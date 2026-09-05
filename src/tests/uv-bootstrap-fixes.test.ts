import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// Pins for the two uv-bootstrap bug fixes that require mocking spawn:
//
//   Fix 1: onPath must pass shell:true on win32 so PATHEXT shims (.cmd)
//          are found and the probe doesn't false-negative on Windows --
//          which MATCHES the real spawn: the SDK's StdioClientTransport
//          goes through cross-spawn, which resolves PATHEXT shims and
//          wraps them in cmd.exe itself. A shell-less probe was tried and
//          reverted (it sent every .cmd-shim host to the bootstrap download).
//
//   Fix 2: ensureUv must clear the memo on rejection so a transient
//          failure doesn't poison every subsequent call for the process
//          lifetime.
//
// These live in a separate file so they can mock node:child_process at
// module level without breaking the other uv-bootstrap tests that rely
// on the real spawn (to probe whether uv is actually installed).
// ═══════════════════════════════════════════════════════════════════════

vi.mock("../logger.js", () => ({ log: vi.fn() }));

// Point cacheDir() at an empty temp dir. Otherwise resolveUv()'s cached-binary
// short-circuit (a non-empty `finalBin` stat returns it) finds a REAL
// cached uv binary that a previous bootstrap left under the OS cache root
// (e.g. %LOCALAPPDATA%\yaw-mcp\Cache) and RESOLVES -- defeating the spawn
// mock and making the rejection-path tests below pass in clean CI but fail
// on any dev box that has run uv. require() inside the factory because
// vi.mock is hoisted above the top-level imports.
vi.mock("../paths.js", () => {
  const nodeOs = require("node:os");
  const nodePath = require("node:path");
  return {
    cacheDir: () => nodePath.join(nodeOs.tmpdir(), "yaw-mcp-uvbf-test-cache"),
  };
});

// Mock undici so resolveUv's download path fails fast rather than hitting
// the network (which makes the test suite slow and flaky in CI).
vi.mock("undici", () => ({
  request: vi.fn().mockRejectedValue(new Error("network mocked out")),
}));

// Mock node:child_process at module level -- required for ESM mocking.
// We replace spawn with a factory that stores the last options and emits
// an error event so onPath returns false immediately. The timeout-path
// test flips spawnMode.hang: the fake child then never emits anything, so
// onPath's 3s timer is the only way out, and the fake records what the
// timeout handler did to it (kill signal, unref). spawnMode.pathHit is the
// opposite flip: the probe exits 0, so onPath returns true and ensureUv
// resolves to the literal "uv" -- how the memo-clear test proves a RETRY can
// actually succeed rather than merely re-failing.
const spawnCalls: Array<{ cmd: string; opts: Record<string, unknown> }> = [];
let spawnCallCount = 0;
const spawnMode = { hang: false, pathHit: false };
let lastHangChild: { killedWith?: string; unrefed?: boolean } | null = null;

vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  return {
    spawn: (cmd: string, _args: unknown, opts: Record<string, unknown>) => {
      spawnCallCount++;
      spawnCalls.push({ cmd, opts: { ...opts } });
      const fake = new EventEmitter();
      if (spawnMode.hang) {
        // A wedged probe: no 'close', no 'error', ever.
        fake.killedWith = undefined;
        fake.unrefed = false;
        fake.kill = (signal?: string) => {
          fake.killedWith = signal;
        };
        fake.unref = () => {
          fake.unrefed = true;
        };
        lastHangChild = fake;
        return fake;
      }
      fake.kill = () => {};
      if (spawnMode.pathHit) {
        // uv answers `--version` with exit 0: onPath resolves true.
        setImmediate(() => fake.emit("close", 0));
        return fake;
      }
      // Emit error asynchronously so the promise chain settles before we check.
      setImmediate(() => fake.emit("error", new Error("ENOENT (mocked)")));
      return fake;
    },
  };
});

import { __resetUvBootstrap, ensureUv, onPath } from "../uv-bootstrap.js";

