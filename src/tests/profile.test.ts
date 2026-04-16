import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:os's homedir() so loadUserGlobalProfile and
// findProfilePath's stop-at-home logic use a per-test synthetic home,
// not Jeff's real $HOME (which may or may not have a .mcph.json and
// would make tests flaky). `homeState` is declared via vi.hoisted so
// vitest's mock-factory hoisting can see it; tests mutate homeState.value
// to redirect the synthetic home.
const homeState = vi.hoisted(() => ({ value: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:os");
  // Initialize the synthetic home default to the real tmpdir so any
  // calls before a test explicitly sets homeState.value don't blow up.
  if (!homeState.value) homeState.value = actual.tmpdir();
  return {
    ...actual,
    homedir: () => homeState.value,
  };
});

import {
  findProfilePath,
  loadEffectiveProfile,
  loadProfile,
  loadUserGlobalProfile,
  mergeProfiles,
  profileAllows,
} from "../profile.js";

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

describe("mergeProfiles", () => {
  it("returns null when both inputs are null", () => {
    expect(mergeProfiles(null, null)).toBeNull();
  });

  it("returns project as-is when user-global is null", () => {
    const project = { path: "/p/.mcph.json", servers: ["a"] };
    expect(mergeProfiles(project, null)).toEqual(project);
  });

  it("returns user-global as-is when project is null", () => {
    const user = { path: "/u/.mcph.json", servers: ["x", "y"] };
    expect(mergeProfiles(null, user)).toEqual(user);
  });

  it("project's servers allow-list replaces user-global's", () => {
    const project = { path: "/p/.mcph.json", servers: ["project-only"] };
    const user = { path: "/u/.mcph.json", servers: ["user1", "user2"] };
    const merged = mergeProfiles(project, user);
    expect(merged?.servers).toEqual(["project-only"]);
  });

  it("falls back to user-global servers when project doesn't specify", () => {
    const project = { path: "/p/.mcph.json" }; // no servers field
    const user = { path: "/u/.mcph.json", servers: ["user1", "user2"] };
    const merged = mergeProfiles(project, user);
    expect(merged?.servers).toEqual(["user1", "user2"]);
  });

  it("treats an empty servers list on project as an explicit statement (replaces)", () => {
    // servers: [] means "the project says: allow nothing via allow-list"
    // (which combined with profileAllows's empty-list-means-allow-all
    // semantics is effectively a reset). More importantly it is NOT
    // undefined, so it should win over user-global's value.
    const project = { path: "/p/.mcph.json", servers: [] };
    const user = { path: "/u/.mcph.json", servers: ["user1"] };
    const merged = mergeProfiles(project, user);
    expect(merged?.servers).toEqual([]);
  });

  it("unions blocked lists across scopes", () => {
    const project = { path: "/p/.mcph.json", blocked: ["proj-block"] };
    const user = { path: "/u/.mcph.json", blocked: ["user-block"] };
    const merged = mergeProfiles(project, user);
    expect(merged?.blocked?.sort()).toEqual(["proj-block", "user-block"]);
  });

  it("deduplicates blocked entries that appear in both scopes", () => {
    const project = { path: "/p/.mcph.json", blocked: ["shared", "proj-only"] };
    const user = { path: "/u/.mcph.json", blocked: ["shared", "user-only"] };
    const merged = mergeProfiles(project, user);
    expect(merged?.blocked?.sort()).toEqual(["proj-only", "shared", "user-only"]);
  });

  it("leaves blocked undefined when neither scope sets it", () => {
    const project = { path: "/p/.mcph.json", servers: ["a"] };
    const user = { path: "/u/.mcph.json", servers: ["b"] };
    const merged = mergeProfiles(project, user);
    expect(merged?.blocked).toBeUndefined();
  });

  it("records both paths in the merged profile", () => {
    const project = { path: "/p/.mcph.json" };
    const user = { path: "/u/.mcph.json" };
    const merged = mergeProfiles(project, user);
    expect(merged?.path).toBe("/p/.mcph.json");
    expect(merged?.userPath).toBe("/u/.mcph.json");
  });

  it("a user-global block still applies when project has an allow-list", () => {
    // End-to-end check: this is the scenario we most want to get right.
    // User trusts gh, pg, s3 globally and globally blocks "prod".
    // Project says "in this repo I only use gh and pg".
    // Expected effective profile: allow [gh, pg], block [prod].
    const project = { path: "/p/.mcph.json", servers: ["gh", "pg"] };
    const user = { path: "/u/.mcph.json", servers: ["gh", "pg", "s3"], blocked: ["prod"] };
    const merged = mergeProfiles(project, user);
    expect(merged?.servers).toEqual(["gh", "pg"]);
    expect(merged?.blocked).toEqual(["prod"]);
    expect(profileAllows(merged, "gh")).toBe(true);
    expect(profileAllows(merged, "s3")).toBe(false); // project's allow-list excludes it
    expect(profileAllows(merged, "prod")).toBe(false); // user's block still applies
  });
});

describe("loadUserGlobalProfile + loadEffectiveProfile", () => {
  let root: string; // synthetic $HOME for tests

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcph-home-"));
    homeState.value = root;
    // biome-ignore lint/performance/noDelete: env-var unset semantics require delete, not assignment
    delete process.env.MCPH_PROFILE;
  });
  afterEach(() => {
    homeState.value = tmpdir(); // reset to a benign value between tests
    rmSync(root, { recursive: true, force: true });
  });

  it("loadUserGlobalProfile returns null when no ~/.mcph.json exists", async () => {
    const profile = await loadUserGlobalProfile();
    expect(profile).toBeNull();
  });

  it("loadUserGlobalProfile reads ~/.mcph.json via homedir()", async () => {
    const userProfilePath = join(root, ".mcph.json");
    writeFileSync(userProfilePath, JSON.stringify({ servers: ["g1"], blocked: ["g-block"] }), "utf8");
    const profile = await loadUserGlobalProfile();
    expect(profile?.path).toBe(userProfilePath);
    expect(profile?.servers).toEqual(["g1"]);
    expect(profile?.blocked).toEqual(["g-block"]);
  });

  it("loadEffectiveProfile returns null when neither profile exists", async () => {
    // Start from a scratch dir outside $HOME so the walk can't find anything.
    const workDir = mkdtempSync(join(tmpdir(), "mcph-work-"));
    try {
      const profile = await loadEffectiveProfile(workDir);
      expect(profile).toBeNull();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("loadEffectiveProfile returns user-global alone when no project profile is found", async () => {
    const userProfilePath = join(root, ".mcph.json");
    writeFileSync(userProfilePath, JSON.stringify({ servers: ["user-default"] }), "utf8");

    const workDir = mkdtempSync(join(tmpdir(), "mcph-work-"));
    try {
      const profile = await loadEffectiveProfile(workDir);
      expect(profile?.path).toBe(userProfilePath);
      expect(profile?.servers).toEqual(["user-default"]);
      expect(profile?.userPath).toBeUndefined(); // single-source, no merge
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("loadEffectiveProfile returns project alone when no user-global profile exists", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "mcph-work-"));
    try {
      const projectProfilePath = join(workDir, ".mcph.json");
      writeFileSync(projectProfilePath, JSON.stringify({ servers: ["project-only"] }), "utf8");

      const profile = await loadEffectiveProfile(workDir);
      expect(profile?.path).toBe(projectProfilePath);
      expect(profile?.servers).toEqual(["project-only"]);
      expect(profile?.userPath).toBeUndefined();
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("loadEffectiveProfile merges both when both exist", async () => {
    const userProfilePath = join(root, ".mcph.json");
    writeFileSync(userProfilePath, JSON.stringify({ servers: ["gh", "pg", "s3"], blocked: ["global-bad"] }), "utf8");

    const workDir = mkdtempSync(join(tmpdir(), "mcph-work-"));
    try {
      const projectProfilePath = join(workDir, ".mcph.json");
      writeFileSync(projectProfilePath, JSON.stringify({ servers: ["gh", "pg"], blocked: ["local-prod"] }), "utf8");

      const profile = await loadEffectiveProfile(workDir);
      expect(profile?.path).toBe(projectProfilePath);
      expect(profile?.userPath).toBe(userProfilePath);
      expect(profile?.servers).toEqual(["gh", "pg"]); // project wins
      expect(profile?.blocked?.sort()).toEqual(["global-bad", "local-prod"]); // union
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("MCPH_PROFILE override ignores user-global entirely", async () => {
    // User has a global profile with some defaults.
    const userProfilePath = join(root, ".mcph.json");
    writeFileSync(userProfilePath, JSON.stringify({ servers: ["user-default"], blocked: ["u-block"] }), "utf8");

    const workDir = mkdtempSync(join(tmpdir(), "mcph-work-"));
    try {
      // MCPH_PROFILE points at a totally different file.
      const overridePath = join(workDir, "override.json");
      writeFileSync(overridePath, JSON.stringify({ servers: ["only-this"] }), "utf8");
      process.env.MCPH_PROFILE = overridePath;

      const profile = await loadEffectiveProfile(workDir);
      expect(profile?.path).toBe(overridePath);
      expect(profile?.servers).toEqual(["only-this"]);
      // The spec: override is explicit, don't surprise with merging.
      expect(profile?.userPath).toBeUndefined();
      expect(profile?.blocked).toBeUndefined(); // user-global's block is NOT applied
    } finally {
      // biome-ignore lint/performance/noDelete: env-var unset semantics require delete, not assignment
      delete process.env.MCPH_PROFILE;
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("doesn't double-count when project walk-up lands on ~/.mcph.json itself", async () => {
    // Scenario: user runs mcph from $HOME (or a subdir with no profile),
    // and the walk-up finds the user-global file as "the project profile".
    // We shouldn't then re-load it as user-global and set userPath === path.
    const userProfilePath = join(root, ".mcph.json");
    writeFileSync(userProfilePath, JSON.stringify({ servers: ["single"] }), "utf8");

    // Start inside $HOME so findProfilePath walks up to it.
    const profile = await loadEffectiveProfile(root);
    expect(profile?.path).toBe(userProfilePath);
    expect(profile?.userPath).toBeUndefined(); // NOT duplicated
    expect(profile?.servers).toEqual(["single"]);
  });

  it("ignores a malformed user-global profile but still uses project-local", async () => {
    // Fail-open: bad user-global shouldn't prevent project-local from applying.
    const userProfilePath = join(root, ".mcph.json");
    writeFileSync(userProfilePath, "{ not valid json", "utf8");

    const workDir = mkdtempSync(join(tmpdir(), "mcph-work-"));
    try {
      const projectProfilePath = join(workDir, ".mcph.json");
      writeFileSync(projectProfilePath, JSON.stringify({ servers: ["gh"] }), "utf8");

      const profile = await loadEffectiveProfile(workDir);
      expect(profile?.path).toBe(projectProfilePath);
      expect(profile?.servers).toEqual(["gh"]);
      expect(profile?.userPath).toBeUndefined(); // user-global failed to load
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
