// `yaw-mcp bundles [list|match]` — CLI counterpart to the `mcp_connect_bundles`
// meta-tool (v0.28.0). The LLM-facing tool has always been the primary
// surface, but users ask "what bundles exist?" in support threads often
// enough that surfacing them in the CLI is worth it: a human can skim the
// curated list without starting an MCP session.
//
// Two actions mirror the meta-tool's `action` parameter:
//
//   list    Static view of every curated bundle with activate hints. No
//           network, no token needed. Good for browsing or sharing in
//           onboarding docs.
//
//   match   Reads the servers yaw-mcp actually MAKES AVAILABLE -- enabled
//           entries from bundles.json (project file winning over user-global)
//           minus anything the config.json allow/deny profile excludes -- and
//           partitions the bundles into "ready to activate" vs "partially
//           installed" vs "ignored" (zero overlap). Also local: no network, no
//           token needed.
//
//           NOT side-effect-free, though: `match` calls loadYawMcpConfig,
//           which runs the pre-0.12 legacy-path migration before resolving
//           any file (migrate.ts). That RENAMES a `~/.yaw-mcp.json` into
//           `~/.yaw-mcp/config.json`, and a project `.yaw-mcp.json` /
//           `.yaw-mcp.local.json` into `<project>/.yaw-mcp/`, on the way
//           through. One-shot, idempotent (an existing target is never
//           overwritten) and fail-open, but a real write -- so `match` is a
//           read of the CONFIG, not a read-only command on the filesystem.
//
// Output is human-readable text by default. `--json` on either action
// emits a machine-readable shape for pipeline use.
//
// Exit codes:
//   0  always -- neither action has a failure mode that surfaces as an exit
//      code. A malformed bundles.json degrades to "no servers" plus a warning
//      on stderr rather than an error exit, and the legacy migration above
//      absorbs its own errors.

import {
  type BundleMatchResult,
  bundleActivateHint,
  CURATED_BUNDLES,
  type CuratedBundle,
  comparePartialBundles,
  matchBundles,
} from "./bundles.js";
import { isAllowed, loadYawMcpConfig } from "./config-loader.js";
import { loadLocalBundles } from "./local-bundles.js";

export type BundlesAction = "list" | "match";

export interface BundlesCommandOptions {
  home?: string;
  cwd?: string;
  /** Environment `match` runs under. Both loaders it calls read exactly one
   *  key from it (YAW_MCP_TRUST_PROJECT for bundles.json, the project-dir
   *  walk's ownership opt-in for config.json), but it must be threaded rather
   *  than left to default inside them: `add`, `remove` and `list` inject
   *  theirs, and an embedded or test caller supplying an env expects THAT env
   *  to decide which bundles.json is in effect -- not the real process's,
   *  which made `list` and `bundles match` disagree on the same repo. */
  env?: NodeJS.ProcessEnv;
  action?: BundlesAction;
  json?: boolean;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export interface BundlesCommandResult {
  exitCode: number;
  /** Everything printed, in emission order, BOTH streams interleaved. Kept for
   *  callers that just want the transcript; use `stdout` / `stderr` when the
   *  two have to be told apart. */
  lines: string[];
  /** Only what went to stdout -- under `--json` that is exactly the JSON body,
   *  so a programmatic caller can `JSON.parse(result.stdout.join("\n"))`
   *  without first stripping warning lines out of a mixed transcript. */
  stdout: string[];
  /** Only the warnings. Interleaving them into `lines` meant a --json consumer
   *  could not split the body from the diagnostics without re-parsing the
   *  transcript -- the one thing the two-stream split exists to avoid. */
  stderr: string[];
}

export interface ParsedBundlesArgs {
  action: BundlesAction;
  json: boolean;
}

export const BUNDLES_USAGE = `Usage: yaw-mcp bundles [list|match] [--json]

  Curated multi-server bundles -- hand-picked stacks you can activate in one step.

  list      List every curated bundle (default).
  match     Partition bundles against the servers in your bundles.json.

  --json    Emit machine-readable JSON instead of a table.`;

export function parseBundlesArgs(
  argv: string[],
): { ok: true; options: ParsedBundlesArgs } | { ok: false; error: string; help?: boolean } {
  let action: BundlesAction = "list";
  let json = false;
  let actionSet = false;
  for (const a of argv) {
    if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      return { ok: false, error: BUNDLES_USAGE, help: true };
    } else if (a === "list" || a === "match") {
      if (actionSet) {
        return {
          ok: false,
          error: `yaw-mcp bundles: action already set to "${action}" (got "${a}")\n\n${BUNDLES_USAGE}`,
        };
      }
      action = a;
      actionSet = true;
    } else {
      return { ok: false, error: `yaw-mcp bundles: unknown argument "${a}"\n\n${BUNDLES_USAGE}` };
    }
  }
  return { ok: true, options: { action, json } };
}

