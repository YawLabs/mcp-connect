import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, readFile, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LEGACY_GLOBAL_FILENAME,
  LEGACY_LOCAL_FILENAME,
  LEGACY_PROJECT_FILENAME,
  migrateLegacyConfigPaths,
} from "../migrate.js";
import { CONFIG_DIRNAME, userConfigDir } from "../paths.js";

// Only `rename` is WRAPPED (real behaviour by default): the sibling-process
// race case below slots a second migrator's move in ahead of ours through a
// per-test mockImplementationOnce. Everything else in node:fs/promises stays
// real, so the suite keeps running against genuine temp directories.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const mockRename = vi.mocked(rename);

// findLegacyProjectRoot is not exported -- all walk-up behaviour is exercised
// indirectly through migrateLegacyConfigPaths, in the SECOND describe block
// below ("findLegacyProjectRoot (via migrateLegacyConfigPaths walk-up)").
// The numbers on the individual cases are historical labels from the order
// they were written, not a reading order: the walk-up block holds 5, 5b, 6,
// 7, 8, 12 and 13, while 9, 10 and 11 sit in the first block above them.

/** The allow-list a pre-0.12 flat file carries -- the payload that survives
 *  the migration. (The flat file's old hosted-backend `token` is retired and
 *  the loader ignores the key; a fixture built on it would be pinning a
 *  decommissioned surface.) */
const LEGACY_SERVERS = ["github-legacy"];

// Helper: create a legacy file at <dir>/<name> carrying an allow-list.
function writeLegacy(dir: string, name: string, servers: string[] = LEGACY_SERVERS): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ servers }), "utf8");
  return p;
}

// logger.ts writes one JSON object per line to stderr. Parse the captured
// chunks rather than substring-matching a PATH against them: on a Windows
// runner every separator in the payload is JSON-escaped to `\\`, so
// `toContain(somePath)` never matches even when the field is exactly right.
// Message substrings carry no separators and are safe either way.
function logLines(chunks: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of chunks.join("").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object") out.push(parsed as Record<string, unknown>);
    } catch {
      // Not one of ours (a stray write from the runner) -- ignore it.
    }
  }
  return out;
}

// The parsed log line whose `msg` contains `needle`, or undefined.
function findLog(chunks: string[], needle: string): Record<string, unknown> | undefined {
  return logLines(chunks).find((l) => typeof l.msg === "string" && l.msg.includes(needle));
}

