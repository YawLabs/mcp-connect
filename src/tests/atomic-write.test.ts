import type { Stats } from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { atomicWriteFile } from "../atomic-write.js";

// The permission behaviour below is asserted through the ARGUMENTS this module
// hands node:fs, not through stat().mode on the finished file. The mode it
// passes is the decision atomicWriteFile makes; whether the OS then honours
// those bits is the OS's business, and Windows does not honour them at all
// (stat reports a synthetic 0o666/0o444). Asserting the bits on disk therefore
// pinned nothing on the only platform this suite runs on. Every fs call is a
// PASSTHROUGH spy, so the real-fs tests in this file behave exactly as before.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    mkdir: vi.fn(actual.mkdir),
    chmod: vi.fn(actual.chmod),
    stat: vi.fn(actual.stat),
    rename: vi.fn(actual.rename),
  };
});

// The rename-retry backoff is 10 + 50 + 100 ms of REAL sleeping per exhausted
// budget, which the win32 retry tests (and, on a Windows runner, the
// rename-onto-a-directory test) paid on every run for ~380 ms of pure wall
// time. Fake timers cannot reach it -- node:timers/promises does not route
// through globalThis.setTimeout -- so the sleep itself is the spy: it records
// the backoff schedule and resolves immediately. Asserting on those recorded
// delays pins MORE than the real sleep did.
vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: vi.fn(async () => undefined) };
});

import { chmod, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Run `fn` with process.platform reporting a POSIX value.
 *
 * Mode preservation and dirMode are both explicitly skipped on win32 inside
 * atomic-write.ts, and it reads process.platform at CALL time -- so the POSIX
 * DECISIONS are reachable from any runner even though the POSIX filesystem
 * SEMANTICS are not.
 */
async function asPosix<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
}

/** Companion to asPosix: run `fn` with process.platform reporting win32, so
 *  the rename-retry branch (win32-only, read at call time) is reachable from
 *  any runner. */
