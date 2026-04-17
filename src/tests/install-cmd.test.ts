import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeClientConfig, parseInstallArgs, runInstall } from "../install-cmd.js";
import { ENTRY_NAME } from "../install-targets.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "mcph-install-home-"));
  synthCwd = mkdtempSync(join(tmpdir(), "mcph-install-cwd-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
  rmSync(synthCwd, { recursive: true, force: true });
});

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  const sink = (arr: string[]): NodeJS.WritableStream => {
    return new Writable({
      write(chunk: Buffer, _enc, cb): void {
        arr.push(chunk.toString());
        cb();
      },
    }) as unknown as NodeJS.WritableStream;
  };
  return {
    io: {
      stdin: process.stdin,
      stdout: sink(out),
      stderr: sink(err),
      isTTY: false,
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

describe("parseInstallArgs", () => {
  it("rejects empty argv with usage", () => {
    const r = parseInstallArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Usage:");
  });

  it("parses positional client", () => {
    const r = parseInstallArgs(["claude-code"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.clientId).toBe("claude-code");
  });

  it("rejects unknown client", () => {
    const r = parseInstallArgs(["zed"]);
    expect(r.ok).toBe(false);
  });

  it("parses --scope", () => {
    const r = parseInstallArgs(["claude-code", "--scope", "project"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.scope).toBe("project");
  });

  it("rejects invalid --scope", () => {
    const r = parseInstallArgs(["claude-code", "--scope", "machine"]);
    expect(r.ok).toBe(false);
  });

  it("parses --token, --os, --project-dir, --force, --skip, --dry-run, --no-mcph-config", () => {
    const r = parseInstallArgs([
      "cursor",
      "--token",
      "mcp_pat_abc",
      "--os",
      "linux",
      "--project-dir",
      "/tmp/repo",
      "--force",
      "--dry-run",
      "--no-mcph-config",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.token).toBe("mcp_pat_abc");
      expect(r.options.os).toBe("linux");
      expect(r.options.projectDir).toBe("/tmp/repo");
      expect(r.options.force).toBe(true);
      expect(r.options.dryRun).toBe(true);
      expect(r.options.skipMcphConfig).toBe(true);
    }
  });

  it("rejects unknown flags", () => {
    const r = parseInstallArgs(["claude-code", "--bogus"]);
    expect(r.ok).toBe(false);
  });

  it("rejects more than one positional", () => {
    const r = parseInstallArgs(["claude-code", "cursor"]);
    expect(r.ok).toBe(false);
  });
});

describe("mergeClientConfig", () => {
  it("preserves other servers in mcpServers", () => {
    const existing = { mcpServers: { other: { command: "x" } } };
    const merged = mergeClientConfig(existing, ["mcpServers"], { command: "npx", args: ["-y", "@yawlabs/mcph"] });
    expect(merged.mcpServers).toEqual({
      other: { command: "x" },
      [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcph"] },
    });
  });

  it("preserves sibling top-level keys (e.g., model, hooks)", () => {
    const existing = { model: "claude-opus-4-7", mcpServers: {} };
    const merged = mergeClientConfig(existing, ["mcpServers"], { command: "npx", args: ["-y", "@yawlabs/mcph"] });
    expect(merged.model).toBe("claude-opus-4-7");
    expect((merged.mcpServers as Record<string, unknown>)[ENTRY_NAME]).toBeDefined();
  });

  it("creates the container if missing", () => {
    const merged = mergeClientConfig({}, ["servers"], { command: "npx", args: [] });
    expect(merged.servers).toEqual({ [ENTRY_NAME]: { command: "npx", args: [] } });
  });

  it("uses the right container key for VS Code (servers, not mcpServers)", () => {
    const merged = mergeClientConfig({}, ["servers"], { command: "x", args: [] });
    expect(merged.mcpServers).toBeUndefined();
    expect(merged.servers).toBeDefined();
  });

  it("does not mutate the input", () => {
    const existing = { mcpServers: { other: { command: "x" } } };
    const snapshot = JSON.stringify(existing);
    mergeClientConfig(existing, ["mcpServers"], { command: "y", args: [] });
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it("walks a nested containerPath and preserves siblings at every level", () => {
    // Claude Code local scope: ["projects", "/abs/dir", "mcpServers"].
    // Must preserve other projects + every top-level key in ~/.claude.json.
    const existing = {
      userID: "abc",
      projects: {
        "/other/project": { mcpServers: { foo: { command: "f" } }, history: ["x"] },
        "/abs/dir": { history: ["y"] },
      },
    };
    const merged = mergeClientConfig(existing, ["projects", "/abs/dir", "mcpServers"], {
      command: "npx",
      args: ["-y", "@yawlabs/mcph"],
    });
    expect(merged.userID).toBe("abc");
    const projects = merged.projects as Record<string, Record<string, unknown>>;
    // Other project untouched.
    expect(projects["/other/project"].mcpServers).toEqual({ foo: { command: "f" } });
    expect(projects["/other/project"].history).toEqual(["x"]);
    // Target project: history preserved, mcpServers added.
    expect(projects["/abs/dir"].history).toEqual(["y"]);
    expect((projects["/abs/dir"].mcpServers as Record<string, unknown>)[ENTRY_NAME]).toEqual({
      command: "npx",
      args: ["-y", "@yawlabs/mcph"],
    });
  });

  it("creates intermediate path segments when missing", () => {
    const merged = mergeClientConfig({}, ["projects", "/new/dir", "mcpServers"], { command: "npx", args: [] });
    const projects = merged.projects as Record<string, Record<string, unknown>>;
    expect(projects["/new/dir"].mcpServers).toEqual({ [ENTRY_NAME]: { command: "npx", args: [] } });
  });
});

describe("runInstall — happy path (claude-code, user scope, fresh install)", () => {
  it("writes both client config and ~/.mcph/config.json", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_fresh_aaaa",
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    expect(r.written.length).toBe(2);

    const clientPath = join(synthHome, ".claude.json");
    const mcphPath = join(synthHome, ".mcph", "config.json");
    expect(existsSync(clientPath)).toBe(true);
    expect(existsSync(mcphPath)).toBe(true);

    const client = JSON.parse(readFileSync(clientPath, "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["-y", "@yawlabs/mcph"]);
    // Token is NOT embedded in client config — lives in ~/.mcph/config.json instead.
    expect(client.mcpServers[ENTRY_NAME].env).toBeUndefined();

    const mcphCfg = JSON.parse(readFileSync(mcphPath, "utf8"));
    expect(mcphCfg.token).toBe("mcp_pat_fresh_aaaa");
    expect(mcphCfg.version).toBe(1);
  });
});

describe("runInstall — Windows uses cmd /c", () => {
  it("emits cmd-wrapped command on --os windows", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "windows",
      home: synthHome,
      token: "mcp_pat_w_aaaa",
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("cmd");
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["/c", "npx", "-y", "@yawlabs/mcph"]);
  });
});

describe("runInstall — VS Code servers shape", () => {
  it("writes under top-level `servers`, not `mcpServers`", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "vscode",
      scope: "project",
      os: "linux",
      home: synthHome,
      projectDir: synthCwd,
      token: "mcp_pat_vs_aaaa",
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthCwd, ".vscode", "mcp.json"), "utf8"));
    expect(client.mcpServers).toBeUndefined();
    expect(client.servers[ENTRY_NAME]).toBeDefined();
  });
});

describe("runInstall — preserves existing entries", () => {
  it("does not clobber unrelated mcpServers when adding mcp.hosting", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ model: "claude-opus-4-7", mcpServers: { spend: { url: "https://x" } } }, null, 2),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_aaaa",
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.model).toBe("claude-opus-4-7");
    expect(client.mcpServers.spend).toEqual({ url: "https://x" });
    expect(client.mcpServers[ENTRY_NAME]).toBeDefined();
  });
});

