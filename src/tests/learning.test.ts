import { describe, expect, it } from "vitest";
import { LEARNING_MAX_BOOST, LEARNING_MIN_OBSERVATIONS, LearningStore } from "../learning.js";

describe("LearningStore", () => {
  it("returns 1.0 boost for unknown namespaces", () => {
    const store = new LearningStore();
    expect(store.boostFactor("never-seen")).toBe(1.0);
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
});
