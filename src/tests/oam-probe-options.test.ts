// probeOam's DEFAULT runner -- the one that actually reaches child_process.
//
// The sibling oam-spawn.test.ts always injects a fake `run`, which is the right
// shape for testing the parse + version-gate logic but structurally cannot
// observe the spawn. That left the spawn options and the timeout untested:
// delete either and every test over there still passes, while the hang they
// prevent comes back.
//
// So this file mocks node:child_process and calls probeOam() with NO argument,
// which is what production does. Split into its own file (rather than added to
// oam-spawn.test.ts) because the mock is module-scoped -- the same reason
// uv-bootstrap's child_process mocks live in -extract / -fixes / -network.
//
// Rewritten for issue #91: the probe was execFileSync + timeout, which does not
// bound the call (spawnSync only SENDS the signal, then waits for an exit an
// unkillable child never produces). It is now spawn + a timer, so the central
// assertion here is no longer "the option is set" but "the event loop keeps
// turning while a probe hangs".

import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SpawnCall {
  bin: string;
  args: string[];
  opts: Record<string, unknown>;
}

const spawnCalls: SpawnCall[] = [];
const killed: string[] = [];
const unrefed: number[] = [];
const stdoutDestroyed: number[] = [];
/** When true the fake child never exits -- the wedged-binary case. */
let hangForever = false;
/** When true the fake stdout emits an 'error' before its data -- the pipe
 *  fault that is an uncaught exception if nothing is listening. */
let errorOnStdout = false;
/** When set, spawn() throws it synchronously -- the reject path that runs
 *  before any listener or the deadline timer exists. */
let spawnThrows: Error | null = null;
/** When set, the child emits 'error' instead of exiting -- the ENOENT shape
 *  every machine without oam produces. */
let childError: (Error & { code?: string }) | null = null;
/** stdout the fake child writes before closing. Empty models a build that
 *  prints --version to the stderr this probe discards. */
let stdoutChunks: string[] = ["oam 9.9.9\n"];
/** close() args. `code` is null exactly when the child died on a signal. */
let exitCode: number | null = 0;
let exitSignal: string | null = null;

vi.mock("node:child_process", () => ({
  spawn: (bin: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ bin, args: [...(args ?? [])], opts: { ...opts } });
    if (spawnThrows) throw spawnThrows;
    const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void; destroy: () => void };
    stdout.setEncoding = () => {};
    const child = new EventEmitter() as EventEmitter & {
      stdout: typeof stdout;
      kill: (sig?: string) => void;
      unref: () => void;
    };
    child.stdout = stdout;
    child.kill = (sig?: string) => {
      killed.push(sig ?? "default");
    };
    child.unref = () => {
      unrefed.push(1);
    };
    stdout.destroy = () => {
      stdoutDestroyed.push(1);
    };
    if (!hangForever) {
      // Emit on a later turn so the probe's listeners are attached first.
      setTimeout(() => {
        // Unhandled 'error' throws out of this callback, so 'close' never
        // fires and the probe falls through to its deadline -- the assertion
        // fails either way when the listener is missing.
        if (errorOnStdout) stdout.emit("error", new Error("EPIPE"));
        // An erroring child never reaches 'close' -- that is the whole shape.
        if (childError) {
          child.emit("error", childError);
          return;
        }
        for (const chunk of stdoutChunks) stdout.emit("data", chunk);
        child.emit("close", exitCode, exitSignal);
      }, 0);
    }
    return child;
  },
}));

const { OAM_PROBE_KILL_SIGNAL, OAM_PROBE_TIMEOUT_MS, probeOam, resetOamBinCache, winNormalize } = await import(
  "../oam-spawn.js"
);

