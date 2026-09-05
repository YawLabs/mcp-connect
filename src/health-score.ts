import type { ConnectionHealth } from "./types.js";

// Health-aware ranking penalty. Takes a raw ranker score and scales it
// by a [0.5, 1.0] factor derived from observed reliability so dispatch
// prefers servers that have been working in this session over servers
// that have been flaking. Pure client-side -- no backend dependency.
//
// We only ever *shrink* the score; we never boost above the raw value.
// The idea is "all else equal, prefer the one that works," not "a very
// healthy obscure match beats a marginally healthy exact match."
//
// Thresholds are tuned by intuition -- when we have usage data the values
// should be revisited. Current defaults:
//   - Need >=3 observations before error rate matters (noise floor).
//   - 0% errors  -> factor 1.00 (no penalty)
//   - 30% errors -> factor 0.70
//   - 50%+ errors -> factor 0.50 (floor -- never drop below)
//   - Activation failure within ACTIVATION_FAILURE_TTL_MS -> factor 0.50
export const ACTIVATION_FAILURE_TTL_MS = 5 * 60 * 1000;
const OBSERVATION_FLOOR = 3;
const MIN_FACTOR = 0.5;
// Minimum error rate that earns a human-visible warning line in discover().
// Below this we still let errorRateFactor nudge ranking, but stay silent:
// totalCalls/errorCount never decay, so a single stale error in a large
// sample (1 in 1000) must not emit a permanent "N of M failed" line at
// a negligible penalty -- that would train the model to skip a fine server.
const WARN_RATE_FLOOR = 0.1;

export interface ActivationFailure {
  at: number;
  message: string;
}

export function errorRateFactor(health: ConnectionHealth | undefined): number {
  if (!health) return 1.0;
  if (health.totalCalls < OBSERVATION_FLOOR) return 1.0;
  const rate = health.errorCount / health.totalCalls;
  const factor = 1 - rate;
  return Math.max(MIN_FACTOR, factor);
}

// True while an activation failure is still inside its TTL window.
//
// The lower bound is not decoration: `at` is a wall-clock stamp taken when the
// activation failed, and a BACKWARDS clock step (NTP correction, VM resume,
// manual set) makes `now - at` NEGATIVE. An upper-bound-only check reads that
// as "younger than the TTL", so the namespace stays pinned at the MIN_FACTOR
// penalty -- and formatHealthWarning keeps rendering "last activation failed
// 1m ago", because Math.max(1, round(negative/60_000)) floors to 1 -- until the
// clock catches back up to the stamp, which can be hours. A future-dated stamp
// is skew, not evidence, so it expires immediately instead.
function isWithinActivationTtl(failure: ActivationFailure, now: number): boolean {
  const age = now - failure.at;
  return age >= 0 && age <= ACTIVATION_FAILURE_TTL_MS;
}

export function activationFailureFactor(failure: ActivationFailure | undefined, now: number = Date.now()): number {
  if (!failure) return 1.0;
  if (!isWithinActivationTtl(failure, now)) return 1.0;
  return MIN_FACTOR;
}

// Combine signals by taking the strictest penalty -- worst observed
// reliability wins, because both signals are evidence of real failure.
export function healthFactor(
  health: ConnectionHealth | undefined,
  activationFailure: ActivationFailure | undefined,
  now: number = Date.now(),
): number {
  return Math.min(errorRateFactor(health), activationFailureFactor(activationFailure, now));
}

