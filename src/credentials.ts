// Heuristic detection of "missing credential" failures. When a local
// upstream fails to start with a stderr tail like "GITHUB_TOKEN is
// required" or "Missing env var: OPENAI_API_KEY", yaw-mcp can prompt the
// user for the value directly via MCP elicitation rather than making
// them hunt for where to put it. We only ever treat ALL_CAPS names as
// credentials -- anything else is too noisy to infer.

// Case-insensitive so the surrounding English is matched in any casing,
// but the captured name is post-filtered to require ALL_CAPS so ordinary
// English words ("var", "missing") never sneak through.
//
// Pattern 1 tolerates every phrasing servers actually emit around the name:
// an optional "required", an optional "env"/"environment", an optional
// "var"/"variable", and an optional COLON after ANY of "missing", "env"/
// "environment" or "var"/"variable" -- "Missing env var: OPENAI_API_KEY"
// (this file's own header example), "Missing env: X" and "missing: X" all
// matched none of those before (the colon was only tolerated after the
// var/variable group). The `\s+` AFTER each optional colon is load-bearing:
// without it "Missing VARIANT_TOKEN" has its leading "VAR" eaten by the
// var/variable group and reports the name as "IANT_TOKEN" (and "Missing
// ENV_TOKEN" would lose its "ENV" the same way).
const MISSING_PATTERNS: RegExp[] = [
  /\bmissing\s*:?\s+(?:required\s+)?(?:(?:env|environment)\s*:?\s+)?(?:(?:variable|var)\s*:?\s+)?([A-Z_][A-Z0-9_]{2,})\b/gi,
  /\b([A-Z_][A-Z0-9_]{2,})\s+is\s+(?:required|not\s+set|missing|empty|undefined)\b/gi,
  /\b([A-Z_][A-Z0-9_]{2,})\s+must\s+be\s+set\b/gi,
  /\bplease\s+set\s+(?:env\s+(?:var\s+|variable\s+)?)?([A-Z_][A-Z0-9_]{2,})\b/gi,
];

// A failing server's stderr chooses what the user is asked to type into a
// secret prompt, so the ALL_CAPS shape alone is far too loose: "SSH_AUTH_SOCK
// is not set" and "ERROR is undefined" are ordinary infrastructure/English
// noise, and eliciting for them trains the user to paste secrets at prompts
// that had nothing to do with a credential. A name therefore has to LOOK like
// a credential before it can be elicited, on top of the deny-list below.
//
// Matching is by UNDERSCORE SEGMENT, not substring: a substring test for
// "KEY" also fires on MONKEY_CAGE, and one for "AUTH" fires on SSH_AUTH_SOCK
// -- the exact false positive this filter exists to stop. AUTH is
// deliberately absent for that reason; a genuine token is spelled with one of
// the words below somewhere in the name.
//
// A bare "API" segment is absent for the same reason: it makes API_URL,
// API_HOST and API_BASE credential-shaped and pops a secret prompt for a
// URL, while adding nothing for real keys -- API_KEY / STRIPE_API_KEY /
// OPENAI_API_KEY all still match on their KEY (or TOKEN) segment, and the
// underscore-less APIKEY spelling is listed in its own right below.
const CREDENTIAL_SEGMENTS = new Set([
  "TOKEN",
  "TOKENS",
  "SECRET",
  "SECRETS",
  "KEY",
  "KEYS",
  "APIKEY",
  "PASSWORD",
  "PASSWD",
  "PASS",
  "PASSPHRASE",
  "CREDENTIAL",
  "CREDENTIALS",
  "CREDS",
  "PAT",
  "DSN",
  "BEARER",
  "PASSWORDS",
  "CLIENTSECRET",
  "BOTTOKEN",
  // -KEY compounds are ENUMERATED, not inferred: KEY is kept off the suffix
  // rule below because MONKEY, TURKEY, HOCKEY and DONKEY all end in it.
  "SECRETKEY",
  "SIGNINGKEY",
  "ACCESSKEY",
  "PRIVATEKEY",
  "SSHKEY",
  "AUTHKEY",
  "MASTERKEY",
  "LICENSEKEY",
]);

