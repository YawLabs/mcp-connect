import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILENAME,
  CURRENT_SCHEMA_VERSION,
  LOCAL_CONFIG_FILENAME,
  isAllowed,
  loadEffectiveProfile,
  loadMcphConfig,
  profileAllows,
  tokenFingerprint,
} from "../config-loader.js";
import { CONFIG_DIRNAME } from "../paths.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "mcph-cfg-home-"));
  // synthCwd lives next to synthHome, not under it — so walk-up from
  // synthCwd genuinely crosses fs levels without ever hitting synthHome.
  synthCwd = mkdtempSync(join(tmpdir(), "mcph-cfg-cwd-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
  rmSync(synthCwd, { recursive: true, force: true });
});

// Writes <root>/.mcph/<filename> with the given JSON object.
// Default perms 0o600 on POSIX so fixtures don't trip the loose-perms
// warning. Tests that need 644 call chmodSync after this.
function writeConfig(root: string, filename: string, obj: unknown): string {
  const dir = join(root, CONFIG_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, filename);
  writeFileSync(p, JSON.stringify(obj, null, 2));
  if (process.platform !== "win32") chmodSync(p, 0o600);
  return p;
}

function writeConfigRaw(root: string, filename: string, body: string): string {
  const dir = join(root, CONFIG_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, filename);
  writeFileSync(p, body);
  if (process.platform !== "win32") chmodSync(p, 0o600);
  return p;
}

describe("loadMcphConfig — defaults & env-only", () => {
  it("returns defaults when no files exist and no env is set", async () => {
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.token).toBeNull();
    expect(r.tokenSource).toBe("missing");
    expect(r.apiBase).toBe("https://mcp.hosting");
    expect(r.apiBaseSource).toBe("default");
    expect(r.loadedFiles).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.projectConfigDir).toBeNull();
  });

  it("reads MCPH_TOKEN + MCPH_URL from env when no files exist", async () => {
    const r = await loadMcphConfig({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_env_aaaa", MCPH_URL: "https://staging.mcp.hosting" },
    });
    expect(r.token).toBe("mcp_pat_env_aaaa");
    expect(r.tokenSource).toBe("env");
    expect(r.apiBase).toBe("https://staging.mcp.hosting");
    expect(r.apiBaseSource).toBe("env");
  });
});

describe("loadMcphConfig — global ~/.mcph/config.json", () => {
  it("loads token + apiBase from user-global when env is empty", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, {
      version: 1,
      token: "mcp_pat_global_aaaa",
      apiBase: "https://corp.mcp.hosting",
    });
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.token).toBe("mcp_pat_global_aaaa");
    expect(r.tokenSource).toBe("global");
    expect(r.apiBase).toBe("https://corp.mcp.hosting");
    expect(r.apiBaseSource).toBe("global");
    expect(r.loadedFiles.map((f) => f.scope)).toEqual(["global"]);
  });

  it("env still wins over global file", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { token: "mcp_pat_global_aaaa" });
    const r = await loadMcphConfig({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_env_bbbb" },
    });
    expect(r.token).toBe("mcp_pat_env_bbbb");
    expect(r.tokenSource).toBe("env");
  });
});

describe("loadMcphConfig — precedence", () => {
  it("local file beats global file for token", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { token: "mcp_pat_global_aaaa" });
    writeConfig(synthCwd, LOCAL_CONFIG_FILENAME, { token: "mcp_pat_local_bbbb" });
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.token).toBe("mcp_pat_local_bbbb");
    expect(r.tokenSource).toBe("local");
    expect(r.loadedFiles.map((f) => f.scope).sort()).toEqual(["global", "local"]);
  });

  it("apiBase precedence: env > local > project > global > default", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { apiBase: "https://global.example" });
    writeConfig(synthCwd, CONFIG_FILENAME, { apiBase: "https://project.example" });
    writeConfig(synthCwd, LOCAL_CONFIG_FILENAME, { apiBase: "https://local.example" });

    const localWins = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(localWins.apiBase).toBe("https://local.example");
    expect(localWins.apiBaseSource).toBe("local");

    rmSync(join(synthCwd, CONFIG_DIRNAME, LOCAL_CONFIG_FILENAME));
    const projectWins = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(projectWins.apiBase).toBe("https://project.example");
    expect(projectWins.apiBaseSource).toBe("project");

    rmSync(join(synthCwd, CONFIG_DIRNAME, CONFIG_FILENAME));
    const globalWins = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(globalWins.apiBase).toBe("https://global.example");
    expect(globalWins.apiBaseSource).toBe("global");

    const envWins = await loadMcphConfig({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_URL: "https://env.example" },
    });
    expect(envWins.apiBase).toBe("https://env.example");
    expect(envWins.apiBaseSource).toBe("env");
  });

  it("project file token does NOT contribute to token resolution (only warns)", async () => {
    // Committed file is the wrong place for a token; we ignore it for
    // resolution and surface a warning instead.
    writeConfig(synthCwd, CONFIG_FILENAME, { token: "mcp_pat_should_not_use_aaaa" });
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.token).toBeNull();
    expect(r.tokenSource).toBe("missing");
    expect(r.warnings.some((w) => w.includes("project-shared file"))).toBe(true);
  });
});

