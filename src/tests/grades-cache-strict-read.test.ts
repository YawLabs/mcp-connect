// writeGrade under INJECTED fs failures: the strict read (a read-side-only
// failure) and the lock steal (a rename-side-only failure).
//
// Lives in its own file because it mocks node:fs/promises module-wide:
// the sibling grades-cache.test.ts exercises the real fs and must not
// inherit the intercept. The directory-at-the-cache-path case over there
// pins "rejects rather than clobbers", but it does NOT discriminate the
// strict read from the old catch-all: a directory also fails the WRITE
// (rename onto a directory), so pre-fix code rejected too. The real
// clobber scenario is a read that fails while the path stays writable
// (EACCES/EBUSY from an AV/indexer handle) -- under the old
// `catch { return {} }` the write then succeeded and published a
// one-entry file over every other cached grade. Only a mocked read
// failure reproduces that shape on every platform.
//
// The same AV/indexer hold is what makes a stale-lock steal's rename fail
// with EPERM on Windows, and Node cannot open a file in a way that blocks
// another rename (libuv always shares delete), so that shape too is only
// reproducible by injection -- see the last describe.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted errnos the mock throws on the NEXT readFile / the NEXT rename;
// one-shot so atomicWriteFile and later callers see the real fs.
const failNextRead = vi.hoisted(() => ({ code: null as string | null }));
const failNextRename = vi.hoisted(() => ({ code: null as string | null }));
// Fails the NEXT write through a handle `open` returned -- the one window
// where a lock file exists but nothing has claimed it yet.
const failNextHandleWrite = vi.hoisted(() => ({ code: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const injected = (code: string): NodeJS.ErrnoException => {
    const err = new Error(`${code}: injected`) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  };
  return {
    ...real,
    readFile: (async (...args: Parameters<typeof real.readFile>) => {
      const code = failNextRead.code;
      if (code) {
        failNextRead.code = null;
        throw injected(code);
      }
      return real.readFile(...args);
    }) as typeof real.readFile,
    rename: (async (...args: Parameters<typeof real.rename>) => {
      const code = failNextRename.code;
      if (code) {
        failNextRename.code = null;
        throw injected(code);
      }
      return real.rename(...args);
    }) as typeof real.rename,
    open: (async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      const code = failNextHandleWrite.code;
      if (!code) return handle;
      failNextHandleWrite.code = null;
      // The handle is REAL and the file it created is on disk -- only the
      // write through it fails, which is the exact shape takeLock has to
      // clean up after.
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === "writeFile") {
            return async () => {
              throw injected(code);
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    }) as typeof real.open,
  };
});

import type { CachedGrade } from "../grades-cache.js";
import { gradesCachePath, writeGrade } from "../grades-cache.js";
import { CONFIG_DIRNAME } from "../paths.js";

const ENTRY_A: CachedGrade = { grade: "A", score: 97.7, gradedAt: "2026-06-11T00:00:00.000Z" };
const ENTRY_B: CachedGrade = { grade: "B", score: 83.0, gradedAt: "2026-06-10T00:00:00.000Z" };

let synthHome: string;

beforeEach(() => {
  failNextRead.code = null;
  failNextRename.code = null;
  failNextHandleWrite.code = null;
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-grades-strict-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
});

describe("writeGrade -- strict read (read fails, path writable)", () => {
  it("rethrows the read error and leaves every existing grade untouched", async () => {
    const dir = join(synthHome, CONFIG_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const original = JSON.stringify({ one: ENTRY_A, two: ENTRY_B }, null, 2);
    writeFileSync(join(dir, "grades.json"), original, "utf8");

    failNextRead.code = "EACCES";
    await expect(writeGrade("three", ENTRY_A, synthHome)).rejects.toMatchObject({ code: "EACCES" });

    // The pre-fix catch-all read would have returned {} here and the
    // (perfectly writable) path would now hold ONLY {"three": ...}.
    expect(readFileSync(gradesCachePath(synthHome), "utf8")).toBe(original);
  });

  it("recovers on the next call once the transient failure clears", async () => {
    const dir = join(synthHome, CONFIG_DIRNAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "grades.json"), JSON.stringify({ one: ENTRY_A }), "utf8");

    failNextRead.code = "EACCES";
    await expect(writeGrade("two", ENTRY_B, synthHome)).rejects.toMatchObject({ code: "EACCES" });

    await writeGrade("two", ENTRY_B, synthHome);
    const parsed = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8"));
    expect(parsed.one).toEqual(ENTRY_A);
    expect(parsed.two).toEqual(ENTRY_B);
  });

  it.each(["ENOENT", "ENOTDIR"])("%s on the strict read means 'no cache yet' and the write proceeds", async (code) => {
    // Both errnos prove there is no cache file to preserve, so the strict
    // path must NOT rethrow them -- it starts from {} and creates the file,
    // exactly like the first-ever audit. (Real-fs ENOTDIR is platform-
    // shaped -- win32 reports ENOENT -- so the errno is injected by name.)
    failNextRead.code = code;
    await writeGrade("gh", ENTRY_A, synthHome);
    const parsed = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8"));
    expect(parsed.gh).toEqual(ENTRY_A);
  });
});

describe("writeGrade -- the lock file is created but the write through it fails", () => {
  it("removes the half-made lock before rethrowing, so the next audit does not wait out the stale age", async () => {
    // takeLock's O_EXCL open succeeds and THEN the write fails (EIO, a full
    // disk, a handle revoked under it). The throw escapes before
    // withGradesLock's try/finally is entered, so nothing releases the file:
    // pre-fix, a lock nobody ever held sat at the path and the next
    // `yaw-mcp audit` -- which the MCP panel fires per server -- paid the
    // whole stale age before it could steal it.
    failNextHandleWrite.code = "EIO";
    await expect(writeGrade("gh", ENTRY_A, synthHome)).rejects.toMatchObject({ code: "EIO" });

    const lockPath = `${gradesCachePath(synthHome)}.lock`;
    expect(existsSync(lockPath), "a lock nobody holds was left behind").toBe(false);

    // ...and the very next call goes straight through: no wait, no steal.
    await writeGrade("gh", ENTRY_A, synthHome, { lockWaitMs: 200 });
    expect(JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")).gh).toEqual(ENTRY_A);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("writeGrade -- a stale lock that will not move (steal's rename fails, path held)", () => {
  it("waits the hold out and steals on the next pass instead of failing the write", async () => {
    // An abandoned lock is stolen by rename. On Windows an AV/indexer handle
    // on that file makes the rename EPERM for a beat -- the same transient
    // hold atomicWriteFile retries its publish rename around. Throwing on it
    // refused a write that succeeds one poll later, and audit then reported
    // the grade as computed-but-not-cached (exit 3) over a hold that had
    // already cleared by the time the user read the message.
    const dir = join(synthHome, CONFIG_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const lockPath = `${gradesCachePath(synthHome)}.lock`;
    writeFileSync(lockPath, "dead-process\n");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);

    failNextRename.code = "EPERM";
    await writeGrade("gh", ENTRY_A, synthHome, { lockWaitMs: 5_000 });
    // The steal consumed the injected failure -- not atomicWriteFile's publish
    // rename, which would otherwise have thrown its way out of the write.
    expect(failNextRename.code).toBeNull();
    expect(JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")).gh).toEqual(ENTRY_A);
    // The second pass moved the stale lock and released our own afterwards.
    expect(existsSync(lockPath)).toBe(false);
  });
});