async function asWin32<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected by test`), { code });
}

describe("atomicWriteFile", () => {
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** The options the tmp write for `target` was born with. atomicWriteFile
   *  writes a sibling `${target}.tmp-<pid>-<ms>-<n>` and renames it over the
   *  target, so the birth mode is that call's third argument. */
  function birthOptions(target: string): { encoding?: string; mode?: number } | undefined {
    const call = vi.mocked(writeFile).mock.calls.find((c) => String(c[0]).startsWith(`${target}.tmp-`));
    return call?.[2] as { encoding?: string; mode?: number } | undefined;
  }

  /** Every path chmod was called on, in order. */
  function chmoddedPaths(): string[] {
    return vi.mocked(chmod).mock.calls.map((c) => String(c[0]));
  }

  it("writes contents to a fresh path", async () => {
    const file = join(dir, "fresh.json");
    await atomicWriteFile(file, '{"a":1}');
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
  });

  it("creates parent directories recursively", async () => {
    const file = join(dir, "nested", "deeper", "file.json");
    await atomicWriteFile(file, '{"a":1}');
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
  });

  it("replaces an existing file in place", async () => {
    const file = join(dir, "existing.json");
    writeFileSync(file, '{"old":true}', "utf8");
    await atomicWriteFile(file, '{"new":true}');
    expect(readFileSync(file, "utf8")).toBe('{"new":true}');
  });

  it("honors the mode option so the file is born owner-only (0600)", async () => {
    const file = join(dir, "secret.json");
    await atomicWriteFile(file, '{"token":"x"}', "utf8", 0o600);
    expect(readFileSync(file, "utf8")).toBe('{"token":"x"}');
    // The mode reaches creat(2) itself: the tmp file is BORN owner-only rather
    // than chmodded after the fact, so there is no window where the secret
    // sits at the umask default. (umask may only clear bits, never add.)
    expect(birthOptions(file)).toEqual({ encoding: "utf8", mode: 0o600 });
  });

  it("carries an existing target's mode onto the replacement inode when no mode is passed", async () => {
    // rename() publishes a NEW inode, so without preservation the surviving
    // file is born at the umask default (~0644) and every overwrite silently
    // widens a config the user (or an earlier secret-bearing write) tightened
    // to owner-only. ~/.claude.json holds OAuth tokens and inline MCP env.
    const file = join(dir, "tightened.json");
    writeFileSync(file, '{"token":"x"}', "utf8");
    await asPosix(async () => {
      // What the target's mode IS comes from stat; what the helper DOES with
      // it is the behaviour under test, so the stat is the injection point.
      vi.mocked(stat).mockResolvedValueOnce({ mode: 0o100600 } as unknown as Stats);
      await atomicWriteFile(file, '{"token":"y"}');
    });
    expect(readFileSync(file, "utf8")).toBe('{"token":"y"}');
    expect(birthOptions(file)).toEqual({ encoding: "utf8", mode: 0o600 });
    // And pinned back with chmod on the TMP file (before the rename), because
    // writeFile's mode is umask-masked -- a preserved 0o664 would otherwise
    // land at 0o644 under a 0o022 umask.
    expect(chmoddedPaths().filter((p) => p.startsWith(`${file}.tmp-`))).toHaveLength(1);
    expect(vi.mocked(chmod).mock.calls[0]?.[1]).toBe(0o600);
  });

  it("carries only the permission bits, never setuid/setgid/sticky, onto the replacement", async () => {
    // `& 0o7777` copied the special bits too: a target that had picked up
    // setgid from a setgid parent directory was replaced by a tmp file BORN
    // setgid, which is not what "carry the perms forward" means.
    const file = join(dir, "setgid.json");
    writeFileSync(file, "{}", "utf8");
    await asPosix(async () => {
      vi.mocked(stat).mockResolvedValueOnce({ mode: 0o102640 } as unknown as Stats);
      await atomicWriteFile(file, '{"a":1}');
    });
    expect(birthOptions(file)).toEqual({ encoding: "utf8", mode: 0o640 });
    expect(vi.mocked(chmod).mock.calls[0]?.[1]).toBe(0o640);
  });

  it("an explicit mode still wins over the target's existing mode", async () => {
    // Preservation must not block a caller that TIGHTENS on purpose: `yaw-mcp
    // try` passes 0o600 precisely because the write it is doing is what puts a
    // plaintext credential in the file. An explicit mode short-circuits the
    // preservation branch outright -- the target's mode is never even read,
    // so it cannot win and there is no chmod pinning the looser bits back.
    const file = join(dir, "was-open.json");
    writeFileSync(file, "{}", "utf8");
    await asPosix(() => atomicWriteFile(file, '{"token":"x"}', "utf8", 0o600));
    expect(birthOptions(file)).toEqual({ encoding: "utf8", mode: 0o600 });
    expect(stat).not.toHaveBeenCalled();
    expect(chmoddedPaths()).toEqual([]);
  });

  it("re-chmods a preserved mode the umask would have masked (0o664)", async () => {
    // The 0o600 case above proves chmod is CALLED but not that it changes the
    // outcome: a 0o022 umask leaves 0o600 untouched, so deleting the chmod
    // would still produce the right file. 0o664 is the mode that actually
    // needs it -- writeFile's mode is umask-masked, so the tmp file is born
    // 0o644 and only the chmod restores the group-write bit the target had.
    // Without this case the chmod's whole purpose lives in a comment.
    const file = join(dir, "group-writable.json");
    writeFileSync(file, '{"a":1}', "utf8");
    await asPosix(async () => {
      vi.mocked(stat).mockResolvedValueOnce({ mode: 0o100664 } as unknown as Stats);
      await atomicWriteFile(file, '{"a":2}');
    });
    expect(readFileSync(file, "utf8")).toBe('{"a":2}');
    // Requested at birth...
    expect(birthOptions(file)).toEqual({ encoding: "utf8", mode: 0o664 });
    // ...and pinned back afterwards, which is the half umask cannot undo.
    expect(vi.mocked(chmod).mock.calls[0]?.[1]).toBe(0o664);
  });

  it("still publishes a no-wider file when chmod on the tmp file fails", async () => {
    // Reachable in production: FAT/exFAT and some network mounts reject chmod
    // outright. The swallow is deliberate, and it is only safe because the tmp
    // file was already BORN at the preserved mode -- so the published file is
    // never wider than the target it replaced, it just may be narrower than
    // intended under a hostile umask. Nothing asserted that invariant, so a
    // future reordering (chmod before writeFile, or a birthMode of undefined)
    // would turn this catch into a silent permission widening.
    const file = join(dir, "chmod-hostile.json");
    writeFileSync(file, '{"token":"x"}', "utf8");
    await asPosix(async () => {
      vi.mocked(stat).mockResolvedValueOnce({ mode: 0o100600 } as unknown as Stats);
      vi.mocked(chmod).mockRejectedValueOnce(new Error("EPERM: operation not permitted, chmod"));
      // The rejection must not surface -- the write itself succeeded.
      await atomicWriteFile(file, '{"token":"y"}');
    });
    expect(readFileSync(file, "utf8")).toBe('{"token":"y"}');
    // The load-bearing part: birth mode already equalled the preserved mode,
    // so losing the chmod cannot widen anything.
    expect(birthOptions(file)).toEqual({ encoding: "utf8", mode: 0o600 });
    // And no orphan tmp file was left behind by the swallowed failure.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("gives concurrent same-path writes distinct tmp files instead of one shared one", async () => {
    // pid+ms alone is not unique WITHIN a process: two overlapping calls in the
    // same millisecond shared a tmp path, and writeFile opens with 'w', so
    // A.truncate -> B.truncate -> A.rename published a torn/zero-byte target
    // and the loser's rename threw. appendAuditEvent -> trimToTailCap reaches
    // this unserialized, once per secret.
    const file = join(dir, "concurrent.json");
    const payloads = ["aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff"];
    // allSettled, not all: on Windows several MoveFileEx calls racing for one
    // destination can still EPERM, which is a platform property of the rename
    // and not what this test is about. What must hold everywhere is that no
    // call ever observes another's half-written buffer.
    const results = await Promise.allSettled(payloads.map((p) => atomicWriteFile(file, p)));
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    // Last writer wins (that part is the caller's problem) but the surviving
    // file must be exactly ONE COMPLETE payload -- never empty, never spliced.
    expect(payloads).toContain(readFileSync(file, "utf8"));
    // And no tmp file was orphaned by a rename whose source vanished.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("leaves no orphan .tmp- siblings on success", async () => {
    const file = join(dir, "clean.json");
    await atomicWriteFile(file, "ok");
    const siblings = readdirSync(dir);
    expect(siblings).toEqual(["clean.json"]);
  });

  it("with dirMode births every parent directory it creates at that mode", async () => {
    const file = join(dir, "secret-dir", "deeper", "vault.json");
    await asPosix(() => atomicWriteFile(file, '{"s":1}', "utf8", undefined, 0o700));
    expect(readFileSync(file, "utf8")).toBe('{"s":1}');
    // mkdir(2) itself carries the mode, so neither new parent ever exists at
    // the umask default (0o755) -- there is no listable window.
    const leaf = resolve(join(dir, "secret-dir", "deeper"));
    expect(vi.mocked(mkdir).mock.calls).toContainEqual([leaf, { recursive: true, mode: 0o700 }]);
    // Both directories this call CREATED are then chmodded (that only
    // normalizes mkdir's umask masking)...
    expect(chmoddedPaths()).toEqual([resolve(join(dir, "secret-dir")), leaf]);
    expect(vi.mocked(chmod).mock.calls.map((c) => c[1])).toEqual([0o700, 0o700]);
    // ...and the PRE-EXISTING parent is left alone: this must not tighten the
    // user's $HOME just because a vault was written under it.
    expect(chmoddedPaths()).not.toContain(resolve(dir));
  });

  it("skips mode preservation entirely on win32", async () => {
    // The other half of every asPosix test above. POSIX bits are meaningless
    // on Windows and stat reports a synthetic 0o666/0o444, so preserving them
    // would birth the tmp file at a mode that means nothing and chmod it to
    // match. The guard makes the target's mode go unread: with
    // `process.platform !== "win32"` deleted, stat WOULD be called here and
    // the write would carry a bogus mode -- nothing else in this file notices.
    const file = join(dir, "win32-preserve.json");
    writeFileSync(file, '{"a":1}', "utf8");
    await asWin32(() => atomicWriteFile(file, '{"a":2}'));
    expect(readFileSync(file, "utf8")).toBe('{"a":2}');
    expect(birthOptions(file)).toEqual({ encoding: "utf8" });
    expect(stat).not.toHaveBeenCalled();
    expect(chmoddedPaths()).toEqual([]);
  });

  it("ignores dirMode on win32 (plain recursive mkdir, no chmod)", async () => {
    // Same shape for the directory chain: mkdirpWithMode short-circuits to a
    // bare recursive mkdir, so no mode reaches mkdir(2) and no directory is
    // chmodded afterwards.
    const parent = join(dir, "win32-dirmode", "deeper");
    const file = join(parent, "vault.json");
    await asWin32(() => atomicWriteFile(file, '{"s":1}', "utf8", undefined, 0o700));
    expect(readFileSync(file, "utf8")).toBe('{"s":1}');
    expect(vi.mocked(mkdir).mock.calls).toEqual([[parent, { recursive: true }]]);
    expect(chmoddedPaths()).toEqual([]);
  });

  it("leaves the original file untouched and rethrows when the parent path is a regular file", async () => {
    // Mechanism: mkdir(parent, {recursive:true}) THROWS EEXIST when
    // `parent` already exists as a REGULAR FILE -- recursive:true only
    // swallows EEXIST when the existing entry is a directory. So the
    // failure happens in mkdirpWithMode, BEFORE the try block that writes
    // the tmp file; nothing is created and there is nothing to clean up.
    // The cleanup path itself is covered by the rename test below.
    const blockingParent = join(dir, "block.txt");
    writeFileSync(blockingParent, "do not touch", "utf8");
    const target = join(blockingParent, "child.json"); // parent is a file, not a dir

    await expect(atomicWriteFile(target, "should fail")).rejects.toThrow();

    // Original blocking file is untouched.
    expect(readFileSync(blockingParent, "utf8")).toBe("do not touch");
    // child.json was never created.
    expect(existsSync(target)).toBe(false);
    // The directory holds exactly the blocker -- no partial artifacts.
    expect(readdirSync(dir)).toEqual(["block.txt"]);
  });

  it("unlinks the tmp file and rethrows when the rename fails", async () => {
    // This is the case the catch-block cleanup actually exists for: the
    // parent dir resolves fine, the tmp file IS written, and rename(tmp,
    // target) then fails because a non-empty directory sits at the target
    // path (EPERM on Windows, EISDIR/ENOTEMPTY on POSIX). If the unlink in
    // the catch were dropped, the .tmp- sibling would survive -- so the
    // orphan assertion below is load-bearing here, unlike in the
    // parent-is-a-file case above where no tmp is ever created.
    const target = join(dir, "target-is-a-dir");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "keep", "utf8");

    await expect(atomicWriteFile(target, "should fail")).rejects.toThrow();

    // The directory and its contents survive.
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
    // And the tmp file the failed write left behind was cleaned up.
    const orphans = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(orphans).toEqual([]);
  });

  // The publish rename on Windows fails spuriously when an AV scanner,
  // Search Indexer, or sync client briefly holds the fresh tmp file --
  // renameWithRetry backs off and retries those codes (win32 only) so one
  // alien handle doesn't fail the whole write.
  it("retries a transient EPERM/EBUSY rename on win32 and lands the write", async () => {
    const file = join(dir, "retry.json");
    vi.mocked(rename).mockRejectedValueOnce(errnoError("EPERM")).mockRejectedValueOnce(errnoError("EBUSY"));
    await asWin32(() => atomicWriteFile(file, '{"ok":1}'));
    expect(readFileSync(file, "utf8")).toBe('{"ok":1}');
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(3);
    // Backed off between attempts, in the documented schedule -- the third
    // attempt succeeded, so the 100 ms step was never reached.
    expect(vi.mocked(delay).mock.calls.map((c) => c[0])).toEqual([10, 50]);
    // No orphan tmp files after the eventual success.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("surfaces the real error and cleans up after the retry budget is spent on win32", async () => {
    // 3 backoff delays + 1 final attempt = 4 renames; a persistent EPERM
    // (read-only destination attribute, a genuine ACL denial) still
    // propagates from the last one and the tmp file is unlinked.
    const file = join(dir, "persistent.json");
    const mocked = vi.mocked(rename);
    for (let i = 0; i < 4; i++) mocked.mockRejectedValueOnce(errnoError("EPERM"));
    await asWin32(async () => {
      await expect(atomicWriteFile(file, "x")).rejects.toThrow("EPERM");
    });
    expect(mocked).toHaveBeenCalledTimes(4);
    // The whole backoff schedule was spent before the final attempt.
    expect(vi.mocked(delay).mock.calls.map((c) => c[0])).toEqual([10, 50, 100]);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("does not retry a non-transient rename error code on win32", async () => {
    vi.mocked(rename).mockRejectedValueOnce(errnoError("ENOENT"));
    await asWin32(async () => {
      await expect(atomicWriteFile(join(dir, "fast.json"), "x")).rejects.toThrow("ENOENT");
    });
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);
  });

  it("does not retry a rename failure on POSIX (no spurious-EPERM failure mode there)", async () => {
    vi.mocked(rename).mockRejectedValueOnce(errnoError("EPERM"));
    await asPosix(async () => {
      await expect(atomicWriteFile(join(dir, "posix.json"), "x")).rejects.toThrow("EPERM");
    });
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);
  });
});

