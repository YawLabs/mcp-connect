import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireUpgradeLock,
  attemptedRecentlyAt,
  detectRunningInstallPrefix,
  maybeAutoUpgrade,
  quoteArgForDisplay,
  quoteShellArgIfNeeded,
  readCheckMemo,
  recordAttemptAt,
  writeCheckMemo,
} from "../auto-upgrade.js";

// ═══════════════════════════════════════════════════════════════════════
// maybeAutoUpgrade — fire-and-forget startup self-upgrade check.
//
// The registry fetch and the npm spawn are both injected, so these tests
// are pure: they assert WHEN a background `npm install -g` is spawned and
// when it is correctly skipped (dev build, offline, already-current, or
// an install method we won't touch).
// ═══════════════════════════════════════════════════════════════════════

// argv[1] paths that detectInstallMethod (upgrade-cmd.ts) classifies.
// Built with join(), NOT a POSIX literal. detectRunningInstallPrefix matches
// on `${sep}node_modules${sep}`, and the file-level realpathSync mock hands
// this string straight back -- so a literal "/usr/.../node_modules/..." finds
// a prefix on POSIX and finds NOTHING on win32. That skew made the spawn args
// platform-dependent (bare 3-element form here, 5-element --prefix form on
// Linux) and silently green only on Windows. join() makes both platforms
// resolve the prefix, so the expected argv is the same everywhere.
const GLOBAL_NPM_PREFIX = join(sep, "usr", "local");
const GLOBAL_NPM_PATH = join(GLOBAL_NPM_PREFIX, "lib", "node_modules", "@yawlabs", "mcp", "dist", "index.js");
/** What maybeAutoUpgrade spawns for a global-npm install whose prefix resolves. */
const GLOBAL_NPM_ARGS = ["install", "-g", "--prefix", GLOBAL_NPM_PREFIX, "@yawlabs/mcp@latest"];
/** maybeAutoUpgrade now hands the spawn a third argument -- the callback that
 *  releases the prefix lockfile once the install settles. Every spawn
 *  assertion has to account for it; the identity of the function is an
 *  implementation detail, its PRESENCE is the contract. */
const RELEASE_LOCK = expect.any(Function);
const NPX_PATH = "/home/u/.npm/_npx/abc123/node_modules/@yawlabs/mcp/dist/index.js";
const LOCAL_NODE_MODULES_PATH = "/home/u/myproject/node_modules/@yawlabs/mcp/dist/index.js";
const UNKNOWN_PATH = "/tmp/some/random/launch/path.js";

