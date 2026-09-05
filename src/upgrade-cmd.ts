// `yaw-mcp upgrade` — installs (or tells the user how to install) the
// newest version of `@yawlabs/mcp`. Detects the invocation mode from
// process.argv[1] so the action matches how yaw-mcp is actually
// reaching this process:
//   - global npm (`npm install -g @yawlabs/mcp`)  → `npm install -g @yawlabs/mcp@latest`
//   - pnpm / bun global store                      → `pnpm add -g` / `bun add -g @yawlabs/mcp@latest`
//   - local node_modules                           → `npm install @yawlabs/mcp@latest` in that tree's root
//   - npx cache                                    → restart the MCP client; `npx -y` always pulls the latest
//   - bundled inside Yaw Terminal (asar.unpacked)  → nothing to run; it updates with the app
//   - standalone SEA binary (track retired 0.70.3) → `npm install -g @yawlabs/mcp@latest`; delete the old executable
//   - unknown / dev checkout                       → print the command and let the user decide
//
// The --run flag spawns the owning tool for the global-npm, pnpm-global,
// bun-global, and local-node-modules cases; for "npx" there is nothing
// to do and --run just prints the "restart your client" hint. Never
// spawns destructive commands — only `npm install [-g]` / `pnpm add -g` /
// `bun add -g` of exactly our package is allowed, and stdout/stderr
// stream through to the caller unchanged.
//
// Exit codes:
//   0  already on the latest version, there is nothing to run (npx /
//      bundled-app), OR the registry was unreachable (see OFFLINE below)
//   1  upgrade available but nothing was installed -- either --run was not
//      passed (human-interactive mode), or --json was, which is a report-only
//      snapshot that never spawns. `--json --run` on a stale install is
//      therefore still 1: the flag combination reports, it does not upgrade.
//   2  usage error (unknown flag), OR --run on an install method that
//      can't be auto-upgraded (binary / dev-checkout / unknown)
//   3  --run attempted the upgrade and the child process failed
//
// After a `--run` whose child exited 0, the RUNNING copy is checked too: the
// package.json of the `@yawlabs/mcp` directory argv[1] was loaded from is
// re-read (runningPackageDir), and when it still reports the old version --
// the install landed in a different tree: a global prefix `--prefix` could
// not pin, or a copy nested under another package's node_modules
// (`/proj/node_modules/foo/node_modules/@yawlabs/mcp`, where localInstallRoot's
// FIRST-segment rule installs a new top-level dependency into /proj and the
// nested copy stays put) -- a WARNING naming that directory goes to stderr.
// Advisory only: the exit code stays 0, because the child did succeed and
// the 0..3 contract above is what scripts branch on. The first-segment rule
// itself is kept on purpose: it is what makes pnpm's
// `<root>/node_modules/.pnpm/<pkg>/node_modules/@yawlabs/mcp` layout resolve
// to the correct root, so a nested copy is reported, not refused.
//
// OFFLINE — a scripting hazard of the same class as the 1→2 trap below.
// When the registry can't be reached, staleness is UNKNOWN, and EVERY
// method — including a stale global-npm — exits 0 after printing
// "couldn't reach the npm registry (offline? firewall?)". So exit 0 means
// "nothing to do OR never checked", not "up to date": a CI step shaped
// like `yaw-mcp upgrade || yaw-mcp upgrade --run` behind a firewall
// records "up to date" forever while the install never moves. A script
// that must tell the two apart has to read the --json snapshot, where
// `latest: null` is the offline marker (`stale` is false there because
// staleness cannot be computed, not because the install is current).
// Pinned by the offline tests in src/tests/upgrade-cmd.test.ts.
//
// SCRIPTING TRAP — the 1→2 transition for NON-RUNNABLE methods (binary,
// dev-checkout, unknown): for these, plain `upgrade` on a stale install
// returns 1 ("upgrade available, --run not passed"), but they can NEVER
// be auto-run, so the advertised `--run` deterministically returns 2,
// not 0. A script that treats 1 as "retry with --run" will always then
// hit exit 2. This is intentional: these methods require a MANUAL
// upgrade (the retired-binary npm reinstall / `git pull` / inspect the
// tree), so the
// human-facing message says "manual upgrade required" rather than
// promising --run will fix it. Branch on the `method` field of the
// --json snapshot (or on exit 2) instead of blindly chaining --run.
//
// `yaw-mcp doctor` shows the same staleness status — upgrade is purely
// the "what do I type to fix it" surface. Kept separate so scripts
// that already run doctor can chain into `yaw-mcp upgrade --run` and
// have the shell do the right thing deterministically.

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { stripInternalSecretsFromEnv } from "./internal-secret-env.js";
import { compareVersions, MIN_OAM_VERSION, type OamProbe, probeOam } from "./oam-spawn.js";

declare const __VERSION__: string;

/** The SEA binary track was RETIRED in 0.70.3 (docs/v0.70.3-binary-track-
 *  decision.md); the last binaries live on the frozen v0.70.2 release --
 *  OLDER than npm, so pointing users at "releases/latest" was a dead end.
 *  A binary install still gets detected (real v0.70.2 downloads exist),
 *  and its upgrade path is: install from npm, delete the old executable.
 *  Single source of truth for that message so upgrade / auto-upgrade /
 *  doctor all say the same thing. */
// Built below UPGRADE_COMMANDS (it needs the table) -- see BINARY_RETIRED_HINT
// after upgradeCommandLine. Declared there rather than here so the command it
// quotes is the table's global-npm line, never a second spelling of the spec.

export interface UpgradeCommandOptions {
  /** When true, actually spawn the upgrade command. Runnable methods only --
   *  global-npm, pnpm-global, bun-global and local-node-modules each spawn
   *  their OWNING tool; every other method (npx / bundled-app are no-ops,
   *  binary / dev-checkout / unknown are manual) refuses without spawning. */
  run?: boolean;
  /** Emit a machine-readable JSON snapshot instead of prose. */
  json?: boolean;
  /** Test hook: replace the npm registry fetch. */
  fetchLatest?: () => Promise<string | null>;
  /** Test hook: override the argv path detection. */
  argvPath?: string;
  /** Test hook: override the current version. */
  currentVersion?: string;
  /** Test hook: override stdout. */
  out?: (s: string) => void;
  /** Test hook: override stderr. */
  err?: (s: string) => void;
  /** Test hook: override the spawn invocation (returns exit code). */
  spawnImpl?: (cmd: string, args: string[], cwd?: string) => Promise<number>;
  /** Test hook: replace the `npm prefix -g` probe used to refine
   *  ambiguous install-method detections. */
  npmPrefix?: () => Promise<string | null>;
  /** Test hook: replace the running-install prefix walk behind the
   *  `--prefix` a global-npm upgrade passes (see defaultRunningPrefix). */
  runningPrefix?: (argvPath: string | undefined) => string | null | Promise<string | null>;
  /** Test hook: override the platform the `--prefix` quoting decides against.
   *  Both quoters take it, so a POSIX runner can exercise the win32-only
   *  unquotable-prefix fallback (the branch that drops `--prefix` from the
   *  spawn argv AND from every printed suggestion). */
  platform?: NodeJS.Platform;
  /** Test hook: force single-executable (SEA binary) detection. */
  isSea?: () => boolean;
  /** Test hook: replace the `oam --version` probe behind the oam-floor note. */
  oamProbe?: () => OamProbe | Promise<OamProbe>;
  /** Test hook: replace the post-`--run` read of the running copy's
   *  package.json version (see defaultInstalledVersion). Null means "could not
   *  read it", which skips the check rather than warning on a guess. */
  installedVersion?: (pkgDir: string) => string | null | Promise<string | null>;
}

