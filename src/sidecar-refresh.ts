// Fire-and-forget sidecar refresh check, run once per yaw-mcp serve startup.
//
// Sibling of auto-upgrade.ts, and deliberately shaped like it: a ladder of
// cheap gates, a short registry probe, a best-effort lockfile, and a
// background install nobody awaits. Where auto-upgrade keeps yaw-mcp ITSELF
// current, this keeps the MCP servers in ~/.yaw-mcp/sidecars current.
//
// Why it has to exist. A server configured `npx -y pkg@latest` was current by
// construction -- npx re-resolved the dist-tag on every spawn. `yaw-mcp
// sidecars install` trades that for one known copy per package, and the
// version then pins itself (sidecars-cmd.ts's header says exactly that): oam
// has no fetch-on-demand, so once the managed tree is what gets spawned,
// nothing re-resolves `@latest` ever again. `sidecars install` is deliberately
// NOT automatic -- acquiring packages is network and minutes, and a first
// connect is the thing an MCP client blocks on -- so a user who ran it once
// stays on those versions until they remember to run it again. This module is
// "remember to run it again", moved off the connect path and onto a timer.
//
// WHAT IT WILL MOVE, and what it will never touch. Sidecars exist to PIN
// versions. So only a spec that asked to float is eligible: a configured range
// of `latest`, or no `@version` at all (which sidecarsManifest itself writes as
// `latest`). An explicit pin (`pkg@0.13.3`), a semver range (`pkg@^1.2.0`) and
// any other dist-tag (`pkg@next`) are all the user's stated intent and go in
// `skipped` untouched. Two independent reasons, and the second is the one that
// would have bitten us:
//   - Intent. A pin the user wrote is not ours to move.
//   - Staleness is only MEASURABLE against `latest`. A `@next` spec behind the
//     `latest` dist-tag would read as stale forever, because `npm update`
//     honours the manifest range and can never move it onto the `latest`
//     track. That is a 24-hourly npm spawn that changes nothing, permanently.
//     The same trap applies to `^1.2.0` once 2.0.0 ships.
//
// It also never DOWNGRADES: an installed version newer than `latest` (a local
// dev build, or a release that was yanked after we fetched it) is not stale.
// The comparison is semver via oam-spawn's compareVersions, never a string
// compare -- "0.9.0" > "0.10.0" lexicographically, which would silently skip
// exactly the upgrade the user most wants.
//
// A package that is CONFIGURED but not installed is not refreshed either. It
// is not stale, it was never acquired -- and acquiring it is the network-and-
// minutes cost `sidecars install` is opt-in about. Keeping what you installed
// moving forward is a different promise from fetching things you never asked
// this machine to fetch. (See KNOWN GAPS: the action cannot honour that
// distinction as precisely as the plan states it.)
//
// WHICH CONFIG IT ACTS ON: the USER-GLOBAL one, always. Both halves -- the plan
// (loadSidecarSpecs) and the action (backgroundInstallOptions) -- run with `cwd`
// forced to $HOME, which paths.ts's project walk stops just short of, so a
// project-local `<project>/.yaw-mcp/bundles.json` is never consulted here. This
// module runs from inside `serve`, whose cwd is whatever project the MCP client
// happened to launch in, while the managed tree is keyed on HOME alone and is
// shared by every project on the machine. Planning against one project's file
// and then rewriting the shared manifest from it would npm-prune every other
// project's servers out of that tree -- silently, because both output channels
// are ignored down here. `sidecars install` prints "shared by every project on
// this machine" when a human runs it from a project; a background task has
// nobody to tell. So a project-local sidecar set is refreshed ONLY by the manual
// `yaw-mcp sidecars install`, and a user whose only bundles.json is project-
// local gets no background refresh at all. That is the intended trade: no
// refresh is recoverable, a pruned shared tree is not.
//
// Never blocks serving: the registry probes run in parallel behind one short
// abort budget, the npm child's stdio is ignored, and the whole thing is
// fire-and-forget. A failure is a no-op -- worst case the sidecars stay on the
// version they were already on for another day.
//
// Concurrent runs are serialized, best-effort, by a lockfile in the sidecars
// root: sidecars-cmd's acquireSidecarsLock, which wraps auto-upgrade's
// acquireUpgradeLock rather than re-deriving it. N MCP clients starting at
// once -- several Claude Code panes -- would otherwise each fire an `npm
// install` at one tree. The manual `yaw-mcp sidecars install` takes the SAME
// lock, so a human running it inside a live refresh is told to wait rather
// than put a second npm on the tree.
//
// It also does not start AT startup. server.ts fires the check the moment the
// transport connects, which is exactly when the client's first tools/list
// activates servers -- spawned from the very tree a refresh rewrites. The
// check therefore sleeps SIDECAR_REFRESH_START_DELAY_MS past its cheap gates
// before touching the registry or the tree; see KNOWN GAPS for the window that
// leaves open. When it wakes it reads the throttle stamp a SECOND time, so a
// pane that wakes after another pane's whole check has stamped stops there
// instead of probing again. Panes that wake within a few seconds of each
// other (a burst of restored tabs) still all probe: each sleeps exactly the
// same delay and the stamp lands only after the probes -- the same window
// auto-upgrade's check memo leaves open. The lock below covers only the
// install, and a pane that finds nothing stale never takes it, so without the
// second read every pane that woke later would probe too.
//
// KNOWN GAPS (documented rather than papered over):
//   - The refresh action is WHOLE-TREE, not per-package. runSidecarsInstall
//     rewrites the manifest from bundles.json and runs one `npm install` plus
//     one `npm update` in the sidecars root; there is no argument that says
//     "only this package". So `plan.stale` is a TRIGGER, not a work list. What
//     protects a pinned spec is therefore not the plan -- it is npm: `update`
//     honours the manifest range, so `pkg@1.0.0` cannot drift even though the
//     whole-tree update runs. The plan's job is to decide whether the tree is
//     worth touching at all; npm's job is to decide what moves when it is.
//   - Consequence of the above: a configured-but-not-installed package IS
//     acquired as a side effect once any other package triggers a refresh,
//     even though the plan lists it as skipped. `npm install` against a
//     manifest that names it cannot do otherwise. It is a merge, not an
//     `npm ci`, so nothing already in the tree is removed.
//   - The lock is advisory: a sidecars root we cannot write to yields a no-op
//     lock and the old unserialized behavior, and a lock left behind by a
//     killed process is stolen once it goes stale BY MTIME (auto-upgrade owns
//     both rules and the constants behind them) -- deliberately not on the
//     holder's death, because the npm child it guards outlives a plain
//     parent exit and a second reify on that tree is the collision the lock
//     exists to prevent. A lock this process still HOLDS is
//     kept out of that stale window by a heartbeat -- see acquireSidecarsLock
//     in sidecars-cmd, which is why the reused ten-minute window does not have
//     to cover a whole-tree install.
//   - The refresh rewrites the tree THIS process spawns servers from, and it
//     cannot pause activations while npm runs. A server activated mid-reify
//     can meet a package.json whose bin is not on disk yet (resolveNpmEntry
//     then quietly falls to an older cache copy) or a bin whose dependencies
//     are half-extracted (the oam boot fails, upstream burns its one-shot node
//     respawn and pins that namespace to node for the session -- nothing can
//     tell that failure from a real one). The start delay moves the refresh
//     off the connect-time activation burst, where nearly every spawn of a
//     session happens; a mid-session re-spawn (the idle reaper) that lands
//     inside the minute or so npm runs still races. On Windows a RUNNING
//     sidecar holding a native .node open also makes `npm update` fail EPERM
//     until that server is reaped, once a day, with nothing on screen.
//   - The npm child is not detached, so an MCP client that tears down the
//     process tree takes a half-finished install with it. Recovery is a manual
//     `yaw-mcp sidecars install`; nothing here repairs a partial tree.
//
// Opt-out: YAW_MCP_SIDECAR_REFRESH=0 (or =false), parsed exactly like
// auto-upgrade's YAW_MCP_AUTO_UPGRADE.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { loadLocalBundles } from "./local-bundles.js";
import { log } from "./logger.js";
import { compareVersions } from "./oam-spawn.js";
import { CONFIG_DIRNAME, sidecarsRoot } from "./paths.js";
import {
  acquireSidecarsLock,
  collectSidecarSpecs,
  configuredRange,
  defaultRunNpm,
  hasManagedSidecars,
  installedVersion,
  runSidecarsInstall,
  type SidecarSpec,
  type SidecarsInstallOptions,
} from "./sidecars-cmd.js";
import type { UpstreamServerConfig } from "./types.js";