describe("runInstall — collision handling", () => {
  it("non-TTY without --force/--skip refuses with exit 1 when entry exists", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_aaaa",
      io: { ...cap.io, isTTY: false },
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toMatch(/already has/);
    // Original entry untouched.
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME]).toEqual({ command: "old" });
  });

  it("--force overwrites existing entry", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_aaaa",
      force: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
  });

  it("--skip leaves existing entry untouched", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_aaaa",
      skip: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME]).toEqual({ command: "old" });
    // ~/.mcph/config.json should NOT have been written either, since we short-circuited.
    expect(existsSync(join(synthHome, ".mcph", "config.json"))).toBe(false);
  });

  it("promptAnswer override exercises the interactive branch deterministically", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_aaaa",
      promptAnswer: "overwrite",
      io: { ...cap.io, isTTY: true },
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
  });
});

describe("runInstall — malformed existing JSON", () => {
  it("refuses to overwrite a malformed client config", async () => {
    writeFileSync(join(synthHome, ".claude.json"), "{ this is not json");
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_aaaa",
      io: cap.io,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toMatch(/not valid JSON/);
  });
});

describe("runInstall — token resolution", () => {
  it("uses existing ~/.mcph/config.json token when --token is omitted", async () => {
    mkdirSync(join(synthHome, ".mcph"), { recursive: true });
    writeFileSync(join(synthHome, ".mcph", "config.json"), JSON.stringify({ token: "mcp_pat_existing_aaaa" }));
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    // The token in ~/.mcph/config.json should remain (not erased).
    const cfg = JSON.parse(readFileSync(join(synthHome, ".mcph", "config.json"), "utf8"));
    expect(cfg.token).toBe("mcp_pat_existing_aaaa");
  });

  it("refuses with exit 1 when no token is anywhere", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toMatch(/no token available/i);
  });

  it("--token overrides existing ~/.mcph/config.json token", async () => {
    mkdirSync(join(synthHome, ".mcph"), { recursive: true });
    writeFileSync(join(synthHome, ".mcph", "config.json"), JSON.stringify({ token: "mcp_pat_old_aaaa" }));
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_new_bbbb",
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    const cfg = JSON.parse(readFileSync(join(synthHome, ".mcph", "config.json"), "utf8"));
    expect(cfg.token).toBe("mcp_pat_new_bbbb");
  });
});

describe("runInstall — --dry-run", () => {
  it("does not write any files but reports what would be written", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_aaaa",
      dryRun: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    expect(r.wouldWrite.length).toBe(2);
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
    expect(existsSync(join(synthHome, ".mcph", "config.json"))).toBe(false);
    expect(cap.stdout()).toMatch(/dry run/i);
  });
});

describe("runInstall — --no-mcph-config", () => {
  it("writes only the client config when --no-mcph-config is passed", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_aaaa",
      skipMcphConfig: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    expect(r.written.length).toBe(1);
    expect(existsSync(join(synthHome, ".mcph", "config.json"))).toBe(false);
  });
});

describe("runInstall — Claude Desktop on Linux refused", () => {
  it("exits 2 with helpful message", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-desktop",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_aaaa",
      io: cap.io,
    });
    expect(r.exitCode).toBe(2);
    expect(cap.stderr()).toMatch(/not available on linux/i);
    expect(cap.stderr()).toMatch(/Claude Code or Cursor/);
  });
});

describe("runInstall — mutually exclusive flags", () => {
  it("--force + --skip refused with exit 2", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_aaaa",
      force: true,
      skip: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(2);
    expect(cap.stderr()).toMatch(/mutually exclusive/);
  });
});
