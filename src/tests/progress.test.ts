import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgressReporter, isProgressRequested } from "../progress.js";

describe("createProgressReporter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns a no-op when no progressToken is present", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const report = createProgressReporter({ sendNotification: send, _meta: {} });
    report("step 1");
    expect(send).not.toHaveBeenCalled();
  });

  it("returns a no-op when extra is undefined", () => {
    const report = createProgressReporter(undefined);
    expect(() => report("x")).not.toThrow();
  });

  it("returns a no-op when sendNotification is missing", () => {
    const report = createProgressReporter({ _meta: { progressToken: "t" } });
    expect(() => report("x")).not.toThrow();
  });

  it("message-only calls creep strictly upward and never carry a total", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const report = createProgressReporter({
      sendNotification: send,
      _meta: { progressToken: "tok-1" },
    });
    report("spawning");
    report("loaded 3 tools");
    expect(send).toHaveBeenCalledTimes(2);
    const [first, second] = send.mock.calls.map((c) => c[0].params);
    expect(first.message).toBe("spawning");
    expect(second.message).toBe("loaded 3 tools");
    // Strictly increasing (MCP monotonicity), indeterminate (no total).
    expect(first.progress).toBe(0);
    expect(second.progress).toBeGreaterThan(first.progress);
    expect(first.total).toBeUndefined();
    expect(second.total).toBeUndefined();
  });

  it("respects explicit progress and total overrides", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const report = createProgressReporter({
      sendNotification: send,
      _meta: { progressToken: 42 },
    });
    report("step", 3, 5);
    expect(send).toHaveBeenCalledWith({
      method: "notifications/progress",
      params: { progressToken: 42, progress: 3, total: 5, message: "step" },
    });
  });

  it("never emits a progress value at or below the previous one (MCP monotonicity)", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const report = createProgressReporter({
      sendNotification: send,
      _meta: { progressToken: "tok-mono" },
    });
    report("jump ahead", 5);
    report("caller regressed", 2);
    report("message-only is still behind"); // would be far below the 5 already sent
    const values = send.mock.calls.map((c) => c[0].params.progress);
    expect(values[0]).toBe(5);
    // The spec says progress MUST increase per token — a regressing caller
    // value and a trailing message-only call both nudge strictly upward
    // instead of replaying the clamped 5 as a duplicate.
    expect(values[1]).toBeGreaterThan(values[0]!);
    expect(values[2]).toBeGreaterThan(values[1]!);
  });

  it("dispatch shape: message-only preamble never inflates past the explicit milestones", () => {
    // Replays handleDispatch's exact sequence: three message-only sub-steps
    // ("Ranking N servers", tiebreak, winner) then the loop's explicit
    // (0, 1). The old integer counter emitted {progress: 3, total: 1} — a
    // 300% bar — here.
    const send = vi.fn().mockResolvedValue(undefined);
    const report = createProgressReporter({
      sendNotification: send,
      _meta: { progressToken: "tok-dispatch" },
    });
    report("Ranking 4 servers");
    report("Asking client to break ranking tie");
    report("Sampling tiebreak picked gh");
    report("Loading gh (1/1)", 0, 1);
    const params = send.mock.calls.map((c) => c[0].params);
    for (let i = 1; i < params.length; i++) {
      expect(params[i]!.progress).toBeGreaterThan(params[i - 1]!.progress);
    }
    const last = params[params.length - 1]!;
    expect(last.total).toBe(1);
    expect(last.progress).toBeLessThanOrEqual(1);
  });

  it("activate shape: interleaved sub-steps never report 100% before the last milestone", () => {
    // Replays handleActivate with two namespaces: explicit (0, 2),
    // activateOne's message-only sub-steps, then explicit (1, 2). The old
    // counter reached 2 during the sub-steps and clamped the second
    // milestone to 2/2 — 100% before the last server had even started.
    const send = vi.fn().mockResolvedValue(undefined);
    const report = createProgressReporter({
      sendNotification: send,
      _meta: { progressToken: "tok-activate" },
    });
    report("Loading gh (1/2)", 0, 2);
    report("spawning gh");
    report("gh: loaded 12 tools");
    report("Loading slack (2/2)", 1, 2);
    const params = send.mock.calls.map((c) => c[0].params);
    for (let i = 1; i < params.length; i++) {
      expect(params[i]!.progress).toBeGreaterThan(params[i - 1]!.progress);
    }
    for (const p of params) {
      if (p.total !== undefined) expect(p.progress).toBeLessThanOrEqual(p.total);
    }
    // The second milestone lands at exactly 1 of 2 — not clamped upward.
    expect(params[3]!.progress).toBe(1);
    expect(params[3]!.total).toBe(2);
  });

  it("drops total when the nudged value would exceed it (never >100% on the wire)", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const report = createProgressReporter({
      sendNotification: send,
      _meta: { progressToken: "tok-cap" },
    });
    report("done", 2, 2);
    report("done again", 2, 2); // duplicate milestone — must nudge past 2
    const [first, second] = send.mock.calls.map((c) => c[0].params);
    expect(first).toMatchObject({ progress: 2, total: 2 });
    expect(second.progress).toBeGreaterThan(2);
    // Nudged past the total, so the total is dropped (indeterminate beats
    // a >100% bar).
    expect(second.total).toBeUndefined();
  });

  it("swallows a sendNotification rejection and reports it as a warn line", async () => {
    // The rejection must not reach the caller -- and it must not vanish
    // silently either: the reporter's .catch() logs it. An operator running
    // the suite with LOG_LEVEL=error exported would mute that line, so pin
    // the threshold instead of inheriting it.
    vi.stubEnv("LOG_LEVEL", "warn");
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") stderrWrites.push(chunk);
      return true;
    });
    const send = vi.fn().mockRejectedValue(new Error("transport closed"));
    const report = createProgressReporter({
      sendNotification: send,
      _meta: { progressToken: "tok" },
    });
    expect(() => report("x")).not.toThrow();
    // Let the microtask for the rejection resolve
    await new Promise((r) => setTimeout(r, 0));

    let warned: Record<string, unknown> | undefined;
    for (const line of stderrWrites) {
      try {
        const entry = JSON.parse(line.trim()) as Record<string, unknown>;
        if (entry.msg === "Progress notification send failed") warned = entry;
      } catch {
        // Not a JSON log line. Nothing else writes to stderr inside this
        // test, but a stray write must not crash the assertions below.
      }
    }
    expect(warned).toBeDefined();
    expect(warned?.level).toBe("warn");
    // The rejection reason has to survive into the line: a bare "send
    // failed" with no cause tells an operator nothing about the transport.
    expect(warned?.error).toBe("transport closed");
  });

  it("accepts numeric progress tokens", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const report = createProgressReporter({
      sendNotification: send,
      _meta: { progressToken: 7 },
    });
    report("numeric");
    expect(send.mock.calls[0]![0].params.progressToken).toBe(7);
  });
});

