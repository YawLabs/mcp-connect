import { describe, expect, it } from "vitest";
import {
  LEARNING_MAX_BOOST,
  LEARNING_MIN_BOOST,
  LEARNING_MIN_OBSERVATIONS,
  LearningStore,
  type NamespaceUsage,
} from "../learning.js";

describe("LearningStore", () => {
  it("returns 1.0 boost for unknown namespaces", () => {
    const store = new LearningStore();
    expect(store.boostFactor("never-seen")).toBe(1.0);
  });

  describe("adjustSucceeded (reward-grader correction)", () => {
    it("applies a delta to succeeded without changing dispatched", () => {
      const store = new LearningStore();
      store.recordOutcome("gh", 0.3); // dispatched 1, succeeded 0.3
      store.adjustSucceeded("gh", 0.7); // revise heuristic 0.3 -> graded 1.0
      const u = store.get("gh");
      expect(u?.dispatched).toBe(1);
      expect(u?.succeeded).toBeCloseTo(1.0);
    });

    it("clamps succeeded into [0, dispatched]", () => {
      const store = new LearningStore();
      store.recordOutcome("gh", 0.2);
      store.adjustSucceeded("gh", 5); // would overshoot dispatched
      expect(store.get("gh")?.succeeded).toBe(1); // dispatched is 1
      store.adjustSucceeded("gh", -5); // would go negative
      expect(store.get("gh")?.succeeded).toBe(0);
    });

    it("is a no-op for an unknown namespace", () => {
      const store = new LearningStore();
      store.adjustSucceeded("never-seen", 0.5);
      expect(store.get("never-seen")).toBeUndefined();
    });
  });

  it("returns 1.0 boost below the observation floor", () => {
    const store = new LearningStore();
    for (let i = 0; i < LEARNING_MIN_OBSERVATIONS - 1; i++) {
      store.recordSuccess("gh");
    }
    expect(store.boostFactor("gh")).toBe(1.0);
  });

  it("returns a boost between 1.0 and MAX once the floor is hit", () => {
    const store = new LearningStore();
    for (let i = 0; i < LEARNING_MIN_OBSERVATIONS; i++) {
      store.recordSuccess("gh");
    }
    const factor = store.boostFactor("gh");
    expect(factor).toBeGreaterThan(1.0);
    expect(factor).toBeLessThan(LEARNING_MAX_BOOST);
  });

  it("caps boost at LEARNING_MAX_BOOST even with many successes", () => {
    const store = new LearningStore();
    for (let i = 0; i < 1000; i++) {
      store.recordSuccess("gh");
    }
    expect(store.boostFactor("gh")).toBe(LEARNING_MAX_BOOST);
  });

  it("records dispatches separately from successes", () => {
    const store = new LearningStore();
    store.recordDispatch("gh");
    const u = store.get("gh");
    expect(u?.dispatched).toBe(1);
    expect(u?.succeeded).toBe(0);
  });

  it("increments succeeded and sets lastUsedAt on recordSuccess", () => {
    const store = new LearningStore();
    const before = Date.now();
    store.recordSuccess("gh");
    const u = store.get("gh");
    expect(u?.succeeded).toBe(1);
    expect(u?.lastUsedAt).toBeGreaterThanOrEqual(before);
  });

  it("reset clears all state", () => {
    const store = new LearningStore();
    store.recordSuccess("gh");
    store.reset();
    expect(store.get("gh")).toBeUndefined();
  });

  describe("loadSnapshot row guard", () => {
    it("skips a null row instead of throwing on the first dereference", () => {
      const store = new LearningStore();
      // The signature promises NamespaceUsage rows, so a null one can only
      // arrive from a caller that parsed state.json itself (bypassing
      // persistence.ts sanitizeLearning). It used to throw "Cannot read
      // properties of null (reading 'dispatched')" and abort the whole
      // restore, taking every GOOD row down with it.
      const snapshot = { bad: null, gh: { dispatched: 3, succeeded: 2, lastUsedAt: 7 } };
      expect(() => store.loadSnapshot(snapshot as unknown as Record<string, NamespaceUsage>)).not.toThrow();
      expect(store.get("bad")).toBeUndefined();
      expect(store.get("gh")).toEqual({ dispatched: 3, succeeded: 2, lastUsedAt: 7 });
    });

    it("drops a primitive row rather than admitting it as an all-zero entry", () => {
      const store = new LearningStore();
      // A string row did NOT throw -- property reads on a primitive yield
      // undefined, which the numeric coercions turned into a phantom
      // {0, 0, 0} row that then round-tripped to disk on every flush.
      store.loadSnapshot({ junk: "not a row" } as unknown as Record<string, NamespaceUsage>);
      expect(store.get("junk")).toBeUndefined();
      expect(Object.keys(store.exportSnapshot())).toEqual([]);
    });
  });

  describe("recordSuccess without prior recordDispatch (fix 11)", () => {
    it("boostFactor coerces dispatched up to succeeded when only successes were recorded", () => {
      const store = new LearningStore();
      // Record 5 successes without any recordDispatch call. The coerce in
      // boostFactor must treat dispatched = max(0, 5) = 5, not 0 -- a 0
      // dispatched count would produce a 0/0 rate (NaN) or a 5/0 rate
      // (Infinity), both of which would corrupt the penalty/boost logic.
      for (let i = 0; i < 5; i++) {
        store.recordSuccess("solo");
      }
      const u = store.get("solo");
      // recordSuccess leaves dispatched at 0 (symmetric with recordDispatch,
      // which leaves succeeded at 0), so after 5 pure successes dispatched is
      // 0 and succeeded is 5. The coerce in boostFactor must treat dispatched
      // as at least succeeded (i.e. max(0, 5) = 5) so the rate stays in [0, 1]
      // and no penalty fires.
      expect(u?.dispatched).toBe(0);
      expect(u?.succeeded).toBe(5);
      // boostFactor must be >= 1.0, not NaN or penalty.
      const factor = store.boostFactor("solo");
      expect(Number.isFinite(factor)).toBe(true);
      expect(factor).toBeGreaterThanOrEqual(1.0);
    });

    it("clamps a loaded succeeded > dispatched snapshot instead of inflating dispatched", () => {
      const store = new LearningStore();
      store.loadSnapshot({ ns: { dispatched: 2, succeeded: 5, lastUsedAt: 1 } });
      // No production recorder can produce succeeded > dispatched, so on load
      // it is corrupt/hand-edited state and succeeded is clamped DOWN -- the
      // same direction persistence.ts's sanitizeLearning clamps it, which is
      // the path every real cross-session load actually goes through.
      expect(store.get("ns")).toEqual({ dispatched: 2, succeeded: 2, lastUsedAt: 1 });
      const factor = store.boostFactor("ns");
      expect(Number.isFinite(factor)).toBe(true);
      expect(factor).toBeGreaterThanOrEqual(1.0);
    });
  });

  describe("penalty branch", () => {
    it("penalizes flaky history below 80% success rate", () => {
      const store = new LearningStore();
      store.loadSnapshot({ flaky: { dispatched: 10, succeeded: 3, lastUsedAt: 1 } });
      const factor = store.boostFactor("flaky");
      expect(factor).toBeLessThan(1.0);
      expect(factor).toBeGreaterThanOrEqual(LEARNING_MIN_BOOST);
    });

    it("floors the penalty at LEARNING_MIN_BOOST at 0% success", () => {
      const store = new LearningStore();
      store.loadSnapshot({ dead: { dispatched: 5, succeeded: 0, lastUsedAt: 1 } });
      expect(store.boostFactor("dead")).toBe(LEARNING_MIN_BOOST);
    });

    it("does not penalize at or above the 80% success boundary", () => {
      const store = new LearningStore();
      store.loadSnapshot({ borderline: { dispatched: 10, succeeded: 8, lastUsedAt: 1 } });
      expect(store.boostFactor("borderline")).toBeGreaterThanOrEqual(1.0);
    });

    it("does not penalize below the observation floor (noise suppression)", () => {
      const store = new LearningStore();
      store.loadSnapshot({ rare: { dispatched: 2, succeeded: 0, lastUsedAt: 1 } });
      expect(store.boostFactor("rare")).toBe(1.0);
    });

    it("penalty beats positive boost when the overall success rate is poor", () => {
      const store = new LearningStore();
      // 10 successes would normally saturate to LEARNING_MAX_BOOST, but
      // the 50% overall rate triggers the penalty branch instead.
      store.loadSnapshot({ mixed: { dispatched: 20, succeeded: 10, lastUsedAt: 1 } });
      expect(store.boostFactor("mixed")).toBeLessThan(1.0);
    });

    it("penalty scales proportionally with the shortfall from the threshold", () => {
      const store = new LearningStore();
      store.loadSnapshot({
        mild: { dispatched: 10, succeeded: 7, lastUsedAt: 1 }, // 70% rate (10% below threshold)
        severe: { dispatched: 10, succeeded: 2, lastUsedAt: 1 }, // 20% rate (60% below threshold)
      });
      expect(store.boostFactor("mild")).toBeGreaterThan(store.boostFactor("severe"));
    });
  });

  describe("exportSnapshot / loadSnapshot round-trip", () => {
    it("export then load returns equivalent state", () => {
      const store = new LearningStore();
      store.loadSnapshot({
        gh: { dispatched: 10, succeeded: 8, lastUsedAt: 1_000_000 },
        slack: { dispatched: 5, succeeded: 5, lastUsedAt: 2_000_000 },
      });

      const snapshot = store.exportSnapshot();
      const store2 = new LearningStore();
      store2.loadSnapshot(snapshot);

      expect(store2.get("gh")).toEqual({ dispatched: 10, succeeded: 8, lastUsedAt: 1_000_000 });
      expect(store2.get("slack")).toEqual({ dispatched: 5, succeeded: 5, lastUsedAt: 2_000_000 });
      // boost factors must be identical after round-trip
      expect(store2.boostFactor("gh")).toBe(store.boostFactor("gh"));
      expect(store2.boostFactor("slack")).toBe(store.boostFactor("slack"));
    });

    it('exports a "__proto__" namespace as an own key (matching the persistence load side)', () => {
      // persistence.ts deliberately preserves a "__proto__" learning key on
      // LOAD via setJsonKey (with its own pinning test). Plain `out[ns] =`
      // in exportSnapshot invoked the inherited setter instead, so the
      // entry silently vanished from state.json on the next SAVE -- the
      // load-side hardening was undone one flush later.
      const store = new LearningStore();
      // JSON.parse creates "__proto__" as an OWN property, exactly like a
      // hand-edited state.json arriving through loadState.
      store.loadSnapshot(JSON.parse('{"__proto__":{"dispatched":2,"succeeded":1,"lastUsedAt":5}}'));
      const snapshot = store.exportSnapshot();
      expect(Object.hasOwn(snapshot, "__proto__")).toBe(true);
      // And it survives serialization, which only sees own properties.
      const roundTripped = JSON.parse(JSON.stringify(snapshot));
      expect(Object.getOwnPropertyDescriptor(roundTripped, "__proto__")?.value).toEqual({
        dispatched: 2,
        succeeded: 1,
        lastUsedAt: 5,
      });
    });

    it("clamps succeeded down to dispatched on load, matching the persistence path", () => {
      // The deprecated recordSuccess can still produce succeeded > dispatched
      // in memory, but that shape is NOT persistable: persistence.ts's
      // sanitizeLearning clamps succeeded to dispatched on every real
      // cross-session load, so loadSnapshot resolves it the same way.
      // Coercing dispatched UP here instead would make export -> load look
      // lossless in-process while the disk path quietly reshaped the record.
      const store = new LearningStore();
      for (let i = 0; i < 5; i++) store.recordSuccess("solo");
      expect(store.get("solo")).toMatchObject({ dispatched: 0, succeeded: 5 });

      const store2 = new LearningStore();
      store2.loadSnapshot(store.exportSnapshot());
      expect(store2.get("solo")).toMatchObject({ dispatched: 0, succeeded: 0 });

      // Loading the loaded snapshot is a fixed point -- no further drift.
      const store3 = new LearningStore();
      store3.loadSnapshot(store2.exportSnapshot());
      expect(store3.get("solo")).toEqual(store2.get("solo"));
    });

    it("resolves a corrupt overcount entry the same way sanitizeLearning does", () => {
      // Regression guard against the two files clamping one invariant in
      // opposite directions. persistence.test.ts pins sanitizeLearning on this
      // exact input: { dispatched: 3, succeeded: 7 } -> succeeded 3.
      const store = new LearningStore();
      store.loadSnapshot({ overcount: { dispatched: 3, succeeded: 7, lastUsedAt: 10 } });
      expect(store.get("overcount")).toEqual({ dispatched: 3, succeeded: 3, lastUsedAt: 10 });
    });

    it("round-tripping an empty store produces an empty store", () => {
      const store = new LearningStore();
      const snapshot = store.exportSnapshot();
      const store2 = new LearningStore();
      store2.loadSnapshot(snapshot);
      expect(store2.get("anything")).toBeUndefined();
    });
  });

  describe("get", () => {
    // Regression: get() handed back the LIVE NamespaceUsage object, so a
    // caller could write straight past the clamps every recorder maintains
    // (and, via exportSnapshot, put the out-of-range shape on disk).
    // entries() and exportSnapshot() already copied; this reader did not.
    it("returns a copy, so mutating the result cannot bypass the recorder clamps", () => {
      const store = new LearningStore();
      store.recordOutcome("gh", 1.0); // dispatched 1, succeeded 1
      const u = store.get("gh") as { dispatched: number; succeeded: number; lastUsedAt: number };
      u.dispatched = 999;
      u.succeeded = -50;
      const fresh = store.get("gh");
      expect(fresh?.dispatched).toBe(1);
      expect(fresh?.succeeded).toBe(1);
      // The store's own derived signal is unmoved too -- a succeeded of -50
      // over 999 dispatches would have fired the penalty branch.
      expect(store.boostFactor("gh")).toBe(1.0);
      expect(store.exportSnapshot().gh).toEqual({ dispatched: 1, succeeded: 1, lastUsedAt: expect.any(Number) });
    });
  });

  describe("recordMiss", () => {
    it("increments dispatched without incrementing succeeded", () => {
      const store = new LearningStore();
      store.recordMiss("gh");
      const u = store.get("gh");
      expect(u?.dispatched).toBe(1);
      expect(u?.succeeded).toBe(0);
    });

    it("boostFactor reflects the lower success rate after misses", () => {
      const store = new LearningStore();
      // Seed 3 genuine successes to pass the observation floor.
      store.loadSnapshot({ gh: { dispatched: 3, succeeded: 3, lastUsedAt: 1 } });
      const boostBefore = store.boostFactor("gh");
      expect(boostBefore).toBeGreaterThanOrEqual(1.0);

      // Add 10 misses: dispatched=13, succeeded=3 -> rate ~23%, well below 80%.
      for (let i = 0; i < 10; i++) {
        store.recordMiss("gh");
      }
      const boostAfter = store.boostFactor("gh");
      // Penalty branch should fire and bring the factor below 1.0.
      expect(boostAfter).toBeLessThan(1.0);
      expect(boostAfter).toBeGreaterThanOrEqual(LEARNING_MIN_BOOST);
    });
  });
});
