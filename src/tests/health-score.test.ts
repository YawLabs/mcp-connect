import { describe, expect, it } from "vitest";
import { ACTIVATION_FAILURE_TTL_MS, activationFailureFactor, errorRateFactor, healthFactor } from "../health-score.js";

describe("errorRateFactor", () => {
  it("returns 1.0 when health is undefined", () => {
    expect(errorRateFactor(undefined)).toBe(1.0);
  });

  it("returns 1.0 below the observation floor", () => {
    expect(errorRateFactor({ totalCalls: 2, errorCount: 2, totalLatencyMs: 0 })).toBe(1.0);
  });

  it("returns 1.0 for perfect reliability", () => {
    expect(errorRateFactor({ totalCalls: 10, errorCount: 0, totalLatencyMs: 0 })).toBe(1.0);
  });

  it("applies linear penalty for low error rates", () => {
    expect(errorRateFactor({ totalCalls: 10, errorCount: 1, totalLatencyMs: 0 })).toBeCloseTo(0.9);
  });

  it("floors at 0.5 for high error rates", () => {
    expect(errorRateFactor({ totalCalls: 10, errorCount: 8, totalLatencyMs: 0 })).toBe(0.5);
    expect(errorRateFactor({ totalCalls: 10, errorCount: 10, totalLatencyMs: 0 })).toBe(0.5);
  });
});

describe("activationFailureFactor", () => {
  it("returns 1.0 when no failure", () => {
    expect(activationFailureFactor(undefined)).toBe(1.0);
  });

  it("returns 0.5 for a recent failure", () => {
    const now = 1_000_000;
    expect(activationFailureFactor({ at: now - 1000, message: "boom" }, now)).toBe(0.5);
  });

  it("returns 1.0 for a stale failure past the TTL", () => {
    const now = 1_000_000;
    expect(activationFailureFactor({ at: now - ACTIVATION_FAILURE_TTL_MS - 1, message: "boom" }, now)).toBe(1.0);
  });
});

describe("healthFactor", () => {
  it("returns 1.0 when both signals are clean", () => {
    expect(healthFactor({ totalCalls: 5, errorCount: 0, totalLatencyMs: 10 }, undefined)).toBe(1.0);
  });

  it("takes the strictest penalty", () => {
    const now = 1_000_000;
    // 50% error rate = 0.5 factor; recent activation failure also 0.5.
    expect(healthFactor({ totalCalls: 10, errorCount: 5, totalLatencyMs: 10 }, { at: now, message: "x" }, now)).toBe(
      0.5,
    );
  });

  it("picks the worse of two signals", () => {
    const now = 1_000_000;
    // Healthy history but recent activation failure should still penalize.
    expect(healthFactor({ totalCalls: 10, errorCount: 0, totalLatencyMs: 10 }, { at: now, message: "x" }, now)).toBe(
      0.5,
    );
  });
});
