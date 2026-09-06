import { chmodSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_OS } from "../install-targets.js";
import {
  compareVersions,
  createProbeCollector,
  isOamCommand,
  isOamLaunch,
  isRegistrySpec,
  MIN_OAM_VERSION,
  nodeLaunchKind,
  npmCacheDir,
  npxCacheNodeModules,
  npxSpec,
  npxSpecIndex,
  OAM_INSTALL_PS1,
  OAM_INSTALL_SH,
  OAM_PROBE_TIMEOUT_MS,
  oamFailureLabel,
  oamHeapOomHint,
  oamInstallAdvice,
  oamNoBinaryReason,
  oamPublishesBinaryFor,
  oamPublishesBinaryForThisMachine,
  packageName,
  parseOamVersion,
  probeOam,
  resetNpmCacheDir,
  resetOamBinCache,
  resetPinnedSidecarLog,
  resolveBinAbsolute,
  resolveNpmEntry,
  resolveOamSpawn,
  resolveStableNpmEntry,
  rewriteForOam,
  specConstraint,
  winNormalize,
} from "../oam-spawn.js";

// isExecutableFile (oam-spawn.ts) asks the REAL filesystem two questions --
// statSync for "is this a regular file", accessSync(X_OK) for "would the loader
// run it" -- and the two POSIX-side branches of resolveBinAbsolute need
// fixtures a Windows runner cannot stage for either one. A ':'-joined PATH
// cannot carry a drive-lettered temp path (it splits at the drive letter), and
// X_OK is a no-op on Windows -- Node degrades it to F_OK -- so a chmod 0644
// file still reads as executable there. Both tests were skipIf(win32) for that
// reason, which in this repo meant they ran NOWHERE: there are no CI legs, and
// release.sh runs the suite on the Windows machine that cuts the release.
//
// So the DISK is injected, not the decision. Only statSync/accessSync answers
// for paths under SYNTH_ROOT come from the map below; every other path passes
// straight through to node:fs, which is load-bearing -- almost every other
// fixture in this file is a real temp dir. resolveBinAbsolute and
// isExecutableFile run unmodified, including isExecutableFile's own
// `platform !== "win32"` gate and its everything-is-"not the binary" catch, so
// the assertions still measure the search rather than a stub of it. accessLog
// records the X_OK calls the staged paths receive, which lets the tests pin the
// DECISION -- X_OK demanded off Windows, never asked for on it -- and not just
// its outcome.
const { SYNTH_ROOT, fsKey, fsEntries, accessLog } = vi.hoisted(() => ({
  SYNTH_ROOT: "/yaw-mcp-synthetic-posix",
  // node:path is platform-NATIVE: a POSIX-shaped path run through join() comes
  // back backslashed on a Windows runner. Both the map keys and the lookups
  // are folded to forward slashes so the two spellings of one staged path
  // cannot disagree.
  fsKey: (p: string) => p.replace(/\\/g, "/"),
  fsEntries: new Map<string, "exec" | "noexec">(),
  accessLog: [] as { path: string; mode: number | undefined }[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  /** "exec"/"noexec" for a staged path, "absent" for an unstaged one under the
   *  synthetic root (the map is authoritative there, so a real directory of
   *  that name on the runner could not answer instead), and null for every
   *  real path -- which passes through untouched. */
  const staged = (target: unknown): "exec" | "noexec" | "absent" | null => {
    if (typeof target !== "string") return null;
    const key = fsKey(target);
    if (!key.startsWith(`${SYNTH_ROOT}/`)) return null;
    return fsEntries.get(key) ?? "absent";
  };
  const errno = (code: string, syscall: string, target: string): NodeJS.ErrnoException => {
    const err: NodeJS.ErrnoException = new Error(`${code}: injected fs failure, ${syscall} '${target}'`);
    err.code = code;
    return err;
  };
  const statSync = ((target: unknown, ...rest: unknown[]) => {
    const kind = staged(target);
    if (kind === null) return (actual.statSync as (...a: unknown[]) => unknown)(target, ...rest);
    if (kind === "absent") throw errno("ENOENT", "stat", String(target));
    // A staged path is always a regular FILE: the directory-shaped candidate is
    // covered by a real mkdir fixture (the "skips a DIRECTORY" test) and needs
    // no injection, so isFile() is the only thing the search asks of this.
    return { isFile: () => true, isDirectory: () => false };
  }) as unknown as typeof actual.statSync;
  const accessSync = ((target: unknown, mode?: number) => {
    const kind = staged(target);
    if (kind === null) return (actual.accessSync as (...a: unknown[]) => unknown)(target, mode);
    accessLog.push({ path: String(target), mode });
    if (kind === "absent") throw errno("ENOENT", "access", String(target));
    // EACCES on an X_OK request is exactly what a real chmod 0644 file answers
    // off Windows; anything weaker than X_OK (an F_OK existence check) still
    // succeeds, so the staged file is "there but not runnable", not "missing".
    if (kind === "noexec" && ((mode ?? actual.constants.F_OK) & actual.constants.X_OK) !== 0) {
      throw errno("EACCES", "access", String(target));
    }
    return undefined;
  }) as unknown as typeof actual.accessSync;
  return { ...actual, statSync, accessSync };
});

describe("winNormalize", () => {
  it("converts forward slashes to backslashes on Windows (cmd-safe)", () => {
    expect(winNormalize("C:/Users/jeff/oam/target/release/oam.exe", "win32")).toBe(
      "C:\\Users\\jeff\\oam\\target\\release\\oam.exe",
    );
  });
  it("leaves an already-backslash path untouched on Windows", () => {
    expect(winNormalize("C:\\Users\\jeff\\oam.exe", "win32")).toBe("C:\\Users\\jeff\\oam.exe");
  });
  it("leaves a bare binary name untouched", () => {
    expect(winNormalize("oam.exe", "win32")).toBe("oam.exe");
  });
  it("is a no-op off Windows", () => {
    expect(winNormalize("/usr/local/bin/oam", "linux")).toBe("/usr/local/bin/oam");
  });
});

describe("packageName", () => {
  it("strips @latest from a scoped package", () => {
    expect(packageName("@yawlabs/tailscale-mcp@latest")).toBe("@yawlabs/tailscale-mcp");
  });
  it("strips a semver from an unscoped package", () => {
    expect(packageName("server-memory@1.2.3")).toBe("server-memory");
  });
  it("leaves a bare scoped name untouched", () => {
    expect(packageName("@yawlabs/npmjs-mcp")).toBe("@yawlabs/npmjs-mcp");
  });
  it("leaves a bare unscoped name untouched", () => {
    expect(packageName("cowsay")).toBe("cowsay");
  });
});

// The rewrite can honour exactly one of the three things a spec suffix can be,
// so the classification decides whether a server hosts on oam at all.
describe("specConstraint", () => {
  it("treats no suffix and a dist-tag alike -- newest on disk is the closest answer", () => {
    expect(specConstraint("@yawlabs/fetch-mcp")).toEqual({ kind: "any" });
    expect(specConstraint("@yawlabs/fetch-mcp@latest")).toEqual({ kind: "any" });
    expect(specConstraint("some-mcp@next")).toEqual({ kind: "any" });
    expect(specConstraint("some-mcp@beta")).toEqual({ kind: "any" });
    // npm forbids a dist-tag that parses as semver, so a leading letter is the
    // reliable tell -- and an empty suffix ("pkg@") is not a constraint either.
    expect(specConstraint("some-mcp@")).toEqual({ kind: "any" });
  });

  it("reads a single version as an exact pin, prerelease and build included", () => {
    expect(specConstraint("some-mcp@1.2.3")).toEqual({ kind: "exact", version: "1.2.3" });
    expect(specConstraint("@yawlabs/fetch-mcp@0.2.0")).toEqual({ kind: "exact", version: "0.2.0" });
    expect(specConstraint("some-mcp@1.2.3-rc.1")).toEqual({ kind: "exact", version: "1.2.3-rc.1" });
    expect(specConstraint("some-mcp@1.2.3+build.5")).toEqual({ kind: "exact", version: "1.2.3+build.5" });
  });

  it("reads a range or partial as unverifiable, NOT as a tag", () => {
    // `^1.2.3` satisfied by an on-disk 0.9.0 is the same major-version jump the
    // exact case exists to prevent, and evaluating it properly would mean a
    // semver range parser this module has no dependency on. So it stays on npx.
    for (const raw of ["^1.2.3", "~1.2", "1.x", ">=2", "*", "1.2", "v1.2.3", "1.2.3 || 2.0.0"]) {
      expect(specConstraint(`some-mcp@${raw}`), raw).toEqual({ kind: "range", raw });
    }
  });
});

// Guards the on-disk lookup: a git/path spec is not a package NAME, and
// resolveNpmEntry would happily look one up as if it were. sidecars-cmd.ts and
// default-runtime.ts import this rather than carrying their own copies (the
// dedupe has happened), so this is the single place the rule is pinned and all
// three surfaces move together when it changes.
describe("isRegistrySpec", () => {
  it("accepts plain registry specs", () => {
    for (const ok of ["@yawlabs/fetch-mcp", "@yawlabs/fetch-mcp@latest", "cowsay", "server-memory@1.2.3"]) {
      expect(isRegistrySpec(ok), ok).toBe(true);
    }
  });

  it("rejects protocol and path specs, which npx accepts but a name lookup cannot", () => {
    for (const bad of ["github:owner/repo", "file:../x", "git+ssh://git@host/x.git", "./local-server", "~/x", "../x"]) {
      expect(isRegistrySpec(bad), bad).toBe(false);
    }
  });

  it("rejects a name npm itself refuses, since each one broke a different consumer", () => {
    // validate-npm-package-name's rule: every part must survive
    // encodeURIComponent unchanged. A backslash is a path separator to the
    // Windows lookup (the traversal the leading-character guard exists to
    // stop); `#`, `%`, `?` and a space land raw in the registry URL
    // sidecar-refresh builds from the name. Every one of these passed the old
    // "anything but a separator" shape.
    for (const bad of ["foo\\bar", "foo#bar", "foo%bar", "foo?bar", "foo bar", "@sc#ope/x", "@scope/_x"]) {
      expect(isRegistrySpec(bad), bad).toBe(false);
    }
    // ...without losing the punctuation npm does allow.
    for (const ok of ["some.pkg", "under_score-mcp", "@yaw-labs/x.y~z", "a-b@1.0.0"]) {
      expect(isRegistrySpec(ok), ok).toBe(true);
    }
  });
});

describe("parseOamVersion", () => {
  it("extracts x.y.z from the canonical `oam X.Y.Z` output", () => {
    expect(parseOamVersion("oam 0.6.0\n")).toBe("0.6.0");
  });
  it("extracts a bare x.y.z", () => {
    expect(parseOamVersion("1.2.3")).toBe("1.2.3");
  });
  it("returns null when no version is present", () => {
    expect(parseOamVersion("oam dev build")).toBeNull();
  });
  it("keeps a prerelease suffix, which an x.y.z-only capture silently dropped", () => {
    // Dropping it went wrong twice at once: the rc compared EQUAL to a 0.8.3
    // floor and was hosted, and doctor plus every oamVersion log line named a
    // release the machine does not have -- so a bug found on the rc gets filed
    // against the release.
    expect(parseOamVersion("oam 0.8.3-rc.1\n")).toBe("0.8.3-rc.1");
    expect(parseOamVersion("oam 0.9.0-dev.7")).toBe("0.9.0-dev.7");
  });
  it("keeps build metadata but stops at ordinary trailing punctuation", () => {
    expect(parseOamVersion("oam 1.2.3+abc.1")).toBe("1.2.3+abc.1");
    // The suffix groups require a literal "-"/"+", so a version at the end of a
    // sentence does not swallow the period.
    expect(parseOamVersion("built with oam 1.2.3.")).toBe("1.2.3");
  });
});

describe("probeOam min-version gate", () => {
  beforeEach(() => resetOamBinCache());
  afterEach(() => resetOamBinCache());

  it("reports a usable bin + version when at/above MIN_OAM_VERSION", async () => {
    const probe = await probeOam(async () => `oam ${MIN_OAM_VERSION}\n`);
    expect(probe.bin).not.toBeNull();
    expect(probe.version).toBe(MIN_OAM_VERSION);
    expect(probe.belowMin).toBe(false);
  });

  it("resolves binPath beside the version, which is what `install` persists", async () => {
    // The one production wiring from the probe to that field: install-targets'
    // buildLaunchEntry drops a non-absolute path back to npx, so a binPath that
    // stopped being resolved here would make `install` write the npx entry
    // while printing "Runtime: node (oam X runs here, but its absolute path
    // could not be resolved ... Set OAM_BIN ...)" -- sending the user to fix an
    // env var that is not the problem. Nothing else asserted this field on the
    // usable path, so the whole suite stayed green through that.
    const dir = mkdtempSync(join(tmpdir(), "probebin-"));
    const bin = join(dir, "oam");
    writeFileSync(bin, "");
    // Load-bearing off Windows only, where resolveBinAbsolute requires X_OK.
    chmodSync(bin, 0o755);
    const savedOamBin = process.env.OAM_BIN;
    process.env.OAM_BIN = bin;
    try {
      const probe = await probeOam(async () => `oam ${MIN_OAM_VERSION}\n`);
      expect(probe.binPath).toBe(winNormalize(bin, process.platform));
      // Both fields answer with the same string here: the absolute branch hands
      // back what it was given and winNormalize is idempotent. They diverge
      // only for a bare name, which is the case the field exists for.
      expect(probe.bin).toBe(probe.binPath);
    } finally {
      if (savedOamBin === undefined) delete process.env.OAM_BIN;
      else process.env.OAM_BIN = savedOamBin;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects the version immediately below the floor, whatever its shape", async () => {
    // Patch-level comparison decides this boundary whenever MIN_OAM_VERSION
    // ends in a non-zero patch -- a comparator that only weighed major.minor
    // would pass every other case here while hosting on a runtime with the
    // fatal request-stream bug the floor exists to exclude. Derived from the
    // constant so it tracks future bumps.
    //
    // The `.0` branch used to `return` before its first expect, which made the
    // whole test a green no-op the moment the floor bumped to a `.0` patch --
    // and the module's own policy says the floor moves on EVERY oam release.
    // The boundary below a `.0` patch is simply in the previous minor (and
    // below a `x.0.0` floor, the previous major), so assert THAT instead of
    // asserting nothing: either way the test still fails if the comparator
    // stops looking past major.minor.
    const [maj, min, patch] = MIN_OAM_VERSION.split(".").map(Number);
    const justBelow =
      patch !== 0 ? `${maj}.${min}.${patch - 1}` : min !== 0 ? `${maj}.${min - 1}.99` : `${maj - 1}.99.99`;
    // The derivation is arithmetic on a constant that moves, and a bad one is
    // not version-shaped at all: a `-1` minor at a `x.0.0` floor, or NaN at a
    // prerelease floor. compareVersions returns 0 for anything it cannot parse,
    // so without this the failure lands on the gate assertion below and reads
    // as a comparator bug. Fail at the derivation instead.
    expect(compareVersions(justBelow, MIN_OAM_VERSION), `derived ${justBelow} is not below the floor`).toBeLessThan(0);
    const probe = await probeOam(async () => `oam ${justBelow}\n`);
    expect(probe.belowMin, `${justBelow} was admitted against a ${MIN_OAM_VERSION} floor`).toBe(true);
    expect(probe.bin).toBeNull();
  });

  it("treats a below-min install as oam-absent (bin null, belowMin set)", async () => {
    const probe = await probeOam(async () => "oam 0.5.9\n");
    expect(probe.bin).toBeNull();
    expect(probe.version).toBe("0.5.9");
    expect(probe.belowMin).toBe(true);
    // Below-min is not a FAILURE: oam ran and answered. Reporting it as one
    // would send doctor's "present but broken" message for a working install.
    expect(probe.failure).toBeNull();
    expect(probe.failureDetail).toBeNull();
  });

  it("ranks a prerelease of the floor BELOW it, and keeps the suffix it reports", async () => {
    // A prerelease OF the floor itself (e.g. "0.11.0-rc.1" against a 0.11.0
    // floor): semver ranks the prerelease lower, and hosting it means
    // debugging against a build nobody else runs. The reported version has to
    // keep the suffix or this warn reads as a comparator bug ("0.11.0 is below
    // the minimum 0.11.0"). Derived from the constant, so the assertion tracks
    // future bumps -- only this illustration names a number.
    const probe = await probeOam(async () => `oam ${MIN_OAM_VERSION}-rc.1\n`);
    expect(probe.belowMin).toBe(true);
    expect(probe.bin).toBeNull();
    expect(probe.version).toBe(`${MIN_OAM_VERSION}-rc.1`);
  });

  it("still hosts a prerelease that is above the floor, reporting its full token", async () => {
    // The gate is "older than the current release", not "not a release". A
    // source build of the NEXT version is newer than the floor, so it hosts --
    // and the version it is reported as must be the one that was actually run.
    const [maj, min] = MIN_OAM_VERSION.split(".").map(Number);
    const probe = await probeOam(async () => `oam ${maj}.${min + 1}.0-dev.7\n`);
    expect(probe.belowMin).toBe(false);
    expect(probe.bin).not.toBeNull();
    expect(probe.version).toBe(`${maj}.${min + 1}.0-dev.7`);
  });

  it("treats a probe that ENOENTs as not installed, with no failure recorded", async () => {
    // ENOENT is ABSENCE, and absence is already conveyed by bin=null. Tagging
    // it as a failure would make doctor tell every node-only machine that its
    // oam install is broken.
    const probe = await probeOam(async () => {
      const e: NodeJS.ErrnoException = new Error("spawn oam ENOENT");
      e.code = "ENOENT";
      throw e;
    });
    expect(probe).toEqual({
      bin: null,
      binPath: null,
      version: null,
      belowMin: false,
      failure: null,
      failureDetail: null,
    });
  });

  it("treats an unparseable version as usable (a working --version proves oam exists)", async () => {
    const probe = await probeOam(async () => "oam dev build\n");
    expect(probe.bin).not.toBeNull();
    expect(probe.version).toBeNull();
    expect(probe.belowMin).toBe(false);
  });

  it("caches the probe result (the runner is only consulted once)", async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return "oam 9.9.9";
    };
    await probeOam(run);
    await probeOam(run);
    expect(calls).toBe(1);
  });
});

// `bin === null` is the answer to "can we host on oam", and it is the SAME
// answer for an oam that is absent and an oam that is present and broken. Those
// send the user to opposite fixes -- install it, versus repair the install you
// already have -- so the probe records which one happened. Reporting a broken
// oam as "not installed" is the specific failure these pin.
describe("probeOam failure classification", () => {
  beforeEach(() => resetOamBinCache());
  afterEach(() => resetOamBinCache());

  /** An injected runner that rejects with a given errno-style code. */
  function rejectWith(code: string | undefined, message: string): () => Promise<string> {
    return async () => {
      const err = new Error(message) as Error & { code?: string };
      if (code !== undefined) err.code = code;
      throw err;
    };
  }

  it("records a timeout as `timeout`, with the message that names the budget", async () => {
    const probe = await probeOam(rejectWith("ETIMEDOUT", "oam --version exceeded 3000ms"));
    expect(probe.failure).toBe("timeout");
    expect(probe.failureDetail).toBe("oam --version exceeded 3000ms");
    expect(probe.bin).toBeNull();
    expect(probe.binPath).toBeNull();
  });

  it("records a non-zero exit as `exit` -- it RAN and failed", async () => {
    // EOAMEXIT is the tag spawnVersionProbe puts on a non-zero `close`; the
    // real tagging is covered end to end in oam-probe-options.test.ts, which
    // drives the actual child. Here it is injected so the CLASSIFIER is what
    // gets tested, not the spawn.
    const probe = await probeOam(rejectWith("EOAMEXIT", "oam exited 1"));
    expect(probe.failure).toBe("exit");
    expect(probe.failureDetail).toBe("oam exited 1");
  });

  it("records an EACCES as `spawn` -- it could not be run at all", async () => {
    // A non-executable file on PATH, or a permission-denied bin. Distinct from
    // "exit": there is no exit code because nothing ever started.
    const probe = await probeOam(rejectWith("EACCES", "spawn oam EACCES"));
    expect(probe.failure).toBe("spawn");
    expect(probe.failureDetail).toBe("spawn oam EACCES");
  });

  it("records an untagged rejection as `spawn`, the conservative answer", async () => {
    // The one thing an unrecognised rejection definitely was NOT is a clean
    // run, so it must not fall back to "usable" or to "absent".
    const probe = await probeOam(rejectWith(undefined, "something unexpected"));
    expect(probe.failure).toBe("spawn");
    expect(probe.failureDetail).toBe("something unexpected");
  });
});

// `bin` is what to SPAWN; `binPath` is what to PERSIST into someone else's
// config. A GUI-launched MCP client does not inherit the shell PATH that made a
// bare `oam` work here, so the install path needs the absolute answer -- and it
// has to get it without a `where`/`which` subprocess, because the whole async
// probe rewrite exists to keep child processes off the connect path.
describe("resolveBinAbsolute", () => {
  /** A temp dir holding the given filenames, cleaned up by the caller.
   *
   *  The files are chmod'd EXECUTABLE, which is load-bearing off Windows: the
   *  search requires X_OK there, and writeFileSync's default mode (0666 minus
   *  umask) carries no execute bit -- so without this every POSIX assertion
   *  below would be measuring the fixture's permissions rather than the search.
   *  A no-op on Windows, which has no execute bit. */
  function binDir(...names: string[]): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "resolvebin-"));
    for (const name of names) {
      writeFileSync(join(dir, name), "");
      chmodSync(join(dir, name), 0o755);
    }
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  /** A POSIX-shaped bin directory that exists only in the injected fs at the
   *  top of this file, for the two branches a real temp dir cannot express on a
   *  Windows runner (see that block for why). The path carries no drive letter,
   *  so it survives a ':'-delimited PATH; `noexec` gives a file that stats as a
   *  regular file but denies X_OK, which is what chmod 0644 produces for real.
   *
   *  The staged keys go through the same join() the search uses, so a Windows
   *  runner's backslashed spelling of this POSIX path still matches. */
  function posixBinDir(leaf: string, files: Record<string, "exec" | "noexec">): { dir: string; cleanup: () => void } {
    const dir = `${SYNTH_ROOT}/${leaf}`;
    const keys = Object.entries(files).map(([name, kind]) => {
      const key = fsKey(join(dir, name));
      fsEntries.set(key, kind);
      return key;
    });
    accessLog.length = 0;
    return {
      dir,
      cleanup: () => {
        for (const key of keys) fsEntries.delete(key);
        accessLog.length = 0;
      },
    };
  }

  it("finds a bare name through PATHEXT on Windows, where `oam` is a file called oam.exe", () => {
    // The case the install path lives on: `oam` spawns because the loader
    // appends an extension, so a PATH-only search finds nothing on disk.
    // Fixture case matches PATHEXT deliberately -- existsSync is
    // case-insensitive on Windows but case-SENSITIVE on a Linux runner.
    const { dir, cleanup } = binDir("oam.exe");
    try {
      expect(resolveBinAbsolute("oam", { PATH: dir, PATHEXT: ".com;.exe" }, "win32")).toBe(
        winNormalize(join(dir, "oam.exe"), "win32"),
      );
    } finally {
      cleanup();
    }
  });

  it("tries the empty extension FIRST, so a name that carries its own is found as written", () => {
    // Otherwise "oam.exe" is searched as "oam.exe.exe" and misses.
    const { dir, cleanup } = binDir("oam.exe");
    try {
      expect(resolveBinAbsolute("oam.exe", { PATH: dir, PATHEXT: ".exe" }, "win32")).toBe(
        winNormalize(join(dir, "oam.exe"), "win32"),
      );
    } finally {
      cleanup();
    }
  });

  it("skips the EXTENSIONLESS candidate on Windows, which CreateProcess would never run", () => {
    // A POSIX shim named `oam` checked into a bin dir beside the real
    // `oam.exe` is an everyday shape. Windows appends an extension to a name
    // that carries none, so spawning `oam` runs oam.exe -- but the search
    // tried "" first and answered with the shim, and install then persisted a
    // launch that cannot start. isExecutableFile cannot tell them apart: X_OK
    // is a no-op on Windows, where executability IS the extension.
    const { dir, cleanup } = binDir("oam", "oam.exe");
    try {
      expect(resolveBinAbsolute("oam", { PATH: dir, PATHEXT: ".exe" }, "win32")).toBe(
        winNormalize(join(dir, "oam.exe"), "win32"),
      );
    } finally {
      cleanup();
    }
  });

  it("refuses a RELATIVE bin that carries a separator instead of PATH-joining it", () => {
    // `./tools/oam` is spawned against the CWD; the loader never consults PATH
    // for a name with a separator in it. Joining it onto each PATH entry could
    // only hit by coincidence -- and that coincidence would be written into a
    // client's config as "the oam we found".
    const dir = mkdtempSync(join(tmpdir(), "resolvebin-rel-"));
    mkdirSync(join(dir, "tools"));
    for (const name of ["oam", "oam.exe"]) {
      writeFileSync(join(dir, "tools", name), "");
      chmodSync(join(dir, "tools", name), 0o755);
    }
    try {
      // join(dir, "./tools/oam") really does land on the file, which is
      // exactly why the PATH loop used to return it.
      expect(resolveBinAbsolute("./tools/oam", { PATH: dir }, "linux")).toBeNull();
      expect(resolveBinAbsolute("tools/oam", { PATH: dir, PATHEXT: ".exe" }, "win32")).toBeNull();
      // The control, asserted through the win32 delimiter so a drive-lettered
      // fixture path is not split at its colon: the bare name in that same
      // directory is an ordinary PATH lookup and still resolves.
      expect(resolveBinAbsolute("oam", { PATH: join(dir, "tools"), PATHEXT: ".exe" }, "win32")).toBe(
        winNormalize(join(dir, "tools", "oam.exe"), "win32"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips quotes from a PATH entry -- they are shell syntax, not the directory name", () => {
    // Windows PATH entries are commonly quoted; keeping the quote makes every
    // join miss, so an install silently declines to write an oam launch.
    const { dir, cleanup } = binDir("oam.exe");
    try {
      expect(resolveBinAbsolute("oam", { PATH: `"${dir}"`, PATHEXT: ".exe" }, "win32")).toBe(
        winNormalize(join(dir, "oam.exe"), "win32"),
      );
    } finally {
      cleanup();
    }
  });

  it("reads a capitalised `Path`, which a sanitized child env can carry instead", () => {
    // Windows env vars are case-insensitive but process.env is not.
    const { dir, cleanup } = binDir("oam.exe");
    try {
      expect(resolveBinAbsolute("oam", { Path: dir, PATHEXT: ".exe" }, "win32")).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it("falls back to the default PATHEXT when the env does not set one", () => {
    const { dir, cleanup } = binDir("oam.EXE");
    try {
      expect(resolveBinAbsolute("oam", { PATH: dir }, "win32")).toBe(winNormalize(join(dir, "oam.EXE"), "win32"));
    } finally {
      cleanup();
    }
  });

  it("skips an empty PATH entry instead of resolving it against the cwd", () => {
    // An empty entry means "cwd" to a shell. It is skipped rather than resolved,
    // because a path destined for someone else's config must not depend on
    // whichever directory the broker happened to be started in -- and skipping
    // it must not abort the rest of the search either.
    //
    // Asserted through the win32 delimiter on purpose: the fixture's own temp
    // path is Windows-shaped on a Windows runner, and a ":" delimiter would
    // then split it at the drive letter, so the test would be measuring the
    // fixture rather than the search.
    const { dir, cleanup } = binDir("oam.exe");
    try {
      expect(resolveBinAbsolute("oam", { PATH: `;${dir}`, PATHEXT: ".exe" }, "win32")).toBe(
        winNormalize(join(dir, "oam.exe"), "win32"),
      );
    } finally {
      cleanup();
    }
  });

  // The fixture is injected rather than staged on disk (see the node:fs block
  // at the top of this file): a real temp dir is drive-lettered on the runner
  // that cuts every release, and a ':'-delimited PATH would split it at that
  // drive letter, so the test would be measuring the fixture rather than the
  // search. Only "what is on disk at this path" is answered from the map --
  // the split, the PATHEXT decision and isExecutableFile all run for real, so
  // what this proves is unchanged: a ';' split would leave the whole
  // "<other>:<dir>" string as ONE entry and find nothing, and applying the
  // default PATHEXT off Windows would search oam.COM/.EXE/... and never the
  // extensionless `oam` that is the only file staged.
  it("splits PATH on ':' off Windows, and needs no PATHEXT", () => {
    const { dir, cleanup } = posixBinDir("split", { oam: "exec" });
    const other = `${SYNTH_ROOT}/split-empty`;
    try {
      // Expectation built with the SAME join the search uses. node:path is
      // platform-native, so this POSIX path builds with backslashes on a
      // Windows runner and a hardcoded "/.../oam" would fail there for a
      // reason that has nothing to do with the ':' split.
      expect(resolveBinAbsolute("oam", { PATH: `${other}:${dir}` }, "linux")).toBe(join(dir, "oam"));
      // ...and the POSIX branch paid the X_OK it owes, on the file it answered
      // with and on nothing else: the miss in `other` never got that far,
      // because statSync said ENOENT first.
      expect(accessLog).toEqual([{ path: join(dir, "oam"), mode: constants.X_OK }]);
    } finally {
      cleanup();
    }
  });

  it("accepts an absolute path that exists and normalizes it for Windows", () => {
    const { dir, cleanup } = binDir("oam");
    try {
      expect(resolveBinAbsolute(join(dir, "oam"), {}, "linux")).toBe(join(dir, "oam"));
      // The win32 half the title promises, which nothing used to assert: the
      // SAME file spelled with forward slashes -- what an OAM_BIN copied out of
      // a POSIX-shaped config carries -- comes back backslashed. Spelled
      // forward-slash deliberately: a Windows runner's own fixture path is
      // already backslashed, so handing that in makes winNormalize a no-op and
      // the assertion answers itself.
      const forward = join(dir, "oam").replace(/\\/g, "/");
      expect(resolveBinAbsolute(forward, {}, "win32")).toBe(winNormalize(forward, "win32"));
      expect(resolveBinAbsolute("C:/nope/oam.exe", {}, "win32")).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("returns null for an absolute path that is not there", () => {
    // "do not persist an oam launch" -- a config entry pointing at nothing is
    // strictly worse than one running on node.
    expect(resolveBinAbsolute(join(tmpdir(), "definitely-not-here", "oam"), {}, "linux")).toBeNull();
  });

  it("returns null for a bare name with no PATH at all", () => {
    expect(resolveBinAbsolute("oam", {}, "linux")).toBeNull();
    expect(resolveBinAbsolute("oam", { PATH: "" }, "linux")).toBeNull();
  });

  it("returns null when the name is on no PATH entry", () => {
    const { dir, cleanup } = binDir("something-else");
    try {
      expect(resolveBinAbsolute("oam", { PATH: dir }, "linux")).toBeNull();
    } finally {
      cleanup();
    }
  });

  // ABSOLUTE is the promise in the name, and every caller depends on it:
  // install-targets' buildLaunchEntry silently drops a non-absolute path back to
  // npx, so returning one made `install` print "will run on oam" while writing
  // the npx entry into the config file it had just written.
  it("never returns a NON-absolute path, even when a relative PATH entry really has the binary", () => {
    const { dir, cleanup } = binDir("oam.exe");
    try {
      const rel = relative(process.cwd(), dir);
      // A temp dir on another drive has no relative form on Windows; the shape
      // this pins is unreachable there, so only the absolute control runs.
      if (!isAbsolute(rel)) {
        // existsSync resolves this candidate against the broker's cwd and FINDS
        // the file, which is exactly why the old existsSync-only search returned
        // it. A "." entry is the everyday spelling of the same thing.
        expect(resolveBinAbsolute("oam", { PATH: rel, PATHEXT: ".exe" }, "win32")).toBeNull();
      }
      // A quoted-EMPTY entry is the same failure by another route: it survives
      // the filter(Boolean) empty-entry guard because the quotes make the
      // string non-empty, and then join("", bin) collapses to the bare bin,
      // which the isAbsolute guard inside the loop is what rejects.
      //
      // The bin is a BARE name on purpose. This used to pass `join(rel,
      // "oam.exe")`, which carries a separator -- and a relative name with a
      // separator is refused by the earlier guard, before the PATH loop this
      // comment describes is ever reached. It also needs no relative form, so
      // it sits outside the block above and runs on every platform.
      expect(resolveBinAbsolute("oam.exe", { PATH: '""', PATHEXT: ".exe" }, "win32")).toBeNull();
      // The same directory in ABSOLUTE form still resolves: the skip is about
      // the shape of the PATH entry, not about this directory.
      expect(resolveBinAbsolute("oam", { PATH: dir, PATHEXT: ".exe" }, "win32")).toBe(
        winNormalize(join(dir, "oam.exe"), "win32"),
      );
    } finally {
      cleanup();
    }
  });

  it("skips a DIRECTORY named like the binary, which the loader would walk past", () => {
    // existsSync says yes to a directory. The loader does not run one -- it
    // keeps searching PATH -- and persisting it into a client's config produces
    // an entry that cannot launch at all, which is worse than staying on node.
    const dir = mkdtempSync(join(tmpdir(), "resolvebin-dir-"));
    mkdirSync(join(dir, "oam"));
    try {
      expect(resolveBinAbsolute("oam", { PATH: dir }, "linux")).toBeNull();
      // Same answer for a directory handed in directly (an OAM_BIN typo).
      expect(resolveBinAbsolute(join(dir, "oam"), {}, "linux")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The permission is injected, not real (see the node:fs block at the top). A
  // real `chmodSync(..., 0o644)` fixture WOULD force a runner-gated test,
  // because X_OK is a no-op on Windows -- Node degrades it to F_OK -- so the
  // real fs there cannot produce a file that stats as a regular file and still
  // refuses X_OK; injecting the errno instead is what lets this one run
  // everywhere, including the Windows machine that cuts the release. The staged
  // file answers EACCES to exactly that X_OK request, which is what the real
  // 0644 file answers off Windows, and isExecutableFile's own platform gate,
  // its accessSync call and its catch are all the shipped code.
  it("skips a non-executable file off Windows, and asks no X_OK on Windows", () => {
    const { dir, cleanup } = posixBinDir("noexec", { oam: "noexec" });
    try {
      // The loader skips it in favour of the real binary further down PATH, and
      // this is the shape that makes probeOam report a `spawn` failure -- so
      // returning it as the answer to "where is oam" is doubly wrong.
      expect(resolveBinAbsolute("oam", { PATH: dir }, "linux")).toBeNull();
      expect(resolveBinAbsolute(join(dir, "oam"), {}, "linux")).toBeNull();
      // Both refusals came from X_OK and nothing else. The file stats as a
      // regular file, so this is the assertion that separates "skipped because
      // it is not executable" from "skipped because the stat missed" -- an
      // isExecutableFile that stopped asking would have returned it twice.
      expect(accessLog).toEqual([
        { path: join(dir, "oam"), mode: constants.X_OK },
        { path: join(dir, "oam"), mode: constants.X_OK },
      ]);
      // The win32 half of the same gate, which the runner skip also hid: the
      // IDENTICAL file is the answer there, because executability is the
      // extension and PATHEXT has already decided it. Asserted through the
      // absolute branch on purpose -- a bare `oam` on win32 is searched as
      // oam.COM/.EXE/... and would never reach an extensionless file at all.
      accessLog.length = 0;
      expect(resolveBinAbsolute(join(dir, "oam"), {}, "win32")).toBe(winNormalize(join(dir, "oam"), "win32"));
      expect(accessLog).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

// Exact `command === "node"` equality -- which this replaced -- silently opted
// out every launch that names its interpreter by path, and an absolute node path
// is an ordinary MCP config shape (Windows installs, nvm/volta shims) rather
// than an edge case. Exported because doctor answers the same question in
// default-runtime.ts and the two must not disagree.
describe("nodeLaunchKind", () => {
  it("recognises node and npx by basename, through either separator", () => {
    expect(nodeLaunchKind("node")).toBe("node");
    expect(nodeLaunchKind("/usr/local/bin/node")).toBe("node");
    expect(nodeLaunchKind(String.raw`C:\Program Files\nodejs\node.exe`)).toBe("node");
    expect(nodeLaunchKind("npx")).toBe("npx");
    expect(nodeLaunchKind("npx.cmd")).toBe("npx"); // npm ships this shim on Windows
    expect(nodeLaunchKind("/usr/local/bin/npx")).toBe("npx");
  });

  it("strips the Windows extension case-INSENSITIVELY, because Windows is", () => {
    // A hand-written or installer-generated config carries the uppercase form as
    // readily as the lowercase one. Stripping only lowercase read `NODE.EXE` as
    // not-Node, so an opted-in server ran on node forever -- and doctor calls
    // this same helper, so it agreed with the spawn and nothing explained why.
    expect(nodeLaunchKind(String.raw`C:\Program Files\nodejs\NODE.EXE`)).toBe("node");
    expect(nodeLaunchKind("NPX.CMD")).toBe("npx");
    expect(nodeLaunchKind("Node.Exe")).toBe("node");
    expect(nodeLaunchKind("node.BAT")).toBe("node");
  });

  it("is not a substring match -- a look-alike launcher is left alone", () => {
    // `nodemon` restarts a server on file changes; rewriting it to `oam run`
    // would drop the watcher entirely.
    expect(nodeLaunchKind("nodemon")).toBeNull();
    expect(nodeLaunchKind("/usr/bin/nodemon")).toBeNull();
    expect(nodeLaunchKind("docker")).toBeNull();
    expect(nodeLaunchKind("uvx")).toBeNull();
    expect(nodeLaunchKind("oam")).toBeNull();
  });
});

describe("rewriteForOam", () => {
  const oam = { oamBin: "oam", resolveEntry: (p: string) => `/pkgs/${p}/dist/index.js` };
  /** An oam whose only on-disk copy of any package declares `version`, which is
   *  what a pin has to be checked against. */
  const oamWithVersion = (version: string) => ({
    oamBin: "oam",
    resolveEntry: (p: string, want: string | null) => (want === null || want === version ? `/pkgs/${p}/x.js` : null),
  });

  it("rewrites `npx -y <pkg>@latest` to `oam run <resolved entry>`", () => {
    expect(rewriteForOam("npx", ["-y", "@yawlabs/npmjs-mcp@latest"], oam)).toEqual({
      command: "oam",
      args: ["run", "/pkgs/@yawlabs/npmjs-mcp/dist/index.js"],
    });
  });

  it("rewrites `node <entry>` to `oam run <entry>`", () => {
    expect(rewriteForOam("node", ["/srv/index.js"], oam)).toEqual({
      command: "oam",
      args: ["run", "/srv/index.js"],
    });
  });

  it("forwards extra args after `--`", () => {
    expect(rewriteForOam("node", ["/srv/index.js", "--port", "1"], oam)).toEqual({
      command: "oam",
      args: ["run", "/srv/index.js", "--", "--port", "1"],
    });
  });

  it("turns oam's concurrent type-checker off for a TypeScript entry", () => {
    // `oam run` defaults to `--check warn`, so a rewritten `node server.ts`
    // spawns tsgo alongside the sidecar and writes its diagnostics to the
    // child's stderr -- which is what lands in the 500-char failure tail when
    // a boot fails, in place of the real error. node ran the file unchecked;
    // the rewrite is billed as a pure optimization, so it must not add a
    // checker the original launch never had.
    expect(rewriteForOam("node", ["/srv/server.ts"], oam)).toEqual({
      command: "oam",
      args: ["run", "--no-check", "/srv/server.ts"],
    });
    // The flag goes before the entry, and the server's own args still ride
    // after the `--` separator.
    expect(rewriteForOam("node", ["/srv/server.mts", "--port", "1"], oam)).toEqual({
      command: "oam",
      args: ["run", "--no-check", "/srv/server.mts", "--", "--port", "1"],
    });
    // A JavaScript entry is not type-checked in the first place: no flag, so
    // the everyday launch keeps the argv it always had.
    expect(rewriteForOam("node", ["/srv/index.js"], oam)).toEqual({
      command: "oam",
      args: ["run", "/srv/index.js"],
    });
  });

  it("stays on node when the first arg is a node flag, not the entry", () => {
    expect(rewriteForOam("node", ["--enable-source-maps", "/srv/index.js"], oam)).toEqual({
      command: "node",
      args: ["--enable-source-maps", "/srv/index.js"],
    });
  });

  it("leaves docker untouched (not Node-based)", () => {
    expect(rewriteForOam("docker", ["run", "-i", "img"], oam)).toEqual({
      command: "docker",
      args: ["run", "-i", "img"],
    });
  });

  it("leaves uv untouched (handled by resolveUvSpawn)", () => {
    expect(rewriteForOam("uv", ["tool", "run", "x"], oam)).toEqual({
      command: "uv",
      args: ["tool", "run", "x"],
    });
  });

  it("falls back to the original command when oam is unavailable", () => {
    expect(rewriteForOam("npx", ["-y", "@yawlabs/npmjs-mcp"], { oamBin: null, resolveEntry: () => "/x" })).toEqual({
      command: "npx",
      args: ["-y", "@yawlabs/npmjs-mcp"],
    });
  });

  it("keeps a server's own --yes, stripping only the flags npx itself consumes", () => {
    // The filter used to run over the WHOLE arg list, so a `--yes` meant for
    // the SERVER was eaten -- the oam launch and the npx fallback then handed
    // the child different argv, which is the one thing a rewrite billed as
    // "a pure optimization, never a correctness dependency" must never do.
    expect(rewriteForOam("npx", ["-y", "some-mcp", "--yes", "--port", "1"], oam)).toEqual({
      command: "oam",
      args: ["run", "/pkgs/some-mcp/dist/index.js", "--", "--yes", "--port", "1"],
    });
  });

  it("stays on npx when there is no positional at all", () => {
    // A hand-edited bundles.json can carry `npx -y` with nothing after it.
    // findIndex returns -1 there, and the guard has to hold rather than
    // treating `undefined` as the package name.
    expect(rewriteForOam("npx", ["-y"], oam)).toEqual({ command: "npx", args: ["-y"] });
    expect(rewriteForOam("npx", [], oam)).toEqual({ command: "npx", args: [] });
  });

  it("falls back to npx when the package can't be resolved on disk", () => {
    expect(rewriteForOam("npx", ["-y", "@yawlabs/not-installed"], { oamBin: "oam", resolveEntry: () => null })).toEqual(
      { command: "npx", args: ["-y", "@yawlabs/not-installed"] },
    );
  });

  it("rewrites a launch that names its interpreter by absolute path", () => {
    // These used to be skipped outright, so oam silently did nothing for them
    // while README claimed only non-Node launches were left alone.
    expect(rewriteForOam("/usr/local/bin/node", ["/srv/index.js"], oam)).toEqual({
      command: "oam",
      args: ["run", "/srv/index.js"],
    });
    expect(rewriteForOam(String.raw`C:\Program Files\nodejs\node.exe`, ["/srv/index.js"], oam)).toEqual({
      command: "oam",
      args: ["run", "/srv/index.js"],
    });
    expect(rewriteForOam("npx.cmd", ["-y", "some-mcp"], oam)).toEqual({
      command: "oam",
      args: ["run", "/pkgs/some-mcp/dist/index.js"],
    });
  });

  it("leaves a look-alike launcher untouched", () => {
    // Basename matching must not become substring matching: `nodemon` is not
    // node, and rewriting it to `oam run` would drop the file watcher.
    expect(rewriteForOam("nodemon", ["/srv/index.js"], oam)).toEqual({
      command: "nodemon",
      args: ["/srv/index.js"],
    });
  });

  it("hosts a pinned spec only when the resolved copy declares that version", () => {
    // `oam run <entry>` runs whatever is at that path, so a version-agnostic
    // lookup turned `npx -y pkg@0.2.0` into "run whatever copy is newest" -- a
    // config that pinned against a major jump getting the major jump anyway.
    expect(rewriteForOam("npx", ["-y", "some-mcp@0.2.0"], oamWithVersion("0.2.0"))).toEqual({
      command: "oam",
      args: ["run", "/pkgs/some-mcp/x.js"],
    });
  });

  it("stays on npx when no on-disk copy declares the pinned version", () => {
    // npx is not a mere fallback here -- it is the only thing that can honour
    // the pin, because it re-resolves the spec against the registry.
    // buildLaunchEntry refuses the oam path for the broker's own pinned spec
    // for exactly this reason (install-targets.ts).
    expect(rewriteForOam("npx", ["-y", "some-mcp@0.2.0"], oamWithVersion("2.0.0"))).toEqual({
      command: "npx",
      args: ["-y", "some-mcp@0.2.0"],
    });
  });

  it("stays on npx for a version RANGE, which it cannot evaluate", () => {
    // `^1.2.3` is satisfiable by more than one version, and checking it would
    // mean a semver range parser. Treating it like a tag would let an on-disk
    // 0.9.0 answer a `^1.2.3` request.
    expect(rewriteForOam("npx", ["-y", "some-mcp@^1.2.3"], oam)).toEqual({
      command: "npx",
      args: ["-y", "some-mcp@^1.2.3"],
    });
  });

  it("still hosts a tag spec, where newest-on-disk is the closest answer", () => {
    expect(rewriteForOam("npx", ["-y", "some-mcp@next"], oam)).toEqual({
      command: "oam",
      args: ["run", "/pkgs/some-mcp/dist/index.js"],
    });
  });

  it("stays on npx for a git or path spec, which is not a package name", () => {
    // `./local-server` fed to the resolver becomes a lookup for a TOP-LEVEL
    // package called `local-server` (path.join eats the "."), so on a machine
    // that happens to have one published by that name the server would be
    // rewritten to run a different program entirely.
    expect(rewriteForOam("npx", ["-y", "./local-server"], oam)).toEqual({
      command: "npx",
      args: ["-y", "./local-server"],
    });
    expect(rewriteForOam("npx", ["-y", "github:owner/repo"], oam)).toEqual({
      command: "npx",
      args: ["-y", "github:owner/repo"],
    });
  });
});

describe("npxCacheNodeModules", () => {
  it("derives sibling npx-cache node_modules from a path under _npx", () => {
    const root = mkdtempSync(join(tmpdir(), "npxcache-"));
    const npx = join(root, "_npx");
    // The broker itself is fetched into cache "aaa"; "bbb" is a sibling
    // cache where some other `npx -y <pkg>` server was installed.
    mkdirSync(join(npx, "aaa", "node_modules", "@yawlabs", "mcp", "dist"), { recursive: true });
    mkdirSync(join(npx, "bbb", "node_modules"), { recursive: true });
    const selfUrl = pathToFileURL(join(npx, "aaa", "node_modules", "@yawlabs", "mcp", "dist", "index.js")).href;
    try {
      expect(npxCacheNodeModules(selfUrl).sort()).toEqual(
        [join(npx, "aaa", "node_modules"), join(npx, "bbb", "node_modules")].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns [] for a path not under an npx cache", () => {
    expect(npxCacheNodeModules(pathToFileURL(join(tmpdir(), "plain", "index.js")).href)).toEqual([]);
  });

  it("returns [] for a non-file URL", () => {
    expect(npxCacheNodeModules("not-a-url")).toEqual([]);
  });

  it("returns [] when the _npx root itself cannot be read", () => {
    // The path HAS an `_npx` segment -- so the marker matches and the readdir
    // is actually attempted -- but the cache root is gone: `npm cache clean`
    // during a long-lived broker's life, or a pruned/unreadable directory.
    // readdirSync throws ENOENT there, and the catch is what keeps that a
    // quiet node fallback instead of an unhandled throw on the connect path.
    const root = mkdtempSync(join(tmpdir(), "npxcache-gone-"));
    const selfUrl = pathToFileURL(
      join(root, "_npx", "aaa", "node_modules", "@yawlabs", "mcp", "dist", "index.js"),
    ).href;
    rmSync(root, { recursive: true, force: true });
    expect(npxCacheNodeModules(selfUrl)).toEqual([]);
  });
});

describe("resolveStableNpmEntry", () => {
  // The whole point: what may be SPAWNED now is not what may be PERSISTED into
  // a client's config. An npx-cache path exists this instant and is gone after
  // `npm cache clean`, which would leave the client pointing at nothing.
  it("refuses an npx-cache install even though resolveNpmEntry accepts it", () => {
    const root = mkdtempSync(join(tmpdir(), "stable-"));
    const dir = join(root, "_npx", "aaa", "node_modules", "@yawlabs", "mcp");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@yawlabs/mcp", bin: { "yaw-mcp": "./dist/index.js" } }),
    );
    writeFileSync(join(dir, "dist", "index.js"), "");
    const fromUrl = pathToFileURL(join(dir, "dist", "index.js")).href;
    try {
      // Same package, same path, opposite answers -- that IS the distinction.
      expect(resolveNpmEntry("@yawlabs/mcp", fromUrl, null, null)).toBe(join(dir, "dist", "index.js"));
      expect(resolveStableNpmEntry("@yawlabs/mcp", fromUrl)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when the package is absent entirely", () => {
    // Distinct condition from present-but-in-the-npx-cache. Both currently
    // mean "stay on npx", so conflating them is invisible today -- and would
    // stop being invisible the moment either grows its own message.
    const root = mkdtempSync(join(tmpdir(), "stable-"));
    const dir = join(root, "lib", "node_modules", "@yawlabs", "other-pkg");
    mkdirSync(dir, { recursive: true });
    const fromUrl = pathToFileURL(join(dir, "index.js")).href;
    try {
      expect(resolveStableNpmEntry("@yawlabs/mcp", fromUrl)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a durable global/project node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "stable-"));
    const dir = join(root, "lib", "node_modules", "@yawlabs", "mcp");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "@yawlabs/mcp", bin: { "yaw-mcp": "./dist/index.js" } }),
    );
    writeFileSync(join(dir, "dist", "index.js"), "");
    const fromUrl = pathToFileURL(join(dir, "dist", "index.js")).href;
    try {
      // `npm update -g` rewrites this path in place, so pinning it still picks
      // up new versions -- which is what makes replacing `@latest` acceptable.
      expect(resolveStableNpmEntry("@yawlabs/mcp", fromUrl)).toBe(join(dir, "dist", "index.js"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("npmCacheDir", () => {
  // npm injects npm_config_* into scripts it runs, and that value takes
  // precedence over every npmrc -- so it has to be cleared or these assertions
  // measure the runner instead of the resolver.
  const savedEnv = process.env.npm_config_cache;
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  let fakeHome = "";
  beforeEach(() => {
    delete process.env.npm_config_cache;
    // ...and the resolver's FIRST candidate is the runner's own `~/.npmrc`,
    // which outranks every fixture npmrc below. A single `cache=` line there --
    // exactly what `npm config set cache` writes -- answers before any fixture
    // and fails 11 of the 12 assertions in this describe. homedir() reads HOME
    // (POSIX) / USERPROFILE (Windows) on every call, so pointing both at an
    // empty temp dir is enough; the `~/` expansion test still agrees, because
    // source and test both go through homedir().
    fakeHome = mkdtempSync(join(tmpdir(), "npmcache-home-"));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    resetNpmCacheDir();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = savedEnv;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
    resetNpmCacheDir();
  });

  /** A broker at <root>/node_modules/@yawlabs/mcp/dist/index.js whose sibling
   *  npm carries a builtin npmrc pointing at `cache`. */
  function brokerWithNpmrc(cache: string): { url: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "npmcache-"));
    const nm = join(root, "node_modules");
    mkdirSync(join(nm, "@yawlabs", "mcp", "dist"), { recursive: true });
    mkdirSync(join(nm, "npm"), { recursive: true });
    writeFileSync(join(nm, "npm", "npmrc"), `prefix=${root}\ncache=${cache}\n`);
    return {
      url: pathToFileURL(join(nm, "@yawlabs", "mcp", "dist", "index.js")).href,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  it("reads the cache out of npm's builtin npmrc", () => {
    // The case that matters: version managers (scoop, nvm, volta) relocate the
    // cache in the BUILTIN npmrc beside npm, not in the user's ~/.npmrc.
    const a = brokerWithNpmrc(join(tmpdir(), "cache-A"));
    try {
      expect(npmCacheDir(a.url)).toBe(join(tmpdir(), "cache-A"));
    } finally {
      a.cleanup();
    }
  });

  it("memoizes per fromUrl, so a second caller does not inherit the first's answer", () => {
    // A single memo slot would return cache-A here for BOTH brokers -- the
    // parameter would silently stop mattering after the first call.
    const a = brokerWithNpmrc(join(tmpdir(), "cache-A"));
    const b = brokerWithNpmrc(join(tmpdir(), "cache-B"));
    try {
      expect(npmCacheDir(a.url)).toBe(join(tmpdir(), "cache-A"));
      expect(npmCacheDir(b.url)).toBe(join(tmpdir(), "cache-B"));
      // Delete a's npmrc BEFORE re-asking. With the fixture still on disk a
      // fresh re-read answers "cache-A" too, so the assertion could not tell a
      // memo from a re-read -- it passed with the memoization deleted. Gone,
      // the only way back to "cache-A" is the map.
      a.cleanup();
      expect(npmCacheDir(a.url)).toBe(join(tmpdir(), "cache-A")); // still cached
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it("takes the LAST cache= line, the way npm's ini parser does", () => {
    // npm parses an npmrc as ini: a duplicate key overwrites the earlier one,
    // so the LAST `cache=` is the directory npm is actually filling. Taking
    // the first one resolved to a stale directory whose `_npx` readdir finds
    // nothing, and every npx sidecar then quietly stayed on npx -- a silent
    // no-op indistinguishable from "no sidecars installed".
    const stale = join(tmpdir(), "cache-STALE");
    const live = join(tmpdir(), "cache-LIVE");
    // brokerWithNpmrc interpolates raw, so this writes two `cache=` lines.
    const a = brokerWithNpmrc(`${stale}\ncache=${live}`);
    try {
      expect(npmCacheDir(a.url)).toBe(live);
    } finally {
      a.cleanup();
    }
  });

  it("lets npm_config_cache win over any npmrc", () => {
    const a = brokerWithNpmrc(join(tmpdir(), "cache-A"));
    process.env.npm_config_cache = join(tmpdir(), "cache-ENV");
    resetNpmCacheDir();
    try {
      expect(npmCacheDir(a.url)).toBe(join(tmpdir(), "cache-ENV"));
    } finally {
      a.cleanup();
    }
  });

  it("expands a ${VAR} reference from the environment, as npm's config layer does", () => {
    // `cache=${XDG_CACHE_HOME}/npm` is how a dotfiles repo writes a relocated
    // cache, and @npmcli/config's envReplace expands it for every value it
    // loads from a file. Left literal it named a directory that exists on no
    // machine, readdirSync threw, and every npx sidecar quietly stayed on npx.
    // Plain double-quoted strings below, so JS does not interpolate what the
    // npmrc has to carry verbatim.
    const dir = join(tmpdir(), "cache-ENVREF");
    process.env.YAW_MCP_TEST_NPMRC_CACHE = dir;
    const bare = brokerWithNpmrc("${YAW_MCP_TEST_NPMRC_CACHE}");
    const inPath = brokerWithNpmrc("${YAW_MCP_TEST_NPMRC_CACHE}/npm");
    try {
      expect(npmCacheDir(bare.url)).toBe(dir);
      expect(npmCacheDir(inPath.url)).toBe(`${dir}/npm`);
    } finally {
      delete process.env.YAW_MCP_TEST_NPMRC_CACHE;
      bare.cleanup();
      inPath.cleanup();
    }
  });

  it("keeps an escaped or unset ${VAR} reference literal, as npm does", () => {
    // npm's two edge rules, mirrored so a value npm would leave alone is left
    // alone here too: an odd run of backslashes escapes the reference (one
    // backslash is consumed, the reference stays), and a name the environment
    // does not carry stays as written rather than collapsing to "".
    delete process.env.YAW_MCP_TEST_NPMRC_UNSET;
    process.env.YAW_MCP_TEST_NPMRC_CACHE = join(tmpdir(), "cache-ENVREF");
    const unset = brokerWithNpmrc("${YAW_MCP_TEST_NPMRC_UNSET}/npm");
    const escaped = brokerWithNpmrc("\\${YAW_MCP_TEST_NPMRC_CACHE}");
    try {
      expect(npmCacheDir(unset.url)).toBe("${YAW_MCP_TEST_NPMRC_UNSET}/npm");
      expect(npmCacheDir(escaped.url)).toBe("${YAW_MCP_TEST_NPMRC_CACHE}");
    } finally {
      delete process.env.YAW_MCP_TEST_NPMRC_CACHE;
      unset.cleanup();
      escaped.cleanup();
    }
  });

  // Every case below yields a cache dir that does not exist if it is decoded
  // wrong, after which readdirSync throws, npmCacheNpxNodeModules returns [],
  // and every npx sidecar quietly stays on npx -- indistinguishable from "no
  // sidecars installed". `brokerWithNpmrc` interpolates its argument straight
  // into the `cache=` line, so these pass the RAW value npm would parse.

  it("drops an inline comment rather than capturing it into the path", () => {
    const dir = join(tmpdir(), "cache-A");
    const a = brokerWithNpmrc(`${dir} ; scratch dir`);
    try {
      expect(npmCacheDir(a.url)).toBe(dir);
    } finally {
      a.cleanup();
    }
  });

  it("unquotes a quoted value", () => {
    const dir = join(tmpdir(), "cache A with spaces");
    const a = brokerWithNpmrc(`"${dir}"`);
    try {
      expect(npmCacheDir(a.url)).toBe(dir);
    } finally {
      a.cleanup();
    }
  });

  it("keeps the backslashes in a Windows path", () => {
    // The regression a generic unescape causes: npm's ini keeps an escape that
    // does NOT precede \ ; or # together WITH its backslash, which is the only
    // reason `cache=C:\Users\me\npm-cache` survives at all. Getting this wrong
    // yields `C:Usersmenpm-cache`.
    const a = brokerWithNpmrc(String.raw`C:\Users\test\npm-cache`);
    try {
      expect(npmCacheDir(a.url)).toBe(String.raw`C:\Users\test\npm-cache`);
    } finally {
      a.cleanup();
    }
  });

  it("treats an escaped semicolon as part of the value, not a comment", () => {
    const a = brokerWithNpmrc(String.raw`/tmp/a\;b`);
    try {
      expect(npmCacheDir(a.url)).toBe("/tmp/a;b");
    } finally {
      a.cleanup();
    }
  });

  it("expands a leading ~/ the way npm does for path fields", () => {
    // `cache=~/.npm-cache` is a natural thing to write, and an unexpanded "~"
    // is a directory that does not exist on any platform.
    const a = brokerWithNpmrc("~/.npm-cache");
    try {
      expect(npmCacheDir(a.url)).toBe(join(homedir(), ".npm-cache"));
    } finally {
      a.cleanup();
    }
  });

  it("reads the GLOBAL npmrc in the POSIX <prefix>/lib/node_modules layout", () => {
    // The global npmrc is `<prefix>/etc/npmrc`, and how far the prefix sits
    // above the global root differs by platform: Windows is
    // `<prefix>\node_modules` (one up), POSIX `<prefix>/lib/node_modules` (two
    // up). Only the one-up form was pushed, so on mac/Linux the candidate was
    // `$PREFIX/lib/etc/npmrc` -- a path npm never writes. A relocated cache was
    // then never seen, the resolver fell back to the compiled-in default, and
    // npmCacheNpxNodeModules scanned an `_npx` npm no longer fills: every
    // `npx -y <pkg>` sidecar silently stayed on npx.
    //
    // Built with path.join, so this exercises the same two-levels-up arithmetic
    // on a Windows runner as on POSIX -- ownNodeModules only splits on a
    // `node_modules` path segment and never touches the real filesystem layout.
    const root = mkdtempSync(join(tmpdir(), "npmcache-posix-"));
    try {
      const nm = join(root, "lib", "node_modules");
      mkdirSync(join(nm, "@yawlabs", "mcp", "dist"), { recursive: true });
      mkdirSync(join(root, "etc"), { recursive: true });
      // No builtin npmrc beside npm here: the global file is the only one that
      // can answer, which is the point.
      writeFileSync(join(root, "etc", "npmrc"), `cache=${join(tmpdir(), "cache-GLOBAL")}\n`);
      const url = pathToFileURL(join(nm, "@yawlabs", "mcp", "dist", "index.js")).href;
      expect(npmCacheDir(url)).toBe(join(tmpdir(), "cache-GLOBAL"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still reads the GLOBAL npmrc in the Windows <prefix>/node_modules layout", () => {
    // The other half of the pair: adding the POSIX candidate must not displace
    // the layout that already worked.
    const root = mkdtempSync(join(tmpdir(), "npmcache-win-"));
    try {
      const nm = join(root, "node_modules");
      mkdirSync(join(nm, "@yawlabs", "mcp", "dist"), { recursive: true });
      mkdirSync(join(root, "etc"), { recursive: true });
      writeFileSync(join(root, "etc", "npmrc"), `cache=${join(tmpdir(), "cache-GLOBAL-WIN")}\n`);
      const url = pathToFileURL(join(nm, "@yawlabs", "mcp", "dist", "index.js")).href;
      expect(npmCacheDir(url)).toBe(join(tmpdir(), "cache-GLOBAL-WIN"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the global npmrc ahead of the builtin one", () => {
    // Precedence check: both etc/npmrc candidates are GLOBAL-tier, so adding
    // the second one must not push either of them BEHIND the builtin. npm's
    // order is user > global > builtin, and with both files setting `cache` the
    // global value is the one that must win.
    const root = mkdtempSync(join(tmpdir(), "npmcache-order-"));
    try {
      const nm = join(root, "lib", "node_modules");
      mkdirSync(join(nm, "@yawlabs", "mcp", "dist"), { recursive: true });
      mkdirSync(join(nm, "npm"), { recursive: true });
      mkdirSync(join(root, "etc"), { recursive: true });
      writeFileSync(join(root, "etc", "npmrc"), `cache=${join(tmpdir(), "cache-GLOBAL")}\n`);
      writeFileSync(join(nm, "npm", "npmrc"), `cache=${join(tmpdir(), "cache-BUILTIN")}\n`);
      const url = pathToFileURL(join(nm, "@yawlabs", "mcp", "dist", "index.js")).href;
      expect(npmCacheDir(url)).toBe(join(tmpdir(), "cache-GLOBAL"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("npxSpecIndex / npxSpec", () => {
  // One rule, three callers: rewriteForOam plus the two collectors in
  // sidecars-cmd that PARTITION the same server set into installed/skipped. The
  // rule used to be written twice more, in a whole-list-filter shape whose argv
  // half was the 0.74.2 bug (a server's own trailing `--yes` was eaten).

  it("finds the first argument npx does not consume itself", () => {
    expect(npxSpecIndex(["-y", "@yawlabs/fetch-mcp@latest"])).toBe(1);
    expect(npxSpecIndex(["@yawlabs/fetch-mcp"])).toBe(0);
    expect(npxSpecIndex(["--yes", "-y", "pkg"])).toBe(2);
  });

  it("returns -1 when npx's own flags are all there is", () => {
    expect(npxSpecIndex([])).toBe(-1);
    expect(npxSpecIndex(["-y", "--yes"])).toBe(-1);
  });

  it("does NOT skip a -y that belongs to the server", () => {
    // The head-scan half of the 0.74.2 fix: -y is npx's only BEFORE the spec.
    // A whole-list filter agrees on the index here but not on the tail, which
    // is how the two shapes drifted apart silently.
    const args = ["-y", "pkg", "--yes", "--flag"];
    expect(npxSpecIndex(args)).toBe(1);
    expect(args.slice(npxSpecIndex(args) + 1)).toEqual(["--yes", "--flag"]);
  });

  it("refuses a leading flag yaw-mcp does not parse", () => {
    // `npx --package x -- y` and friends: the first survivor is a flag, not a
    // package name, and treating it as one would install a nonsense dependency.
    expect(npxSpec(["--package", "x"])).toBeNull();
    expect(npxSpec(["-y", "-p", "x"])).toBeNull();
    expect(npxSpec([])).toBeNull();
    expect(npxSpec(["-y", "pkg", "--verbose"])).toBe("pkg");
  });
});

describe("resolveNpmEntry", () => {
  // Build a temp npx cache: the broker in cache "aaa", a sidecar in sibling
  // "bbb". `brokerUrl` is a module path under "aaa" so the resolver derives the
  // sibling caches from it.
  //
  // Every call below passes an EXPLICIT npmCache (null, or the fixture's own
  // cache root). Letting it default would resolve the host's real npm cache,
  // where these very package names are present in several versions -- the
  // assertions would then pass or fail based on what the developer happens to
  // have npx'd, which is exactly the machine-dependence the injectable
  // parameter exists to prevent.
  function fixture(): { root: string; npx: string; brokerUrl: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "resolve-"));
    const npx = join(root, "_npx");
    mkdirSync(join(npx, "aaa", "node_modules", "@yawlabs", "mcp", "dist"), { recursive: true });
    const brokerUrl = pathToFileURL(join(npx, "aaa", "node_modules", "@yawlabs", "mcp", "dist", "index.js")).href;
    return { root, npx, brokerUrl, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }
  /**
   * Write a package.json AND the file its bin/main points at.
   *
   * packageEntry existsSync's the entry it resolves -- a DECLARED entry is not
   * an entry on disk -- so a fixture that writes only the manifest resolves to
   * null and every assertion below collapses into "the package was not found",
   * which is the condition these tests exist to distinguish resolution FROM.
   * Deriving the path from the json keeps the two in step when a case changes
   * its bin shape. A manifest with neither bin nor main gets no file, which is
   * deliberate: that is the exports-only package the fall-through test needs.
   *
   * EVERY declared bin gets a file, not just the first. packageEntry picks
   * `bin[unscoped] ?? bin[name] ?? the first one`, and writing only the first
   * made the other two tiers unbuildable here: the file the lookup selected
   * would not exist, packageEntry's existsSync would reject it, and the case
   * would collapse into "the package was not found" -- so a source that
   * dropped the tiers for a plain first-bin passed every test in this file.
   */
  function writeManifest(dir: string, json: Record<string, unknown>): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(json));
    const bin = json.bin;
    const rels: string[] = [];
    if (typeof bin === "string") rels.push(bin);
    else if (bin && typeof bin === "object") rels.push(...Object.values(bin as Record<string, string>));
    else if (typeof json.main === "string") rels.push(json.main);
    for (const rel of rels) {
      const entry = join(dir, rel);
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(entry, "");
    }
  }

  function writePkg(npx: string, pkg: string, json: Record<string, unknown>): string {
    const dir = join(npx, "bbb", "node_modules", ...pkg.split("/"));
    writeManifest(dir, json);
    return dir;
  }

  it("resolves a sidecar's BIN, not its ESM-only exports library entry", async () => {
    const { npx, brokerUrl, cleanup } = fixture();
    // Real-world shape: bin is the CLI (dist/index.js); exports is ESM-only
    // (import/types, no require/default) so require.resolve throws -- the bug.
    const dir = writePkg(npx, "@yawlabs/fetch-mcp", {
      name: "@yawlabs/fetch-mcp",
      type: "module",
      main: "./dist/server.js",
      bin: { "fetch-mcp": "./dist/index.js" },
      exports: { ".": { import: "./dist/server.js", types: "./dist/server.d.ts" } },
    });
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, null, null)).toBe(join(dir, "dist", "index.js"));
    } finally {
      cleanup();
    }
  });

  it("falls back to the first bin when none is keyed by the unscoped name", async () => {
    const { npx, brokerUrl, cleanup } = fixture();
    const dir = writePkg(npx, "@modelcontextprotocol/server-memory", {
      name: "@modelcontextprotocol/server-memory",
      bin: { "mcp-server-memory": "dist/index.js" }, // bin key != unscoped name
    });
    try {
      expect(resolveNpmEntry("@modelcontextprotocol/server-memory", brokerUrl, null, null)).toBe(
        join(dir, "dist", "index.js"),
      );
    } finally {
      cleanup();
    }
  });

  it("prefers the bin keyed by the UNSCOPED name over the first declared one", async () => {
    // Tier 1 of `bin[unscoped] ?? bin[name] ?? first`. Every other scoped
    // fixture in this file declares exactly ONE bin, where tiers 1 and 3 are
    // the same file -- so a source that dropped the keyed lookup for a plain
    // Object.values(bin)[0] passed all of them. Here they disagree.
    const { npx, brokerUrl, cleanup } = fixture();
    const dir = writePkg(npx, "@yawlabs/fetch-mcp", {
      name: "@yawlabs/fetch-mcp",
      // Declared FIRST, so a first-bin pick answers with the wrong file.
      bin: { "other-tool": "dist/other.js", "fetch-mcp": "dist/index.js" },
    });
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, null, null)).toBe(join(dir, "dist", "index.js"));
    } finally {
      cleanup();
    }
  });

  it("takes the bin keyed by the package's FULL name before falling to the first", async () => {
    // Tier 2, the middle rung, which nothing else exercised: a scoped package
    // whose bin key is the whole `@scope/name`. Deleting it would silently
    // demote every such package to whichever bin happens to be declared first.
    const { npx, brokerUrl, cleanup } = fixture();
    const dir = writePkg(npx, "@yawlabs/fetch-mcp", {
      name: "@yawlabs/fetch-mcp",
      bin: { "other-tool": "dist/other.js", "@yawlabs/fetch-mcp": "dist/full.js" },
    });
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, null, null)).toBe(join(dir, "dist", "full.js"));
    } finally {
      cleanup();
    }
  });

  it("falls back to main when there is no bin", async () => {
    const { npx, brokerUrl, cleanup } = fixture();
    const dir = writePkg(npx, "libonly", { name: "libonly", main: "lib/main.js" });
    try {
      expect(resolveNpmEntry("libonly", brokerUrl, null, null)).toBe(join(dir, "lib", "main.js"));
    } finally {
      cleanup();
    }
  });

  // The SHAPE of a package.json is as untrusted as its syntax: this reads
  // every `_npx/<hash>` cache dir on the machine plus the managed tree. A
  // malformed manifest used to throw a TypeError out of the connect path,
  // where upstream wraps it as an ActivationError and its one-shot node
  // respawn never fires (the rewrite was never applied) -- so the server
  // failed to activate at all where a null would have kept it on npx for
  // free. Written by hand rather than through writeManifest, which derives
  // the files to create from a WELL-FORMED bin.

  it("returns null, rather than throwing, for a bin that is not a string", async () => {
    // `bin: {"x": 1}` reached isAbsolute, which throws ERR_INVALID_ARG_TYPE
    // on a non-string instead of answering false.
    const { npx, brokerUrl, cleanup } = fixture();
    const dir = join(npx, "bbb", "node_modules", "badbin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "badbin", bin: { x: 1 } }));
    try {
      expect(() => resolveNpmEntry("badbin", brokerUrl, null, null)).not.toThrow();
      expect(resolveNpmEntry("badbin", brokerUrl, null, null)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("returns null for a manifest that is valid JSON but not a package object", async () => {
    const { npx, brokerUrl, cleanup } = fixture();
    const dir = join(npx, "bbb", "node_modules", "nullpkg");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "null");
    try {
      expect(() => resolveNpmEntry("nullpkg", brokerUrl, null, null)).not.toThrow();
      expect(resolveNpmEntry("nullpkg", brokerUrl, null, null)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("reads only the package's OWN bin keys, never Object.prototype's", async () => {
    // `bin[unscoped]` on a package named "constructor" used to return Object's
    // constructor function -- truthy, so it won the tier lookup and then threw
    // out of isAbsolute. The first declared bin is the right answer.
    const { npx, brokerUrl, cleanup } = fixture();
    const dir = writePkg(npx, "constructor", { name: "constructor", bin: { "ctor-cli": "dist/index.js" } });
    try {
      expect(resolveNpmEntry("constructor", brokerUrl, null, null)).toBe(join(dir, "dist", "index.js"));
    } finally {
      cleanup();
    }
  });

  it("returns null when the package is in no cache", async () => {
    const { brokerUrl, cleanup } = fixture();
    try {
      expect(resolveNpmEntry("@yawlabs/nonexistent-mcp", brokerUrl, null, null)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("finds an npx-cached sidecar when the broker is NOT itself under _npx", async () => {
    // The globally-installed shape, and the one that was broken: a broker at
    // <globalroot>/@yawlabs/mcp has no "_npx" segment in its path, so the
    // path-derived cache search returned nothing and EVERY `npx -y <pkg>`
    // sidecar silently stayed on npx -- while doctor reported it as "oam".
    // Passing the cache root explicitly is what makes the lookup independent
    // of how the broker itself was launched.
    const { root, npx, cleanup } = fixture();
    const globalUrl = pathToFileURL(join(root, "global", "node_modules", "@yawlabs", "mcp", "dist", "index.js")).href;
    const dir = writePkg(npx, "@yawlabs/fetch-mcp", {
      name: "@yawlabs/fetch-mcp",
      bin: { "fetch-mcp": "./dist/index.js" },
    });
    try {
      // Without the cache root it cannot be found at all...
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", globalUrl, null, null)).toBeNull();
      // ...and with it, the same global broker reaches the same sidecar.
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", globalUrl, root, null)).toBe(join(dir, "dist", "index.js"));
    } finally {
      cleanup();
    }
  });

  it("picks the highest version when the npx cache holds several copies", async () => {
    // The cache is keyed by content hash, so a machine that has run a server
    // for months keeps every version it ever fetched (15 copies of one sidecar
    // is real). Iteration order is hash order, so "first hit" silently pinned
    // an arbitrary build -- a config saying `@latest` running months-old code
    // with nothing logged anywhere.
    const { root, npx, brokerUrl, cleanup } = fixture();
    const mk = (hash: string, version: string) => {
      const dir = join(npx, hash, "node_modules", "@yawlabs", "fetch-mcp");
      writeManifest(dir, { name: "@yawlabs/fetch-mcp", version, bin: { "fetch-mcp": "./dist/index.js" } });
      return dir;
    };
    // The newest copy is deliberately placed so it sorts LAST. Directory order
    // is what the old code followed, so an oldest-first layout is the only one
    // that actually fails when "first hit wins" comes back.
    mk("aaa0", "0.1.0");
    mk("mmm5", "0.3.3");
    const newest = mk("zzz9", "0.3.6");
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root, null)).toBe(join(newest, "dist", "index.js"));
    } finally {
      cleanup();
    }
  });

  it("lets a higher version in a sibling cache beat a copy in the broker's OWN _npx dir", async () => {
    // The broker's own node_modules is authoritative only when it is DURABLE.
    // Under _npx it is a cache copy like any other, so taking it outright let
    // a stale sidecar sitting in our own content-hashed dir preempt a newer
    // copy the highest-version scan exists to find. (Only the ranking was
    // wrong: the replaced branch already tagged an own _npx copy "npx-cache",
    // so the refresh advice it carried was the npx one, not "npm install".)
    const { npx, brokerUrl, cleanup } = fixture();
    const own = join(npx, "aaa", "node_modules", "@yawlabs", "fetch-mcp");
    writeManifest(own, { name: "@yawlabs/fetch-mcp", version: "0.1.0", bin: { "fetch-mcp": "./dist/index.js" } });
    const sibling = join(npx, "bbb", "node_modules", "@yawlabs", "fetch-mcp");
    writeManifest(sibling, { name: "@yawlabs/fetch-mcp", version: "0.9.0", bin: { "fetch-mcp": "./dist/index.js" } });
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, null, null)).toBe(join(sibling, "dist", "index.js"));
    } finally {
      cleanup();
    }
  });

  it("prefers the managed sidecar tree over a newer cached copy", async () => {
    // `yaw-mcp sidecars install` maintains this tree, and re-running that
    // command is how a version moves forward. A newer cache copy winning
    // would make the managed version unreachable and the command pointless.
    const { root, npx, brokerUrl, cleanup } = fixture();
    const managed = join(root, "managed", "node_modules");
    const managedPkg = join(managed, "@yawlabs", "fetch-mcp");
    writeManifest(managedPkg, {
      name: "@yawlabs/fetch-mcp",
      version: "0.3.0",
      bin: { "fetch-mcp": "./dist/index.js" },
    });
    const cached = join(npx, "aaa0", "node_modules", "@yawlabs", "fetch-mcp");
    writeManifest(cached, { name: "@yawlabs/fetch-mcp", version: "9.9.9", bin: { "fetch-mcp": "./dist/index.js" } });
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root, managed)).toBe(
        join(managedPkg, "dist", "index.js"),
      );
    } finally {
      cleanup();
    }
  });

  it("falls through to the cache when the managed copy has no bin or main", async () => {
    // An exports-only package (no `bin`, no `main`) has no runnable entry to
    // point oam at, so the managed copy cannot be used even though the install
    // succeeded. Falling through to a cached copy that DOES declare one beats
    // failing, but it means `sidecars install` can report a package as
    // installed while the spawn still comes from the cache -- pin that so the
    // asymmetry is a decision rather than a surprise.
    const { root, npx, cleanup } = fixture();
    const managed = join(root, "managed", "node_modules");
    const managedPkg = join(managed, "@yawlabs", "fetch-mcp");
    // No bin, no main -- so writeManifest deliberately leaves no entry file.
    writeManifest(managedPkg, {
      name: "@yawlabs/fetch-mcp",
      version: "9.9.9",
      exports: { ".": { import: "./dist/lib.js" } },
    });
    const cached = join(npx, "aaa0", "node_modules", "@yawlabs", "fetch-mcp");
    writeManifest(cached, { name: "@yawlabs/fetch-mcp", version: "0.1.0", bin: { "fetch-mcp": "./dist/index.js" } });
    const brokerUrl = pathToFileURL(join(root, "global", "node_modules", "@yawlabs", "mcp", "dist", "index.js")).href;
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root, managed)).toBe(join(cached, "dist", "index.js"));
    } finally {
      cleanup();
    }
  });

  // The pinned-sidecar notice, per SOURCE. The three sources want different
  // things: the managed tree is a decision the user already made, while an
  // ambient durable copy and a cache copy are invisible without this line --
  // and each is refreshed by a different command, so naming the wrong one is
  // worse than saying nothing.

  /** Pinned-sidecar notices the logger put on stderr while `fn` ran, PARSED,
   *  and excluding debug.
   *
   *  Parsed rather than substring-matched because the envelope is JSON, so a
   *  Windows path arrives backslash-escaped and no raw `toContain(dir)` would
   *  ever match on the platform most likely to have one.
   *
   *  Debug is filtered EXPLICITLY rather than relied on being suppressed by
   *  the default LOG_LEVEL: process.env is process-wide and a sibling file
   *  raises the level to assert the managed notice, so under worker reuse the
   *  suppression is not guaranteed. Filtering here makes "empty" mean "said
   *  nothing at info" by construction instead of by scheduling luck. */
  function captureNotices(fn: () => void): Array<Record<string, unknown>> {
    resetPinnedSidecarLog();
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return chunks
      .join("")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => String(e.msg ?? "").includes("will not self-update") && e.level !== "debug");
  }

  function writeResolvablePkg(nodeModules: string, version: string): void {
    writeManifest(join(nodeModules, "@yawlabs", "fetch-mcp"), {
      name: "@yawlabs/fetch-mcp",
      version,
      bin: { "fetch-mcp": "./dist/index.js" },
    });
  }

  /** The entry writeResolvablePkg produces under a given node_modules. */
  function entryIn(nodeModules: string): string {
    return join(nodeModules, "@yawlabs", "fetch-mcp", "dist", "index.js");
  }

  it("stays quiet about a managed-tree pin, which the user opted into", () => {
    // `sidecars install` prints these versions on its way out and doctor
    // reports them on demand, so an info line per package on every boot only
    // restates a decision the user already made.
    const { root, brokerUrl, cleanup } = fixture();
    const managed = join(root, "managed", "node_modules");
    writeResolvablePkg(managed, "0.3.0");
    try {
      expect(captureNotices(() => resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root, managed))).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("reports a durable install with the command that refreshes it", () => {
    // An ambient global/project node_modules is not something the user aimed
    // at yaw-mcp, so the pin genuinely is invisible without this.
    const { root, cleanup } = fixture();
    const nm = join(root, "global", "node_modules");
    writeResolvablePkg(nm, "0.1.0");
    const brokerUrl = pathToFileURL(join(nm, "@yawlabs", "mcp", "dist", "index.js")).href;
    try {
      const [note] = captureNotices(() => resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, null, null));
      expect(note, "a durable hit reported no pin at all").toBeDefined();
      expect(note.source).toBe("durable");
      expect(note.refreshWith).toBe("npm install @yawlabs/fetch-mcp@latest");
      // No Ctrl-C note here: `npm install` exits on its own, so the guidance
      // is npx-cache-only and the field must not leak onto other sources.
      expect("refreshNote" in note, "refreshNote leaked onto a durable pin").toBe(false);
      expect(note.version).toBe("0.1.0");
      // The command alone is not actionable: a durable tree may be global
      // (needs -g) or project-local, so without the directory the user would
      // run it in whatever cwd they happen to be in and update nothing.
      expect(note.from, "no directory, so the refresh command has nowhere to run").toBe(nm);
    } finally {
      cleanup();
    }
  });

  it("calls the broker's OWN node_modules a cache when it sits under _npx", () => {
    // `npx -y @yawlabs/mcp` puts the broker itself inside the npx cache, so
    // ownNodeModules hands back a CACHE path -- the common install shape, not
    // an edge case. Classifying that as durable advertised `npm install`,
    // which cannot refresh a content-hashed cache directory.
    const { npx, brokerUrl, cleanup } = fixture();
    const cacheNodeModules = join(npx, "aaa", "node_modules");
    writeResolvablePkg(cacheNodeModules, "0.2.0");
    try {
      const [note] = captureNotices(() => resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, null, null));
      expect(note).toBeDefined();
      expect(note.source, "the broker's own _npx node_modules was called durable").toBe("npx-cache");
      // No `--help` in the advice: stdio MCP servers ignore the flag and just
      // start, so the old form hung the user's terminal on a server waiting
      // for stdin. The flag-free run refreshes the cache before exec. And no
      // trailing `# ...` comment: `#` starts a comment in sh and PowerShell
      // but NOT cmd.exe, which forwarded it as literal argv the spawned
      // server then choked on. The Ctrl-C guidance rides in refreshNote.
      expect(note.refreshWith).toBe("npx -y @yawlabs/fetch-mcp@latest");
      expect(note.refreshNote).toBe("then Ctrl-C -- the cache is refreshed before the server starts");
      expect(note.from).toBe(cacheNodeModules);
    } finally {
      cleanup();
    }
  });

  it("names the cache directory the WINNING copy came from", () => {
    // `from` is what makes the refresh advice actionable, so naming a cache
    // dir the entry did not come from is worse than omitting it. bestRoot is
    // assigned inside the same conditional as best; if the two fall out of
    // step nothing else notices, because every other test in this file
    // asserts only the resolved entry path.
    const { root, npx, brokerUrl, cleanup } = fixture();
    const mk = (hash: string, version: string) => {
      const dir = join(npx, hash, "node_modules");
      writeResolvablePkg(dir, version);
      return dir;
    };
    // Hashes deliberately unsorted, so `from` is right only if bestRoot is
    // assigned alongside best rather than following directory order. None of
    // them is the broker's own cache ("aaa"), but that is incidental now: an
    // own `_npx` copy is a cache copy like any other and never enters the
    // take-outright durable loop -- which is what the sibling test above ("lets
    // a higher version in a sibling cache beat a copy in the broker's OWN _npx
    // dir") exists to pin.
    mk("aaa0", "0.1.0");
    const newest = mk("zzz9", "0.3.6");
    mk("mmm5", "0.3.3");
    try {
      const [note] = captureNotices(() => resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root, null));
      expect(note).toBeDefined();
      expect(note.source).toBe("npx-cache");
      expect(note.version).toBe("0.3.6");
      expect(note.from, "reported a cache dir other than the winning copy's").toBe(newest);
    } finally {
      cleanup();
    }
  });

  it("prefers a durable install over any cached copy, even a newer one", async () => {
    // A real `npm i` is a deliberate choice and the single copy; the cache is
    // incidental. Version order must not override that.
    const { root, npx, cleanup } = fixture();
    const home = join(root, "global", "node_modules");
    const durable = join(home, "@yawlabs", "fetch-mcp");
    writeManifest(durable, { name: "@yawlabs/fetch-mcp", version: "0.1.0", bin: { "fetch-mcp": "./dist/index.js" } });
    const brokerUrl = pathToFileURL(join(home, "@yawlabs", "mcp", "dist", "index.js")).href;
    const cachedDir = join(npx, "aaa0", "node_modules", "@yawlabs", "fetch-mcp");
    writeManifest(cachedDir, {
      name: "@yawlabs/fetch-mcp",
      version: "9.9.9",
      bin: { "fetch-mcp": "./dist/index.js" },
    });
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root, null)).toBe(join(durable, "dist", "index.js"));
    } finally {
      cleanup();
    }
  });

  it("refuses a declared entry that is not on disk", async () => {
    // package.json is a MANIFEST, not a file listing. A `files` field that omits
    // the bin, a partially pruned cache directory, or an interrupted install all
    // leave a manifest pointing at nothing -- and resolving it anyway guarantees
    // a failed spawn (`oam run <missing>` exits 1 immediately with
    // error[OAM-RT0002]), which then burns upstream's one-shot node respawn
    // where staying on npx cost nothing.
    const { npx, brokerUrl, cleanup } = fixture();
    const dir = join(npx, "bbb", "node_modules", "gone-mcp");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "gone-mcp", bin: "./dist/index.js" }));
    try {
      expect(resolveNpmEntry("gone-mcp", brokerUrl, null, null)).toBeNull();
      // The SAME manifest resolves once the file it names exists, so this fails
      // when the existence check is deleted rather than passing for some
      // unrelated reason (a fixture typo would fail both halves).
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "dist", "index.js"), "");
      expect(resolveNpmEntry("gone-mcp", brokerUrl, null, null)).toBe(join(dir, "dist", "index.js"));
    } finally {
      cleanup();
    }
  });

  it("lets a real version displace a present-but-unparseable one", async () => {
    // compareVersions returns 0 for anything it cannot parse, so an incumbent
    // whose `version` is non-null but not x.y.z could never BE displaced: the
    // copy the directory listing happened to surface first won outright, and
    // the highest-version pick -- the entire reason this loop exists -- was back
    // to hash order. The old comment here claimed the rule was symmetric; it
    // only ever held in the one direction.
    const { root, npx, brokerUrl, cleanup } = fixture();
    writeResolvablePkg(join(npx, "aaa0", "node_modules"), "1.2"); // listed FIRST
    const good = join(npx, "zzz9", "node_modules");
    writeResolvablePkg(good, "0.3.6");
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root, null)).toBe(entryIn(good));
    } finally {
      cleanup();
    }
  });

  it("prefers a release over its own prerelease, not whichever came first", async () => {
    // "0.4.0" and "0.4.0-rc.1" both truncate to the same triple, so a
    // triple-only comparator called them equal and left hash order to decide
    // which build a config saying `@latest` actually ran. The release is placed
    // LAST here, so "first hit wins" fails this.
    const { root, npx, brokerUrl, cleanup } = fixture();
    writeResolvablePkg(join(npx, "aaa0", "node_modules"), "0.4.0-rc.1");
    const release = join(npx, "zzz9", "node_modules");
    writeResolvablePkg(release, "0.4.0");
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root, null)).toBe(entryIn(release));
    } finally {
      cleanup();
    }
  });

  // A pinned spec (`npx -y pkg@0.2.0`) asks a different question than `@latest`:
  // not "the best copy on disk" but "this exact build, or nothing". `oam run
  // <entry>` runs whatever sits at the path, so a version-agnostic lookup
  // silently answered the first question when the config asked the second.

  it("skips a managed copy at the wrong version and takes the pinned one from the cache", async () => {
    // The managed tree is authoritative about WHERE, not about WHICH BUILD.
    // Falling through to a cache copy that does declare the pin honours the
    // config; taking the managed copy would break it silently.
    const { root, npx, brokerUrl, cleanup } = fixture();
    const managed = join(root, "managed", "node_modules");
    writeResolvablePkg(managed, "9.9.9");
    const cached = join(npx, "aaa0", "node_modules");
    writeResolvablePkg(cached, "0.2.0");
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root, managed, "0.2.0")).toBe(entryIn(cached));
      // Unpinned, the managed tree still wins outright -- the pin is the only
      // thing that may override it.
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root, managed)).toBe(entryIn(managed));
    } finally {
      cleanup();
    }
  });

  it("returns null when nothing on disk declares the pinned version", async () => {
    // Which keeps npx -- the only thing that can actually fetch the pin.
    const { root, npx, brokerUrl, cleanup } = fixture();
    writeResolvablePkg(join(npx, "aaa0", "node_modules"), "2.0.0");
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root, null, "0.2.0")).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("accepts a copy that differs from the pin only by build metadata", async () => {
    // Semver says build metadata carries no precedence, and npm publishes the
    // same release under it, so refusing here would drop to npx for no reason.
    const { root, npx, brokerUrl, cleanup } = fixture();
    const cached = join(npx, "aaa0", "node_modules");
    writeResolvablePkg(cached, "1.2.3+build.5");
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root, null, "1.2.3")).toBe(entryIn(cached));
    } finally {
      cleanup();
    }
  });

  it("never satisfies a pin from a copy that declares no version at all", async () => {
    // It cannot be shown to be the requested build, and "probably right" is
    // exactly what the check replaces.
    const { root, npx, brokerUrl, cleanup } = fixture();
    const cached = join(npx, "aaa0", "node_modules");
    writeManifest(join(cached, "@yawlabs", "fetch-mcp"), {
      name: "@yawlabs/fetch-mcp",
      bin: { "fetch-mcp": "./dist/index.js" },
    });
    try {
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root, null, "1.0.0")).toBeNull();
      // ...but it is still a perfectly good answer for an unpinned spec.
      expect(resolveNpmEntry("@yawlabs/fetch-mcp", brokerUrl, root, null)).toBe(entryIn(cached));
    } finally {
      cleanup();
    }
  });
});

// probeOam spawns `oam --version` asynchronously and settles on a deadline: the
// timer resolves the probe whether or not the child ever exits, so a wedged
// binary on the upstream connect path of a single-threaded broker cannot hold
// the hub. (It was execFileSync until #91, and a synchronous probe with a
// `timeout` still hung on an unkillable child -- see spawnVersionProbe.) These
// pin both halves of the contract: the bound exists, and exceeding it degrades
// to the same node fallback that an absent oam already produces.
describe("probeOam timeout", () => {
  beforeEach(() => resetOamBinCache());
  afterEach(() => resetOamBinCache());

  it("declares a 3s probe timeout, the literal uv's onPath budget also uses", async () => {
    // A LITERAL pin, not the cross-module relationship the old title claimed:
    // uv-bootstrap's onPath hard-codes its own `3_000` rather than importing
    // this constant, so the two budgets can drift with nothing failing. Keeping
    // them equal is a manual job until one of them exports the number.
    expect(OAM_PROBE_TIMEOUT_MS).toBe(3_000);
  });

  it("falls back to node when the probe times out", async () => {
    // The spawn's deadline rejects with `code: "ETIMEDOUT"` -- the shape
    // execFileSync used to throw, kept so probeOam's catch is unchanged -- and
    // that catch must produce the same result as "oam is not installed".
    const probe = await probeOam(async () => {
      const err = new Error("spawnSync oam ETIMEDOUT") as Error & { code?: string };
      err.code = "ETIMEDOUT";
      throw err;
    });
    expect(probe.bin).toBeNull();
    expect(probe.version).toBeNull();
    expect(probe.belowMin).toBe(false);
  });

  it("leaves an opted-in server on its original node/npx command after a timeout", async () => {
    const probe = await probeOam(async () => {
      const err = new Error("spawnSync oam ETIMEDOUT") as Error & { code?: string };
      err.code = "ETIMEDOUT";
      throw err;
    });
    const original = { command: "npx", args: ["-y", "some-mcp-server"] };
    const rewritten = rewriteForOam(original.command, original.args, {
      oamBin: probe.bin,
      resolveEntry: () => "/somewhere/entry.js",
    });
    expect(rewritten).toEqual(original);
  });
});

// A timeout is not the same event as "oam is not installed", even though both
// land on the same node fallback. oam IS on disk and did not answer in time --
// and because the probe result is cached for the process lifetime, that one
// slow moment downgrades every opted-in server until restart. Without a log
// there is nothing to tell the user why their oam-hosted servers stopped
// using oam.
describe("probeOam timeout diagnostics", () => {
  beforeEach(() => resetOamBinCache());
  afterEach(() => resetOamBinCache());

  /** Collect everything the logger writes to stderr while `fn` runs. */
  async function captureStderr(fn: () => unknown): Promise<Array<{ level?: string; msg?: string }>> {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    try {
      await fn();
    } finally {
      process.stderr.write = original;
    }
    return chunks
      .join("")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { level?: string; msg?: string });
  }

  it("warns when the probe times out, so the silent downgrade is diagnosable", async () => {
    const lines = await captureStderr(() =>
      probeOam(async () => {
        const err = new Error("spawnSync oam ETIMEDOUT") as Error & { code?: string };
        err.code = "ETIMEDOUT";
        throw err;
      }),
    );
    const warn = lines.find((l) => l.msg?.includes("did not respond to --version"));
    expect(warn).toBeDefined();
    expect(warn?.level).toBe("warn");
  });

  it("stays silent when oam is simply not installed", async () => {
    // ENOENT is the routine node-only setup; logging it would be noise on
    // every machine without oam.
    const lines = await captureStderr(() =>
      probeOam(async () => {
        const err = new Error("spawnSync oam ENOENT") as Error & { code?: string };
        err.code = "ENOENT";
        throw err;
      }),
    );
    expect(lines).toEqual([]);
  });

  it("warns when the probe fails for any reason other than 'not installed'", async () => {
    // A present-but-broken oam -- exits non-zero on --version, is killed by a
    // signal, is not executable -- downgrades every opted-in server to node
    // for the process lifetime exactly like a timeout does. Silence there
    // leaves nothing to explain why oam quietly stopped being used.
    const lines = await captureStderr(() =>
      probeOam(async () => {
        throw new Error("oam exited 1");
      }),
    );
    const warn = lines.find((l) => l.msg?.includes("oam --version failed"));
    expect(warn).toBeDefined();
    expect(warn?.level).toBe("warn");
  });
});

// Two hardening fixes after #92 shipped.
describe("probeOam hardening", () => {
  beforeEach(() => resetOamBinCache());
  afterEach(() => resetOamBinCache());

  // These assert the COLLECTOR's behaviour. The previous version of this test
  // only asserted that OAM_PROBE_MAX_OUTPUT sat in a plausible range, which
  // passes with the capping logic deleted outright -- it proved nothing.

  it("caps retained output hard, even against a single oversized chunk", () => {
    // The first implementation checked the length BEFORE appending, so one
    // big chunk landed whole: an 80KB chunk was retained in full.
    const c = createProbeCollector(1024);
    c.push("x".repeat(80 * 1024));
    expect(c.retainedLength()).toBe(1024);

    c.push("y".repeat(80 * 1024));
    expect(c.retainedLength()).toBe(1024);
  });

  it("still finds a version that arrives after the cap", () => {
    // The real damage of a naive prefix cap: the version is discarded, so
    // parseOamVersion returns null, so the `version !== null` guard skips the
    // MIN_OAM_VERSION check -- hosting on an oam that was never version-gated.
    const c = createProbeCollector(64);
    c.push("banner ".repeat(200)); // well past the cap, no version in it
    c.push("oam 0.9.1\n");
    expect(parseOamVersion(c.result())).toBe("0.9.1");
  });

  it("finds a version split across a chunk boundary, past the cap", () => {
    // The cap must be already full, otherwise the head buffer happens to
    // contain both halves and the test passes without the carry doing any
    // work -- which is exactly how the first version of this test passed
    // with the carry deleted.
    const c = createProbeCollector(16);
    c.push("banner ".repeat(50)); // head is now full of text with no version
    c.push("oam 0.");
    c.push("6.0\n");
    expect(parseOamVersion(c.result())).toBe("0.6.0");
  });

  it("stops collecting once the version is known", () => {
    // `found` is monotonic and result() never reaches `head` once it is set,
    // so a further chunk has nothing to do. Without the early return each one
    // still costs a full-chunk concat plus a slice -- paid precisely by the
    // runaway binary the cap exists to bound.
    const c = createProbeCollector(1024);
    c.push("oam 1.2.3\n");
    const retained = c.retainedLength();

    c.push("x".repeat(80 * 1024));
    expect(c.retainedLength()).toBe(retained);
    expect(parseOamVersion(c.result())).toBe("1.2.3");
  });

  it("keeps the first version when several appear", () => {
    const c = createProbeCollector();
    c.push("oam 1.2.3\n");
    c.push("plugin 9.9.9\n");
    expect(parseOamVersion(c.result())).toBe("1.2.3");
  });

  it("lets the NEXT chunk extend a version that ended flush with the buffer", () => {
    // stdout is a byte stream: "oam 0.12.1" and "-rc.1" can arrive as separate
    // chunks. Latching on the first parse hit dropped the prerelease suffix,
    // and a floor-equal rc then compares EQUAL to MIN_OAM_VERSION instead of
    // below it -- so the exact build the gate exists to refuse gets hosted.
    // A match that runs to the very end of what has been seen is only a
    // PREFIX, so it is held until a later chunk settles it.
    const c = createProbeCollector();
    c.push("oam 0.12.1");
    c.push("-rc.1\n");
    expect(c.result()).toBe("0.12.1-rc.1");
  });

  it("still reports a flush version when the stream closes without another chunk", () => {
    // The other half of holding it: `oam 0.12.1` with no trailing newline is
    // the whole output, so result() has to finalize what is held rather than
    // fall through to the capped head (which parses to null and skips the
    // gate entirely).
    const c = createProbeCollector();
    c.push("oam 0.12.1");
    expect(c.result()).toBe("0.12.1");
  });

  it("returns capped text (which parses to null) when no version appears", () => {
    const c = createProbeCollector(32);
    c.push("no version here at all, and quite a lot of it".repeat(10));
    expect(c.retainedLength()).toBe(32);
    expect(parseOamVersion(c.result())).toBeNull();
  });

  it("a below-min version past the cap still trips the gate end to end", async () => {
    // The consequence chain, exercised through probeOam rather than the
    // collector: a chatty binary must not smuggle an old oam past the gate.
    const probe = await probeOam(async () => {
      const c = createProbeCollector(64);
      c.push("banner ".repeat(200));
      c.push(`oam 0.0.1\n`);
      return c.result();
    });
    expect(probe.belowMin).toBe(true);
    expect(probe.bin).toBeNull();
  });

  it("does not let a probe that was in flight during a reset publish its result", async () => {
    // Otherwise the reset is silently undone by a probe the caller believes
    // it discarded -- one test's probe populating the next test's cache.
    let release: (v: string) => void = () => {};
    const slow = () =>
      new Promise<string>((r) => {
        release = r;
      });

    const inflight = probeOam(slow);
    resetOamBinCache(); // caller discards that probe
    release("oam 9.9.9"); // ...which only now lands
    await inflight;

    // A fresh probe must actually run rather than reading the discarded result.
    let ran = false;
    const after = await probeOam(async () => {
      ran = true;
      return "oam 1.2.3";
    });
    expect(ran, "stale in-flight probe published over the reset").toBe(true);
    expect(after.version).toBe("1.2.3");
  });

  it("does not let a stale probe release the in-flight slot of the one that replaced it", async () => {
    // The test above releases the stale probe BEFORE the replacement starts,
    // so the ordering the generation guard actually exists for -- stale settles
    // LAST, after a newer probe already owns the slot -- never runs. Unguarded,
    // the stale .finally clears oamProbeInFlight and the next caller starts a
    // second spawn against state the live probe is already resolving.
    let releaseStale: (v: string) => void = () => {};
    const stale = () =>
      new Promise<string>((r) => {
        releaseStale = r;
      });
    // One resolver per invocation, so a spurious second probe is counted rather
    // than silently stealing the first one's resolver and hanging the test.
    const freshCalls: Array<(v: string) => void> = [];
    const fresh = () => new Promise<string>((r) => freshCalls.push(r));

    const staleProbe = probeOam(stale);
    resetOamBinCache();
    const freshProbe = probeOam(fresh); // claims the in-flight slot

    releaseStale("oam 9.9.9"); // ...and only now does the discarded probe land
    await staleProbe;

    // A caller arriving here must JOIN the live probe, not start another.
    const joiner = probeOam(fresh);
    for (const release of freshCalls) release("oam 1.2.3");
    const [a, b] = await Promise.all([freshProbe, joiner]);

    expect(freshCalls, "stale probe's cleanup released the live probe's slot").toHaveLength(1);
    expect(a).toEqual(b);
    expect(a.version).toBe("1.2.3");
  });
});

describe("MIN_OAM_VERSION freshness floor", () => {
  /** The ratchet. ONE literal, and the title is built from it, so the two
   *  cannot say different numbers -- the title used to name 0.13.0 while the
   *  body asserted 0.13.1. */
  const FLOOR = "0.13.1";

  it(`is at least ${FLOOR} (bump this literal when you bump the floor)`, () => {
    // POLICY (see the constant's doc): the floor tracks the LATEST oam
    // release, bumped with every release. This literal-floor pin mirrors
    // the UV_VERSION freshness test in uv-bootstrap.test.ts: every other
    // MIN_OAM_VERSION assertion derives its fixture FROM the constant, so
    // without this a stale floor was invisible to the suite. That makes this
    // the ONE deliberate exception to the derive-from-constant rule: a floor
    // derived from the constant would assert the constant against itself.
    // The contract is ONE-directional: the constant can never drop below
    // this literal (a revert fails here); raising the constant without the
    // literal passes and merely leaves this pin weak, so bump BOTH together.
    // Catching a NEW upstream release still takes the release checklist --
    // a network-dependent freshness gate is deliberately out (see the
    // doctor-cmd stance on network in tests).
    expect(compareVersions(MIN_OAM_VERSION, FLOOR)).toBeGreaterThanOrEqual(0);
  });
});

describe("resolveOamSpawn -- unavailable-oam warning", () => {
  beforeEach(() => resetOamBinCache());
  afterEach(() => {
    resetOamBinCache();
    vi.restoreAllMocks();
  });

  /** Prime the probe cache as "oam absent" so this does not depend on whether
   *  the machine running the tests has oam. */
  async function primeAbsent(): Promise<void> {
    await probeOam(async () => {
      const e: NodeJS.ErrnoException = new Error("spawn oam ENOENT");
      e.code = "ENOENT";
      throw e;
    });
  }

  /** Start capturing stderr, one entry per write. The array is LIVE -- it keeps
   *  filling as the logger writes -- because several cases here assert between
   *  calls rather than once at the end. The spy is dropped by this describe's
   *  afterEach (vi.restoreAllMocks).
   *
   *  Deliberately raw chunks, not the parsed envelopes captureNotices and
   *  captureStderr return elsewhere in this file: everything here is a
   *  substring match on one warn, so parsing would only add a way to fail. */
  function captureStderrLines(): string[] {
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      lines.push(String(chunk));
      return true;
    });
    return lines;
  }

  it("stays silent when oam is only the default, not an opt-in", async () => {
    // `optedIn` false is "nothing configured, oam is merely the default" -- the
    // stock config on every node-only machine. Dropping the `optedIn &&` from
    // the gate would print "a server opted in to oam but oam is not installed",
    // with install commands attached, once per broker boot to users who never
    // opted into anything -- on the stderr MCP clients surface, for a broker
    // that is spawned per client session.
    await primeAbsent();
    const lines = captureStderrLines();
    await resolveOamSpawn("node", ["a.js"], false);
    expect(lines.filter((l) => l.includes("opted in to oam"))).toHaveLength(0);
    // ...and the silence did not spend the once-per-process flag: the gate
    // short-circuits on optedIn BEFORE setting it, so a genuine opt-in
    // immediately afterwards still gets its one warn.
    await resolveOamSpawn("node", ["b.js"], true);
    expect(lines.filter((l) => l.includes("opted in to oam"))).toHaveLength(1);
  });

  it("warns once per process, not once per opted-in server", async () => {
    await primeAbsent();
    const lines = captureStderrLines();
    // A broker hosting a dozen opted-in servers must not print this a dozen
    // times on every boot.
    await resolveOamSpawn("node", ["a.js"]);
    await resolveOamSpawn("node", ["b.js"]);
    await resolveOamSpawn("node", ["c.js"]);
    const warnings = lines.filter((l) => l.includes("opted in to oam but oam is not installed"));
    expect(warnings).toHaveLength(1);
    // and it carries the install command -- the whole point of warning
    expect(warnings[0]).toContain("oamjs.org/install.sh");
  });

  it("stays silent for a launch oam could never host (docker / uvx / python)", async () => {
    // upstream.ts calls resolveOamSpawn for EVERY local server whose
    // effective runtime is oam. For a non-node command the warn told the
    // user to install oam while doctor reported the same server as
    // `not-node-command`, and claimed a node fallback that never happens.
    await primeAbsent();
    const lines = captureStderrLines();
    await resolveOamSpawn("docker", ["run", "-i", "x/mcp"]);
    await resolveOamSpawn("uvx", ["some-mcp"]);
    await resolveOamSpawn("python", ["-m", "server"]);
    expect(lines.filter((l) => l.includes("opted in to oam but oam is not installed"))).toHaveLength(0);
    // ...and a node launch after them still gets the (single) warn.
    await resolveOamSpawn("node", ["a.js"]);
    expect(lines.filter((l) => l.includes("opted in to oam but oam is not installed"))).toHaveLength(1);
  });

  it("stays silent when oam is present", async () => {
    await probeOam(async () => "oam 99.0.0");
    const lines = captureStderrLines();
    await resolveOamSpawn("node", ["a.js"]);
    expect(lines.filter((l) => l.includes("oam is not installed"))).toHaveLength(0);
  });

  // A BROKEN oam and an ABSENT one both reach this warn with bin=null, and they
  // send the user to OPPOSITE fixes. doctor and describeServerRuntime already
  // branch on probe.failure; this warn was the last surface reporting every
  // failure as absence -- one line after the probe itself said `--version`
  // failed, which is how the log told a user with oam on disk to install oam.
  it("says INSTALLED AND UNUSABLE for a broken oam, with no install instructions", async () => {
    await probeOam(async () => {
      const e: NodeJS.ErrnoException = new Error("spawn oam EACCES");
      e.code = "EACCES";
      throw e;
    });
    const lines = captureStderrLines();
    // Three servers, one line: the flag is shared with the absent case because
    // both are the same event to the user (asked for oam, got node).
    await resolveOamSpawn("node", ["a.js"]);
    await resolveOamSpawn("node", ["b.js"]);
    const warnings = lines.filter((l) => l.includes("opted in to oam but oam is installed and unusable"));
    expect(warnings).toHaveLength(1);
    // The shared label, not a second wording of it, plus the raw error a ticket
    // needs.
    expect(warnings[0]).toContain(oamFailureLabel("spawn"));
    expect(warnings[0]).toContain("spawn oam EACCES");
    // The specific harm being fixed: reinstall instructions for software the
    // user demonstrably already has.
    expect(lines.filter((l) => l.includes("oamjs.org/install"))).toHaveLength(0);
    expect(lines.filter((l) => l.includes("oam is not installed"))).toHaveLength(0);
  });

  it("still says NOT INSTALLED for a timeout's opposite -- absence keeps the install commands", async () => {
    // The absent case is unchanged; this pins that the new branch did not
    // capture it. (A timeout is a FAILURE and lands in the branch above.)
    await primeAbsent();
    const lines = captureStderrLines();
    await resolveOamSpawn("node", ["a.js"]);
    expect(lines.filter((l) => l.includes("oam is installed and unusable"))).toHaveLength(0);
    expect(lines.filter((l) => l.includes("oamjs.org/install.sh"))).toHaveLength(1);
  });

  it("names the TIMEOUT budget's own label, not the generic one", async () => {
    // Each failure gets its own wording (oamFailureLabel is what enforces that),
    // so the warn must not flatten them into one "oam is broken".
    await probeOam(async () => {
      const e: NodeJS.ErrnoException = new Error("oam --version exceeded 3000ms");
      e.code = "ETIMEDOUT";
      throw e;
    });
    const lines = captureStderrLines();
    await resolveOamSpawn("node", ["a.js"]);
    const warnings = lines.filter((l) => l.includes("oam is installed and unusable"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(oamFailureLabel("timeout"));
    expect(warnings[0]).not.toContain(oamFailureLabel("spawn"));
  });

  it("stays silent for a below-min install, which warns in the probe instead", async () => {
    // Two warnings for one condition would be noise; belowMin already reports
    // both versions, which is strictly more actionable.
    await probeOam(async () => "oam 0.0.1");
    const lines = captureStderrLines();
    await resolveOamSpawn("node", ["a.js"]);
    expect(lines.filter((l) => l.includes("opted in to oam but oam is not installed"))).toHaveLength(0);
  });
});

describe("isOamCommand / isOamLaunch", () => {
  it("recognises an oam command with either path separator", () => {
    expect(isOamCommand("oam")).toBe(true);
    expect(isOamCommand("oam.exe")).toBe(true);
    expect(isOamCommand("/usr/local/bin/oam")).toBe(true);
    // Windows writes this shape, and a "/"-only split silently missed it.
    expect(isOamCommand(String.raw`C:\Users\jeff\oam.exe`)).toBe(true);
    expect(isOamCommand("npx")).toBe(false);
    expect(isOamCommand("cmd")).toBe(false);
    expect(isOamCommand("/usr/bin/node")).toBe(false);
    // Not a substring match: a different binary that merely contains "oam".
    expect(isOamCommand("/usr/bin/foam")).toBe(false);
  });

  // These assert the shapes a CONFIG FILE actually contains. An earlier
  // version asserted `sh -c` with a single-token payload and `cmd` with a bare
  // `/c` -- neither occurs in practice, so the suite went green while every
  // realistic wrapped entry returned false.
  it("sees through a cmd wrapper, including its everyday switch set", () => {
    expect(isOamLaunch("cmd", ["/c", "oam", "run", "x.js"])).toBe(true);
    expect(isOamLaunch("cmd.exe", ["/C", String.raw`C:\bin\oam.exe`, "run"])).toBe(true);
    // `/d /s /c` is what npm and most wrappers emit -- the common case, and
    // the one the first version missed by matching only an exact "/c".
    expect(isOamLaunch("cmd", ["/d", "/s", "/c", "oam", "run", "x.js"])).toBe(true);
    expect(isOamLaunch("cmd", ["/d", "/s", "/c", "npx", "-y", "@yawlabs/mcp@latest"])).toBe(false);
  });

  it("sees through a POSIX shell wrapper, whose payload is ONE string", () => {
    // `sh -c` does not receive separate argv entries -- this is the shape that
    // silently failed before.
    expect(isOamLaunch("sh", ["-c", "oam run /path/index.js"])).toBe(true);
    expect(isOamLaunch("bash", ["-c", "/usr/local/bin/oam run x.js"])).toBe(true);
    expect(isOamLaunch("sh", ["-c", "npx -y @yawlabs/mcp@latest"])).toBe(false);
    // Quoting is tolerated only when it does not hide a space: tokenising on
    // whitespace cannot recover `'/opt/my oam/oam'`, and a display marker is
    // not worth a shell parser. Under-reporting (says node) is the safe way
    // to be wrong here -- it never claims oam for something that is not.
    expect(isOamLaunch("sh", ["-c", `"oam" run x.js`])).toBe(true);
    expect(isOamLaunch("sh", ["-c", `'/opt/my oam/oam' run x.js`])).toBe(false);
    expect(isOamLaunch("sh", ["-c", "   "])).toBe(false);
    expect(isOamLaunch("sh", ["-c"])).toBe(false);
  });

  it("under-reports a COMBINED shell switch, and reads a payload with no -c at all", () => {
    // The payload lookup is `args[indexOf("-c") + 1]`, falling back to args[0].
    // `bash -lc "<script>"` -- the shape GUI MCP clients write to get a login
    // PATH -- packs the switches into ONE argv entry, so indexOf misses and the
    // fallback answers with "-lc", which is not a command. It therefore reports
    // node for an entry that plainly launches oam. Pinned as the same
    // deliberate under-report as a quoted path containing a space: recovering
    // it means parsing shell switch clusters, and being wrong in the direction
    // that never CLAIMS oam is the safe half.
    expect(isOamLaunch("bash", ["-lc", "oam run x.js"])).toBe(false);
    // The no-`-c` fallback taken on its own terms: args[0] IS the script, so a
    // payload passed without a switch still reads correctly, either way.
    expect(isOamLaunch("sh", ["oam run x.js"])).toBe(true);
    expect(isOamLaunch("sh", ["npx -y @yawlabs/mcp@latest"])).toBe(false);
  });

  it("judges a non-shell command on itself, never on its arguments", () => {
    // Otherwise `node --require oam ...` would read as oam-hosted.
    expect(isOamLaunch("node", ["oam"])).toBe(false);
    expect(isOamLaunch("npx", ["oam"])).toBe(false);
    expect(isOamLaunch("oam", [])).toBe(true);
    expect(isOamLaunch("npx", [])).toBe(false);
    // A POSIX path argument must never be read as a cmd switch.
    expect(isOamLaunch("cmd", ["/c", "/usr/local/bin/oam"])).toBe(true);
  });
});

describe("oam published-binary gate", () => {
  it("ships every windows and macos arch, but linux x64 only", () => {
    for (const arch of ["x64", "arm64"]) {
      expect(oamPublishesBinaryFor("win32", arch), `win32-${arch}`).toBe(true);
      expect(oamPublishesBinaryFor("darwin", arch), `darwin-${arch}`).toBe(true);
    }
    expect(oamPublishesBinaryFor("linux", "x64")).toBe(true);
    // The whole reason this gate exists: install.sh REFUSES on aarch64 Linux
    // ("no published oam binary for Linux aarch64 yet"), so printing the curl
    // one-liner there hands over a command that cannot succeed.
    expect(oamPublishesBinaryFor("linux", "arm64")).toBe(false);
  });

  it("refuses a platform with no asset at all rather than assuming one", () => {
    expect(oamPublishesBinaryFor("freebsd", "x64")).toBe(false);
    expect(oamPublishesBinaryFor("linux", "ppc64")).toBe(false);
  });

  it("agrees with the running machine's platform and arch", () => {
    expect(oamPublishesBinaryForThisMachine()).toBe(oamPublishesBinaryFor(process.platform, process.arch));
  });
});

describe("oamInstallAdvice", () => {
  // A report ABOUT another OS carries no arch, so the gate must not fire on it
  // -- guessing this machine's arch for a platform we cannot see would turn
  // "I do not know" into a confident claim. These hold on every host.
  const otherOses = (["macos", "linux", "windows"] as const).filter((o) => o !== CURRENT_OS);

  it("hands back the platform's one-liner for any OS that is not this machine", () => {
    for (const os of otherOses) {
      expect(oamInstallAdvice(os), os).toBe(os === "windows" ? OAM_INSTALL_PS1 : OAM_INSTALL_SH);
    }
  });

  it("withholds the installer for THIS machine only when no binary is published", () => {
    const advice = oamInstallAdvice(CURRENT_OS);
    if (oamPublishesBinaryForThisMachine()) {
      expect(advice).toBe(CURRENT_OS === "windows" ? OAM_INSTALL_PS1 : OAM_INSTALL_SH);
    } else {
      expect(advice).toBe(oamNoBinaryReason());
      expect(advice).not.toContain("oamjs.org/install");
    }
  });

  it("names the platform it could not find a binary for", () => {
    expect(oamNoBinaryReason()).toContain(`${process.platform}-${process.arch}`);
  });

  it("stays ASCII, because doctor prints it verbatim to a terminal", () => {
    // A legacy Windows console renders a UTF-8 em-dash as mojibake, and this
    // line is written to be pasted into a support thread -- where the mangled
    // bytes then spread. Built with fromCharCode so this test cannot itself
    // be the thing that reintroduces the character.
    const emDash = String.fromCharCode(0x2014);
    expect(oamNoBinaryReason()).not.toContain(emDash);
    // Space through tilde: the printable ASCII range, written literally so the
    // assertion is about bytes rather than about one character.
    expect(oamNoBinaryReason()).toMatch(/^[ -~]+$/);
    expect(oamNoBinaryReason()).toContain(" -- build from source");
  });
});

describe("oamHeapOomHint", () => {
  it("recognizes oam's heap-cap death and names the lever that fixes it", () => {
    const banner = "error[OAM-RT-OOM]: JavaScript heap out of memory -- reached the 4096 MB cap (default 4 GiB)";
    const hint = oamHeapOomHint(banner);
    expect(hint).not.toBeNull();
    expect(hint).toContain("OAM_MAX_HEAP_MB");
    // The other escape hatch: pin the server off oam entirely.
    expect(hint).toContain("bundles.json");
  });

  it("matches the stable code, not the banner's wording", () => {
    // The prose carries the resolved cap and whether it came from the env, so
    // it is the part most likely to be reworded between oam releases.
    expect(oamHeapOomHint("error[OAM-RT-OOM]: heap exhausted, cap set by OAM_MAX_HEAP_MB")).not.toBeNull();
  });

  it("stays silent for every other stderr, including a node-hosted OOM", () => {
    expect(oamHeapOomHint("")).toBeNull();
    expect(oamHeapOomHint("Error: connect ECONNREFUSED")).toBeNull();
    // node's abort carries no OAM code -- surfacing OAM_MAX_HEAP_MB to someone
    // not running oam would point them at a variable nothing reads.
    expect(oamHeapOomHint("FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed")).toBeNull();
  });
});