// Render a short human-readable warning when a server is looking shaky,
// so discover() can point the LLM at healthier alternatives. Returns
// null when there is nothing to warn about -- the caller should not
// print a line at all in that case. Activation failures take precedence
// over per-call error rates because they mean the server is currently
// unusable, not merely unreliable. Both signals are session-local.
//
// We deliberately hide low-sample error rates (<3 calls) -- flagging a
// server as unhealthy after a single flaky call would train the model
// to skip perfectly-fine servers just because the first call 500'd. Above
// the floor we surface a MEANINGFUL rate (>= WARN_RATE_FLOOR) -- a lower gate
// than the old 30% so a genuinely flaky server isn't silent, but NOT rate>0,
// since the never-decaying counters would then warn forever on one old error.
//
// The upstream error excerpt appended to either line is SCRUBBED, not raw:
// error-category.ts refuses to surface raw text next to a category precisely
// because third-party servers echo secrets in errors, and this surface used
// to contradict that by pasting up to 120 chars of the same text into
// discover(). truncateForWarning now runs scrubForWarning first, so the
// actionable part of the message survives and credential-shaped values do
// not. The excerpt earns its place: "502 bad gateway" tells the model to
// retry elsewhere where a bare category would not.
export function formatHealthWarning(
  health: ConnectionHealth | undefined,
  activationFailure: ActivationFailure | undefined,
  now: number = Date.now(),
): string | null {
  if (activationFailure && isWithinActivationTtl(activationFailure, now)) {
    const ageMin = Math.max(1, Math.round((now - activationFailure.at) / 60_000));
    const msg = activationFailure.message ? `: ${truncateForWarning(activationFailure.message)}` : "";
    return `warn: last activation failed ${ageMin}m ago${msg}`;
  }
  if (health && health.totalCalls >= OBSERVATION_FLOOR) {
    const rate = health.errorCount / health.totalCalls;
    // Warn once the rate is meaningful (>= WARN_RATE_FLOOR) -- a lower gate
    // than the old >=30% so a genuinely flaky server (which errorRateFactor is
    // already down-ranking) no longer hides, but NOT rate>0: totalCalls /
    // errorCount never decay, so a lone early error would otherwise emit a
    // permanent "N of M failed" line at a negligible 1/M penalty.
    //
    // The line says "N of M", NOT "N of the last M": there is no window. Both
    // counters run from the first call of the session and never decay, so M is
    // the all-time total for this process and the failures it counts can all be
    // hours old. "last" claimed a recency the numbers do not carry, and it is
    // the LLM reading this line and deciding whether to route elsewhere.
    if (rate >= WARN_RATE_FLOOR) {
      const lastErr = health.lastErrorMessage ? `: ${truncateForWarning(health.lastErrorMessage)}` : "";
      return `warn: ${health.errorCount} of ${health.totalCalls} calls failed${lastErr}`;
    }
  }
  return null;
}

// Credential-shaped fragments we refuse to echo into discover() output.
// The name/value shape keeps the NAME and blanks only the VALUE --
// "unauthorized: api_key=<redacted>" still tells the model what went wrong,
// which is the whole point of surfacing the excerpt at all.
//
// ORDER IS LOAD-BEARING. The auth-scheme rule runs FIRST: with the
// name/value rule ahead of it, `Authorization: Bearer <blob>` matched
// name=Authorization value=`Bearer`, so the SCHEME WORD was redacted and the
// actual token survived into the output. Scheme-first collapses the whole
// `Bearer <blob>` run to the marker, and because the name/value rule's value
// class excludes `<` it then finds nothing left to consume.
const REDACTED = "<redacted>";

const SECRET_KEY_NAMES =
  "api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|" +
  "private[-_]?key|secret|password|passwd|pwd|token|authorization|auth|credential|signature|sig";

