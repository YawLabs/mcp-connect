// Compliance grade cache -- ~/.yaw-mcp/grades.json.
//
// `yaw-mcp audit <namespace>` runs the @yawlabs/mcp-compliance suite against a
// server's stdio spawn config and writes its grade here. `yaw-mcp list`
// (local-add-cmd.ts runList) and the broker's hydrateComplianceGrades
// (server.ts -- the view the Yaw Terminal MCP panel sees) merge a server's
// cached grade into its row so the user sees an up-to-date letter grade
// without re-running the suite on every list.
//
// Shape (keyed by namespace):
//   {
//     "ctxlint": { "grade": "A", "score": 97.7, "gradedAt": "2026-06-11T..." }
//   }
//
// This file is purely a local cache. It is safe to delete; the next `audit`
// run repopulates it. We never fail a list/read on a malformed cache -- a
// garbage grades.json is treated as "no cached grades" and ignored.

import { type FileHandle, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicWriteFile } from "./atomic-write.js";
import { setJsonKey } from "./json-key.js";
import { parseJsonc } from "./jsonc.js";
import { log } from "./logger.js";
import { userConfigDir } from "./paths.js";

/** Canonical filename for the grade cache. */
export const GRADES_FILENAME = "grades.json";

/** One cached grade entry. `grade` is the A-F letter; `score` is the 0-100
 *  percentage; `gradedAt` is an ISO-8601 timestamp of when the audit ran.
 *  `suiteVersion` is the compliance rubric that produced the letter -- the
 *  @yawlabs/mcp-compliance PACKAGE version (e.g. "0.17.1"; rubric changes ship
 *  as package releases, whereas the package's exported SPEC_VERSION is the MCP
 *  protocol revision date, identical across releases -- see
 *  resolveComplianceSuiteVersion in audit-cmd.ts). Optional because entries
 *  written before it existed carry only the timestamp. Without it two rubrics'
 *  letters are indistinguishable in `list`, so a pre-rubric-change "A" reads
 *  as current. */
export interface CachedGrade {
  grade: "A" | "B" | "C" | "D" | "F";
  score: number;
  gradedAt: string;
  suiteVersion?: string;
}

/** The on-disk shape: a map of namespace -> cached grade. */
export type GradesCache = Record<string, CachedGrade>;

const GRADE_LETTERS = new Set(["A", "B", "C", "D", "F"]);

/** Absolute path to grades.json inside the user-global ~/.yaw-mcp/ dir. The
 *  cache is always user-global -- a grade describes how a server BINARY scored,
 *  not a per-project preference, so there's no project-local variant. */
export function gradesCachePath(home: string = homedir()): string {
  return join(userConfigDir(home), GRADES_FILENAME);
}

/** Valid range for a cached score, matching the compliance suite's 0-100
 *  percentage. Range-validated for the same reason the letter is checked
 *  against GRADE_LETTERS: an out-of-range score (-5, 1e9) is a corrupt or
 *  hand-edited entry, and rendering it in the `list` row or the Yaw
 *  Terminal MCP panel would show a nonsense grade rather than falling back
 *  to "no cached grade". */
const MIN_SCORE = 0;
const MAX_SCORE = 100;

/** Coerce a raw parsed entry into a CachedGrade, or null if malformed. A
 *  single bad entry is dropped rather than discarding the whole cache. */
function validateEntry(entry: unknown): CachedGrade | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  const grade = typeof e.grade === "string" ? e.grade.toUpperCase() : "";
  if (!GRADE_LETTERS.has(grade)) return null;
  const score = typeof e.score === "number" && Number.isFinite(e.score) ? e.score : null;
  if (score === null) return null;
  if (score < MIN_SCORE || score > MAX_SCORE) return null;
  const gradedAt = typeof e.gradedAt === "string" && e.gradedAt.length > 0 ? e.gradedAt : "";
  if (!gradedAt) return null;
  // Optional: entries from before suiteVersion existed stay valid without it;
  // a malformed value is dropped from the entry rather than dropping the entry.
  const suiteVersion = typeof e.suiteVersion === "string" && e.suiteVersion.length > 0 ? e.suiteVersion : undefined;
  return suiteVersion
    ? { grade: grade as CachedGrade["grade"], score, gradedAt, suiteVersion }
    : { grade: grade as CachedGrade["grade"], score, gradedAt };
}

