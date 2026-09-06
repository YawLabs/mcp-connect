// Foundry: privacy-safe local harvest of dispatch traces for a future
// routing-eval corpus.
//
// The goal is to let a user OPT IN to collecting a corpus of "intent ->
// candidate namespaces -> chosen namespace" decisions that a future eval
// could replay to measure routing quality -- WITHOUT ever persisting the
// raw English intent the user typed. Two layers keep it privacy-safe:
//
//   1. Path-splitting in `tokenizeQuery` (src/relevance.ts) already shreds
//      most structure: it lowercases and splits on every non-alphanumeric run,
//      so emails, URLs, file paths, `key=value` pairs, and dotted hosts are
//      blown apart into bare alphanumeric tokens before we ever see them.
//      `user@host.com/secret` becomes ["user", "host", "com", "secret"].
//      That is the FIRST line of defense -- structure is gone.
//
//   2. `redactIntent` is the SECOND line of defense, and it runs in two
//      passes. BEFORE tokenize it scrubs the raw string of the shapes that
//      only exist while the punctuation does -- emails, phone runs, issue /
//      ticket refs, and punctuated secret prefixes (`ghp_...`, `sk-proj-...`).
//      AFTER tokenize it drops the tokens that survive splitting but still
//      look sensitive -- long high-entropy blobs, punctuation-free secret
//      prefixes (`xox...`, `akia...`), hex digests, long pure-alpha runs, and
//      mixed letter+digit runs (an API key with no punctuation inside it).
//      The surviving tokens are then SORTED, so word order is destroyed and
//      the original sentence cannot be reconstructed from the bag.
//
// Privacy scope (READ BEFORE ENABLING): this protects against persisting the
// raw intent string, its delimiters/structure, secret-shaped tokens, and
// word order. It does NOT strip ordinary words that happen to be sensitive --
// personal names, company names, or ticket text are "ordinary words" to the
// redactor and survive (un-ordered) in the bag. Do not enable YAW_MCP_FOUNDRY
// on intents that routinely carry such PII.
//
// Default is privacy-safe: harvesting is DISABLED unless YAW_MCP_FOUNDRY is
// explicitly "1" / "true". When enabled, only the redacted+sorted token bag
// and the chosen namespace are written -- never the raw intent string, and
// never the candidate shortlist or its scores (the FoundryTrace shape no
// longer carries one; see the note on the interface).

import { appendFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { userConfigDir } from "./paths.js";
import { tokenizeQuery } from "./relevance.js";

export interface RedactedIntent {
  tokens: string[];
  redactedCount: number;
}

// Known secret/token prefixes. All are stored lowercase because tokenize has
// already lowercased every token before it reaches us (so "akia" here matches
// an "AKIA..." AWS access-key-id that arrived as "akia...").
//
// These get matched in TWO places, because tokenize() destroys the punctuation
// most of them contain. A prefix with a '_' or '-' in it can NEVER match a
// token -- tokenize splits on every non-alphanumeric, so a token is always a
// bare [a-z0-9]+ run and `token.startsWith("ghp_")` is unsatisfiable. Those
// prefixes are therefore matched on the RAW intent string (see
// RAW_SECRET_PREFIX_PATTERN below), where the punctuation still exists; only
// the purely-alphanumeric ones ("xox", "akia") are checked per token. The
// split is DERIVED, not hand-maintained, so the next prefix a maintainer adds
// ("github_pat_", "sk-proj-") lands in the right layer automatically instead
// of being dead on arrival.
const SECRET_PREFIXES = ["sk_", "sk-", "tok_", "ghp_", "gho_", "xox", "pk_", "akia"];

/** Prefixes that survive tokenize() -- purely [a-z0-9], so a token can start
 *  with one. Checked per token in looksSensitive. */
const TOKEN_SECRET_PREFIXES = SECRET_PREFIXES.filter((p) => /^[a-z0-9]+$/.test(p));

/** Prefixes containing punctuation -- unreachable from a token, so they are
 *  matched on the raw intent instead. */
const RAW_SECRET_PREFIXES = SECRET_PREFIXES.filter((p) => !/^[a-z0-9]+$/.test(p));

// A token "looks like a secret/PII" when any of these hold. tokenizeQuery has
// already lowercased and stripped non-alphanumerics, so by the time we see
// a token it is a single [a-z0-9]+ run (>= 1 char -- the ranker's QUERY floor,
// not the 3-char prose floor). The checks therefore target what survives:
// long high-entropy blobs and prefixed/hex tokens.
function looksSensitive(token: string): boolean {
  // Known secret prefixes (case-insensitive; token is already lowercased).
  // Only the punctuation-free ones can ever match here -- see SECRET_PREFIXES.
  for (const prefix of TOKEN_SECRET_PREFIXES) {
    if (token.startsWith(prefix)) return true;
  }

  // Pure-hex of length >= 16 (git SHAs, hashed ids, hex-encoded keys).
  if (token.length >= 16 && /^[0-9a-f]+$/.test(token)) return true;

  // Mixed letters+digits, length >= 12. A 12+ char run that interleaves
  // [a-z] and [0-9] is almost never an English word; it is overwhelmingly an
  // id, token, or key fragment. (Lowered from 20 so 12-19 char keys don't
  // slip through.)
  if (token.length >= 12 && /[a-z]/.test(token) && /[0-9]/.test(token)) return true;

  // Long pure-alpha run, length >= 16. A single [a-z] run this long is far
  // more likely a passphrase / base32-style secret than an English word, so
  // we over-redact here rather than risk persisting a cleartext secret.
  if (token.length >= 16 && /^[a-z]+$/.test(token)) return true;

  return false;
}

// Tokenize an intent (via relevance `tokenizeQuery`) THEN drop any surviving
// token that looks like a secret/PII. Returns the kept tokens plus the
// number dropped. Note on "email / IPv4 / @" rules from the spec:
// tokenizeQuery splits on `@` and `.`, so an email or IPv4 never reaches here
// as a single token -- its alphanumeric pieces ("user", "gmail", "com", "192",
// "168") pass through as ordinary tokens, which is acceptable since the
// identifying structure (the @ and dots) is already destroyed. We document
// this rather than re-detect a structure tokenizeQuery has already removed.
// A raw-string scrub rule. `re` NOMINATES a match; `applies`, when present,
// decides whether it is really PII. The two are split because the phone and
// ticket-ref shapes are ambiguous with ordinary technical vocabulary, and the
// disambiguation (count the digits, exclude the standards prefixes) reads as
// code but not as a lookaround. Over-redaction is not free: every token
// wrongly dropped here is a token the routing corpus can never be scored on.
interface RawScrubRule {
  re: RegExp;
  /** Return false to keep the nominated match verbatim (not PII after all).
   *  Absent means "always scrub what `re` matched". */
  applies?: (match: string) => boolean;
}

// A dotted run of 4+ numeric groups (three or more dots): an IPv4 literal
// (192.168.1.100) or a dotted version (1.2.3.4.5). Phone numbers are
// written with spaces, parens
// or hyphens far more often than with three or more dots, so excluding this
// shape costs essentially no real phone coverage.
const DOTTED_NUMERIC_RE = /^\d+(?:\.\d+){3,}$/;

/** True when a nominated phone-shape run really looks like a phone number.
 *  The nominating regex is deliberately loose (any run of digits and phone
 *  punctuation), so it also matched ISO dates and IP literals; both fall out
 *  here. */
function isPhoneShape(match: string): boolean {
  // Real numbers carry 9+ digits (NANP is 10, E.164 allows up to 15). An ISO
  // date has 8 ("2024-01-15") and a short dotted version fewer still.
  const digits = match.replace(/[^0-9]/g, "");
  if (digits.length < 9) return false;
  // The exclusion is per-GROUP, not per-match. Whitespace is inside the
  // nominating character class, so two adjacent IPv4 literals
  // ("192.168.1.100 10.0.0.1") arrive as ONE match that no whole-match test
  // recognizes -- and the pair clears the 9-digit floor on its own even
  // though neither literal does. Splitting on whitespace first judges each
  // literal as itself; a single group reduces to the old whole-match test.
  const groups = match.trim().split(/\s+/);
  return !groups.every((g) => DOTTED_NUMERIC_RE.test(g));
}

// Standards, algorithms and encodings share Jira's PROJ-1234 shape. They are
// ordinary technical vocabulary -- exactly the words a routing corpus needs --
// so they are excluded by name. Stored lowercase; the check lowercases the
// alpha side before the lookup.
const TECH_REF_PREFIXES = new Set([
  "aes",
  "base",
  "crc",
  "cve",
  "ecma",
  "es",
  "gpt",
  "http",
  "ipv",
  "iso",
  "md",
  "rfc",
  "rsa",
  "sha",
  "ssl",
  "tls",
  "utf",
]);

/** True when a nominated `LETTERS-digits` run really looks like a ticket ref.
 *  Excludes 1-digit suffixes (UTF-8, GPT-4, ES-6 are version/bit-width
 *  markers, not ticket numbers) and the standards prefixes above (SHA-256,
 *  ISO-8601, CVE-2024 all carry multi-digit suffixes). */
function isTicketRef(match: string): boolean {
  const dash = match.indexOf("-");
  const alpha = match.slice(0, dash);
  const digits = match.slice(dash + 1);
  if (digits.length < 2) return false;
  return !TECH_REF_PREFIXES.has(alpha.toLowerCase());
}

// Structured PII patterns we strip from the RAW intent BEFORE tokenize()
// shreds it into bare alphanumeric runs. Tokenize splits on every
// non-alphanumeric, which loses the structure that makes these
// recognizable -- so we have to scrub here, not in the token loop.
// Each rule's matched substrings are replaced with " " (so a token
// boundary is preserved) and counted toward redactedCount.
//   - email: user@host.tld
//   - phone-shape: 9+ actual digits with optional +/separators (isPhoneShape)
//   - GitHub-style refs: #1234, at the same 2-digit floor isTicketRef uses.
//     A single digit is a priority marker or a list index ("priority #1"),
//     not an issue ref, and keeping "PROJ-1" while scrubbing "#1" made the
//     two sibling rules disagree about the same shape.
//   - Jira-style ticket refs: PROJ-1234 (isTicketRef)
// Each pattern is wrapped with `(?<![A-Za-z0-9])...(?![A-Za-z0-9])` so it only
// matches when bounded by non-alphanumerics (start/end of string, whitespace,
// punctuation). Without these, the phone-shape pattern matches a digit run
// INSIDE a longer alphanumeric token (e.g. the "0123456789" tail of
// "xoxbabcdef0123456789"), double-counting against the prefix-token rule.
const RAW_PII_RULES: RawScrubRule[] = [
  { re: /(?<![A-Za-z0-9])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9])/g },
  { re: /(?<![A-Za-z0-9])\+?[0-9][0-9\s().-]{8,}(?![A-Za-z0-9])/g, applies: isPhoneShape },
  { re: /(?<![A-Za-z0-9])#\d{2,}(?![A-Za-z0-9])/g },
  { re: /(?<![A-Za-z0-9])[A-Z]+-\d+(?![A-Za-z0-9])/g, applies: isTicketRef },
];