beforeEach(() => {
  spawnCalls.length = 0;
  spawnCallCount = 0;
  spawnMode.hang = false;
  spawnMode.pathHit = false;
  lastHangChild = null;
  __resetUvBootstrap();
});

afterEach(async () => {
  __resetUvBootstrap();
  // resolveUv() mkdir's the (mocked) cache dir before the download fails;
  // clean the empty tree so we don't litter the OS temp dir.
  await fs.rm(path.join(os.tmpdir(), "yaw-mcp-uvbf-test-cache"), { recursive: true, force: true }).catch(() => {});
});

// ── Fix 1: onPath resolves the binary the way the SDK's spawn does ────
describe("onPath spawn options (fix 1)", () => {
  // The value onPath vouches for is handed to StdioClientTransport, which
  // spawns via cross-spawn: PATHEXT resolution + a cmd.exe wrapper for
  // .cmd/.bat shims. shell:true on win32 is the raw-spawn equivalent, so
  // a uv.cmd that passes this probe really does spawn at activation. A
  // shell:false probe false-NEGATIVED on that shim and sent every such
  // host to the ~20MB bootstrap download -- fatal with no github.com route.
  //
  // The platform is FORCED, not mirrored: computing the expectation from
  // `process.platform === "win32"` -- the exact expression under test -- passes
  // on a non-win32 runner even if the option is hard-coded back to false, which
  // is precisely the regression this pin exists to prevent. Same
  // Object.defineProperty technique as uv-bootstrap-extract.test.ts.
  async function probeOptsUnder(platform: NodeJS.Platform): Promise<Record<string, unknown>> {
    const orig = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      spawnCalls.length = 0;
      __resetUvBootstrap();
      await ensureUv().catch(() => {});
      // At least one spawn call must have been made (the onPath probe).
      expect(spawnCalls.length).toBeGreaterThan(0);
      return spawnCalls[0].opts;
    } finally {
      if (orig) Object.defineProperty(process, "platform", orig);
      __resetUvBootstrap();
    }
  }

  it("passes shell:true and windowsHide:true under a forced win32", async () => {
    const probeOpts = await probeOptsUnder("win32");
    expect(probeOpts.shell).toBe(true);
    expect(probeOpts.windowsHide).toBe(true);
  });

  it("passes shell:false and windowsHide:false under a forced linux", async () => {
    const probeOpts = await probeOptsUnder("linux");
    expect(probeOpts.shell).toBe(false);
    expect(probeOpts.windowsHide).toBe(false);
  });

  it("hands uv an env with yaw-mcp's own secrets stripped", async () => {
    // README promises the vault passphrase is stripped from every child
    // yaw-mcp starts; the probe (and the download-extract spawn, same option
    // block) inherited process.env whole. The rest of the env still arrives
    // (uv needs PATH), so the pin is on the one key, not on an empty env.
    const prev = process.env.YAW_MCP_VAULT_PASSPHRASE;
    process.env.YAW_MCP_VAULT_PASSPHRASE = "hunter2-do-not-leak";
    try {
      const probeOpts = await probeOptsUnder("linux");
      const env = probeOpts.env as NodeJS.ProcessEnv | undefined;
      expect(env, "spawn must pass an explicit env").toBeDefined();
      expect(env).not.toHaveProperty("YAW_MCP_VAULT_PASSPHRASE");
      expect(Object.keys(env ?? {}).length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.YAW_MCP_VAULT_PASSPHRASE;
      else process.env.YAW_MCP_VAULT_PASSPHRASE = prev;
    }
  });
});