export async function runBundlesCommand(opts: BundlesCommandOptions = {}): Promise<BundlesCommandResult> {
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  // Three transcripts, not one: `lines` stays the interleaved emission-order
  // record every existing caller reads, while `stdout` / `stderr` keep the two
  // streams separable. A `--json` consumer of the returned result could not
  // otherwise tell the JSON body from a warning line without re-parsing the
  // transcript, which is precisely what routing warnings to stderr in the
  // PRINTED output already avoids.
  const lines: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const print = (s = ""): void => {
    lines.push(s);
    stdout.push(s);
    write(`${s}\n`);
  };
  const printErr = (s: string): void => {
    lines.push(s);
    stderr.push(s);
    writeErr(`${s}\n`);
  };

  const action = opts.action ?? "list";

  if (action === "list") {
    if (opts.json) {
      print(JSON.stringify({ bundles: CURATED_BUNDLES }, null, 2));
    } else {
      renderList(print);
    }
    return { exitCode: 0, lines, stdout, stderr };
  }

  // action === "match" — reads the same local bundles.json server.ts loads at
  // startup AND the same config.json profile it enforces, so the CLI's
  // partition and the LLM-facing `mcp_connect_bundles` partition are computed
  // over the identical server set.
  const env = opts.env ?? process.env;
  const loaded = await loadLocalBundles({ cwd: opts.cwd, home: opts.home, env });
  const config = await loadYawMcpConfig({ cwd: opts.cwd, home: opts.home, env });

  // Surface load warnings so a malformed bundles.json (or config.json) reads as
  // "this file is broken" instead of "you have no servers." stderr keeps stdout
  // clean for a --json consumer.
  for (const w of loaded.warnings) printErr(`warning: ${w}`);
  for (const w of config.warnings) printErr(`warning: ${w}`);

  // Only count enabled servers — disabled ones won't auto-activate so
  // they shouldn't count toward a bundle being "ready."
  const enabled = (loaded.config?.servers ?? []).filter((s) => s.isActive).map((s) => s.namespace);
  // ...and only those the config.json allow/deny profile permits. This is the
  // second half of the filter the LLM-facing `mcp_connect_bundles` uses
  // (server.ts getProfiledActiveServers = isActive AND profileAllows). Counting
  // a blocked namespace as installed made the CLI print a bundle as "Ready to
  // activate" with an `mcp_connect_activate({...})` snippet the server then
  // hard-refuses -- the one thing this command exists to get right.
  const installed = enabled.filter((ns) => isAllowed(config, ns));
  const excluded = enabled.filter((ns) => !isAllowed(config, ns));
  const match = matchBundles(installed);

  if (opts.json) {
    print(JSON.stringify({ installed, excluded, ...match }, null, 2));
    return { exitCode: 0, lines, stdout, stderr };
  }

  renderMatch(match, installed, excluded, print);
  return { exitCode: 0, lines, stdout, stderr };
}

function renderList(print: (s?: string) => void): void {
  print(`${CURATED_BUNDLES.length} curated bundles`);
  print("");
  // Group by category so the reader can skim the category they care
  // about. Inside each category sort by id alphabetical for stability.
  const byCategory = new Map<string, CuratedBundle[]>();
  for (const b of CURATED_BUNDLES) {
    const list = byCategory.get(b.category) ?? [];
    list.push(b);
    byCategory.set(b.category, list);
  }
  const categories = [...byCategory.keys()].sort();
  for (const cat of categories) {
    const list = (byCategory.get(cat) ?? []).slice().sort((a, b) => a.id.localeCompare(b.id));
    print(`  [${cat}]`);
    for (const b of list) {
      print(`    ${b.id.padEnd(18)} ${b.name}`);
      print(`                       ${b.description}`);
      print(`                       -> ${bundleActivateHint(b)}`);
    }
    print("");
  }
}

function renderMatch(
  match: BundleMatchResult,
  installed: string[],
  excluded: string[],
  print: (s?: string) => void,
): void {
  const installedList = installed.length === 0 ? "(none)" : installed.slice().sort().join(", ");
  const serverWord = installed.length === 1 ? "server" : "servers";
  print(
    `Checked ${CURATED_BUNDLES.length} bundles against ${installed.length} available ${serverWord}: ${installedList}`,
  );
  // Name what the profile took out of the count, or a bundle that "should" be
  // ready reads as a bug in the matcher rather than as the deny-list doing its
  // job. Only printed when a profile actually excluded something.
  if (excluded.length > 0) {
    print(
      `Excluded by your config.json allow/deny profile: ${excluded.slice().sort().join(", ")} (enabled in bundles.json, but not activatable)`,
    );
  }
  print("");

  if (match.ready.length === 0 && match.partial.length === 0) {
    print("No curated bundles match your current config.");
    print("Run `yaw-mcp bundles list` to see the full catalog.");
    return;
  }

  if (match.ready.length > 0) {
    print("Ready to activate (every namespace installed):");
    for (const b of match.ready.slice().sort((a, c) => a.id.localeCompare(c.id))) {
      print(`  ${b.id.padEnd(18)} ${b.description}`);
      print(`                     -> ${bundleActivateHint(b)}`);
    }
    print("");
  }

  if (match.partial.length > 0) {
    // THE shared comparator bundles.ts owns (comparePartialBundles), not a
    // copy of it: topPartialBundles ranks the inline discover hint with the
    // same function, so the CLI's ordering cannot desync from the server's the
    // next time someone tweaks a tie-break.
    const sorted = match.partial.slice().sort(comparePartialBundles);
    print("Partially installed (install more to complete):");
    for (const entry of sorted) {
      const have = entry.have.join(", ");
      const missing = entry.missing.join(", ");
      print(`  ${entry.bundle.id.padEnd(18)} have: ${have}; missing: ${missing}`);
    }
    print("");
  }
}
