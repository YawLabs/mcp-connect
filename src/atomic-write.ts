// Atomic file write helper. Writes to a sibling .tmp file then renames
// onto the target -- fs.rename is atomic on the same filesystem on POSIX
// and on modern Windows Node, so a process killed mid-write (SIGINT,
// OOM, antivirus) leaves the original target intact instead of a half-
// written file. The pid+timestamp suffix avoids tmp name collisions
// across concurrent processes; in-process serialization is the caller's
// concern (see persistence.ts:saveState for an example).

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export async function atomicWriteFile(
  filePath: string,
  contents: string,
  encoding: BufferEncoding = "utf8",
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(tmp, contents, encoding);
    await rename(tmp, filePath);
  } catch (err) {
    // Best-effort cleanup so we don't leak orphan temp files when the
    // write or rename fails. Swallow the unlink error -- the original
    // failure is what the caller cares about.
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