/** Whether this runner can create a symlink at all -- Windows refuses without
 *  Developer Mode / SeCreateSymbolicLinkPrivilege. Probed ONCE, in a temp dir
 *  of its own, so the two tests below can report SKIPPED rather than each
 *  bailing with a bare `return` that vitest scores as a PASS: the severed-link
 *  regression they exist for would otherwise read as covered on every Windows
 *  box that cannot make links. */
function symlinksAvailable(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "yaw-mcp-atomic-symlink-probe-"));
  try {
    symlinkSync(join(probe, "target.txt"), join(probe, "link.txt"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const SYMLINKS_AVAILABLE = symlinksAvailable();

// Regression: rename() publishes at the path it is handed, so renaming the
// tmp file onto a SYMLINK replaced the link with a regular file. A
// ~/.yaw-mcp/state.json symlinked into a dotfiles checkout was therefore
// severed by the first save, and every later write landed somewhere the
// user's repo no longer saw. atomicWriteFile now resolves the link and
// writes through it.
describe("atomicWriteFile with a symlinked target", () => {
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-atomic-link-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!SYMLINKS_AVAILABLE)("writes THROUGH the link and leaves it a symlink", async () => {
    const realDir = join(dir, "dotfiles");
    mkdirSync(realDir);
    const real = join(realDir, "state.json");
    writeFileSync(real, '{"v":1}', "utf8");
    const link = join(dir, "state.json");
    symlinkSync(real, link, "file");

    await atomicWriteFile(link, '{"v":2}');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // The bytes landed on the REAL file, which is what the dotfiles repo
    // tracks -- reading either path sees them.
    expect(readFileSync(real, "utf8")).toBe('{"v":2}');
    expect(readFileSync(link, "utf8")).toBe('{"v":2}');
    // The tmp sibling went next to the real file and was renamed away; no
    // orphan is left in either directory.
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(readdirSync(realDir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it.skipIf(!SYMLINKS_AVAILABLE)("publishes at the link path when the link dangles (no real file)", async () => {
    const link = join(dir, "dangling.json");
    symlinkSync(join(dir, "missing", "state.json"), link, "file");

    await atomicWriteFile(link, '{"v":3}');

    // realpath cannot resolve a dangling link, so the write falls back to the
    // literal path -- the pre-existing behavior, and the only one available.
    expect(readFileSync(link, "utf8")).toBe('{"v":3}');
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});