// REDACT WHOLE, DO NOT CLASSIFY. Three attempts tried to tell a diagnostic
// value from a credential and each was wrong in a different direction:
//
//   1. An enumerated absence-word list matched only the FIRST whitespace-
//      delimited token, so every phrasing nobody listed still inverted:
//      "SLACK_BOT_TOKEN: must be provided" -> "<redacted> be provided".
//   2. Asking whether TEXT FOLLOWS on the line exempted a value whenever
//      anything word-shaped came later -- a second pair, a JSON sibling, a
//      query parameter, even the marker rule 1 had just inserted. It leaked
//      real secrets and rescanned the line per match (796 ms on 260 KB).
//   3. Gating on the SEPARATOR assumed a space after the colon means prose.
//      Every machine config format puts one there -- YAML, TOML, INI, spaced
//      .env, column-aligned and header dumps -- so "api_key: abcdef" and
//      "MYSQL_PASSWORD: swordfish" leaked whole.
//
// The lesson is that the distinction is NOT DECIDABLE from the text: `abcdef`
// and `missing` are the same shape in the same position. So this revision
// stops guessing and makes every redaction WHOLE, because the damage was
// never the redaction -- it was the PARTIAL one. A surviving tail ("<redacted>
// set") reads as "credential present but rejected" when the truth is
// "credential absent", and this header has always held that an INVERTED
// diagnostic is worse than a hidden one.
//
// What that means per shape:
//
//   quoted value    -- explicit bounds, so redact the BODY and keep the
//                      quotes. BOTH quote styles: the old separator knew only
//                      the double quote, so a single-quoted value never
//                      matched and leaked whole (Python reprs, shell export).
//   compact NAME=v  -- the value is unambiguously ONE token. Redact it and
//                      leave the rest of the line alone.
//   NAME: <space>   -- where the value ends is undecidable, so redact to the
//                      end of the clause. The tail stops at a dash-run and at
//                      the next NAME=/NAME: pair, so " -- upstream returned
//                      502" survives and a following pair is still redacted
//                      on its own.
//
// ABSENCE_VALUE is the ONE safe-list and the only judgement left, because it
// is the only one that needs none: no credential is literally the word
// "unset". It keeps the clause intact so the common diagnostics still read.
//
// Accepted cost, stated plainly: a diagnostic whose first value token is not
// on that list is now HIDDEN rather than shown -- "API_KEY: environment
// variable not found" becomes "API_KEY: <redacted>". That is the deliberate
// trade. Widening the list to recover those lines is attempt 1 again.
//
// (The value class below stops at a quote or delimiter, so `token=abc'def`
// still yields `token=<redacted>'def`. That is a value-class question older
// than these gates and deliberately not folded in here.)
const ABSENCE_VALUE =
  /^(?:not|no|missing|unset|undefined|null|none|empty|required|absent|blank|nil|n\/a|must|invalid|expected|cannot|failed)$/i;

