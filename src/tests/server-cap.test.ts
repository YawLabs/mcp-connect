import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SERVER_CAP, evaluateServerCap, resolveServerCap } from "../server-cap.js";

describe("resolveServerCap", () => {
  const originalEnv = process.env.MCPH_SERVER_CAP;

  beforeEach(() => {
    // biome-ignore lint/performance/noDelete: unsetting an env var needs delete
    delete process.env.MCPH_SERVER_CAP;
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      // biome-ignore lint/performance/noDelete: unsetting an env var needs delete
      delete process.env.MCPH_SERVER_CAP;
    } else {
      process.env.MCPH_SERVER_CAP = originalEnv;
    }
  });

  it("returns the default when env is unset", () => {
    expect(resolveServerCap({})).toBe(DEFAULT_SERVER_CAP);
  });

  it("returns the default when env is empty string", () => {
    expect(resolveServerCap({ MCPH_SERVER_CAP: "" })).toBe(DEFAULT_SERVER_CAP);
  });

  it("honors a valid positive override", () => {
    expect(resolveServerCap({ MCPH_SERVER_CAP: "12" })).toBe(12);
  });

  it("honors 0 as 'disabled'", () => {
    expect(resolveServerCap({ MCPH_SERVER_CAP: "0" })).toBe(0);
  });

  it("falls back to the default on invalid input rather than erroring", () => {
    expect(resolveServerCap({ MCPH_SERVER_CAP: "abc" })).toBe(DEFAULT_SERVER_CAP);
    expect(resolveServerCap({ MCPH_SERVER_CAP: "-2" })).toBe(DEFAULT_SERVER_CAP);
  });
});

describe("evaluateServerCap", () => {
  it("allows when the cap is disabled (0)", () => {
    const loaded = Array.from({ length: 20 }, (_, i) => ({ namespace: `s${i}`, idleCount: 0 }));
    expect(evaluateServerCap("new", loaded, 0)).toEqual({ allow: true });
  });

  it("allows when under the cap", () => {
    expect(evaluateServerCap("new", [{ namespace: "a", idleCount: 0 }], 3)).toEqual({ allow: true });
  });

  it("allows when the namespace is already loaded (re-activation is a no-op)", () => {
    const loaded = [
      { namespace: "a", idleCount: 0 },
      { namespace: "b", idleCount: 0 },
      { namespace: "c", idleCount: 0 },
    ];
    expect(evaluateServerCap("a", loaded, 3)).toEqual({ allow: true });
  });

  it("refuses when at cap for a new namespace", () => {
    const loaded = [
      { namespace: "a", idleCount: 0 },
      { namespace: "b", idleCount: 0 },
    ];
    const decision = evaluateServerCap("c", loaded, 2);
    expect(decision.allow).toBe(false);
    expect(decision.message).toContain('Cannot load "c"');
    expect(decision.message).toContain("2-server concurrent cap");
  });

  it("surfaces remediation hints — deactivate + read_tool + env override", () => {
    const decision = evaluateServerCap("new", [{ namespace: "a", idleCount: 0 }], 1);
    expect(decision.message).toContain("mcp_connect_deactivate");
    expect(decision.message).toContain("mcp_connect_read_tool");
    expect(decision.message).toContain("MCPH_SERVER_CAP");
  });

  it("lists loaded servers by descending idle count so the cheapest drop shows first", () => {
    const decision = evaluateServerCap(
      "new",
      [
        { namespace: "fresh", idleCount: 0 },
        { namespace: "stale", idleCount: 7 },
        { namespace: "mid", idleCount: 3 },
      ],
      3,
    );
    const msg = decision.message ?? "";
    const staleIdx = msg.indexOf("stale");
    const midIdx = msg.indexOf("mid");
    const freshIdx = msg.indexOf("fresh");
    expect(staleIdx).toBeGreaterThan(-1);
    expect(staleIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(freshIdx);
    expect(msg).toContain('"stale" (idle 7)');
    // Zero-idle servers render without the parenthetical.
    expect(msg).toContain('"fresh"');
    expect(msg).not.toContain('"fresh" (idle 0)');
  });

  it("breaks idle ties alphabetically for stable output", () => {
    const decision = evaluateServerCap(
      "new",
      [
        { namespace: "zebra", idleCount: 2 },
        { namespace: "apple", idleCount: 2 },
      ],
      2,
    );
    const msg = decision.message ?? "";
    expect(msg.indexOf("apple")).toBeLessThan(msg.indexOf("zebra"));
  });

  it("ignores error-state equivalents — the caller filters before passing loaded slots", () => {
    // Contract test: the helper trusts its input. The caller in server.ts is
    // responsible for excluding error-state connections from `loaded`.
    const decision = evaluateServerCap("new", [], 2);
    expect(decision.allow).toBe(true);
  });
});