// A segment that ENDS in one of these is a credential noun with a qualifier
// glued to its front -- BOTTOKEN, CLIENTSECRET, AUTHTOKEN, DBPASSWORD -- and
// reads as a credential exactly as its split form (BOT_TOKEN) does. Tested
// as a SUFFIX, never a substring, because that is the direction English does
// not build ordinary words in: "tokenizer" and "secretary" start with the
// noun, nothing common ends in "token" or "secret". So S3_SECRETKEY,
// SLACK_BOTTOKEN and OAUTH_CLIENTSECRET elicit while TOKENIZER_PATH and
// SECRETARY_EMAIL stay refused. KEY is deliberately absent (see the -KEY
// note in CREDENTIAL_SEGMENTS); so is PASS (BYPASS, COMPASS).
const CREDENTIAL_NOUN_SUFFIXES = ["TOKEN", "SECRET", "PASSWORD", "PASSPHRASE", "CREDENTIAL"];

// Names with no underscores at all (GITHUBTOKEN, APIKEY) never split into a
// segment the set can match, so a small set of unambiguous substrings backs
// the segment test up -- for THOSE names only (see isCredentialShaped). A name
// that has underscores already had every segment tested, and applying the
// substring test to it as well is what made "TOKENIZER_PATH is required"
// pop a secret prompt for a file path: "TOKEN" is a whole word here, but it
// is also the head of an ordinary one.
const CREDENTIAL_SUBSTRINGS = ["TOKEN", "SECRET", "PASSWORD", "PASSPHRASE", "APIKEY", "CREDENTIAL"];

// Belt-and-braces on top of the credential-shape test above: these are names
// that either ARE infrastructure variables or are English words a server is
// likely to shout in a failure line. Keeping them listed means the filter
// still refuses them if the shape test is ever relaxed.
const IGNORED = new Set([
  "PATH",
  "HOME",
  "USER",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TERM",
  "SHELL",
  "NODE_ENV",
  "DEBUG",
  "LOG_LEVEL",
  "SSH_AUTH_SOCK",
  "DISPLAY",
  "LANG",
  "LC_ALL",
  "PWD",
  "PS1",
  "EDITOR",
  "PAGER",
  "HOSTNAME",
  "ERROR",
  "WARNING",
  "NOTE",
  "TODO",
  "NULL",
  "NONE",
  "UNDEFINED",
  "CONFIG",
  "OPTION",
  "OPTIONS",
  "VALUE",
  "VAR",
]);

// JS regex has no (?i:...) scoped case-insensitivity, so the capture-group
// case check has to happen in code: keep only matches whose captured span
// is already uppercase in the original input.
function isAllCaps(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]{2,}$/.test(name);
}

/** Does this ALL_CAPS name read as a credential rather than as ordinary
 *  infrastructure? See CREDENTIAL_SEGMENTS for why the test is per-segment. */
function isCredentialShaped(name: string): boolean {
  for (const segment of name.split("_")) {
    if (CREDENTIAL_SEGMENTS.has(segment)) return true;
    // Strictly LONGER than the noun: the whole-word case is the set's job,
    // and this rule is only for the compound (BOTTOKEN) the set cannot list
    // exhaustively. Before it, the underscore gate below refused every
    // underscored compound outright -- S3_SECRETKEY, SLACK_BOTTOKEN and
    // OAUTH_CLIENTSECRET, all of which the old substring test had caught,
    // stopped eliciting the day TOKENIZER_PATH was fixed.
    if (CREDENTIAL_NOUN_SUFFIXES.some((noun) => segment.length > noun.length && segment.endsWith(noun))) {
      return true;
    }
  }
  // The substring fallback exists for names the segment split cannot see
  // into (no underscore at all). A name WITH underscores has just had every
  // segment checked, as a whole word and as a noun-suffixed compound, so a
  // substring hit on it can only be a noun buried at the HEAD or middle of a
  // longer segment -- TOKENIZER_PATH, SECRETARY_EMAIL -- which is exactly the
  // false positive the segment rule was written to refuse.
  if (name.includes("_")) return false;
  return CREDENTIAL_SUBSTRINGS.some((s) => name.includes(s));
}

export function detectMissingCredentials(stderrOrMessage: string | undefined): string[] {
  if (!stderrOrMessage) return [];
  const found = new Set<string>();
  for (const re of MISSING_PATTERNS) {
    for (const match of stderrOrMessage.matchAll(re)) {
      const name = match[1];
      if (name && isAllCaps(name) && isCredentialShaped(name) && !IGNORED.has(name)) found.add(name);
    }
  }
  return [...found];
}
