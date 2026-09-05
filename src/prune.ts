// Conservative response pruning for MCP tool-call results.
//
// Goal: strip obviously-dead weight from upstream responses before they
// reach the LLM, so large tool outputs cost fewer tokens without
// changing meaning. We measure bytes before and after so callers can
// tell whether pruning actually paid for itself.
//
// The rules are intentionally narrow — pruning is on by default, so
// anything that risks changing semantics is left alone:
//
//   * Drop keys whose values are null / undefined / [] / {}. These
//     almost always mean "no value" for an LLM consumer; keeping them
//     costs tokens without informing the model.
//   * KEEP false, 0, empty strings — those can be load-bearing
//     ("error": "" meaning success, "deleted": false, etc.).
//   * Text-mode: strip trailing whitespace per line and collapse runs
//     of 3+ blank lines into 2. No content is removed, just formatting.
//   * JSON mode is SKIPPED entirely when re-serializing would change a
//     number. Pruning round-trips through JSON.parse + JSON.stringify, so
//     an int64 id like 12345678901234567890 (ordinary in SQL and REST MCP
//     servers) would reach the model as 12345678901234567000. Losing a
//     couple of percent of savings beats handing the model a wrong id.
//   * If pruning doesn't save at least MIN_SAVINGS_RATIO of the total
//     serialized bytes across the entire content array, we return the
//     original untouched — the re-serialization cost isn't worth a
//     marginal win. The ratio is measured over the whole array
//     (JSON.stringify(content)), not per individual content item.
//
// Opt-out: set YAW_MCP_PRUNE_RESPONSES=0 to disable entirely and keep
// the original bytes. In that mode responseBytesPruned == responseBytesRaw.
//
// NOT a security control. Nothing here inspects, redacts or truncates a
// VALUE -- a large file blob, a base64 payload, an instruction-shaped string
// all reach the model byte-for-byte (a whitespace collapse in text mode is
// the only edit to content). Token savings is the whole job; any prompt-
// injection or blob-redaction claim about "response pruning" describes a
// feature this module does not have.

import { setJsonKey } from "./json-key.js";

const MIN_SAVINGS_RATIO = 0.02;

export interface Content {
  type: string;
  text: string;
  [k: string]: unknown;
}

export interface PruneResult {
  content: Content[];
  bytesRaw: number;
  bytesPruned: number;
}

export function isPruneEnabled(): boolean {
  const raw = process.env.YAW_MCP_PRUNE_RESPONSES;
  if (raw === undefined || raw === "") return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

export function pruneContent(content: Content[]): PruneResult {
  const bytesRaw = Buffer.byteLength(JSON.stringify(content), "utf8");
  if (!isPruneEnabled()) {
    return { content, bytesRaw, bytesPruned: bytesRaw };
  }

  const pruned: Content[] = content.map((item) => {
    if (item.type !== "text" || typeof item.text !== "string") return item;
    const text = pruneText(item.text);
    return text === item.text ? item : { ...item, text };
  });

  const bytesPruned = Buffer.byteLength(JSON.stringify(pruned), "utf8");

  if (bytesPruned > bytesRaw * (1 - MIN_SAVINGS_RATIO)) {
    return { content, bytesRaw, bytesPruned: bytesRaw };
  }
  return { content: pruned, bytesRaw, bytesPruned };
}

function pruneText(text: string): string {
  // Guard: don't try to parse multi-megabyte blobs as JSON — even a
  // failed parse chews CPU. We still apply text-mode cleanup below.
  const trimmed = text.trimStart();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && text.length < 2_000_000) {
    try {
      const parsed = JSON.parse(text);
      // Only re-serialize when every number survives the round-trip. A
      // response carrying one oversized id keeps its original bytes rather
      // than reaching the model with that id silently rewritten.
      if (jsonNumbersAreFaithful(text)) {
        const cleaned = pruneJson(parsed);
        if (cleaned !== undefined) return JSON.stringify(cleaned);
      }
    } catch {
      // Not JSON — fall through to text-mode cleanup.
    }
  }
  return pruneWhitespace(text);
}