/** Read the grade cache. Returns an empty object when the file is absent or
 *  malformed -- never throws, so a list command degrades to "no cached grades"
 *  instead of crashing on a hand-edited file. */
export async function readGradesCache(home: string = homedir()): Promise<GradesCache> {
  return readGradesCacheImpl(home, { strictRead: false });
}

/** strictRead: true is the WRITE path's posture. writeGrade's
 *  read-modify-write must not treat a transient read failure (EACCES,
 *  EBUSY from a win32 AV/indexer handle -- the same class atomic-write.ts
 *  retries renames for, EISDIR) as "no cache": doing so published a
 *  one-entry file and silently destroyed every other cached grade,
 *  contradicting writeGrade's own "preserving every other entry" doc.
 *  Rethrowing instead lands in audit-cmd's writeGrade catch, which
 *  reports grade-computed-but-cache-write-failed as exit 3. Only
 *  ENOENT/ENOTDIR mean "no cache yet" (same split as config-loader).
 *  A file that reads but does not PARSE -- or parses to something that is
 *  not a namespace -> grade object -- still yields {} on both paths:
 *  replacing a malformed cache with a rebuilt one is fine -- it is
 *  disposable derived data, and both of those cases log a warning on the
 *  way out, so the rebuild is never the user's only clue. */
async function readGradesCacheImpl(home: string, opts: { strictRead: boolean }): Promise<GradesCache> {
  const path = gradesCachePath(home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (opts.strictRead && code !== "ENOENT" && code !== "ENOTDIR") throw err;
    return {};
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    log("warn", "grades.json is not valid JSON; ignoring", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
  // Warned about, not dropped in silence: a root that PARSES but is not a
  // namespace->grade map (an array, a bare number, `null`) is exactly as
  // corrupt as invalid JSON, and it is the same user staring at a `list`
  // table with no grades in it. Saying nothing here while the parse failure
  // above logs meant the identical symptom had a diagnostic in one case and
  // nothing at all in the other. Both then rebuild the file on the next audit
  // (see the strictRead note above), so the warning is the only trace.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log("warn", "grades.json is not a JSON object of namespace -> grade; ignoring", {
      path,
      rootType: Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed,
    });
    return {};
  }
  const out: GradesCache = {};
  for (const [ns, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const validated = validateEntry(entry);
    // setJsonKey, not out[ns]: ns comes straight from the parsed cache file,
    // and plain assignment to "__proto__" would drop the grade AND repoint
    // `out`'s prototype at it.
    if (validated) setJsonKey(out, ns, validated);
  }
  return out;
}

// --- cross-process lock ------------------------------------------------------
//
// Every production writeGrade runs in its own one-shot `yaw-mcp audit`
// process (audit-cmd.ts is its only caller, and index.ts runs one audit per
// process), so the writers that collide on grades.json are PROCESSES: the Yaw
// Terminal MCP panel grading two servers at once, or two terminals. An
// in-process promise chain -- what this file used to carry -- serialized the
// one case that never happens in production and left the real one open: both
// audits loaded the pre-write snapshot, both atomic renames landed, and
// whichever landed second silently dropped the other's grade. Both printed
// "Cached to ...", and `list` showed no letter for the loser until it was
// re-audited.
//
// The serializer is therefore a SIDECAR LOCK FILE beside grades.json, taken
// with `wx` (O_EXCL), which is atomic on POSIX and Windows: two processes
// racing it cannot both win. Same primitive as auto-upgrade.ts's install lock,
// with the same three rules that lock learned the hard way:
//
//   - The holder is not guaranteed to release (an MCP client can tear the
//     process tree down mid-audit), so a lock older than GRADES_LOCK_STALE_MS
//     is treated as abandoned. The critical section is one read, one
//     stringify and one atomic write -- milliseconds, tens of them on a
//     Windows rename retry -- so ten seconds is three orders of magnitude past
//     any live holder.
//   - A stale lock is stolen by RENAME, never unlink. Two stealers that both
//     unlink cannot tell "I removed the stale file" from "I removed the lock
//     the other stealer just took", and end up inside the critical section
//     together; only one rename of the inode can succeed.
//   - Release is ownership-checked. The lock carries a token this call wrote,
//     and release unlinks only while that token is still there -- otherwise a
//     lock that went stale and was retaken would be pulled out from under its
//     new holder.
//
// A writer waits GRADES_LOCK_WAIT_MS on a LIVE lock before giving up, and the
// wait is deliberately longer than the stale age so a writer arriving right
// after a holder crashed always outlives the lock instead of failing on it.
// Giving up throws, which audit-cmd reports as grade-computed-but-not-cached
// (exit 3): the honest outcome, and one re-audit repairs it. A release that
// fails (a Windows AV handle on the lock file) leaves it to go stale, so the
// worst case for the NEXT writer is one stale-age wait, still inside its
// budget. In-process concurrency rides the same lock -- the second caller
// simply polls until the first releases -- so there is exactly one mechanism
// and one set of rules to reason about.