export interface UpgradeCommandResult {
  exitCode: number;
  lines: string[];
}

export type InstallMethod =
  | "global-npm"
  | "pnpm-global"
  | "bun-global"
  | "npx"
  | "local-node-modules"
  | "bundled-app"
  | "dev-checkout"
  | "binary"
  | "unknown";

/** POSIX-style global prefixes keep globals at `<prefix>/lib/node_modules`.
 *  These alternatives each anchor on a prefix shape that really is a Node
 *  install root: a bare `/lib/node_modules/@yawlabs/mcp/` marker also matched a
 *  workspace package directory literally named `lib`
 *  (`<repo>/packages/lib/node_modules/@yawlabs/mcp/...`), which then drove
 *  auto-upgrade's `npm install -g --prefix <repo>/packages` — writing a global
 *  tree plus bin shims into the user's repo and overwriting the
 *  workspace-pinned version.
 *
 *  Anchoring deliberately trades a false POSITIVE (unrecoverable: a `-g`
 *  install into a project tree) for a false NEGATIVE (recoverable: the install
 *  is classified `local-node-modules`, refineInstallMethod's `npm prefix -g`
 *  probe reclassifies it for the CLI, and maybeAutoUpgrade merely logs the
 *  manual path instead of spawning). An exotic prefix that isn't listed here
 *  therefore degrades safely — do NOT widen this back to a bare
 *  `/lib/node_modules/`.
 *    /usr/lib, /usr/local/lib   distro packages and `make install` defaults
 *    /opt/<tool>/lib            homebrew (/opt/homebrew), /opt/node, /opt/nodejs
 *  The optional drive prefix keeps a normalized `C:/usr/local/lib/...`
 *  (MSYS/Cygwin) matching the same shape. */
const POSIX_GLOBAL_LIB_PREFIX = /^(?:[A-Za-z]:)?(?:\/usr(?:\/local)?|\/opt\/[^/]+)\/lib\/node_modules\/@yawlabs\/mcp\//;

/** Version-manager and rootless-user Node roots, which also keep globals at
 *  `<root>/lib/node_modules`. Same anchoring rationale as
 *  POSIX_GLOBAL_LIB_PREFIX -- and the anchor has to be each manager's REAL
 *  layout. The marker used to allow any number of free segments between the
 *  manager directory and `lib`, which re-opened the exact false positive the
 *  anchoring exists to close: any repo under an ancestor named `.local`, `n`,
 *  `fnm`, ... satisfied it (`~/.local/share/myrepo/packages/lib/node_modules/
 *  @yawlabs/mcp/...`) and landed back on the unrecoverable
 *  `npm install -g --prefix <repo>/packages`. Each alternative below is one
 *  manager's fixed shape, version segment included:
 *    ~/.nvm/versions/node/v22.11.0/lib/node_modules
 *    ~/.volta/tools/image/node/22.11.0/lib/node_modules
 *    ~/.asdf/installs/nodejs/22.11.0/lib/node_modules
 *    ~/.fnm/node-versions/v22.11.0/installation/lib/node_modules
 *    ~/.local/share/fnm/node-versions/v22.11.0/installation/lib/node_modules
 *    ~/.nodenv/versions/22.11.0/lib/node_modules
 *    ~/.nvs/node/22.11.0/x64/lib/node_modules
 *    <N_PREFIX>/n/versions/node/22.11.0/lib/node_modules
 *    ~/.local/lib/node_modules            (rootless `npm -g --prefix ~/.local`)
 *  Anything else degrades safely to local-node-modules, exactly as documented
 *  on POSIX_GLOBAL_LIB_PREFIX. */
const MANAGED_NODE_LIB_PREFIX =
  /\/(?:\.nvm\/versions\/node\/[^/]+|\.volta\/tools\/image\/node\/[^/]+|\.asdf\/installs\/nodejs\/[^/]+|(?:\.local\/share\/)?\.?fnm\/node-versions\/[^/]+\/installation|\.nodenv\/versions\/[^/]+|\.nvs\/[^/]+\/[^/]+\/[^/]+|n\/versions\/node\/[^/]+|\.local)\/lib\/node_modules\/@yawlabs\/mcp\//;

export interface UpgradePlan {
  current: string;
  latest: string | null;
  stale: boolean;
  method: InstallMethod;
  /** Command to run to move to the latest version. Null when method=npx (nothing to do). */
  command: string | null;
  /** Directory `command` must run IN, or null when it can run anywhere.
   *  Only local-node-modules installs need one -- the package-tree root, i.e.
   *  everything above the first `node_modules` segment. `npm install
   *  @yawlabs/mcp@latest` run from any other directory does not upgrade that
   *  tree: it creates a stray package.json + node_modules wherever it landed
   *  and leaves the stale copy in place.
   *
   *  Present on the --json snapshot only. buildUpgradePlan has no argv[1] to
   *  walk, so it leaves the field absent; runUpgrade fills it in. */
  cwd?: string | null;
}

export const UPGRADE_USAGE = `Usage: yaw-mcp upgrade [--run] [--json]

  Show (or execute) the command to upgrade @yawlabs/mcp to the latest version.

  --run     Run the upgrade in place (global npm, pnpm, bun, and local npm
            installs). No-op for npx installs -- they always fetch the latest.
  --json    Emit a machine-readable snapshot ({ current, latest, stale,
            method, command, cwd }) instead of prose. "cwd" is the directory
            "command" must run IN -- the package-tree root for a
            local-node-modules install, null for every other method (the
            command can run anywhere). Running a local install's command from
            the wrong directory creates a stray package.json + node_modules
            there instead of upgrading the tree.
            NOTE: --json is a report-only snapshot; it never spawns an upgrade
            even when combined with --run, and exits 1 whenever "stale" is
            true. Use --run without --json to actually perform the upgrade.`;

export function parseUpgradeArgs(
  argv: string[],
): { ok: true; options: UpgradeCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: UpgradeCommandOptions = {};
  for (const a of argv) {
    if (a === "--run") opts.run = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") return { ok: false, error: UPGRADE_USAGE, help: true };
    else return { ok: false, error: `yaw-mcp upgrade: unknown argument "${a}"\n\n${UPGRADE_USAGE}` };
  }
  return { ok: true, options: opts };
}