describe("loadMcphConfig — JSONC support", () => {
  it("strips line + block comments before parsing", async () => {
    writeConfigRaw(
      synthHome,
      CONFIG_FILENAME,
      `{
  // user-global config with comments
  "version": 1,
  "token": "mcp_pat_jsonc_aaaa", /* end-of-line block */
  "apiBase": "https://mcp.hosting"
}`,
    );
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.token).toBe("mcp_pat_jsonc_aaaa");
    expect(r.warnings).toEqual([]);
  });
});

describe("loadMcphConfig — schema versioning", () => {
  it("warns when a file declares a newer schema version than this mcph supports", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { version: CURRENT_SCHEMA_VERSION + 1, token: "mcp_pat_aaaa" });
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.token).toBe("mcp_pat_aaaa");
    expect(r.warnings.some((w) => w.includes("schema version"))).toBe(true);
  });

  it("loads silently when version is current or absent", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { version: CURRENT_SCHEMA_VERSION, token: "x" });
    const r1 = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r1.warnings).toEqual([]);
    writeConfig(synthHome, CONFIG_FILENAME, { token: "x" });
    const r2 = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r2.warnings).toEqual([]);
  });
});

describe("loadMcphConfig — fail-open on bad files", () => {
  it("malformed JSON in local file falls back to global", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { token: "mcp_pat_global_aaaa" });
    writeConfigRaw(synthCwd, LOCAL_CONFIG_FILENAME, "{ this is not json");
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.token).toBe("mcp_pat_global_aaaa");
    expect(r.tokenSource).toBe("global");
    expect(r.warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
  });

  it("non-object root is ignored with a warning", async () => {
    writeConfigRaw(synthHome, CONFIG_FILENAME, JSON.stringify(["not", "an", "object"]));
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.token).toBeNull();
    expect(r.warnings.some((w) => w.includes("must be a JSON object"))).toBe(true);
  });
});

describe("loadMcphConfig — servers/blocked merging", () => {
  it("project allow-list wins over global", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["a", "b"] });
    writeConfig(synthCwd, CONFIG_FILENAME, { servers: ["c"] });
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toEqual(["c"]);
  });

  it("local allow-list wins over project and global", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["a"] });
    writeConfig(synthCwd, CONFIG_FILENAME, { servers: ["b"] });
    writeConfig(synthCwd, LOCAL_CONFIG_FILENAME, { servers: ["c"] });
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.servers).toEqual(["c"]);
  });

  it("blocked unions across all scopes", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { blocked: ["a", "b"] });
    writeConfig(synthCwd, CONFIG_FILENAME, { blocked: ["b", "c"] });
    writeConfig(synthCwd, LOCAL_CONFIG_FILENAME, { blocked: ["d"] });
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect((r.blocked ?? []).sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("loadMcphConfig — walk-up project discovery", () => {
  it("finds .mcph/ in a parent directory", async () => {
    writeConfig(synthCwd, CONFIG_FILENAME, { apiBase: "https://parent.example" });
    const deep = join(synthCwd, "apps", "web", "src");
    mkdirSync(deep, { recursive: true });
    const r = await loadMcphConfig({ cwd: deep, home: synthHome, env: {} });
    expect(r.apiBase).toBe("https://parent.example");
    expect(r.apiBaseSource).toBe("project");
    expect(r.projectConfigDir).toBe(join(synthCwd, CONFIG_DIRNAME));
  });

  it("does not treat ~/.mcph/ as a project dir when cwd is under $HOME", async () => {
    // A `.mcph/` at $HOME is the user-global scope. findProjectConfigDir
    // stops exclusive of $HOME, so even cwd deep inside $HOME shouldn't
    // claim it as project.
    writeConfig(synthHome, CONFIG_FILENAME, { token: "mcp_pat_global_aaaa" });
    const sub = join(synthHome, "projects", "p1");
    mkdirSync(sub, { recursive: true });
    const r = await loadMcphConfig({ cwd: sub, home: synthHome, env: {} });
    expect(r.projectConfigDir).toBeNull();
    expect(r.loadedFiles.map((f) => f.scope)).toEqual(["global"]);
  });
});

describe("checkPermissions (POSIX only)", () => {
  it.skipIf(process.platform === "win32")("warns on world-readable file with token", async () => {
    const file = writeConfig(synthHome, CONFIG_FILENAME, { token: "mcp_pat_loose_aaaa" });
    chmodSync(file, 0o644);
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.warnings.some((w) => w.includes("readable by group/other"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("does not warn on 0600 file", async () => {
    const file = writeConfig(synthHome, CONFIG_FILENAME, { token: "mcp_pat_strict_aaaa" });
    chmodSync(file, 0o600);
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.warnings).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("does not warn on file without a token even if loose perms", async () => {
    const file = writeConfig(synthHome, CONFIG_FILENAME, { servers: ["a"] });
    chmodSync(file, 0o644);
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.warnings).toEqual([]);
  });
});

describe("tokenFingerprint", () => {
  it("returns (none) for null", () => {
    expect(tokenFingerprint(null)).toBe("(none)");
  });

  it("masks long tokens to first-8…last-4", () => {
    expect(tokenFingerprint("mcp_pat_abcdef1234567890")).toBe("mcp_pat_…7890");
  });

  it("masks short tokens with last-2 only", () => {
    expect(tokenFingerprint("ab")).toBe("***ab");
  });
});

describe("loadMcphConfig — empty/invalid string fields are ignored", () => {
  it("empty token string is treated as missing", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { token: "" });
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.token).toBeNull();
    expect(r.tokenSource).toBe("missing");
  });

  it("non-string apiBase is ignored", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { apiBase: 123 });
    const r = await loadMcphConfig({ cwd: synthCwd, home: synthHome, env: {} });
    expect(r.apiBase).toBe("https://mcp.hosting");
    expect(r.apiBaseSource).toBe("default");
  });
});

