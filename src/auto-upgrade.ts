// Fire-and-forget self-upgrade check, run once per yaw-mcp serve startup.
//
// yaw-mcp cannot hot-swap its own running code, so "auto-update" means:
// detect a stale install and upgrade it in the background so the NEXT
// spawn (the next time the MCP client restarts) runs the new version.
//
// Global install methods are acted on with their owning tool -- `npm
// install -g` / `pnpm add -g` / `bun add -g @yawlabs/mcp@latest` are
// whitelisted, non-destructive commands.
//   - npx installs self-heal already: `yaw-mcp install` now writes
//     `@yawlabs/mcp@latest`, so `npx` re-resolves the newest version on
//     every spawn. A stale npx cache without `@latest` in the client
//     config is a config problem this process can't safely fix from
//     inside serve, so it is logged, not acted on.
//   - local-node-modules / dev-checkout: the user owns that tree; we
//     never run package installs against it.
//   - bundled-app (inside Yaw Terminal): only an app update can refresh
//     it; logged, never touched.
//
// Never blocks serving: the registry fetch has a short timeout, the npm
// spawn's stdio is ignored (no parent I/O contention), and the whole
// thing is fire-and-forget. A failure is a no-op -- worst case the user
// runs the current version for one more session.
//
// Concurrent runs ARE serialized, best-effort, by a lockfile in the target
// prefix (acquireUpgradeLock): N MCP clients starting at once -- the realistic
// trigger being several Claude Code panes -- would otherwise each fire their
// own `npm install -g` into the same tree. Losers skip the spawn entirely and
// pick the new version up on the next restart, which is what a background
// upgrade promises anyway.
//
// Two small JSON memos keep a REPEATED startup cheap, where the lock only
// covers a simultaneous one:
//   - a machine-wide "checked recently" memo throttles the registry probe.
//     The lock is taken well after the fetch, so it never covered it, and
//     without the memo every serve start hits registry.npmjs.org. The memo
//     carries the ANSWER (the latest version, or null for an unreachable
//     registry), not just a timestamp: it is keyed by uid alone, so a copy
//     of yaw-mcp that cannot act on staleness (Yaw Terminal's bundled copy,
//     an npx run) would otherwise re-arm it on every restart, and a
//     global-npm copy on the same machine, reading "checked recently", would
//     never evaluate its own staleness at all. With the answer cached, a
//     later process of ANY install method still gets to its own plan.
//   - a per-lock "already attempted this version" stamp stops a permanently
//     failing install (the classic being EACCES on a sudo-installed global)
//     from re-running a full `npm install -g` on every single serve start. A
//     SUCCESSFUL upgrade invalidates it for free -- the next start is no
//     longer stale, so nothing reads the memo.
// Both are best-effort and fail open: a missing, unreadable or malformed memo
// just means the work happens.
//
// KNOWN GAPS in the background install (documented rather than papered
// over -- see defaultSpawn):
//   - The lock is advisory and best-effort: a prefix we cannot write to
//     yields no lock and the old unserialized behavior, and a lock left
//     behind by a killed process is stolen once it goes stale (by rename, so
//     two stealers cannot both win -- see acquireUpgradeLock). A crash between
//     that rename and its unlink leaves a `.yaw-mcp-upgrade.lock.stale-<pid>`
//     file behind that nothing reads.
//   - The attempt memo (`<prefix>/.yaw-mcp-upgrade.lock.attempt`) is never
//     deleted, not even after a successful upgrade, so every global prefix
//     yaw-mcp has ever self-upgraded from keeps that one dotfile. Deliberate:
//     an install that exits 0 into the WRONG tree (the multi-prefix case the
//     `--prefix` machinery narrows but cannot close) leaves the running copy
//     stale, and the memo is what keeps THAT from re-running a full npm
//     install on every serve start for six hours. Deleting it on exit 0 would
//     trade a stray 40-byte file for exactly that loop.
//   - The child is NOT detached, which on POSIX does not mean it dies
//     with yaw-mcp -- it only dies when the client kills the whole
//     process group/tree (which MCP clients commonly do). If it IS
//     killed mid-install, the install is not guaranteed to be intact:
//     npm's reify removes the existing package dir before moving the new
//     one in and writes bin shims separately, so the window leaves a
//     partial install. There is no repair logic; recovery is a manual
//     `npm install -g @yawlabs/mcp@latest`.
//
// Opt-out: set YAW_MCP_AUTO_UPGRADE=0 (or =false) to suppress the check
// entirely -- useful for pinned-version setups or sudo-installed
// globals where `npm install -g` would always EACCES.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { stripInternalSecretsFromEnv } from "./internal-secret-env.js";
import { log } from "./logger.js";
import {
  buildUpgradePlan,
  comparablePath,
  detectInstallMethod,
  detectSea,
  fetchLatestVersion,
  GLOBAL_UPGRADE_METHODS,
  globalUpgradeCommandLineForTool,
  npmGlobalPrefix,
  upgradeSpawnSpec,
} from "./upgrade-cmd.js";

declare const __VERSION__: string;

/** Quote a single argv entry for the shell the npm spawn actually uses.
 *
 *  Only win32 spawns with `shell: true`, so only win32 needs quoting; on
 *  POSIX the arg is passed through execve untouched and quoting it would
 *  put literal quotes INTO the path. Returns null when the value cannot be
 *  safely quoted, so the caller drops `--prefix` entirely rather than
 *  emitting a mangled command line -- npm's own prefix resolution is a
 *  worse-but-safe fallback, and a broken `--prefix` is not.
 *
 *  Narrower sibling of quoteForShell in compliance-cmd.ts; kept local so a
 *  background upgrade path does not depend on a CLI command module. */