// ── onPath timeout path: SIGKILL + unref, not a bare default kill ─────
describe("onPath timeout path", () => {
  it("SIGKILLs and unrefs a wedged probe child, then resolves false", async () => {
    // child.kill() with no signal is SIGTERM, which a trapping child ignores;
    // and a still-referenced live child holds the broker's event loop open at
    // shutdown even after settle(false). The timeout handler must therefore
    // send SIGKILL AND unref -- same contract as runCommand in the same file
    // and spawnVersionProbe in oam-spawn.ts.
    vi.useFakeTimers();
    spawnMode.hang = true;
    try {
      const probe = onPath("uv");
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(probe).resolves.toBe(false);
      expect(lastHangChild).not.toBeNull();
      expect(lastHangChild?.killedWith).toBe("SIGKILL");
      expect(lastHangChild?.unrefed).toBe(true);
    } finally {
      spawnMode.hang = false;
      vi.useRealTimers();
    }
  });
});

// ── uvTarget: unsupported platform/arch returns null; ensureUv surfaces message ──
describe("uvTarget unsupported platform/arch (coverage gap)", () => {
  // The branch that fires when uvTarget() returns null: resolveUv() throws
  // 'No prebuilt uv binary' + the docs URL.
  //
  // Strategy: ensureUv() calls onPath("uv") first (false -- the spawn mock
  // emits error), then resolveUv() calls uvTarget() with its default
  // parameters, which read process.platform/arch. Those two are stubbed to an
  // unsupported combination for the duration of the test. uvTarget itself is
  // exported and unit-tested per (platform, arch, libc) in uv-bootstrap.test.ts;
  // this test is about the ensureUv-level rejection the caller actually sees,
  // which only the platform stub reaches.
  it("ensureUv rejects with 'No prebuilt uv binary' message on unsupported platform/arch", async () => {
    __resetUvBootstrap();

    // Save the DESCRIPTORS, not the values. Restoring from a value alone
    // redefines the property with THIS test's descriptor and leans on
    // defineProperty's retain-unspecified-fields rule to happen to preserve
    // Node's `writable: false, enumerable: true` -- a subtlety that holds only
    // while the property still exists. Putting the saved descriptor back
    // restores process.platform/arch exactly as Node had them, unconditionally.
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const origArch = Object.getOwnPropertyDescriptor(process, "arch");

    // Stub to an unsupported combination.
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
    Object.defineProperty(process, "arch", { value: "mips", configurable: true });

    try {
      const err = await ensureUv().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("No prebuilt uv binary");
      expect((err as Error).message).toContain("https://docs.astral.sh/uv/");
    } finally {
      // Restore the saved descriptors verbatim.
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
      if (origArch) Object.defineProperty(process, "arch", origArch);
      __resetUvBootstrap();
    }
  });
});

// ── Fix 2: ensureUv clears memo on rejection ──────────────────────────
describe("ensureUv rejection memo clear (fix 2)", () => {
  it("retries after a transient failure instead of returning the same rejection", async () => {
    // First call -- rejects because spawn emits error (uv not on PATH).
    const first = await ensureUv().catch((e: unknown) => e);
    expect(first).toBeInstanceOf(Error);

    const countAfterFirst = spawnCallCount;

    // Second call -- must spawn again (new promise), not replay the cached rejection.
    const second = await ensureUv().catch((e: unknown) => e);
    expect(second).toBeInstanceOf(Error);
    expect(spawnCallCount).toBeGreaterThan(countAfterFirst);
  });

  it("succeeds on a retry after transient failure clears the memo", async () => {
    // First call fails: the probe ENOENTs (uv not on PATH) and the mocked
    // download rejects, so the memo must be dropped.
    const first = await ensureUv().catch((e: unknown) => e);
    expect(first).toBeInstanceOf(Error);

    // Now the transient condition clears -- the probe exits 0, so onPath finds
    // uv and resolveUv short-circuits to the literal "uv". A memo that survived
    // the rejection would replay it here and never reach the new spawn
    // behavior, so a RESOLVED "uv" is what proves the clear actually happened.
    // (The preceding test covers the re-fail case; this one covers success.)
    spawnMode.pathHit = true;
    const countBefore = spawnCallCount;
    await expect(ensureUv()).resolves.toBe("uv");
    expect(spawnCallCount).toBeGreaterThan(countBefore);
  });
});