describe("isProgressRequested", () => {
  // The predicate exists so server.ts can decide whether to relay an upstream
  // tool's progress. That decision is not cosmetic: handing the SDK an
  // onprogress makes it stamp a progress token onto the UPSTREAM request, so
  // relaying unconditionally would change the wire shape of every proxied
  // call to collect notifications the reporter then drops.
  const send = (): Promise<void> => Promise.resolve();

  it("is true only when a token AND a channel are both present", () => {
    expect(isProgressRequested({ sendNotification: send, _meta: { progressToken: "t" } })).toBe(true);
    expect(isProgressRequested({ sendNotification: send, _meta: { progressToken: 0 } })).toBe(true);
    expect(isProgressRequested({ sendNotification: send, _meta: {} })).toBe(false);
    expect(isProgressRequested({ _meta: { progressToken: "t" } })).toBe(false);
    expect(isProgressRequested({ sendNotification: send, _meta: { progressToken: null } })).toBe(false);
    expect(isProgressRequested(undefined)).toBe(false);
  });

  it("agrees with whether the reporter actually emits", () => {
    // Drift guard. These are two views of one condition, and if they ever
    // disagree the failure is silent in both directions: a relay wired up for
    // a reporter that discards, or progress asked for and never forwarded.
    const cases = [
      { sendNotification: send, _meta: { progressToken: "t" } },
      { sendNotification: send, _meta: { progressToken: 7 } },
      { sendNotification: send, _meta: { progressToken: 0 } },
      { sendNotification: send, _meta: {} },
      { sendNotification: send, _meta: { progressToken: null } },
      { _meta: { progressToken: "t" } },
      undefined,
    ];
    for (const extra of cases) {
      const spy = vi.fn().mockResolvedValue(undefined);
      const withSpy = extra === undefined ? undefined : { ...extra, sendNotification: extra.sendNotification && spy };
      createProgressReporter(withSpy)("probe");
      expect(spy.mock.calls.length > 0, JSON.stringify(extra ?? null)).toBe(isProgressRequested(withSpy));
    }
  });
});
