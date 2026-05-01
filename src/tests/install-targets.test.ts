import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENTRY_NAME,
  INSTALL_TARGETS,
  buildLaunchEntry,
  resolveClaudeCodeSettingsPath,
  resolveInstallPath,
} from "../install-targets.js";

describe("INSTALL_TARGETS metadata", () => {
  it("includes the four expected clients", () => {
    expect(INSTALL_TARGETS.map((t) => t.clientId).sort()).toEqual([
      "claude-code",
      "claude-desktop",
      "cursor",
      "vscode",
    ]);
  });

  it("Claude Desktop is marked unavailable on Linux (no Linux build)", () => {
    const cd = INSTALL_TARGETS.find((t) => t.clientId === "claude-desktop");
    expect(cd?.availableOn).not.toContain("linux");
    expect(cd?.availableOn).toContain("macos");
    expect(cd?.availableOn).toContain("windows");
  });

  it("VS Code uses the `servers` root key, not `mcpServers`", () => {
    // This is the wire contract — getting it wrong silently fails.
    // code.visualstudio.com/docs/copilot/customization/mcp-servers
    const vscode = INSTALL_TARGETS.find((t) => t.clientId === "vscode");
    expect(vscode?.jsonShape).toBe("servers");
  });

  it("Claude Code + Desktop + Cursor all use `mcpServers` root key", () => {
    const mcpServerClients = INSTALL_TARGETS.filter((t) => t.jsonShape === "mcpServers").map((t) => t.clientId);
    expect(mcpServerClients.sort()).toEqual(["claude-code", "claude-desktop", "cursor"]);
  });

  it("every client lists at least one scope", () => {
    for (const t of INSTALL_TARGETS) {
      expect(t.scopes.length, `${t.clientId} has no scopes`).toBeGreaterThan(0);
    }
  });
});

describe("resolveInstallPath — Claude Code", () => {
  it("user scope on macOS resolves to ~/.claude.json (the file Claude Code actually reads)", () => {
    const r = resolveInstallPath({
      clientId: "claude-code",
      scope: "user",
      os: "macos",
      home: "/Users/alice",
    });
    // Locks the v0.11.2 fix: prior versions wrote to ~/.claude/settings.json,
    // which Claude Code silently ignores for MCP servers. ~/.claude.json
    // (no directory) is the canonical user-scope MCP store.
    expect(r.absolute).toMatch(/[\\/]\.claude\.json$/);
    expect(r.absolute).not.toMatch(/[\\/]\.claude[\\/]settings\.json$/);
    expect(r.display).toBe("~/.claude.json");
    expect(r.containerPath).toEqual(["mcpServers"]);
  });

  it("user scope on Windows uses %USERPROFILE% display path", () => {
    const r = resolveInstallPath({
      clientId: "claude-code",
      scope: "user",
      os: "windows",
      home: "C:\\Users\\alice",
    });
    expect(r.display).toBe("%USERPROFILE%\\.claude.json");
    expect(r.containerPath).toEqual(["mcpServers"]);
  });

  it("project scope resolves to <project>/.mcp.json", () => {
    const r = resolveInstallPath({
      clientId: "claude-code",
      scope: "project",
      os: "linux",
      home: "/home/alice",
      projectDir: "/home/alice/repo",
    });
    expect(r.absolute).toMatch(/[\\/]\.mcp\.json$/);
    expect(r.containerPath).toEqual(["mcpServers"]);
  });

  it("local scope writes to ~/.claude.json under projects[<absDir>].mcpServers", () => {
    // Claude Code stores per-project local-scope MCP nested inside the
    // global ~/.claude.json — NOT in <project>/.claude/settings.local.json
    // (that file is for permissions/hooks; mcpServers there is ignored).
    const r = resolveInstallPath({
      clientId: "claude-code",
      scope: "local",
      os: "linux",
      home: "/home/alice",
      projectDir: "/home/alice/repo",
    });
    expect(r.absolute).toMatch(/[\\/]\.claude\.json$/);
    expect(r.containerPath).toEqual(["projects", "/home/alice/repo", "mcpServers"]);
  });

  it("project scope without projectDir throws", () => {
    expect(() =>
      resolveInstallPath({ clientId: "claude-code", scope: "project", os: "linux", home: "/home/alice" }),
    ).toThrow(/requires a project directory/);
  });
});