/** Sidecar beside grades.json: `<path>.lock`. */
const GRADES_LOCK_SUFFIX = ".lock";
/** Age past which a lock is abandoned, not held. See the header above. */
const GRADES_LOCK_STALE_MS = 10_000;
/** How long a writer waits on a LIVE lock. Longer than the stale age on
 *  purpose, so waiting out a crashed holder always fits inside it. */
const GRADES_LOCK_WAIT_MS = 15_000;
const GRADES_LOCK_POLL_MS = 25;
/** How far ahead of Date.now() a lock's mtime may sit and still count as
 *  "taken just now": filesystem timestamp granularity routinely reports an
 *  mtime a hair ahead of the clock, and without the margin a lock taken
 *  microseconds ago reads as future-dated and is stolen at once. Anything
 *  further ahead is a stepped clock, and a lock no live process on this clock
 *  could have written is stale too. */
const GRADES_LOCK_FUTURE_SKEW_MS = 5_000;

/** Bumped per lock take so two calls in ONE process never share a token --
 *  the pid alone cannot tell them apart, and the ownership check on release
 *  would then let the first caller unlink the second caller's lock. */
let lockSeq = 0;

/** Test hooks for the lock's timing. Production callers pass nothing. */
export interface WriteGradeOptions {
  /** How long to wait on a live lock before throwing. */
  lockWaitMs?: number;
  /** Age past which a lock is treated as abandoned and stolen. */
  lockStaleMs?: number;
}

/** Create the lock with O_EXCL, carrying `token`. False when someone else
 *  holds it; any other failure (EACCES, a vanished directory) throws, because
 *  a lock this process cannot create sits in the directory grades.json itself
 *  could not have been written into. */
async function takeLock(lockPath: string, token: string): Promise<boolean> {
  let fh: FileHandle;
  try {
    fh = await open(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    await fh.writeFile(token);
    await fh.close();
  } catch (err) {
    // The O_EXCL open succeeded, so a lock now sits at lockPath and NOBODY
    // will release it: this throw escapes before withGradesLock's try/finally
    // is entered, and the next audit would wait the whole stale age on a lock
    // that never held anything. Both the write and the close are inside the
    // guard -- a close failure after a successful write orphans a fully
    // formed lock the same way. Remove it before rethrowing.
    await fh.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
    throw err;
  }
  return true;
}

/** Steal an abandoned lock by RENAME (see the header), then discard it. When
 *  the file the rename caught turns out to be LIVE -- another stealer retook
 *  the path with a fresh lock between our stat and our rename -- it is put
 *  back under its own token, O_EXCL so a third taker is never clobbered, and
 *  the caller goes back to waiting on it.
 *
 *  True when the path is (probably) free and the caller should retake it at
 *  once; false when the stale file could not be moved -- on Windows an AV or
 *  indexer handle on it surfaces as EPERM/EBUSY, the same transient hold
 *  atomicWriteFile retries its publish rename around. That is not an error
 *  to throw: the caller waits it out exactly like a live lock, paced and
 *  bounded by its deadline, and either the hold clears and the next steal
 *  lands or the deadline names the lock in its diagnostic. */
async function stealStaleLock(lockPath: string, isLive: (ageMs: number) => boolean): Promise<boolean> {
  const stolenPath = `${lockPath}.stale-${process.pid}-${++lockSeq}`;
  try {
    await rename(lockPath, stolenPath);
  } catch (err) {
    // ENOENT: the holder released, or another stealer's rename won. Either
    // way the path may be free now; the caller's next take settles it.
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  let holder: string | null = null;
  try {
    if (isLive(Date.now() - (await stat(stolenPath)).mtimeMs)) holder = await readFile(stolenPath, "utf8");
  } catch {
    // Vanished under us: nothing to restore.
  }
  if (holder !== null) {
    // EEXIST here means a THIRD process took the path meanwhile. The live
    // holder's lock is then simply gone, and the cost is bounded to one
    // possible lost grade in that three-way race -- the pre-lock behavior.
    await takeLock(lockPath, holder).catch(() => false);
  }
  await rm(stolenPath, { force: true }).catch(() => undefined);
  return true;
}

/** Unlink the lock -- only while it still carries OUR token. A lock that went
 *  stale and was retaken belongs to its new holder; a read failure gets the
 *  same answer, because nothing is unlinked that this call cannot prove it
 *  owns. */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    if ((await readFile(lockPath, "utf8")) !== token) return;
    await rm(lockPath, { force: true });
  } catch {
    // Already gone, or held open by a scanner: it goes stale on its own.
  }
}