export function quoteShellArgIfNeeded(arg: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "win32") return arg;
  // A newline or NUL terminates the command line regardless of quoting, and
  // cmd.exe expands %VAR% and breaks on a literal " even inside quotes.
  if (/[\r\n\0"%]/.test(arg)) return null;
  if (!/[\s&|<>^]/.test(arg)) return arg; // nothing the shell would act on
  return `"${arg}"`;
}

/** Quote a single argv entry for DISPLAY in a printed command line.
 *
 *  quoteShellArgIfNeeded above quotes for the shell the spawn actually uses,
 *  which on POSIX is no shell at all -- so the SPAWN argv must stay raw
 *  there. But a printed suggestion gets pasted into an interactive shell,
 *  which splits on whitespace: a prefix like `/Users/j/My Tools` printed raw
 *  makes npm read `/Users/j/My` as the prefix and install a package named
 *  `Tools`. The display form therefore quotes independently of the spawn
 *  argv: on win32 it reuses quoteShellArgIfNeeded so the printed line stays
 *  byte-identical to what the shell:true spawn joins; on POSIX it
 *  single-quotes anything outside the shell-inert character set (with the
 *  standard '\'' escape for embedded single quotes). Returns null exactly
 *  when quoteShellArgIfNeeded does (win32 unquotable) -- POSIX display
 *  quoting always succeeds. */
export function quoteArgForDisplay(arg: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") return quoteShellArgIfNeeded(arg, platform);
  // Allowlist of characters no POSIX shell acts on; anything else (spaces,
  // `$`, backticks, globs, ...) gets the arg single-quoted. Quoting a tad
  // too eagerly is harmless; under-quoting silently splits the paste.
  if (/^[A-Za-z0-9_\-./+,:@=]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Resolve the global install prefix of the CURRENTLY running yaw-mcp from the
 *  LAST `node_modules` segment of `process.argv[1]`'s directory
 *  (realpath-resolved first, so a symlinked shim like
 *  `/usr/local/bin/yaw-mcp -> /opt/node/lib/node_modules/@yawlabs/mcp/...`
 *  points at the real install root). The directory ABOVE that `node_modules`
 *  is the prefix that owns this install -- minus a trailing `lib`, which POSIX
 *  globals insert (`<prefix>/lib/node_modules/...`) and `npm prefix -g` does
 *  not report. No `.bin` directory is involved: the match is on the bare
 *  `node_modules` segment, and nothing reads the filesystem beyond the initial
 *  realpath.
 *
 *  We need this because `npm prefix -g` reports the user's *configured*
 *  global prefix -- which can differ from the prefix the running install
 *  actually lives under (custom prefixes, multiple Node versions, nvm,
 *  Yaw Terminal's bundled Node). Installing into the configured global
 *  prefix while the running install is rooted elsewhere produces a
 *  silent no-op upgrade: a second copy is updated but the spawned-from-
 *  client one stays stale. */
export function detectRunningInstallPrefix(argvPath: string | undefined): string | null {
  if (!argvPath) return null;
  let resolved: string;
  try {
    resolved = realpathSync(argvPath);
  } catch {
    return null;
  }
  // ONE lastIndexOf on the entrypoint's directory. This used to be a walk-up
  // loop with a 24-iteration cap, which was theatre: lastIndexOf scans the
  // WHOLE string, so any `node_modules` segment is found on the first pass and
  // walking up can never introduce one that pass missed. The cap's documented
  // effect ("an install nested deeper than 24 segments returns null") was
  // therefore never real, and the test that claimed to pin it used a
  // node_modules-free path -- i.e. it pinned the null that the -1 below
  // returns anyway. Depth does not matter; the presence of the segment does.
  //
  // Two recognized shapes:
  //   1. <prefix>/node_modules/<pkg>/...    -> prefix is the dir above node_modules
  //   2. <prefix>/lib/node_modules/<pkg>/.. -> common on Linux global installs
  const dir = dirname(resolved);
  const idx = dir.lastIndexOf(`${sep}node_modules${sep}`);
  if (idx === -1) return null;
  const candidate = dir.slice(0, idx);
  // Linux-style global: strip a trailing `/lib` if present so the prefix is
  // the bin/lib parent (matches `npm prefix -g` output).
  if (candidate.endsWith(`${sep}lib`)) return candidate.slice(0, -`${sep}lib`.length);
  return candidate;
}

/** Log a warning when npm's configured global prefix differs from the
 *  detected running-install prefix. `detected` must be the RAW (unquoted)
 *  prefix -- comparing the shell-quoted form against npm's unquoted answer
 *  never matches, so every startup on a Windows account with a space in the
 *  username (npm's DEFAULT global prefix path) warned about a multi-prefix
 *  setup the user does not have.
 *
 *  The probe itself is upgrade-cmd's npmGlobalPrefix: shared so there is one
 *  timeout, one kill and one VITEST short-circuit instead of two divergent
 *  copies. The COMPARATOR is shared for the same reason: this used to trim +
 *  lowercase only, while upgrade-cmd's comparablePath realpaths both sides --
 *  so on a junction-style prefix (scoop's `current` pointing into a versioned
 *  dir) the two names for one directory read as two prefixes and every stale
 *  startup printed a multi-prefix warning about a setup the user does not
 *  have. Best-effort -- a spawn failure, non-zero exit or timeout resolves
 *  null and silently skips the warning. Never blocks the caller. */
async function compareWithNpmPrefix(
  detected: string,
  probe: () => Promise<string | null> = npmGlobalPrefix,
): Promise<void> {
  const npmPrefix = await probe();
  // Null is the probe's own "couldn't answer"; blank output is the same thing
  // said differently, and comparing a path against "" would always "differ".
  if (!npmPrefix?.trim()) return;
  // Trim BEFORE comparablePath: realpath of a path with trailing whitespace
  // throws, which would silently drop the resolution back to a literal
  // comparison and reintroduce the junction false positive.
  if (comparablePath(npmPrefix.trim()) === comparablePath(detected)) return;
  // Through log(), not a raw process.stderr.write: everything else serve
  // emits is one JSON line per event, and a four-line plain-text blob in the
  // middle of that stream is what a client or operator parsing yaw-mcp's
  // stderr tripped over. The two paths ride as structured fields.
  log(
    "warn",
    "yaw-mcp self-upgrade: running prefix differs from `npm prefix -g`; installing into the running prefix so the upgrade lands in the tree the client spawned from",
    { running: detected, npmPrefix },
  );
}

/** DEFAULT lockfile name, in the prefix being installed into. Dotted so it does
 *  not show up in a casual `ls` of a global prefix. A caller with no prefix of
 *  its own to lock passes a scoped name instead -- see the tmpdir fallback in
 *  maybeAutoUpgrade, where one fixed name would put every tool family (and, on
 *  a shared POSIX box, every user) on one file. sidecars-cmd.ts passes its own
 *  SIDECARS_LOCK_NAME explicitly rather than leaning on this default; that
 *  constant deliberately EQUALS this value for the one mixed-version upgrade
 *  window (see its doc), so change the two together or not at all. */
const UPGRADE_LOCK_NAME = ".yaw-mcp-upgrade.lock";

/** How long a lock is honoured before it is treated as abandoned. An install
 *  is seconds; ten minutes is far past that. The holder is NOT guaranteed to
 *  release -- an MCP client that tears down the process tree mid-install
 *  leaves the file behind -- so an unstealable lock would disable self-upgrade
 *  on that prefix forever, which is strictly worse than one duplicated npm. */
const UPGRADE_LOCK_STALE_MS = 10 * 60 * 1000;

/** How far ahead of Date.now() a lock's mtime may sit and still count as
 *  "taken just now". Filesystem timestamp granularity routinely reports an
 *  mtime a hair ahead of the clock we compare it against; without this margin
 *  a lock taken microseconds ago reads as future-dated and gets stolen
 *  immediately, which is the same as having no lock at all. Anything further
 *  ahead than this really is a stepped clock (see the steal rule below). */
const UPGRADE_LOCK_FUTURE_SKEW_MS = 5 * 1000;

/** Is the process that wrote `lockPath` still running? The lock records its
 *  holder's pid (see take() below), so a lock whose holder is gone is stale
 *  NOW, not after the ten-minute mtime window: an MCP client that kills
 *  `serve` mid-refresh leaves the file behind, and the documented recovery
 *  (`yaw-mcp sidecars install`, or the next `add`/`remove` on bundles.json)
 *  was refused for the whole window with a "try again in a minute" that was
 *  wrong for nine of them. `kill(pid, 0)` sends no signal: ESRCH is "no such
 *  process" and settles it; EPERM is a live process we may not signal, which
 *  is still live. Anything unreadable or unparseable answers true -- an
 *  unknown holder is honoured, the mtime rule still bounds the wait. Windows
 *  reuses pids slowly enough that a false positive here costs at most the old
 *  behaviour (wait out the window). */
function lockHolderAlive(lockPath: string): boolean {
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
  } catch {
    return true;
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Best-effort cross-process lock around the background `npm install -g`.
 *
 *  Returns a release callback when the caller may proceed, and null ONLY when
 *  another live process is already installing into this prefix. "Best-effort"
 *  is the load-bearing word: a lock we cannot CREATE (read-only prefix,
 *  EACCES, EPERM) must not block the upgrade, so those cases hand back a
 *  no-op release and the caller proceeds exactly as it did before the lock
 *  existed. Only a live EEXIST means "someone else has this".
 *
 *  `openSync(path, "wx")` is the whole mutual-exclusion primitive: O_EXCL is
 *  atomic on both POSIX and Windows, so two processes racing it cannot both
 *  win. */
export function acquireUpgradeLock(dir: string, lockName: string = UPGRADE_LOCK_NAME): (() => void) | null {
  const lockPath = join(dir, lockName);
  /** What this process writes into the lock, and what its release reads back
   *  to prove the file it is about to unlink is still the one it took. */
  const mine = String(process.pid);
  /** undefined = the lock is held by someone else; otherwise a release fn. */
  const take = (): (() => void) | undefined => {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        // The pid is diagnostic (an operator who finds a stuck lock can tell
        // whether the owner still lives) AND load-bearing: the release below
        // reads it back before unlinking.
        writeSync(fd, `${mine}\n`);
      } finally {
        closeSync(fd);
      }
      // Idempotent AND ownership-checked, for two different failure modes.
      // Idempotent because both of defaultSpawn's handlers fire for an ENOENT
      // spawn. Ownership-checked because the `released` flag can only see THIS
      // process's releases: if our lock went stale and another process stole
      // it, an unconditional unlink here would delete the NEW holder's lock --
      // cascading the steal through every process behind it, which is the exact
      // outcome the idempotence guard exists to prevent.
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          // Not ours any more (stolen as stale, then retaken by someone else):
          // leave it alone. A read failure lands in the catch and is the same
          // answer -- do not unlink what we cannot prove we own.
          if (readFileSync(lockPath, "utf8").trim() !== mine) return;
          unlinkSync(lockPath);
        } catch {
          // Already gone (stolen as stale, or the dir was cleaned up).
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      return () => {};
    }
  };

  const first = take();
  if (first !== undefined) return first;

  // Held. Steal it only once it is provably stale: its holder is gone
  // (lockHolderAlive), or its mtime is past the window. An mtime further than
  // the skew margin into the FUTURE (clock stepped backwards between the two
  // runs) counts as stale too: no live process on this clock could have
  // written it, and honouring it would suppress every upgrade until
  // wall-clock caught up.
  const isLive = (ageMs: number): boolean => ageMs > -UPGRADE_LOCK_FUTURE_SKEW_MS && ageMs < UPGRADE_LOCK_STALE_MS;
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    // Vanished between the open and the stat. Treat it as stale so the steal
    // path runs: its rename answers ENOENT, which retries the take below rather
    // than reporting contention over a lock nobody holds.
    ageMs = UPGRADE_LOCK_STALE_MS;
  }
  if (isLive(ageMs) && lockHolderAlive(lockPath)) return null;

  // Steal by RENAME, not unlink. Two processes that both read the lock as
  // stale used to both unlinkSync it, and a successful unlink cannot tell "I
  // removed the stale file" from "I removed the file the OTHER stealer just
  // took": A unlinks and retakes, B's unlink then removes A's fresh lock and
  // B's take succeeds too -- two concurrent installs into one prefix, the
  // exact outcome the lock exists to prevent. Renaming the stale file to a
  // name private to this process makes the steal itself exclusive: only one
  // rename of that inode can succeed, and the loser sees ENOENT.
  const stolenPath = `${lockPath}.stale-${process.pid}`;
  try {
    renameSync(lockPath, stolenPath);
  } catch (err) {
    // ENOENT is "there was nothing left to steal" -- the holder released
    // between the stat and here, or another stealer's rename won. Either way
    // the path may be free now, and one retry of take() settles it: EEXIST
    // there is the winner's fresh lock, and that answer is final. Anything
    // else is a lost race too.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
    const retry = take();
    return retry === undefined ? null : retry;
  }
  // The rename moved SOME file, but not provably the stale one: the winner of
  // an earlier steal can have retaken a FRESH lock at this path between our
  // stat and our rename, and a rename cannot tell the two apart any more than
  // an unlink could. So check the file actually caught. A live mtime means a
  // running holder's lock was just pulled out from under it -- give it back
  // and yield.
  let stoleLive = false;
  try {
    stoleLive = isLive(Date.now() - statSync(stolenPath).mtimeMs) && lockHolderAlive(stolenPath);
  } catch {
    // Vanished under us: nothing to restore and nothing to unlink.
  }
  if (stoleLive) {
    // Restore without clobbering anyone: re-create the path with O_EXCL and
    // the holder's own pid, so its ownership-checked release still recognises
    // the file. EEXIST here means a THIRD process took the path meanwhile; the
    // live holder's lock is then simply gone, and the cost is bounded to one
    // possible duplicate install in that three-way race (the pre-lock
    // behavior) -- its release is ownership-checked, so nothing cascades.
    try {
      const holder = readFileSync(stolenPath, "utf8");
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, holder);
      } finally {
        closeSync(fd);
      }
    } catch {
      // EEXIST, or the stolen file vanished: leave it.
    }
    try {
      unlinkSync(stolenPath);
    } catch {}
    return null;
  }
  // Genuinely stale: discard it and take the freed path. The unlink is
  // best-effort -- a crash between the rename and here leaves a
  // `.stale-<pid>` file that nothing reads and no later steal contends on.
  try {
    unlinkSync(stolenPath);
  } catch {}
  const second = take();
  return second === undefined ? null : second;
}

