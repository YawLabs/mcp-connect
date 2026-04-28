import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeClientConfig, mergePermissionsAllow, parseInstallArgs, runInstall } from "../install-cmd.js";
import { CLAUDE_CODE_ALLOW_PATTERN, ENTRY_NAME } from "../install-targets.js";

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

describe("mergePermissionsAllow", () => {
  it("adds the pattern to an empty settings object", () => {
    const merged = mergePermissionsAllow({}, [CLAUDE_CODE_ALLOW_PATTERN]);
    expect(merged).toEqual({ permissions: { allow: [CLAUDE_CODE_ALLOW_PATTERN] } });
  });

  it("preserves unrelated top-level keys (hooks, model, mcpServers)", () => {
    const existing = {
      model: "claude-opus-4-7",
      hooks: { PreToolUse: [{ matcher: "Bash" }] },
      mcpServers: { other: { command: "x" } },
    };
    const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
    expect(merged.model).toBe("claude-opus-4-7");
    expect(merged.hooks).toEqual(existing.hooks);
    expect(merged.mcpServers).toEqual(existing.mcpServers);
    expect((merged.permissions as { allow: string[] }).allow).toContain(CLAUDE_CODE_ALLOW_PATTERN);
  });

  it("unions with existing allow entries instead of replacing", () => {
    const existing = { permissions: { allow: ["Bash(git *)", "Read"] } };
    const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
    const allow = (merged.permissions as { allow: string[] }).allow;
    expect(allow).toEqual(["Bash(git *)", "Read", CLAUDE_CODE_ALLOW_PATTERN]);
  });

  it("does not duplicate a pattern already present", () => {
    const existing = { permissions: { allow: [CLAUDE_CODE_ALLOW_PATTERN] } };
    const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
    const allow = (merged.permissions as { allow: string[] }).allow;
    expect(allow.filter((x) => x === CLAUDE_CODE_ALLOW_PATTERN)).toHaveLength(1);
  });

  it("preserves other permissions fields like deny / additionalDirectories", () => {
    const existing = { permissions: { deny: ["Bash(rm -rf *)"], additionalDirectories: ["/tmp"] } };
    const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
    const perms = merged.permissions as { allow: string[]; deny: string[]; additionalDirectories: string[] };
    expect(perms.deny).toEqual(["Bash(rm -rf *)"]);
    expect(perms.additionalDirectories).toEqual(["/tmp"]);
    expect(perms.allow).toContain(CLAUDE_CODE_ALLOW_PATTERN);
  });
});

describe("runInstall — settings.json merge edge cases (claude-code)", () => {
  it("preserves existing settings.json content when patching", async () => {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({
        model: "claude-opus-4-7",
        hooks: { PreToolUse: [] },
        permissions: { allow: ["Bash(git *)"], deny: ["Bash(rm -rf *)"] },
      }),
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

    const settings = JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf8"));
    expect(settings.model).toBe("claude-opus-4-7");
    expect(settings.hooks).toEqual({ PreToolUse: [] });
    expect(settings.permissions.deny).toEqual(["Bash(rm -rf *)"]);
    expect(settings.permissions.allow).toEqual(["Bash(git *)", CLAUDE_CODE_ALLOW_PATTERN]);
  });

  it("is a no-op on settings.json when the pattern is already present", async () => {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const initial = JSON.stringify({ permissions: { allow: [CLAUDE_CODE_ALLOW_PATTERN] } }, null, 2);
    writeFileSync(join(settingsDir, "settings.json"), initial);

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
    // settings.json not listed as written because no change was needed.
    expect(r.written).not.toContain(join(settingsDir, "settings.json"));
    // Contents untouched.
    expect(readFileSync(join(settingsDir, "settings.json"), "utf8")).toBe(initial);
  });

  it("does not touch settings.json for non-claude-code clients", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "cursor",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_aaaa",
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(synthHome, ".claude", "settings.json"))).toBe(false);
  });
});

