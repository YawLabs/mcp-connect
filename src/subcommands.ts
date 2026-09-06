// Side-effect-free registry of dispatched subcommands + flag aliases.
//
// Lives in its own module (not index.ts) because index.ts runs the
// dispatcher at import time -- importing it from a test would boot the
// CLI. Keeping the known-subcommand list here lets the completion test
// import the ground-truth dispatch table directly and assert
// SUBCOMMAND_SPEC covers every real subcommand (no hand-maintained
// mirror to drift).

import { closestNames, levenshtein } from "./fuzzy.js";

// Leading-dash flag aliases handled by the dispatcher (help/version).
// Kept separate from the subcommand names so consumers (did-you-mean,
// completion coverage) can filter them out cleanly.
export const FLAG_ALIASES = ["--help", "-h", "--version", "-V"] as const;

// Known subcommands for fuzzy-match feedback on typos. Anything not in
// this list and not a flag (leading `-`) falls through to "unknown
// subcommand" before runServer, so `yaw-mcp instal` fails loud instead of
// silently booting a stdio MCP server on a dead prompt.
//
// HAND-MAINTAINED: this list MUST track the dispatch chain in
// src/index.ts. The completion drift guard compares SUBCOMMAND_SPEC
// against THIS table, so a name left here after its dispatch branch is
// removed keeps passing the guard while did-you-mean and shell
// completion suggest a dead command (exactly what happened when commit
// 45a3462 removed the Yaw Team surface: login/logout/sync/stats/token/
// set-active lingered here). When you add or remove an index.ts branch,
// update this list in the same commit.
//
// That last sentence is enforced now, not merely requested: the test
// "lists exactly the subcommands index.ts dispatches" (index-dispatch.
// test.ts) scrapes every `subcommand === "..."` literal out of index.ts
// and requires the two sets to be equal, in both directions. A branch
// added without an entry here, or an entry outliving its branch, goes red.
export const KNOWN_SUBCOMMANDS = [
  "compliance",
  "audit",
  "foundry",
  "install",
  "add",
  "remove",
  "list",
  "doctor",
  "reset-learning",
  "servers",
  "sidecars",
  "bundles",
  "completion",
  "upgrade",
  "try",
  "try-cleanup",
  "secrets",
  "trust",
  "help",
  ...FLAG_ALIASES,
] as const;

/**
 * Suggest the closest real subcommands for a bare (non-dash) typo.
 * `help` stays in the pool so `halp` -> `help`; only the leading-dash
 * flag aliases are stripped (those are handled by `suggestFlag`).
 * Returns up to `limit` names, best first; [] when nothing is close.
 */
export function suggestSubcommand(input: string, limit = 3): string[] {
  const visible = KNOWN_SUBCOMMANDS.filter((s) => !s.startsWith("-"));
  return closestNames(input, visible, limit);
}

/**
 * Suggest the closest known flag alias for a long-form leading-dash typo
 * (e.g. `--versionn` -> `--version`, `--hepl` -> `--help`). A wrong-case
 * spelling counts as a typo too (`--HELP` -> `--help`): index.ts dispatches
 * only the exact raw spellings, so without a suggestion here the mis-cased
 * flag falls through to runServer and hangs. Restricted to inputs longer
 * than a single-letter flag (length > 2) so a genuine short flag like a
 * server's own lowercase `-v` is NOT hijacked by a case-only match against
 * `-V` -- that gate is what keeps case-insensitive matching safe here.
 *
 * Uses pure levenshtein distance <= 2 (without the prefix/substring tiers
 * that closestNames adds). Prefix matching would over-trigger: `--vers`
 * is 3+ edits from nothing, but a prefix tier would "suggest" for any
 * head-fragment of an alias. Edit-distance only keeps the did-you-mean
 * to genuine typos.
 *
 * Returns up to `limit` aliases, best first; [] when nothing is close.
 * The CALLER (index.ts) rejects every unknown leading-dash arg with exit
 * 2 either way -- [] just selects the generic "--help" hint over a
 * did-you-mean. (runServer reads no argv, so there is no server flag for
 * an unknown flag to fall through TO; the old pass-through booted a
 * stdio server on a dead prompt.)
 */
export function suggestFlag(input: string, limit = 2): string[] {
  if (input.length <= 2) return [];
  const q = input.toLowerCase();
  const hits: Array<{ name: string; d: number }> = [];
  for (const alias of FLAG_ALIASES) {
    // Never "did you mean yourself" -- but the skip must be an exact RAW
    // match, not a case-insensitive one. index.ts dispatches every raw
    // spelling (`--help` / `-h` / `--version` / `-V`) by === before this
    // runs, so a raw-identical flag never reaches here; a case-insensitive
    // skip therefore only ever discards the one alias the user most likely
    // meant. That dropped `--help` from the pool for `--HELP`, left every
    // remaining alias >2 edits away, returned [], and let index.ts fall
    // through to runServer -- booting a stdio MCP server that hangs with no
    // output on a dead prompt.
    if (alias === input) continue;
    const d = levenshtein(q, alias.toLowerCase());
    if (d <= 2) hits.push({ name: alias, d });
  }
  hits.sort((a, b) => a.d - b.d || a.name.localeCompare(b.name));
  return hits.slice(0, limit).map((h) => h.name);
}