// Names the LOCK file only: audit-cmd's exit-3 wrapper already prefixes the
// grades.json path, and the lock sits beside it, so repeating the cache path
// here printed the same long absolute path three times in one stderr line.
function lockTimeout(_path: string, lockPath: string, ageMs: number | null): Error {
  const held = ageMs === null ? "" : ` for ${Math.round(ageMs / 1000)}s`;
  return new Error(`locked by another yaw-mcp audit (${lockPath}, held${held}) -- re-run this audit once it finishes`);
}

/** Run `fn` while holding the sidecar lock for `path`. */
async function withGradesLock<T>(path: string, opts: WriteGradeOptions, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}${GRADES_LOCK_SUFFIX}`;
  const staleMs = opts.lockStaleMs ?? GRADES_LOCK_STALE_MS;
  const waitMs = opts.lockWaitMs ?? GRADES_LOCK_WAIT_MS;
  const token = `${process.pid}-${++lockSeq}\n`;
  const isLive = (ageMs: number): boolean => ageMs > -GRADES_LOCK_FUTURE_SKEW_MS && ageMs < staleMs;

  // The lock lives beside grades.json, so on the first-ever audit its
  // directory does not exist yet.
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + waitMs;
  while (!(await takeLock(lockPath, token))) {
    let ageMs: number | null;
    try {
      ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
    } catch {
      // Vanished between the open and the stat: the holder released, and the
      // next take should win. Still paced and still bounded by the deadline,
      // so a path that keeps flickering cannot spin here forever.
      ageMs = null;
    }
    // A stolen stale lock is retaken at once, unpaced: the path was just
    // freed and nothing is being waited on. A stale lock that would not move
    // (see stealStaleLock) falls through to the same pacing and deadline as
    // a live one, so neither a scanner's handle nor a flickering path can
    // spin here without bound.
    if (ageMs !== null && !isLive(ageMs) && (await stealStaleLock(lockPath, isLive))) continue;
    if (Date.now() >= deadline) throw lockTimeout(path, lockPath, ageMs);
    await delay(GRADES_LOCK_POLL_MS);
  }
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath, token);
  }
}

/** Write (insert or replace) a single namespace's grade into the cache,
 *  preserving every other entry. Atomic write, under the cross-process lock
 *  above, so two audits finishing together cannot drop each other's entry.
 *  Returns the path written. `opts` is test-only timing for the lock. */
export async function writeGrade(
  namespace: string,
  grade: CachedGrade,
  home: string = homedir(),
  opts: WriteGradeOptions = {},
): Promise<string> {
  const path = gradesCachePath(home);
  await withGradesLock(path, opts, async () => {
    // strictRead: a transient read failure must throw (surfacing as audit's
    // exit 3), not clobber the cache -- see readGradesCacheImpl.
    const cache = await readGradesCacheImpl(home, { strictRead: true });
    // setJsonKey, not cache[namespace]: mirrors the read side above. Plain
    // assignment of "__proto__" would invoke the inherited setter and the
    // grade would vanish from the serialized file.
    setJsonKey(cache, namespace, grade);
    await atomicWriteFile(path, `${JSON.stringify(cache, null, 2)}\n`);
  });
  return path;
}