/** The lock the serve path actually uses. Short-circuits under vitest --
 *  mirroring npmGlobalPrefix's probe guard -- so no unit test writes a
 *  lockfile into a real global prefix, or leaves one behind for the next test
 *  in the run to trip over. Tests that mean to exercise locking either call
 *  acquireUpgradeLock directly against a temp dir, or inject acquireLockImpl. */
function defaultAcquireLock(dir: string, lockName: string): (() => void) | null {
  if (process.env.VITEST) return () => {};
  return acquireUpgradeLock(dir, lockName);
}

/** How long a completed registry check (and the answer it fetched) is reused
 *  before another one fires. The check is a startup nicety, never a
 *  correctness input: without the memo every serve start hits
 *  registry.npmjs.org -- the prefix lock is taken long after the fetch, so it
 *  never covered this. An hour keeps a same-day release reachable while a
 *  REPEATED start within the hour reuses the cached answer. It does not
 *  collapse a simultaneous burst: the memo is written only after the fetch
 *  completes, so N panes starting inside the ~3s fetch window still make N
 *  requests. (A provisional memo written before the fetch would close that,
 *  at the price of a crashed fetch suppressing every re-check for an hour.) */
const UPGRADE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** How long one background upgrade ATTEMPT suppresses another at the SAME
 *  target version. Sized for the failure it exists for: a permanently failing
 *  install (EACCES on a sudo-installed global) that would otherwise re-run a
 *  full `npm install -g` on every serve start, forever. A successful upgrade
 *  needs no expiry -- the next start is no longer stale and never gets here. */