// --- number fidelity --------------------------------------------------
//
// JSON numbers are IEEE-754 doubles once parsed, so JSON.parse +
// JSON.stringify is not a round-trip for every literal a server can send:
//
//   12345678901234567890  ->  12345678901234567000   (int64 row id)
//   9007199254740993      ->  9007199254740992       (2^53 + 1)
//   1e400                 ->  null                   (overflow to Infinity)
//   1e-400                ->  0                      (underflow)
//
// Pruning is on by default and these shapes are ordinary in SQL / REST MCP
// servers, so the module's "anything that risks changing semantics is left
// alone" contract has to cover them too. When any literal is unfaithful we
// skip JSON mode for the whole document and fall back to whitespace-only
// cleanup, which cannot alter a value.
//
// Both shapes get an EXACT test, so a 16-digit id a double holds precisely
// still prunes: integers compare the re-serialized text byte for byte,
// fractional / exponent forms compare canonical (sign, digits, exponent)
// triples so a pure reformat passes and a changed value does not.

/** A JSON string literal (escapes included) OR a JSON number literal, in one
 *  alternation with the STRING form first. Order is what makes it safe: digits
 *  inside a string are consumed as part of that string match, so they can
 *  never be read as a number. Neither branch can match empty, so the exec loop
 *  below always advances. */
const JSON_STRING_OR_NUMBER_RE = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Does every number in `text` survive JSON.parse + JSON.stringify with its
 *  value intact? Callers only ask after JSON.parse succeeded, so every literal
 *  outside a string really is a number.
 *
 *  One pass, and it does not copy the document. The previous shape blanked
 *  every string with a full-text `replace` -- an extra whole copy of the
 *  response -- and then swept that copy with `matchAll`, which measured
 *  11-15 ms on a 2 MB row array next to 5 ms for the JSON.parse it sits
 *  beside, on the synchronous proxy path. Alternating the two literal forms in
 *  a single regex drops the copy (measured 13.4 ms -> 7.4 ms on that same
 *  array) and lets an unfaithful literal return immediately instead of only
 *  after the copy has been built -- so the common case of an int64 id in the
 *  first row now costs almost nothing.
 *
 *  No cheap pre-filter guards this, deliberately: a digit-run bail
 *  (`/\d[\d.]{15}|.../.test(text)`) measures 7.6 ms on the same 2 MB input --
 *  as much as this entire scan -- because it is itself a full-text regex pass.
 *  The cost here was never the matching, it was the copy, so a pre-filter
 *  would only make the common case slower. */
function jsonNumbersAreFaithful(text: string): boolean {
  // Module-level /g regex: a bail below leaves lastIndex mid-document, so
  // reset before iterating rather than trusting the previous call to have run
  // to completion.
  JSON_STRING_OR_NUMBER_RE.lastIndex = 0;
  let match = JSON_STRING_OR_NUMBER_RE.exec(text);
  while (match !== null) {
    const literal = match[0];
    // A string literal, not a number — nothing to check.
    if (!literal.startsWith('"') && !numberLiteralIsFaithful(literal)) return false;
    match = JSON_STRING_OR_NUMBER_RE.exec(text);
  }
  return true;
}

function numberLiteralIsFaithful(literal: string): boolean {
  const n = Number(literal);
  // 1e400 parses to Infinity, which JSON.stringify emits as `null`.
  if (!Number.isFinite(n)) return false;
  // Plain integers are the shape that actually breaks, so they get an EXACT
  // test: the re-serialized text must be the literal, byte for byte. That
  // keeps every id a double holds precisely (9007199254740991 is 16 digits
  // and fine), rejects the ones it does not (12345678901234567890, 2^53+1),
  // and also rejects the ones that merely reshape (1000000000000000000000
  // comes back as 1e+21 -- same value, but not an id the user can grep for).
  if (/^-?\d+$/.test(literal)) return String(n) === literal;
  // Fractional / exponent forms: the double IS the value every JSON parser
  // sees, and JSON.stringify emits the shortest text that round-trips to
  // that same double, so re-serializing is allowed to REFORMAT (1.0 -> 1,
  // 19.90 -> 19.9, 0.0000001 -> 1e-7) but never to change the value.
  const mantissa = literal.replace(/^-/, "").split(/[eE]/)[0];
  const digits = mantissa.replace(".", "").replace(/^0+/, "");
  // 1e-400 underflows to 0 -- the digits are gone, not merely rounded.
  if (n === 0) return !/[1-9]/.test(digits);
  // Comparing the two spellings in canonical form IS the reformat-or-not
  // test: it accepts every reshaping above and rejects a literal carrying
  // more precision than a double holds (0.12345678901234567 comes back
  // ...66, 0.1000000000000000000001 collapses to 0.1). A digit-count bound
  // cannot do both -- 15 (the decimal->double->decimal guarantee) rejects
  // ordinary computed doubles like 0.30000000000000004, and one rejected
  // literal costs the WHOLE document its pruning; 17 (the double->decimal
  // direction) accepts 16-17 digit literals a double does not hold.
  const canonical = canonicalDecimal(literal);
  return canonical !== null && canonical === canonicalDecimal(String(n));
}

