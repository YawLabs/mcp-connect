import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeMcphConfig(root: string, filename: string, obj: unknown): void {
  mkdirSync(join(root, ".mcph"), { recursive: true });
  writeFileSync(join(root, ".mcph", filename), JSON.stringify(obj));
}
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatRelativeAge, runDoctor, scanShellHistoryForShadows } from "../doctor-cmd.js";
import { ENTRY_NAME } from "../install-targets.js";
import { STATE_FILENAME, STATE_SCHEMA_VERSION } from "../persistence.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "mcph-doctor-home-"));
  // synthCwd lives INSIDE synthHome so walk-up terminates at the
  // synthetic home boundary rather than escaping into the real user
  // dir, where a real ~/.mcph/config.json would otherwise get claimed.
  synthCwd = mkdtempSync(join(synthHome, "cwd-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
  rmSync(synthCwd, { recursive: true, force: true });
});

function captureOut() {
  const lines: string[] = [];
  return {
    out: (s: string) => lines.push(s),
    text: () => lines.join(""),
  };
}

describe("runDoctor — exit codes", () => {
  it("exits 1 when no token is anywhere", async () => {
    const cap = captureOut();
    const r = await runDoctor({ cwd: synthCwd, home: synthHome, env: {}, os: "linux", out: cap.out });
    expect(r.exitCode).toBe(1);
    expect(cap.text()).toMatch(/No token resolved/);
  });

  it("exits 0 when a token is in env and there are no warnings", async () => {
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa" },
      os: "linux",
      out: cap.out,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.text()).toMatch(/All good/);
  });

  it("exits 2 when token is present but warnings exist (newer schema)", async () => {
    writeMcphConfig(synthHome, "config.json", { version: 999, token: "mcp_pat_aaaa" });
    const cap = captureOut();
    const r = await runDoctor({ cwd: synthCwd, home: synthHome, env: {}, os: "linux", out: cap.out });
    expect(r.exitCode).toBe(2);
    expect(cap.text()).toMatch(/warnings above need attention/);
  });
});

describe("runDoctor — output content", () => {
  it("fingerprints the token (never prints raw)", async () => {
    const cap = captureOut();
    const raw = "mcp_pat_supersecret_DO_NOT_LEAK_aaaa1234";
    await runDoctor({ cwd: synthCwd, home: synthHome, env: { MCPH_TOKEN: raw }, os: "linux", out: cap.out });
    const txt = cap.text();
    expect(txt).not.toContain("supersecret");
    expect(txt).not.toContain("DO_NOT_LEAK");
    expect(txt).toMatch(/mcp_pat_…1234/);
  });

  it("reports the source for token and apiBase", async () => {
    writeMcphConfig(synthHome, "config.json", { token: "mcp_pat_aaaa", apiBase: "https://corp.example" });
    const cap = captureOut();
    await runDoctor({ cwd: synthCwd, home: synthHome, env: {}, os: "linux", out: cap.out });
    expect(cap.text()).toMatch(/source: global/);
    expect(cap.text()).toMatch(/https:\/\/corp\.example/);
  });

  it("lists each loaded config file with scope", async () => {
    writeMcphConfig(synthHome, "config.json", { token: "mcp_pat_aaaa" });
    writeMcphConfig(synthCwd, "config.json", { apiBase: "https://example" });
    const cap = captureOut();
    await runDoctor({ cwd: synthCwd, home: synthHome, env: {}, os: "linux", out: cap.out });
    const txt = cap.text();
    expect(txt).toMatch(/global {2}/);
    expect(txt).toMatch(/project /);
  });
});

