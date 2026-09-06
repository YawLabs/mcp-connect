import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  buildLaunchEntry,
  claudeCodeProjectKey,
  ENTRY_NAME,
  escapeCmdArg,
  INSTALL_TARGETS,
  isCmdShimLauncher,
  isProjectLocalEntry,
  resolveAppDataDir,
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

  it("local scope resolves a RELATIVE projectDir to absolute for the projects[] key", () => {
    // Claude Code keys local-scope MCP by the absolute project dir it
    // writes. A relative projectDir would key the entry under a path
    // Claude Code never uses, so install/doctor/list would disagree.
    // resolveInstallPath normalizes to absolute so the key is stable.
    const rel = "some/relative/repo";
    const r = resolveInstallPath({
      clientId: "claude-code",
      scope: "local",
      os: "linux",
      home: "/home/alice",
      projectDir: rel,
    });
    const key = r.containerPath[1];
    expect(isAbsolute(key)).toBe(true);
    // resolve() spells the key with the HOST separator, but Claude Code
    // writes projects[] keys with forward slashes on every OS — so on a
    // Windows runner the key is the normalized spelling (no-op on POSIX,
    // where resolve() already emits `/`).
    const expected = resolve(rel).replace(/\\/g, "/");
    expect(key).toBe(expected);
    expect(r.containerPath).toEqual(["projects", expected, "mcpServers"]);
  });

  it("local scope leaves an ABSOLUTE projectDir untouched in the projects[] key", () => {
    // The common case: callers pass process.cwd() / path.resolve(...),
    // which must pass through verbatim (including POSIX-rooted fixtures
    // on a Windows runner, where isAbsolute('/...') is true).
    //
    // The un-normalized `nested/..` segment is what makes this case
    // independently falsifiable -- with a plain `/home/alice/repo` fixture it
    // was byte-for-byte the case above and could never fail on its own.
    // Dropping the isAbsolute guard would send this through resolve(), which
    // collapses the `..` (and, on a Windows runner, re-roots it on the current
    // drive), so the key would no longer match what Claude Code wrote.
    const r = resolveInstallPath({
      clientId: "claude-code",
      scope: "local",
      os: "linux",
      home: "/home/alice",
      projectDir: "/home/alice/nested/../repo",
    });
    expect(r.containerPath).toEqual(["projects", "/home/alice/nested/../repo", "mcpServers"]);
    expect(r.containerPath[1]).not.toBe(resolve("/home/alice/nested/../repo"));
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
  // yaw-mcp install ignores the env, the entry lands in ~/.claude.json while
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
  // No `os` in any of these calls: the option is declared but never read (every
  // path here is node:path.join against the runner's platform), so passing it
  // only made the dead parameter look load-bearing. It stays optional in the
  // signature purely so the remaining production call sites keep compiling.
  it("user scope without override resolves to ~/.claude/settings.json", () => {
    const p = resolveClaudeCodeSettingsPath("user", { home: "/home/alice" });
    expect(p).toBe(join("/home/alice", ".claude", "settings.json"));
  });

  it("user scope with claudeConfigDir resolves to <DIR>/settings.json", () => {
    // Note: NOT <DIR>/.claude/settings.json — the .claude segment is
    // absorbed by the env redirect (the dir IS the .claude equivalent).
    const p = resolveClaudeCodeSettingsPath("user", {
      home: "/home/alice",
      claudeConfigDir: "/tmp/wrapper-session",
    });
    expect(p).toBe(join("/tmp/wrapper-session", "settings.json"));
  });

  it("project scope is unaffected by claudeConfigDir", () => {
    const p = resolveClaudeCodeSettingsPath("project", {
      home: "/home/alice",
      projectDir: "/home/alice/repo",
      claudeConfigDir: "/tmp/wrapper-session",
    });
    expect(p).toBe(join("/home/alice/repo", ".claude", "settings.json"));
  });

  it("local scope writes settings.local.json in the project dir, not the wrapper dir", () => {
    const p = resolveClaudeCodeSettingsPath("local", {
      home: "/home/alice",
      projectDir: "/home/alice/repo",
      claudeConfigDir: "/tmp/wrapper-session",
    });
    expect(p).toBe(join("/home/alice/repo", ".claude", "settings.local.json"));
  });

  it("empty claudeConfigDir falls back to home (treated as unset)", () => {
    const p = resolveClaudeCodeSettingsPath("user", {
      home: "/home/alice",
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
    // `absolute` is the path install actually WRITES; `display` is cosmetic.
    // Pinning only the display string left the write path unpinned anywhere in
    // the suite -- a refactor that dropped a segment here would stay green while
    // install wrote to a file Claude Desktop never reads and doctor/--list
    // agreed it was "installed" (they share this resolver). That is the exact
    // v0.11.0-0.11.1 failure class the file header records.
    expect(r.absolute).toBe(
      join("/Users/alice", "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
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

  it("never reads process.env.APPDATA -- with a `home` override or without one", () => {
    // The resolver is PURE: it consults no environment, and `appData` defaults
    // off `home` alone. Deciding %APPDATA% belongs to the CALLER (resolveAppData
    // in install-cmd.ts), which threads it in. Two separate failures ride on
    // that, one per branch below.
    //
    // WITH a `home`: claude-desktop is the one client living under %APPDATA%,
    // so an env read ahead of an explicit `home` meant a hermetic run (tests, a
    // `--home` override) resolved to -- and install would have written -- the
    // DEVELOPER's real claude_desktop_config.json.
    //
    // WITHOUT a `home`, which is the branch that split READ from WRITE: the
    // resolver used to fall back to the ambient env there, and only the WRITE
    // path reaches it (runInstall passes `home: undefined`; there is no --home
    // flag). Every reader resolves a home first, so on a box where %APPDATA% is
    // redirected away from `<home>\AppData\Roaming`, install wrote the file
    // Claude Desktop actually reads while doctor and --list named another.
    vi.stubEnv("APPDATA", "C:\\Users\\REAL-DEVELOPER\\AppData\\Roaming");
    try {
      const r = resolveInstallPath({
        clientId: "claude-desktop",
        scope: "user",
        os: "windows",
        home: "C:\\synth-home",
      });
      expect(r.absolute).toBe(join("C:\\synth-home", "AppData", "Roaming", "Claude", "claude_desktop_config.json"));
      expect(r.absolute).not.toContain("REAL-DEVELOPER");
      // No `home` either: still derived from the resolved home, never the env.
      const ambient = resolveInstallPath({ clientId: "claude-desktop", scope: "user", os: "windows" });
      expect(ambient.absolute).toBe(join(homedir(), "AppData", "Roaming", "Claude", "claude_desktop_config.json"));
      expect(ambient.absolute).not.toContain("REAL-DEVELOPER");
      // An explicit appData still wins over both.
      const explicit = resolveInstallPath({
        clientId: "claude-desktop",
        scope: "user",
        os: "windows",
        home: "C:\\synth-home",
        appData: "C:\\explicit\\Roaming",
      });
      expect(explicit.absolute).toBe(join("C:\\explicit\\Roaming", "Claude", "claude_desktop_config.json"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("an empty `appData` is treated as unset, never as a relative path", () => {
    // resolveInstallPath's own `opts.appData ?? join(home, ...)` was nullish-only,
    // so a caller-supplied "" -- or one threaded in from an empty-but-set
    // %APPDATA%, which is ordinary on Windows and in CI -- survived, and
    // claude-desktop resolved to the RELATIVE "Claude\claude_desktop_config.json".
    // doctor stats and prints that against the process cwd.
    const withHome = resolveInstallPath({
      clientId: "claude-desktop",
      scope: "user",
      os: "windows",
      home: "C:\\synth-home",
      appData: "",
    });
    expect(withHome.absolute).toBe(
      join("C:\\synth-home", "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
    );
    // No `home` either: the fallback is still the resolved home, NOT the env
    // (this resolver stays pure), and the result is ABSOLUTE on any runner.
    const ambient = resolveInstallPath({ clientId: "claude-desktop", scope: "user", os: "windows", appData: "" });
    expect(ambient.absolute).toBe(join(homedir(), "AppData", "Roaming", "Claude", "claude_desktop_config.json"));
    expect(isAbsolute(ambient.absolute)).toBe(true);
  });

  it("Linux is refused (no Linux build)", () => {
    expect(() =>
      resolveInstallPath({ clientId: "claude-desktop", scope: "user", os: "linux", home: "/home/alice" }),
    ).toThrow(/not available on linux/);
  });
});

describe("resolveAppDataDir", () => {
  it("treats an EMPTY %APPDATA% as unset and still resolves an ABSOLUTE dir", () => {
    // Empty-but-set env vars are ordinary on Windows and in CI. `env.APPDATA ??
    // join(homedir(), ...)` only falls back on null/undefined, so this returned
    // "" -- and every caller threads that into resolveInstallPath, which made
    // claude-desktop's path relative to the process cwd.
    const r = resolveAppDataDir({ env: { APPDATA: "" } });
    expect(r).toBe(join(homedir(), "AppData", "Roaming"));
    expect(isAbsolute(r)).toBe(true);
  });

  it("treats an empty `appData` override as unset, falling through to home then env", () => {
    expect(resolveAppDataDir({ appData: "", home: "C:\\synth-home" })).toBe(
      join("C:\\synth-home", "AppData", "Roaming"),
    );
    expect(resolveAppDataDir({ appData: "", env: { APPDATA: "D:\\Redirected\\Roaming" } })).toBe(
      "D:\\Redirected\\Roaming",
    );
  });

  it("precedence: explicit appData, then home, then the ambient %APPDATA%, then homedir()", () => {
    const env = { APPDATA: "D:\\Redirected\\Roaming" };
    // An explicit value wins over both, and a `home` override wins over the env
    // so a hermetic run cannot escape into the developer's real %APPDATA%.
    expect(resolveAppDataDir({ appData: "C:\\explicit\\Roaming", home: "C:\\synth-home", env })).toBe(
      "C:\\explicit\\Roaming",
    );
    expect(resolveAppDataDir({ home: "C:\\synth-home", env })).toBe(join("C:\\synth-home", "AppData", "Roaming"));
    // With neither, the ambient %APPDATA% is authoritative -- that is the
    // directory Claude Desktop reads when it is redirected off the home tree.
    expect(resolveAppDataDir({ env })).toBe("D:\\Redirected\\Roaming");
    expect(resolveAppDataDir({ env: {} })).toBe(join(homedir(), "AppData", "Roaming"));
    // An empty `home` is NOT re-interpreted as unset: falling through to the env
    // would aim a run that asked for a synthetic home at the real config file.
    expect(resolveAppDataDir({ home: "", env })).toBe(join("", "AppData", "Roaming"));
  });
});

describe("resolveInstallPath — Cursor", () => {
  it("user scope uses ~/.cursor/mcp.json", () => {
    const r = resolveInstallPath({ clientId: "cursor", scope: "user", os: "macos", home: "/Users/alice" });
    // Same reason as the Claude Desktop case: pin the path install writes, not
    // just the cosmetic display string.
    expect(r.absolute).toBe(join("/Users/alice", ".cursor", "mcp.json"));
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
    // @latest so npx re-resolves the newest release on every spawn.
    expect(e.args).toEqual(["/c", "npx", "-y", "@yawlabs/mcp@latest"]);
    expect(e.env).toBeUndefined();
  });

  it("macOS/Linux runs npx directly", () => {
    for (const os of ["macos", "linux"] as const) {
      const e = buildLaunchEntry({ os });
      expect(e.command).toBe("npx");
      expect(e.args).toEqual(["-y", "@yawlabs/mcp@latest"]);
    }
  });

  // Hosting the BROKER on oam (distinct from bundles.json `runtime: "oam"`,
  // which hosts the sidecars it spawns).
  it("hosts the broker on oam when both the binary and a durable entry resolve", () => {
    for (const os of ["windows", "macos", "linux"] as const) {
      const e = buildLaunchEntry({
        os,
        oamBinPath: "/usr/local/bin/oam",
        oamEntry: "/opt/nm/@yawlabs/mcp/dist/index.js",
      });
      expect(e.command).toBe("/usr/local/bin/oam");
      // No cmd /c even on Windows: that wrap exists for npx's .cmd shim, and
      // oam is a real executable the client can spawn directly.
      expect(e.args).toEqual(["run", "--no-check", "/opt/nm/@yawlabs/mcp/dist/index.js"]);
      expect(e.env).toBeUndefined();
    }
  });

  it("prefers upstream over oam when both are supplied", () => {
    // Precedence here is positional -- `upstream` returns before the oam
    // branch is reached. `yaw-mcp try` always passes upstream, so a
    // reordering would silently route trial entries through oam and point
    // them at the BROKER's binary instead of the upstream's launcher.
    const e = buildLaunchEntry({
      os: "linux",
      upstream: { command: "uvx", args: ["some-server"] },
      oamBinPath: "/usr/local/bin/oam",
      oamEntry: "/opt/nm/@yawlabs/mcp/dist/index.js",
    });
    expect(e.command).toBe("uvx");
    expect(e.args).toEqual(["some-server"]);
  });

  it("ignores oam when pkg pins a version, rather than emitting a name-only pin", () => {
    // npx honours a pinned spec on every spawn; an oamEntry is a resolved path
    // the caller looked up for its own package. Combining them would name one
    // version and run whatever is on disk, so the pin wins and oam is skipped.
    const e = buildLaunchEntry({
      os: "linux",
      pkg: "@yawlabs/mcp@0.73.0",
      oamBinPath: "/usr/local/bin/oam",
      oamEntry: "/opt/nm/@yawlabs/mcp/dist/index.js",
    });
    expect(e.command).toBe("npx");
    expect(e.args).toEqual(["-y", "@yawlabs/mcp@0.73.0"]);
  });

  it("keeps the npx entry when either half is missing", () => {
    // oam absent -> npx. The feature can only ever be an upgrade AT WRITE TIME:
    // it never replaces a launcher that works right now. (It says nothing about
    // later -- the entry is baked, so a subsequent oam or @yawlabs/mcp uninstall
    // breaks it with no retry and no downgrade. See BuildLaunchEntryOptions.)
    const noBin = buildLaunchEntry({ os: "linux", oamBinPath: null, oamEntry: "/opt/nm/@yawlabs/mcp/dist/index.js" });
    expect(noBin.command).toBe("npx");
    // oam present but yaw-mcp only in the npx cache -> npx, because a config
    // file must not persist a path under ~/.npm/_npx that can be evicted.
    const noEntry = buildLaunchEntry({ os: "linux", oamBinPath: "/usr/local/bin/oam", oamEntry: null });
    expect(noEntry.command).toBe("npx");
    expect(noEntry.args).toEqual(["-y", "@yawlabs/mcp@latest"]);
  });

  // The shape the probe actually produces without OAM_BIN. Every other fixture
  // here passes an absolute path, which is why a bare-name entry shipped:
  // `{command: "oam"}` resolves against the CLIENT's PATH, and a GUI-launched
  // client (Claude Desktop / Cursor from the Dock or Explorer) never inherited
  // the shell PATH that oam's installer nudged. The gate is inside
  // buildLaunchEntry, not only in its caller, so no caller can reintroduce it.
  it("refuses a non-absolute oam binary and stays on npx", () => {
    for (const [os, bareName] of [
      ["linux", "oam"],
      ["macos", "oam"],
      ["windows", "oam.exe"],
    ] as const) {
      const e = buildLaunchEntry({ os, oamBinPath: bareName, oamEntry: "/opt/nm/@yawlabs/mcp/dist/index.js" });
      expect(e.command).not.toBe(bareName);
      expect(e.command).toBe(os === "windows" ? "cmd" : "npx");
      expect(e.args).toEqual(
        os === "windows" ? ["/c", "npx", "-y", "@yawlabs/mcp@latest"] : ["-y", "@yawlabs/mcp@latest"],
      );
    }
    // A relative path is a bare name with extra steps -- same refusal.
    expect(
      buildLaunchEntry({ os: "linux", oamBinPath: "./bin/oam", oamEntry: "/opt/nm/@yawlabs/mcp/dist/index.js" })
        .command,
    ).toBe("npx");
  });

  // yaw-mcp is local-only: the default entry carries no env at all. There is
  // no longer a `token` option to embed YAW_MCP_TOKEN with.
  it("never sets env on the default entry", () => {
    for (const os of ["macos", "linux", "windows"] as const) {
      expect(buildLaunchEntry({ os }).env).toBeUndefined();
    }
  });

  it("triple-caret-escapes cmd metacharacters for a .cmd SHIM command on Windows", () => {
    // The entry is spawned by the MCP CLIENT, whose libuv only quotes argv
    // elements containing space/tab/quote. A bare `&` in a catalog arg would
    // otherwise reach cmd.exe unquoted and run the tail as a second command
    // at client-spawn time (a query-string arg truncates the same way).
    //
    // `npx` is a `.cmd` shim: cmd parses the line once, launches npx.cmd, and
    // npx.cmd forwards the args through `%*`, which cmd RE-PARSES. So an arg
    // must survive TWO cmd parses -- triple-caret (`^^^&` -> `^&` -> `&`). The
    // single caret this shipped with was a no-op against the shim: the outer
    // cmd stripped it and the bare `&` split inside the shim (reproduced live).
    const e = buildLaunchEntry({
      os: "windows",
      upstream: { command: "npx", args: ["-y", "some-server", "--url", "https://api/x?a=1&b=2"] },
    });
    expect(e.command).toBe("cmd");
    // Command token (`npx`, no metachar) unescaped; the metachar ARG triple-caret.
    expect(e.args).toEqual(["/c", "npx", "-y", "some-server", "--url", "https://api/x?a=1^^^&b=2"]);
  });

  it("single-caret-escapes cmd metacharacters for a DIRECT-exe command on Windows", () => {
    // `node` is a real exe, launched directly -- one cmd parse, no `%*`
    // re-parse -- so its args escape at the single-parse depth (`^&` -> `&`).
    // Triple-caret here would deliver a corrupted `^&` to the child.
    const e = buildLaunchEntry({
      os: "windows",
      upstream: { command: "node", args: ["server.js", "--url", "https://api/x?a=1&b=2"] },
    });
    expect(e.command).toBe("cmd");
    expect(e.args).toEqual(["/c", "node", "server.js", "--url", "https://api/x?a=1^&b=2"]);
  });

  it("single-caret-escapes for a uvx-hosted server (uvx.exe is direct, not a .cmd shim)", () => {
    // uv ships `uvx.exe`, so a uvx-hosted upstream is reached after ONE cmd
    // parse. Classifying uvx as a shim triple-caret escaped the arg and the
    // server received the corrupted `^&` instead of `&` -- the query string it
    // was handed silently carried a stray caret.
    const e = buildLaunchEntry({
      os: "windows",
      upstream: { command: "uvx", args: ["mcp-server-x", "--url", "https://api/x?a=1&b=2"] },
    });
    expect(e.command).toBe("cmd");
    expect(e.args).toEqual(["/c", "uvx", "mcp-server-x", "--url", "https://api/x?a=1^&b=2"]);
  });

  it("single-caret-escapes for a uv-hosted server (uv.exe is direct, like the uvx.exe beside it)", () => {
    // Bare `uv` (a catalog entry launching `uv run <srv>`) is the native exe
    // the bootstrap itself installs (uv-bootstrap.ts), reached after ONE cmd
    // parse. It was missing from the direct-binary set, so isCmdShimLauncher
    // failed it safe to "shim" and triple-caret escaped the arg -- uv.exe
    // received `^&` for `&`, the same defect the uvx case above was written
    // to stop.
    expect(isCmdShimLauncher("uv")).toBe(false);
    const e = buildLaunchEntry({
      os: "windows",
      upstream: { command: "uv", args: ["run", "srv", "--url", "https://x?a=1&b=2"] },
    });
    expect(e.command).toBe("cmd");
    expect(e.args).toEqual(["/c", "uv", "run", "srv", "--url", "https://x?a=1^&b=2"]);
  });

  it("refuses an upstream command containing whitespace on Windows", () => {
    // `command` goes into the `cmd /c` wrap verbatim (escapeCmdArg shape 3:
    // libuv quote-wraps a space-bearing token). But `cmd /c` strips the FIRST
    // and LAST quote of the line whenever a second token is quoted too, so the
    // command loses its opening quote and the client's spawn dies with
    // `'C:\Program' is not recognized`. Refuse at write time instead of
    // persisting an entry that fails later, in someone else's process.
    expect(() =>
      buildLaunchEntry({
        os: "windows",
        upstream: { command: "C:\\Program Files\\demo\\srv.cmd", args: ["--flag=a b"] },
      }),
    ).toThrow(/launcher command that contains whitespace/);
    // Non-Windows has no cmd.exe in the spawn path -- the same command is fine.
    const posix = buildLaunchEntry({
      os: "linux",
      upstream: { command: "/opt/demo dir/srv", args: ["--flag=a b"] },
    });
    expect(posix.command).toBe("/opt/demo dir/srv");
    expect(posix.args).toEqual(["--flag=a b"]);
  });

  it("refuses an upstream arg that combines a quote and a cmd metacharacter", () => {
    // The exact hostile-catalog injection escapeCmdArg's own comment closes:
    // `a"&echo X` breaks out of libuv's quoting under cmd.exe's quote-counting
    // parser and runs `echo X` at client-spawn time. No escaping is safe, so
    // buildLaunchEntry throws rather than emit an exploitable entry.
    expect(() =>
      buildLaunchEntry({
        os: "windows",
        upstream: { command: "npx", args: ["-y", "some-server", '--x=a"&calc'] },
      }),
    ).toThrow(/double-quote and a cmd\.exe metacharacter/);
  });

  it("passes a quote-bearing but metachar-free JSON arg through verbatim on Windows", () => {
    // Legitimate MCP config args (`--config {"a":1}`) must keep working: libuv
    // quote-wraps them and cmd, with no metachar to act on, passes them intact.
    const e = buildLaunchEntry({
      os: "windows",
      upstream: { command: "npx", args: ["-y", "some-server", "--config", '{"a":1}'] },
    });
    expect(e.args).toEqual(["/c", "npx", "-y", "some-server", "--config", '{"a":1}']);
  });

  it("leaves upstream args verbatim on macOS/Linux (no cmd.exe in the spawn path)", () => {
    const e = buildLaunchEntry({
      os: "linux",
      upstream: { command: "uvx", args: ["some-server", "--url", "https://api/x?a=1&b=2"] },
    });
    expect(e.command).toBe("uvx");
    expect(e.args).toEqual(["some-server", "--url", "https://api/x?a=1&b=2"]);
  });
});

describe("isCmdShimLauncher", () => {
  it("classifies known .cmd/.bat shim launchers as shims", () => {
    // npm-generated wrappers: every global npm bin and every node_modules/.bin
    // entry is a `.cmd` on Windows.
    for (const c of ["npx", "npm", "pnpm", "yarn", "bunx"]) {
      expect(isCmdShimLauncher(c), c).toBe(true);
    }
    // Explicit extension and a full path both resolve by basename.
    expect(isCmdShimLauncher("npx.cmd")).toBe(true);
    expect(isCmdShimLauncher("C:\\Users\\me\\AppData\\Roaming\\npm\\npx.cmd")).toBe(true);
    expect(isCmdShimLauncher("some-tool.bat")).toBe(true);
    // A hand-rolled `uvx.cmd` is still caught by the extension test, even
    // though the bare `uvx` stem is classified direct below.
    expect(isCmdShimLauncher("uvx.cmd")).toBe(true);
  });

  it("classifies real executables as direct (not shims)", () => {
    // uvx/pipx are in this list, not the shim list: uv ships `uvx.exe` beside
    // `uv.exe` (yaw-mcp's own uv bootstrap installs exactly that native binary)
    // and pipx installs `pipx.exe`. Calling them shims charged their args a
    // caret level they never spend -- a no-space metachar arg was triple-caret
    // escaped and arrived at uvx.exe as the corrupted `^&` instead of `&`.
    for (const c of ["node", "deno", "bun", "python", "python3", "uvx", "pipx", "docker", "dotnet", "java", "go"]) {
      expect(isCmdShimLauncher(c), c).toBe(false);
    }
    expect(isCmdShimLauncher("node.exe")).toBe(false);
    expect(isCmdShimLauncher("C:\\Program Files\\nodejs\\node.exe")).toBe(false);
    expect(isCmdShimLauncher("foo.com")).toBe(false);
    expect(isCmdShimLauncher("uvx.exe")).toBe(false);
  });

  it("fails SAFE for an unknown bare name (treated as a shim)", () => {
    // cmd can resolve a bare name to a `.cmd` via PATHEXT, so the injection-safe
    // default is to over-escape (shim depth), never under-escape.
    expect(isCmdShimLauncher("mystery-launcher")).toBe(true);
  });
});

describe("escapeCmdArg (Windows cmd /c metacharacter neutralization)", () => {
  it("triple-caret-escapes metachars for the SHIM path (survives the %* re-parse)", () => {
    // A shim (npx.cmd) forwards args through `%*`, which cmd RE-PARSES, so a
    // metachar must survive TWO cmd parses: `^^^&` -> `^&` -> `&`.
    expect(escapeCmdArg("https://api/x?a=1&b=2", { shim: true })).toBe("https://api/x?a=1^^^&b=2");
    expect(escapeCmdArg("a|b", { shim: true })).toBe("a^^^|b");
    expect(escapeCmdArg("a<b>c", { shim: true })).toBe("a^^^<b^^^>c");
    expect(escapeCmdArg("x^y", { shim: true })).toBe("x^^^^y");
    expect(escapeCmdArg("(group)", { shim: true })).toBe("^^^(group^^^)");
  });

  it("single-caret-escapes metachars for the DIRECT-exe path (one cmd parse)", () => {
    expect(escapeCmdArg("https://api/x?a=1&b=2", { shim: false })).toBe("https://api/x?a=1^&b=2");
    expect(escapeCmdArg("a|b", { shim: false })).toBe("a^|b");
    expect(escapeCmdArg("a<b>c", { shim: false })).toBe("a^<b^>c");
    expect(escapeCmdArg("x^y", { shim: false })).toBe("x^^y");
    expect(escapeCmdArg("(group)", { shim: false })).toBe("^(group^)");
  });

  it("leaves a quote-bearing but metachar-free arg alone (legit JSON must survive)", () => {
    // libuv quote-wraps + escapes it and cmd, with nothing to act on, passes it
    // through intact; a caret would corrupt it inside libuv's quotes.
    for (const shim of [true, false]) {
      expect(escapeCmdArg('{"a":1}', { shim })).toBe('{"a":1}');
      expect(escapeCmdArg('{"a":"b"}', { shim })).toBe('{"a":"b"}');
      expect(escapeCmdArg('say "hi"', { shim })).toBe('say "hi"');
    }
  });

  it("leaves a space/tab arg (no quote) alone -- libuv quotes it, caret would corrupt", () => {
    for (const shim of [true, false]) {
      expect(escapeCmdArg("foo & bar", { shim })).toBe("foo & bar");
      expect(escapeCmdArg("a\t&b", { shim })).toBe("a\t&b");
    }
  });

  it("REFUSES an arg combining a double-quote and a cmd metacharacter", () => {
    // The injection escapeCmdArg's comment closes: parity flips through libuv's
    // \" and no caret depth can neutralize the exposed metachar, so we throw.
    for (const shim of [true, false]) {
      expect(() => escapeCmdArg('a"&echo X', { shim })).toThrow(/double-quote and a cmd\.exe metacharacter/);
      expect(() => escapeCmdArg('{"url":"https://x?a=1&b=2"}', { shim })).toThrow(/command injection/);
      expect(() => escapeCmdArg('x"|y', { shim })).toThrow();
    }
  });

  it("leaves plain args and % untouched", () => {
    for (const shim of [true, false]) {
      expect(escapeCmdArg("-y", { shim })).toBe("-y");
      expect(escapeCmdArg("@yawlabs/mcp@latest", { shim })).toBe("@yawlabs/mcp@latest");
      // `%` is deliberately not escaped: cmd expands %VAR% before caret
      // processing, so a caret cannot neutralize it anyway.
      expect(escapeCmdArg("100%", { shim })).toBe("100%");
    }
  });
});

// Empirical proof on a real Windows box: spawn the escaped args through both a
// `%*`-forwarding `.cmd` shim and a direct exe, EXACTLY as an MCP client would
// spawn the stored entry, and assert the argv the child actually receives is
// the intended value -- with no injected command executing. On non-win32 there
// is no cmd.exe, so this collapses to the string-level assertions above; the
// win32 spawn is what proves the string-level expectations are the RIGHT ones.
describe("escapeCmdArg / buildLaunchEntry -- spawn-through-shim (win32 only)", () => {
  const runWin = process.platform === "win32";
  // Every test here spawns real `cmd /c` children -- the point of the block is
  // that only a genuine spawn proves the escaping. A Windows process spawn is
  // tens of ms idle but runs into seconds when the parallel suite has the CPU
  // oversubscribed (the full run packs 406 s of test time into 87 s of wall
  // clock), and the 11-spawn case below blew the 30 s global testTimeout on a
  // release run while passing in 6 s standalone. These budgets are sized for
  // spawn-under-contention; they are not a hint that the work is slow.
  const WIN_SPAWN_TIMEOUT_MS = 180_000;
  const tmp = runWin ? mkdtempSync(join(tmpdir(), "yaw-cmdesc-")) : "";
  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  // echo-argv.js prints the argv it received, framed so we can tell it apart
  // from anything an injection ran. Written via fs (not a bash heredoc) so
  // backslashes survive verbatim on this box.
  function setupFixtures(): { echo: string; env: NodeJS.ProcessEnv } {
    const echo = join(tmp, "echo-argv.js");
    writeFileSync(echo, 'process.stdout.write("<<<A>>>"+JSON.stringify(process.argv.slice(2))+"<<<Z>>>\\n");\n');
    // A shim that forwards its args through %*, standing in for npx.cmd.
    writeFileSync(join(tmp, "myshim.cmd"), `@echo off\r\nnode "${echo}" %*\r\n`);
    const env = { ...process.env, PATH: `${tmp};${process.env.PATH ?? ""}` };
    return { echo, env };
  }

  function argvFrom(stdout: string): string[] | null {
    const m = stdout.match(/<<<A>>>([\s\S]*?)<<<Z>>>/);
    return m ? (JSON.parse(m[1]) as string[]) : null;
  }

  // Spawn `cmd /c myshim <stored...>` -- shim resolves off PATH like npx does.
  function deliverViaShim(stored: string[], env: NodeJS.ProcessEnv): string[] | null {
    const r = spawnSync("cmd", ["/c", "myshim", ...stored], { cwd: tmp, encoding: "utf8", env });
    return argvFrom(r.stdout);
  }

  // Spawn `cmd /c node echo.js <stored...>` -- node.exe is a real exe (direct).
  function deliverViaDirect(stored: string[], echo: string): string[] | null {
    const r = spawnSync("cmd", ["/c", "node", echo, ...stored], { cwd: tmp, encoding: "utf8" });
    return argvFrom(r.stdout);
  }

  it.runIf(runWin)(
    "SHIM path delivers every escaped arg intact through the %* re-parse",
    () => {
      const { env } = setupFixtures();
      const intended = [
        "hello",
        "https://api/x?a=1&b=2", // the reproduced truncation payload
        "a|b",
        "a<b>c",
        "x^y",
        "(group)",
        "a&b|c",
        "C:\\a&b\\dir\\", // metachar + trailing backslash
        "foo & bar", // space -> libuv quotes it
        '{"a":1}', // quote, no metachar -> verbatim
        '{"a": "b c"}', // quote + space, no metachar
      ];
      for (const A of intended) {
        const stored = escapeCmdArg(A, { shim: true });
        expect(deliverViaShim([stored], env), `intended=${A} stored=${stored}`).toEqual([A]);
      }
    },
    WIN_SPAWN_TIMEOUT_MS,
  );

  it.runIf(runWin)(
    "DIRECT path delivers every escaped arg intact (single cmd parse)",
    () => {
      const { echo } = setupFixtures();
      const intended = ["hello", "https://api/x?a=1&b=2", "a|b", "x^y", "(group)", "foo & bar", '{"a":1}'];
      for (const A of intended) {
        const stored = escapeCmdArg(A, { shim: false });
        expect(deliverViaDirect([stored], echo), `intended=${A} stored=${stored}`).toEqual([A]);
      }
    },
    WIN_SPAWN_TIMEOUT_MS,
  );

  it.runIf(runWin)(
    "a full buildLaunchEntry shim entry delivers all args intact",
    () => {
      const { env } = setupFixtures();
      // Build the real entry, then swap the shim command name so it resolves to
      // our %*-forwarding fixture instead of the real npx.
      const entry = buildLaunchEntry({
        os: "windows",
        upstream: { command: "npx", args: ["-y", "@demo/mcp", "--url", "https://api/x?a=1&b=2", "--flag", "a|b"] },
      });
      expect(entry.command).toBe("cmd");
      // entry.args = ["/c", "npx", ...escaped]; replace "npx" with "myshim".
      const stored = entry.args.slice(2);
      expect(deliverViaShim(stored, env)).toEqual([
        "-y",
        "@demo/mcp",
        "--url",
        "https://api/x?a=1&b=2",
        "--flag",
        "a|b",
      ]);
    },
    WIN_SPAWN_TIMEOUT_MS,
  );

  it.runIf(runWin)(
    "the reproduced payload does NOT execute the injected command (shim)",
    () => {
      const { env } = setupFixtures();
      // No-space metachar payload -> exercises the CARET path (the one bug #1
      // fixed), not the libuv-quote path. `x&cd>PWNED.txt` WOULD create the file
      // if the `&` split the line (verified: unescaped it does). Triple-caret
      // neutralizes it so the whole thing arrives as one literal argv element.
      rmSync(join(tmp, "PWNED.txt"), { force: true });
      const stored = escapeCmdArg("x&cd>PWNED.txt", { shim: true });
      expect(deliverViaShim([stored], env)).toEqual(["x&cd>PWNED.txt"]);
      const exists = spawnSync("cmd", ["/c", "if", "exist", "PWNED.txt", "echo", "YES"], {
        cwd: tmp,
        encoding: "utf8",
      }).stdout;
      expect(exists).not.toContain("YES");
    },
    WIN_SPAWN_TIMEOUT_MS,
  );

  it.runIf(runWin)(
    "a bare & would inject WITHOUT escaping -- the fixture proves the harness bites",
    () => {
      // Control: the UNescaped payload truncates at `&` through the shim, proving
      // the shim path really does re-parse (so the pass above is meaningful).
      const { env } = setupFixtures();
      expect(deliverViaShim(["https://api/x?a=1&b=2"], env)).toEqual(["https://api/x?a=1"]);
      // And the OLD single-caret form is likewise a no-op against the shim.
      expect(deliverViaShim(["https://api/x?a=1^&b=2"], env)).toEqual(["https://api/x?a=1"]);
    },
    WIN_SPAWN_TIMEOUT_MS,
  );
});

describe("claudeCodeProjectKey (projects[] key spelling)", () => {
  // Claude Code writes projects[] keys with forward slashes on every OS.
  // Writing resolve()'s backslash spelling verbatim created a NEW sibling
  // key Claude Code never reads: install printed Done, doctor/--list said
  // "installed" (same wrong key), and /mcp showed nothing.
  it("normalizes a Windows drive-letter path to forward slashes", () => {
    expect(claudeCodeProjectKey("C:\\Users\\me\\repo")).toBe("C:/Users/me/repo");
  });

  it("leaves an already forward-slash Windows path untouched", () => {
    expect(claudeCodeProjectKey("C:/Users/me/repo")).toBe("C:/Users/me/repo");
  });

  it("normalizes a UNC path", () => {
    expect(claudeCodeProjectKey("\\\\server\\share\\repo")).toBe("//server/share/repo");
  });

  it("leaves POSIX paths untouched, even ones containing a backslash in a name", () => {
    expect(claudeCodeProjectKey("/home/alice/repo")).toBe("/home/alice/repo");
    // Scoped to Windows-shaped paths: a legal (if cursed) POSIX dir name
    // containing a backslash must not be mangled.
    expect(claudeCodeProjectKey("/home/alice/weird\\name")).toBe("/home/alice/weird\\name");
  });
});

describe("isProjectLocalEntry", () => {
  // resolveStableNpmEntry calls a project node_modules "durable" too, and
  // install persists it into a machine-global config -- so install warns. Pure
  // string work on both separators, so POSIX literals are safe on a Windows
  // runner (nothing here routes through path.join).
  it("flags a node_modules under the tree cwd sits in", () => {
    expect(isProjectLocalEntry("/home/j/repo/node_modules/@yawlabs/mcp/dist/index.js", "/home/j/repo")).toBe(true);
    // Invoked from a subdirectory: still the same project tree.
    expect(isProjectLocalEntry("/home/j/repo/node_modules/@yawlabs/mcp/dist/index.js", "/home/j/repo/src/deep")).toBe(
      true,
    );
    // Trailing separator on cwd must not defeat the prefix compare.
    expect(isProjectLocalEntry("/home/j/repo/node_modules/@yawlabs/mcp/dist/index.js", "/home/j/repo/")).toBe(true);
  });

  it("does not flag a global install", () => {
    // The layouts that must stay quiet -- a false positive here would nag on
    // every correct global install, which is the recommended setup.
    for (const entry of [
      "/usr/local/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/opt/homebrew/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/home/j/.nvm/versions/node/v22.3.0/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "C:\\Users\\j\\AppData\\Roaming\\npm\\node_modules\\@yawlabs\\mcp\\dist\\index.js",
    ]) {
      expect(isProjectLocalEntry(entry, "/home/j/repo")).toBe(false);
    }
    // A sibling checkout is not this one.
    expect(isProjectLocalEntry("/home/j/other/node_modules/@yawlabs/mcp/dist/index.js", "/home/j/repo")).toBe(false);
    // The reason the containment test only runs one way: an nvm/volta prefix
    // under HOME is "inside cwd" whenever install is run from the home dir.
    expect(
      isProjectLocalEntry("/home/j/.nvm/versions/node/v22.3.0/lib/node_modules/@yawlabs/mcp/dist/index.js", "/home/j"),
    ).toBe(false);
    // Prefix-but-not-path-segment: /home/j/repo2 is not inside /home/j/repo.
    expect(isProjectLocalEntry("/home/j/repo/node_modules/@yawlabs/mcp/dist/index.js", "/home/j/repo2")).toBe(false);
  });

  it("handles Windows separators and drive-letter case", () => {
    // process.cwd() and a resolved module path can disagree on drive-letter
    // case on Windows; a case-sensitive compare would silently never warn.
    expect(
      isProjectLocalEntry("C:\\Users\\j\\repo\\node_modules\\@yawlabs\\mcp\\dist\\index.js", "c:\\users\\j\\repo"),
    ).toBe(true);
    expect(isProjectLocalEntry("C:/Users/j/repo/node_modules/@yawlabs/mcp/dist/index.js", "C:\\Users\\j\\repo")).toBe(
      true,
    );
  });

  it("returns false for paths with no node_modules segment", () => {
    expect(isProjectLocalEntry("/home/j/repo/dist/index.js", "/home/j/repo")).toBe(false);
    expect(isProjectLocalEntry("", "/home/j/repo")).toBe(false);
    // A node_modules at the filesystem root owns no project tree.
    expect(isProjectLocalEntry("/node_modules/@yawlabs/mcp/dist/index.js", "/")).toBe(false);
  });

  it("attributes a transitively-nested copy to the outer project tree", () => {
    // Anchoring on the innermost node_modules would compute a root of
    // <repo>/node_modules/x, which cwd is never inside -- so the warning would
    // silently never fire for a nested copy.
    expect(
      isProjectLocalEntry("/home/j/repo/node_modules/x/node_modules/@yawlabs/mcp/dist/index.js", "/home/j/repo"),
    ).toBe(true);
  });
});

describe("ENTRY_NAME", () => {
  it("is the stable key the installer writes under mcpServers / servers", () => {
    // Doctor depends on this constant to detect an existing install.
    expect(ENTRY_NAME).toBe("mcp");
  });
});