const UPGRADE_ATTEMPT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** A memo written by writeMemo, parsed and age-checked, or null when there is
 *  no usable one: absent, unreadable, malformed, or stamped further into the
 *  future than the clock-skew margin (same reasoning as the lock's
 *  future-dated steal rule -- a stepped clock is not evidence that anything
 *  happened recently). A memo only ever suppresses work, so every failure
 *  shape degrades to "do the work". */
function readMemo(path: string): { ageMs: number; memo: Record<string, unknown> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  // A truncated write can leave a valid JSON scalar (`null`, a number) behind,
  // and reading `.at` off that throws OUTSIDE the parse try -- so the shape is
  // checked before anything is read off it.
  if (typeof parsed !== "object" || parsed === null) return null;
  const memo = parsed as Record<string, unknown>;
  if (typeof memo.at !== "number") return null;
  const ageMs = Date.now() - memo.at;
  return ageMs < -UPGRADE_LOCK_FUTURE_SKEW_MS ? null : { ageMs, memo };
}

/** Best-effort memo write of `{ at: Date.now(), ...fields }`. An unwritable
 *  directory is not an error here: losing the memo costs a redundant check,
 *  never a wrong answer. */
function writeMemo(path: string, fields: Record<string, unknown>): void {
  try {
    writeFileSync(path, `${JSON.stringify({ at: Date.now(), ...fields })}\n`);
  } catch {
    // Read-only tmpdir / prefix, EACCES, EPERM -- degrade to no memo at all.
  }
}