/** A decimal number's value as a `(sign, significant digits, exponent)`
 *  triple, in which two spellings of the SAME value compare equal: `19.90`,
 *  `19.9` and `1.990e1` all canonicalize to `199e-1`, while
 *  `9007199254740993.0` and the `9007199254740992` a double re-serializes to
 *  do not. Returns null for a shape it cannot parse, which the caller treats
 *  as unfaithful. */
function canonicalDecimal(s: string): string | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (m === null) return null;
  const [, sign, intPart, fracPart = "", expPart = ""] = m;
  // value === digits * 10^pow, with the digit string read as an integer:
  // every fraction digit shifts the point right by one, the exponent shifts
  // it back (Number("") is 0, which is the no-exponent case). Leading zeros
  // do not change an integer's value, so dropping them leaves pow alone;
  // each dropped TRAILING zero divides the digits by ten, so pow gains one
  // back.
  const digits = `${intPart}${fracPart}`.replace(/^0+/, "");
  if (digits === "") return "0";
  const significant = digits.replace(/0+$/, "");
  const pow = Number(expPart) - fracPart.length + (digits.length - significant.length);
  return `${sign === "-" ? "-" : ""}${significant}e${pow}`;
}

// CRLF-aware on purpose: a Windows-hosted MCP server that shells out (git,
// filesystem, any CLI wrapper) returns \r\n line endings, and an LF-only
// version of these rules was a silent no-op there — the trailing-space
// regex never matched before a \r, and the blank-run collapse never saw
// three consecutive \n. The \r itself is preserved (content stays
// byte-faithful); only the collapsed blank run is rewritten, in the style
// the run itself used.
function pruneWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+(?=\r?$)/, ""))
    .join("\n")
    .replace(/(?:\r?\n){3,}/g, (run) => (run.includes("\r") ? "\r\n\r\n" : "\n\n"));
}

// Walk a parsed JSON tree, dropping keys/elements whose value is
// "no information" (null, undefined, empty collection after recursion).
// `undefined` returned from this function means "caller should drop me".
function pruneJson(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;

  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    // Never drop array elements — dropping shifts indices and breaks any
    // caller that relies on positional access (e.g. list data returned to
    // the model). Pruned elements stay in place: an OBJECT that prunes to
    // empty is preserved as `{}` so the row/object SHAPE survives (a list of
    // rows stays a list of objects, not a list of nulls); anything else that
    // prunes away (null/undefined/empty primitive collection) becomes null.
    const cleaned: unknown[] = value.map((el) => {
      const pv = pruneJson(el);
      if (pv !== undefined) return pv;
      // el pruned to "no information": keep {} for objects to preserve shape.
      if (el !== null && typeof el === "object" && !Array.isArray(el)) return {};
      return null;
    });
    return cleaned;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let kept = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const pv = pruneJson(v);
      if (pv !== undefined) {
        // setJsonKey, not out[k]: `k` came out of an upstream server's JSON,
        // and plain assignment to "__proto__" hits Object.prototype's
        // inherited setter instead of creating an own key -- the field
        // would vanish from the pruned result the server actually returned.
        // Shared with persistence/grades-cache/trust so the one key that
        // needs this cannot be handled four subtly different ways.
        setJsonKey(out, k, pv);
        kept++;
      }
    }
    return kept === 0 ? undefined : out;
  }

  return value;
}