/** How long a completed check suppresses the next one. A day: sidecar releases
 *  land on the order of days, and the cost of checking is N registry round
 *  trips on a path that runs on EVERY MCP client start -- several times an hour
 *  for a heavy Claude Code user. Mirrors install-nudge's "act once, then stay
 *  quiet" cadence. */
export const SIDECAR_REFRESH_THROTTLE_MS = 24 * 60 * 60 * 1000;

/** Abort budget for one package's registry probe. Shorter than `upgrade`'s
 *  3000ms and matched to doctor's 2000ms for the reason doctor picked it:
 *  nobody is waiting for this answer, so a black-holed registry must cost a
 *  bounded couple of seconds and then read as "unknown", not hold a socket and
 *  a timer open behind a long-lived server process. The probes run in parallel,
 *  so N packages cost ONE budget, not N. */
export const SIDECAR_REGISTRY_TIMEOUT_MS = 2000;

/** How long past its cheap gates the check sleeps before it probes the
 *  registry or touches the tree. server.ts fires maybeRefreshSidecars the
 *  instant the transport connects, and the client's first tools/list follows
 *  within seconds -- activating servers, i.e. spawning them from the managed
 *  tree an npm reify pass is about to rewrite (see the header's KNOWN GAPS for
 *  what a spawn that lands mid-reify sees). A minute is past that burst on any
 *  client, and costs nothing that matters: a `serve` that exits sooner just
 *  runs the check on its next start, since nothing is recorded until the check
 *  actually completes. Sits AFTER the opt-out, managed-tree and throttle gates
 *  so the common no-op start holds no timer at all. */
export const SIDECAR_REFRESH_START_DELAY_MS = 60 * 1000;