/** What a fresh check memo hands back: the registry's answer as of that check.
 *  `latest: null` is a cached "unreachable" -- an offline machine answers null
 *  on every attempt, and re-probing an unreachable registry on each start is
 *  the same waste the memo exists to stop. */
export interface CachedCheck {
  latest: string | null;
}

/** Machine-wide memo of the last completed registry check. It has to live in
 *  tmpdir because the check runs before any install prefix is known, and it
 *  carries the uid so one user's check cannot silence another's on a shared
 *  POSIX box. */
function checkMemoPath(): string {
  return join(tmpdir(), `.yaw-mcp-upgrade-check-${process.getuid?.() ?? "win"}.json`);
}

/** The cached registry answer at `path`, or null when there is none to reuse:
 *  no usable memo (see readMemo), one older than UPGRADE_CHECK_INTERVAL_MS, or
 *  one without a `latest` field. That last case is the memo an older yaw-mcp
 *  wrote -- a bare timestamp -- and it is deliberately NOT honoured as
 *  "checked recently": a timestamp-only memo is precisely what let a
 *  non-actionable copy (bundled-app, npx) starve a global-npm copy on the same
 *  machine of ever evaluating its own staleness. Exported for tests: the
 *  default hooks below short-circuit under vitest. */
export function readCheckMemo(path: string): CachedCheck | null {
  const read = readMemo(path);
  if (read === null || read.ageMs >= UPGRADE_CHECK_INTERVAL_MS) return null;
  const latest = read.memo.latest;
  if (latest !== null && typeof latest !== "string") return null;
  return { latest };
}

/** Record a completed registry check together with its answer. Exported for
 *  tests, as readCheckMemo is. */
export function writeCheckMemo(path: string, latest: string | null): void {
  writeMemo(path, { latest });
}

/** The attempt memo sits next to the lock whose name it borrows, so it inherits
 *  that scoping for free: per prefix for a detected global install, per tool +
 *  uid for the tmpdir fallback. Keyed on the target version: a memo written
 *  for a different version is no evidence about this one. */
function attemptMemoPath(dir: string, lockName: string): string {
  return join(dir, `${lockName}.attempt`);
}

/** Where the attempt memo goes when `dir` cannot take it: the classic is a
 *  sudo-installed global (`/usr/local/lib/node_modules`) that a non-root
 *  `serve` can neither write a memo into nor lock. Without a fallback that
 *  install re-spawned `npm install -g` on EVERY start -- the check memo caches
 *  the registry answer, the attempt memo silently failed to land, the lock
 *  handed back a no-op release, and nothing between the cache and the spawn
 *  could say "already tried". Scoped by uid and by a hash of the prefix + lock
 *  name so two prefixes (or two users on a shared box) never share one. */
function attemptMemoFallbackPath(dir: string, lockName: string, fallbackDir: string): string {
  const scope = createHash("sha256").update(`${dir}\0${lockName}`).digest("hex").slice(0, 16);
  return join(fallbackDir, `.yaw-mcp-upgrade-attempt-${process.getuid?.() ?? "win"}-${scope}.json`);
}

// The four defaults below short-circuit under vitest for the same reason
// defaultAcquireLock does: no unit test may write a memo into a real tmpdir or
// global prefix, and none may inherit one left by an earlier test in the run.
// Tests that mean to exercise the wiring inject the hooks instead.
function defaultCheckedRecently(): CachedCheck | null {
  if (process.env.VITEST) return null;
  return readCheckMemo(checkMemoPath());
}

function defaultRecordCheck(latest: string | null): void {
  if (process.env.VITEST) return;
  writeCheckMemo(checkMemoPath(), latest);
}

function defaultAttemptedRecently(dir: string, lockName: string, version: string): boolean {
  if (process.env.VITEST) return false;
  return attemptedRecentlyAt(dir, lockName, version);
}

function defaultRecordAttempt(dir: string, lockName: string, version: string): void {
  if (process.env.VITEST) return;
  recordAttemptAt(dir, lockName, version);
}

/** The memo logic behind the two defaults, exported for tests: the in-prefix
 *  memo is authoritative when present; the fallback under `fallbackDir`
 *  (the real tmpdir in production; a sandbox in tests, which must never
 *  write into the machine's temp dir) answers when the prefix was
 *  unwritable (see attemptMemoFallbackPath). */
export function attemptedRecentlyAt(dir: string, lockName: string, version: string, fallbackDir = tmpdir()): boolean {
  const recent = (read: ReturnType<typeof readMemo>): boolean =>
    read !== null && read.memo.version === version && read.ageMs < UPGRADE_ATTEMPT_COOLDOWN_MS;
  if (recent(readMemo(attemptMemoPath(dir, lockName)))) return true;
  return recent(readMemo(attemptMemoFallbackPath(dir, lockName, fallbackDir)));
}

export function recordAttemptAt(dir: string, lockName: string, version: string, fallbackDir = tmpdir()): void {
  // writeMemo swallows every failure, so probe the prefix write ourselves:
  // the fallback is written only when the prefix memo did not land, keeping
  // the in-prefix file the source of truth wherever it CAN exist.
  const primary = attemptMemoPath(dir, lockName);
  try {
    writeFileSync(primary, `${JSON.stringify({ at: Date.now(), version })}\n`);
    return;
  } catch {
    // Read-only prefix (EACCES/EPERM/EROFS): fall through to the fallback dir.
  }
  writeMemo(attemptMemoFallbackPath(dir, lockName, fallbackDir), { version });
}

