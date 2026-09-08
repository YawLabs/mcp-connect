import { describe, expect, it, vi } from "vitest";
import { registerShutdownTriggers, SIGNAL_SHUTDOWN_EVENTS, STDIN_SHUTDOWN_EVENTS } from "../shutdown-triggers.js";

/** A recording stand-in for `process` / `process.stdin`.
 *
 *  Carries a `resume` spy that the module under test has no way to reach
 *  through its own ShutdownEventTarget type. That is the point: the test
 *  asserts the SHAPE the production call has, so a future widening of the
 *  interface to include `resume` fails the "never resumes stdin" test below
 *  rather than silently regressing the protocol. */
function makeTarget() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    listeners,
    resume: vi.fn(),
    pause: vi.fn(),
    on(event: string, listener: () => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return this;
    },
    /** Fire one event the way Node would. */
    emit(event: string) {
      for (const l of listeners.get(event) ?? []) l();
    },
  };
}

describe("registerShutdownTriggers", () => {
  it("registers both POSIX signals", () => {
    const proc = makeTarget();
    const stdin = makeTarget();
    registerShutdownTriggers(() => {}, { proc, stdin });

    expect([...proc.listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("registers stdin end AND close -- the events the SDK transport never binds", () => {
    // The regression this whole module exists for. StdioServerTransport.start()
    // attaches only 'data' and 'error', so nothing in the SDK notices EOF and
    // transport.onclose never fires. If these two ever stop being registered,
    // shutdown() stops running on Windows and upstream children leak again.
    const proc = makeTarget();
    const stdin = makeTarget();
    registerShutdownTriggers(() => {}, { proc, stdin });

    expect([...stdin.listeners.keys()].sort()).toEqual(["close", "end"]);
  });

  it("never resumes stdin, so the transport keeps every byte the client sent", () => {
    // Resuming before StdioServerTransport attaches its 'data' listener puts
    // stdin in flowing mode with no consumer, which discards whatever the
    // client already wrote -- typically its `initialize` request. A broker
    // that eats the handshake is worse than one that leaks on exit.
    const proc = makeTarget();
    const stdin = makeTarget();
    registerShutdownTriggers(() => {}, { proc, stdin });

    expect(stdin.resume).not.toHaveBeenCalled();
    expect(stdin.pause).not.toHaveBeenCalled();
  });

  it("routes every trigger to the one shutdown callback", () => {
    const proc = makeTarget();
    const stdin = makeTarget();
    const shutdown = vi.fn();
    registerShutdownTriggers(shutdown, { proc, stdin });

    proc.emit("SIGTERM");
    expect(shutdown).toHaveBeenCalledTimes(1);
    proc.emit("SIGINT");
    expect(shutdown).toHaveBeenCalledTimes(2);
    stdin.emit("end");
    expect(shutdown).toHaveBeenCalledTimes(3);
    stdin.emit("close");
    expect(shutdown).toHaveBeenCalledTimes(4);
  });

  it("fires the callback again per event rather than latching -- the caller owns idempotency", () => {
    // runServer's `shuttingDown` flag is the single latch. Adding a second
    // one here would mean two places decide what "already shutting down"
    // means, and the one in index.ts is the one that guards the force-exit
    // timer. A killed client really can deliver 'end' then 'close', so this
    // documents that the module passes both through.
    const proc = makeTarget();
    const stdin = makeTarget();
    const shutdown = vi.fn();
    registerShutdownTriggers(shutdown, { proc, stdin });

    stdin.emit("end");
    stdin.emit("close");

    expect(shutdown).toHaveBeenCalledTimes(2);
  });

  it("registers exactly the events its exported constants name", () => {
    // Drift guard: the constants are documentation other code and this test
    // read, so they must not diverge from what actually gets bound.
    const proc = makeTarget();
    const stdin = makeTarget();
    registerShutdownTriggers(() => {}, { proc, stdin });

    for (const signal of SIGNAL_SHUTDOWN_EVENTS) {
      expect(proc.listeners.get(signal)).toHaveLength(1);
    }
    for (const event of STDIN_SHUTDOWN_EVENTS) {
      expect(stdin.listeners.get(event)).toHaveLength(1);
    }
    expect(proc.listeners.size).toBe(SIGNAL_SHUTDOWN_EVENTS.length);
    expect(stdin.listeners.size).toBe(STDIN_SHUTDOWN_EVENTS.length);
  });

  it("binds signals to proc and stream events to stdin, never crossed", () => {
    const proc = makeTarget();
    const stdin = makeTarget();
    registerShutdownTriggers(() => {}, { proc, stdin });

    expect(proc.listeners.has("end")).toBe(false);
    expect(proc.listeners.has("close")).toBe(false);
    expect(stdin.listeners.has("SIGTERM")).toBe(false);
    expect(stdin.listeners.has("SIGINT")).toBe(false);
  });

  it("accepts the real process and process.stdin shapes", () => {
    // Compile-time assurance that the loose ShutdownEventTarget really does
    // admit Node's overloaded `on`. Registering against the live process
    // would leak listeners into the vitest worker, so this only checks
    // assignability and never calls the function.
    const targets: Parameters<typeof registerShutdownTriggers>[1] = {
      proc: process,
      stdin: process.stdin,
    };
    expect(typeof targets.proc.on).toBe("function");
    expect(typeof targets.stdin.on).toBe("function");
  });
});