const SECRET_PATTERNS: ReadonlyArray<{ re: RegExp; replace: (match: string, ...groups: string[]) => string }> = [
  // 1. An HTTP `Authorization: Bearer <blob>` / `Basic <blob>` header value.
  // Scheme list is not just bearer/basic: any other scheme fell through to
  // rule 2, which then captured the SCHEME WORD as the value and left the
  // token itself in the clear ("Authorization: Token abc123def456").
  //
  // Most of those schemes are also ordinary English, and an unanchored rule
  // took ANY 8+ letter word after one of them as the credential: "API key
  // required" -> "API <redacted>", "basic authentication failed" ->
  // "<redacted> failed", "digest mismatch" -> "<redacted>". That throws away
  // the one word the model can act on, which is the over-scrubbing the header
  // below calls as bad a regression as a leak. So for the bare-word schemes
  // the blob has to LOOK like a credential -- carry a digit, or run 16+ chars
  // -- which no English word following "key" / "token" / "basic" / "digest"
  // does, while a real token nearly always does. `bearer` and `hmac` are
  // scheme names, not prose, so they stay unanchored and a short all-letter
  // bearer token is still caught. A short letters-only blob after a bare-word
  // scheme in PROSE is the accepted miss -- but in header position, right
  // after `Authorization:` (or any `-Authorization:` header spelling), the
  // word after the scheme is a credential by construction, so there the shape
  // gate is dropped and any 8+ char blob is redacted (rule 2 covers the same
  // spot only when the header name survives as a NAME: pair; anchoring here
  // does not depend on it).
  {
    re: /\bauthorization\s*:\s*(?:basic|token|apikey|api-key|digest|key)\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:bearer|hmac)\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:basic|token|apikey|api-key|digest|key)\s+(?=[A-Za-z0-9._~+/=-]{16}|[A-Za-z._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (m: string) => {
      // Keep the header NAME legible when the anchored alternative matched:
      // `Authorization: <redacted>` tells the reader which header it was.
      const head = /^authorization\s*:\s*/i.exec(m);
      return head ? `${head[0]}${REDACTED}` : REDACTED;
    },
  },
  // 2. A secret-ish key followed by = or : and a value -- a query string, a
  //    JSON body, a header dump, or a Python repr ({'token': 'abc'}).
  //
  //    The name may carry an underscore/hyphen-joined PREFIX (NOTION_API_KEY,
  //    auth_token, MY_SECRET), and that prefix is part of the match rather than
  //    something \b can skip over: `_` is a word character, so a bare \b in
  //    front of the name token never matches inside SOMETHING_TOKEN. Env-var
  //    spellings are the dominant shape in MCP spawn/config errors, so that gap
  //    left the raw value in the excerpt whenever the key carried a prefix and
  //    the value itself had no vendor prefix for rule 3 to catch. The prefix
  //    group sits INSIDE $1 so the full name still survives into the output.
  //
  //    Prefixed NON-secrets stay readable, because the name has to both END the
  //    prefixed run and be followed by = or : -- "SSH_AUTH_SOCK=/tmp/..." has
  //    `_SOCK` sitting after `AUTH`, so no alternative matches. Once the name
  //    DOES match, the callback redacts WHOLE (see the header above): a quoted
  //    value loses its body, a compact NAME=v loses its one token, and a
  //    whitespace-separated value loses the rest of the clause. The only
  //    thing handed back untouched is a first value token on ABSENCE_VALUE,
  //    so "GITHUB_TOKEN: not set" still reads as the diagnostic it is.
  //
  //    Everything the callback needs is inside the match, so this stays a
  //    single linear pass. An earlier revision looked ahead at the rest of the
  //    line to decide; that was both wrong (any later word exempted the value)
  //    and quadratic on a long collapsed line.
  {
    // The prefix repetition is BOUNDED. `(?:[A-Za-z0-9]+[-_])*` is O(n^2)
    // against a long hyphen-joined run, because `\b` matches at every hyphen so
    // the scan restarts per position: 784 ms on a 64 KB kebab chain, 12.4 s at
    // 100 KB, and the message is stored, so it recurs on every discover().
    // Nothing real has 8 prefix segments of 32 chars.
    re: new RegExp(
      `\\b((?:[A-Za-z0-9]{1,32}[-_]){0,8}(?:${SECRET_KEY_NAMES}))` +
        `(["']?\\s*[=:][ \\t]*)` +
        // The tail stops at a dash-run (so " -- upstream returned 502" survives
        // as its own clause) and at the next NAME=/NAME: pair -- without that
        // second guard the tail swallowed the following pair, and
        // "PASSWORD=letmein API_KEY=zzz" redacted only the first of the two.
        `(?:'([^'\\n]*)'|"([^"\\n]*)"|([^\\s,;&"'}\\]<]+)` +
        `((?:[ \\t]+(?!-)(?![A-Za-z0-9_-]+["']?[ \\t]*[=:])[^\\s,;&"'}\\]<]+)*))`,
      "gi",
    ),
    replace: (_match, name, sep, single, double, bare, tail) => {
      // A quoted value has explicit bounds, so redact the BODY and keep the
      // quotes. Both quote styles: the old separator knew only `"`, so a
      // single-quoted value failed to match at all and leaked whole -- Python
      // reprs, shell `export`, single-quoted YAML.
      if (single !== undefined) return `${name}${sep}'${REDACTED}'`;
      if (double !== undefined) return `${name}${sep}"${REDACTED}"`;
      // The only safe-list. Keeps the clause intact so the diagnostic reads.
      if (ABSENCE_VALUE.test(bare)) return `${name}${sep}${bare}${tail}`;
      // Compact separator: the value is unambiguously ONE token, so redact it
      // and leave the rest of the line alone.
      if (!/[ \t]$/.test(sep)) return `${name}${sep}${REDACTED}${tail}`;
      // Whitespace separator: where the value ends is NOT decidable. Three
      // attempts tried (enumerated absence words, then "does text follow?",
      // then the separator shape) and each one either inverted a diagnostic or
      // exempted a real credential, because `abcdef` and `missing` are the same
      // shape. So stop classifying and redact the whole clause: a partial
      // redaction is what inverts the meaning, and hiding beats inverting.
      return `${name}${sep}${REDACTED}`;
    },
  },
  // 3. A vendor-prefixed key carrying no name for rule 2 to anchor on.
  {
    re: /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xoxb|xoxp|xoxa|xapp|glpat)[-_][A-Za-z0-9_-]{8,}/g,
    replace: () => REDACTED,
  },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => REDACTED },
];