export interface AutoUpgradeDeps {
  /** Test hook: override the current version (defaults to __VERSION__). */
  currentVersion?: string;
  /** Test hook: override the argv path used for install-method detection. */
  argvPath?: string;
  /** Test hook: replace the npm registry fetch. */
  fetchLatestImpl?: () => Promise<string | null>;
  /** Test hook: replace the background npm spawn. `onDone` releases the
   *  upgrade lock and MUST be called once the install has finished (or
   *  failed); defaultSpawn wires it to the child's close/error handlers. */
  spawnImpl?: (cmd: string, args: string[], onDone?: () => void) => void;
  /** Test hook: replace the prefix lockfile that serializes concurrent
   *  background installs. Called with the directory to lock and the lockfile
   *  name (the tmpdir fallback scopes that name by tool + uid). Returning null
   *  means "someone else holds it". */
  acquireLockImpl?: (dir: string, lockName: string) => (() => void) | null;
  /** Test hook: replace the `npm prefix -g` probe behind the multi-prefix
   *  warning. Needed in tests because the shared probe short-circuits to null
   *  under VITEST so no unit test ever spawns a real npm. */
  npmPrefixImpl?: () => Promise<string | null>;
  /** Test hook: force single-executable (SEA binary) detection. */
  isSeaImpl?: () => boolean | Promise<boolean>;
  /** Test hook: replace the "a registry check already ran recently" memo. A
   *  non-null answer is the CACHED registry result and skips the fetch; null
   *  means "no fresh check, go ask". Needed in tests because the default
   *  short-circuits to null under VITEST. */
  checkedRecentlyImpl?: () => CachedCheck | null;
  /** Test hook: replace the recorder for a completed registry check. Receives
   *  the answer the fetch produced (null for an unreachable registry). */
  recordCheckImpl?: (latest: string | null) => void;
  /** Test hook: replace the "this exact upgrade was already attempted" memo. */
  attemptedRecentlyImpl?: (dir: string, lockName: string, version: string) => boolean;
  /** Test hook: replace the recorder for a background upgrade attempt. */
  recordAttemptImpl?: (dir: string, lockName: string, version: string) => void;
}

function defaultSpawn(cmd: string, args: string[], onDone: () => void = () => {}): void {
  // Track whether the error handler already fired so the close handler
  // stays silent after it -- both handlers fire for ENOENT, but the
  // error handler has the right message and fires first.
  let errorFired = false;
  // Release the upgrade lock exactly once, whichever handler gets there
  // first. Both fire for ENOENT, and a double release would unlink a lock a
  // DIFFERENT process had since taken.
  let released = false;
  const finish = (): void => {
    if (released) return;
    released = true;
    onDone();
  };

  // The corrective command the user should run for their tool comes from the
  // same whitelist table the spawn argv did (upgrade-cmd's UPGRADE_COMMANDS),
  // keyed by tool because that is all this function is handed. Null only for
  // a tool the table does not know, which maybeAutoUpgrade never passes.
  const correctiveCmd = globalUpgradeCommandLineForTool(cmd);

  const child = spawn(cmd, args, {
    stdio: "ignore",
    // yaw-mcp's own secrets stay out of the install. npm runs every
    // dependency's pre/postinstall with this env, and README tells the user to
    // put YAW_MCP_VAULT_PASSPHRASE in yaw-mcp's env block precisely because
    // "yaw-mcp strips its own secrets from every child env" -- a promise the
    // upstream spawn kept and this one, spawning with the full inherited
    // process.env, silently did not: a compromised transitive dependency's
    // install script plus ~/.yaw-mcp/secrets.json was the whole vault.
    env: stripInternalSecretsFromEnv(process.env),
    // Not detached, so the install shares yaw-mcp's process group and an MCP
    // client that tears down the whole tree takes it with it. Two things this
    // does NOT buy (the file header lists both as known gaps): on POSIX a
    // plain parent exit does not kill it, and if it IS killed mid-install the
    // result is not guaranteed intact -- npm reify removes the existing
    // package dir before moving the new one in, and nothing here repairs a
    // partial install on the next startup.
    detached: false,
    shell: process.platform === "win32",
  });
  child.on("close", (code) => {
    finish();
    if (errorFired) return; // error handler already logged; stay silent here.
    if (code === 0) {
      log("info", "yaw-mcp self-upgrade complete; the next client restart will run the new version");
    } else {
      // stdio is "ignore" so we can't surface the underlying tool error.
      // The common cause for npm is a non-user-writable global prefix
      // (yaw-mcp was installed with sudo); pnpm/bun have analogous issues.
      // Only npm gets the EACCES/sudo hint -- pnpm and bun manage their own
      // permissions and the sudo suggestion doesn't apply to them.
      const hint = cmd === "npm" ? " (often EACCES on a sudo-installed global -- run with the right permissions)" : "";
      const manual = correctiveCmd === null ? "Set" : `Run \`${correctiveCmd}\` manually, or set`;
      log(
        "warn",
        `yaw-mcp self-upgrade: ${cmd} exited non-zero${hint}. ${manual} YAW_MCP_AUTO_UPGRADE=0 to silence this.`,
        { code },
      );
    }
  });
  child.on("error", (err: Error) => {
    errorFired = true;
    finish();
    log("warn", `yaw-mcp self-upgrade: ${cmd} spawn failed`, { error: err?.message });
  });
}

/** Fire-and-forget startup self-upgrade check. Resolves once the check
 *  completes; callers must NOT await it on the serve hot path. */