// Punctuation-carrying secret prefixes, matched on the RAW intent for the same
// reason as the patterns above: tokenize() splits on the very '_' / '-' that
// makes `ghp_...` / `sk-proj-...` recognizable, so by the token loop the prefix
// is gone. The trailing `[A-Za-z0-9_-]+` swallows the whole key (a GitHub PAT
// and an OpenAI project key both keep '_' / '-' internally), and the
// non-alphanumeric boundaries mirror RAW_PII_RULES so this cannot fire on a
// fragment inside a longer run. Built from SECRET_PREFIXES so the two layers
// can never drift. Case-insensitive: this runs BEFORE tokenize lowercases.
//
// Guarded on a non-empty list: an empty alternation would compile to `(?:)`,
// which matches the empty string and would turn the pattern into "scrub every
// word". If every prefix ever becomes punctuation-free the layer just drops
// out instead.
const RAW_SECRET_PREFIX_PATTERN: RegExp | null =
  RAW_SECRET_PREFIXES.length > 0
    ? new RegExp(
        `(?<![A-Za-z0-9])(?:${RAW_SECRET_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[A-Za-z0-9_-]+(?![A-Za-z0-9])`,
        "gi",
      )
    : null;

// Scrubbed off the raw string in order. The secret-prefix pattern runs FIRST so
// a key is consumed whole before a narrower pattern (e.g. the phone shape) can
// nibble a digit run out of its middle and double-count it.
const RAW_SCRUB_RULES: RawScrubRule[] = [
  ...(RAW_SECRET_PREFIX_PATTERN ? [{ re: RAW_SECRET_PREFIX_PATTERN }] : []),
  ...RAW_PII_RULES,
];

