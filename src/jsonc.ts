// Tiny string-aware JSONC comment stripper. Not a full parser — we just
// strip // line comments and /* block */ comments, then hand the result
// to JSON.parse. String literals are tracked so `//` inside "https://…"
// or a dollar sign inside a comment-like token are preserved verbatim.
//
// Why hand-roll instead of depending on `jsonc-parser`: we want mcph's
// dependency surface to stay small (currently 4 production deps) and the
// stripping logic is <50 LOC. A full comment-preserving parser isn't
// needed — we only read config, never rewrite it as JSONC.
//
// Known limitations by design:
//   - No trailing-comma support. JSON.parse rejects trailing commas,
//     which is strict JSONC's usual tolerance. Users who want trailing
//     commas can strip them themselves or use strict JSON. We surface
//     the parse error with the offending line so the fix is obvious.
//   - Escape sequences inside strings are honored (`"a\\"` stays closed),
//     so a literal `"abc // def"` keeps its `//`.

export function stripJsoncComments(src: string): string {
  let out = "";
  let i = 0;
  const len = src.length;
  let inString = false;
  let stringChar = "";
  while (i < len) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < len) {
        // Preserve the escaped character verbatim so `\"` doesn't prematurely
        // close the string and trick the comment scanner on the next char.
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === stringChar) inString = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      i++;
      continue;
    }
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      // Line comment — swallow through (but not including) the next newline,
      // which we preserve so line numbers in JSON.parse errors stay accurate.
      while (i < len && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      // Block comment — swallow through the closing `*/`. Preserve any
      // newlines inside the comment so JSON.parse line numbers line up
      // with the user's source file.
      i += 2;
      while (i < len && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Parse JSONC → unknown. Throws SyntaxError with the original source line
// context when JSON.parse fails (so "bad JSON on line 7" works even after
// we strip comments).
export function parseJsonc(src: string): unknown {
  // Strip a leading UTF-8 BOM (U+FEFF). Notepad on Windows defaults to
  // BOM-prefixed UTF-8, so a user who hand-edits ~/.claude.json there and
  // saves it back produces a file JSON.parse rejects. The strip lives in the
  // wrapper so stripJsoncComments stays focused on comments/strings.
  const debommed = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const stripped = stripJsoncComments(debommed);
  return JSON.parse(stripped);
}