describe("migrateLegacyConfigPaths", () => {
  let home: string;
  // cwd lives inside home so findLegacyProjectRoot walk-up stops at the
  // synthetic home boundary rather than escaping into the real user dir.
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-migrate-home-"));
    cwd = mkdtempSync(join(home, "proj-"));
    // The stderr-spy cases below assert on WARN lines, and logger.ts resolves
    // LOG_LEVEL per call from the ambient env. A runner shell carrying
    // LOG_LEVEL=error would suppress exactly the lines they assert on, so the
    // threshold is pinned here rather than inherited.
    vi.stubEnv("LOG_LEVEL", "warn");
  });

  afterEach(() => {
    // mockReset restores the implementation vi.fn was created with (the real
    // rename) and drops any *Once a failed assertion left unconsumed.
    mockRename.mockReset();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  // 1. Renames legacy ~/.yaw-mcp.json -> ~/.yaw-mcp/config.json when target does not exist.
  it("renames legacy global file into .yaw-mcp/ when target is absent", async () => {
    const legacyPath = writeLegacy(home, LEGACY_GLOBAL_FILENAME);
    const targetPath = join(userConfigDir(home), "config.json");

    await migrateLegacyConfigPaths({ cwd, home });

    // Legacy file should no longer exist (rename, not copy).
    await expect(stat(legacyPath)).rejects.toThrow();
    // Target should now exist with the original content.
    const content = JSON.parse(await readFile(targetPath, "utf8"));
    expect(content.servers).toEqual(LEGACY_SERVERS);
  });

  // 2. Idempotent: does NOT overwrite target when ~/.yaw-mcp/config.json already exists.
  it("does not overwrite the target when it already exists (idempotent)", async () => {
    // Both legacy and target exist.
    writeLegacy(home, LEGACY_GLOBAL_FILENAME);
    const targetDir = userConfigDir(home);
    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, "config.json");
    writeFileSync(targetPath, JSON.stringify({ servers: ["github-new"] }), "utf8");

    const warns: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      warns.push(String(chunk));
      return true;
    });
    try {
      await migrateLegacyConfigPaths({ cwd, home });
    } finally {
      spy.mockRestore();
    }

    // Target content must be unchanged (the new list wins, legacy is orphaned).
    const content = JSON.parse(await readFile(targetPath, "utf8"));
    expect(content.servers).toEqual(["github-new"]);

    // Legacy file must still exist (not deleted, not renamed).
    await expect(stat(join(home, LEGACY_GLOBAL_FILENAME))).resolves.toBeDefined();

    // ...and the orphaning is ANNOUNCED. Asserting only the skip would pass
    // against a migrator that had gone silent, leaving the user with a legacy
    // file nothing reads and nothing mentions.
    const ignored = findLog(warns, "legacy file exists alongside new location -- legacy is ignored");
    expect(ignored, "no 'legacy is ignored' warn was emitted").toBeDefined();
    expect(ignored?.legacy).toBe(join(home, LEGACY_GLOBAL_FILENAME));
    expect(ignored?.target).toBe(targetPath);
  });

  // 11. The rename-failure catch: a filesystem that refuses the move must warn
  //     and leave the legacy file in place, never lose it. Forced by planting a
  //     regular FILE where `.yaw-mcp/` needs to be a directory, so migrateFile's
  //     `mkdir(dirname(target), { recursive: true })` throws EEXIST/ENOTDIR --
  //     the same shape a locked or read-only path produces in production.
  it("warns and leaves the legacy file in place when the move fails", async () => {
    const legacyPath = writeLegacy(home, LEGACY_GLOBAL_FILENAME);
    // `~/.yaw-mcp` as a FILE: mkdir(recursive) on it throws instead of no-oping.
    writeFileSync(userConfigDir(home), "not a directory", "utf8");

    const warns: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      warns.push(String(chunk));
      return true;
    });
    try {
      await migrateLegacyConfigPaths({ cwd, home });
    } finally {
      spy.mockRestore();
    }

    // Fail-open: the legacy file is untouched, so the user is no worse off
    // than if they had never upgraded.
    await expect(stat(legacyPath)).resolves.toBeDefined();
    // ...and the failure is visible rather than swallowed by the catch.
    const failed = findLog(warns, "legacy migration failed -- leaving file in place");
    expect(failed, "no 'migration failed' warn was emitted").toBeDefined();
    expect(failed?.legacy).toBe(legacyPath);
    expect(failed?.scope).toBe("global");
    // The reason travels with it -- a bare "it failed" is not diagnosable.
    expect(typeof failed?.error).toBe("string");
    expect(String(failed?.error).length).toBeGreaterThan(0);
  });

  // 11b. The check-then-act pair `exists(target)` + rename, against a SIBLING
  //      process. config-loader memoizes the migration per process only, so
  //      two yaw-mcp processes starting together (several MCP client panes)
  //      both pass the check and the loser's rename ENOENTs on a file its
  //      sibling has already moved. That used to log the "migration failed"
  //      warn for a file sitting exactly where it should be.
  it("reports a rename that lost to a sibling process as migrated, not failed", async () => {
    const legacyPath = writeLegacy(home, LEGACY_GLOBAL_FILENAME);
    const targetPath = join(userConfigDir(home), "config.json");
    // The sibling's move, slotted in just before ours: the real rename runs
    // first (the file lands at the target), then OUR rename sees ENOENT.
    mockRename.mockImplementationOnce(async (from, to) => {
      await rename(from, to);
      const err = new Error("ENOENT: no such file or directory, rename") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    // The verdict is an INFO line; the suite's default threshold hides it.
    vi.stubEnv("LOG_LEVEL", "info");

    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      await migrateLegacyConfigPaths({ cwd, home });
    } finally {
      spy.mockRestore();
    }

    // The migration DID happen (by the sibling), and the outcome says so.
    await expect(stat(legacyPath)).rejects.toThrow();
    expect(JSON.parse(await readFile(targetPath, "utf8")).servers).toEqual(LEGACY_SERVERS);
    const migrated = findLog(chunks, "migrated by another yaw-mcp process");
    expect(migrated, "no 'migrated by another process' info was emitted").toBeDefined();
    expect(migrated?.from).toBe(legacyPath);
    expect(migrated?.to).toBe(targetPath);
    expect(findLog(chunks, "legacy migration failed")).toBeUndefined();
  });

  // 3. No-op when legacy file does not exist (ENOENT).
  it("is a no-op when the legacy file does not exist", async () => {
    // No legacy file created -- just call the migrator.
    await expect(migrateLegacyConfigPaths({ cwd, home })).resolves.toBeUndefined();

    // Target directory should not have been created (no migration happened).
    await expect(stat(join(userConfigDir(home), "config.json"))).rejects.toThrow();
  });

  // 4. The owner check itself: a legacy file whose uid is not ours is left
  //    alone rather than hoisted into ~/.yaw-mcp/, where the loader trusts it.
  //
  //    migrateFile gates this on `process.platform !== "win32"` (Windows has
  //    no geteuid and a different ACL model) and reads process.platform at CALL
  //    time, so the decision is reachable from any runner: report a POSIX
  //    platform, then hand it a geteuid that disagrees with the file's stat().
  //    Both halves are stubs of things the OS supplies, not of the code under
  //    test -- what runs is the real comparison and the real skip.
  it("skips migration when the legacy file is owned by a different uid", async () => {
    writeLegacy(home, LEGACY_GLOBAL_FILENAME);
    const legacyPath = join(home, LEGACY_GLOBAL_FILENAME);
    const targetPath = join(userConfigDir(home), "config.json");

    // stat().uid on the real file is the current user's (0 where the platform
    // does not report one), so a geteuid that differs is a foreign owner.
    const realStat = await stat(legacyPath);
    const foreignUid = realStat.uid + 999;
    const origGeteuid = (process as { geteuid?: () => number }).geteuid;
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    (process as { geteuid?: () => number }).geteuid = () => foreignUid;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    try {
      await migrateLegacyConfigPaths({ cwd, home });
    } finally {
      (process as { geteuid?: () => number }).geteuid = origGeteuid;
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }

    // Migration must have been skipped: target does not exist.
    await expect(stat(targetPath)).rejects.toThrow();
    // Legacy file must still be in place.
    await expect(stat(legacyPath)).resolves.toBeDefined();
  });

  // The other half of the same branch: a MATCHING uid must still migrate.
  // Without this, "skipped" above would pass just as happily against a
  // migrator that had stopped migrating anything at all.
  it("still migrates when the legacy file's uid IS ours", async () => {
    writeLegacy(home, LEGACY_GLOBAL_FILENAME);
    const legacyPath = join(home, LEGACY_GLOBAL_FILENAME);
    const targetPath = join(userConfigDir(home), "config.json");

    const realStat = await stat(legacyPath);
    const origGeteuid = (process as { geteuid?: () => number }).geteuid;
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    (process as { geteuid?: () => number }).geteuid = () => realStat.uid;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    try {
      await migrateLegacyConfigPaths({ cwd, home });
    } finally {
      (process as { geteuid?: () => number }).geteuid = origGeteuid;
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }

    await expect(stat(targetPath)).resolves.toBeDefined();
    await expect(stat(legacyPath)).rejects.toThrow();
  });

  // 9. A symlinked legacy path is left alone: the inode the trust check
  //    covered (stat follows) was never the one rename() would have moved.
  it("skips a legacy file that is a symlink instead of moving the link", async (ctx) => {
    // The old code stat'ed (following the link) for the ownership decision and
    // then renamed the LINK, so the file it vetted and the file it moved were
    // different inodes -- and a relative link target dangles once the link
    // lands one directory deeper inside .yaw-mcp/.
    const realDir = mkdtempSync(join(home, "real-"));
    const realFile = writeLegacy(realDir, "actual-config.json");
    const linkPath = join(home, LEGACY_GLOBAL_FILENAME);
    try {
      symlinkSync(realFile, linkPath, "file");
    } catch {
      // ctx.skip(), not a bare `return`: returning early reported this as
      // PASSED with zero assertions, so a machine that cannot create file
      // symlinks (unelevated Windows) looked like it had verified the
      // symlink-skip branch when it had not run a line of it.
      ctx.skip("file symlink creation unavailable on this machine");
    }
    const warns: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      warns.push(String(chunk));
      return true;
    });
    try {
      await migrateLegacyConfigPaths({ cwd, home });
    } finally {
      spy.mockRestore();
    }

    // The link is still a link, still where it was. (`toMatchObject({})` used
    // to stand here as well; an empty object matches ANY object, so it asserted
    // nothing beyond "lstat resolved" -- which this line already proves.)
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    // ...nothing was hoisted into ~/.yaw-mcp/, and the target is untouched.
    await expect(stat(join(userConfigDir(home), "config.json"))).rejects.toThrow();
    await expect(stat(realFile)).resolves.toBeDefined();
    // The skip is visible, not silent.
    expect(warns.join("")).toContain("legacy path is a symlink");
  });

  // 10. `.yaw-mcp.local.json` AT $HOME: no new-layout home, so it is left in
  //     place -- but the drop is announced instead of silent.
  it("warns about a legacy machine-local file sitting at $HOME instead of dropping it silently", async () => {
    // The loader's local scope is per-project and the project walk stops
    // strictly before $HOME, so this file becomes unread on upgrade with
    // nothing anywhere saying so.
    const legacyAtHome = writeLegacy(home, LEGACY_LOCAL_FILENAME);
    const warns: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      warns.push(String(chunk));
      return true;
    });
    try {
      await migrateLegacyConfigPaths({ cwd, home });
    } finally {
      spy.mockRestore();
    }

    const out = warns.join("");
    expect(out).toContain("legacy machine-local file at $HOME has no new location");
    // Non-destructive: the file stays put and nothing was written under
    // ~/.yaw-mcp/ on its behalf.
    await expect(stat(legacyAtHome)).resolves.toBeDefined();
    await expect(stat(join(userConfigDir(home), "config.local.json"))).rejects.toThrow();
  });
});