export async function maybeAutoUpgrade(deps: AutoUpgradeDeps = {}): Promise<void> {
  // Opt-out escape hatch -- checked before everything else so pinned-
  // version users / sudo-installed globals can suppress with one env var.
  const optOut = process.env.YAW_MCP_AUTO_UPGRADE;
  if (optOut === "0" || optOut?.toLowerCase() === "false") return;

  const current = deps.currentVersion ?? (typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev");
  // An unbuilt checkout has no real version to compare; never touch it.
  if (current === "dev") return;

  const argvPath = deps.argvPath ?? process.argv[1];
  // NOTE: maybeAutoUpgrade deliberately uses detectInstallMethod's fast,
  // synchronous path-pattern heuristic rather than the async
  // refineInstallMethod (which runs `npm prefix -g` -- a ~3s npm
  // subprocess -- to distinguish a real global-npm install from a local
  // node_modules install that happens to share a path prefix). The serve
  // hot path must not block on a 3s probe at startup. Consequence: a
  // custom-prefix global install whose argv[1] pattern doesn't match
  // the default npm prefix heuristic -- and whose realpath doesn't either --
  // is classified as "local-node-modules" (or "unknown") and silently skipped;
  // no background upgrade fires for it even when stale. Users in that setup
  // should run `yaw-mcp upgrade --run` manually, or set the standard npm
  // global prefix.
  //
  // `local-node-modules` joins `unknown` in the realpath second chance (the
  // CLI resolves `unknown` only -- see detectInstallMethod's docblock for why
  // the literal answer is otherwise never second-guessed). It IS a literal
  // answer, so a `node_modules/@yawlabs/mcp` that is a symlink into a global
  // prefix -- `npm link`, a bin shim staged into a project tree -- would keep
  // the local classification and never background-upgrade, even though the
  // bytes actually running belong to the global install. Filesystem-only, so
  // the ~3s objection above does not apply, and it degrades safely in both
  // directions: an `npm link`ed checkout resolves to `dev-checkout` and a
  // project-local shim back to `local-node-modules`, and neither spawns.
  const method = (deps.isSeaImpl ? await deps.isSeaImpl() : await detectSea())
    ? "binary"
    : detectInstallMethod(argvPath, realpathSync, ["unknown", "local-node-modules"]);

  // Throttle the registry probe itself. The lock below is acquired well AFTER
  // the fetch, so it never covered it: without this, every serve start hits
  // registry.npmjs.org. A fresh memo carries the ANSWER, so a repeated start
  // (of this copy, or of any other install on the machine) evaluates its own
  // staleness from the cache instead of skipping the evaluation altogether --
  // see the file header on how a timestamp-only memo starved global-npm copies.
  const cached = (deps.checkedRecentlyImpl ?? defaultCheckedRecently)();
  let latest: string | null;
  if (cached !== null) {
    latest = cached.latest;
  } else {
    latest = await (deps.fetchLatestImpl ?? fetchLatestVersion)();
    // Record the check whichever way it went. An offline machine answers null
    // on every attempt, and re-probing an unreachable registry on each start
    // is the same waste this memo exists to stop.
    (deps.recordCheckImpl ?? defaultRecordCheck)(latest);
  }
  // Offline / registry unreachable / malformed response -- no-op.
  if (latest === null) return;

  const plan = buildUpgradePlan({ current, latest, method });
  if (!plan.stale) return;

  // Global installs self-upgrade with their OWNING tool -- same whitelist
  // as `upgrade --run` (exactly our package, fixed args).
  //
  // For npm specifically, we resolve the prefix from the RUNNING install
  // (argv[1] -> walk up to node_modules parent) and pass it explicitly
  // via `--prefix <dir>` so the upgrade lands in the same tree the
  // client just spawned us from -- not whatever `npm prefix -g` reports.
  // The two can drift (nvm, multiple Node versions, custom prefixes, the
  // bundled-Node Yaw Terminal ships), in which case installing into
  // npm's reported prefix is a no-op for the running copy.
  const rawPrefix = method === "global-npm" ? detectRunningInstallPrefix(argvPath) : null;
  // The npm spawn below runs with `shell: true` on win32 (npm is npm.cmd and
  // Node refuses to spawn a .cmd without a shell). With a shell, argv is
  // joined on spaces and NOT quoted -- so an unquoted prefix containing a
  // space was split into two tokens:
  //   passed:   C:\Users\Jeff Smith\AppData\Roaming\npm
  //   npm saw:  --prefix C:\Users\Jeff   +   a stray positional
  // npm then installs into the wrong tree, leaving the running copy stale --
  // exactly the silent no-op `--prefix` exists to prevent. This is not exotic:
  // C:\Users\<First Last>\AppData\Roaming\npm is npm's DEFAULT Windows global
  // prefix, so any account with a space in its name hit it on every stale
  // startup. Quote for the shell we actually invoke.
  const quotedPrefix = rawPrefix === null ? null : quoteShellArgIfNeeded(rawPrefix);
  // One whitelist for every spawn surface (upgrade-cmd's UPGRADE_COMMANDS):
  // `--prefix` is inserted only for global-npm, and only when the prefix
  // survived quoting -- a null quotedPrefix drops the flag rather than emit a
  // mangled command line, and pnpm/bun never get one (rawPrefix is null there).
  const globalSpec = GLOBAL_UPGRADE_METHODS.includes(method) ? upgradeSpawnSpec(method, quotedPrefix) : null;
  if (globalSpec) {
    // Serialize concurrent background installs into one prefix. N MCP clients
    // starting at once each reach this line with the same verdict; without the
    // lock they each fire `npm install -g` at the same tree. Losing the race
    // is not a failure -- the winner's install is the one this process would
    // have run, and the next client restart picks it up either way.
    //
    // The lock lives in the prefix being written to, so two processes contend
    // only when they would actually collide. pnpm/bun have no detected prefix
    // (that walk is global-npm only), so they fall back to the temp dir -- and
    // there the NAME has to carry the scope the directory no longer does. With
    // one fixed name, pnpm, bun and a prefix-less global npm all contended on a
    // single `${tmpdir()}/.yaw-mcp-upgrade.lock`, and on a shared POSIX box
    // another user's lock could be neither taken nor stolen. Tool + uid in the
    // filename restores "one lock per tool family per user".
    const lockDir = rawPrefix ?? tmpdir();
    const lockName =
      rawPrefix === null ? `.yaw-mcp-upgrade-${globalSpec.cmd}-${process.getuid?.() ?? "win"}.lock` : UPGRADE_LOCK_NAME;
    // A permanently failing upgrade (EACCES on a sudo-installed global is the
    // classic) fails again on every start, so re-spawning a full install each
    // time buys nothing. Checked BEFORE the lock -- taking a lock for work we
    // are not going to do would make every other pane skip for nothing.
    if ((deps.attemptedRecentlyImpl ?? defaultAttemptedRecently)(lockDir, lockName, latest)) {
      log("info", "yaw-mcp self-upgrade: this upgrade was already attempted recently; not retrying yet", {
        current,
        latest,
        tool: globalSpec.cmd,
        lockDir,
      });
      return;
    }
    const releaseLock = (deps.acquireLockImpl ?? defaultAcquireLock)(lockDir, lockName);
    if (releaseLock === null) {
      log("info", "yaw-mcp self-upgrade: another process is already upgrading this install; skipping this one", {
        current,
        latest,
        tool: globalSpec.cmd,
        lockDir,
      });
      return;
    }
    log("info", "yaw-mcp is out of date; upgrading the global install in the background", {
      current,
      latest,
      tool: globalSpec.cmd,
      // The RAW prefix, not the shell-quoted argv form -- a log field is read
      // by a human, and stray quotes read as part of the path. Omitted when
      // quoting failed, because then no `--prefix` was passed at all and npm
      // resolves its own prefix.
      prefix: quotedPrefix === null ? undefined : (rawPrefix ?? undefined),
    });
    // If we have a detected prefix AND can cheaply discover npm's
    // configured global prefix, warn when they differ -- the user
    // likely has a multi-prefix setup and may be confused why one
    // copy updates while another stays stale. Best-effort, async,
    // never blocks the upgrade itself. Gated on quotedPrefix because the
    // warning claims we install into the running prefix, which is only true
    // when the `--prefix` flag actually survived quoting.
    if (method === "global-npm" && rawPrefix !== null && quotedPrefix !== null) {
      // Fire-and-forget WITH a rejection sink. The default probe never
      // rejects, but an injected npmPrefixImpl (or a future comparablePath
      // that throws) would otherwise become an unhandled rejection inside
      // serve, which Node terminates the process on.
      compareWithNpmPrefix(rawPrefix, deps.npmPrefixImpl).catch(() => {});
    }
    // Record the attempt BEFORE the spawn, not after it settles: the failure
    // this memo exists for (a torn-down process tree, a synchronous throw) is
    // exactly the one that never reaches a completion handler.
    (deps.recordAttemptImpl ?? defaultRecordAttempt)(lockDir, lockName, latest);
    try {
      (deps.spawnImpl ?? defaultSpawn)(globalSpec.cmd, globalSpec.args, releaseLock);
    } catch (err) {
      // A synchronous spawn throw would otherwise leave the lock held for the
      // full stale window, suppressing the next N startups' upgrade for a
      // failure that already happened.
      releaseLock();
      log("warn", `yaw-mcp self-upgrade: could not start ${globalSpec.cmd}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (method === "bundled-app") {
    // The copy Yaw Terminal ships in its resources -- only an app update
    // can refresh it, so there is nothing to spawn and nothing to ask of
    // the user beyond keeping the app current.
    log("info", "yaw-mcp (bundled with Yaw Terminal) is behind npm; it updates with the app", { current, latest });
    return;
  }

  if (method === "binary") {
    // A standalone binary has no package manager to self-upgrade -- and the
    // binary track was retired in 0.70.3, so the only way forward is the
    // npm install. Nothing safe to spawn; log it and move on.
    log(
      "info",
      "yaw-mcp (standalone binary) is behind npm; the binary track was retired -- npm install -g @yawlabs/mcp@latest, then delete the old executable",
      { current, latest },
    );
    return;
  }

  // npx / local-node-modules / dev-checkout / unknown: nothing safe to
  // spawn from here. Log a one-liner so a stale install is at least visible.
  if (method === "npx") {
    // For npx the `@latest` client config (written by `yaw-mcp install`)
    // makes the next restart fetch the newest version, so a restart fixes it.
    log("info", "yaw-mcp is out of date; restart your MCP client to pick up the latest version", {
      current,
      latest,
      method,
    });
  } else if (method === "local-node-modules") {
    // A restart re-runs the SAME version the project's node_modules pins, so
    // it won't pick up the new one. `upgrade --run` DOES work here: it runs
    // `npm install @yawlabs/mcp@latest` in the tree root (upgrade-cmd's
    // local-node-modules runSpec), so advertise it.
    log(
      "info",
      "yaw-mcp is out of date; run `yaw-mcp upgrade --run` to update this install (a restart re-runs the version pinned in your project's node_modules)",
      {
        current,
        latest,
        method,
      },
    );
  } else {
    // dev-checkout / unknown: a restart re-runs the same stale install, and
    // `upgrade --run` CANNOT fix it -- upgrade-cmd leaves runSpec null for both
    // methods and exits 2 with "can't be upgraded automatically" (the 1->2
    // scripting trap its header documents). Advertising `--run` here sent users
    // to a command that always refuses, so point at plain `upgrade`, which
    // prints the command for their install and exits 1.
    log(
      "info",
      "yaw-mcp is out of date; run `yaw-mcp upgrade` for the command that updates this install (`--run` can't automate this install method)",
      {
        current,
        latest,
        method,
      },
    );
  }
}