describe("resolveInstallPath — Claude Code with CLAUDE_CONFIG_DIR override", () => {
  // Locks the v0.47.2 fix: when Claude Code runs under a wrapper that sets
  // CLAUDE_CONFIG_DIR (Yaw Mode, dev containers, sandboxed sessions), the
  // user-scope `.claude.json` it reads moves to <DIR>/.claude.json. If
  // mcph install ignores the env, the entry lands in ~/.claude.json while
  // Claude Code is reading from somewhere else — `claude mcp list` shows
  // nothing despite a "successful" install.

  it("user scope honors claudeConfigDir, not home", () => {
    const r = resolveInstallPath({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: "/home/alice",
      claudeConfigDir: "/tmp/wrapper-session",
    });
    expect(r.absolute).toBe(join("/tmp/wrapper-session", ".claude.json"));
    expect(r.absolute).not.toContain("alice");
    expect(r.containerPath).toEqual(["mcpServers"]);
  });

  it("user scope display is the absolute resolved path when overridden (no ~ shortcut)", () => {
    const r = resolveInstallPath({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: "/home/alice",
      claudeConfigDir: "/tmp/wrapper-session",
    });
    // Must not pretend it's still ~/.claude.json — that would mislead
    // users staring at doctor output trying to figure out where the
    // entry actually went.
    expect(r.display).toBe(join("/tmp/wrapper-session", ".claude.json"));
    expect(r.display).not.toBe("~/.claude.json");
  });

  it("local scope honors claudeConfigDir while preserving the projects[<dir>].mcpServers containerPath", () => {
    const r = resolveInstallPath({
      clientId: "claude-code",
      scope: "local",
      os: "linux",
      home: "/home/alice",
      projectDir: "/home/alice/repo",
      claudeConfigDir: "/tmp/wrapper-session",
    });
    expect(r.absolute).toBe(join("/tmp/wrapper-session", ".claude.json"));
    // Container path is unchanged — local-scope MCP still nests under
    // projects[<absDir>].mcpServers regardless of which file it's in.
    // The projectDir key is a JSON property, not a path, so we keep
    // the literal string form (it must match what Claude Code wrote).
    expect(r.containerPath).toEqual(["projects", "/home/alice/repo", "mcpServers"]);
  });

  it("project scope is unaffected by claudeConfigDir (project-relative .mcp.json)", () => {
    const r = resolveInstallPath({
      clientId: "claude-code",
      scope: "project",
      os: "linux",
      home: "/home/alice",
      projectDir: "/home/alice/repo",
      claudeConfigDir: "/tmp/wrapper-session",
    });
    // Project scope writes <project>/.mcp.json — Claude Code reads it
    // relative to the project, env redirect doesn't apply.
    expect(r.absolute).toBe(join("/home/alice/repo", ".mcp.json"));
  });

  it("empty claudeConfigDir falls back to home (treated as unset)", () => {
    const r = resolveInstallPath({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: "/home/alice",
      claudeConfigDir: "",
    });
    expect(r.absolute).toBe(join("/home/alice", ".claude.json"));
    expect(r.display).toBe("~/.claude.json");
  });

  it("undefined claudeConfigDir falls back to home (no env-fallback inside resolver)", () => {
    // Resolver is pure: it does NOT consult process.env.CLAUDE_CONFIG_DIR
    // on its own. Callers (install-cmd, doctor-cmd, index.ts) read env
    // and pass it; this keeps unit tests deterministic regardless of
    // whether the test runner inherits a real CLAUDE_CONFIG_DIR.
    const r = resolveInstallPath({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: "/home/alice",
    });
    expect(r.absolute).toBe(join("/home/alice", ".claude.json"));
  });

  it("does not leak into other clients (cursor user scope unaffected)", () => {
    const r = resolveInstallPath({
      clientId: "cursor",
      scope: "user",
      os: "linux",
      home: "/home/alice",
      claudeConfigDir: "/tmp/wrapper-session",
    });
    // Cursor has its own redirect mechanism (none, today) — claude_config_dir
    // must not bleed into ~/.cursor/mcp.json resolution.
    expect(r.absolute).toBe(join("/home/alice", ".cursor", "mcp.json"));
  });
});

describe("resolveClaudeCodeSettingsPath", () => {
  it("user scope without override resolves to ~/.claude/settings.json", () => {
    const p = resolveClaudeCodeSettingsPath("user", { home: "/home/alice", os: "linux" });
    expect(p).toBe(join("/home/alice", ".claude", "settings.json"));
  });

  it("user scope with claudeConfigDir resolves to <DIR>/settings.json", () => {
    // Note: NOT <DIR>/.claude/settings.json — the .claude segment is
    // absorbed by the env redirect (the dir IS the .claude equivalent).
    const p = resolveClaudeCodeSettingsPath("user", {
      home: "/home/alice",
      os: "linux",
      claudeConfigDir: "/tmp/wrapper-session",
    });
    expect(p).toBe(join("/tmp/wrapper-session", "settings.json"));
  });

  it("project scope is unaffected by claudeConfigDir", () => {
    const p = resolveClaudeCodeSettingsPath("project", {
      home: "/home/alice",
      projectDir: "/home/alice/repo",
      os: "linux",
      claudeConfigDir: "/tmp/wrapper-session",
    });
    expect(p).toBe(join("/home/alice/repo", ".claude", "settings.json"));
  });

  it("local scope writes settings.local.json in the project dir, not the wrapper dir", () => {
    const p = resolveClaudeCodeSettingsPath("local", {
      home: "/home/alice",
      projectDir: "/home/alice/repo",
      os: "linux",
      claudeConfigDir: "/tmp/wrapper-session",
    });
    expect(p).toBe(join("/home/alice/repo", ".claude", "settings.local.json"));
  });

  it("empty claudeConfigDir falls back to home (treated as unset)", () => {
    const p = resolveClaudeCodeSettingsPath("user", {
      home: "/home/alice",
      os: "linux",
      claudeConfigDir: "",
    });
    expect(p).toBe(join("/home/alice", ".claude", "settings.json"));
  });
});

