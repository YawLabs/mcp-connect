// Atomic file write helper. Writes to a sibling .tmp file then renames
// onto the target -- fs.rename is atomic on the same filesystem on POSIX
// and on modern Windows Node, so a process killed mid-write (SIGINT,
// OOM, antivirus) leaves the original target intact instead of a half-
// written file. (Atomic on Windows does not mean reliable first try there:
// see renameWithRetry below for the transient EPERM/EBUSY dance with AV and
// indexer handles.) The pid+timestamp+counter suffix makes the tmp name unique
// across concurrent processes AND within this one; in-process serialization
// of the LOGICAL read-modify-write is still the caller's concern (see
// persistence.ts:saveState) -- unique tmp names stop the writes from
// tearing each other, they don't stop a last-writer-wins overwrite.
//
// PERMISSIONS: rename() publishes a brand-new inode, so the surviving
// file's mode comes from the tmp file, never from the file being replaced.
// Left alone that silently resets a user-tightened target to the umask
// default (typically 0644) on every overwrite. This helper therefore
// carries an EXISTING target's mode forward when the caller passes no
// explicit `mode` -- a write never loosens perms it did not set. Pass
// `mode` explicitly when the CONTENT decides the mode (e.g. 0o600 because
// this write is what puts a secret in the file).
//
// SYMLINKS: a symlinked target is written THROUGH, not replaced. rename()
// publishes at the path it is handed, so renaming onto a link would sever it
// and leave every later write invisible to whatever the link pointed at (the
// dotfiles-repo shape: ~/.yaw-mcp/state.json linked into a checkout). We
// resolve the link first, so both the tmp sibling and the rename land on the
// real file. See resolveSymlinkTarget.

import { chmod, lstat, mkdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Windows-only transient-error retry for the publish rename. On Windows a
// freshly written file is routinely held open for a beat by antivirus
// scanners, Search Indexer, or sync clients (OneDrive/Dropbox), and libuv's
// MoveFileExW surfaces that alien handle as EPERM/EBUSY/EACCES even though
// nothing is wrong with the write itself. A short backoff run lands those;
// a persistent error (read-only destination attribute, a real ACL denial)
// still surfaces from the final attempt. POSIX rename has no spurious
// failure mode of this shape, so retrying there would only delay reporting
// a genuine permission error.
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRY_DELAYS_MS = [10, 50, 100];

async function renameWithRetry(tmp: string, target: string): Promise<void> {
  if (process.platform !== "win32") {
    await rename(tmp, target);
    return;
  }
  for (const ms of RENAME_RETRY_DELAYS_MS) {
    try {
      await rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !RENAME_RETRY_CODES.has(code)) throw err;
      await delay(ms);
    }
  }
  // Final attempt outside the loop -- let the real error propagate.
  await rename(tmp, target);
}

// Bumped per call so two concurrent atomicWriteFile calls to the same path in
// the same process never share a tmp path. pid+ms alone is NOT unique there
// (same pid, same millisecond): writeFile opens with 'w', so an interleaved
// A.truncate -> B.truncate -> A.rename publishes a torn or zero-byte target
// and the loser's rename throws ENOENT/EPERM -- the exact failure this
// primitive exists to prevent. appendAuditEvent -> trimToTailCap
// (secrets-audit.ts) reaches this with no serializer, once per secret.
let tmpSeq = 0;