describe("runDoctor — client detection", () => {
  it("reports Claude Code as configured when an mcp.hosting entry exists in ~/.claude.json", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "npx" } } }),
    );
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa" },
      os: "linux",
      out: cap.out,
    });
    expect(r.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "user")?.hasMcphEntry).toBe(true);
    expect(cap.text()).toMatch(/Claude Code \(user\): OK/);
  });

  it("reports Claude Desktop as unavailable on Linux", async () => {
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa" },
      os: "linux",
      out: cap.out,
    });
    const cd = r.snapshot.clients.find((c) => c.clientId === "claude-desktop");
    expect(cd?.unavailable).toBe(true);
    expect(cap.text()).toMatch(/Claude Desktop.*unavailable/);
  });

  it("flags malformed JSON in a client config", async () => {
    writeFileSync(join(synthHome, ".claude.json"), "{ broken");
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa" },
      os: "linux",
      out: cap.out,
    });
    expect(r.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "user")?.malformed).toBe(true);
    expect(cap.text()).toMatch(/JSON is malformed/);
  });

  it("suggests a `mcph install` command when a configured-looking file lacks the entry", async () => {
    writeFileSync(join(synthHome, ".claude.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const cap = captureOut();
    await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa" },
      os: "linux",
      out: cap.out,
    });
    expect(cap.text()).toMatch(/run `mcph install claude-code`/);
  });

  it("under CLAUDE_CONFIG_DIR, probes <DIR>/.claude.json — not the home file", async () => {
    // Sets up the trap: home has the entry, wrapper dir does NOT.
    // Doctor must report claude-code user as "not configured" (not "OK"),
    // matching what `claude mcp list` actually sees in this session.
    const wrapperDir = mkdtempSync(join(tmpdir(), "mcph-doctor-wrapper-"));
    try {
      writeFileSync(
        join(synthHome, ".claude.json"),
        JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "npx" } } }),
      );
      const cap = captureOut();
      const r = await runDoctor({
        cwd: synthCwd,
        home: synthHome,
        env: { MCPH_TOKEN: "mcp_pat_aaaa", CLAUDE_CONFIG_DIR: wrapperDir },
        os: "linux",
        out: cap.out,
      });
      const userScope = r.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "user");
      expect(userScope?.hasMcphEntry).toBe(false);
      expect(userScope?.path).toBe(join(wrapperDir, ".claude.json"));
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });

  it("under CLAUDE_CONFIG_DIR, finds the entry when it lives in <DIR>/.claude.json", async () => {
    const wrapperDir = mkdtempSync(join(tmpdir(), "mcph-doctor-wrapper-found-"));
    try {
      writeFileSync(
        join(wrapperDir, ".claude.json"),
        JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "npx" } } }),
      );
      const cap = captureOut();
      const r = await runDoctor({
        cwd: synthCwd,
        home: synthHome,
        env: { MCPH_TOKEN: "mcp_pat_aaaa", CLAUDE_CONFIG_DIR: wrapperDir },
        os: "linux",
        out: cap.out,
      });
      const userScope = r.snapshot.clients.find((c) => c.clientId === "claude-code" && c.scope === "user");
      expect(userScope?.hasMcphEntry).toBe(true);
      expect(cap.text()).toMatch(/Claude Code \(user\): OK/);
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });
});