/** State file, beside the other ~/.yaw-mcp state.
 *
 *  NOT a key in state.json, which is the obvious-looking home for it. Two
 *  reasons, either one fatal: persistence.ts's loadState rebuilds the state
 *  object from a fixed sanitizer (learning / packHistory / toolCache), so an
 *  unknown key does not survive a load; and saveState writes the WHOLE document
 *  from the running broker's in-memory snapshot, so the next debounced save
 *  would erase a timestamp written behind its back anyway. install-nudge hit
 *  the same wall and reached the same answer -- its own small file. */
export const SIDECAR_REFRESH_STATE_FILENAME = "sidecar-refresh-state.json";

/** Absolute path to the throttle-state file inside `~/.yaw-mcp/`. */
export function sidecarRefreshStatePath(home: string = homedir()): string {
  return join(home, CONFIG_DIRNAME, SIDECAR_REFRESH_STATE_FILENAME);
}

/** The persisted throttle state. One KNOWN key today; read-modify-written
 *  rather than overwritten so a key a later build adds here is not dropped by
 *  an older binary's write.
 *
 *  Exported because it is part of SidecarRefreshDeps' surface (readStateImpl
 *  returns it): a caller that had to hand-copy `{ lastSidecarRefreshCheck?:
 *  number }` would be re-introducing exactly the drift the index signature
 *  below exists to prevent. */
export interface SidecarRefreshState {
  /** Epoch ms of the last COMPLETED check. See maybeRefreshSidecars for the
   *  one path that deliberately does not record it. */
  lastSidecarRefreshCheck?: number;
  /** Anything else the file carried. A NEWER build's key rides through
   *  parse -> merge -> write untouched instead of being erased by this one's
   *  save; without the index signature parseSidecarRefreshState could not
   *  return the keys it preserved, and the read-modify-write above would be a
   *  read-rebuild-write that silently drops them. */
  [key: string]: unknown;
}

/** What a write must supply: the state's KNOWN keys, with the timestamp
 *  REQUIRED. Derived from SidecarRefreshState so the two cannot drift --
 *  adding a key there widens this automatically instead of leaving a
 *  hand-copied literal behind. Exported alongside it for the same reason:
 *  writeStateImpl takes one. */
export type SidecarRefreshStatePatch = Required<Pick<SidecarRefreshState, "lastSidecarRefreshCheck">>;

export interface SidecarRefreshDeps {
  /** Test hook: replace the per-package registry probe. */
  fetchLatestImpl?: (pkg: string) => Promise<string | null>;
  /** Test hook: replace the background refresh. `onDone` releases the sidecars
   *  lock and MUST be called once the refresh has finished (or failed). */
  spawnRefreshImpl?: (stale: SidecarSpec[], onDone: () => void) => void;
  /** Test hook: replace the lockfile that serializes concurrent refreshes.
   *  Returning null means "someone else holds it". */
  acquireLockImpl?: (dir: string) => (() => void) | null;
  /** Test hook: replace the on-disk installed-version read. */
  installedVersionImpl?: (pkg: string, home?: string) => string | null;
  /** Test hook: replace the "is there a managed tree at all" probe. */
  hasManagedSidecarsImpl?: (home?: string) => boolean;
  /** Test hook: replace the configured-sidecar-spec load. */
  specsImpl?: () => Promise<SidecarSpec[]>;
  /** Test hook: the clock. */
  nowImpl?: () => number;
  /** Test hook: the start delay (see SIDECAR_REFRESH_START_DELAY_MS). Resolves
   *  when the check may go on to the registry and the tree. */
  delayImpl?: (ms: number) => Promise<void>;
  /** Test hook: read the throttle state. Null means unreadable or absent,
   *  which reads as "never checked" (fail-open). Called TWICE on a start that
   *  gets past the cheap gates: once before the start delay and once after it
   *  (steps 3 and 3c of maybeRefreshSidecars) -- the second read is how a pane
   *  notices a check another pane completed while this one slept.
   *
   *  Typed via SidecarRefreshState rather than re-declaring its shape inline:
   *  that interface is read-modify-written precisely so a key a later build
   *  adds is not dropped, and a hand-copied `{ lastSidecarRefreshCheck?: number }`
   *  here would silently fail to carry such a key -- with no type error to
   *  catch the drift, which is the exact failure the interface guards against. */
  readStateImpl?: () => SidecarRefreshState | null;
  /** Test hook: persist the throttle state. Best-effort; never throws. May be
   *  async -- the default is, because it writes atomically -- and the check
   *  awaits it, so "resolves once the check completes" holds for the write. */
  writeStateImpl?: (patch: SidecarRefreshStatePatch) => void | Promise<void>;
  /** Home directory the managed tree lives under. Defaults to homedir(). */
  home?: string;
}

export interface SidecarRefreshPlan {
  /** Packages that asked to float and are behind the registry. */
  stale: Array<{ pkg: string; installed: string; latest: string }>;
  /** Every other configured package, with the reason it was passed over. */
  skipped: Array<{ pkg: string; reason: string }>;
}