describe("probeOam default runner", () => {
  const originalOamBin = process.env.OAM_BIN;
  /** The OAM_BIN every case here runs with: an absolute path that CANNOT
   *  exist. `spawn` is mocked, so nothing has to be on disk for the probe to
   *  succeed -- but `binPath` is resolved against the REAL filesystem, and the
   *  fixed "/usr/local/bin/oam" this used to carry is a path a macOS or Linux
   *  developer with oam installed genuinely has, which turned the binPath
   *  assertion below into a machine-dependent failure. Nothing is created, so
   *  there is nothing to clean up. */
  const missingBin = join(tmpdir(), `yaw-mcp-no-such-oam-${process.pid}`, "oam");

  beforeEach(() => {
    spawnCalls.length = 0;
    killed.length = 0;
    unrefed.length = 0;
    stdoutDestroyed.length = 0;
    hangForever = false;
    errorOnStdout = false;
    spawnThrows = null;
    childError = null;
    stdoutChunks = ["oam 9.9.9\n"];
    exitCode = 0;
    exitSignal = null;
    resetOamBinCache();
    process.env.OAM_BIN = missingBin;
  });

  afterEach(() => {
    vi.useRealTimers();
    resetOamBinCache();
    if (originalOamBin === undefined) delete process.env.OAM_BIN;
    else process.env.OAM_BIN = originalOamBin;
  });

  it("spawns `<bin> --version` with stdout piped and stderr off the broker's stdio", async () => {
    // The broker speaks MCP over its own stdio; a probe that inherited stderr
    // could interleave oam's output into the transport.
    const probe = await probeOam();

    expect(spawnCalls).toHaveLength(1);
    // Through winNormalize: a forward-slash OAM_BIN is backslash-converted on
    // Windows so cmd does not read a leading "/" as a switch.
    expect(spawnCalls[0].bin).toBe(winNormalize(missingBin));
    expect(spawnCalls[0].args).toEqual(["--version"]);
    expect(spawnCalls[0].opts.stdio).toEqual(["ignore", "pipe", "ignore"]);
    // Pinned too, because deleting it costs a console window flashing on every
    // probe under a GUI-launched broker -- and the stdio assertion above would
    // not notice.
    expect(spawnCalls[0].opts.windowsHide).toBe(process.platform === "win32");
    expect(probe.version).toBe("9.9.9");
  });

  it("hands oam an env with yaw-mcp's own secrets stripped", async () => {
    // README promises the vault passphrase is stripped from every child
    // yaw-mcp starts; this probe inherited process.env whole. The rest of the
    // env must still arrive (oam needs PATH and HOME), so the pin is on the
    // one key, not on an empty env.
    vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE", "hunter2-do-not-leak");
    try {
      await probeOam();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(spawnCalls).toHaveLength(1);
    const env = spawnCalls[0].opts.env as NodeJS.ProcessEnv | undefined;
    expect(env, "spawn must pass an explicit env").toBeDefined();
    expect(env).not.toHaveProperty("YAW_MCP_VAULT_PASSPHRASE");
    expect(Object.keys(env ?? {}).length).toBeGreaterThan(0);
  });

  it("keeps the event loop responsive while a wedged binary is being probed", async () => {
    // THE regression this file exists for. Under the old synchronous probe the
    // call blocked the loop outright, so nothing else could run until it
    // returned -- and with an unkillable child it never returned. Here the
    // probe is in flight and other work must still be scheduled and completed.
    //
    // Honest about what each assertion can catch. `otherWorkRan` alone cannot
    // fail: the mocked spawn returns immediately and never blocks anything. It
    // earns its place only PAIRED with `settled` below -- together they say the
    // other work ran WHILE the probe was still outstanding, which is the actual
    // claim. A regression to a synchronous probe does not fail either of them
    // cleanly; it fails at the module boundary (this file's mock exports only
    // `spawn`, so reaching for execFileSync throws) or by timing this test out.
    hangForever = true;
    vi.useFakeTimers();

    let settled = false;
    const pending = probeOam().then((p) => {
      settled = true;
      return p;
    });
    let otherWorkRan = false;
    setTimeout(() => {
      otherWorkRan = true;
    }, 1);

    await vi.advanceTimersByTimeAsync(2);
    expect(otherWorkRan, "event loop was blocked by the probe").toBe(true);
    expect(settled, "the probe settled before its deadline -- it was not in flight at all").toBe(false);

    // Now let the probe's own deadline expire.
    await vi.advanceTimersByTimeAsync(OAM_PROBE_TIMEOUT_MS);
    const probe = await pending;

    // Same degraded shape as "oam is not installed" -- callers fall back to
    // node -- EXCEPT for `failure`, which is the whole point of that field: oam
    // is on disk and wedged, and telling the user it is "not installed" sends
    // them to install an oam they already have.
    expect(probe).toEqual({
      bin: null,
      binPath: null,
      version: null,
      belowMin: false,
      failure: "timeout",
      failureDetail: `oam --version exceeded ${OAM_PROBE_TIMEOUT_MS}ms`,
    });
    // Best-effort kill still attempted, with the stronger signal.
    expect(killed).toEqual([OAM_PROBE_KILL_SIGNAL]);
  });

  it("probes once per process, not once per call", async () => {
    await probeOam();
    await probeOam();
    await probeOam();

    expect(spawnCalls).toHaveLength(1);
  });

  it("shares one spawn between callers that race before the first result lands", async () => {
    // N servers connecting at once must not each start their own probe: the
    // cache is only populated once the first one finishes.
    const [a, b, c] = await Promise.all([probeOam(), probeOam(), probeOam()]);

    expect(spawnCalls).toHaveLength(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("detaches the child on timeout so a survivor cannot hold the process open", async () => {
    // Killing is best-effort; DETACHING is what makes the shutdown safe. A
    // live child with a piped stdout keeps the PARENT's event loop alive --
    // verified out-of-band: a parent with an unkilled child and nothing else
    // pending was still running after 6s. So in the exact case this probe
    // exists for (a kill that does not take effect), settling the promise
    // unblocks the connect path but the broker could then never exit.
    hangForever = true;
    vi.useFakeTimers();

    const pending = probeOam();
    await vi.advanceTimersByTimeAsync(OAM_PROBE_TIMEOUT_MS);
    await pending;

    expect(killed).toEqual([OAM_PROBE_KILL_SIGNAL]);
    expect(unrefed, "child was not unref'd -- it can still hold the loop").toHaveLength(1);
    expect(stdoutDestroyed, "stdout pipe was not released").toHaveLength(1);
  });

  it("survives a pipe error on stdout rather than taking the broker down", async () => {
    // An 'error' on a stream with nothing listening is an uncaught exception,
    // and this file's whole premise is that the oam probe is an optimization
    // that must never kill the process. The timeout path destroys this pipe
    // while a wedged child may still be writing to it, so the fault is one the
    // probe creates deliberately -- it is not a hypothetical.
    errorOnStdout = true;

    const probe = await probeOam();

    // Swallowed: 'close' still settles the probe on the normal path.
    expect(probe.version).toBe("9.9.9");
  });

  it("falls back to node the moment the child errors, without waiting out the deadline", async () => {
    // The routine path on every machine without oam. The sibling file's ENOENT
    // tests all inject a fake `run`, so this listener could be deleted and they
    // would all still pass -- while each broker start stalls the full 3s on the
    // deadline before degrading. `killed` being empty is what pins that: only
    // the timeout path attempts a kill.
    //
    // OAM_BIN is cleared for this one case. The beforeEach sets it purely to
    // keep `binPath` off the real filesystem, but probeOam splits ENOENT on
    // whether the name was OURS to guess: a path the USER named and that is not
    // there is a broken configuration, tagged `failure`, while a bare `oam`
    // missing from PATH is the routine node-only machine this test is about.
    // The explicit half lives in oam-spawn-probe-log.test.ts; binPath is null
    // on both paths, so nothing here depends on the variable being set.
    delete process.env.OAM_BIN;
    const enoent = new Error("spawn oam ENOENT") as Error & { code?: string };
    enoent.code = "ENOENT";
    childError = enoent;

    const probe = await probeOam();

    // ENOENT is ABSENCE, not a failure: `bin === null` already says everything
    // there is to say, and tagging it would make doctor report a broken install
    // on every node-only machine.
    expect(probe).toEqual({
      bin: null,
      binPath: null,
      version: null,
      belowMin: false,
      failure: null,
      failureDetail: null,
    });
    expect(killed, "probe waited for the deadline instead of settling on 'error'").toEqual([]);
  });

  it("falls back to node when the probe exits non-zero", async () => {
    // A broken install that fails `--version`. Same node fallback as absent,
    // but classified as "exit": it RAN, so the fix is to repair the install
    // rather than to perform one. The EOAMEXIT tag spawnVersionProbe puts on a
    // non-zero close is what carries that across, and this is the only test
    // that drives the real tagging (the sibling file injects the code).
    stdoutChunks = [];
    exitCode = 1;

    const probe = await probeOam();

    expect(probe).toEqual({
      bin: null,
      binPath: null,
      version: null,
      belowMin: false,
      failure: "exit",
      failureDetail: "oam exited 1",
    });
    expect(killed).toEqual([]);
  });

  it("falls back to node when the child is killed by a signal", async () => {
    // `close` reports code null + a signal here (OOM killer, external kill),
    // which is the shape the exit-code branch has to survive -- and the signal
    // NAME is the one diagnostic the message carries, so it must reach
    // failureDetail rather than degrading to "oam exited null".
    stdoutChunks = [];
    exitCode = null;
    exitSignal = "SIGKILL";

    const probe = await probeOam();

    expect(probe).toEqual({
      bin: null,
      binPath: null,
      version: null,
      belowMin: false,
      failure: "exit",
      failureDetail: "oam exited SIGKILL",
    });
    expect(killed).toEqual([]);
  });

  it("degrades to node when spawn itself throws before any listener exists", async () => {
    // OAM_BIN is user-supplied and node rejects some values outright (a NUL
    // byte, say). This is the one reject path that never reaches settle() or
    // the deadline, so nothing else covers it. Classified "spawn": nothing ran,
    // so there is no exit code to report.
    spawnThrows = new TypeError("The argument 'file' must be a string without null bytes");

    const probe = await probeOam();

    expect(probe).toEqual({
      bin: null,
      binPath: null,
      version: null,
      belowMin: false,
      failure: "spawn",
      failureDetail: "The argument 'file' must be a string without null bytes",
    });
  });

  it("treats a clean exit with no parseable stdout as a usable oam", async () => {
    // stderr is discarded (stdio ["ignore","pipe","ignore"]), so a build that
    // prints --version there leaves version null -- and probeOamUncached gates
    // on `version !== null`, so MIN_OAM_VERSION is then never applied. That is
    // the same shape the collector's truncation fix exists to prevent, so pin
    // the decision rather than leave it to be rediscovered.
    stdoutChunks = [];

    const probe = await probeOam();

    expect(probe.version).toBeNull();
    expect(probe.belowMin).toBe(false);
    expect(probe.bin).toBe(winNormalize(missingBin));
    expect(probe.failure).toBeNull();
    // SPAWNABLE but not PERSISTABLE: this OAM_BIN does not exist on disk (see
    // missingBin -- it is a path chosen so that holds on every machine), so
    // there is no absolute path to write into someone else's config, and an
    // entry pointing at nothing is worse than one running on node.
    expect(probe.binPath).toBeNull();
  });

  it("unrefs its deadline timer so a pending probe cannot hold the process open", async () => {
    // Promised by the doc comment on spawnVersionProbe and checked by nothing:
    // drop the unref and a broker that starts and immediately shuts down waits
    // out the whole deadline before exiting.
    hangForever = true;
    vi.useFakeTimers();

    const unrefedTimers: NodeJS.Timeout[] = [];
    const schedule = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const handle = schedule(fn, ms) as unknown as NodeJS.Timeout;
      handle.unref = () => {
        unrefedTimers.push(handle);
        return handle;
      };
      return handle;
    }) as unknown as typeof globalThis.setTimeout);

    try {
      // The probe's executor -- spawn and setTimeout -- runs synchronously, so
      // the unref has already happened by the time probeOam() returns.
      const pending = probeOam();
      expect(unrefedTimers, "deadline timer was not unref'd").toHaveLength(1);

      await vi.advanceTimersByTimeAsync(OAM_PROBE_TIMEOUT_MS);
      await pending;
    } finally {
      spy.mockRestore();
    }
  });
});