describe("scanShellHistoryForShadows", () => {
  it("counts shadowed CLI invocations in bash history", () => {
    writeFileSync(
      join(synthHome, ".bash_history"),
      ["npm audit", "ls -la", "tailscale status", "npm deprecate foo bar", "cd ~"].join("\n"),
    );
    const hits = scanShellHistoryForShadows({ home: synthHome, env: {} });
    const npm = hits.find((h) => h.cli === "npm");
    const ts = hits.find((h) => h.cli === "tailscale");
    expect(npm?.count).toBe(2);
    expect(ts?.count).toBe(1);
    expect(npm?.namespaces).toContain("npmjs");
  });

  it("parses zsh extended-history metadata prefix", () => {
    writeFileSync(
      join(synthHome, ".zsh_history"),
      [": 1700000000:0;npm audit", ": 1700000001:0;gh pr list", "bare line without prefix"].join("\n"),
    );
    const hits = scanShellHistoryForShadows({ home: synthHome, env: {} });
    expect(hits.find((h) => h.cli === "npm")?.count).toBe(1);
    expect(hits.find((h) => h.cli === "gh")?.count).toBe(1);
  });

  it("strips leading env-var assignments and sudo", () => {
    writeFileSync(
      join(synthHome, ".bash_history"),
      ["FOO=bar npm search lodash", "sudo kubectl get pods", "DEBUG=1 FOO=baz aws s3 ls"].join("\n"),
    );
    const hits = scanShellHistoryForShadows({ home: synthHome, env: {} });
    expect(hits.find((h) => h.cli === "npm")?.count).toBe(1);
    expect(hits.find((h) => h.cli === "kubectl")?.count).toBe(1);
    expect(hits.find((h) => h.cli === "aws")?.count).toBe(1);
  });

  it("strips an absolute path from the leading binary", () => {
    writeFileSync(
      join(synthHome, ".bash_history"),
      ["/usr/local/bin/npm audit", "/opt/homebrew/bin/tailscale up"].join("\n"),
    );
    const hits = scanShellHistoryForShadows({ home: synthHome, env: {} });
    expect(hits.find((h) => h.cli === "npm")?.count).toBe(1);
    expect(hits.find((h) => h.cli === "tailscale")?.count).toBe(1);
  });

  it("returns [] when no history files exist", () => {
    const hits = scanShellHistoryForShadows({ home: synthHome, env: {} });
    expect(hits).toEqual([]);
  });

  it("ignores commands that don't match a shadowed CLI", () => {
    writeFileSync(join(synthHome, ".bash_history"), ["ls -la", "echo hi", "cat foo.txt", "pwd"].join("\n"));
    const hits = scanShellHistoryForShadows({ home: synthHome, env: {} });
    expect(hits).toEqual([]);
  });

  it("sorts hits by count descending", () => {
    writeFileSync(
      join(synthHome, ".bash_history"),
      ["tailscale up", "npm audit", "npm search foo", "npm view bar"].join("\n"),
    );
    const hits = scanShellHistoryForShadows({ home: synthHome, env: {} });
    expect(hits[0].cli).toBe("npm");
    expect(hits[0].count).toBe(3);
  });
});

describe("runDoctor — surfaces config-loader warnings", () => {
  it("relays the project-token warning into doctor output", async () => {
    writeMcphConfig(synthCwd, "config.json", { token: "mcp_pat_committed_aaaa" });
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_env_aaaa" },
      os: "linux",
      out: cap.out,
    });
    // Token resolved (env), but the warning about committed-file token still surfaces.
    expect(cap.text()).toMatch(/should not appear in a project-shared file/);
    expect(r.exitCode).toBe(2);
  });
});

describe("runDoctor — STATE section", () => {
  it("shows 'no persisted state yet' when state.json doesn't exist", async () => {
    const cap = captureOut();
    await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa" },
      os: "linux",
      out: cap.out,
      skipRegistryCheck: true,
    });
    const txt = cap.text();
    expect(txt).toMatch(/STATE\n/);
    expect(txt).toMatch(/no persisted state yet/);
  });

  it("reports counts and last-saved age when state.json exists", async () => {
    mkdirSync(join(synthHome, ".mcph"), { recursive: true });
    writeFileSync(
      join(synthHome, ".mcph", STATE_FILENAME),
      JSON.stringify({
        version: STATE_SCHEMA_VERSION,
        savedAt: Date.now() - 5 * 60 * 1000, // 5 minutes ago
        learning: {
          gh: { dispatched: 4, succeeded: 3, lastUsedAt: Date.now() },
          linear: { dispatched: 2, succeeded: 2, lastUsedAt: Date.now() },
        },
        packHistory: [
          { namespace: "gh", toolName: "listPrs", at: Date.now() - 1000 },
          { namespace: "gh", toolName: "addComment", at: Date.now() - 500 },
        ],
      }),
    );
    const cap = captureOut();
    await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa" },
      os: "linux",
      out: cap.out,
      skipRegistryCheck: true,
    });
    const txt = cap.text();
    expect(txt).toMatch(/STATE/);
    expect(txt).toMatch(/learning entries: +2/);
    expect(txt).toMatch(/pack history entries: +2/);
    expect(txt).toMatch(/last saved: +5m ago/);
  });

  it("shows 'disabled via MCPH_DISABLE_PERSISTENCE' and skips the file read", async () => {
    // Seed a state file so we can verify doctor doesn't read its contents.
    mkdirSync(join(synthHome, ".mcph"), { recursive: true });
    writeFileSync(
      join(synthHome, ".mcph", STATE_FILENAME),
      JSON.stringify({ version: STATE_SCHEMA_VERSION, savedAt: 1, learning: {}, packHistory: [] }),
    );
    const cap = captureOut();
    await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa", MCPH_DISABLE_PERSISTENCE: "1" },
      os: "linux",
      out: cap.out,
      skipRegistryCheck: true,
    });
    const txt = cap.text();
    expect(txt).toMatch(/disabled via MCPH_DISABLE_PERSISTENCE/);
    expect(txt).not.toMatch(/learning entries/);
    expect(txt).not.toMatch(/last saved/);
  });
});

