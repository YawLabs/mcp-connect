import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeMcphConfig(root: string, filename: string, obj: unknown): void {
  mkdirSync(join(root, ".mcph"), { recursive: true });
  writeFileSync(join(root, ".mcph", filename), JSON.stringify(obj));
}
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor, scanShellHistoryForShadows } from "../doctor-cmd.js";
import { ENTRY_NAME } from "../install-targets.js";

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
