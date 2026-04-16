import { describe, expect, it } from "vitest";
import { PackDetector } from "../pack-detect.js";

describe("PackDetector", () => {
  it("returns no chains from empty history", () => {
    const d = new PackDetector();
    expect(d.detectChains()).toEqual([]);
  });

  it("returns no chains for a single-namespace run", () => {
    // Repeated calls to one namespace are not a chain — a chain needs
    // ≥2 distinct namespaces interacting in the same burst.
    const d = new PackDetector();
    const t0 = 1_000_000;
    for (let i = 0; i < 8; i++) {
      d.recordCall("gh", "create_issue", t0 + i * 1_000);
    }
    expect(d.detectChains()).toEqual([]);
  });

  it("detects a chain from a diverse short burst that recurs", () => {
    const d = new PackDetector();
    const t0 = 1_000_000;
    // Burst 1: gh, linear within 5s of each other
    d.recordCall("gh", "create_issue", t0);
    d.recordCall("linear", "create_task", t0 + 5_000);
    // Gap of 5 minutes — well beyond the 120s default, forces a new burst
    const t1 = t0 + 5 * 60_000;
    // Burst 2: gh, linear again
    d.recordCall("gh", "list_prs", t1);
    d.recordCall("linear", "list_tasks", t1 + 10_000);

    const chains = d.detectChains();
    expect(chains).toHaveLength(1);
    expect(chains[0].frequency).toBe(2);
    expect(new Set(chains[0].namespaces)).toEqual(new Set(["gh", "linear"]));
    expect(chains[0].lastSeenAt).toBe(t1 + 10_000);
  });

  it("does not count a single occurrence as a chain", () => {
    const d = new PackDetector();
    const t0 = 1_000_000;
    d.recordCall("gh", "create_issue", t0);
    d.recordCall("linear", "create_task", t0 + 5_000);
    expect(d.detectChains()).toEqual([]);
  });

  it("treats [gh, linear, gh] and [gh, linear] as the same pack set", () => {
    const d = new PackDetector();
    const t0 = 1_000_000;
    // Burst 1: gh, linear, gh — set is {gh, linear}
    d.recordCall("gh", "a", t0);
    d.recordCall("linear", "b", t0 + 1_000);
    d.recordCall("gh", "c", t0 + 2_000);
    // Gap
    const t1 = t0 + 5 * 60_000;
    // Burst 2: gh, linear — same set {gh, linear}
    d.recordCall("gh", "d", t1);
    d.recordCall("linear", "e", t1 + 1_000);

    const chains = d.detectChains();
    expect(chains).toHaveLength(1);
    expect(chains[0].frequency).toBe(2);
    expect(new Set(chains[0].namespaces)).toEqual(new Set(["gh", "linear"]));
  });

  it("counts two recurrences crossing a long gap when each burst is tight", () => {
    const d = new PackDetector();
    const t0 = 1_000_000;
    // Burst 1: quick
    d.recordCall("gh", "a", t0);
    d.recordCall("slack", "b", t0 + 500);
    // Long gap (1h)
    const t1 = t0 + 60 * 60_000;
    // Burst 2: also quick
    d.recordCall("gh", "c", t1);
    d.recordCall("slack", "d", t1 + 500);

    const chains = d.detectChains();
    expect(chains).toHaveLength(1);
    expect(chains[0].frequency).toBe(2);
    expect(chains[0].lastSeenAt).toBe(t1 + 500);
  });

  it("ignores noise from a call that is alone in its own burst", () => {
    const d = new PackDetector();
    const t0 = 1_000_000;
    // Real burst 1: gh+linear
    d.recordCall("gh", "a", t0);
    d.recordCall("linear", "b", t0 + 1_000);
    // Lone noise burst: a single slack call far from everything
    const tNoise = t0 + 5 * 60_000;
    d.recordCall("slack", "ping", tNoise);
    // Real burst 2: gh+linear
    const t1 = tNoise + 5 * 60_000;
    d.recordCall("gh", "c", t1);
    d.recordCall("linear", "d", t1 + 1_000);

    const chains = d.detectChains();
    // Only {gh, linear} should be reported; the lone slack burst has
    // only 1 namespace so it's not a chain.
    expect(chains).toHaveLength(1);
    expect(new Set(chains[0].namespaces)).toEqual(new Set(["gh", "linear"]));
    expect(chains[0].frequency).toBe(2);
  });

  it("detects a 3-namespace pack and reports frequency correctly", () => {
    const d = new PackDetector();
    const t0 = 1_000_000;
    // Burst 1: gh, linear, slack
    d.recordCall("gh", "a", t0);
    d.recordCall("linear", "b", t0 + 1_000);
    d.recordCall("slack", "c", t0 + 2_000);
    // Burst 2: same three
    const t1 = t0 + 10 * 60_000;
    d.recordCall("gh", "d", t1);
    d.recordCall("slack", "e", t1 + 500);
    d.recordCall("linear", "f", t1 + 1_000);

    const chains = d.detectChains();
    expect(chains).toHaveLength(1);
    expect(chains[0].frequency).toBe(2);
    expect(new Set(chains[0].namespaces)).toEqual(new Set(["gh", "linear", "slack"]));
  });

  it("does not merge bursts separated by more than the gap threshold", () => {
    // Two bursts split far apart must be counted as separate bursts.
    // If a {gh, linear} burst is followed later by a {gh} burst, the
    // {gh} doesn't retroactively extend the earlier pack.
    const d = new PackDetector();
    const t0 = 1_000_000;
    d.recordCall("gh", "a", t0);
    d.recordCall("linear", "b", t0 + 1_000);
    // Gap > 120s
    const t1 = t0 + 300_000;
    d.recordCall("gh", "c", t1);

    // Only one burst has ≥2 namespaces, so no pack has reached the
    // recurrence threshold.
    expect(d.detectChains()).toEqual([]);
  });

  it("rolls history past the maxHistory cap", () => {
    const d = new PackDetector({ maxHistory: 5 });
    for (let i = 0; i < 10; i++) {
      d.recordCall("gh", "t", i);
    }
    expect(d.getHistory().length).toBe(5);
    expect(d.getHistory()[0].at).toBe(5);
  });

  it("ignores empty namespace or tool name", () => {
    const d = new PackDetector();
    d.recordCall("", "t", 1);
    d.recordCall("gh", "", 2);
    expect(d.getHistory().length).toBe(0);
  });

  it("reset clears history and detected chains", () => {
    const d = new PackDetector();
    const t0 = 1_000_000;
    d.recordCall("gh", "a", t0);
    d.recordCall("linear", "b", t0 + 500);
    const t1 = t0 + 5 * 60_000;
    d.recordCall("gh", "c", t1);
    d.recordCall("linear", "d", t1 + 500);
    expect(d.detectChains()).toHaveLength(1);

    d.reset();
    expect(d.detectChains()).toEqual([]);
    expect(d.getHistory().length).toBe(0);
  });

  it("respects a custom maxGapMs", () => {
    // A 10s gap is inside the default 120s window but outside a 5s
    // custom window — the second call starts a new burst.
    const d = new PackDetector({ maxGapMs: 5_000 });
    const t0 = 1_000_000;
    d.recordCall("gh", "a", t0);
    d.recordCall("linear", "b", t0 + 10_000);
    d.recordCall("gh", "c", t0 + 20_000);
    d.recordCall("linear", "d", t0 + 30_000);

    // Every call is its own burst (10s gap > 5s threshold), so no
    // burst ever contains ≥2 namespaces.
    expect(d.detectChains()).toEqual([]);
  });
});