describe("runDoctor — RELIABILITY section", () => {
  it("omits the section entirely when no namespace qualifies", async () => {
    mkdirSync(join(synthHome, ".mcph"), { recursive: true });
    writeFileSync(
      join(synthHome, ".mcph", STATE_FILENAME),
      JSON.stringify({
        version: STATE_SCHEMA_VERSION,
        savedAt: Date.now(),
        learning: {
          gh: { dispatched: 10, succeeded: 10, lastUsedAt: Date.now() },
          linear: { dispatched: 2, succeeded: 0, lastUsedAt: Date.now() },
        },
        packHistory: [],
      }),
    );
    const cap = captureOut();
    await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa" },
      os: "linux",
      out: cap.out,
      skipRegistryCheck: true,
    });
    expect(cap.text()).not.toMatch(/RELIABILITY/);
  });

  it("surfaces flaky namespaces sorted worst-rate first, capped at 5", async () => {
    const now = Date.now();
    mkdirSync(join(synthHome, ".mcph"), { recursive: true });
    const learning: Record<string, { dispatched: number; succeeded: number; lastUsedAt: number }> = {
      solid: { dispatched: 10, succeeded: 10, lastUsedAt: now },
      mild: { dispatched: 10, succeeded: 7, lastUsedAt: now - 60_000 }, // 70%
      severe: { dispatched: 5, succeeded: 1, lastUsedAt: now - 120_000 }, // 20%
      dead: { dispatched: 4, succeeded: 0, lastUsedAt: now - 180_000 }, // 0%
      zzz: { dispatched: 6, succeeded: 3, lastUsedAt: now }, // 50%
    };
    writeFileSync(
      join(synthHome, ".mcph", STATE_FILENAME),
      JSON.stringify({ version: STATE_SCHEMA_VERSION, savedAt: now, learning, packHistory: [] }),
    );
    const cap = captureOut();
    await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa" },
      os: "linux",
      out: cap.out,
      skipRegistryCheck: true,
    });
    const txt = cap.text();
    expect(txt).toMatch(/RELIABILITY \(dormant, <80% success\)/);
    // Healthy entries must not appear.
    expect(txt).not.toMatch(/ {2}solid /);
    // Ordering: dead (0%) < severe (20%) < zzz (50%) < mild (70%).
    const deadIdx = txt.indexOf("dead —");
    const severeIdx = txt.indexOf("severe —");
    const zzzIdx = txt.indexOf("zzz —");
    const mildIdx = txt.indexOf("mild —");
    expect(deadIdx).toBeGreaterThan(-1);
    expect(deadIdx).toBeLessThan(severeIdx);
    expect(severeIdx).toBeLessThan(zzzIdx);
    expect(zzzIdx).toBeLessThan(mildIdx);
    // Format carries call counts + rate + relative age.
    expect(txt).toMatch(/dead — 4 calls, 0% success, last used/);
  });

  it("is skipped when MCPH_DISABLE_PERSISTENCE is set", async () => {
    mkdirSync(join(synthHome, ".mcph"), { recursive: true });
    writeFileSync(
      join(synthHome, ".mcph", STATE_FILENAME),
      JSON.stringify({
        version: STATE_SCHEMA_VERSION,
        savedAt: Date.now(),
        learning: { flaky: { dispatched: 10, succeeded: 2, lastUsedAt: Date.now() } },
        packHistory: [],
      }),
    );
    const cap = captureOut();
    await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa", MCPH_DISABLE_PERSISTENCE: "1" },
      os: "linux",
      out: cap.out,
      skipRegistryCheck: true,
    });
    expect(cap.text()).not.toMatch(/RELIABILITY/);
  });
});

