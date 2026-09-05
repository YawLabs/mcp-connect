// Shadow-driven install nudge — the gate + per-CLI suppression cadence for
// discover's opt-in "Install candidates" block.
//
// What it does: when the gate is ON, discover runs the existing offline
// shell-history shadow scan (doctor-cmd.ts scanShellHistoryForShadows) and,
// for any heavily-used CLI that has a first-party install target but no
// matching MCP server installed, appends a one-line "install <package>"
// nudge. This module owns ONLY the policy: is the feature enabled, does a
// given CLI clear the usage threshold + cooldown, and recording that we
// nudged a CLI so we don't repeat within the cooldown.
//
// Privacy (load-bearing): this module never reads, stores, or emits any raw
// shell-history line. The only state it persists is { cli, nudgedAt } — a
// CLI binary NAME (a fixed identifier from SHADOW_INSTALL_TARGETS, not user
// input) plus a timestamp. No command text, no arguments, nothing about
// what the user ran beyond the aggregate count the caller already computed.
//
// Off by default: the gate (installNudgeEnabled) is the single chokepoint.
// When it returns false the caller must NOT run the scan, so discover output
// is byte-identical to today and nothing about shell history is even read.
//
// Fail-open on IO: a missing / unreadable / corrupt state file is treated as
// "never nudged" (shouldNudge returns true); a write failure is swallowed.
// The worst case is nudging the same CLI twice — never a thrown error and
// never a blocked discover. Synchronous fs is used deliberately: the call
// site (buildDiscoverOutputImpl) is synchronous, and the file is tiny.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./logger.js";
import { CONFIG_DIRNAME } from "./paths.js";

/** Minimum ShadowHit.count (over the tail-500 history window scanned by
 *  scanShellHistoryForShadows) before a CLI is eligible for a nudge. A CLI
 *  run fewer times than this is noise, not a workflow. */
export const INSTALL_NUDGE_MIN_COUNT = 5;

/** Don't re-nudge the same CLI within this window. Mirrors auto-upgrade's
 *  "act once, then stay quiet" cadence — a user who saw the nudge and chose
 *  not to install shouldn't be pestered on every discover for a week. */
export const INSTALL_NUDGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export const INSTALL_NUDGE_STATE_FILENAME = "install-nudge-state.json";

interface NudgeRecord {
  /** CLI binary name (e.g. "tailscale"). */
  cli: string;
  /** Epoch ms when we last surfaced this CLI's nudge. */
  nudgedAt: number;
}

interface NudgeState {
  nudges: NudgeRecord[];
}

/** Absolute path to the suppression-state file inside `~/.yaw-mcp/`. */
export function installNudgeStatePath(home: string): string {
  return join(home, CONFIG_DIRNAME, INSTALL_NUDGE_STATE_FILENAME);
}

/** The gate. The shadow scan runs ONLY when this returns true; off by
 *  default. Enabled by either the env override (YAW_MCP_INSTALL_NUDGE=1) or
 *  the resolved config flag (installNudge: true). Env and config are
 *  independent — either one flips it on. Only a literal "1" enables via env
 *  so a stray empty/other value can't accidentally turn it on. */
export function installNudgeEnabled(env: NodeJS.ProcessEnv, config: { installNudge?: boolean } | null): boolean {
  if (env.YAW_MCP_INSTALL_NUDGE === "1") return true;
  if (config?.installNudge === true) return true;
  return false;
}

/** Last parse of the state file, keyed by identity (path + mtime + size).
 *
 *  WHY: one discover surfaces N install candidates, and server.ts
 *  (buildInstallCandidatesLines) calls shouldNudge once per candidate in its
 *  filter loop -- N reads of the same tiny file per discover -- before it
 *  records the survivors with ONE recordNudges call. The parse is memoized on
 *  the file's identity rather than on a TTL, so an edit from any process (or
 *  from recordNudges, which refreshes the memo itself) is picked up on the
 *  very next call: a changed file has a different mtime or size. Only a
 *  same-millisecond, same-byte-length external rewrite can be missed, and
 *  this module is fail-open by design -- the worst case there is one extra
 *  nudge, exactly like a lost write.
 *
 *  The write side is `recordNudges`, which lands a whole discover's
 *  candidates in that one read-modify-write; `recordNudge` is its single-CLI
 *  spelling, kept as the convenience the tests drive it through. */
let stateMemo: { path: string; mtimeMs: number; size: number; state: NudgeState } | null = null;

/** Read + parse the suppression state. Fail-open: any absent / unreadable /
 *  malformed file yields an empty state so every CLI reads as "never
 *  nudged". Never throws. */
function readState(home: string): NudgeState {
  const path = installNudgeStatePath(home);
  if (!existsSync(path)) {
    if (stateMemo?.path === path) stateMemo = null;
    return { nudges: [] };
  }
  try {
    const st = statSync(path);
    if (stateMemo && stateMemo.path === path && stateMemo.mtimeMs === st.mtimeMs && stateMemo.size === st.size) {
      return stateMemo.state;
    }
    // Memoize the PARSED result, including a degenerate one: a corrupt file
    // reads as empty on every call anyway, so re-parsing it per candidate
    // buys nothing.
    const remember = (state: NudgeState): NudgeState => {
      stateMemo = { path, mtimeMs: st.mtimeMs, size: st.size, state };
      return state;
    };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return remember({ nudges: [] });
    const raw = (parsed as { nudges?: unknown }).nudges;
    if (!Array.isArray(raw)) return remember({ nudges: [] });
    const nudges: NudgeRecord[] = [];
    for (const entry of raw) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as NudgeRecord).cli === "string" &&
        typeof (entry as NudgeRecord).nudgedAt === "number"
      ) {
        nudges.push({ cli: (entry as NudgeRecord).cli, nudgedAt: (entry as NudgeRecord).nudgedAt });
      }
    }
    return remember({ nudges });
  } catch {
    // A stat/read/parse throw leaves the memo untouched rather than caching a
    // failure: the next call re-probes, which is what fail-open wants.
    return { nudges: [] };
  }
}

