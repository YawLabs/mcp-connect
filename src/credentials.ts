// Heuristic detection of "missing credential" failures. When a local
// upstream fails to start with a stderr tail like "GITHUB_TOKEN is
// required" or "Missing env var: OPENAI_API_KEY", mcph can prompt the
// user for the value directly via MCP elicitation rather than making
// them hunt for the dashboard. We only ever treat ALL_CAPS names as
// credentials — anything else is too noisy to infer.

// Case-insensitive so the surrounding English is matched in any casing,
// but the captured name is post-filtered to require ALL_CAPS so ordinary
// English words ("var", "missing") never sneak through.
const MISSING_PATTERNS: RegExp[] = [
  /\bmissing\s+(?:env\s+|environment\s+)?(?:variable\s+|var\s+)?([A-Z_][A-Z0-9_]{2,})\b/gi,
  /\b([A-Z_][A-Z0-9_]{2,})\s+is\s+(?:required|not\s+set|missing|empty|undefined)\b/gi,
  /\b([A-Z_][A-Z0-9_]{2,})\s+must\s+be\s+set\b/gi,
  /\bplease\s+set\s+(?:env\s+(?:var\s+|variable\s+)?)?([A-Z_][A-Z0-9_]{2,})\b/gi,
];

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
]);

// JS regex has no (?i:...) scoped case-insensitivity, so the capture-group
// case check has to happen in code: keep only matches whose captured span
// is already uppercase in the original input.
function isAllCaps(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]{2,}$/.test(name);
}

export function detectMissingCredentials(stderrOrMessage: string | undefined): string[] {
  if (!stderrOrMessage) return [];
  const found = new Set<string>();
  for (const re of MISSING_PATTERNS) {
    for (const match of stderrOrMessage.matchAll(re)) {
      const name = match[1];
      if (name && isAllCaps(name) && !IGNORED.has(name)) found.add(name);
    }
  }
  return [...found];
}
