import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProfilePath, loadProfile, profileAllows } from "../profile.js";

describe("profileAllows", () => {
  it("allows anything when profile is null", () => {
    expect(profileAllows(null, "anything")).toBe(true);
  });

  it("blocks namespaces listed in blocked", () => {
    expect(profileAllows({ path: "/x", blocked: ["prod"] }, "prod")).toBe(false);
    expect(profileAllows({ path: "/x", blocked: ["prod"] }, "dev")).toBe(true);
  });

  it("treats servers as an allow-list when non-empty", () => {
    expect(profileAllows({ path: "/x", servers: ["a", "b"] }, "a")).toBe(true);
    expect(profileAllows({ path: "/x", servers: ["a", "b"] }, "c")).toBe(false);
  });

  it("ignores empty servers list (allows all)", () => {
    expect(profileAllows({ path: "/x", servers: [] }, "anything")).toBe(true);
  });

  it("blocked wins over allow", () => {
    expect(profileAllows({ path: "/x", servers: ["a", "b"], blocked: ["a"] }, "a")).toBe(false);
  });
});

describe("findProfilePath + loadProfile", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcph-profile-"));
    // biome-ignore lint/performance/noDelete: env-var unset semantics require delete, not assignment
    delete process.env.MCPH_PROFILE;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when no .mcph.json anywhere", async () => {
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    const found = await findProfilePath(deep);
    expect(found).toBeNull();
  });

  it("finds .mcph.json at the starting directory", async () => {
    const profilePath = join(root, ".mcph.json");
    writeFileSync(profilePath, JSON.stringify({ servers: ["a"] }), "utf8");
    const found = await findProfilePath(root);
    expect(found).toBe(profilePath);
  });

  it("walks up to find .mcph.json in an ancestor", async () => {
    const profilePath = join(root, ".mcph.json");
    writeFileSync(profilePath, JSON.stringify({ servers: ["a"] }), "utf8");
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    const found = await findProfilePath(deep);
    expect(found).toBe(profilePath);
  });

  it("parses a valid profile file", async () => {
    const profilePath = join(root, ".mcph.json");
    writeFileSync(profilePath, JSON.stringify({ servers: ["gh", "pg"], blocked: ["prod"] }), "utf8");
    const profile = await loadProfile(root);
    expect(profile?.path).toBe(profilePath);
    expect(profile?.servers).toEqual(["gh", "pg"]);
    expect(profile?.blocked).toEqual(["prod"]);
  });

  it("ignores malformed JSON without throwing", async () => {
    const profilePath = join(root, ".mcph.json");
    writeFileSync(profilePath, "{not valid json", "utf8");
    const profile = await loadProfile(root);
    expect(profile).toBeNull();
  });

  it("ignores non-object root", async () => {
    const profilePath = join(root, ".mcph.json");
    writeFileSync(profilePath, JSON.stringify(["a", "b"]), "utf8");
    const profile = await loadProfile(root);
    expect(profile).toBeNull();
  });

  it("filters non-string entries out of servers/blocked", async () => {
    const profilePath = join(root, ".mcph.json");
    writeFileSync(profilePath, JSON.stringify({ servers: ["ok", 42, null, "also-ok"], blocked: [{}, "bad"] }), "utf8");
    const profile = await loadProfile(root);
    expect(profile?.servers).toEqual(["ok", "also-ok"]);
    expect(profile?.blocked).toEqual(["bad"]);
  });

  it("respects MCPH_PROFILE env var override", async () => {
    const overridePath = join(root, "other.json");
    writeFileSync(overridePath, JSON.stringify({ servers: ["only"] }), "utf8");
    process.env.MCPH_PROFILE = overridePath;
    try {
      const profile = await loadProfile("/nonexistent/path");
      expect(profile?.path).toBe(overridePath);
      expect(profile?.servers).toEqual(["only"]);
    } finally {
      // biome-ignore lint/performance/noDelete: env-var unset semantics require delete, not assignment
      delete process.env.MCPH_PROFILE;
    }
  });
});