/** Classify how yaw-mcp is being invoked. The argv[1] path is the most
 *  reliable signal — npm/npx land it in distinct directories. Falls
 *  through to `unknown` rather than guessing, which lets --json
 *  consumers branch without false positives.
 *
 *  Two passes, and the ORDER is load-bearing. Pass 1 classifies the literal
 *  argv path. Only when that yields `unknown` does pass 2 realpath the path and
 *  re-classify, which is what rescues the canonical POSIX invocation: `yaw-mcp
 *  upgrade` arrives through npm's bin SYMLINK (`<prefix>/bin/yaw-mcp`,
 *  `node_modules/.bin/yaw-mcp`, `_npx/<hex>/node_modules/.bin/yaw-mcp`), which
 *  matches none of the markers below and used to classify `unknown` -- so an
 *  ordinary global install paid a real `npm prefix -g` subprocess, then printed
 *  "Install: unknown" and refused `--run`.
 *
 *  Resolving FIRST would regress pnpm-global: `<pnpm-home>/global/<n>/
 *  node_modules/@yawlabs/mcp` is itself a symlink into
 *  `.pnpm/@yawlabs+mcp@<ver>/node_modules/@yawlabs/mcp`, whose resolved path
 *  misses the pnpm marker and falls through to `local-node-modules` -- i.e.
 *  `--run` would `npm install` inside the pnpm store, the precise hazard the
 *  pnpm/bun markers were written to prevent. A literal that already classifies
 *  is therefore never second-guessed.
 *
 *  `realpath` is injectable because unit tests work in fake paths that cannot
 *  be resolved on any real filesystem. In production a nonexistent or
 *  unreadable path throws and the literal answer stands, exactly as
 *  comparablePath degrades.
 *
 *  `resolveWhen` names the literal answers that get the second pass. The CLI
 *  default is `unknown` only, for the pnpm reason above. auto-upgrade's
 *  background upgrader shares this classifier and passes
 *  `["unknown", "local-node-modules"]`: a `node_modules/@yawlabs/mcp` that is
 *  a symlink into a global prefix (`npm link`, a bin shim staged into a
 *  project tree) is a literal `local-node-modules` and would otherwise never
 *  background-upgrade even though the bytes running belong to the global
 *  install. (It used to keep its own copy of the realpath pass for that one
 *  difference, one resolution-rule change away from drifting.) Widening is
 *  safe in the direction that matters: a resolved path is re-classified by
 *  the same markers, so a genuine project tree -- whose realpath is itself --
 *  stays `local-node-modules` and cannot become the `-g`-into-a-repo false
 *  positive the marker comments above warn about, and a marker match NOT in
 *  `resolveWhen` (pnpm-global above all) is never second-guessed. The paths
 *  the second pass newly reaches are genuine globals invoked through their
 *  bin shim -- for which detectRunningInstallPrefix already realpathed and
 *  already had the right `--prefix`; only the classification was missing. */
export function detectInstallMethod(
  argvPath: string | undefined,
  realpath: (p: string) => string = realpathSync,
  resolveWhen: readonly InstallMethod[] = ["unknown"],
): InstallMethod {
  if (!argvPath) return "unknown";
  const literal = classifyEntrypoint(argvPath);
  if (!resolveWhen.includes(literal)) return literal;
  let resolved: string;
  try {
    resolved = realpath(argvPath);
  } catch {
    return literal;
  }
  return resolved === argvPath ? literal : classifyEntrypoint(resolved);
}

/** The path-marker pass behind detectInstallMethod, run once on the literal
 *  argv path and (only when that says `unknown`) once on its realpath. */
