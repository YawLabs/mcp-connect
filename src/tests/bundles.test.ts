import { describe, expect, it } from "vitest";
import {
  CURATED_BUNDLES,
  type CuratedBundle,
  bundleActivateHint,
  matchBundles,
  topPartialBundles,
} from "../bundles.js";

describe("CURATED_BUNDLES data", () => {
  it("every bundle has a non-empty id, name, description, and namespaces array", () => {
    for (const bundle of CURATED_BUNDLES) {
      expect(bundle.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(bundle.name.length).toBeGreaterThan(0);
      expect(bundle.description.length).toBeGreaterThan(0);
      expect(bundle.namespaces.length).toBeGreaterThan(0);
      expect(["dev", "ops", "growth", "data"]).toContain(bundle.category);
    }
  });

  it("bundle ids are unique", () => {
    const ids = CURATED_BUNDLES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("namespaces within each bundle are unique", () => {
    for (const bundle of CURATED_BUNDLES) {
      expect(new Set(bundle.namespaces).size).toBe(bundle.namespaces.length);
    }
  });

  it("seeds at least 4 realistic bundles covering multiple categories", () => {
    expect(CURATED_BUNDLES.length).toBeGreaterThanOrEqual(4);
    const categories = new Set(CURATED_BUNDLES.map((b) => b.category));
    expect(categories.size).toBeGreaterThanOrEqual(3);
  });
});

describe("bundleActivateHint", () => {
  it("emits a ready-to-run mcp_connect_activate call with JSON namespaces", () => {
    const bundle: CuratedBundle = {
      id: "demo",
      name: "Demo",
      description: "test",
      namespaces: ["alpha", "beta"],
      category: "dev",
    };
    expect(bundleActivateHint(bundle)).toBe('mcp_connect_activate({ namespaces: ["alpha","beta"] })');
  });
});

describe("matchBundles", () => {
  it("returns empty ready + empty partial when nothing is installed (not an error)", () => {
    const result = matchBundles([]);
    expect(result.ready).toEqual([]);
    expect(result.partial).toEqual([]);
  });

  it("surfaces a bundle as ready when every namespace is installed", () => {
    // pr-review is the smallest seeded bundle (github + linear) — safe to
    // exercise without accidentally satisfying a larger bundle too.
    const result = matchBundles(["github", "linear"]);
    const prReview = result.ready.find((b) => b.id === "pr-review");
    expect(prReview).toBeDefined();
    expect(prReview?.namespaces).toEqual(["github", "linear"]);
    // pr-review should NOT also appear in partial.
    expect(result.partial.find((p) => p.bundle.id === "pr-review")).toBeUndefined();
  });

  it("separates partial matches from ready and reports the missing namespaces", () => {
    // Install github + slack only. devops-incident needs pagerduty on top
    // of those two, so it must land in `partial` with `missing=[pagerduty]`.
    const result = matchBundles(["github", "slack"]);
    const incident = result.partial.find((p) => p.bundle.id === "devops-incident");
    expect(incident).toBeDefined();
    expect(incident?.have.sort()).toEqual(["github", "slack"]);
    expect(incident?.missing).toEqual(["pagerduty"]);
    // And it must NOT appear as ready.
    expect(result.ready.find((b) => b.id === "devops-incident")).toBeUndefined();
  });

  it("omits bundles with zero overlap (noise suppression)", () => {
    // Random namespaces that match no curated bundle — the result should
    // be empty on both sides, not a list of "0% match" entries.
    const result = matchBundles(["totally-fake", "nope"]);
    expect(result.ready).toEqual([]);
    expect(result.partial).toEqual([]);
  });

  it("does not mutate its input iterable or the underlying bundles array", () => {
    const input = ["github", "linear"];
    const snapshot = [...input];
    const before = CURATED_BUNDLES.map((b) => ({ id: b.id, namespaces: [...b.namespaces] }));
    matchBundles(input);
    expect(input).toEqual(snapshot);
    const after = CURATED_BUNDLES.map((b) => ({ id: b.id, namespaces: [...b.namespaces] }));
    expect(after).toEqual(before);
  });

  it("accepts a Set as input (Iterable contract)", () => {
    const result = matchBundles(new Set(["github", "linear"]));
    expect(result.ready.some((b) => b.id === "pr-review")).toBe(true);
  });
});

describe("topPartialBundles", () => {
  it("returns empty when nothing is installed", () => {
    expect(topPartialBundles([], 3)).toEqual([]);
  });

  it("returns empty when limit is 0 or negative", () => {
    expect(topPartialBundles(["github", "linear"], 0)).toEqual([]);
    expect(topPartialBundles(["github", "linear"], -1)).toEqual([]);
  });

  it("ranks a 1-missing bundle ahead of a 2-missing bundle (fewest-missing wins)", () => {
    // Install github + slack. Relevant partials (by seeded bundles):
    //   devops-incident: have=[github,slack], missing=[pagerduty] — 1 missing
    //   product-release: have=[github,slack], missing=[linear]    — 1 missing
    //   growth-stack:    have=[slack],        missing=[hubspot,ga] — 2 missing
    //   support-ops:     have=[slack],        missing=[zendesk,hubspot] — 2 missing
    //   pr-review:       have=[github],       missing=[linear]    — 1 missing
    // Top 3 must all be 1-missing entries.
    const top = topPartialBundles(["github", "slack"], 3);
    expect(top.length).toBe(3);
    for (const t of top) {
      expect(t.missing.length).toBe(1);
    }
  });

  it("tie-breaks fewest-missing by most-momentum (have.length desc)", () => {
    // All three tied at missing=1, so have-length descending wins:
    //   devops-incident have=2, product-release have=2, pr-review have=1.
    // pr-review (have=1) must land AFTER the two have=2 bundles.
    const top = topPartialBundles(["github", "slack"], 3);
    const prReviewIndex = top.findIndex((t) => t.bundle.id === "pr-review");
    const devopsIndex = top.findIndex((t) => t.bundle.id === "devops-incident");
    const releaseIndex = top.findIndex((t) => t.bundle.id === "product-release");
    expect(prReviewIndex).toBeGreaterThan(devopsIndex);
    expect(prReviewIndex).toBeGreaterThan(releaseIndex);
  });

  it("caps the result at the requested limit", () => {
    const top = topPartialBundles(["github", "slack", "hubspot"], 2);
    expect(top.length).toBeLessThanOrEqual(2);
  });

  it("never includes a fully-ready bundle (those land in matchBundles.ready)", () => {
    // github+linear fully satisfies pr-review → it must not appear here.
    const top = topPartialBundles(["github", "linear"], 10);
    expect(top.find((t) => t.bundle.id === "pr-review")).toBeUndefined();
  });
});