export function redactIntent(intent: string): RedactedIntent {
  let redactedCount = 0;
  // First pass: strip structured PII and punctuated secret prefixes from the
  // raw string. Replace each match with a single space to preserve token
  // boundaries. APPEND to the existing token-level redaction below -- this
  // layer catches the shapes tokenize() would destroy before looksSensitive
  // could see them.
  let scrubbed = intent;
  for (const rule of RAW_SCRUB_RULES) {
    scrubbed = scrubbed.replace(rule.re, (match) => {
      // A rule with an `applies` gate can decline: the shape matched but the
      // text is ordinary technical vocabulary (a date, an IP, SHA-256), so it
      // stays verbatim and is NOT counted as a redaction.
      if (rule.applies && !rule.applies(match)) return match;
      redactedCount++;
      return " ";
    });
  }

  // tokenizeQuery, not tokenize: the ranker tokenizes queries at the 1-char
  // floor (sparing pg/gh/s3), so harvesting at the 3-char prose floor would
  // silently delete every short identifier from the corpus that scores it.
  const all = tokenizeQuery(scrubbed);
  const tokens: string[] = [];
  for (const token of all) {
    if (looksSensitive(token)) {
      redactedCount++;
    } else {
      tokens.push(token);
    }
  }
  // Sort the surviving tokens so word ORDER is destroyed -- a bag of words
  // can't reconstruct the original sentence. BM25-style eval is bag-of-words
  // anyway, so ordering carries no signal we lose.
  tokens.sort();
  return { tokens, redactedCount };
}

export interface FoundryTrace {
  tokens: string[];
  // No `candidates` field: the ranker's shortlist was accepted here for a
  // release and never persisted (nothing read it back, and a ns-only list no
  // consumer opens was pure weight against the 5 MiB harvest cap). The
  // dispatch call site (server.ts) no longer passes it.
  chosen: string;
  redactedCount: number;
}

// Opt-in ONLY. True when YAW_MCP_FOUNDRY is exactly "1" or "true"
// (case-insensitive, whitespace-trimmed). Anything else -- unset, "0",
// "false", "yes", garbage -- is treated as disabled. Privacy-safe default.
export function isFoundryEnabled(): boolean {
  const raw = process.env.YAW_MCP_FOUNDRY;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

// Hard cap on the harvest file size. Once foundry.jsonl exceeds this, we
// stop appending so an npm-published CLI can never fill a user's disk.
// 5 MiB of single-line JSON traces is on the order of 10k-30k entries --
// far more than any eval corpus needs -- and the cap is checked cheaply via
// a single stat() before each append. We DROP new traces rather than
// rotate/truncate: rotation adds I/O and complexity for telemetry that must
// stay best-effort and never throw, and an eval corpus only needs a bounded
// sample, not the most-recent window. Bounded-by-drop is the simple choice.
//
// Exported so the cap test pins THIS number instead of re-declaring its own
// copy -- with a local copy, lowering the cap here made that test pass
// vacuously (it staged a file at the old, now-larger size).
export const MAX_FOUNDRY_BYTES = 5 * 1024 * 1024;

export const FOUNDRY_FILENAME = "foundry.jsonl";

// Append one trace as a JSON line to ~/.yaw-mcp/foundry.jsonl.
//
// Best-effort by contract: this is telemetry and MUST NEVER throw or reject
// in a way that breaks a dispatch. Every failure path (disabled, oversized
// file, mkdir/stat/append error) resolves quietly. No-op when disabled.
//
// `home` is overridable so tests (and any future relocation) can isolate
// the harvest dir without touching the real home -- mirrors
// userConfigDir(home) in paths.ts.
export async function appendFoundryTrace(trace: FoundryTrace, home: string = homedir()): Promise<void> {
  try {
    if (!isFoundryEnabled()) return;

    const dir = userConfigDir(home);
    const file = path.join(dir, FOUNDRY_FILENAME);

    // Enforce the size cap BEFORE writing. If the file is already at/over
    // the cap, drop this trace silently. A missing file (ENOENT) means
    // size 0 -- proceed to create it.
    try {
      const info = await stat(file);
      if (info.size >= MAX_FOUNDRY_BYTES) return;
    } catch {
      // ENOENT (first write) or any stat error -> treat as "not over cap"
      // and let the append attempt proceed / fail quietly below.
    }

    // Persist ONLY the redacted bag + routing decision -- never raw intent.
    // (The ranker's shortlist used to ride along scores-stripped and was never
    // read by anything, so it only ate into the size cap; it is gone from the
    // trace shape now. See FoundryTrace.)
    const line = `${JSON.stringify({
      tokens: trace.tokens,
      chosen: trace.chosen,
      redactedCount: trace.redactedCount,
    })}\n`;

    // Born owner-only, best-effort like everything else here. The file header
    // says it: ordinary words -- names, company names, ticket text -- survive
    // redaction, so on a multi-user host a harvest born at the umask default
    // (0644, inside a 0755 ~/.yaw-mcp this same call may create) hands every
    // token bag to any local user. `mode` on mkdir applies only to directories
    // it creates and on appendFile only to a file it creates, so neither
    // touches perms the user already has. Mirrors secrets-audit.ts, the
    // repo's other privacy-adjacent append-only log. No-op on Windows.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Swallow everything. Telemetry must never break a dispatch.
  }
}