describe("runInstall — happy path (claude-code, user scope, fresh install)", () => {
  it("writes client config, ~/.mcph/config.json, and patches settings.json permissions", async () => {
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
    // Three files touched: ~/.claude.json (mcpServers), ~/.mcph/config.json (token),
    // and ~/.claude/settings.json (permissions.allow so the client stops prompting).
    expect(r.written.length).toBe(3);

    const clientPath = join(synthHome, ".claude.json");
    const mcphPath = join(synthHome, ".mcph", "config.json");
    const settingsPath = join(synthHome, ".claude", "settings.json");
    expect(existsSync(clientPath)).toBe(true);
    expect(existsSync(mcphPath)).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);

    const client = JSON.parse(readFileSync(clientPath, "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["-y", "@yawlabs/mcph"]);
    // Token is NOT embedded in client config — lives in ~/.mcph/config.json instead.
    expect(client.mcpServers[ENTRY_NAME].env).toBeUndefined();

    const mcphCfg = JSON.parse(readFileSync(mcphPath, "utf8"));
    expect(mcphCfg.token).toBe("mcp_pat_fresh_aaaa");
    expect(mcphCfg.version).toBe(1);

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.permissions.allow).toContain(CLAUDE_CODE_ALLOW_PATTERN);
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

  it("backs up a malformed ~/.mcph/config.json before overwriting (token recovery path)", async () => {
    mkdirSync(join(synthHome, ".mcph"), { recursive: true });
    const malformedPath = join(synthHome, ".mcph", "config.json");
    const malformedBytes = '{"token": "mcp_pat_old_aaaa", "version": 1';
    writeFileSync(malformedPath, malformedBytes, "utf8");
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
    // New config has the new token.
    const cfg = JSON.parse(readFileSync(malformedPath, "utf8"));
    expect(cfg.token).toBe("mcp_pat_new_bbbb");
    // A .bak-* sibling exists with the original malformed bytes.
    const siblings = readdirSync(join(synthHome, ".mcph"));
    const backups = siblings.filter((f) => f.startsWith("config.json.bak-"));
    expect(backups).toHaveLength(1);
    const backedUp = readFileSync(join(synthHome, ".mcph", backups[0]), "utf8");
    expect(backedUp).toBe(malformedBytes);
    // User-facing message names the backup path.
    expect(cap.stdout()).toMatch(/was malformed/);
    expect(cap.stdout()).toMatch(/backed up to/);
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
    // Would-write list covers client config + mcph config + settings.json patch.
    expect(r.wouldWrite.length).toBe(3);
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
    expect(existsSync(join(synthHome, ".mcph", "config.json"))).toBe(false);
    expect(existsSync(join(synthHome, ".claude", "settings.json"))).toBe(false);
    expect(cap.stdout()).toMatch(/dry run/i);
  });
});

describe("runInstall — --no-mcph-config", () => {
  it("writes only the client config and the settings.json permissions patch", async () => {
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
    // --no-mcph-config skips ~/.mcph/config.json but still patches settings.json
    // so the user doesn't get re-prompted for every tool call.
    expect(r.written.length).toBe(2);
    expect(existsSync(join(synthHome, ".mcph", "config.json"))).toBe(false);
    expect(existsSync(join(synthHome, ".claude", "settings.json"))).toBe(true);
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

  it("--list + --all refused with exit 2", async () => {
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      listOnly: true,
      all: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(2);
    expect(cap.stderr()).toMatch(/mutually exclusive/);
  });
});

describe("parseInstallArgs — --list / --all", () => {
  it("accepts --list with no positional", () => {
    const r = parseInstallArgs(["--list"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.listOnly).toBe(true);
      expect(r.options.clientId).toBeUndefined();
    }
  });

  it("accepts --all with no positional", () => {
    const r = parseInstallArgs(["--all"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.all).toBe(true);
      expect(r.options.clientId).toBeUndefined();
    }
  });

  it("rejects --list combined with a client positional", () => {
    const r = parseInstallArgs(["claude-code", "--list"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--list does not take a client argument");
  });

  it("rejects --all combined with a client positional", () => {
    const r = parseInstallArgs(["cursor", "--all"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--all does not take a client argument");
  });

  it("accepts --all combined with --token", () => {
    const r = parseInstallArgs(["--all", "--token", "mcp_pat_xyz"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.all).toBe(true);
      expect(r.options.token).toBe("mcp_pat_xyz");
    }
  });
});

describe("runInstall --list (read-only)", () => {
  it("enumerates all clients on linux and shows `not installed` by default", async () => {
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      listOnly: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    const out = cap.stdout();
    expect(out).toContain("CLIENT");
    expect(out).toContain("SCOPE");
    expect(out).toContain("STATUS");
    // Claude Desktop is unavailable on linux.
    expect(out).toMatch(/Claude Desktop\s+user\s+\(n\/a\)\s+unavailable/);
    // Nothing seeded, so every other client reads "not installed".
    expect(out).toContain("not installed");
    expect(out).not.toContain("installed "); // "installed" word only appears in status heading/rows
    expect(out).toContain("0/");
  });

  it("detects an installed mcp.hosting entry in ~/.claude.json", async () => {
    // Seed Claude Code user-scope config with the entry.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcph"] } } }),
      "utf8",
    );
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      listOnly: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    const out = cap.stdout();
    expect(out).toMatch(/Claude Code\s+user\s+~[\\/].claude\.json\s+installed/);
    // At least one scope is configured; headline reflects that.
    expect(out).toMatch(/^\d+\/\d+ client scopes have mcp\.hosting configured on linux\./m);
  });

  it("reports `malformed` for unparseable client config", async () => {
    writeFileSync(join(synthHome, ".claude.json"), "{not valid json", "utf8");
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      listOnly: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toMatch(/Claude Code\s+user\s+~[\\/].claude\.json\s+malformed/);
  });

  it("does not require a token", async () => {
    // No token anywhere. --list should still work.
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      listOnly: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stderr()).toBe("");
  });
});

describe("runInstall --all", () => {
  it("installs into every user-scope client on linux and writes ~/.mcph/config.json once", async () => {
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      token: "mcp_pat_all",
      all: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    // Claude Code user → ~/.claude.json exists.
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(true);
    // Cursor user → ~/.cursor/mcp.json exists.
    expect(existsSync(join(synthHome, ".cursor", "mcp.json"))).toBe(true);
    // Claude Desktop is unavailable on linux, so skipped — no claude_desktop_config.
    // VS Code requires project-dir (user-scope unsupported); it's reported as skipped.
    const out = cap.stdout();
    expect(out).toContain("skip vscode");
    expect(out).toMatch(/✓ \d+\/\d+ clients installed successfully\./);
    // Token written to global mcph config exactly once.
    const mcphCfg = JSON.parse(readFileSync(join(synthHome, ".mcph", "config.json"), "utf8"));
    expect(mcphCfg.token).toBe("mcp_pat_all");
  });

  it("refuses with exit 1 when no clients are installable on the OS", async () => {
    const cap = captureIo();
    const r = await runInstall({
      // Synthetic OS value. Cast to bypass the TS guard since we're
      // probing the runtime error path.
      os: "plan9" as unknown as "linux",
      home: synthHome,
      cwd: synthCwd,
      token: "mcp_pat_abc",
      all: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toContain("no installable clients");
  });

  it("returns exit 1 when at least one sub-install fails", async () => {
    // Seed a malformed ~/.claude.json so Claude Code user-scope install
    // refuses (exit 1); Cursor install still succeeds. Aggregate fails.
    writeFileSync(join(synthHome, ".claude.json"), "{oops", "utf8");
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      token: "mcp_pat_x",
      all: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toMatch(/client install.*failed/);
  });
});
