import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../logger.js";

// -----------------------------------------------------------------------
// logger.ts: spread-order pin (logger.ts:9)
//
// The JSON line is built as: { ...data, level, msg, ts }
// That means the envelope's own level/msg/ts ALWAYS appear last and
// clobber any same-named key in `data`. This test pins that contract so
// a refactor that swaps the spread order (e.g. { level, msg, ts, ...data })
// would be caught immediately.
// -----------------------------------------------------------------------

describe("log() spread-order: envelope fields win over data keys", () => {
  let stderrWrites: string[] = [];

  beforeEach(() => {
    stderrWrites = [];
    // log() resolves LOG_LEVEL per call, so a developer shell or CI runner
    // exporting LOG_LEVEL=warn (or error) would suppress the info lines these
    // tests read back -- two would fail and the warn-level one would pass
    // vacuously. Pin the threshold below every level used here.
    vi.stubEnv("LOG_LEVEL", "debug");
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") stderrWrites.push(chunk);
      else if (Buffer.isBuffer(chunk)) stderrWrites.push(chunk.toString("utf8"));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("envelope level/msg/ts survive when data carries the same keys", () => {
    // Call log() with data that tries to override the envelope fields.
    // Use "info" (not "debug") so the minLevel filter does not suppress the line.
    log("info", "real-msg", { level: "INJECTED_LEVEL", msg: "INJECTED_MSG", ts: "INJECTED_TS" });

    expect(stderrWrites.length).toBeGreaterThan(0);
    const line = stderrWrites[0].trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;

    // The envelope's own values must win.
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("real-msg");
    // ts is an ISO string; it must NOT be the injected literal.
    expect(parsed.ts).not.toBe("INJECTED_TS");
    expect(typeof parsed.ts).toBe("string");
  });

  it("data keys that do NOT clash with envelope fields appear in the JSON line", () => {
    log("info", "hello", { foo: "bar", count: 42 });

    const line = stderrWrites[0].trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.foo).toBe("bar");
    expect(parsed.count).toBe(42);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
  });

  it("log() with no data still emits a valid JSON line with level/msg/ts", () => {
    log("warn", "something-happened");

    const line = stderrWrites[0].trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;

    expect(parsed.level).toBe("warn");
    expect(parsed.msg).toBe("something-happened");
    expect(typeof parsed.ts).toBe("string");
  });
});

// -----------------------------------------------------------------------
// logger.ts robustness: the log line must never take the process (or the
// caller's own work) down with it, and LOG_LEVEL must be readable per call.
// -----------------------------------------------------------------------

describe("log() failure containment", () => {
  let stderrWrites: string[] = [];

  beforeEach(() => {
    stderrWrites = [];
    // Same reason as the describe above: these assert on emitted lines at
    // warn / error / info, so an inherited LOG_LEVEL must not decide the
    // threshold.
    vi.stubEnv("LOG_LEVEL", "debug");
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") stderrWrites.push(chunk);
      else if (Buffer.isBuffer(chunk)) stderrWrites.push(chunk.toString("utf8"));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("still emits the line when data carries a BigInt JSON.stringify cannot serialize", () => {
    // JSON.stringify throws a TypeError on a BigInt. Before the fix that
    // throw escaped log() and surfaced as a failure of whatever the caller
    // was doing -- a diagnostic taking down the operation it was diagnosing.
    expect(() => log("warn", "bigint-payload", { size: BigInt(7) })).not.toThrow();

    expect(stderrWrites.length).toBe(1);
    const parsed = JSON.parse(stderrWrites[0].trim()) as Record<string, unknown>;
    expect(parsed.level).toBe("warn");
    expect(parsed.msg).toBe("bigint-payload");
    // The payload is dropped, and the entry says so rather than lying by
    // omission about what the caller passed.
    expect(parsed.dataOmitted).toBe(true);
    expect(parsed.size).toBeUndefined();
  });

  it("still emits the line when data is circular", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    expect(() => log("error", "circular-payload", circular)).not.toThrow();
    const parsed = JSON.parse(stderrWrites[0].trim()) as Record<string, unknown>;
    expect(parsed.msg).toBe("circular-payload");
    expect(parsed.dataOmitted).toBe(true);
  });

  it("swallows a synchronous stderr write failure (closed pipe) instead of throwing", () => {
    // A host that closed our stderr makes write() throw EPIPE/EBADF
    // synchronously. That must not propagate into the caller.
    vi.mocked(process.stderr.write).mockImplementation(() => {
      const err = new Error("write EPIPE") as NodeJS.ErrnoException;
      err.code = "EPIPE";
      throw err;
    });

    expect(() => log("info", "into-the-void")).not.toThrow();
  });

  it("attaches an 'error' listener to stderr so an async EPIPE is not an unhandled event", () => {
    log("info", "arm-the-guard");
    // With no listener Node treats a stream 'error' as unhandled and kills
    // the process. Emitting here must be inert.
    expect(process.stderr.listenerCount("error")).toBeGreaterThan(0);
    expect(() => process.stderr.emit("error", new Error("late EPIPE"))).not.toThrow();
  });
});

describe("log() reads LOG_LEVEL per call, not once at import", () => {
  let stderrWrites: string[] = [];

  beforeEach(() => {
    stderrWrites = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") stderrWrites.push(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("suppresses an info line when LOG_LEVEL is raised after import", () => {
    // The threshold used to be latched in a module-scope const, so this
    // env change could not take effect for the life of the process.
    vi.stubEnv("LOG_LEVEL", "error");
    log("info", "should-be-filtered");
    expect(stderrWrites).toEqual([]);
  });

  it("emits a debug line when LOG_LEVEL is lowered after import", () => {
    vi.stubEnv("LOG_LEVEL", "debug");
    log("debug", "now-visible");
    expect(stderrWrites.length).toBe(1);
    expect(JSON.parse(stderrWrites[0].trim()).msg).toBe("now-visible");
  });

  it("falls back to info when LOG_LEVEL is set to something unrecognized", () => {
    vi.stubEnv("LOG_LEVEL", "chatty");
    log("debug", "still-filtered");
    log("info", "still-shown");
    expect(stderrWrites.length).toBe(1);
    expect(JSON.parse(stderrWrites[0].trim()).msg).toBe("still-shown");
  });
});
