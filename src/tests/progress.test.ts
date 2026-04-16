import { describe, expect, it, vi } from "vitest";
import { createProgressReporter } from "../progress.js";

describe("createProgressReporter", () => {
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

  it("sends a progress notification with auto-incrementing counter", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const report = createProgressReporter({
      sendNotification: send,
      _meta: { progressToken: "tok-1" },
    });
    report("spawning");
    report("loaded 3 tools");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toEqual({
      method: "notifications/progress",
      params: { progressToken: "tok-1", progress: 1, message: "spawning" },
    });
    expect(send.mock.calls[1]![0]).toEqual({
      method: "notifications/progress",
      params: { progressToken: "tok-1", progress: 2, message: "loaded 3 tools" },
    });
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

  it("swallows sendNotification rejection without throwing", async () => {
    const send = vi.fn().mockRejectedValue(new Error("transport closed"));
    const report = createProgressReporter({
      sendNotification: send,
      _meta: { progressToken: "tok" },
    });
    expect(() => report("x")).not.toThrow();
    // Let the microtask for the rejection resolve
    await new Promise((r) => setTimeout(r, 0));
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