describe("findLegacyProjectRoot (via migrateLegacyConfigPaths walk-up)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-migrate-walk-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // 5. Finds .yaw-mcp.json in a parent directory strictly under $HOME.
  it("migrates a project legacy file found by walking up from a deep subdirectory", async () => {
    // Place the legacy project file one level below home (the project root).
    const projectRoot = mkdtempSync(join(home, "proj-"));
    writeLegacy(projectRoot, LEGACY_PROJECT_FILENAME);

    // Start the migrator from a subdirectory several levels deeper.
    const deep = join(projectRoot, "packages", "api", "src");
    mkdirSync(deep, { recursive: true });

    await migrateLegacyConfigPaths({ cwd: deep, home });

    // The legacy project file should have been moved to .yaw-mcp/config.json
    // inside the project root.
    const targetPath = join(projectRoot, CONFIG_DIRNAME, "config.json");
    const content = JSON.parse(await readFile(targetPath, "utf8"));
    expect(content.servers).toEqual(LEGACY_SERVERS);

    // Legacy file must no longer exist.
    await expect(stat(join(projectRoot, LEGACY_PROJECT_FILENAME))).rejects.toThrow();
  });

  // 5b. Regression: the walk-up must not stop at a directory whose NAME
  // starts with "..". migrate.ts once carried its own isUnderHome with a
  // bare `startsWith("..")` bound, so relative(home, dir) = "..config/app"
  // read as "escaped $HOME" and a legacy file under `~/..config/` was
  // discoverable by the loader but never migrated -- silent config loss.
  // The predicate is now shared with paths.ts (anchored on a separator).
  it("migrates a legacy file under a directory whose name starts with '..'", async () => {
    const projectRoot = join(home, "..config", "app");
    mkdirSync(projectRoot, { recursive: true });
    writeLegacy(projectRoot, LEGACY_PROJECT_FILENAME);
    const deep = join(projectRoot, "src");
    mkdirSync(deep, { recursive: true });

    await migrateLegacyConfigPaths({ cwd: deep, home });

    const targetPath = join(projectRoot, CONFIG_DIRNAME, "config.json");
    const content = JSON.parse(await readFile(targetPath, "utf8"));
    expect(content.servers).toEqual(LEGACY_SERVERS);
    await expect(stat(join(projectRoot, LEGACY_PROJECT_FILENAME))).rejects.toThrow();
  });

  // 12. The project-LOCAL rename, on its own: `.yaw-mcp.local.json` is the
  //     highest-precedence (gitignored) allow/deny override, and it is also the
  //     only file that can make the walker pick a root by itself -- the `||
  //     exists(legacyLocal)` arm in findLegacyProjectRoot. With only the
  //     `.yaw-mcp.json` cases above, dropping that arm or typo'ing
  //     NEW_LOCAL_FILENAME left the suite green while a 0.11.x user's override
  //     was either never migrated or renamed to a name the loader does not
  //     read -- the loader then falls through to project/global config with no
  //     warning, silently changing which MCP servers are allowed.
  it("migrates a project legacy LOCAL file and finds the root by that file alone", async () => {
    const projectRoot = mkdtempSync(join(home, "proj-"));
    writeLegacy(projectRoot, LEGACY_LOCAL_FILENAME);
    // No `.yaw-mcp.json` anywhere: the walker must return this root off the
    // local file alone.
    const deep = join(projectRoot, "packages", "api", "src");
    mkdirSync(deep, { recursive: true });

    await migrateLegacyConfigPaths({ cwd: deep, home });

    // Pinned as a literal, not re-derived from the module: a typo in
    // NEW_LOCAL_FILENAME has to fail here rather than travel into the
    // expectation with the code.
    const targetPath = join(projectRoot, CONFIG_DIRNAME, "config.local.json");
    const content = JSON.parse(await readFile(targetPath, "utf8"));
    expect(content.servers).toEqual(LEGACY_SERVERS);

    await expect(stat(join(projectRoot, LEGACY_LOCAL_FILENAME))).rejects.toThrow();
    // The shared config.json is NOT invented on the local file's behalf.
    await expect(stat(join(projectRoot, CONFIG_DIRNAME, "config.json"))).rejects.toThrow();
  });

  // 13. Both legacy files in one root: each lands under its own new name in
  //     the SAME `.yaw-mcp/`, and neither move clobbers the other (migrateFile
  //     mkdirs the parent for each, and the second mkdir must be idempotent).
  it("migrates both legacy files in a root into one .yaw-mcp/ directory", async () => {
    const projectRoot = mkdtempSync(join(home, "proj-"));
    // Distinct lists (writeLegacy's default could not tell the two moves
    // apart if one file's contents landed under the other's new name).
    writeLegacy(projectRoot, LEGACY_PROJECT_FILENAME, ["shared-only"]);
    writeLegacy(projectRoot, LEGACY_LOCAL_FILENAME, ["local-only"]);

    await migrateLegacyConfigPaths({ cwd: projectRoot, home });

    const newDir = join(projectRoot, CONFIG_DIRNAME);
    const shared = JSON.parse(await readFile(join(newDir, "config.json"), "utf8"));
    const local = JSON.parse(await readFile(join(newDir, "config.local.json"), "utf8"));
    // Contents did not cross over: each legacy file kept its own payload.
    expect(shared.servers).toEqual(["shared-only"]);
    expect(local.servers).toEqual(["local-only"]);

    await expect(stat(join(projectRoot, LEGACY_PROJECT_FILENAME))).rejects.toThrow();
    await expect(stat(join(projectRoot, LEGACY_LOCAL_FILENAME))).rejects.toThrow();
  });

  // 6. Returns null (no project migration) when the walk reaches $HOME itself.
  it("does not migrate a legacy file sitting at $HOME as a project file", async () => {
    // `.yaw-mcp.local.json` at $HOME. The local variant is deliberate: the
    // global migration only handles `.yaw-mcp.json`, so the ONLY code path
    // that could touch this file is the project walk-up -- which must stop
    // strictly before $HOME.
    const innerHome = mkdtempSync(join(home, "inner-home-"));
    const innerCwd = mkdtempSync(join(innerHome, "cwd-"));
    const legacyAtHome = writeLegacy(innerHome, LEGACY_LOCAL_FILENAME);

    await migrateLegacyConfigPaths({ cwd: innerCwd, home: innerHome });

    // A regressed guard would treat innerHome as the project root and write
    // innerHome/.yaw-mcp/config.local.json -- assert against THAT path, not
    // innerCwd's (which the walker could never have picked as the root,
    // making the old assertion vacuous).
    await expect(stat(join(innerHome, CONFIG_DIRNAME, "config.local.json"))).rejects.toThrow();
    // ...and the legacy file is still sitting untouched at $HOME.
    await expect(stat(legacyAtHome)).resolves.toBeDefined();
  });

  // 7. No-op when cwd is OUTSIDE $HOME entirely.
  it("is a no-op when cwd is outside $HOME (no walk to the filesystem root)", async () => {
    // A cwd outside $HOME used to send the walker all the way to the
    // filesystem root, destructively renaming any `.yaw-mcp.json` it passed
    // -- hoisting files from unrelated ancestors (a shared /tmp, `/`).
    // The loader now walks outside $HOME too (ownership-gated), but the
    // DESTRUCTIVE migrator deliberately stays strictly under $HOME: legacy
    // files out there are left in place for the user to move by hand.
    const outside = mkdtempSync(join(tmpdir(), "yaw-mcp-migrate-outside-"));
    try {
      const legacyProject = writeLegacy(outside, LEGACY_PROJECT_FILENAME);
      const legacyLocal = writeLegacy(outside, LEGACY_LOCAL_FILENAME);

      await migrateLegacyConfigPaths({ cwd: outside, home });

      // Both legacy files stay exactly where they are...
      await expect(stat(legacyProject)).resolves.toBeDefined();
      await expect(stat(legacyLocal)).resolves.toBeDefined();
      // ...and no `.yaw-mcp/` was created out there.
      await expect(stat(join(outside, CONFIG_DIRNAME))).rejects.toThrow();
      // The synthetic $HOME is untouched too (nothing was hoisted into it).
      await expect(stat(join(userConfigDir(home), "config.json"))).rejects.toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // 8. A symlinked $HOME spelling still migrates (realpath'd bound).
  it("migrates when $HOME is passed via a symlinked spelling of the same directory", async (ctx) => {
    // Production shape: HOME is the logical spelling (/home/u) while
    // process.cwd() reports the physical path (/var/home/u) -- symlinked
    // homes, NFS automounts. findLegacyProjectRoot used to compare the two
    // lexically, so the first isUnderHome test failed and pre-0.12 project
    // configs were silently never migrated. Both inputs are realpath'd now
    // (the same treatment findProjectConfigDir gives the loader). The link
    // is a directory junction so the fixture works unelevated on Windows;
    // on POSIX symlinkSync ignores the type hint.
    const linkParent = mkdtempSync(join(tmpdir(), "yaw-mcp-migrate-link-"));
    const homeLink = join(linkParent, "home-link");
    try {
      symlinkSync(home, homeLink, "junction");
    } catch {
      rmSync(linkParent, { recursive: true, force: true });
      // Same reason as the file-symlink case above: a bare `return` reported
      // this as a zero-assertion PASS, hiding that the branch never ran here.
      ctx.skip("directory junction creation unavailable on this machine");
    }
    try {
      const projectRoot = mkdtempSync(join(home, "proj-"));
      const legacyPath = writeLegacy(projectRoot, LEGACY_PROJECT_FILENAME);

      // home via the LINK, cwd via the PHYSICAL path -- lexically disjoint.
      await migrateLegacyConfigPaths({ cwd: projectRoot, home: homeLink });

      // Migrated: legacy renamed into the project's .yaw-mcp/.
      await expect(stat(legacyPath)).rejects.toThrow();
      await expect(stat(join(projectRoot, CONFIG_DIRNAME, "config.json"))).resolves.toBeDefined();
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
    }
  });
});