describe("resolveInstallPath — Claude Desktop", () => {
  it("macOS resolves to ~/Library/Application Support/Claude/claude_desktop_config.json", () => {
    const r = resolveInstallPath({
      clientId: "claude-desktop",
      scope: "user",
      os: "macos",
      home: "/Users/alice",
    });
    expect(r.display).toBe("~/Library/Application Support/Claude/claude_desktop_config.json");
  });

  it("Windows uses %APPDATA%\\Claude\\claude_desktop_config.json", () => {
    const r = resolveInstallPath({
      clientId: "claude-desktop",
      scope: "user",
      os: "windows",
      home: "C:\\Users\\alice",
      appData: "C:\\Users\\alice\\AppData\\Roaming",
    });
    expect(r.display).toBe("%APPDATA%\\Claude\\claude_desktop_config.json");
  });

  it("Linux is refused (no Linux build)", () => {
    expect(() =>
      resolveInstallPath({ clientId: "claude-desktop", scope: "user", os: "linux", home: "/home/alice" }),
    ).toThrow(/not available on linux/);
  });
});

describe("resolveInstallPath — Cursor", () => {
  it("user scope uses ~/.cursor/mcp.json", () => {
    const r = resolveInstallPath({ clientId: "cursor", scope: "user", os: "macos", home: "/Users/alice" });
    expect(r.display).toBe("~/.cursor/mcp.json");
  });

  it("project scope uses <project>/.cursor/mcp.json", () => {
    const r = resolveInstallPath({
      clientId: "cursor",
      scope: "project",
      os: "linux",
      home: "/home/alice",
      projectDir: "/home/alice/repo",
    });
    expect(r.absolute).toMatch(/[\\/]\.cursor[\\/]mcp\.json$/);
  });
});

describe("resolveInstallPath — VS Code", () => {
  it("only supports project/workspace scope", () => {
    const vscode = INSTALL_TARGETS.find((t) => t.clientId === "vscode");
    expect(vscode?.scopes.map((s) => s.scope)).toEqual(["project"]);
  });

  it("resolves to <project>/.vscode/mcp.json", () => {
    const r = resolveInstallPath({
      clientId: "vscode",
      scope: "project",
      os: "linux",
      home: "/home/alice",
      projectDir: "/home/alice/repo",
    });
    expect(r.absolute).toMatch(/[\\/]\.vscode[\\/]mcp\.json$/);
  });
});

describe("buildLaunchEntry", () => {
  it("Windows wraps npx in cmd /c (npx.cmd shim workaround)", () => {
    const e = buildLaunchEntry({ os: "windows" });
    expect(e.command).toBe("cmd");
    expect(e.args).toEqual(["/c", "npx", "-y", "@yawlabs/mcph"]);
    expect(e.env).toBeUndefined();
  });

  it("macOS/Linux runs npx directly", () => {
    for (const os of ["macos", "linux"] as const) {
      const e = buildLaunchEntry({ os });
      expect(e.command).toBe("npx");
      expect(e.args).toEqual(["-y", "@yawlabs/mcph"]);
    }
  });

  it("embeds MCPH_TOKEN only when token is explicitly passed", () => {
    const withToken = buildLaunchEntry({ os: "macos", token: "mcp_pat_abc" });
    expect(withToken.env).toEqual({ MCPH_TOKEN: "mcp_pat_abc" });
    const without = buildLaunchEntry({ os: "macos" });
    expect(without.env).toBeUndefined();
  });
});

describe("ENTRY_NAME", () => {
  it("is the stable key mcph writes under mcpServers / servers", () => {
    // Doctor depends on this constant to detect an existing install.
    // If we ever rename it (e.g., "yawlabs-mcph"), user installs collide
    // until they re-run `mcph install` — document before changing.
    expect(ENTRY_NAME).toBe("mcp.hosting");
  });
});