/** Clamp a persisted timestamp to "no later than now".
 *
 *  A nudgedAt in the FUTURE is not hypothetical: a laptop that syncs its
 *  clock backwards (or a file copied from a machine ahead of this one) leaves
 *  one behind. Unclamped it poisons both halves of the cadence -- shouldNudge
 *  computes a NEGATIVE age, which never reaches the cooldown, so the CLI is
 *  suppressed until wall-clock time catches up; and recordNudge's prune keeps
 *  the entry for exactly the same reason, so it never ages out of the file.
 *  Clamping degrades it to "just nudged", which expires normally one cooldown
 *  from now. */
function clampToNow(nudgedAt: number, now: number): number {
  return nudgedAt > now ? now : nudgedAt;
}

/** True iff `cli` may be nudged now: either never nudged, or last nudged
 *  longer ago than the cooldown. Fail-open — a read error reads as "never
 *  nudged", so the user still sees the candidate. `now` is injectable for
 *  tests; defaults to Date.now(). */
export function shouldNudge(cli: string, home: string, now: () => number = Date.now): boolean {
  const state = readState(home);
  const rec = state.nudges.find((n) => n.cli === cli);
  if (!rec) return true;
  const at = now();
  return at - clampToNow(rec.nudgedAt, at) >= INSTALL_NUDGE_COOLDOWN_MS;
}

/** Record that `cli` was just nudged so it's suppressed for the cooldown.
 *  The one-CLI spelling of `recordNudges` -- see there for the semantics.
 *  Nothing in server.ts calls it (discover records its whole candidate set
 *  through the batch form); it stays as the convenience the tests use, and
 *  for any caller with exactly one CLI to record. A caller with several CLIs
 *  from one discover should pass them together rather than loop, so the
 *  whole set costs a single write. */
export function recordNudge(cli: string, home: string, now: () => number = Date.now): void {
  recordNudges([cli], home, now);
}

/** Record that every CLI in `clis` was just nudged, in ONE read-modify-write,
 *  so each is suppressed for the cooldown. A discover surfaces its candidates
 *  as a set, so this is the shape the call site wants, and it is what
 *  buildInstallCandidatesLines in server.ts calls -- once per discover, with
 *  every surviving candidate. Looping recordNudge per candidate instead
 *  re-read and rewrote the whole state file once per CLI and landed every
 *  record with a slightly different timestamp for what was one event.
 *
 *  Prior timestamps for the named CLIs are replaced, a repeated name in `clis`
 *  collapses to one record, and stale entries past the cooldown are pruned on
 *  write to bound file growth. An empty batch writes nothing at all.
 *  Fail-open: a write/mkdir failure is logged at debug and swallowed — the
 *  cost is a possible repeat nudge, never a thrown error. `now` is
 *  injectable for tests. */
export function recordNudges(clis: string[], home: string, now: () => number = Date.now): void {
  // Nothing to record: leave the file (and its absence) exactly as it is
  // rather than rewriting it just to prune.
  if (clis.length === 0) return;
  const recorded = new Set(clis);
  try {
    const at = now();
    const state = readState(home);
    // Drop the existing record for every cli in this batch, plus any entry
    // whose cooldown has fully lapsed (those would read as "never nudged"
    // anyway, so keeping them just grows the file). Every surviving entry is
    // REWRITTEN with its timestamp clamped to now, so a future-dated record
    // (see clampToNow) is normalised on the next write instead of sitting in
    // the file forever suppressing its CLI.
    const kept = state.nudges
      .filter((n) => !recorded.has(n.cli) && at - clampToNow(n.nudgedAt, at) < INSTALL_NUDGE_COOLDOWN_MS)
      .map((n) => ({ cli: n.cli, nudgedAt: clampToNow(n.nudgedAt, at) }));
    // Iterating the SET, not the argument: two candidates naming the same CLI
    // are one nudge, and a duplicated record would make the file grow by one
    // entry per repeat.
    for (const cli of recorded) kept.push({ cli, nudgedAt: at });
    const path = installNudgeStatePath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ nudges: kept }, null, 2)}\n`, "utf8");
    // Refresh the read memo from what we just wrote, so later shouldNudge
    // calls in this process (the next discover's filter loop) neither re-read
    // the file nor observe a stale parse.
    try {
      const st = statSync(path);
      stateMemo = { path, mtimeMs: st.mtimeMs, size: st.size, state: { nudges: kept } };
    } catch {
      // Could not confirm the written file's identity -- drop the memo so the
      // next read goes back to disk rather than trusting an unverified entry.
      stateMemo = null;
    }
  } catch (err) {
    // Best-effort suppression — losing a write just risks one extra nudge.
    // The whole batch is lost together, so the line names every CLI in it
    // rather than the first (a single-CLI call reads exactly as it used to).
    log("debug", "install-nudge: failed to record nudge state", {
      cli: [...recorded].join(", "),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