describe("runDoctor — ENVIRONMENT section", () => {
  it("renders every behavior-modifier var with '(not set)' when none are set", async () => {
    const cap = captureOut();
    await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa" },
      os: "linux",
      out: cap.out,
      skipRegistryCheck: true,
    });
    const txt = cap.text();
    expect(txt).toMatch(/ENVIRONMENT \(behavior overrides\)/);
    // Every tracked var must be listed so support can see at a glance
    // whether the user set it. Default-hint strings prove the row is
    // rendered with the "(not set — …)" form rather than a raw value.
    expect(txt).toMatch(/MCPH_POLL_INTERVAL\s+\(not set — default 60s\)/);
    expect(txt).toMatch(/MCPH_SERVER_CAP\s+\(not set — default 6\)/);
    expect(txt).toMatch(/MCPH_MIN_COMPLIANCE\s+\(not set — filter inactive\)/);
    expect(txt).toMatch(/MCPH_AUTO_LOAD\s+\(not set — auto-load inactive\)/);
    expect(txt).toMatch(/MCPH_PRUNE_RESPONSES\s+\(not set — pruning active\)/);
  });

  it("prints the raw value (not the default hint) when a var is set", async () => {
    const cap = captureOut();
    await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: {
        MCPH_TOKEN: "mcp_pat_aaaa",
        MCPH_SERVER_CAP: "10",
        MCPH_MIN_COMPLIANCE: "B",
        MCPH_AUTO_LOAD: "1",
      },
      os: "linux",
      out: cap.out,
      skipRegistryCheck: true,
    });
    const txt = cap.text();
    expect(txt).toMatch(/MCPH_SERVER_CAP\s+10/);
    expect(txt).toMatch(/MCPH_MIN_COMPLIANCE\s+B/);
    expect(txt).toMatch(/MCPH_AUTO_LOAD\s+1/);
    // Unset vars should still show their default hint.
    expect(txt).toMatch(/MCPH_POLL_INTERVAL\s+\(not set/);
    expect(txt).toMatch(/MCPH_PRUNE_RESPONSES\s+\(not set/);
  });
});

describe("formatRelativeAge", () => {
  it("renders seconds under a minute", () => {
    expect(formatRelativeAge(0)).toBe("0s");
    expect(formatRelativeAge(45_000)).toBe("45s");
  });
  it("renders minutes under an hour", () => {
    expect(formatRelativeAge(60_000)).toBe("1m");
    expect(formatRelativeAge(45 * 60_000)).toBe("45m");
  });
  it("renders hours under a day", () => {
    expect(formatRelativeAge(60 * 60_000)).toBe("1h");
    expect(formatRelativeAge(23 * 60 * 60_000)).toBe("23h");
  });
  it("renders days for anything older", () => {
    expect(formatRelativeAge(24 * 60 * 60_000)).toBe("1d");
    expect(formatRelativeAge(5 * 24 * 60 * 60_000)).toBe("5d");
  });
  it("clamps negative input to 0s", () => {
    expect(formatRelativeAge(-1000)).toBe("0s");
  });
});