function classifyEntrypoint(argvPath: string): InstallMethod {
  const normalized = argvPath.replace(/\\/g, "/");
  // `npx -y @yawlabs/mcp` stages packages under ~/.npm/_npx/<hex>/
  // node_modules/@yawlabs/mcp/ (or platform equivalent; on Windows the
  // cache is under npm-cache/_npx/...). Require the full npm-cache
  // context — `_npx/<hex>/node_modules/@yawlabs/mcp/` — rather than a
  // bare `_npx` segment: a user project path that merely CONTAINS a
  // `_npx` directory would otherwise be misclassified as an npx run.
  // Consistent with the global markers below, which all anchor on the
  // `@yawlabs/mcp` segment.
  if (/\/_npx\/[0-9a-f]+\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "npx";
  // The copy Yaw Terminal ships inside its Electron resources
  // (resources/app.asar.unpacked/node_modules/@yawlabs/mcp). It LOOKS
  // like local-node-modules, but running `npm install` against the
  // app's resources dir would corrupt the install — this copy only
  // updates when the app itself updates. Must be checked BEFORE the
  // generic node_modules marker below.
  if (/\/app\.asar\.unpacked\//.test(normalized)) return "bundled-app";
  // npm i -g writes to the global prefix. Can be detected by
  // "npm/node_modules/@yawlabs/mcp" or "/usr/local/lib/node_modules"
  // style paths, or the npm global prefix (varies). Most dependable
  // signal: the path lives under a `node_modules` that is NOT inside
  // the current project's node_modules. Since we can't reliably tell
  // global vs local from argv alone, use the npm prefix marker on
  // common platforms and a `\\npm\\node_modules\\` Windows marker.
  if (/\/npm\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "global-npm";
  // `<prefix>/lib/node_modules` — anchored on real Node-root shapes; see the
  // two regex definitions above for why a bare `/lib/` marker was unsafe.
  if (POSIX_GLOBAL_LIB_PREFIX.test(normalized)) return "global-npm";
  if (MANAGED_NODE_LIB_PREFIX.test(normalized)) return "global-npm";
  if (/\/AppData\/Roaming\/npm\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "global-npm";
  // Windows npm prefixes that live in a `bin` dir (scoop's nodejs persist
  // dir, custom prefixes): globals land at <prefix>/node_modules with
  // <prefix> itself named `bin`. A project tree whose root dir is
  // literally named `bin` is rare enough that this marker is safe, and
  // misclassifying these as local-node-modules made `upgrade --run`
  // npm-install into the node prefix instead of upgrading the global.
  if (/\/bin\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "global-npm";
  // pnpm / bun global stores look like local node_modules trees but are
  // internally managed -- running plain `npm install` inside them writes
  // a foreign package-lock + node_modules into the tool's store. Detect
  // them BEFORE the generic node_modules marker and upgrade with the
  // owning tool instead. pnpm: <pnpm-home>/global/<n>/node_modules/...
  // (~/.local/share/pnpm, ~/AppData/Local/pnpm, ~/Library/pnpm); bun:
  // ~/.bun/install/global/node_modules/...
  if (/\/pnpm\/global\/\d+\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "pnpm-global";
  if (/\/\.bun\/install\/global\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "bun-global";
  if (/\/node_modules\/@yawlabs\/mcp\//.test(normalized)) return "local-node-modules";
  // `npm run dev` or direct `node ./dist/index.js` from a checkout --
  // not installed at all. `mcp` is the canonical clone dir (`git clone
  // git@github.com:YawLabs/mcp.git` lands in mcp/); yaw-mcp and mcph are
  // older on-disk names (repo renamed from /mcph 2026-05-25). Safe to
  // match the generic `mcp` here: every node_modules-shaped install was
  // classified above, so a path reaching this test is not inside any
  // package tree -- without it, the repo's own working tree classified as
  // "unknown" and was told to `npm install -g` a second global copy.
  if (/\/(yaw-mcp|mcph|mcp)\/(dist|src)\//.test(normalized)) return "dev-checkout";
  return "unknown";
}

/** For a local-node-modules install, the directory `npm install` must run
 *  in: the package-tree root, i.e. everything before the FIRST
 *  `/node_modules/` segment of the entrypoint path. Null when the path
 *  doesn't contain a node_modules segment. */
export function localInstallRoot(argvPath: string | undefined): string | null {
  if (!argvPath) return null;
  // Separator normalization preserves length, so an index found in the
  // normalized string addresses the same spot in the original — slicing
  // the original keeps Windows drive letters and backslashes intact.
  const idx = argvPath.replace(/\\/g, "/").indexOf("/node_modules/");
  return idx > 0 ? argvPath.slice(0, idx) : null;
}

/** The `@yawlabs/mcp` package directory the RUNNING copy was loaded from --
 *  the LAST `node_modules/@yawlabs/mcp` segment of argv[1] -- or null when no
 *  such segment exists even after resolving a bin shim. The post-`--run`
 *  check reads this directory's package.json to tell whether the copy the
 *  client spawns actually moved.
 *
 *  LAST segment, where localInstallRoot takes the FIRST: that one names the
 *  tree npm must run in, this one names the copy that is running, and for a
 *  nested install (`/proj/node_modules/foo/node_modules/@yawlabs/mcp`) the two
 *  legitimately differ -- which is exactly the mismatch the check reports.
 *
 *  The LITERAL path is tried first and the realpath only as a fallback, on
 *  purpose: pnpm's global entry is a symlink into a versioned store dir, and
 *  `pnpm add -g` repoints the link rather than rewriting the old target, so
 *  the resolved path would keep reporting the pre-upgrade version forever
 *  while the link already serves the new one. npm's bin shim is the other way
 *  round -- the literal path carries no node_modules segment at all -- which
 *  is what the fallback is for. `realpath` is injectable for the same reason
 *  detectInstallMethod's is: unit-test paths exist on no filesystem. */
export function runningPackageDir(
  argvPath: string | undefined,
  realpath: (p: string) => string = realpathSync,
): string | null {
  if (!argvPath) return null;
  const literal = packageDirOf(argvPath);
  if (literal !== null) return literal;
  try {
    return packageDirOf(realpath(argvPath));
  } catch {
    return null;
  }
}

function packageDirOf(p: string): string | null {
  const marker = "/node_modules/@yawlabs/mcp/";
  // Separator normalization preserves length (same trick as localInstallRoot),
  // so the index found in the normalized string slices the ORIGINAL and keeps
  // drive letters and backslashes intact.
  const idx = p.replace(/\\/g, "/").lastIndexOf(marker);
  return idx === -1 ? null : p.slice(0, idx + marker.length - 1);
}

/** Version field of `<pkgDir>/package.json`, or null when it cannot be read or
 *  carries no string version. Auto-skips under vitest (mirrors
 *  npmGlobalPrefix): the fixtures' argv paths are fictional, and a real
 *  install that happened to sit at one of them would make the check's outcome
 *  depend on the machine. Tests inject opts.installedVersion. */
function defaultInstalledVersion(pkgDir: string): string | null {
  if (process.env.VITEST) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Ask npm where its global prefix actually is. Returns null when npm
 *  isn't reachable, exits non-zero, or doesn't answer within 3s — refinement
 *  is then skipped and the path-marker classification stands.
 *
 *  Exported because auto-upgrade's multi-prefix warning needs the same probe:
 *  it used to keep its own copy with no timer, no kill, no exit-code check and
 *  no VITEST guard, so a hung `npm prefix -g` left an unresolved promise and a
 *  live child handle for the broker's lifetime. One helper, one timeout, one
 *  test short-circuit. */
/** Minimal shape of the child npmGlobalPrefix's timeout has to tear down. */
interface KillableChild {
  pid?: number;
  kill: () => boolean;
}

/** Spawn shape used only for the taskkill escape hatch below. */
type TreeKillSpawn = (
  cmd: string,
  args: string[],
  opts: { stdio: "ignore" },
) => { on(event: string, listener: (...args: any[]) => void): unknown };

/** Kill a probe child and, on win32, everything it spawned.
 *
 *  The probe spawns with `shell: true` on win32 because npm is npm.cmd and
 *  Node refuses to spawn a .cmd without a shell. A bare `child.kill()` then
 *  signals only the cmd.exe WRAPPER -- the npm -> node grandchild doing the
 *  actual work survives it and can outlive the CLI process that started the
 *  probe. `taskkill /T` walks the tree from the wrapper's pid instead.
 *
 *  Best-effort by design: taskkill is fired and forgotten (an error there is
 *  not actionable from here, and swallowing it is why the `on("error")` sink
 *  exists -- an unhandled 'error' event would take the process down), and
 *  child.kill() still runs afterwards so the probe's close/error handler
 *  resolves either way.
 *
 *  Exported for tests: npmGlobalPrefix short-circuits under VITEST, so this is
 *  the only reachable surface for the timeout path. */
export function killProcessTree(
  child: KillableChild,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: TreeKillSpawn = spawn as unknown as TreeKillSpawn,
): void {
  if (platform === "win32" && child.pid !== undefined) {
    try {
      // /T walks the process tree, /F forces termination of each node.
      spawnImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
    } catch {
      // taskkill missing or unspawnable -- fall through to the plain kill.
    }
  }
  child.kill();
}

/** The subset of child_process.spawn the prefix probe uses. Injectable so a
 *  test can reach the spawn OPTIONS -- the env strip below -- which the VITEST
 *  short-circuit otherwise keeps unreachable. */
export type ProbeSpawn = (
  cmd: string,
  args: string[],
  opts: { shell: boolean; stdio: ["ignore", "pipe", "ignore"]; env: NodeJS.ProcessEnv },
) => KillableChild & {
  stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

export async function npmGlobalPrefix(spawnImpl?: ProbeSpawn): Promise<string | null> {
  // Auto-skip under vitest (mirrors doctor-cmd's registry probe) so unit
  // tests never spawn a real npm; tests exercising refinement inject
  // their own probe via opts.npmPrefix, and a test of THIS function's spawn
  // injects the spawn itself.
  if (process.env.VITEST && !spawnImpl) return null;
  const spawnFn = spawnImpl ?? (spawn as unknown as ProbeSpawn);
  return new Promise((resolve) => {
    const child = spawnFn("npm", ["prefix", "-g"], {
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "ignore"],
      // Even a read-only `npm prefix -g` is an npm invocation: yaw-mcp's own
      // secrets do not ride into it. See internal-secret-env.ts.
      env: stripInternalSecretsFromEnv(process.env),
    });
    let out = "";
    const timer = setTimeout(() => {
      // Tree kill, not child.kill(): see killProcessTree -- the shell:true
      // spawn means the pid we hold is cmd.exe, not npm.
      killProcessTree(child);
      resolve(null);
    }, 3000);
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.trim() ? out.trim() : null);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** Resolve symlinks/junctions and normalize a path for comparison.
 *  realpath matters on Windows tool managers (scoop's `current` is a
 *  junction into a versioned dir) where the literal argv path and the
 *  npm prefix point at the same files through different names.
 *
 *  Exported because auto-upgrade's multi-prefix warning compares the SAME two
 *  values (running-install prefix vs `npm prefix -g`) and kept its own
 *  trim+lowercase comparator, which sees a junction and its target as two
 *  different prefixes -- so every stale startup under scoop's `current`
 *  junction printed a "your prefixes differ" warning about a setup the user
 *  does not have. One comparator, one answer. */
export function comparablePath(p: string): string {
  let real = p;
  try {
    real = realpathSync(p);
  } catch {
    // Nonexistent or unreadable -- compare the literal path instead.
  }
  const normalized = real.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Second-chance classification for the methods the path markers can't
 *  distinguish: when an install looks like `local-node-modules` (or
 *  `unknown`), ask npm for its real global prefix and reclassify as
 *  `global-npm` when the entrypoint lives inside it. Catches exotic
 *  prefixes the markers don't know (custom NPM_CONFIG_PREFIX, new tool
 *  managers) without spawning npm on the unambiguous fast paths. */
export async function refineInstallMethod(
  method: InstallMethod,
  argvPath: string | undefined,
  npmPrefix: () => Promise<string | null> = npmGlobalPrefix,
): Promise<InstallMethod> {
  if (method !== "local-node-modules" && method !== "unknown") return method;
  if (!argvPath) return method;
  const prefix = await npmPrefix();
  if (!prefix) return method;
  const entry = comparablePath(argvPath);
  const pfx = comparablePath(prefix);
  // Windows global layout: <prefix>/node_modules; POSIX: <prefix>/lib/node_modules.
  if (entry.startsWith(`${pfx}/node_modules/`) || entry.startsWith(`${pfx}/lib/node_modules/`)) {
    return "global-npm";
  }
  return method;
}

/** The package spec every whitelisted upgrade installs -- `@latest`, never a
 *  pinned version, so a stale copy always moves to the newest publish. */
export const UPGRADE_PACKAGE_SPEC = "@yawlabs/mcp@latest";

/** The ONE whitelisted upgrade command per install method -- the only
 *  commands `upgrade --run` and the background self-upgrade ever spawn, and
 *  the text every printed suggestion, --json snapshot and log hint derives
 *  from. Null means nothing is spawnable for that method: npx and bundled-app
 *  have nothing to run, and binary / dev-checkout / unknown are manual
 *  (buildUpgradePlan still prints advice for those; runUpgrade refuses --run).
 *
 *  This used to be spelled in four places -- buildUpgradePlan's switch,
 *  runUpgrade's runSpec, auto-upgrade's globalSpec and its corrective-command
 *  hint -- so a change to the package spec or a new tool had to land in all
 *  four or they drifted. Every arg list ends in UPGRADE_PACKAGE_SPEC;
 *  upgradeSpawnSpec relies on that to place `--prefix`. */
export const UPGRADE_COMMANDS: Readonly<
  Record<InstallMethod, Readonly<{ cmd: string; args: readonly string[] }> | null>
> = {
  "global-npm": { cmd: "npm", args: ["install", "-g", UPGRADE_PACKAGE_SPEC] },
  "pnpm-global": { cmd: "pnpm", args: ["add", "-g", UPGRADE_PACKAGE_SPEC] },
  "bun-global": { cmd: "bun", args: ["add", "-g", UPGRADE_PACKAGE_SPEC] },
  "local-node-modules": { cmd: "npm", args: ["install", UPGRADE_PACKAGE_SPEC] },
  npx: null,
  "bundled-app": null,
  "dev-checkout": null,
  binary: null,
  unknown: null,
};

/** The global-install methods -- the ones the background self-upgrade may act
 *  on with the owning tool; everything else it only logs about. */
export const GLOBAL_UPGRADE_METHODS: readonly InstallMethod[] = ["global-npm", "pnpm-global", "bun-global"];

/** The spawn argv for `method`, or null when nothing is spawnable. For
 *  global-npm a non-null `prefixArg` inserts `--prefix <prefixArg>` ahead of
 *  the package spec; the CALLER decides whether that value is the raw path
 *  (POSIX, no shell) or the shell-quoted form (win32, shell:true) -- see
 *  quoteShellArgIfNeeded in auto-upgrade.ts. Ignored for every other method:
 *  `pnpm add -g --prefix` is not a real flag. A fresh array every call, so a
 *  caller may push onto it without editing the table. */
export function upgradeSpawnSpec(
  method: InstallMethod,
  prefixArg: string | null = null,
): { cmd: string; args: string[] } | null {
  const base = UPGRADE_COMMANDS[method];
  if (base === null) return null;
  const args = [...base.args];
  if (method === "global-npm" && prefixArg !== null) args.splice(args.length - 1, 0, "--prefix", prefixArg);
  return { cmd: base.cmd, args };
}

/** The printed / pasteable form of the whitelisted command for `method` (no
 *  `--prefix` -- that is the caller's display-quoting decision), or null when
 *  there is nothing to spawn. */
export function upgradeCommandLine(method: InstallMethod): string | null {
  const spec = upgradeSpawnSpec(method);
  return spec === null ? null : [spec.cmd, ...spec.args].join(" ");
}

/** What `upgrade` / `doctor` say to a user running the retired standalone
 *  binary: its upgrade path is install from npm, delete the old executable.
 *  Single source of truth for that message so upgrade / auto-upgrade / doctor
 *  all say the same thing, and the command it quotes is the table's own
 *  global-npm line rather than a hand-typed copy of the package spec. */
export const BINARY_RETIRED_HINT = `the standalone-binary track was retired in 0.70.3. Install from npm instead -- \`${upgradeCommandLine("global-npm")}\` -- then delete this executable.`;

/** The manual command for the GLOBAL install that `tool` (npm / pnpm / bun)
 *  owns, or null for a tool the table does not know. auto-upgrade's failure
 *  hint: its spawn callback is handed the tool, not the method. Global only,
 *  so npm resolves to the `-g` line and never to local-node-modules'. */
export function globalUpgradeCommandLineForTool(tool: string): string | null {
  const method = GLOBAL_UPGRADE_METHODS.find((m) => UPGRADE_COMMANDS[m]?.cmd === tool);
  return method === undefined ? null : upgradeCommandLine(method);
}

/** Assemble the upgrade plan from method + version info. Single source
 *  of truth for both the prose and --json paths. */
export function buildUpgradePlan(input: {
  current: string;
  latest: string | null;
  method: InstallMethod;
}): UpgradePlan {
  const { current, latest, method } = input;
  // oam-spawn's compareVersions is THE semver comparator for the package (it
  // implements real prerelease precedence, so 0.45.0-rc.1 ranks below 0.45.0).
  // It is anchored and does not accept a leading "v", so strip one first --
  // the same normalization doctor-cmd's compareSemver does, and for the same
  // reason: a git-tag-shaped "v0.45.0" would otherwise fail to parse, compare
  // equal, and silently report a stale install as current.
  const stripV = (s: string): string => (s.startsWith("v") ? s.slice(1) : s);
  const stale = latest !== null && current !== "dev" && compareVersions(stripV(current), stripV(latest)) < 0;

  // The spawnable methods print exactly the line --run would execute (from
  // UPGRADE_COMMANDS); the rest are the advice-only cases.
  let command: string | null;
  switch (method) {
    case "npx":
      command = null; // npx -y refreshes on its own; nothing to run.
      break;
    case "bundled-app":
      command = null; // ships inside Yaw Terminal; updates with the app.
      break;
    case "binary":
      command = null; // standalone binary -- replace the executable manually.
      break;
    case "dev-checkout":
      command = "git pull && npm run build";
      break;
    case "unknown":
      // Best guess for an unrecognized path: the global install line, as
      // copy-paste advice only (runUpgrade refuses --run for `unknown`).
      command = upgradeCommandLine("global-npm");
      break;
    default:
      command = upgradeCommandLine(method);
      break;
  }
  return { current, latest, stale, method, command };
}

/** Abort budget for the registry probe when a caller names none. Three seconds
 *  is `upgrade`'s own number: reaching the registry IS that command's job, so it
 *  has nothing to print until this answers and can afford to wait. */
export const REGISTRY_FETCH_TIMEOUT_MS = 3000;

export interface FetchLatestVersionOptions {
  /** Abort budget in ms. Defaults to REGISTRY_FETCH_TIMEOUT_MS.
   *
   *  Per-caller on purpose, and not a tuning detail: `doctor` deliberately runs
   *  a SHORTER budget than `upgrade` (see DOCTOR_REGISTRY_TIMEOUT_MS in
   *  doctor-cmd.ts). A diagnostic that hangs behind a black-holed registry is a
   *  worse failure than one that prints the freshness check as unknown and moves
   *  on to the twenty other things it checks; `upgrade` has no report at all
   *  until this resolves. Forcing both onto one number is what made the second
   *  copy of this function look justified. */
  timeoutMs?: number;
  /** Stand-in for the request itself -- doctor's `registryFetch` hook and the
   *  unit tests behind it. Short-circuits the fetch entirely, and a throw is
   *  absorbed to null so an injected probe can fail its caller no harder than
   *  the real one can. */
  override?: () => Promise<string | null>;
}

/** Ask the registry for the newest published version, or null on any failure
 *  (non-2xx, malformed body, offline, or a stall past `timeoutMs` via the
 *  AbortController).
 *
 *  THE registry probe for the package: `upgrade`, auto-upgrade at serve startup,
 *  and `doctor` all land here. It previously existed three times over and the
 *  copies had already drifted on the two axes that actually differ between
 *  callers -- the timeout budget and whether a stand-in can be injected. Both
 *  are parameters now, so a caller with a real difference in requirement gets it
 *  without forking the URL, the response validation, or the failure semantics
 *  along with it. */
export async function fetchLatestVersion(opts: FetchLatestVersionOptions = {}): Promise<string | null> {
  if (opts.override) {
    try {
      return await opts.override();
    } catch {
      return null;
    }
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? REGISTRY_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("https://registry.npmjs.org/@yawlabs/mcp/latest", {
      signal: ac.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** probeOam's below-floor branch emits a broker-flavoured JSON warn on stderr
 *  ("oam is installed but below the minimum supported version..."). That is the
 *  right and only report under `serve`, where nothing else is printing — but in
 *  `upgrade` the prose note below already says the same thing in the shape a
 *  human reads, so the warn is a second, uglier copy of one advisory landing on
 *  the same terminal. Raise the logger threshold for the duration of the probe
 *  and no longer: logger.ts resolves LOG_LEVEL per call rather than latching it
 *  at import, so this is a scoped mute, and the restore runs in a `finally` so a
 *  throwing probe cannot leave the process silent. */
async function probeOamQuietly(): Promise<OamProbe> {
  const prev = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "error";
  try {
    return await probeOam();
  } finally {
    if (prev === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prev;
  }
}

/** Advisory lines for the case where the oam runtime is installed but BELOW the
 *  floor yaw-mcp hosts sidecars on. Empty when oam is absent (node is the
 *  baseline, nothing to say), current, or unprobeable.
 *
 *  Why `upgrade` of all commands: MIN_OAM_VERSION tracks the LATEST oam release
 *  and moves with every one, so the very act of upgrading yaw-mcp can raise the
 *  floor past the user's oam and silently drop every sidecar from oam to
 *  node/npx. That state is otherwise surfaced only as one warn line on the
 *  broker's stderr (which MCP clients hide) and in `yaw-mcp doctor` — while
 *  `upgrade`, the command a user runs precisely to "get current", printed
 *  "nothing to do".
 *
 *  The try/catch makes the note strictly advisory — a probe that throws must
 *  never fail `upgrade`. */
async function oamFloorLines(probe?: UpgradeCommandOptions["oamProbe"]): Promise<string[]> {
  // Auto-skip under vitest when no probe was injected (mirrors npmGlobalPrefix):
  // an un-injected unit test must never spawn a real `oam --version`, whose
  // answer varies per machine.
  if (!probe && process.env.VITEST) return [];
  try {
    const oam = probe ? await probe() : await probeOamQuietly();
    if (!oam.belowMin) return [];
    return [
      "",
      `oam:     v${oam.version ?? "unknown"} is installed but below the v${MIN_OAM_VERSION} floor yaw-mcp`,
      "         requires, so MCP sidecars run on node instead of oam. Update it:",
      "",
      "  oam self-update",
    ];
  } catch {
    return [];
  }
}

/** Resolve the global prefix the RUNNING install lives under (argv[1] walked
 *  up to its node_modules parent) so a global-npm upgrade can pass `--prefix`.
 *  Delegates to auto-upgrade's detectRunningInstallPrefix via dynamic import:
 *  auto-upgrade.ts statically imports this module, so a static back-import
 *  would create a cycle. (oam-spawn, by contrast, imports nothing from here,
 *  which is why THAT one is a plain static import at the top of the file.)
 *  Auto-skips under vitest (mirrors npmGlobalPrefix): the
 *  walk realpaths argv[1], so on a machine that really has a global install
 *  an un-injected unit test's spawn args would flip from bare `-g` to
 *  `--prefix` depending on the machine. Tests exercising the prefix path
 *  inject opts.runningPrefix. */
async function defaultRunningPrefix(argvPath: string | undefined): Promise<string | null> {
  if (process.env.VITEST) return null;
  const { detectRunningInstallPrefix } = await import("./auto-upgrade.js");
  return detectRunningInstallPrefix(argvPath);
}

async function defaultSpawn(cmd: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      cwd,
      // yaw-mcp's own secrets stay out of the install: npm runs every
      // dependency's pre/postinstall with this env, and a passphrase parked
      // in yaw-mcp's env block (where README says to put it) must not reach
      // them. See internal-secret-env.ts.
      env: stripInternalSecretsFromEnv(process.env),
    });
    child.on("close", (code) => resolve(typeof code === "number" ? code : 1));
    child.on("error", () => resolve(1));
  });
}

/** True when this process is a Single Executable Application (Node SEA)
 *  blob -- i.e. yaw-mcp was compiled into a standalone binary. Two cheap
 *  gates first so ordinary `node script.js` runs skip the node:sea import
 *  entirely (a micro-optimization, not a correctness guard -- node:sea does
 *  not warn on Node >= 21): a SEA's execPath is the app binary, never `node`,
 *  and Electron-as-node is never a SEA. node:sea exists only on Node >= 20.12
 *  and isSea() is true only inside a SEA, so a missing module or a thrown call
 *  both mean "not a binary". */
export async function detectSea(): Promise<boolean> {
  if (process.env.ELECTRON_RUN_AS_NODE) return false;
  const exe = process.execPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (exe === "node" || exe === "node.exe") return false;
  try {
    const sea = (await import("node:sea")) as { isSea?: () => boolean };
    return typeof sea.isSea === "function" && sea.isSea() === true;
  } catch {
    return false;
  }
}

export async function runUpgrade(opts: UpgradeCommandOptions = {}): Promise<UpgradeCommandResult> {
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  const lines: string[] = [];
  const print = (s = ""): void => {
    lines.push(s);
    write(`${s}\n`);
  };
  const printErr = (s: string): void => {
    lines.push(s);
    writeErr(`${s}\n`);
  };

  const fetcher = opts.fetchLatest ?? fetchLatestVersion;
  const current = opts.currentVersion ?? readCurrentVersion();
  const argvPath = opts.argvPath ?? process.argv[1];
  // A standalone SEA binary has no package manager and no script path in
  // argv[1] (it'd be the first user arg), so path-based detection would
  // mislabel it `unknown` and suggest a bogus `npm install -g`. Detect the
  // SEA blob first and short-circuit to the binary method.
  const sea = opts.isSea ? opts.isSea() : await detectSea();
  const method = sea ? "binary" : await refineInstallMethod(detectInstallMethod(argvPath), argvPath, opts.npmPrefix);

  let latest: string | null;
  try {
    latest = await fetcher();
  } catch {
    latest = null;
  }

  const plan = buildUpgradePlan({ current, latest, method });

  // For global-npm, pin the install to the prefix the RUNNING copy lives
  // under -- the same `--prefix` auto-upgrade passes (maybeAutoUpgrade in
  // auto-upgrade.ts). A bare `npm install -g` writes into whatever
  // `npm prefix -g` resolves, which can be a DIFFERENT tree than the one the
  // client spawned us from (multiple Node versions, custom NPM_CONFIG_PREFIX,
  // Yaw Terminal's bundled Node); the child then exits 0, we print
  // "OK: Upgraded", and the running copy stays stale.
  //
  // Computed BEFORE the --json and offline returns on purpose: the walk is
  // filesystem-only (a realpath of argv[1]), so offline can afford it, and
  // both paths hand out a command the user will run later -- a bare `-g`
  // there would re-open the exact wrong-tree hazard `--prefix` closes.
  //
  // Two quotings of one value, and they must drop together:
  //   - globalPrefixArg is the SPAWN argv form. defaultSpawn runs shell:true
  //     on win32, where argv is joined unquoted, so the arg carries its own
  //     quotes there; POSIX spawns without a shell and needs the raw path.
  //     An unquotable prefix drops `--prefix` entirely (npm's own resolution
  //     is the worse-but-safe fallback -- same policy as auto-upgrade).
  //   - suggestedCommand is the PRINTED, paste-safe form: on POSIX a prefix
  //     with a space must be single-quoted for the user's shell even though
  //     the spawn argv stays raw (see quoteArgForDisplay in auto-upgrade.ts).
  let globalPrefixArg: string | null = null;
  let suggestedCommand = plan.command;
  if (method === "global-npm") {
    const rawPrefix = await (opts.runningPrefix ?? defaultRunningPrefix)(argvPath);
    if (rawPrefix !== null) {
      const { quoteArgForDisplay, quoteShellArgIfNeeded } = await import("./auto-upgrade.js");
      // opts.platform threads through to BOTH quoters: only win32 can refuse a
      // prefix, so a POSIX test runner has no other way to reach the
      // drop-the-prefix branch below.
      const spawnForm = quoteShellArgIfNeeded(rawPrefix, opts.platform);
      const displayForm = quoteArgForDisplay(rawPrefix, opts.platform);
      // The two fail together today (win32 shares one implementation; POSIX
      // display quoting is total) -- requiring both keeps the spawned argv
      // and every printed suggestion from ever disagreeing.
      if (spawnForm !== null && displayForm !== null) {
        globalPrefixArg = spawnForm;
        // Derived from the same table the spawn argv comes from, so the
        // printed suggestion and the --json `command` cannot say a different
        // package spec than `--run` spawns (this was the one hand-spelled
        // copy left after UPGRADE_COMMANDS became the single source).
        const spec = upgradeSpawnSpec("global-npm", displayForm);
        suggestedCommand = spec === null ? null : [spec.cmd, ...spec.args].join(" ");
      }
    }
  }

  // The directory a local-node-modules command has to run IN. Computed here,
  // above the --json and offline returns, for the same reason globalPrefixArg
  // is: the walk is a pure string operation on argv[1], and every one of those
  // paths hands the user a command to run LATER. A cwd-less
  // `npm install @yawlabs/mcp@latest` run from the wrong directory does not
  // upgrade the tree -- it writes a stray package.json + node_modules wherever
  // it landed and leaves the stale copy in place.
  const installRoot = method === "local-node-modules" ? localInstallRoot(argvPath) : null;

  if (opts.json) {
    // The snapshot's command is the paste-safe prefixed form: scripts and
    // humans both act on it, and a bare `-g` would promise a different
    // install than `--run` performs (see the pinning note above). `cwd` is the
    // other half of that promise for local installs -- a script that runs
    // `command` from its own working directory needs to be told it must chdir.
    print(JSON.stringify({ ...plan, command: suggestedCommand, cwd: installRoot }, null, 2));
    // --json is a REPORT-ONLY snapshot: it never spawns, even with --run. The
    // exit code therefore keys on staleness alone. It used to key on
    // `plan.stale && !opts.run`, which made `--json --run` on a stale install
    // exit 0 having installed nothing -- so a script that added --json purely
    // to parse the output lost BOTH the upgrade and the non-zero signal that
    // one was needed. Stale is stale regardless of --run.
    return { exitCode: plan.stale ? 1 : 0, lines };
  }

  // Offline or registry unreachable — still useful to print the method +
  // suggested command so the user can run it when they're back online.
  if (latest === null) {
    print("yaw-mcp upgrade: couldn't reach the npm registry (offline? firewall?).");
    if (suggestedCommand) {
      print("When you're back online, run:");
      print("");
      // Same `in <root>:` header the online exit-1 path prints: the command is
      // the one the user will paste later, and for a local install it is only
      // correct from the tree root.
      if (installRoot) {
        print(`in ${installRoot}:`);
      }
      print(`  ${suggestedCommand}`);
    } else if (method === "bundled-app") {
      print("This copy of yaw-mcp ships inside Yaw Terminal and updates with the app -- nothing to run.");
    } else if (method === "binary") {
      print(`yaw-mcp is a standalone binary; ${BINARY_RETIRED_HINT}`);
    } else {
      print("Your install uses `npx -y` -- just restart the MCP client when you're back online.");
    }
    // The oam floor probe is LOCAL (`oam --version`); an unreachable npm
    // registry says nothing about it. Skipping the note here used to hide the
    // below-floor state from precisely the user who cannot fix the other half
    // right now -- and their sidecars are already falling back to node.
    for (const line of await oamFloorLines(opts.oamProbe)) print(line);
    return { exitCode: 0, lines };
  }

  print(`Current: ${current}`);
  print(`Latest:  ${latest}`);
  print(`Install: ${method}`);
  // Printed for both the stale and up-to-date paths: "nothing to do" about
  // yaw-mcp itself is exactly when a below-floor oam would otherwise go unsaid.
  for (const line of await oamFloorLines(opts.oamProbe)) print(line);

  if (!plan.stale) {
    print("");
    print("OK: You're on the latest version -- nothing to do.");
    return { exitCode: 0, lines };
  }

  print("");
  // ASCII punctuation in every printed line: these go straight to the user's
  // terminal, where a Unicode dash renders as mojibake under a Windows console
  // codepage and then travels, mangled, into bug reports.
  if (method === "npx") {
    print("Your install uses `npx -y` -- restart the MCP client and it will fetch the new version.");
    return { exitCode: 0, lines };
  }

  if (method === "bundled-app") {
    print("This copy of yaw-mcp ships inside Yaw Terminal and updates with the app --");
    print("there is nothing to run here. Update Yaw Terminal to get the new version.");
    return { exitCode: 0, lines };
  }

  if (method === "binary") {
    // One stream per exit code, matching the dev-checkout / unknown refusal
    // below: a --run that REFUSES (exit 2) reports on stderr, while the
    // informational exit-1 listing stays on stdout. These are the same
    // documented exit-2 class, and a script redirecting one stream to catch the
    // refusal must not have to know which non-runnable method it happened to
    // hit.
    const emit = opts.run ? printErr : print;
    emit("yaw-mcp is running as a standalone binary -- manual upgrade required.");
    emit(`There's no package manager to upgrade it, and \`--run\` can't automate this: ${BINARY_RETIRED_HINT}`);
    // 1→2 scripting trap (see the "SCRIPTING TRAP" note in the file header):
    // plain `upgrade` returns 1, but `--run` returns 2 because a binary can
    // never be auto-run. The message above states "manual upgrade required"
    // so scripts don't blindly retry with --run. The exit-code contract is
    // intentionally unchanged.
    return { exitCode: opts.run ? 2 : 1, lines };
  }

  // Auto-runnable methods spawn the OWNING tool with whitelisted args for
  // exactly our package: npm for global/local npm trees, pnpm/bun for
  // their global stores. dev-checkout stays manual — the user owns that
  // tree and the right command depends on their setup. unknown stays
  // manual because we don't know which install we'd be mutating.
  // One whitelist for every spawn surface: UPGRADE_COMMANDS. The `--prefix`
  // arg rides in only for global-npm, and only when it survived quoting.
  const spec = upgradeSpawnSpec(method, globalPrefixArg);
  // The `installRoot !== null` guard is defensive-dead, kept only so a future
  // localInstallRoot change cannot produce `cwd: undefined` and silently
  // install into the process cwd: localInstallRoot returns null exactly when
  // `/node_modules/` sits at index 0, i.e. a node_modules directory at the
  // filesystem root, which no real classification produces
  // (detectInstallMethod only labels a path local-node-modules when there is a
  // tree above it).
  const runSpec: { cmd: string; args: string[]; cwd?: string } | null =
    spec === null
      ? null
      : method === "local-node-modules"
        ? installRoot !== null
          ? { ...spec, cwd: installRoot }
          : null
        : spec;
  // Print the line we actually spawn, in its paste-safe display form: once
  // `--prefix` is in the argv, a bare `npm install -g` would promise a
  // different install than --run performs -- and "run it yourself" must
  // suggest the same command, or the manual path keeps the silent wrong-tree
  // hazard --prefix exists to close. For global-npm that is suggestedCommand
  // (the spawn argv with the prefix display-quoted, so a POSIX path with a
  // space pastes as one token); for every other runSpec the argv join IS
  // plan.command, no arg of which ever needs quoting.
  const commandLine =
    method === "global-npm" ? suggestedCommand : runSpec ? [runSpec.cmd, ...runSpec.args].join(" ") : plan.command;

  if (!opts.run) {
    if (runSpec) {
      print("Run `yaw-mcp upgrade --run` to upgrade in place, or run it yourself:");
    } else {
      // Non-runnable method (dev-checkout / unknown): manual upgrade required.
      // 1→2 scripting trap — see the file-header "SCRIPTING TRAP" note: this
      // returns 1 here, but `--run` returns 2 below, never 0. Don't promise
      // --run will fix it.
      print("Manual upgrade required (--run can't safely automate this install method). Run it yourself:");
    }
    print("");
    if (installRoot) {
      print(`in ${installRoot}:`);
    }
    print(`  ${commandLine}`);
    return { exitCode: 1, lines };
  }

  // --run: attempt the upgrade. Only whitelisted commands — never
  // pass arbitrary user input into a shell.
  if (!runSpec) {
    // Non-runnable method reached via --run: manual upgrade required. This is
    // the exit-2 half of the documented 1→2 scripting trap (file-header note).
    printErr(
      `yaw-mcp upgrade --run: a "${method}" install can't be upgraded automatically (manual upgrade required). Run it yourself:`,
    );
    printErr("");
    printErr(`  ${commandLine}`);
    return { exitCode: 2, lines };
  }

  const runner = opts.spawnImpl ?? defaultSpawn;
  if (runSpec.cwd) {
    print(`Running in ${runSpec.cwd}:`);
  } else {
    print("Running:");
  }
  print(`  ${commandLine}`);
  print("");
  const code = await runner(runSpec.cmd, runSpec.args, runSpec.cwd);
  if (code === 0) {
    print("");
    print(`OK: Upgraded @yawlabs/mcp to ${latest}`);
    // The child succeeded, but did the RUNNING copy move? Re-read the version
    // of the package directory argv[1] was loaded from. A copy still on the
    // old version means the install landed in another tree -- a global prefix
    // `--prefix` could not pin, or a copy nested under another package's
    // node_modules, where localInstallRoot's first-segment rule installs a new
    // top-level dependency and leaves the nested copy alone -- and "OK:
    // Upgraded" on its own would have been the silent wrong-tree upgrade the
    // prefix machinery exists to prevent. Advisory: stderr, exit code
    // unchanged (see the header). Unreadable means unverifiable, and
    // unverifiable stays quiet rather than crying wolf.
    const pkgDir = runningPackageDir(argvPath);
    const running = pkgDir === null ? null : await (opts.installedVersion ?? defaultInstalledVersion)(pkgDir);
    // OLDER than the fetched latest, not merely different: `latest` was
    // fetched before the child ran and `@latest` resolves the dist-tag at
    // install time, so a copy that comes back NEWER than the pre-install fetch
    // landed exactly where it should and is not the wrong-tree case.
    const bare = (s: string): string => (s.startsWith("v") ? s.slice(1) : s);
    if (running !== null && compareVersions(bare(running), bare(latest)) < 0) {
      printErr("");
      printErr(`WARNING: the copy this command ran from still reports ${running}, not ${latest}:`);
      printErr(`  ${pkgDir}`);
      printErr(
        "The install landed in a different tree, so your MCP client keeps spawning the old version until that tree is upgraded too (for a copy nested under another package's node_modules, upgrade the package that pins it).",
      );
    }
    return { exitCode: 0, lines };
  }
  printErr(`yaw-mcp upgrade: ${runSpec.cmd} exited ${code}. Try running the command yourself:`);
  printErr("");
  // The child ran with cwd=installRoot; a retry the user types by hand has to
  // start from the same directory or it installs into whatever they were in.
  if (installRoot) {
    printErr(`in ${installRoot}:`);
  }
  printErr(`  ${commandLine}`);
  return { exitCode: 3, lines };
}

/** Read the version tsup inlines at build time; falls back to "dev"
 *  for unbuilt runs. tsup substitutes the bare `__VERSION__`
 *  identifier; a property access (e.g. `globalThis.__VERSION__`)
 *  isn't replaced, which left the shipped bundle reporting "dev". */
function readCurrentVersion(): string {
  return typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";
}