describe("maybeAutoUpgrade", () => {
  it("does nothing when YAW_MCP_AUTO_UPGRADE=0 (opt-out short-circuits before fetch/spawn)", async () => {
    const prev = process.env.YAW_MCP_AUTO_UPGRADE;
    process.env.YAW_MCP_AUTO_UPGRADE = "0";
    try {
      const fetchLatestImpl = vi.fn();
      const spawnImpl = vi.fn();
      await maybeAutoUpgrade({
        currentVersion: "0.47.0",
        argvPath: GLOBAL_NPM_PATH,
        fetchLatestImpl,
        spawnImpl,
      });
      expect(fetchLatestImpl).not.toHaveBeenCalled();
      expect(spawnImpl).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.YAW_MCP_AUTO_UPGRADE;
      else process.env.YAW_MCP_AUTO_UPGRADE = prev;
    }
  });

  it("YAW_MCP_AUTO_UPGRADE=false also opts out (matches the =0 escape hatch)", async () => {
    const prev = process.env.YAW_MCP_AUTO_UPGRADE;
    process.env.YAW_MCP_AUTO_UPGRADE = "false";
    try {
      const spawnImpl = vi.fn();
      await maybeAutoUpgrade({
        currentVersion: "0.47.0",
        argvPath: GLOBAL_NPM_PATH,
        fetchLatestImpl: async () => "0.47.8",
        spawnImpl,
      });
      expect(spawnImpl).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.YAW_MCP_AUTO_UPGRADE;
      else process.env.YAW_MCP_AUTO_UPGRADE = prev;
    }
  });

  it("YAW_MCP_AUTO_UPGRADE=FALSE (uppercase) opts out -- contract is case-insensitive", async () => {
    const prev = process.env.YAW_MCP_AUTO_UPGRADE;
    process.env.YAW_MCP_AUTO_UPGRADE = "FALSE";
    try {
      const fetchLatestImpl = vi.fn();
      const spawnImpl = vi.fn();
      await maybeAutoUpgrade({
        currentVersion: "0.47.0",
        argvPath: GLOBAL_NPM_PATH,
        fetchLatestImpl,
        spawnImpl,
      });
      expect(fetchLatestImpl).not.toHaveBeenCalled();
      expect(spawnImpl).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.YAW_MCP_AUTO_UPGRADE;
      else process.env.YAW_MCP_AUTO_UPGRADE = prev;
    }
  });

  it("YAW_MCP_AUTO_UPGRADE=1 / =true does NOT opt out -- only `0`/`false` disable", async () => {
    // Defends the opt-OUT contract against a user who reads the env var
    // as opt-in and sets `1`/`true` expecting it to enable -- the
    // feature is already on by default, and these values must NOT
    // accidentally suppress it.
    for (const value of ["1", "true", "yes", "on"]) {
      const prev = process.env.YAW_MCP_AUTO_UPGRADE;
      process.env.YAW_MCP_AUTO_UPGRADE = value;
      try {
        const spawnImpl = vi.fn();
        await maybeAutoUpgrade({
          currentVersion: "0.47.0",
          argvPath: GLOBAL_NPM_PATH,
          fetchLatestImpl: async () => "0.47.8",
          spawnImpl,
        });
        expect(spawnImpl, `value=${value} should NOT opt out`).toHaveBeenCalledWith(
          "npm",
          GLOBAL_NPM_ARGS,
          RELEASE_LOCK,
        );
      } finally {
        if (prev === undefined) delete process.env.YAW_MCP_AUTO_UPGRADE;
        else process.env.YAW_MCP_AUTO_UPGRADE = prev;
      }
    }
  });

  it("does nothing for an unbuilt dev checkout (never fetches or spawns)", async () => {
    const fetchLatestImpl = vi.fn();
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({ currentVersion: "dev", argvPath: GLOBAL_NPM_PATH, fetchLatestImpl, spawnImpl });
    expect(fetchLatestImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does nothing when the registry is unreachable (fetch returns null)", async () => {
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => null,
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does nothing when already on the latest version", async () => {
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.8",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("background-upgrades a stale global-npm install", async () => {
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith("npm", GLOBAL_NPM_ARGS, RELEASE_LOCK);
  });

  it("background-upgrades stale pnpm/bun globals with their owning tool", async () => {
    const pnpmSpawn = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: "/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: pnpmSpawn,
    });
    expect(pnpmSpawn).toHaveBeenCalledWith("pnpm", ["add", "-g", "@yawlabs/mcp@latest"], RELEASE_LOCK);

    const bunSpawn = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: "/home/u/.bun/install/global/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: bunSpawn,
    });
    expect(bunSpawn).toHaveBeenCalledWith("bun", ["add", "-g", "@yawlabs/mcp@latest"], RELEASE_LOCK);
  });

  it("does NOT spawn for a stale npx install (npx self-heals via the @latest config)", async () => {
    // npx installs are upgraded by the `@yawlabs/mcp@latest` entry that
    // `yaw-mcp install` writes -- there is nothing safe to spawn from here.
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: NPX_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does NOT spawn for a stale local-node-modules install (project owns its own tree)", async () => {
    // If a project has @yawlabs/mcp as a local dep, this process must
    // never run `npm install -g` against the user's environment -- the
    // project's lockfile owns that version. Locks the switch arm in
    // maybeAutoUpgrade so a future refactor can't flip the default.
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: LOCAL_NODE_MODULES_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does NOT spawn for a stale install of unknown method (the catch-all is harmless)", async () => {
    // detectInstallMethod returns "unknown" when argv[1] doesn't match
    // any known pattern. The only spawn arm is gated on "global-npm";
    // this test pins that the unknown fallback logs an info hint and
    // never reaches a spawn, even when latest > current.
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: UNKNOWN_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("does NOT spawn for a standalone binary (no package manager to self-upgrade)", async () => {
    // A SEA binary has no package manager; the user replaces the executable.
    // isSeaImpl forces the binary classification regardless of the argv path.
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      isSeaImpl: () => true,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("only whitelists `npm install -g @yawlabs/mcp@latest` -- never arbitrary commands", async () => {
    const calls: [string, string[]][] = [];
    await maybeAutoUpgrade({
      currentVersion: "0.40.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: (cmd, args) => calls.push([cmd, args]),
    });
    expect(calls).toEqual([["npm", GLOBAL_NPM_ARGS]]);
  });

  it("does NOT spawn for a stale bundled-app (asar.unpacked) argvPath -- distinct from generic no-spawn cases", async () => {
    // The bundled-app branch in maybeAutoUpgrade logs and returns without
    // calling spawnImpl. Same observable surface as npx/local/unknown, but the
    // code reaches it through the explicit `method === "bundled-app"` guard
    // rather than the null-globalSpec fallthrough. Pin that branch by name --
    // a line number cited here goes stale on the next edit above it.
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: "/Applications/Yaw.app/Contents/Resources/app.asar.unpacked/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// detectRunningInstallPrefix
//
// The function calls realpathSync(argvPath) then takes the LAST
// `<sep>node_modules<sep>` segment of its dirname (a bare node_modules
// segment -- no `.bin` directory is involved). We mock
// realpathSync so the tests control exactly what "resolved" path is
// seen, and build all fixture paths with path.join / sep so the
// assertions hold on both Windows (\) and POSIX (/) runners.
// ═══════════════════════════════════════════════════════════════════════

// Only realpathSync is stubbed, and renameSync is WRAPPED (real behaviour by
// default; a per-test mockImplementationOnce lets the steal suite interleave a
// second stealer between acquireUpgradeLock's stat and its rename) -- the rest
// of node:fs stays real, which is what lets the lockfile suite below run
// against a genuine temp directory.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, realpathSync: vi.fn((p: string) => p), renameSync: vi.fn(actual.renameSync) };
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

const mockRealpathSync = vi.mocked(realpathSync);
const mockRenameSync = vi.mocked(renameSync);

describe("detectRunningInstallPrefix", () => {
  it("returns the install prefix when argv[1] is inside a node_modules tree", () => {
    // e.g. /usr/local/lib/node_modules/@yawlabs/mcp/dist/index.js
    // -> walks up past @yawlabs/mcp/dist, finds node_modules segment
    // -> candidate = /usr/local/lib  (then strips /lib -> /usr/local)
    const argv1 = join(sep, "usr", "local", "lib", "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    mockRealpathSync.mockReturnValueOnce(argv1);
    const result = detectRunningInstallPrefix(argv1);
    // The /lib suffix must be stripped on a Linux-style global path.
    expect(result).toBe(join(sep, "usr", "local"));
  });

  it("returns null when no node_modules segment exists in argv[1]", () => {
    const argv1 = join(sep, "home", "user", "bin", "yaw-mcp");
    mockRealpathSync.mockReturnValueOnce(argv1);
    expect(detectRunningInstallPrefix(argv1)).toBeNull();
  });

  it("strips the lib segment on Linux-style global paths", () => {
    // /opt/homebrew/lib/node_modules/@yawlabs/mcp/dist/index.js
    // -> candidate = /opt/homebrew/lib  -> stripped to /opt/homebrew
    const argv1 = join(sep, "opt", "homebrew", "lib", "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    mockRealpathSync.mockReturnValueOnce(argv1);
    expect(detectRunningInstallPrefix(argv1)).toBe(join(sep, "opt", "homebrew"));
  });

  it("does NOT strip lib when the path has node_modules but no trailing /lib parent", () => {
    // /home/user/.nvm/versions/node/v20.0.0/node_modules/@yawlabs/mcp/dist/index.js
    // candidate = /home/user/.nvm/versions/node/v20.0.0  -- no /lib suffix, kept as-is
    const argv1 = join(
      sep,
      "home",
      "user",
      ".nvm",
      "versions",
      "node",
      "v20.0.0",
      "node_modules",
      "@yawlabs",
      "mcp",
      "dist",
      "index.js",
    );
    mockRealpathSync.mockReturnValueOnce(argv1);
    expect(detectRunningInstallPrefix(argv1)).toBe(join(sep, "home", "user", ".nvm", "versions", "node", "v20.0.0"));
  });

  it("returns null when argv[1] is undefined", () => {
    expect(detectRunningInstallPrefix(undefined)).toBeNull();
  });

  it("returns null for a path with no node_modules segment, however deep", () => {
    // This replaces a test that claimed to pin a 24-segment "safety cap". The
    // cap never had an observable effect -- lastIndexOf scans the whole string,
    // so depth cannot hide a node_modules segment -- and the old fixture had no
    // node_modules in it at all, so it pinned the plain not-found null it still
    // pins here. The cap is gone; this is the behavior that was actually real.
    const deepSegments = Array.from({ length: 26 }, (_, i) => `dir${i}`);
    const argv1 = join(sep, ...deepSegments, "index.js");
    mockRealpathSync.mockReturnValueOnce(argv1);
    expect(detectRunningInstallPrefix(argv1)).toBeNull();
  });

  it("resolves the prefix of an install nested far deeper than the old 24-segment cap", () => {
    // The counterpart the old cap test could never express: a REAL deep
    // install still resolves, because the match is on the segment, not depth.
    const deep = Array.from({ length: 30 }, (_, i) => `d${i}`);
    const prefix = join(sep, ...deep);
    const argv1 = join(prefix, "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    mockRealpathSync.mockReturnValueOnce(argv1);
    expect(detectRunningInstallPrefix(argv1)).toBe(prefix);
  });

  it("returns null when realpathSync throws (e.g. path does not exist)", () => {
    mockRealpathSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    expect(detectRunningInstallPrefix("/nonexistent/path/index.js")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// runAutoUpgrade (via maybeAutoUpgrade) -- --prefix injection
//
// When detectRunningInstallPrefix returns a prefix that differs from
// what `npm prefix -g` would return, the spawn args must include
// --prefix <dir> so the upgrade lands in the same tree the client
// originally spawned us from.
// ═══════════════════════════════════════════════════════════════════════

describe("runAutoUpgrade: --prefix injection into spawn args", () => {
  // Restoring the file-level identity realpath mock belongs in afterEach, not
  // at the end of a test body: a failing assertion skips the rest of the body,
  // so an in-body restore leaks a blanket realpath stub into every suite below
  // and turns one red test into a cascade of unrelated ones.
  afterEach(() => {
    mockRealpathSync.mockReset();
    mockRealpathSync.mockImplementation((p: Parameters<typeof mockRealpathSync>[0]) => String(p));
  });

  it("adds --prefix to npm spawn args when detected prefix differs from the default", async () => {
    // Use a path whose dirname walk hits node_modules so
    // detectRunningInstallPrefix returns a non-null prefix. The mock
    // realpathSync set above returns the path verbatim.
    const customPrefix = join(sep, "opt", "node");
    const argv1 = join(customPrefix, "lib", "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    mockRealpathSync.mockReturnValue(argv1);

    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: argv1,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnImpl.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("npm");
    expect(args).toContain("--prefix");
    expect(args).toContain(customPrefix);
    expect(args).toContain("@yawlabs/mcp@latest");
    // Ensure the exact whitelisted shape: install -g --prefix <dir> @yawlabs/mcp@latest
    expect(args).toEqual(["install", "-g", "--prefix", customPrefix, "@yawlabs/mcp@latest"]);
  });

  it("classifies a bin shim by its REALPATH, so a global install behind a shim still upgrades", async () => {
    // `/usr/local/bin/yaw-mcp` is npm's own bin symlink -- the canonical POSIX
    // global invocation. The literal path matches no install marker; only the
    // resolved path says global-npm. Classified from the unresolved argv[1] it
    // reads as "unknown", and the most ordinary global install there is never
    // background-upgrades. The prefix walk resolves the same shim, so the
    // upgrade lands in the tree the shim points into.
    const shim = join(sep, "usr", "local", "bin", "yaw-mcp");
    mockRealpathSync.mockImplementation((p) => (p === shim ? GLOBAL_NPM_PATH : String(p)));

    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: shim,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith("npm", GLOBAL_NPM_ARGS, RELEASE_LOCK);
  });

  it("re-classifies a project-local node_modules that is a symlink into a global prefix (npm link)", async () => {
    // `local-node-modules` is a LITERAL answer, so the CLI's classifier never
    // second-guesses it (resolving a pnpm global first lands in the store and
    // reads as local). The background upgrader passes detectInstallMethod a
    // resolveWhen that includes local-node-modules: the bytes running under an
    // `npm link`ed or staged shim belong to the global install, and that
    // install is what a restart keeps spawning. It used to keep a private copy
    // of this realpath pass for the one difference; now it is the
    // classifier's own option, so the resolution rule cannot drift in two
    // places.
    mockRealpathSync.mockImplementation((p) => (p === LOCAL_NODE_MODULES_PATH ? GLOBAL_NPM_PATH : String(p)));

    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: LOCAL_NODE_MODULES_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
    });

    expect(spawnImpl).toHaveBeenCalledWith("npm", GLOBAL_NPM_ARGS, RELEASE_LOCK);
  });
});

describe("quoteArgForDisplay -- paste-safe quoting for PRINTED command lines", () => {
  // Both platforms are pinned explicitly: the helper's job is that a printed
  // suggestion pastes as ONE token in the user's shell, which the spawn-side
  // quoteShellArgIfNeeded deliberately does NOT guarantee on POSIX (there the
  // spawn argv must stay raw -- no shell is involved).
  it("POSIX: passes shell-inert values through raw", () => {
    expect(quoteArgForDisplay("/usr/local", "linux")).toBe("/usr/local");
    expect(quoteArgForDisplay("/opt/node-22.1_x64/lib", "darwin")).toBe("/opt/node-22.1_x64/lib");
  });

  it("POSIX: single-quotes whitespace so the paste can't split into two tokens", () => {
    expect(quoteArgForDisplay("/Users/j/My Tools", "darwin")).toBe("'/Users/j/My Tools'");
    expect(quoteArgForDisplay("/home/j/a\tb", "linux")).toBe("'/home/j/a\tb'");
  });

  it("POSIX: single-quotes shell metacharacters, escaping embedded single quotes", () => {
    expect(quoteArgForDisplay("/home/j/$HOME-ish", "linux")).toBe("'/home/j/$HOME-ish'");
    // The standard '\'' dance: close, escaped literal quote, reopen.
    expect(quoteArgForDisplay("/Users/j/it's here", "darwin")).toBe("'/Users/j/it'\\''s here'");
  });

  it("win32: is byte-identical to quoteShellArgIfNeeded (the printed line must match the shell:true argv join)", () => {
    for (const arg of ["C:\\npm", "C:\\Users\\Jeff Smith\\AppData\\Roaming\\npm", 'C:\\bad"quote', "C:\\pct%path"]) {
      expect(quoteArgForDisplay(arg, "win32")).toBe(quoteShellArgIfNeeded(arg, "win32"));
    }
    expect(quoteArgForDisplay("C:\\Users\\Jeff Smith\\npm", "win32")).toBe('"C:\\Users\\Jeff Smith\\npm"');
    expect(quoteArgForDisplay('C:\\bad"quote', "win32")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// defaultSpawn + compareWithNpmPrefix + fetchLatestVersion
//
// Everything above injects `spawnImpl` / `fetchLatestImpl`, so the arms
// that only run when a real caller does NOT inject a hook were never
// executed: the actual `spawn()` of `npm install -g` (its options, its
// close/error handling) and the actual registry fetch. Those are the two
// pieces that touch the user's machine at every server start, so they are
// exercised here against a mocked `node:child_process` / `fetch`.
//
// The `npm prefix -g` comparison probe does NOT appear in cp.calls: it now
// routes through upgrade-cmd's shared npmGlobalPrefix, which short-circuits
// to null under `process.env.VITEST` so no unit test ever spawns a real npm.
// Tests that need the probe to answer inject `npmPrefixImpl` instead (see the
// compareWithNpmPrefix block below).
// ═══════════════════════════════════════════════════════════════════════

import type { EventEmitter } from "node:events";

/** Recorder for the mocked spawn. `vi.hoisted` so the object exists before
 *  the hoisted `vi.mock` factory below closes over it. */
const cp = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>,
  children: [] as Array<EventEmitter & { stdout: EventEmitter }>,
  /** Set to make the mocked spawn throw SYNCHRONOUSLY (EACCES on the tool
   *  binary, a bad cwd) instead of returning a child. Node really does throw
   *  from spawn for those, and that path never reaches a close/error handler --
   *  so it is the only way to exercise maybeAutoUpgrade's catch. */
  throwOnSpawn: null as Error | null,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter: EE } = await import("node:events");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
      cp.calls.push({ cmd, args: [...args], opts: { ...opts } });
      if (cp.throwOnSpawn) throw cp.throwOnSpawn;
      const child = new EE() as EventEmitter & { stdout: EventEmitter };
      child.stdout = new EE();
      cp.children.push(child);
      return child;
    },
  };
});

// The module logs its outcome rather than returning it, so the log is the
// only observable for the close/error arms of defaultSpawn.
vi.mock("../logger.js", () => ({ log: vi.fn() }));

import { log } from "../logger.js";

const mockLog = vi.mocked(log);

/** A realpath with NO node_modules segment: detectRunningInstallPrefix
 *  returns null for it on EVERY platform, so `--prefix` is omitted and the
 *  `npm prefix -g` comparison probe never fires. Built with join/sep
 *  because the walk in detectRunningInstallPrefix keys off `path.sep`. */
const NO_PREFIX_REALPATH = join(sep, "home", "u", "bin", "yaw-mcp");
/** A realpath that DOES yield a prefix on every platform. */
const DETECTED_PREFIX = join(sep, "opt", "node");
const PREFIXED_REALPATH = join(DETECTED_PREFIX, "lib", "node_modules", "@yawlabs", "mcp", "dist", "index.js");

const PNPM_PATH = "/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js";
const BUN_PATH = "/home/u/.bun/install/global/node_modules/@yawlabs/mcp/dist/index.js";

/** All `warn`-level log calls, in order. */
function warnCalls(): Array<[string, string, Record<string, unknown> | undefined]> {
  return mockLog.mock.calls.filter((c) => c[0] === "warn") as Array<
    [string, string, Record<string, unknown> | undefined]
  >;
}

function resetSpawnRecorder(): void {
  cp.calls.length = 0;
  cp.children.length = 0;
  cp.throwOnSpawn = null;
  mockLog.mockClear();
  mockRealpathSync.mockReset();
  mockRealpathSync.mockImplementation((p: Parameters<typeof mockRealpathSync>[0]) => String(p));
}

describe("defaultSpawn -- the real background upgrade child", () => {
  beforeEach(resetSpawnRecorder);
  afterEach(resetSpawnRecorder);

  it("spawns the whitelisted npm command with stdio ignored, NOT detached, shell only on win32", async () => {
    // stdio:"ignore" keeps the child off the MCP stdio transport (a single
    // stray byte on stdout corrupts the JSON-RPC stream); detached:false
    // keeps the child in yaw-mcp's process group, so a client that tears down
    // the whole tree takes it along. That is all it buys: on POSIX a plain
    // parent exit does NOT kill it (the source's KNOWN GAPS say so), so the
    // option is pinned for the group membership, not for "dies with us".
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });

    expect(cp.calls).toHaveLength(1);
    expect(cp.calls[0].cmd).toBe("npm");
    expect(cp.calls[0].args).toEqual(["install", "-g", "@yawlabs/mcp@latest"]);
    expect(cp.calls[0].opts).toMatchObject({
      stdio: "ignore",
      detached: false,
      shell: process.platform === "win32",
    });
  });

  it("logs completion (not a warning) when the child exits 0", async () => {
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });
    cp.children[0].emit("close", 0);

    expect(mockLog).toHaveBeenCalledWith("info", expect.stringContaining("self-upgrade complete"));
    expect(warnCalls()).toHaveLength(0);
  });

  it("warns with the npm corrective command, the EACCES hint and the opt-out when the child exits non-zero", async () => {
    // stdio is "ignore", so the tool's own error text is unrecoverable --
    // the warning IS the entire diagnostic the user gets. It has to carry
    // the command to run by hand and the way to silence the check.
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });
    cp.children[0].emit("close", 243);

    const warns = warnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toContain("npm install -g @yawlabs/mcp@latest");
    expect(warns[0][1]).toContain("EACCES");
    expect(warns[0][1]).toContain("YAW_MCP_AUTO_UPGRADE=0");
    // The exit code has to survive into the structured field -- it is the
    // only machine-readable part of an otherwise opaque failure.
    expect(warns[0][2]).toEqual({ code: 243 });
  });

  it("warns once on a spawn error, and the close that follows it stays SILENT", async () => {
    // ENOENT fires BOTH "error" and "close". The error handler owns the
    // message (it is the only one that knows what actually happened), so a
    // regression that drops the errorFired guard shows up here as a second,
    // misleading "exited non-zero" warning for the same failure.
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });
    const child = cp.children[0];
    child.emit("error", new Error("spawn npm ENOENT"));
    child.emit("close", 1);

    const warns = warnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toContain("spawn failed");
    expect(warns[0][2]).toEqual({ error: "spawn npm ENOENT" });
  });

  it("names pnpm (not npm) in the corrective command, and drops the sudo/EACCES hint", async () => {
    // The EACCES hint is npm-specific -- pnpm manages its own global store,
    // so telling a pnpm user to fix permissions on an npm prefix is wrong.
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: PNPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });

    // Exactly one spawn: the `npm prefix -g` comparison probe is global-npm
    // only, so a pnpm upgrade must not shell out to npm at all.
    expect(cp.calls).toHaveLength(1);
    expect(cp.calls[0].cmd).toBe("pnpm");
    expect(cp.calls[0].args).toEqual(["add", "-g", "@yawlabs/mcp@latest"]);

    cp.children[0].emit("close", 1);
    const warns = warnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toContain("pnpm add -g @yawlabs/mcp@latest");
    expect(warns[0][1]).not.toContain("EACCES");
  });

  it("names bun in the corrective command, and drops the sudo/EACCES hint", async () => {
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: BUN_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });

    expect(cp.calls).toHaveLength(1);
    expect(cp.calls[0].cmd).toBe("bun");
    expect(cp.calls[0].args).toEqual(["add", "-g", "@yawlabs/mcp@latest"]);

    cp.children[0].emit("close", 1);
    const warns = warnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toContain("bun add -g @yawlabs/mcp@latest");
    expect(warns[0][1]).not.toContain("EACCES");
  });

  it("never computes a --prefix for pnpm/bun -- the flag is npm-only", async () => {
    // detectRunningInstallPrefix WOULD return a prefix for this realpath;
    // the guard is on `method === "global-npm"`, not on the prefix being
    // resolvable. `pnpm add -g --prefix ...` is not a real pnpm flag.
    mockRealpathSync.mockReturnValue(PREFIXED_REALPATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: PNPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });
    expect(cp.calls).toHaveLength(1);
    expect(cp.calls[0].args).not.toContain("--prefix");
  });

  it("quotes a --prefix containing a space for the win32 shell, passes it through on POSIX", async () => {
    // Regression guard. defaultSpawn passes `shell: true` on win32 (npm is
    // npm.cmd and Node will not spawn a .cmd without a shell), and Node builds
    // the cmd.exe command line by joining argv on spaces WITHOUT quoting. An
    // unquoted prefix under a username with a space therefore reached npm as
    // TWO tokens -- `--prefix C:\Users\Jeff` plus a stray positional -- so the
    // install landed in the wrong tree and the running copy stayed stale: the
    // exact silent no-op `--prefix` exists to prevent. And
    // C:\Users\<First Last>\AppData\Roaming\npm is npm's DEFAULT Windows
    // global prefix, so this was not an edge case.
    const spaced = join(sep, "Users", "Jeff Smith", "AppData", "Roaming", "npm");
    mockRealpathSync.mockReturnValue(join(spaced, "node_modules", "@yawlabs", "mcp", "dist", "index.js"));

    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });

    // The comparison probe never reaches child_process under vitest, so the
    // install is the only recorded spawn.
    expect(cp.calls).toHaveLength(1);
    const install = cp.calls[cp.calls.length - 1];
    const onWin32 = process.platform === "win32";
    // Quoted only where a shell actually parses it. On POSIX the arg goes
    // through execve untouched and quoting would put literal quotes in the path.
    const expected = onWin32 ? `"${spaced}"` : spaced;
    expect(install.args).toEqual(["install", "-g", "--prefix", expected, "@yawlabs/mcp@latest"]);
    expect(install.opts.shell).toBe(onWin32);
    // The structured log field carries the RAW path, never the quoted argv
    // form: a log field is read by a human and stray quotes read as part of
    // the path. Only the spawn argv is quoted.
    expect(mockLog).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("upgrading the global install"),
      expect.objectContaining({ prefix: spaced }),
    );
  });

  it("releases the upgrade lock EXACTLY once when the child fires both error and close", async () => {
    // defaultSpawn's finish() guard, which nothing else covers: every other
    // test injects spawnImpl (so the real handlers never run) and
    // defaultAcquireLock short-circuits to a no-op release under vitest. An
    // ENOENT spawn fires BOTH handlers, and a second release unlinks whatever
    // lock has been taken since -- including another process's.
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
    const releaseSpy = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      acquireLockImpl: () => releaseSpy,
    });

    expect(cp.calls).toHaveLength(1);
    // Still installing: the lock is held until the child settles.
    expect(releaseSpy).not.toHaveBeenCalled();
    const child = cp.children[0];
    child.emit("error", new Error("spawn npm ENOENT"));
    child.emit("close", 1);
    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it("releases the lock (and warns) when the spawn throws synchronously", async () => {
    // The other untested half of the lock lifecycle. A synchronous throw never
    // reaches a close/error handler, so without the catch's release the lock
    // would sit held for the full ten-minute stale window -- suppressing the
    // next N startups' upgrade over a failure that already finished.
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
    cp.throwOnSpawn = new Error("EACCES: permission denied, spawn npm");
    const releaseSpy = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      acquireLockImpl: () => releaseSpy,
    });

    expect(releaseSpy).toHaveBeenCalledTimes(1);
    const warns = warnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toContain("could not start npm");
    expect(warns[0][2]).toEqual({ error: "EACCES: permission denied, spawn npm" });
  });

  it("drops --prefix entirely when the path cannot be safely quoted on win32", async () => {
    // A `"` or `%` cannot be quoted for cmd.exe -- a quote ends the quoted run
    // and %VAR% expands even inside quotes. Emitting a mangled command line is
    // worse than falling back to npm's own prefix resolution, so the flag is
    // dropped rather than guessed at. POSIX has no such restriction.
    const nasty = join(sep, "Users", 'we"ird%USERNAME%', "AppData", "Roaming", "npm");
    mockRealpathSync.mockReturnValue(join(nasty, "node_modules", "@yawlabs", "mcp", "dist", "index.js"));

    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
    });

    const install = cp.calls[cp.calls.length - 1];
    if (process.platform === "win32") {
      expect(install.args).toEqual(["install", "-g", "@yawlabs/mcp@latest"]);
    } else {
      expect(install.args).toEqual(["install", "-g", "--prefix", nasty, "@yawlabs/mcp@latest"]);
    }
  });

  it.each([
    ["npm", GLOBAL_NPM_PATH],
    ["pnpm", PNPM_PATH],
    ["bun", BUN_PATH],
  ])("spawns %s with yaw-mcp's own secrets STRIPPED from the child env (PATH survives)", async (tool, argvPath) => {
    // README tells the user to park YAW_MCP_VAULT_PASSPHRASE in yaw-mcp's own
    // env block because "yaw-mcp strips its own secrets from every child env".
    // The upstream spawn kept that promise; this spawn inherited process.env
    // whole, and npm runs every dependency's pre/postinstall with it -- so a
    // compromised transitive dependency's install script plus
    // ~/.yaw-mcp/secrets.json was the entire vault, with stdio ignored and
    // nothing logged.
    vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE", "hunter2");
    vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE_NEW", "hunter3");
    vi.stubEnv("YAW_MCP_TOKEN", "mcp_pat_stale");
    try {
      mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);
      await maybeAutoUpgrade({ currentVersion: "0.47.0", argvPath, fetchLatestImpl: async () => "0.47.8" });

      expect(cp.calls).toHaveLength(1);
      expect(cp.calls[0].cmd).toBe(tool);
      const env = cp.calls[0].opts.env as NodeJS.ProcessEnv | undefined;
      // An absent `env` option means "inherit process.env" -- the leaking shape.
      expect(env).toBeDefined();
      expect(env).not.toHaveProperty("YAW_MCP_VAULT_PASSPHRASE");
      expect(env).not.toHaveProperty("YAW_MCP_VAULT_PASSPHRASE_NEW");
      expect(env).not.toHaveProperty("YAW_MCP_TOKEN");
      // ...and it is a strip, not a blank env: the tool still has to be found.
      // The copy keeps process.env's own spelling of the key (`Path` on
      // Windows), so look it up the way the OS does.
      const pathKey = Object.keys(env ?? {}).find((k) => k.toUpperCase() === "PATH");
      expect(pathKey).toBeDefined();
      expect(env?.[pathKey as string]).toBe(process.env.PATH);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("compareWithNpmPrefix -- the multi-prefix warning", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetSpawnRecorder();
    // Spied only to prove the warning does NOT bypass the logger: everything
    // serve emits is one JSON line per event, and the four-line plain-text
    // blob this used to write straight to process.stderr was what a client or
    // operator parsing yaw-mcp's stderr tripped over.
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    resetSpawnRecorder();
    // Put the realpath mock back to the file-level factory default (identity)
    // so a per-test mapping installed by runWithProbe cannot leak into the
    // suites below.
    mockRealpathSync.mockImplementation((p) => String(p));
  });

  const rawStderrText = (): string => (stderrSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join("");

  /** The structured fields of every prefix-mismatch warn -- the only surface
   *  the warning has now that it goes through log(). */
  const prefixWarns = (): Array<Record<string, unknown> | undefined> =>
    warnCalls()
      .filter((c) => c[1].includes("running prefix differs"))
      .map((c) => c[2]);

  /** The comparison is fire-and-forget (`compareWithNpmPrefix(...).catch`),
   *  so maybeAutoUpgrade resolves before the probe's continuation logs. Drain
   *  the microtask + immediate queues before asserting. */
  const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

  /** Every case here needs the same three things: a resolvable prefix, an
   *  injected upgrade spawn (so no real npm install is recorded), and an
   *  injected `npm prefix -g` answer -- the shared probe short-circuits to null
   *  under vitest, so the real one can never answer here. */
  async function runWithProbe(npmPrefixImpl: () => Promise<string | null>, realpath = PREFIXED_REALPATH) {
    // Map ONLY argv[1] to its resolved install path; every other path resolves
    // to itself. compareWithNpmPrefix now realpaths BOTH sides through
    // upgrade-cmd's comparablePath, so a blanket mockReturnValue would collapse
    // the two prefixes onto one string and no comparison could ever differ.
    mockRealpathSync.mockImplementation((p) => (p === GLOBAL_NPM_PATH ? realpath : String(p)));
    const probe = vi.fn(npmPrefixImpl);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: vi.fn(),
      npmPrefixImpl: probe,
    });
    await settle();
    return probe;
  }

  it("logs ONE structured warn -- never a raw stderr write -- when `npm prefix -g` disagrees with the running prefix", async () => {
    const other = join(sep, "usr", "local");
    const probe = await runWithProbe(async () => other);

    expect(probe).toHaveBeenCalledTimes(1);
    // No `npm prefix -g` child: the probe is upgrade-cmd's shared helper, which
    // never spawns under vitest. The only spawn arm here is injected too.
    expect(cp.calls).toHaveLength(0);
    // The two paths ride as fields, not as lines of prose inside the message.
    expect(prefixWarns()).toEqual([{ running: DETECTED_PREFIX, npmPrefix: other }]);
    // The logger is mocked in this file, so anything about the prefix on the
    // REAL stderr is the unstructured blob coming back.
    expect(rawStderrText()).not.toContain("running prefix");
  });

  it("stays quiet when the two prefixes agree", async () => {
    await runWithProbe(async () => DETECTED_PREFIX);
    expect(prefixWarns()).toHaveLength(0);
  });

  it("stays quiet when the probe cannot answer (spawn failure / non-zero exit / 3s timeout)", async () => {
    // All three failure shapes collapse to null in npmGlobalPrefix, and null
    // must skip the warning rather than compare against an empty string.
    await runWithProbe(async () => null);
    expect(prefixWarns()).toHaveLength(0);
    // Blank output is the same non-answer.
    await runWithProbe(async () => "   ");
    expect(prefixWarns()).toHaveLength(0);
  });

  it("swallows a REJECTING probe instead of surfacing it as an unhandled rejection inside serve", async () => {
    // The default probe never rejects, but the hook is caller-supplied and the
    // comparison is fire-and-forget: without a rejection sink on that promise
    // a throwing probe became an unhandled rejection, which Node terminates
    // the process on -- the serve process, mid-startup.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const probe = await runWithProbe(async () => {
        throw new Error("npm prefix -g exploded");
      });
      expect(probe).toHaveBeenCalledTimes(1);
      // A second drain: Node reports an unhandled rejection a macrotask after
      // the microtask that left it unhandled.
      await settle();
      expect(rejections).toEqual([]);
      expect(prefixWarns()).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("compares the RAW prefix, not the shell-quoted argv form", async () => {
    // Regression guard for the spaced-username case. The prefix handed to the
    // spawn is quoted for cmd.exe (`"C:\Users\Jeff Smith\..."`); comparing THAT
    // against npm's unquoted answer can never match, so every startup on npm's
    // DEFAULT Windows global prefix warned about a multi-prefix setup the user
    // does not have. Real assertion on win32; on POSIX quoting is a no-op, so
    // the case is trivially true there and the test just documents intent.
    const spaced = join(sep, "Users", "Jeff Smith", "AppData", "Roaming", "npm");
    const realpath = join(spaced, "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    await runWithProbe(async () => spaced, realpath);
    expect(prefixWarns()).toHaveLength(0);

    // And when they genuinely differ, the field carries the raw path -- a
    // diagnostic with stray quotes in it reads as part of the filename.
    const other = join(sep, "opt", "node");
    await runWithProbe(async () => other, realpath);
    expect(prefixWarns()).toEqual([{ running: spaced, npmPrefix: other }]);
  });

  it("treats a case-differing prefix as the SAME prefix on win32 (and as different on POSIX)", async () => {
    // Windows paths are case-insensitive, so npm reporting a lowercased prefix
    // is not a multi-prefix setup. POSIX paths are case-sensitive, so there the
    // difference is real and must still warn.
    await runWithProbe(async () => DETECTED_PREFIX.toUpperCase());
    expect(prefixWarns()).toHaveLength(process.platform === "win32" ? 0 : 1);
  });

  it("treats a junction/symlink prefix and its target as the SAME prefix", async () => {
    // The regression this exists for: the comparator used to trim+lowercase
    // only, while the detected prefix comes from a REALPATH-resolved argv[1].
    // On a scoop-style layout (`.../current` is a junction into `.../1.2.3`)
    // npm reports the junction name and the walk reports the target, so the
    // two names for ONE directory read as two prefixes and every stale startup
    // warned about a multi-prefix setup the user does not have. Both sides now
    // go through upgrade-cmd's comparablePath, which realpaths first.
    const junction = join(sep, "scoop", "apps", "nodejs", "current");
    const target = join(sep, "scoop", "apps", "nodejs", "22.1.0");
    const realpath = join(target, "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    mockRealpathSync.mockImplementation((p) => {
      if (p === GLOBAL_NPM_PATH) return realpath;
      if (p === junction) return target; // the junction resolves to its target
      return String(p);
    });
    const probe = vi.fn(async () => junction);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: vi.fn(),
      npmPrefixImpl: probe,
    });
    await settle();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(prefixWarns()).toHaveLength(0);
  });

  it("still warns when two prefixes resolve to genuinely different directories", async () => {
    // The other half of the realpath change: resolving must not swallow a
    // REAL multi-prefix setup, which is the whole point of the warning.
    // Not DETECTED_PREFIX, and not a junction into it -- a second real tree.
    const other = join(sep, "usr", "local");
    mockRealpathSync.mockImplementation((p) => (p === GLOBAL_NPM_PATH ? PREFIXED_REALPATH : String(p)));
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: vi.fn(),
      npmPrefixImpl: async () => other,
    });
    await settle();

    expect(prefixWarns()).toEqual([{ running: DETECTED_PREFIX, npmPrefix: other }]);
  });

  it("never probes when the prefix could not be quoted (no --prefix was passed)", async () => {
    // With the flag dropped, npm resolves its own prefix -- so the warning's
    // claim ("installing into the running prefix") would be false, and the
    // probe is skipped entirely rather than emitting a misleading diagnostic.
    const nasty = join(sep, "Users", 'we"ird%USERNAME%', "AppData", "Roaming", "npm");
    const probe = await runWithProbe(
      async () => join(sep, "opt", "node"),
      join(nasty, "node_modules", "@yawlabs", "mcp", "dist", "index.js"),
    );
    if (process.platform === "win32") {
      expect(probe).not.toHaveBeenCalled();
      expect(prefixWarns()).toHaveLength(0);
    } else {
      // POSIX has no unquotable path, so the prefix survives and the probe runs.
      expect(probe).toHaveBeenCalledTimes(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Stale-install advice for the methods nothing can be spawned for. The log
// IS the whole user-facing surface here, so the text is the contract: it has
// to name a command that actually works for that method.
// ═══════════════════════════════════════════════════════════════════════

describe("maybeAutoUpgrade -- advice for the non-spawnable methods", () => {
  beforeEach(resetSpawnRecorder);
  afterEach(resetSpawnRecorder);

  /** The single "out of date" info log, asserted to be the only one. */
  function adviceLog(): [string, string, Record<string, unknown> | undefined] {
    const infos = mockLog.mock.calls.filter((c) => c[0] === "info" && String(c[1]).includes("out of date"));
    expect(infos).toHaveLength(1);
    return infos[0] as [string, string, Record<string, unknown> | undefined];
  }

  async function adviseFor(argvPath: string): Promise<[string, string, Record<string, unknown> | undefined]> {
    mockRealpathSync.mockReturnValue(argvPath);
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({ currentVersion: "0.47.0", argvPath, fetchLatestImpl: async () => "0.47.8", spawnImpl });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(cp.calls).toHaveLength(0);
    return adviceLog();
  }

  it("points a local-node-modules install at `upgrade --run`, which really can upgrade it", async () => {
    // upgrade-cmd builds a runSpec for local-node-modules (npm install in the
    // tree root), so --run is honest advice here.
    const [, message, fields] = await adviseFor(LOCAL_NODE_MODULES_PATH);
    expect(message).toContain("yaw-mcp upgrade --run");
    // The old wording called a project's node_modules tree a "global".
    expect(message).not.toContain("global");
    expect(fields).toMatchObject({ method: "local-node-modules" });
  });

  it("points an unknown install at plain `upgrade` -- `--run` always exits 2 there", async () => {
    // runUpgrade leaves runSpec null for unknown, so --run hits the "can't be
    // upgraded automatically" arm and exits 2. Advertising it was a dead end
    // (a bunx launch, say: its path has no node_modules segment at all).
    const [, message, fields] = await adviseFor(UNKNOWN_PATH);
    expect(message).toContain("yaw-mcp upgrade");
    // The dead-end instruction is what must be gone: `--run` may only appear as
    // the thing that CANNOT work, never as the command to type.
    expect(message).not.toContain("yaw-mcp upgrade --run");
    expect(message).toContain("can't automate");
    expect(fields).toMatchObject({ method: "unknown" });
  });

  it("points a dev-checkout install at plain `upgrade` too (same exit-2 arm)", async () => {
    const [, message, fields] = await adviseFor("/home/u/yaw-mcp/dist/index.js");
    expect(message).not.toContain("yaw-mcp upgrade --run");
    expect(fields).toMatchObject({ method: "dev-checkout" });
  });

  it("never spawns `npm install -g --prefix <repo>/packages` for a workspace package named `lib`", async () => {
    // The bare `/lib/node_modules/` marker classified this as global-npm, and
    // detectRunningInstallPrefix strips the trailing `/lib` -- so the background
    // child became `npm install -g --prefix <repo>/packages`, writing a global
    // tree plus bin shims into the user's repo over the workspace-pinned copy.
    const [, , fields] = await adviseFor("/home/u/repo/packages/lib/node_modules/@yawlabs/mcp/dist/index.js");
    expect(fields).toMatchObject({ method: "local-node-modules" });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// fetchLatestVersion -- the built-in registry probe used when the caller
// injects no fetchLatestImpl. Every failure shape must degrade to "no
// upgrade this session", never to a spawn against a bogus version.
// ═══════════════════════════════════════════════════════════════════════

/** Minimal duck-typed stand-in for the two members fetchLatestVersion uses. */
function fakeResponse(ok: boolean, json: () => Promise<unknown>): Response {
  return { ok, json } as unknown as Response;
}

describe("fetchLatestVersion -- the built-in registry probe", () => {
  beforeEach(resetSpawnRecorder);

  afterEach(() => {
    vi.unstubAllGlobals();
    resetSpawnRecorder();
  });

  it("requests @yawlabs/mcp/latest with an abort signal, and upgrades on a newer version", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { headers?: Record<string, string>; signal?: AbortSignal }) =>
      fakeResponse(true, async () => ({ version: "0.47.8" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);

    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({ currentVersion: "0.47.0", argvPath: GLOBAL_NPM_PATH, spawnImpl });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://registry.npmjs.org/@yawlabs/mcp/latest");
    expect(init.headers).toEqual({ accept: "application/json" });
    // The 3s AbortController is what keeps a hung registry off the serve
    // hot path; without a signal the check could stall startup indefinitely.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(spawnImpl).toHaveBeenCalledWith("npm", ["install", "-g", "@yawlabs/mcp@latest"], RELEASE_LOCK);
  });

  it.each([
    ["a non-2xx response", () => fakeResponse(false, async () => ({ version: "0.47.8" }))],
    ["a body with no version field", () => fakeResponse(true, async () => ({}))],
    ["a body whose version is not a string", () => fakeResponse(true, async () => ({ version: 47 }))],
    [
      "a body that is not JSON",
      () =>
        fakeResponse(true, async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        }),
    ],
  ])("does not spawn on %s", async (_label, make) => {
    const fetchMock = vi.fn(async () => make());
    vi.stubGlobal("fetch", fetchMock);
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);

    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({ currentVersion: "0.47.0", argvPath: GLOBAL_NPM_PATH, spawnImpl });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(cp.calls).toHaveLength(0);
  });

  it("does not spawn (and does not reject) when fetch itself throws -- offline / aborted", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    });
    vi.stubGlobal("fetch", fetchMock);
    mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);

    const spawnImpl = vi.fn();
    await expect(
      maybeAutoUpgrade({ currentVersion: "0.47.0", argvPath: GLOBAL_NPM_PATH, spawnImpl }),
    ).resolves.toBeUndefined();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("YAW_MCP_AUTO_UPGRADE=0 makes NO network call and spawns NO child -- the opt-out is total", async () => {
    // The three existing opt-out tests all inject both hooks, so they can
    // only prove the injected fns went uncalled. This one leaves the real
    // fetch + real spawn in place, which is what a pinned-version or
    // sudo-installed user is actually opting out of.
    const prev = process.env.YAW_MCP_AUTO_UPGRADE;
    process.env.YAW_MCP_AUTO_UPGRADE = "0";
    try {
      const fetchMock = vi.fn(async () => fakeResponse(true, async () => ({ version: "9.9.9" })));
      vi.stubGlobal("fetch", fetchMock);
      mockRealpathSync.mockReturnValue(NO_PREFIX_REALPATH);

      await maybeAutoUpgrade({ currentVersion: "0.47.0", argvPath: GLOBAL_NPM_PATH });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(cp.calls).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.YAW_MCP_AUTO_UPGRADE;
      else process.env.YAW_MCP_AUTO_UPGRADE = prev;
    }
  });

  it("an unbuilt dev checkout short-circuits before the registry probe", async () => {
    // Same class as the opt-out above: the existing dev-checkout test
    // injects fetchLatestImpl, so it cannot show that the REAL fetch is
    // skipped for a version of "dev".
    const fetchMock = vi.fn(async () => fakeResponse(true, async () => ({ version: "9.9.9" })));
    vi.stubGlobal("fetch", fetchMock);
    await maybeAutoUpgrade({ currentVersion: "dev", argvPath: GLOBAL_NPM_PATH });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cp.calls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// acquireUpgradeLock -- the prefix lockfile that serializes concurrent
// background installs.
//
// The realistic trigger is N Claude Code panes starting at once: each serve
// process independently detects the same staleness and, before the lock,
// each fired its own `npm install -g` into the same prefix. npm's cache lock
// made that slow rather than corrupting, but nothing made it SAFE.
//
// These run against a real temp directory (node:fs is only stubbed for
// realpathSync), because the whole primitive is openSync(path, "wx") and a
// mocked fs would test the mock.
// ═══════════════════════════════════════════════════════════════════════

describe("acquireUpgradeLock", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-lock-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const lockFile = (): string => join(dir, ".yaw-mcp-upgrade.lock");

  it("hands the first caller a release and refuses the second", () => {
    const first = acquireUpgradeLock(dir);
    expect(first).toBeTypeOf("function");
    expect(existsSync(lockFile())).toBe(true);

    // The second serve process starting against the same prefix.
    expect(acquireUpgradeLock(dir)).toBeNull();
  });

  it("frees the lock on release so the next process can take it", () => {
    const release = acquireUpgradeLock(dir);
    release?.();
    expect(existsSync(lockFile())).toBe(false);
    expect(acquireUpgradeLock(dir)).toBeTypeOf("function");
  });

  it("releases idempotently, so a double release cannot unlink someone else's lock", () => {
    const release = acquireUpgradeLock(dir);
    release?.();
    const second = acquireUpgradeLock(dir);
    // The first holder's release fires again (both spawn handlers can call it).
    release?.();
    // The SECOND holder still owns a live lock file.
    expect(second).toBeTypeOf("function");
    expect(existsSync(lockFile())).toBe(true);
  });

  it("never unlinks a lock another process has since taken (no steal cascade)", () => {
    // The idempotence flag only sees THIS process's releases. If our lock goes
    // stale and another process steals it, an unconditional unlink on release
    // deletes the NEW holder's lock -- cascading the steal down the line, the
    // exact outcome the idempotence guard is supposed to prevent. The release
    // reads back the pid it wrote and leaves anything else alone.
    const release = acquireUpgradeLock(dir);
    const newHolder = `${process.pid + 1}\n`;
    writeFileSync(lockFile(), newHolder); // stolen as stale, then retaken
    release?.();

    expect(existsSync(lockFile())).toBe(true);
    expect(readFileSync(lockFile(), "utf8")).toBe(newHolder);
    // ...and the new holder's lock is still honoured by the next caller.
    expect(acquireUpgradeLock(dir)).toBeNull();
  });

  it("steals a fresh lock whose holder process no longer exists", () => {
    // An MCP client that kills `serve` mid-refresh leaves a lock with a live
    // mtime and a dead pid. The mtime rule alone honoured it for the full
    // stale window, refusing the documented recovery command with "try again
    // in a minute" for ten of them. The pid in the file is the tell.
    acquireUpgradeLock(dir);
    // A pid that cannot be running: far above any real pid space on every
    // supported OS, and never this process.
    writeFileSync(lockFile(), `${2 ** 31 - 2}\n`);
    const stolen = acquireUpgradeLock(dir);
    expect(stolen).toBeTypeOf("function");
    // The new holder's own pid is now on file, so its release is recognised.
    expect(readFileSync(lockFile(), "utf8").trim()).toBe(String(process.pid));
  });

  it("keeps honouring a fresh lock whose holder is alive (this process stands in)", () => {
    // Positive control for the test above: a live pid with a fresh mtime is
    // still contention, so the liveness probe cannot have turned every held
    // lock into a stealable one.
    acquireUpgradeLock(dir);
    expect(acquireUpgradeLock(dir)).toBeNull();
  });

  it("honours a fresh lock whose holder cannot be parsed, letting the mtime rule bound the wait", () => {
    acquireUpgradeLock(dir);
    writeFileSync(lockFile(), "not-a-pid\n");
    expect(acquireUpgradeLock(dir)).toBeNull();
  });

  it("records the attempt in a tmpdir fallback when the prefix is unwritable, so a cached check cannot re-spawn every start", () => {
    // The sudo-installed-global class: the check memo (tmpdir) caches the
    // registry answer, the attempt memo could not land in the root-owned
    // prefix, and the lock hands back a no-op release -- so before the
    // fallback, EVERY serve start within the check window spawned a doomed
    // `npm install -g`. A prefix that does not exist stands in for EACCES:
    // writeFileSync fails the same way, and no test may chmod a real dir.
    // The fallback dir is injected: the production default is the machine's
    // tmpdir, which no unit test may write into.
    const fallback = join(dir, "fallback-tmp");
    mkdirSync(fallback);
    const unwritable = join(dir, "no-such-prefix");
    recordAttemptAt(unwritable, ".yaw-mcp-upgrade.lock", "0.47.8", fallback);
    expect(existsSync(join(unwritable, ".yaw-mcp-upgrade.lock.attempt"))).toBe(false);
    expect(readdirSync(fallback).filter((f) => f.startsWith(".yaw-mcp-upgrade-attempt-"))).toHaveLength(1);
    expect(attemptedRecentlyAt(unwritable, ".yaw-mcp-upgrade.lock", "0.47.8", fallback)).toBe(true);
    // Keyed on the version: a memo for one target says nothing about another.
    expect(attemptedRecentlyAt(unwritable, ".yaw-mcp-upgrade.lock", "0.47.9", fallback)).toBe(false);
    // And scoped to the prefix: a different unwritable prefix has no memo.
    expect(attemptedRecentlyAt(join(dir, "other-prefix"), ".yaw-mcp-upgrade.lock", "0.47.8", fallback)).toBe(false);
  });

  it("prefers the in-prefix attempt memo when the prefix is writable, touching no fallback", () => {
    const fallback = join(dir, "fallback-tmp");
    mkdirSync(fallback);
    recordAttemptAt(dir, ".yaw-mcp-upgrade.lock", "0.47.8", fallback);
    expect(existsSync(join(dir, ".yaw-mcp-upgrade.lock.attempt"))).toBe(true);
    expect(readdirSync(fallback)).toEqual([]);
    expect(attemptedRecentlyAt(dir, ".yaw-mcp-upgrade.lock", "0.47.8", fallback)).toBe(true);
  });

  it("steals a lock left behind by a killed process once it goes stale", () => {
    acquireUpgradeLock(dir);
    // Backdate the FILE rather than steering the clock: acquireUpgradeLock
    // reads Date.now() itself and takes no `now` argument. mtimeMs also carries
    // sub-millisecond precision while Date.now() is truncated, so a fixture
    // built as `Date.now() + STALE + 1` sits a fraction of a millisecond
    // INSIDE the threshold often enough to flake.
    const stale = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lockFile(), stale, stale);
    expect(acquireUpgradeLock(dir)).toBeTypeOf("function");

    // ...and still refuses while the lock is merely OLD, not stale.
    const recent = new Date(Date.now() - 60 * 1000);
    utimesSync(lockFile(), recent, recent);
    expect(acquireUpgradeLock(dir)).toBeNull();
  });

  it("steals a lock stamped in the FUTURE (clock stepped backwards)", () => {
    acquireUpgradeLock(dir);
    // A future mtime cannot belong to a live process on this clock; honouring
    // it would suppress every upgrade until wall-clock caught up.
    const future = new Date(Date.now() + 60 * 60 * 1000);
    utimesSync(lockFile(), future, future);
    expect(acquireUpgradeLock(dir)).toBeTypeOf("function");
  });

  describe("the steal is by rename, so two stealers cannot both win", () => {
    // Two processes that both read the lock as stale used to both unlinkSync
    // it. A successful unlink cannot tell "I removed the stale file" from "I
    // removed the file the OTHER stealer just took": A unlinks and retakes, B's
    // unlink then removes A's fresh lock and B's take succeeds too -- two
    // concurrent installs into one prefix, the outcome the lock exists to
    // prevent. A rename of the stale inode can succeed exactly once, and the
    // loser sees ENOENT. Each case below interleaves "the other stealer" (A)
    // into THIS process's (B's) steal through the wrapped renameSync: the real
    // rename runs, with A's move slotted in just before it.
    const STALE = new Date(Date.now() - 11 * 60 * 1000);
    const staleLock = (): void => {
      acquireUpgradeLock(dir);
      utimesSync(lockFile(), STALE, STALE);
    };
    const otherPid = `${process.pid + 1}\n`;
    const staleLeftovers = (): string[] => readdirSync(dir).filter((f) => f.includes(".stale-"));
    const enoent = (): NodeJS.ErrnoException => {
      const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return err;
    };

    afterEach(() => {
      // mockReset restores the implementation vi.fn was created with (the real
      // renameSync) and drops any *Once a failed assertion left unconsumed.
      mockRenameSync.mockReset();
    });

    it("leaves no `.stale-<pid>` file behind after an uncontended steal", () => {
      staleLock();
      const release = acquireUpgradeLock(dir);
      expect(release).toBeTypeOf("function");
      expect(readFileSync(lockFile(), "utf8").trim()).toBe(String(process.pid));
      expect(staleLeftovers()).toEqual([]);
      release?.();
      expect(existsSync(lockFile())).toBe(false);
    });

    it("gives the lock back and yields when the file it moved is another stealer's FRESH retake", () => {
      // B's view of the race: stale at the stat, but by the time B renames, A
      // has already stolen the stale file and retaken the path. B's rename
      // therefore moves A's LIVE lock -- the one thing an unlink-based steal
      // could never notice. B must put it back under A's own pid (so A's
      // ownership-checked release still recognises it) and yield.
      staleLock();
      mockRenameSync.mockImplementationOnce((from, to) => {
        unlinkSync(String(from));
        writeFileSync(String(from), otherPid); // A's retake: fresh mtime, A's pid
        renameSync(from, to); // ...and B's real rename now moves A's lock
      });

      expect(acquireUpgradeLock(dir)).toBeNull();
      expect(readFileSync(lockFile(), "utf8")).toBe(otherPid);
      expect(staleLeftovers()).toEqual([]);
      // ...and A's restored lock keeps its force: the next caller yields too.
      expect(acquireUpgradeLock(dir)).toBeNull();
    });

    it("retakes the freed path once when the other stealer's rename won (ENOENT) and it has not retaken yet", () => {
      staleLock();
      mockRenameSync.mockImplementationOnce((from) => {
        unlinkSync(String(from)); // A's rename already moved it away
        throw enoent();
      });

      const release = acquireUpgradeLock(dir);
      expect(release).toBeTypeOf("function");
      expect(readFileSync(lockFile(), "utf8").trim()).toBe(String(process.pid));
      expect(staleLeftovers()).toEqual([]);
      release?.();
    });

    it("yields when the other stealer's rename won (ENOENT) and it already holds a fresh lock", () => {
      staleLock();
      mockRenameSync.mockImplementationOnce((from) => {
        unlinkSync(String(from));
        writeFileSync(String(from), otherPid); // A won the steal AND retook the path
        throw enoent();
      });

      expect(acquireUpgradeLock(dir)).toBeNull();
      expect(readFileSync(lockFile(), "utf8")).toBe(otherPid);
    });

    it("yields on any other rename failure -- whoever holds the path now owns it", () => {
      staleLock();
      mockRenameSync.mockImplementationOnce(() => {
        const err = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      });
      expect(acquireUpgradeLock(dir)).toBeNull();
      // Nothing was moved, so the stale file is still there for the next steal.
      expect(existsSync(lockFile())).toBe(true);
    });
  });

  it("does NOT block the upgrade when the lock cannot be created at all", () => {
    // Read-only prefix, EACCES, a prefix that does not exist: locking is
    // best-effort, so an un-lockable directory yields a no-op release and the
    // caller proceeds exactly as it did before the lock existed. Only a live
    // EEXIST means "someone else has this".
    const release = acquireUpgradeLock(join(dir, "does", "not", "exist"));
    expect(release).toBeTypeOf("function");
    expect(() => release?.()).not.toThrow();
  });
});

describe("maybeAutoUpgrade -- lock contention", () => {
  beforeEach(resetSpawnRecorder);
  afterEach(resetSpawnRecorder);

  it("skips the background install entirely when another process holds the lock", async () => {
    const spawnImpl = vi.fn();
    const acquireLockImpl = vi.fn(() => null);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
      acquireLockImpl,
    });

    expect(acquireLockImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).not.toHaveBeenCalled();
    // The skip is logged, and deliberately does NOT claim an upgrade is running.
    const skips = mockLog.mock.calls.filter((c) => String(c[1]).includes("already upgrading this install"));
    expect(skips).toHaveLength(1);
    expect(mockLog.mock.calls.some((c) => String(c[1]).includes("upgrading the global install"))).toBe(false);
  });

  it("locks the DETECTED running prefix, not npm's configured one", async () => {
    // The lock has to live where the install actually lands, or two processes
    // installing into the same tree through different prefix names miss it.
    // With a prefix of its own to lock, the file keeps the plain default name
    // (sidecar-refresh.ts hardcodes that name for its mtime heartbeat).
    const acquireLockImpl = vi.fn((_dir: string, _lockName: string) => () => {});
    mockRealpathSync.mockReturnValueOnce(GLOBAL_NPM_PATH);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: vi.fn(),
      acquireLockImpl,
    });
    expect(acquireLockImpl).toHaveBeenCalledWith(GLOBAL_NPM_PREFIX, ".yaw-mcp-upgrade.lock");
  });

  it("scopes the tmpdir fallback lock by tool and user -- not one lock for the whole machine", async () => {
    // pnpm/bun never get a detected prefix (that walk is global-npm only), so
    // they fall back to tmpdir. With a fixed filename, pnpm, bun and a
    // prefix-less global npm all contended on ONE
    // `${tmpdir()}/.yaw-mcp-upgrade.lock` -- and on a shared POSIX box another
    // user's lock could be neither taken (EEXIST, not ours) nor stolen (EPERM).
    const acquireLockImpl = vi.fn((_dir: string, _lockName: string) => () => {});
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: PNPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: vi.fn(),
      acquireLockImpl,
    });
    const scopedName = `.yaw-mcp-upgrade-pnpm-${process.getuid?.() ?? "win"}.lock`;
    expect(acquireLockImpl).toHaveBeenCalledWith(tmpdir(), scopedName);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The two throttle memos. Both defaults short-circuit under vitest (same
// guard as defaultAcquireLock -- no unit test may write a memo into a real
// tmpdir or global prefix, or inherit one an earlier test left), so the
// wiring is what these pin: WHEN each memo is consulted and recorded.
// ═══════════════════════════════════════════════════════════════════════

describe("maybeAutoUpgrade -- check + attempt throttles", () => {
  beforeEach(resetSpawnRecorder);
  afterEach(resetSpawnRecorder);

  it("skips the registry probe when a check ran recently, and STILL evaluates staleness from the cached answer", async () => {
    // The lock is taken long AFTER the fetch, so it never covered it: without
    // this memo every serve start hits registry.npmjs.org. But the memo is
    // keyed by uid alone, and it used to be a bare "checked recently" that
    // returned before any plan: a copy that cannot act on staleness (Yaw
    // Terminal's bundled copy, an npx run) restarting within the hour re-armed
    // it every time, and a stale global-npm copy on the same machine never
    // evaluated itself at all. The memo carries the ANSWER now, and a cached
    // answer goes through the same plan a fresh fetch would.
    const fetchLatestImpl = vi.fn(async () => "9.9.9");
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl,
      spawnImpl,
      checkedRecentlyImpl: () => ({ latest: "0.47.8" }),
    });

    expect(fetchLatestImpl).not.toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledWith("npm", GLOBAL_NPM_ARGS, RELEASE_LOCK);
  });

  it("a cached up-to-date answer skips both the probe and the spawn", async () => {
    const fetchLatestImpl = vi.fn(async () => "9.9.9");
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.8",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl,
      spawnImpl,
      checkedRecentlyImpl: () => ({ latest: "0.47.8" }),
    });
    expect(fetchLatestImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("honours a cached 'unreachable' answer (latest: null) -- no re-probe of an offline registry every start", async () => {
    const fetchLatestImpl = vi.fn(async () => "0.47.8");
    const spawnImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl,
      spawnImpl,
      checkedRecentlyImpl: () => ({ latest: null }),
    });
    expect(fetchLatestImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("records the check WITH its answer, whichever way it went", async () => {
    const recordCheckImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: vi.fn(),
      recordCheckImpl,
    });
    expect(recordCheckImpl).toHaveBeenCalledWith("0.47.8");

    // An unreachable registry is an answer too: re-probing it on each start is
    // the same waste the memo exists to stop.
    recordCheckImpl.mockClear();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => null,
      spawnImpl: vi.fn(),
      recordCheckImpl,
    });
    expect(recordCheckImpl).toHaveBeenCalledWith(null);
  });

  it("does not re-record a check it answered from the cache", async () => {
    const recordCheckImpl = vi.fn();
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl: vi.fn(),
      checkedRecentlyImpl: () => ({ latest: "0.47.8" }),
      recordCheckImpl,
    });
    expect(recordCheckImpl).not.toHaveBeenCalled();
  });

  it("does not re-spawn an upgrade already attempted at the same target version", async () => {
    // A permanently failing install (EACCES on a sudo-installed global) would
    // otherwise re-run a full `npm install -g` on every single serve start.
    const spawnImpl = vi.fn();
    const acquireLockImpl = vi.fn((_dir: string, _lockName: string) => () => {});
    const attemptedRecentlyImpl = vi.fn((_dir: string, _lockName: string, _version: string) => true);
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
      acquireLockImpl,
      attemptedRecentlyImpl,
    });

    expect(attemptedRecentlyImpl).toHaveBeenCalledWith(GLOBAL_NPM_PREFIX, ".yaw-mcp-upgrade.lock", "0.47.8");
    expect(spawnImpl).not.toHaveBeenCalled();
    // And no lock is taken for work we were never going to do -- holding it
    // would make every other pane skip for nothing.
    expect(acquireLockImpl).not.toHaveBeenCalled();
  });

  it("records the attempt (keyed on the target version) BEFORE spawning", async () => {
    // Before, not after: the failures this memo exists for -- a torn-down
    // process tree, a synchronous spawn throw -- never reach a completion
    // handler that could record anything.
    // Recorded as an order log rather than an assertion inside the spawn mock:
    // a throw from there lands in maybeAutoUpgrade's own catch, which would
    // turn a real ordering regression into a silent pass.
    const order: string[] = [];
    const recordAttemptImpl = vi.fn(() => {
      order.push("record");
    });
    const spawnImpl = vi.fn(() => {
      order.push("spawn");
    });
    await maybeAutoUpgrade({
      currentVersion: "0.47.0",
      argvPath: GLOBAL_NPM_PATH,
      fetchLatestImpl: async () => "0.47.8",
      spawnImpl,
      acquireLockImpl: () => () => {},
      recordAttemptImpl,
    });

    expect(order).toEqual(["record", "spawn"]);
    expect(recordAttemptImpl).toHaveBeenCalledWith(GLOBAL_NPM_PREFIX, ".yaw-mcp-upgrade.lock", "0.47.8");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The check memo's on-disk contract. The default hooks short-circuit under
// vitest, so the exported reader/writer are exercised here against a real
// temp file -- what a later process of ANY install method reads back.
// ═══════════════════════════════════════════════════════════════════════

describe("readCheckMemo / writeCheckMemo -- the on-disk check memo", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-mcp-check-memo-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const memo = (): string => join(dir, "check.json");

  it("round-trips the answer, a cached 'unreachable' (null) included", () => {
    writeCheckMemo(memo(), "0.47.8");
    expect(readCheckMemo(memo())).toEqual({ latest: "0.47.8" });
    writeCheckMemo(memo(), null);
    expect(readCheckMemo(memo())).toEqual({ latest: null });
  });

  it("does NOT honour the timestamp-only memo an older yaw-mcp wrote", () => {
    // `{ at }` with no `latest` is the exact shape that starved global-npm
    // copies: it says "checked recently" without saying what the check found,
    // and honouring it would skip the staleness evaluation for another hour.
    writeFileSync(memo(), `${JSON.stringify({ at: Date.now() })}\n`);
    expect(readCheckMemo(memo())).toBeNull();
  });

  it("expires after the check interval, and ignores a future-dated, malformed or absent memo", () => {
    writeFileSync(memo(), JSON.stringify({ at: Date.now() - 61 * 60 * 1000, latest: "0.47.8" }));
    expect(readCheckMemo(memo())).toBeNull();
    // Stepped clock: an `at` an hour ahead is not evidence of a recent check.
    writeFileSync(memo(), JSON.stringify({ at: Date.now() + 60 * 60 * 1000, latest: "0.47.8" }));
    expect(readCheckMemo(memo())).toBeNull();
    writeFileSync(memo(), "{not json");
    expect(readCheckMemo(memo())).toBeNull();
    writeFileSync(memo(), JSON.stringify({ at: Date.now(), latest: 47 }));
    expect(readCheckMemo(memo())).toBeNull();
    expect(readCheckMemo(join(dir, "absent.json"))).toBeNull();
  });
});