/** True when a unit test is driving. Every DEFAULT implementation below is
 *  gated on it, in one place, because each one reaches something a test run
 *  must never touch: the network, the user's real ~/.yaw-mcp, a lockfile in a
 *  real sidecars root, or a real `npm install`. Tests inject their own impls
 *  and never see these paths; a test that forgets to inject one gets a
 *  deterministic no-op instead of a machine-dependent side effect. Mirrors the
 *  VITEST short-circuits in upgrade-cmd (npmGlobalPrefix), auto-upgrade
 *  (defaultAcquireLock) and doctor (registrySkipCheck). */
function inUnitTest(): boolean {
  return Boolean(process.env.VITEST);
}

/**
 * Why this spec can never be refreshed, or null when it is eligible.
 *
 * THE single eligibility rule, shared by buildRefreshPlan (which reports it)
 * and maybeRefreshSidecars (which uses it to avoid probing the registry for a
 * package it could not move anyway). Two copies of this predicate is how the
 * probe set and the plan come to disagree about which packages are in play.
 */
function ineligibleReason(spec: SidecarSpec): string | null {
  const range = configuredRange(spec);
  if (range === "latest") return null;
  return `configured "${range}", not "latest" -- an explicit pin, range or dist-tag is left alone`;
}

/**
 * Decide which managed packages are stale. Pure: no I/O, no clock, no env.
 * This is where the staleness matrix lives, so it is the half that gets tested
 * exhaustively.
 *
 * `stale` and `skipped` PARTITION `specs`: every configured package appears in
 * exactly one of them, exactly once. An up-to-date package is a skip with a
 * reason like any other, so a caller rendering the plan never has to account
 * for a package that simply vanished.
 */
export function buildRefreshPlan(args: {
  specs: SidecarSpec[];
  installed: Map<string, string | null>;
  latest: Map<string, string | null>;
}): SidecarRefreshPlan {
  const stale: SidecarRefreshPlan["stale"] = [];
  const skipped: SidecarRefreshPlan["skipped"] = [];
  for (const spec of args.specs) {
    // Order matters: intent first. A pinned package is passed over for BEING
    // pinned, not for "the registry did not answer" -- we never asked.
    const ineligible = ineligibleReason(spec);
    if (ineligible !== null) {
      skipped.push({ pkg: spec.pkg, reason: ineligible });
      continue;
    }
    const installed = args.installed.get(spec.pkg) ?? null;
    if (installed === null) {
      // Configured but absent. Not stale -- never acquired. See the header on
      // why "keep it current" is not "fetch it for the first time", and the
      // KNOWN GAP that the whole-tree action cannot fully honour that.
      skipped.push({ pkg: spec.pkg, reason: "not installed in the managed tree" });
      continue;
    }
    const latest = args.latest.get(spec.pkg) ?? null;
    if (latest === null) {
      // Offline, 404, a private package, or a probe that timed out. Unknown is
      // not stale: acting on it would mean refreshing on no evidence.
      skipped.push({ pkg: spec.pkg, reason: "registry did not answer" });
      continue;
    }
    // Semver, never a string compare. compareVersions returns 0 for anything it
    // cannot parse, so a package with a non-semver version reads as equal and
    // is passed over rather than being handed a made-up verdict.
    const cmp = compareVersions(installed, latest);
    if (cmp < 0) {
      stale.push({ pkg: spec.pkg, installed, latest });
    } else if (cmp > 0) {
      // Ahead of the registry: a local dev build linked into the tree, or a
      // release yanked after we installed it. Refreshing would DOWNGRADE.
      skipped.push({ pkg: spec.pkg, reason: `installed ${installed} is newer than the registry's ${latest}` });
    } else {
      skipped.push({ pkg: spec.pkg, reason: `up to date (${installed})` });
    }
  }
  return { stale, skipped };
}

/** Latest-version probe for one package. Same contract and response validation
 *  as upgrade-cmd's fetchLatestVersion (null on any failure, hard abort at the
 *  budget) but keyed by package -- that one is hardwired to @yawlabs/mcp.
 *
 *  doctor-cmd has a near-identical fetchSidecarLatest, and this is NOT that one
 *  reused: it is unexported, and importing doctor-cmd would drag the entire
 *  diagnostic command onto the serve startup path for one fetch. (oam-spawn's
 *  compareVersions header documents the same dependency-direction rule.) If a
 *  third copy ever wants to exist, promote one to a shared module instead. */
async function defaultFetchLatest(pkg: string): Promise<string | null> {
  if (inUnitTest()) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SIDECAR_REGISTRY_TIMEOUT_MS);
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
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

/** The lock the serve path actually uses: sidecars-cmd's acquireSidecarsLock,
 *  the SAME lock a manual `sidecars install` takes, so the two writers of the
 *  managed tree serialize against each other and not merely against
 *  themselves. It lives there, beside the install it guards, together with
 *  the heartbeat that keeps a whole-tree install out of auto-upgrade's
 *  ten-minute stale-steal window; this module used to carry both, plus a
 *  hand-copied lockfile name that the heartbeat could drift from. */
function defaultAcquireLock(dir: string): (() => void) | null {
  if (inUnitTest()) return () => {};
  return acquireSidecarsLock(dir);
}

/** The start delay (see SIDECAR_REFRESH_START_DELAY_MS). The timer is unref'd:
 *  a `serve` that exits inside the delay must not be held open by a background
 *  nicety, and the promise then simply never settles -- nothing awaits it but
 *  the fire-and-forget check. Guarded the way the lock heartbeat guards its
 *  interval: under an embedded host whose global setTimeout is the browser
 *  one, there is no unref to call. */