describe("isAllowed / profileAllows", () => {
  it("null rules allows everything", () => {
    expect(isAllowed(null, "github")).toBe(true);
    expect(profileAllows(null, "github")).toBe(true);
  });

  it("empty rules allows everything", () => {
    expect(isAllowed({}, "anything")).toBe(true);
  });

  it("allow-list restricts to listed namespaces", () => {
    expect(isAllowed({ servers: ["github", "postgres"] }, "github")).toBe(true);
    expect(isAllowed({ servers: ["github", "postgres"] }, "slack")).toBe(false);
  });

  it("empty allow-list is treated as 'no restriction' (not 'deny all')", () => {
    // Users who clear servers to [] likely meant "no explicit filter",
    // not "nothing allowed". Blocking everything would make the config
    // feel broken rather than permissive.
    expect(isAllowed({ servers: [] }, "anything")).toBe(true);
  });

  it("deny-list blocks even if allow-list permits", () => {
    expect(isAllowed({ servers: ["github", "postgres"], blocked: ["postgres"] }, "postgres")).toBe(false);
  });

  it("deny-list alone blocks listed namespaces, allows others", () => {
    expect(isAllowed({ blocked: ["bad"] }, "bad")).toBe(false);
    expect(isAllowed({ blocked: ["bad"] }, "good")).toBe(true);
  });
});

describe("loadEffectiveProfile", () => {
  it("returns null when no allow/deny rules are set anywhere", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { token: "mcp_pat_aaaa" });
    const p = await loadEffectiveProfile(synthCwd, synthHome);
    expect(p).toBeNull();
  });

  it("returns a profile with servers + blocked when global sets them", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["github"], blocked: ["slack"] });
    const p = await loadEffectiveProfile(synthCwd, synthHome);
    expect(p).not.toBeNull();
    expect(p?.servers).toEqual(["github"]);
    expect(p?.blocked).toEqual(["slack"]);
    // Single-source (global-only) → no userPath needed, path IS the global.
    expect(p?.path).toContain(CONFIG_DIRNAME);
    expect(p?.userPath).toBeUndefined();
  });

  it("exposes both project and user paths when both contribute", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["github"] });
    writeConfig(synthCwd, CONFIG_FILENAME, { blocked: ["slack"] });
    const p = await loadEffectiveProfile(synthCwd, synthHome);
    expect(p).not.toBeNull();
    // Allow-list from global (project didn't set servers), blocked from project.
    expect(p?.servers).toEqual(["github"]);
    expect(p?.blocked).toEqual(["slack"]);
    expect(p?.path).toContain(join(synthCwd, CONFIG_DIRNAME));
    expect(p?.userPath).toContain(join(synthHome, CONFIG_DIRNAME));
  });

  it("project allow-list takes precedence over global", async () => {
    writeConfig(synthHome, CONFIG_FILENAME, { servers: ["github", "postgres"] });
    writeConfig(synthCwd, CONFIG_FILENAME, { servers: ["github"] });
    const p = await loadEffectiveProfile(synthCwd, synthHome);
    expect(p?.servers).toEqual(["github"]);
  });
});