/** Blank out credential-shaped substrings before an upstream error excerpt
 *  reaches discover() output.
 *
 *  error-category.ts's header states the never-surface-raw-text policy and
 *  cites "no general scrubber" as the reason. This is not a general scrubber
 *  and does not pretend to be one -- it cannot know a third-party server's
 *  private encoding. It closes the shapes actually observed leaking (URLs
 *  with `?api_key=`, echoed request bodies, `Authorization:` header dumps,
 *  vendor-prefixed keys), so the excerpt that IS load-bearing for the model
 *  ("502 bad gateway", "spawn ENOENT npx") survives while the value next to a
 *  credential-shaped name does not. Anything it misses is still bounded by
 *  the 120-char truncation below.
 *
 *  Whitespace is collapsed to single spaces HERE, before the patterns run,
 *  and the result is one line. That is not cosmetic: rule 2's separator
 *  admits only spaces and tabs, so a key and value split by a newline
 *  ("GITHUB_TOKEN:\nabc123def456", or a pretty-printed JSON body with the
 *  key, colon and value on three lines) matched nothing -- and when the
 *  collapse ran AFTER the scrub, in truncateForWarning, it joined the two
 *  halves into a clear-text "NAME: value" line in discover() output. Doing
 *  it first means the patterns see the same one-line text the reader will,
 *  and the export is safe on its own rather than only via truncateForWarning.
 *  The one behavior change: a line break no longer ends a whole-clause tail
 *  by accident, so the text after it is redacted too. That is the header's
 *  hiding-beats-inverting trade, and the surviving tail never reached the
 *  output as its own line anyway. */
export function scrubForWarning(msg: string): string {
  let out = msg.replace(/\s+/g, " ");
  for (const { re, replace } of SECRET_PATTERNS) out = out.replace(re, replace);
  return out;
}

// Keep warning strings short -- discover() output goes to the LLM's
// context window and every error message line we append is tokens the
// caller pays. 120 chars is two lines of typical terminal width and
// usually enough for a stack-trace top-level or an HTTP status.
//
// Scrubs BEFORE truncating so the 120-char cut is applied to already-redacted
// text: a secret sitting past char 120 is REMOVED rather than merely hidden by
// the cut, and an expanded redaction cannot push the result past the cap.
// (A redaction changes length in EITHER direction: `token=x` grows to
// `token=<redacted>`, while a long API key collapses to those same 10 chars.
// The ordering does not depend on which way it goes -- what matters is that
// the cut is applied to the FINAL text, so whatever the substitution did to
// the length is already accounted for by the time we measure.) The whitespace
// collapse lives in scrubForWarning for the reason given there; only the trim
// and the cut are left to do here.
function truncateForWarning(msg: string): string {
  const clean = scrubForWarning(msg).trim();
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}