function defaultDelay(ms: number): Promise<void> {
  if (inUnitTest()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/** The options the background install runs with. Exported (and pure) so the
 *  properties that matter are pinned by a test rather than by a comment:
 *
 *  - `cwd` is the HOME dir, so the install rewrites the shared manifest from
 *    the USER-GLOBAL bundles.json and never from whatever project the MCP
 *    client was launched in. It must stay in lockstep with loadSidecarSpecs,
 *    which plans against the same scope: a plan computed from one config and
 *    an install performed from another is a plan that describes nothing.
 *  - all three output channels are silenced. `out`/`err` default to the
 *    command's prose on stdout/stderr, which from inside serve would put an
 *    "Installed:" table in the middle of the MCP stream, and runNpm defaults to
 *    a child whose own output goes to fd 2 -- which from inside serve is the
 *    stream the MCP client reads our diagnostics from, sprayed with "added 220
 *    packages in 12s" and every npm warning.
 *  - the npm child's console window is hidden. `serve` under a GUI-launched
 *    MCP client has no console of its own, and a console child of such a
 *    process (cmd.exe running npm.cmd) is given a brand-new window on the
 *    user's desktop for as long as it runs -- a blank box for the length of
 *    an install plus an update, once a day, from a process the user never
 *    started by hand. The CLI deliberately does NOT hide (see
 *    RunNpmOptions.windowsHide), so this is set here and not in the default.
 *  - the lock is a no-op. maybeRefreshSidecars takes the real sidecars lock,
 *    heartbeat and all, BEFORE it spawns this install (step 7), and the
 *    command's own default would take that same lock again: an O_EXCL take
 *    against a file this very process created reads as "held by someone
 *    else", and the refresh would refuse the install it took the lock for.
 *
 *  The runner is sidecars-cmd's defaultRunNpm with the two things this caller
 *  differs on -- `stdio` and `windowsHide` -- rather than a second spawn of its
 *  own. The rest of that shape is security-sensitive: npm on Windows is a .cmd
 *  shim Node refuses to spawn without a shell (post-CVE-2024-27980), which is
 *  safe ONLY because every argument is a fixed literal and `cwd` travels as a
 *  spawn option rather than in the command line. A hand-copied runner is how
 *  that condition comes to be kept in one place and forgotten in the other. */
export function backgroundInstallOptions(home: string): SidecarsInstallOptions {
  return {
    home,
    cwd: home,
    runNpm: (args, cwd) => defaultRunNpm(args, cwd, { stdio: "ignore", windowsHide: true }),
    out: () => {},
    err: () => {},
    acquireLock: () => () => {},
  };
}

/** Run the refresh in the background and release the lock when it settles.
 *
 *  `stale` is here for the log line and for a test to assert on -- it is NOT a
 *  work list, because runSidecarsInstall has no way to accept one: it rewrites
 *  the manifest from bundles.json and installs the tree as a whole. See the
 *  header's first KNOWN GAP for why that is nonetheless safe for pinned specs.
 *
 *  onDone fires on EVERY exit path -- resolve, reject, and the
 *  impossible-in-practice synchronous throw -- via `finally`. auto-upgrade
 *  needed two handlers and a `released` flag to get the same guarantee out of a
 *  child process; one promise gets it for free. */
function defaultSpawnRefresh(stale: SidecarSpec[], onDone: () => void, home: string): void {
  if (inUnitTest()) {
    onDone();
    return;
  }
  void (async () => {
    try {
      const result = await runSidecarsInstall(backgroundInstallOptions(home));
      if (result.exitCode === 0) {
        // NOT "restart your MCP client": this writes into the very tree this
        // process re-spawns servers from, so the next ACTIVATION of a refreshed
        // server -- which the idle reaper makes a routine mid-session event --
        // already picks up the new version. Only a server that is loaded right
        // now keeps the copy it started on, until it is next re-spawned.
        log("info", "yaw-mcp sidecar refresh complete; the next activation of each server spawns the new version", {
          refreshed: stale.map((s) => s.pkg),
          installed: result.installed.map((i) => `${i.pkg}@${i.version ?? "?"}`),
        });
      } else {
        // stdio was ignored, so the underlying npm error is not recoverable
        // here. Name the manual command rather than pretending to diagnose.
        log("warn", "yaw-mcp sidecar refresh did not complete; run `yaw-mcp sidecars install` to see why", {
          exitCode: result.exitCode,
        });
      }
    } catch (err) {
      log("warn", "yaw-mcp sidecar refresh failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      onDone();
    }
  })();
}

/**
 * The state file's contents, validated. Null means "there is no usable state
 * here" -- which reads as "never checked" (fail-open), so the worst case is one
 * extra check, never a suppressed feature.
 *
 * PURE, and separate from the read it is fed by, because this is where all the
 * judgement lives: corrupt JSON, a document that is not an object, a stamp that
 * is not a number, NaN / Infinity, a negative stamp, and the forward-compat
 * rule below. The I/O wrapper around it is short-circuited under VITEST (see
 * inUnitTest), so anything left inside that wrapper is untestable by
 * construction -- which is exactly what this split exists to undo.
 *
 * Foreign keys are PRESERVED. A newer build that adds a second key to
 * SidecarRefreshState must be able to write it, run this (older) build once,
 * and still find it: the state is read-modify-written, and a read that rebuilt
 * a fresh object from the one key it knows would quietly drop the rest on the
 * next write. Only `lastSidecarRefreshCheck` is normalized; everything else
 * rides through untouched and unread.
 */
export function parseSidecarRefreshState(text: string): SidecarRefreshState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // `null` is typeof "object"; an ARRAY is too, and spreading one below would
  // turn its indices into state keys that then get written back out as
  // `{"0": ...}`. Neither is a state document.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { lastSidecarRefreshCheck: at, ...rest } = parsed as Record<string, unknown>;
  // A non-finite / negative timestamp is a hand-edited or corrupt file. Drop
  // the VALUE rather than the whole document: NaN fails every comparison
  // silently, and "never checked" is the honest reading of a broken stamp --
  // while any OTHER key in the file is still someone's data.
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) return rest;
  return { ...rest, lastSidecarRefreshCheck: at };
}

/** The read-modify-write, as a pure function: what was on disk, with the patch
 *  applied over it. Split out for the same reason as the parse -- it is the
 *  half that either honours or drops a newer build's key, and it is one line
 *  that nothing could otherwise reach under VITEST. */
export function mergeSidecarRefreshState(
  prev: SidecarRefreshState | null,
  patch: SidecarRefreshStatePatch,
): SidecarRefreshState {
  return { ...(prev ?? {}), ...patch };
}

/** Read the throttle state. A thin wrapper over parseSidecarRefreshState: an
 *  absent or unreadable file is the same null the parse returns for a corrupt
 *  one. */
function defaultReadState(home: string): SidecarRefreshState | null {
  if (inUnitTest()) return null;
  try {
    return parseSidecarRefreshState(readFileSync(sidecarRefreshStatePath(home), "utf8"));
  } catch {
    return null;
  }
}

/** Persist the throttle state. Read-modify-write so an unknown key written by
 *  a newer build survives this one's write. Best-effort: a write failure costs
 *  at most one extra check on the next startup, so it is swallowed at debug --
 *  the same trade install-nudge makes.
 *
 *  Atomic (write-then-rename, the helper sidecars-cmd already uses for the
 *  manifest), and that is not fussiness: the read-modify-write above is what
 *  makes a torn write expensive. A torn STAMP alone would be cheap -- it reads
 *  back as corrupt, which defaultReadState treats as "never checked", one
 *  extra check -- but a torn FILE loses every foreign key with it, the very
 *  keys parseSidecarRefreshState goes out of its way to carry a newer build's
 *  state through this build's save. atomicWriteFile creates the parent
 *  directory too, so a fresh ~/.yaw-mcp needs no mkdir here. */
async function defaultWriteState(home: string, patch: SidecarRefreshStatePatch): Promise<void> {
  if (inUnitTest()) return;
  try {
    const path = sidecarRefreshStatePath(home);
    const next = mergeSidecarRefreshState(defaultReadState(home), patch);
    await atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch (err) {
    log("debug", "sidecar-refresh: failed to record the check timestamp", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Just the slice of loadLocalBundles this module uses. Narrow on purpose: the
 *  real loader satisfies it, and a test can hand over a two-line fake instead of
 *  building out LoadLocalBundlesResult's other eight fields. */
type BundlesLoader = (opts: { cwd?: string; home?: string }) => Promise<{
  config: { servers?: Array<Partial<UpstreamServerConfig>> } | null;
}>;

/**
 * The configured sidecar specs, from the same loader `sidecars install` uses so
 * the plan is computed against the manifest the refresh will actually write.
 * A load failure yields no specs, which is a clean no-op.
 *
 * `cwd` is the HOME dir, NOT process.cwd(), and that is the whole point of this
 * function existing separately from its gated caller. findProjectConfigDir
 * stops just before $HOME when the walk starts there, so passing home as the
 * cwd resolves to "user-global bundles.json only" -- see the header's WHICH
 * CONFIG IT ACTS ON. It must agree with backgroundInstallOptions, which forces
 * the same scope on the install; that pairing is what keeps the plan honest
 * about what gets written.
 *
 * The loader is injectable purely so that pairing is testable: every default in
 * this module is short-circuited under VITEST, so without a seam nothing could
 * observe which config scope the real path asks for.
 */
export async function loadSidecarSpecs(home: string, load: BundlesLoader = loadLocalBundles): Promise<SidecarSpec[]> {
  try {
    const bundles = await load({ cwd: home, home });
    return collectSidecarSpecs(bundles.config?.servers ?? []);
  } catch {
    return [];
  }
}

/** `loadSidecarSpecs`, gated. loadLocalBundles reads the real home (and, but
 *  for the cwd above, would walk the real cwd) for bundles.json, so an ungated
 *  call made a test's result depend on the developer's own config --
 *  observably: running this module's suite logged "Skipping an untrusted
 *  .yaw-mcp/ dir outside $HOME" naming a real path. No specs is the same clean
 *  no-op loadSidecarSpecs' own catch produces. */
async function defaultSpecs(home: string): Promise<SidecarSpec[]> {
  if (inUnitTest()) return [];
  return loadSidecarSpecs(home);
}

/** `hasManagedSidecars`, gated. One existsSync against the real
 *  ~/.yaw-mcp/sidecars, which is the FIRST gate maybeRefreshSidecars hits --
 *  so on a developer machine that has a managed tree, an ungated call let
 *  every later gate run against real state while CI (which has none) stopped
 *  at the door. False is the common real-world answer (`sidecars install` is
 *  opt-in) and the one that makes a forgotten injection a no-op. */
function defaultHasManagedSidecars(home: string): boolean {
  if (inUnitTest()) return false;
  return hasManagedSidecars(home);
}

/** `installedVersion`, gated. A stat + readFileSync + JSON.parse per package
 *  against the real managed tree. Null reads as "configured but not
 *  installed", which buildRefreshPlan already treats as not-stale. */
function defaultInstalledVersion(pkg: string, home: string): string | null {
  if (inUnitTest()) return null;
  return installedVersion(pkg, home);
}

/**
 * Is the background refresh switched off? `YAW_MCP_SIDECAR_REFRESH=0` or
 * `=false`, case-insensitively -- the same parse auto-upgrade uses for
 * YAW_MCP_AUTO_UPGRADE, so one habit ("=0 or =false turns it off") covers both
 * background features.
 *
 * Exported because this module is not the only place that has to answer the
 * question: doctor-cmd re-derives it to decide whether to describe a stale
 * package as one the refresher will carry forward (saying so on a machine where
 * the user turned the refresher off is simply false, to exactly the reader who
 * most needs to be told to run `sidecars install` by hand). That copy, and
 * auto-upgrade's for its own variable, should call this rather than re-spelling
 * the parse -- three hand-copies each carrying a comment promising to match the
 * others is how "=FALSE" ends up honoured by two of them and not the third.
 * `env` is a parameter for doctor's sake: it takes the environment as input.
 */
export function isSidecarRefreshDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.YAW_MCP_SIDECAR_REFRESH;
  return raw === "0" || raw?.toLowerCase() === "false";
}

/**
 * Fire-and-forget startup sidecar refresh check. Resolves once the check
 * completes; callers must NOT await it on the serve hot path, and it never
 * rejects -- every failure inside is absorbed to a no-op.
 */
export async function maybeRefreshSidecars(deps: SidecarRefreshDeps = {}): Promise<void> {
  try {
    // 1. Opt-out, before anything else.
    if (isSidecarRefreshDisabled()) return;

    const home = deps.home ?? homedir();
    const now = (deps.nowImpl ?? Date.now)();

    // 2. No managed tree, nothing to refresh. This is the COMMON case --
    // `sidecars install` is opt-in -- and it is one existsSync, so it comes
    // before the state read and long before the network. An npx-launched
    // server re-resolves `@latest` on every spawn and was never stale.
    if (!(deps.hasManagedSidecarsImpl ?? defaultHasManagedSidecars)(home)) return;

    // 3. Throttle. `age < 0` means the recorded check is in the FUTURE -- a
    // clock stepped backwards, or a home directory copied from a machine ahead
    // of this one. Proceeding (rather than clamping, install-nudge's answer for
    // a different cadence) self-heals in one run: this check rewrites the
    // timestamp to a sane `now`. Clamping would instead suppress the feature
    // for a full day on a machine whose clock is already confused.
    const state = (deps.readStateImpl ?? (() => defaultReadState(home)))();
    const last = state?.lastSidecarRefreshCheck;
    if (typeof last === "number") {
      const age = now - last;
      if (age >= 0 && age < SIDECAR_REFRESH_THROTTLE_MS) return;
    }
    // Awaited wherever it is called: the default write is atomic and therefore
    // async, and "resolves once the check completes" has to include the write
    // -- a caller (or test) that sees this promise settle must be able to read
    // the stamp back.
    const writeState = deps.writeStateImpl ?? ((patch: SidecarRefreshStatePatch) => defaultWriteState(home, patch));
    const recordCheck = async (): Promise<void> => {
      await writeState({ lastSidecarRefreshCheck: now });
    };

    // 3b. Wait out the connect-time activation burst. Everything above was a
    // local read; everything below reads the config, probes the registry and
    // -- if anything is stale -- rewrites the tree the burst is spawning
    // servers from (see SIDECAR_REFRESH_START_DELAY_MS and the header's KNOWN
    // GAPS). `now` stays the pre-delay clock on purpose: the throttle was
    // decided against it, and a stamp a minute early only makes the next
    // window a minute shorter. A `serve` that exits inside the delay has
    // recorded nothing and simply checks again on its next start.
    await (deps.delayImpl ?? defaultDelay)(SIDECAR_REFRESH_START_DELAY_MS);

    // 3c. Re-check the throttle now that a minute has passed. The stamp was
    // read BEFORE the delay, so a pane that started while another pane's
    // check was already under way passed the gate at step 3 and would go on
    // to load the config and probe the registry. One more cheap read: a pane
    // whose check finished while this one slept has stamped, and this one
    // stops here. (Panes that woke within seconds of each other still all
    // probe -- see the header; the stamp lands after the probes.)
    const afterDelay = (deps.readStateImpl ?? (() => defaultReadState(home)))();
    const lastAfterDelay = afterDelay?.lastSidecarRefreshCheck;
    if (typeof lastAfterDelay === "number") {
      const age = (deps.nowImpl ?? Date.now)() - lastAfterDelay;
      if (age >= 0 && age < SIDECAR_REFRESH_THROTTLE_MS) return;
    }

    // 4. What is configured.
    const specs = await (deps.specsImpl ?? (() => defaultSpecs(home)))();
    if (specs.length === 0) {
      await recordCheck();
      return;
    }

    // 5. What is on disk, and what the registry has. Both reads are scoped to
    // specs that could actually be moved, via the same ineligibleReason the
    // plan uses -- so neither set can disagree with the plan about who is in
    // play. The installed read is cheap but not free (stat + readFileSync +
    // JSON.parse each) and this is the serve startup path: for a pinned spec
    // buildRefreshPlan reaches its ineligible branch FIRST and never consults
    // installed.get, so reading those versions was work whose result was
    // guaranteed unused. doctor's `anyManaged` short-circuit models the same
    // shape.
    const installedVersionFn = deps.installedVersionImpl ?? defaultInstalledVersion;
    const eligible = specs.filter((s) => ineligibleReason(s) === null);
    const installed = new Map<string, string | null>(
      eligible.map((s): [string, string | null] => [s.pkg, installedVersionFn(s.pkg, home)]),
    );
    const probable = eligible.filter((s) => (installed.get(s.pkg) ?? null) !== null);
    const fetchLatest = deps.fetchLatestImpl ?? defaultFetchLatest;
    // Parallel, so N packages cost one timeout window. Each probe is
    // individually absorbed to null: Promise.all rejects on the FIRST rejection
    // and abandons the others' results, so one 404 must not be able to turn the
    // whole check into a thrown error.
    const latest = new Map<string, string | null>(
      await Promise.all(
        probable.map(async (s): Promise<[string, string | null]> => {
          try {
            return [s.pkg, await fetchLatest(s.pkg)];
          } catch {
            return [s.pkg, null];
          }
        }),
      ),
    );

    // 6. Decide. Some packages resolving and others not is NOT a reason to
    // refuse the batch: the action is whole-tree (see KNOWN GAPS), so "refresh
    // only the ones that resolved" is not even expressible -- and a package
    // whose probe failed is one whose configured `latest` range npm will move
    // forward anyway, which is what that range asked for. Refusing on one
    // failed lookup would let a single 404 or slow package disable the refresh
    // for every other package, once a day, forever.
    const plan = buildRefreshPlan({ specs, installed, latest });
    if (plan.stale.length === 0) {
      // Nothing to do -- including the all-probes-failed (offline) case, which
      // is deliberately RECORDED rather than retried. A machine with no network
      // would otherwise probe the registry on every single client start, which
      // is precisely the storm the throttle exists to prevent; the cost of
      // getting it "wrong" is one day of staleness on a background nicety.
      log("debug", "sidecar refresh: nothing stale", { skipped: plan.skipped });
      await recordCheck();
      return;
    }

    // 7. Serialize. A null lock means another process is mid-refresh, and the
    // timestamp is deliberately NOT recorded: the winner is doing the work this
    // process would have done, and if it dies before finishing, the loser
    // retries on the next startup instead of sitting out a full day on a
    // refresh that never happened. (Unlike the offline case above, this is not
    // a completed check -- it is a check that yielded to someone else.)
    const release = (deps.acquireLockImpl ?? defaultAcquireLock)(sidecarsRoot(home));
    if (release === null) {
      log("info", "sidecar refresh: another process is already refreshing this tree; skipping this one", {
        stale: plan.stale.map((s) => s.pkg),
      });
      return;
    }
    // Release exactly once no matter how many paths reach it. The default
    // lock's own release is already idempotent, but an INJECTED acquireLockImpl
    // need not be -- and a double release would unlink a lock a DIFFERENT
    // process had since taken, which is the failure the lock exists to prevent.
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release();
    };

    // 8. Go. Record the timestamp regardless of how the background refresh
    // turns out: the CHECK is what the throttle governs, and a refresh that
    // fails must not put this process into a retry loop against a registry or
    // an npm that is already unhappy.
    const staleSpecs = specs.filter((s) => plan.stale.some((p) => p.pkg === s.pkg));
    log("info", "yaw-mcp sidecars are behind npm; refreshing the managed tree in the background", {
      stale: plan.stale.map((s) => `${s.pkg} ${s.installed} -> ${s.latest}`),
    });
    try {
      (deps.spawnRefreshImpl ?? ((s: SidecarSpec[], done: () => void) => defaultSpawnRefresh(s, done, home)))(
        staleSpecs,
        releaseOnce,
      );
    } catch (err) {
      // A synchronous throw out of the spawn would otherwise leave the lock held
      // for the full stale window, suppressing the next several startups'
      // refresh over a failure that already happened.
      releaseOnce();
      log("warn", "sidecar refresh: could not start the background refresh", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await recordCheck();
  } catch (err) {
    // The contract is "never throws". Anything unanticipated -- an injected dep
    // that misbehaves, a clock impl that blows up -- degrades to a skipped
    // check, never to a rejected promise on the serve startup path.
    log("debug", "sidecar refresh check failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