describe("runDoctor — --json", () => {
  it("emits a single JSON blob with no text sections", async () => {
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa" },
      os: "linux",
      out: cap.out,
      json: true,
      skipRegistryCheck: true,
    });
    expect(r.exitCode).toBe(0);
    // Should have exactly one element (the JSON blob) in lines.
    expect(r.lines).toHaveLength(1);
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed).toMatchObject({
      version: expect.any(String),
      platform: "linux",
      token: { source: "env" },
      apiBase: { value: expect.any(String), source: expect.any(String) },
      diagnosis: { exitCode: 0, summary: expect.any(String) },
    });
    // Text-mode section headers MUST NOT appear.
    expect(cap.text()).not.toMatch(/CONFIG FILES|TOKEN\n|DIAGNOSIS/);
  });

  it("never includes the raw token value", async () => {
    const cap = captureOut();
    const raw = "mcp_pat_supersecret_DO_NOT_LEAK_aaaa1234";
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: raw },
      os: "linux",
      out: cap.out,
      json: true,
      skipRegistryCheck: true,
    });
    const text = r.lines.join("");
    expect(text).not.toContain("supersecret");
    expect(text).not.toContain("DO_NOT_LEAK");
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.token.fingerprint).toMatch(/…1234/);
    expect(parsed.token.fingerprint).not.toContain("DO_NOT_LEAK");
  });

  it("exit code in diagnosis matches returned exitCode (no token)", async () => {
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: {},
      os: "linux",
      out: cap.out,
      json: true,
      skipRegistryCheck: true,
    });
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.diagnosis.exitCode).toBe(1);
    expect(parsed.diagnosis.summary).toMatch(/No token/);
    expect(parsed.token.fingerprint).toBe("(none)");
  });

  it("surfaces warnings in the JSON snapshot", async () => {
    writeMcphConfig(synthHome, "config.json", { version: 999, token: "mcp_pat_aaaa" });
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: {},
      os: "linux",
      out: cap.out,
      json: true,
      skipRegistryCheck: true,
    });
    expect(r.exitCode).toBe(2);
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.diagnosis.exitCode).toBe(2);
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.loadedFiles[0].schemaAhead).toBe(true);
  });

  it("reports state.disabled when MCPH_DISABLE_PERSISTENCE is set", async () => {
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa", MCPH_DISABLE_PERSISTENCE: "1" },
      os: "linux",
      out: cap.out,
      json: true,
      skipRegistryCheck: true,
    });
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.state.disabled).toBe(true);
    expect(parsed.state.path).toBeNull();
    expect(parsed.state.savedAt).toBeNull();
  });

  it("includes reliability entries for flaky persisted namespaces", async () => {
    mkdirSync(join(synthHome, ".mcph"), { recursive: true });
    writeFileSync(
      join(synthHome, ".mcph", STATE_FILENAME),
      JSON.stringify({
        version: STATE_SCHEMA_VERSION,
        savedAt: Date.now() - 60_000,
        learning: {
          flaky: { dispatched: 10, succeeded: 3, lastUsedAt: Date.now() - 60_000 },
          good: { dispatched: 10, succeeded: 10, lastUsedAt: Date.now() - 60_000 },
        },
        packHistory: [],
      }),
    );
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa" },
      os: "linux",
      out: cap.out,
      json: true,
      skipRegistryCheck: true,
    });
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.reliability).toHaveLength(1);
    expect(parsed.reliability[0].namespace).toBe("flaky");
    expect(parsed.reliability[0].successRate).toBeCloseTo(0.3, 2);
    expect(parsed.reliability[0].lastUsedAt).toMatch(/T/);
  });

  it("records the env overrides block with null for unset vars", async () => {
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa", MCPH_SERVER_CAP: "12" },
      os: "linux",
      out: cap.out,
      json: true,
      skipRegistryCheck: true,
    });
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.env.MCPH_SERVER_CAP).toBe("12");
    expect(parsed.env.MCPH_POLL_INTERVAL).toBeNull();
    expect(parsed.env).toHaveProperty("MCPH_AUTO_LOAD");
  });

  it("upgrade.stale is true when registry reports a newer version", async () => {
    // Doctor only flags stale when VERSION !== "dev". Under vitest
    // VERSION is "dev" so stale should always be false even with a
    // fetch hook override — this test documents that.
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa" },
      os: "linux",
      out: cap.out,
      json: true,
      skipRegistryCheck: true,
    });
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.upgrade.current).toBe("dev");
    expect(parsed.upgrade.stale).toBe(false);
  });

  it("clients array is populated even in json mode", async () => {
    const cap = captureOut();
    const r = await runDoctor({
      cwd: synthCwd,
      home: synthHome,
      env: { MCPH_TOKEN: "mcp_pat_aaaa" },
      os: "linux",
      out: cap.out,
      json: true,
      skipRegistryCheck: true,
    });
    const parsed = JSON.parse(r.lines[0]);
    expect(Array.isArray(parsed.clients)).toBe(true);
    expect(parsed.clients.length).toBeGreaterThan(0);
    expect(parsed.clients[0]).toHaveProperty("clientId");
  });
});