export async function atomicWriteFile(
  filePath: string,
  contents: string,
  encoding: BufferEncoding = "utf8",
  // Optional creation mode for the tmp file. Pass 0o600 for secret-bearing
  // files (token config, session cookie, vault) so the file is born
  // owner-only and never sits at the default-umask perms (often 0644) in the
  // window between rename and a post-hoc chmod. The bits are masked by the
  // process umask like any creat(2); callers that need an exact mode should
  // still chmod afterward as belt-and-suspenders.
  //
  // Omit it to PRESERVE an existing target's mode (see the header note).
  // Omitting is the right default when this write does not change what the
  // file is worth protecting; pass a mode only when the content does.
  mode?: number,
  // Optional mode for the parent-directory chain. Pass 0o700 for secret-
  // bearing paths (vault, team-session cookie) so newly-created parent
  // directories aren't born group/other-readable -- mkdir(2)'s default of
  // 0o777-&-umask typically lands at 0o755, which lets others list the
  // directory and observe filenames/timestamps of secret files inside.
  // No-op on Windows (POSIX-mode bits aren't meaningful there). Only
  // applies to directories CREATED by this call -- pre-existing parents
  // are left alone (we don't want to tighten the user's $HOME).
  dirMode?: number,
): Promise<void> {
  // Write THROUGH a symlinked target rather than replacing it. rename()
  // publishes a regular file at the path it is handed, so renaming onto a
  // symlink severs the link: a `~/.yaw-mcp/state.json` symlinked into a
  // dotfiles checkout (the common way people version these files) silently
  // detaches on the first save, and every later write lands somewhere the
  // user's repo no longer sees. Resolving the link first puts the tmp file
  // next to the REAL file and renames onto the real file, so the link
  // survives and keeps pointing at the bytes we just wrote -- and the mode
  // preservation below then reads and restores the real file's mode, which
  // is the inode rename actually replaces. A dangling link (or any path
  // realpath cannot resolve) falls back to the literal path: there is no
  // real file to write through, so publishing at the link path is the only
  // option left.
  const target = await resolveSymlinkTarget(filePath);
  const dir = path.dirname(target);
  // The tmp file is a SIBLING of the target (same directory => same
  // filesystem), so fs.rename is atomic. Atomicity holds ONLY on the same
  // filesystem: a cross-device rename throws EXDEV. We never cross devices
  // here because tmp and target share a dir, but callers must not point
  // filePath at a special/overlay mount whose dirname resolves to a
  // different fs than where the tmp would be written -- that would surface
  // as an EXDEV throw rather than an atomic swap. (If a real cross-device
  // need ever arises, fall back to writeFile-in-place, losing atomicity.)
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`;
  await mkdirpWithMode(dir, dirMode);
  // No explicit mode: carry the target's own perms onto the replacement inode
  // so an overwrite cannot widen a file the user (or an earlier secret-bearing
  // write) tightened. Nothing to preserve when the target does not exist yet --
  // that stays at the umask default, as before. Skipped on Windows, where the
  // POSIX bits are not meaningful and stat reports a synthetic 0o666/0o444.
  let preserved: number | undefined;
  if (mode === undefined && process.platform !== "win32") {
    try {
      // 0o777, not 0o7777: the PERMISSION bits are what "carry the perms
      // forward" means. setuid / setgid / sticky describe the old inode's
      // role (a target that inherited setgid from its directory, say) and a
      // tmp file BORN with them is a surprise nobody asked for.
      preserved = (await stat(target)).mode & 0o777;
    } catch {
      // ENOENT (fresh file) or an unstattable target -- nothing to carry.
    }
  }
  const birthMode = mode ?? preserved;
  try {
    await writeFile(tmp, contents, birthMode === undefined ? { encoding } : { encoding, mode: birthMode });
    if (preserved !== undefined) {
      try {
        // writeFile's mode is masked by the process umask, so a preserved
        // 0o664 would land at 0o644 under a 0o022 umask. chmod pins it back
        // to exactly what the target had -- preservation must not quietly
        // rewrite the user's bits either way. Best-effort: some filesystems
        // (FAT-shaped mounts) reject chmod.
        await chmod(tmp, preserved);
      } catch {
        // Ignored -- the born mode above is already no wider than the target.
      }
    }
    await renameWithRetry(tmp, target);
  } catch (err) {
    // Best-effort cleanup so we don't leak orphan temp files when the
    // write or rename fails. Swallow the unlink error -- the original
    // failure is what the caller cares about.
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * The path this write should actually publish at: the symlink's resolved
 * target when `filePath` is a symlink, the path itself otherwise.
 *
 * lstat (not stat) is the probe -- stat follows the link and reports the
 * target, which is exactly the confusion this function exists to remove.
 * Every failure degrades to the literal path: a missing file (the fresh-write
 * case), a dangling link with no real file behind it, an EACCES on the parent,
 * or a platform that cannot resolve the path. That is the pre-existing
 * behavior, so nothing regresses when the probe cannot run.
 */
async function resolveSymlinkTarget(filePath: string): Promise<string> {
  try {
    if (!(await lstat(filePath)).isSymbolicLink()) return filePath;
    return await realpath(filePath);
  } catch {
    return filePath;
  }
}

/**
 * mkdir -p with an optional POSIX mode applied to every directory we
 * actually CREATE (pre-existing parents are not re-chmodded -- we don't
 * want to tighten the user's $HOME just because we wrote a vault under it).
 *
 * The mode is passed to mkdir(2) itself, so each directory is BORN at
 * dirMode -- there is no window where a freshly-created parent sits at
 * the umask default (typically 0o755) and lets others list it. The chmod
 * afterwards only normalizes the umask masking (mkdir's mode is `mode &
 * ~umask`, e.g. a umask of 0o027 would land 0o700 at 0o750); it can only
 * ever tighten toward the requested mode, never widen a window.
 *
 * On Windows or when dirMode is undefined this is just a recursive mkdir.
 */
async function mkdirpWithMode(dir: string, dirMode: number | undefined): Promise<void> {
  if (dirMode === undefined || process.platform === "win32") {
    await mkdir(dir, { recursive: true });
    return;
  }
  // Walk leaf -> root collecting segments that don't exist yet, then create
  // them root -> leaf, chmodding each one we created. We stat-walk UP rather
  // than splitting and walking DOWN so we don't have to reason about the
  // POSIX leading-slash / "" first-segment shape (path.dirname handles that
  // correctly on every platform).
  const resolved = path.resolve(dir);
  const toCreate: string[] = [];
  let cursor = resolved;
  // Stop at the filesystem root (path.dirname("/" ) === "/").
  while (true) {
    let exists = true;
    try {
      await stat(cursor);
    } catch {
      exists = false;
    }
    if (exists) break;
    toCreate.unshift(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break; // hit the root without finding an existing ancestor
    cursor = parent;
  }
  if (toCreate.length === 0) return; // every parent already exists
  // recursive:true tolerates a concurrent racer creating any of these dirs
  // between our stat and our mkdir. `mode` applies to every directory this
  // call creates, so they're born restricted rather than chmodded after
  // the fact.
  await mkdir(resolved, { recursive: true, mode: dirMode });
  for (const created of toCreate) {
    try {
      // Normalizes the umask masking applied by mkdir(2) above. Only
      // narrows the gap to the requested mode; the birth mode already
      // ruled out an over-permissive window.
      await chmod(created, dirMode);
    } catch {
      // Best-effort -- some filesystems (FAT-shaped mounts) reject chmod.
    }
  }
}
