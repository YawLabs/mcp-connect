import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRY_RUN_ENV_PLACEHOLDER,
  INSTALL_USAGE,
  mergeClientConfig,
  mergePermissionsAllow,
  NO_CONFIG_FLAG_DEPRECATION,
  parseInstallArgs,
  readEntryAt,
  runInstall,
  TOKEN_FLAG_DEPRECATION,
} from "../install-cmd.js";
import { CLAUDE_CODE_ALLOW_PATTERN, CURRENT_OS, ENTRY_NAME } from "../install-targets.js";
import { parseJsonc } from "../jsonc.js";
import { MIN_OAM_VERSION, OAM_INSTALL_PS1, OAM_INSTALL_SH, type OamProbe, oamNoBinaryReason } from "../oam-spawn.js";

/** Seam INSIDE install's settings.json read->write window. runInstall reads
 *  settings.json AFTER the oam probe and the collision prompt, so the
 *  `oamProbe` seam the client-config race tests use lands before that read
 *  (a write there is simply merged onto). The one awaited step between the
 *  read and the settings patch is the client-config publish, and this hook
 *  runs ahead of every atomicWriteFile so a test can land a write exactly
 *  there. Pass-through for every other test: the hook is null, and the real
 *  write always follows. `vi.hoisted` so the object exists before the hoisted
 *  mock factory closes over it; afterEach resets it. */
const atomicWriteSeam = vi.hoisted(() => ({ beforeWrite: null as null | ((path: string) => void) }));
vi.mock("../atomic-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../atomic-write.js")>();
  return {
    ...actual,
    atomicWriteFile: async (...args: Parameters<typeof actual.atomicWriteFile>): Promise<void> => {
      atomicWriteSeam.beforeWrite?.(args[0]);
      return actual.atomicWriteFile(...args);
    },
  };
});

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-install-home-"));
  synthCwd = mkdtempSync(join(tmpdir(), "yaw-mcp-install-cwd-"));
});

afterEach(() => {
  atomicWriteSeam.beforeWrite = null;
  rmSync(synthHome, { recursive: true, force: true });
  rmSync(synthCwd, { recursive: true, force: true });
});

/** The projects[] key install writes for a project dir: Claude Code spells
 *  those keys with forward slashes on every OS, so a host-native fixture path
 *  (backslashes on a Windows runner) must be normalized before indexing into
 *  the written JSON. No-op on POSIX. */
const projectsKey = (dir: string): string => dir.replace(/\\/g, "/");

/** One of `--all`'s per-client header lines (`-- cursor (user) --`).
 *
 *  ASCII, and pinned as ASCII: install renders the separator with `--` today
 *  (install-cmd.ts, the per-plan header in runInstallAll), for the same
 *  Windows-console mojibake reason the sibling module it prints beside
 *  documents at oam-spawn.ts:285-287 -- a box-drawing `──` written to a
 *  console whose active codepage is not UTF-8 comes back as `ΓÇö`-class
 *  garbage. Accepting BOTH spellings pinned neither, so reverting the code to
 *  box-drawing kept the suite green. Matching the LINE shape (rather than the
 *  separator token) is also what makes a header COUNT meaningful: counting
 *  bare separator tokens double-counts, since every header carries two. */
const CLIENT_HEADER_LINE = /^-- \S+ \(\w+\) --$/;

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

  it("--help returns ok:true with helpRequested so dispatcher routes to stdout+exit0", () => {
    // Parser shape changed: --help is now a SUCCESSFUL parse carrying
    // helpRequested in options (was ok:false + help:true, a spelling whose
    // `help` field is gone from the failure type entirely -- nothing set it
    // and nothing read it). The dispatcher in index.ts checks
    // `parsed.ok && parsed.options.helpRequested` and prints USAGE to
    // stdout + exit 0.
    const r = parseInstallArgs(["--help"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.helpRequested).toBe(true);
  });

  it("-h returns ok:true with helpRequested", () => {
    const r = parseInstallArgs(["-h"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.helpRequested).toBe(true);
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

  it("parses --token, --os, --project-dir, --force, --dry-run, --no-yaw-mcp-config", () => {
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
      "--no-yaw-mcp-config",
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.token).toBe("mcp_pat_abc");
      expect(r.options.os).toBe("linux");
      expect(r.options.projectDir).toBe("/tmp/repo");
      expect(r.options.force).toBe(true);
      expect(r.options.dryRun).toBe(true);
      expect(r.options.skipYawMcpConfig).toBe(true);
    }
  });

  it("parses --skip", () => {
    // Passed ALONE, never beside --force: the accepting `case "--skip"` branch
    // had no positive test at all (the combined case above names the flag in
    // its title but never in its argv), and pinning it next to --force would
    // pin a pair the install path refuses.
    const r = parseInstallArgs(["claude-code", "--skip"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.skip).toBe(true);
  });

  it("rejects unknown flags", () => {
    const r = parseInstallArgs(["claude-code", "--bogus"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --token that swallows a following flag as its value", () => {
    // `--token --force` must not set token="--force"; the free-form flag
    // guards mirror the enum-flag allow-list rejection.
    const r = parseInstallArgs(["claude-code", "--token", "--force"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--token requires a value");
  });

  it("rejects --project-dir that swallows a following flag as its value", () => {
    const r = parseInstallArgs(["claude-code", "--project-dir", "--dry-run"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--project-dir requires a value");
  });

  it("rejects a SINGLE-dash flag swallowed as a value, not just a double-dash one", () => {
    // The guard tested `startsWith("--")`, so `install --token -h` set
    // token="-h": the user got the deprecation warning for a flag they were
    // trying to read the help for, and never got the help. `-h` is the one
    // single-dash flag this parser accepts, which is exactly why it is the
    // one that got eaten.
    const token = parseInstallArgs(["claude-code", "--token", "-h"]);
    expect(token.ok).toBe(false);
    if (!token.ok) expect(token.error).toContain("--token requires a value");

    const projectDir = parseInstallArgs(["claude-code", "--project-dir", "-h"]);
    expect(projectDir.ok).toBe(false);
    if (!projectDir.ok) expect(projectDir.error).toContain("--project-dir requires a value");
  });

  it("still accepts values that merely contain a dash", () => {
    // The guard is about a LEADING dash. A token or a path with one inside it
    // (`mcp_pat_a-b`, `/repos/my-project`) is an ordinary value.
    const r = parseInstallArgs(["claude-code", "--token", "mcp_pat_a-b", "--project-dir", "my-project"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.token).toBe("mcp_pat_a-b");
      expect(r.options.projectDir).toBe("my-project");
    }
  });

  it("rejects more than one positional", () => {
    const r = parseInstallArgs(["claude-code", "cursor"]);
    expect(r.ok).toBe(false);
  });

  // `--os` is a preview knob, not a cross-OS writer: resolveInstallPath
  // builds `absolute` from THIS machine's home/APPDATA/separators, so a real
  // cross-OS run would mkdir a host-shaped junk tree and report Done.
  describe("cross-OS --os gate", () => {
    const otherOs = CURRENT_OS === "windows" ? "macos" : "windows";

    it("refuses a cross-OS --os without --dry-run", () => {
      const r = parseInstallArgs(["claude-code", "--os", otherOs]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain(`--os ${otherOs}`);
        expect(r.error).toContain("--dry-run");
      }
    });

    it("allows a cross-OS --os with --dry-run (preview only)", () => {
      const r = parseInstallArgs(["claude-code", "--os", otherOs, "--dry-run"]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.options.os).toBe(otherOs);
    });

    it("allows a cross-OS --os with --list (read-only)", () => {
      const r = parseInstallArgs(["--list", "--os", otherOs]);
      expect(r.ok).toBe(true);
    });

    it("allows --os naming the current machine without --dry-run", () => {
      const r = parseInstallArgs(["claude-code", "--os", CURRENT_OS]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.options.os).toBe(CURRENT_OS);
    });
  });
});

describe("mergeClientConfig", () => {
  it("preserves other servers in mcpServers", () => {
    const existing = { mcpServers: { other: { command: "x" } } };
    const merged = mergeClientConfig(existing, ["mcpServers"], { command: "npx", args: ["-y", "@yawlabs/mcp"] });
    expect(merged.mcpServers).toEqual({
      other: { command: "x" },
      [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp"] },
    });
  });

  it("preserves sibling top-level keys (e.g., model, hooks)", () => {
    const existing = { model: "claude-opus-4-7", mcpServers: {} };
    const merged = mergeClientConfig(existing, ["mcpServers"], { command: "npx", args: ["-y", "@yawlabs/mcp"] });
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
      args: ["-y", "@yawlabs/mcp"],
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
      args: ["-y", "@yawlabs/mcp"],
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

  it("never strips a pre-rename legacy pattern, whichever brand spelled it", () => {
    // This used to strip mcp__mcp_hosting__* / mcp__mcph__* / mcp__yaw_mcp__*
    // unless the caller vouched for them. But the settings.json this feeds is
    // GLOBAL at user scope and a run only ever sees the ONE container it is
    // writing, so a legacy `yaw-mcp` entry still wired in a repo's .mcp.json
    // (or another project's local scope) had its live grant revoked and Claude
    // Code re-prompted on every tool call. Three dead wildcards are harmless;
    // the strip is gone, and so is the `retain` escape hatch it needed.
    const existing = {
      permissions: { allow: ["mcp__mcp_hosting__*", "mcp__mcph__*", "mcp__yaw_mcp__*", "Read"] },
    };
    const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
    const allow = (merged.permissions as { allow: string[] }).allow;
    expect(allow).toEqual([
      "mcp__mcp_hosting__*",
      "mcp__mcph__*",
      "mcp__yaw_mcp__*",
      "Read",
      CLAUDE_CODE_ALLOW_PATTERN,
    ]);
  });

  it("REPLACES a non-array permissions.allow rather than preserving it", () => {
    // The one place this function does not keep what it found: `allow` is only
    // read through Array.isArray, so a hand-edited string (or object, or null)
    // is dropped for a fresh array carrying just our pattern -- which reads as
    // a contradiction of the preserve-everything promise in its own doc
    // comment. Pinned rather than argued: a client that ever accepts a
    // non-array `allow` would make this silent data loss, and the pin is what
    // fails when that day arrives. Sibling keys are still preserved, so the
    // loss is scoped to the key this function manages.
    const existing = { permissions: { allow: "Bash(git *)", deny: ["Bash(rm -rf *)"] } };
    const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
    const perms = merged.permissions as { allow: unknown[]; deny: string[] };
    expect(perms.allow).toEqual([CLAUDE_CODE_ALLOW_PATTERN]);
    expect(perms.deny).toEqual(["Bash(rm -rf *)"]);
  });
});

/** Deterministic oam seams. `runInstall` probes the real machine by default,
 *  so a maintainer with oam + a global @yawlabs/mcp would get an oam entry
 *  where CI gets npx -- these pin the world each test means to assert.
 *
 *  Annotated `Promise<OamProbe>` deliberately: a fixture built from an
 *  un-annotated object literal drifts silently when the probe gains a field,
 *  and `binPath` is exactly the field whose absence let a bare-name entry ship. */
const OAM_ABSENT = async (): Promise<OamProbe> => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: null,
  failureDetail: null,
});
// Derived from the constant, not pinned: MIN_OAM_VERSION tracks the latest oam
// release and so moves every release. A hardcoded version here would silently
// become a below-min build that the fixture still claims is usable.
const OAM_PRESENT = async (): Promise<OamProbe> => ({
  bin: "/usr/local/bin/oam",
  binPath: "/usr/local/bin/oam",
  version: MIN_OAM_VERSION,
  belowMin: false,
  failure: null,
  failureDetail: null,
});
/** The shape the REAL probe returns without OAM_BIN: a bare spawnable name,
 *  resolved to an absolute path against PATH x PATHEXT. Every fixture used to
 *  pass an absolute `bin`, which is why the bare-name entry shipped untested. */
const OAM_BARE_RESOLVED = async (): Promise<OamProbe> => ({
  bin: "oam",
  binPath: "/home/j/.oam/bin/oam",
  version: MIN_OAM_VERSION,
  belowMin: false,
  failure: null,
  failureDetail: null,
});
/** Bare name that PATH could not locate as a file (a shell function, an alias,
 *  a sanitized child env). Usable here, not persistable anywhere. */
const OAM_BARE_UNRESOLVED = async (): Promise<OamProbe> => ({
  bin: "oam",
  binPath: null,
  version: MIN_OAM_VERSION,
  belowMin: false,
  failure: null,
  failureDetail: null,
});
/** A binPath that PATH resolved to a RELATIVE hit. resolveBinAbsolute joins the
 *  bin onto each PATH dir in turn, so a PATH carrying `.` or `node_modules/.bin`
 *  yields a relative path -- which buildLaunchEntry rejects (isAbsolute gate)
 *  while the probe still reports it as found. */
const OAM_RELATIVE_BINPATH = async (): Promise<OamProbe> => ({
  bin: "oam",
  binPath: "node_modules/.bin/oam",
  version: MIN_OAM_VERSION,
  belowMin: false,
  failure: null,
  failureDetail: null,
});
// Safe to hardcode below-min, unlike the usable fixtures above: MIN_OAM_VERSION
// only ever moves forward, so a version below today's floor stays below it.
const OAM_BELOW_MIN = async (): Promise<OamProbe> => ({
  bin: null,
  binPath: null,
  version: "0.8.2",
  belowMin: true,
  failure: null,
  failureDetail: null,
});
/** Present on disk but unusable -- distinct from absent, which is why the probe
 *  carries `failure` at all. */
const OAM_BROKEN = async (): Promise<OamProbe> => ({
  bin: null,
  binPath: null,
  version: null,
  belowMin: false,
  failure: "timeout",
  failureDetail: "oam --version timed out after 3000ms",
});
const OAM_ENTRY = "/opt/nm/@yawlabs/mcp/dist/index.js";
/** A probe that must never run. The refusal tests below reach their exit
 *  BEFORE runInstall probes oam, so they are hermetic by ORDERING alone --
 *  reorder the probe above the refusal and those runs would spawn a real
 *  `oam --version` against the host. Throwing turns that silent drift into a
 *  failing test, and pins the contract the probe's own placement comment
 *  states: a refused run never claims a runtime. */
const OAM_PROBE_FORBIDDEN = (): never => {
  throw new Error("refusal path must not probe oam");
};

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
      io: cap.io,
      oamProbe: OAM_ABSENT,
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
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    // settings.json not listed as written because no change was needed.
    expect(r.written).not.toContain(join(settingsDir, "settings.json"));
    // Contents untouched.
    expect(readFileSync(join(settingsDir, "settings.json"), "utf8")).toBe(initial);
  });

  it("warns (not silent) when settings.json is malformed and cannot be patched", async () => {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const malformed = "{ this is not json";
    writeFileSync(join(settingsDir, "settings.json"), malformed);

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    // Settings patch is best-effort, so the install itself still succeeds.
    expect(r.exitCode).toBe(0);
    // But the malformed file is surfaced, not silently skipped -- and the
    // warning names the file + the by-hand fix.
    expect(cap.stderr()).toMatch(/could not patch/);
    expect(cap.stderr()).toMatch(/settings\.json/);
    expect(cap.stderr()).toContain(CLAUDE_CODE_ALLOW_PATTERN);
    // The malformed file is left untouched.
    expect(readFileSync(join(settingsDir, "settings.json"), "utf8")).toBe(malformed);
    // settings.json is not in the written list (no patch applied).
    expect(r.written).not.toContain(join(settingsDir, "settings.json"));
  });

  // Distinct from the malformed (unparseable-bytes) case above: this file
  // parses cleanly as JSON but is NOT a plain object (array or null). The
  // parse succeeds, so the catch branch never fires; instead the non-object
  // branch returns malformedReason "not a JSON object". runInstall must still
  // warn ("could not patch" + "(not a JSON object)") and skip the patch
  // rather than throw or silently no-op.
  it.each([
    ["array", "[]"],
    ["null", "null"],
  ])("warns and skips the patch when settings.json is valid JSON but not an object (%s)", async (_label, contents) => {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "settings.json"), contents);

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    // Settings patch is best-effort, so the install itself still succeeds
    // (no throw, exit 0).
    expect(r.exitCode).toBe(0);
    // The skip is surfaced, not silent -- warning names the by-hand fix and
    // the specific reason for THIS branch ("not a JSON object"), which
    // distinguishes it from the unparseable-bytes malformed case.
    expect(cap.stderr()).toMatch(/could not patch/);
    expect(cap.stderr()).toContain("(not a JSON object)");
    expect(cap.stderr()).toMatch(/settings\.json/);
    expect(cap.stderr()).toContain(CLAUDE_CODE_ALLOW_PATTERN);
    // The non-object file is left byte-for-byte untouched.
    expect(readFileSync(join(settingsDir, "settings.json"), "utf8")).toBe(contents);
    // settings.json is not in the written list (no patch applied).
    expect(r.written).not.toContain(join(settingsDir, "settings.json"));
  });

  // The THIRD malformed branch, and the one neither case above reaches: the
  // file parses AND is an object, so the patch is computed and attempted --
  // and `editJsoncEntry` throws because `permissions` itself is not an object
  // to hang an `allow` key off ("Can not add index to parent of type array").
  // That throw is caught and reported as malformed with jsonc-parser's own
  // message, so the same "could not patch" warning covers a shape the earlier
  // branches never see.
  it.each([
    ["an array", '{ "permissions": [] }'],
    ["a number", '{ "permissions": 7 }'],
  ])("warns and skips the patch when settings.json `permissions` is %s", async (_label, contents) => {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "settings.json"), contents);

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    // Best-effort patch: the launch entry still lands and the run exits 0.
    expect(r.exitCode).toBe(0);
    expect(r.written).toContain(join(synthHome, ".claude.json"));
    // The skip is surfaced, naming the file and the by-hand fix.
    expect(cap.stderr()).toMatch(/could not patch/);
    expect(cap.stderr()).toMatch(/settings\.json/);
    expect(cap.stderr()).toContain(CLAUDE_CODE_ALLOW_PATTERN);
    // Left byte-for-byte alone rather than rewritten into a valid shape.
    expect(readFileSync(join(settingsDir, "settings.json"), "utf8")).toBe(contents);
    expect(r.written).not.toContain(join(settingsDir, "settings.json"));
  });

  it("does not touch settings.json for non-claude-code clients", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "cursor",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(synthHome, ".claude", "settings.json"))).toBe(false);
  });
});

describe("runInstall — happy path (claude-code, user scope, fresh install)", () => {
  it("writes client config and patches settings.json permissions, and never touches ~/.yaw-mcp/config.json", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    // Two files touched: ~/.claude.json (mcpServers) and ~/.claude/settings.json
    // (permissions.allow so the client stops prompting). ~/.yaw-mcp/config.json
    // used to be a third -- it carried the account token, which is gone.
    expect(r.written.length).toBe(2);

    const clientPath = join(synthHome, ".claude.json");
    const settingsPath = join(synthHome, ".claude", "settings.json");
    expect(existsSync(clientPath)).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);
    expect(existsSync(join(synthHome, ".yaw-mcp", "config.json"))).toBe(false);

    const client = JSON.parse(readFileSync(clientPath, "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["-y", "@yawlabs/mcp@latest"]);
    expect(client.mcpServers[ENTRY_NAME].env).toBeUndefined();

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.permissions.allow).toContain(CLAUDE_CODE_ALLOW_PATTERN);
  });

  it("warns when a legacy `mcp.hosting` entry is present in the client config", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "mcp.hosting": { command: "npx", args: ["-y", "@yawlabs/mcp"] } } }),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toMatch(/legacy "mcp\.hosting" entry remains/);
    expect(cap.stdout()).toMatch(/running yaw-mcp twice/);
    // New entry written without removing the legacy one (commit chose no auto-migration).
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME]).toBeDefined();
    expect(client.mcpServers["mcp.hosting"]).toBeDefined();
  });

  it("--dry-run with a legacy entry says `would remain`, not `remains`", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "mcp.hosting": { command: "npx" } } }),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toMatch(/legacy "mcp\.hosting" entry .* would remain/);
    // File is untouched on dry-run.
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME]).toBeUndefined();
  });

  it("--skip on existing yaw-mcp entry does not log the legacy hint", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          [ENTRY_NAME]: { command: "npx" },
          "mcp.hosting": { command: "npx" },
        },
      }),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      skip: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).not.toMatch(/legacy "mcp\.hosting"/);
  });
});

describe("runInstall — claudeConfigDir override (CLAUDE_CONFIG_DIR wrapper)", () => {
  // Locks the v0.47.2 fix: when Claude Code runs under a wrapper that
  // sets CLAUDE_CONFIG_DIR, BOTH the mcpServers config AND the
  // permissions.allow patch must follow the redirect. Otherwise the
  // user sees a "successful" install but `claude mcp list` shows nothing.

  it("writes .claude.json + settings.json into the wrapper dir, not home", async () => {
    const wrapperDir = mkdtempSync(join(tmpdir(), "yaw-mcp-wrapper-"));
    try {
      const cap = captureIo();
      const r = await runInstall({
        clientId: "claude-code",
        scope: "user",
        os: "linux",
        home: synthHome,
        claudeConfigDir: wrapperDir,
        io: cap.io,
        // Pins the npx assertion below. Without the seam this calls the real
        // probeOam (a live `oam --version` spawn) plus the real
        // resolveStableNpmEntry, so the entry depends on the machine: it passes
        // from a repo checkout only because there is no node_modules segment in
        // import.meta.url, and fails from an installed copy on a box with oam.
        oamProbe: OAM_ABSENT,
      });
      expect(r.exitCode).toBe(0);

      // The two claude-code files land in the wrapper dir.
      const wrapperClient = join(wrapperDir, ".claude.json");
      const wrapperSettings = join(wrapperDir, "settings.json");
      expect(existsSync(wrapperClient)).toBe(true);
      expect(existsSync(wrapperSettings)).toBe(true);
      const client = JSON.parse(readFileSync(wrapperClient, "utf8"));
      expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
      const settings = JSON.parse(readFileSync(wrapperSettings, "utf8"));
      expect(settings.permissions.allow).toContain(CLAUDE_CODE_ALLOW_PATTERN);

      // Crucially, the home-based defaults are NOT created — that was
      // the original bug (entry written, but to a file Claude Code
      // doesn't read under the wrapper).
      expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
      expect(existsSync(join(synthHome, ".claude", "settings.json"))).toBe(false);

      // ~/.yaw-mcp/config.json is never written any more, in the wrapper
      // dir or in home.
      expect(existsSync(join(synthHome, ".yaw-mcp", "config.json"))).toBe(false);
      expect(existsSync(join(wrapperDir, "config.json"))).toBe(false);
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });

  it("local scope under wrapper writes to <wrapperDir>/.claude.json projects[<dir>].mcpServers", async () => {
    const wrapperDir = mkdtempSync(join(tmpdir(), "yaw-mcp-wrapper-local-"));
    try {
      const cap = captureIo();
      const r = await runInstall({
        clientId: "claude-code",
        scope: "local",
        os: "linux",
        home: synthHome,
        projectDir: synthCwd,
        claudeConfigDir: wrapperDir,
        io: cap.io,
        oamProbe: OAM_ABSENT,
      });
      expect(r.exitCode).toBe(0);

      const wrapperClient = join(wrapperDir, ".claude.json");
      expect(existsSync(wrapperClient)).toBe(true);
      const client = JSON.parse(readFileSync(wrapperClient, "utf8"));
      // Nested under projects[<absDir>].mcpServers — locks the local-scope
      // shape against accidental flattening when redirecting. Keyed by the
      // forward-slash spelling Claude Code writes, even on a Windows runner.
      expect(client.projects[projectsKey(synthCwd)].mcpServers[ENTRY_NAME].command).toBe("npx");
      // The host-native backslash spelling must NOT exist as a sibling key —
      // that was the Windows bug: install wrote resolve()'s spelling verbatim,
      // creating a projects[] entry Claude Code never reads while doctor and
      // --list (computing the same wrong key) reported "installed".
      if (synthCwd !== projectsKey(synthCwd)) {
        expect(client.projects[synthCwd]).toBeUndefined();
      }

      // The local-scope permissions file, written by this run as a side effect
      // and asserted nowhere until now. It lands beside the PROJECT, not in the
      // wrapper dir: resolveClaudeCodeSettingsPath sends local scope to
      // <projectDir>/.claude/settings.local.json, which CLAUDE_CONFIG_DIR does
      // not redirect (only user scope moves).
      const localSettings = join(synthCwd, ".claude", "settings.local.json");
      expect(existsSync(localSettings)).toBe(true);
      expect(r.written).toContain(localSettings);
      const localJson = JSON.parse(readFileSync(localSettings, "utf8"));
      expect(localJson.permissions.allow).toContain(CLAUDE_CODE_ALLOW_PATTERN);
      // ...and the user-scope settings file is NOT the one that got patched.
      expect(existsSync(join(wrapperDir, "settings.json"))).toBe(false);

      // Home version not created.
      expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });

  it("empty claudeConfigDir falls back to home (treated as unset)", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      claudeConfigDir: "",
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(true);
    expect(existsSync(join(synthHome, ".claude", "settings.json"))).toBe(true);
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
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("cmd");
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["/c", "npx", "-y", "@yawlabs/mcp@latest"]);
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
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthCwd, ".vscode", "mcp.json"), "utf8"));
    expect(client.mcpServers).toBeUndefined();
    expect(client.servers[ENTRY_NAME]).toBeDefined();
  });
});

describe("runInstall — preserves existing entries", () => {
  it("does not clobber unrelated mcpServers when adding yaw-mcp", async () => {
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
      io: cap.io,
      oamProbe: OAM_ABSENT,
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
      io: { ...cap.io, isTTY: false },
      oamProbe: OAM_ABSENT,
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
      force: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
  });

  it("--dry-run on a collision says `Would overwrite`, not `Overwriting`", async () => {
    // dryRun maps onto decision="overwrite" so the collision path is exercised,
    // but the run returns before any write. The present-tense line told a user
    // scanning the transcript that their preview had already mutated the file.
    const initial = JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2);
    writeFileSync(join(synthHome, ".claude.json"), initial);
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toContain(`Would overwrite existing "${ENTRY_NAME}" entry.`);
    expect(cap.stdout()).not.toContain(`Overwriting existing "${ENTRY_NAME}" entry.`);
    expect(r.written).toEqual([]);
    // And the claim is true: the file is byte-identical.
    expect(readFileSync(join(synthHome, ".claude.json"), "utf8")).toBe(initial);
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
      skip: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME]).toEqual({ command: "old" });
    // install never writes ~/.yaw-mcp/config.json on ANY path -- the token it
    // carried is gone -- so this is a standing regression guard, not a
    // consequence of the --skip short-circuit the test is about.
    expect(existsSync(join(synthHome, ".yaw-mcp", "config.json"))).toBe(false);
  });

  it("--skip --dry-run previews the SKIP, not an overwrite", async () => {
    // dryRun used to win the decision ladder, so `--skip --dry-run`
    // previewed "Would overwrite" -- a preview contradicting the real
    // `--skip` run it claims to preview (which leaves the entry alone).
    const initial = JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2);
    writeFileSync(join(synthHome, ".claude.json"), initial);
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      skip: true,
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toContain("Would leave existing");
    expect(cap.stdout()).not.toContain("Would overwrite");
    expect(r.written).toEqual([]);
    expect(r.wouldWrite).toEqual([]);
    expect(readFileSync(join(synthHome, ".claude.json"), "utf8")).toBe(initial);
  });

  it("a malformed env on the existing entry is NOT carried into the overwrite", async () => {
    // The user chose --force precisely to replace a broken entry; carrying
    // `"env": "abc"` (whose Object.keys are 0,1,2) into the fresh entry
    // re-broke the file the overwrite was meant to fix.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old", env: "abc" } } }, null, 2),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      force: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).not.toContain("Kept existing env");
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].env).toBeUndefined();
  });

  it("a MIXED env carries its valid string keys and drops only the malformed ones", async () => {
    // All-or-nothing validation silently dropped OAM_BIN -- the carry-over
    // comment's own load-bearing example -- whenever one sibling value was
    // non-string. Filter per key instead.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify(
        { mcpServers: { [ENTRY_NAME]: { command: "old", env: { OAM_BIN: "/x/oam", DEBUG: 1 } } } },
        null,
        2,
      ),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      force: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toContain(`Kept existing env on the ${ENTRY_NAME} entry: OAM_BIN`);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].env).toEqual({ OAM_BIN: "/x/oam" });
  });

  it("a VALID env on the existing entry still carries into the overwrite", async () => {
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old", env: { OAM_BIN: "/x/oam" } } } }, null, 2),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      force: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toContain(`Kept existing env on the ${ENTRY_NAME} entry: OAM_BIN`);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].env).toEqual({ OAM_BIN: "/x/oam" });
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
      promptAnswer: "overwrite",
      io: { ...cap.io, isTTY: true },
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
  });

  it("promptAnswer `abort` refuses with exit 1 and leaves the entry alone", async () => {
    // The [a]bort answer is a REFUSAL, not a no-op success: it exits 1 so a
    // wrapper script can tell "the user declined" from "nothing to do". Only
    // the overwrite answer had coverage.
    const initial = JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2);
    writeFileSync(join(synthHome, ".claude.json"), initial);
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      promptAnswer: "abort",
      io: { ...cap.io, isTTY: true },
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toContain("Aborted.");
    expect(r.written).toEqual([]);
    expect(readFileSync(join(synthHome, ".claude.json"), "utf8")).toBe(initial);
  });

  it("takes the skip default when stdin hits EOF at the prompt, instead of hanging", async () => {
    // A bare rl.question() never settles once its input closes (Ctrl+D, a
    // pipe running dry), so a TTY run over an existing entry hung at the
    // prompt forever. questionOrEmpty hands back "" on EOF -- the same answer
    // a bare Enter gives, i.e. the documented `(default: skip)`.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2),
    );
    const cap = captureIo();
    const stdin = new PassThrough();
    const pending = runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: { ...cap.io, stdin, isTTY: true },
      oamProbe: OAM_ABSENT,
    });
    // Close stdin without ever writing a line.
    stdin.end();
    const r = await pending;
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    expect(cap.stdout()).toMatch(/left untouched/);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME]).toEqual({ command: "old" });
  });

  it("Ctrl+C at the collision prompt is a cancel: 'Cancelled', exit 130, nothing written", async () => {
    // Distinct from EOF: on a TTY readline owns the keypress, closes the
    // interface and raises no process signal, so a close-only handler turned
    // a cancel into the DEFAULT answer -- the run printed "left untouched"
    // and exited 0 on a cancel. Every other prompt in the product exits 130.
    // terminal:true is what makes readline own the keypress; ETX is built
    // from its code so no control byte sits in this source file.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2),
    );
    const cap = captureIo();
    const stdin = new PassThrough();
    const pending = runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: { ...cap.io, stdin, isTTY: true, terminal: true },
      oamProbe: OAM_ABSENT,
    });
    await new Promise<void>((r) => setImmediate(r));
    stdin.write(String.fromCharCode(3));
    const r = await pending;
    expect(r.exitCode).toBe(130);
    expect(r.written).toEqual([]);
    expect(cap.stderr()).toMatch(/Cancelled/);
    expect(cap.stdout()).not.toMatch(/left untouched/);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME]).toEqual({ command: "old" });
  });

  it("promptAnswer `skip` exits 0 and leaves the entry alone", async () => {
    // The interactive [s]kip answer -- also promptCollision's DEFAULT for a
    // bare Enter -- lands on the same branch as the --skip flag, but by a
    // different route through the decision ladder.
    const initial = JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "old" } } }, null, 2);
    writeFileSync(join(synthHome, ".claude.json"), initial);
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      promptAnswer: "skip",
      io: { ...cap.io, isTTY: true },
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toContain(`Existing "${ENTRY_NAME}" entry left untouched.`);
    expect(r.written).toEqual([]);
    expect(readFileSync(join(synthHome, ".claude.json"), "utf8")).toBe(initial);
  });
});

// Its own describe, not a member of "collision handling": there is no
// collision here (fresh synthetic home, --dry-run, claude-desktop) -- the
// subject is the home override staying hermetic against the real APPDATA.
describe("runInstall — home override hermeticity (claude-desktop on Windows)", () => {
  it("a home override is hermetic for claude-desktop on Windows (APPDATA never leaks in)", async () => {
    // claude-desktop is the one client that lives under %APPDATA% rather
    // than $HOME on Windows. The `home` test seam did not cover it: with
    // a real APPDATA set, `runInstall({ os: "windows", home: synthHome,
    // force: true })` resolved through process.env.APPDATA and would have
    // overwritten the DEVELOPER'S real Claude Desktop config. appData now
    // derives from an overridden home. Asserted via --dry-run so even a
    // regression only reports the wrong path instead of writing to it.
    const prev = process.env.APPDATA;
    process.env.APPDATA = join(synthHome, "DECOY-real-appdata");
    try {
      const cap = captureIo();
      const r = await runInstall({
        clientId: "claude-desktop",
        scope: "user",
        os: "windows",
        home: synthHome,
        dryRun: true,
        io: cap.io,
        oamProbe: OAM_ABSENT,
      });
      expect(r.exitCode).toBe(0);
      expect(r.wouldWrite).toHaveLength(1);
      expect(r.wouldWrite[0]).toBe(join(synthHome, "AppData", "Roaming", "Claude", "claude_desktop_config.json"));
      expect(r.wouldWrite[0]).not.toContain("DECOY");
    } finally {
      if (prev === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prev;
    }
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
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toMatch(/not valid JSON/);
  });

  // The sibling branch: the bytes PARSE, so the "not valid JSON" refusal above
  // never fires, but the root is not an object and there is nowhere to splice
  // an entry. Refusal is by a different message ("is not a JSON object"), and
  // the settings.json equivalent is already matrixed the same way.
  it.each([
    ["array", "[]"],
    ["null", "null"],
  ])("refuses a client config that parses but is not an object (%s)", async (_label, contents) => {
    const clientPath = join(synthHome, ".claude.json");
    writeFileSync(clientPath, contents);
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toMatch(/not a JSON object/);
    expect(cap.stderr()).not.toMatch(/not valid JSON/);
    // Refusal means refusal: the file is byte-identical and nothing was written.
    expect(readFileSync(clientPath, "utf8")).toBe(contents);
    expect(r.written).toEqual([]);
  });
});

// A container key holding a non-object is the one shape valid-JSON files reach
// the splice with, and jsonc-parser throws on it ("Can not add index to parent
// of type null") -- a message that names neither the file nor the key. The
// pre-splice merge path repaired such a key and installed fine, so an abort here
// is a regression as well as an unreadable one.
describe("runInstall — non-object container key", () => {
  for (const [label, bad] of [
    ["null", null],
    ["an empty array", []],
    ["a number", 7],
    ["a string", "mcpServers"],
  ] as const) {
    it(`repairs an "mcpServers" key holding ${label} and installs`, async () => {
      const clientPath = join(synthHome, ".claude.json");
      writeFileSync(clientPath, `${JSON.stringify({ model: "opus", mcpServers: bad }, null, 2)}\n`, "utf8");

      const cap = captureIo();
      const r = await runInstall({
        clientId: "claude-code",
        scope: "user",
        os: "linux",
        home: synthHome,
        io: cap.io,
        oamProbe: OAM_ABSENT,
      });
      expect(r.exitCode).toBe(0);
      // No jsonc-parser internals in the output, either as an error or a warning.
      expect(cap.stderr()).not.toMatch(/Can not add index/);
      const parsed = parseJsonc(readFileSync(clientPath, "utf8")) as {
        model: string;
        mcpServers: Record<string, unknown>;
      };
      expect(parsed.mcpServers[ENTRY_NAME]).toBeDefined();
      // Siblings of the repaired key are untouched -- only that key is rewritten.
      expect(parsed.model).toBe("opus");
      // ...and the user is told, naming the key, since a value did disappear.
      const msg = r.messages.join(" ");
      expect(msg).toContain('"mcpServers"');
      expect(msg).toContain(`is ${label}, not an object`);
    });
  }

  it("repairs a non-object INTERMEDIATE key on the project-scope chain", async () => {
    // Claude Code local scope nests under projects[<absDir>].mcpServers, so the
    // blocked key can be two levels above the container. jsonc-parser
    // materializes the segments BELOW the repair, which is why one repair is
    // enough regardless of depth.
    const clientPath = join(synthHome, ".claude.json");
    writeFileSync(clientPath, `${JSON.stringify({ projects: null }, null, 2)}\n`, "utf8");

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "local",
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      projectDir: synthCwd,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const parsed = parseJsonc(readFileSync(clientPath, "utf8")) as {
      projects: Record<string, { mcpServers: Record<string, unknown> }>;
    };
    expect(parsed.projects[projectsKey(synthCwd)].mcpServers[ENTRY_NAME]).toBeDefined();
    const msg = r.messages.join(" ");
    expect(msg).toContain('"projects"');
    expect(msg).toContain("is null, not an object");
  });

  it("keeps the user's comments while repairing the key", async () => {
    const clientPath = join(synthHome, ".claude.json");
    writeFileSync(clientPath, ["{", "  // keep me", '  "mcpServers": null', "}", ""].join("\n"), "utf8");

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(readFileSync(clientPath, "utf8")).toContain("// keep me");
  });

  it("refuses, naming the key, when the container holds entries in the wrong shape", async () => {
    // The one non-object shape that can carry real server definitions. The old
    // merge path dropped them silently to write ours; refusing names the key and
    // leaves the file alone.
    const clientPath = join(synthHome, ".claude.json");
    const original = `${JSON.stringify({ mcpServers: [{ name: "spend", url: "https://x" }] }, null, 2)}\n`;
    writeFileSync(clientPath, original, "utf8");

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    const stderr = cap.stderr();
    expect(stderr).toContain('"mcpServers"');
    expect(stderr).toMatch(/an array of 1/);
    expect(stderr).toMatch(/not a JSON object/);
    expect(stderr).not.toMatch(/Can not add index/);
    // Refusal means refusal: the file is byte-identical.
    expect(readFileSync(clientPath, "utf8")).toBe(original);
  });

  it("previews the repair in the conditional under --dry-run without writing", async () => {
    const clientPath = join(synthHome, ".claude.json");
    const original = `${JSON.stringify({ mcpServers: null }, null, 2)}\n`;
    writeFileSync(clientPath, original, "utf8");

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(r.messages.join(" ")).toMatch(/would replace it with an empty object/);
    expect(readFileSync(clientPath, "utf8")).toBe(original);
  });
});

// SOFT deprecation, not a removal: `--token` and `--no-yaw-mcp-config` must
// keep parsing, keep exiting 0, and warn -- a scripted
// `yaw-mcp install --all --token mcp_pat_...` in someone's provisioning
// script must not start failing.
describe("runInstall — deprecated --token / --no-yaw-mcp-config", () => {
  it("accepts --token, warns on stderr, exits 0, and writes no ~/.yaw-mcp/config.json", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_scripted_aaaa",
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stderr()).toContain(TOKEN_FLAG_DEPRECATION);
    // The PAT itself is never echoed back.
    expect(cap.stderr()).not.toContain("mcp_pat_scripted_aaaa");
    expect(cap.stdout()).not.toContain("mcp_pat_scripted_aaaa");
    // The client install still happened; the token file did not.
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(true);
    expect(existsSync(join(synthHome, ".yaw-mcp", "config.json"))).toBe(false);
  });

  it("names the deprecation reason and tells the user to revoke the PAT", () => {
    expect(TOKEN_FLAG_DEPRECATION).toMatch(/deprecated and ignored/);
    expect(TOKEN_FLAG_DEPRECATION).toMatch(/local-only/);
    expect(TOKEN_FLAG_DEPRECATION).toMatch(/revoke that PAT/);
  });

  it("accepts --no-yaw-mcp-config, warns, and exits 0", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      skipYawMcpConfig: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stderr()).toContain(NO_CONFIG_FLAG_DEPRECATION);
  });

  it("leaves an existing ~/.yaw-mcp/config.json completely untouched", async () => {
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const cfgPath = join(synthHome, ".yaw-mcp", "config.json");
    const originalBytes = JSON.stringify({ token: "mcp_pat_existing_aaaa", version: 1 });
    writeFileSync(cfgPath, originalBytes, "utf8");

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_new_bbbb",
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    // Byte-identical: no rewrite, no rotation, and no `.bak-*` sibling.
    expect(readFileSync(cfgPath, "utf8")).toBe(originalBytes);
    expect(readdirSync(join(synthHome, ".yaw-mcp")).filter((f) => f.startsWith("config.json.bak-"))).toHaveLength(0);
  });

  it("warns ONCE under --all, not once per client", async () => {
    const cap = captureIo();
    const r = await runInstall({
      all: true,
      os: "linux",
      home: synthHome,
      token: "mcp_pat_all_aaaa",
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const hits = cap.stderr().split(TOKEN_FLAG_DEPRECATION).length - 1;
    expect(hits).toBe(1);
    expect(existsSync(join(synthHome, ".yaw-mcp", "config.json"))).toBe(false);
  });

  it("a scripted `install --all --token <pat>` parses and runs clean end to end", async () => {
    const parsed = parseInstallArgs(["--all", "--token", "mcp_pat_scripted_zzzz"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const cap = captureIo();
    const r = await runInstall({
      ...parsed.options,
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
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
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    // Would-write list covers client config + settings.json patch.
    expect(r.wouldWrite.length).toBe(2);
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
    expect(existsSync(join(synthHome, ".yaw-mcp", "config.json"))).toBe(false);
    expect(existsSync(join(synthHome, ".claude", "settings.json"))).toBe(false);
    expect(cap.stdout()).toMatch(/dry run/i);
  });

  it("never echoes a passed --token into the dry-run dump", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      token: "mcp_pat_super_secret_value",
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    // Nothing renders the token any more -- the config.json dump is gone.
    expect(cap.stdout()).not.toContain("mcp_pat_super_secret_value");
    expect(cap.stderr()).not.toContain("mcp_pat_super_secret_value");
  });

  it("prints only the entry being added, never a sibling entry's env or the rest of settings.json", async () => {
    // ~/.claude.json carries every server's env (a GitHub PAT here; a `yaw-mcp
    // try` entry's inline API key in the wild) and settings.json has an `env`
    // block of its own. The preview used to dump both files WHOLE, so a user
    // who pasted the transcript into a bug report disclosed every one of them
    // -- while the header promised a diff.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify(
        { mcpServers: { github: { command: "npx", env: { GITHUB_TOKEN: "ghp_sibling_secret" } } } },
        null,
        2,
      ),
    );
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-settings-secret" }, permissions: { allow: ["Bash(git *)"] } }),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    expect(r.wouldWrite).toHaveLength(2);
    const out = cap.stdout();
    expect(out).not.toContain("ghp_sibling_secret");
    expect(out).not.toContain("sk-ant-settings-secret");
    // Not even the sibling's key or the pre-existing allow rule: nothing that
    // is not changing is echoed.
    expect(out).not.toContain('"github"');
    expect(out).not.toContain("Bash(git *)");
    // What WOULD change still previews: the entry at its container path and
    // the permissions.allow delta.
    expect(out).toContain('"mcpServers"');
    expect(out).toContain(`"${ENTRY_NAME}"`);
    expect(out).toContain('"npx"');
    expect(out).toContain(`permissions.allow += ${JSON.stringify([CLAUDE_CODE_ALLOW_PATTERN])}`);
  });

  it("masks the values of the env it carries over from the existing entry, but still names its keys", async () => {
    // The carry-over ahead of the preview keeps the existing entry's env
    // verbatim, and README tells users to put YAW_MCP_VAULT_PASSPHRASE in
    // exactly that block -- so rendering entryToWrite as-is printed the vault
    // passphrase into the one output that exists to be pasted somewhere,
    // under a comment claiming the preview no longer leaked.
    const clientPath = join(synthHome, ".claude.json");
    const original = JSON.stringify(
      {
        mcpServers: {
          [ENTRY_NAME]: { command: "old", env: { YAW_MCP_VAULT_PASSPHRASE: "hunter2-vault-passphrase" } },
        },
      },
      null,
      2,
    );
    writeFileSync(clientPath, original);
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    const out = cap.stdout();
    expect(out).not.toContain("hunter2-vault-passphrase");
    expect(cap.stderr()).not.toContain("hunter2-vault-passphrase");
    // The key survives in both places it is named: the carry-over line, and
    // the previewed entry, where the placeholder stands in for the value.
    expect(out).toContain(`Kept existing env on the ${ENTRY_NAME} entry: YAW_MCP_VAULT_PASSPHRASE`);
    expect(out).toContain(`"YAW_MCP_VAULT_PASSPHRASE": ${JSON.stringify(DRY_RUN_ENV_PLACEHOLDER)}`);
    // Preview only: the file still holds the real value, untouched.
    expect(readFileSync(clientPath, "utf8")).toBe(original);
  });

  it("previews a local-scope entry under its projects[<dir>] nesting, so the user sees where it lands", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "local",
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const out = cap.stdout();
    expect(out).toContain('"projects"');
    expect(out).toContain(JSON.stringify(projectsKey(synthCwd)));
    expect(out).toContain(`"${ENTRY_NAME}"`);
  });
});

describe("runInstall — a client config that changes between read and write", () => {
  // The read of ~/.claude.json and its publishing rename bracket an awaited
  // `oam --version` probe (up to 3s) plus the collision prompt, and Claude
  // Code writes that same file during a live session. The probe seam IS that
  // window, so a write from inside it is what a concurrent save looks like.
  it("refuses instead of clobbering a save that landed during the oam probe", async () => {
    const clientPath = join(synthHome, ".claude.json");
    writeFileSync(clientPath, JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2));
    const concurrent = JSON.stringify(
      { mcpServers: { other: { command: "x" } }, projects: { "/repo": { allowedTools: ["Read"] } } },
      null,
      2,
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: async () => {
        writeFileSync(clientPath, concurrent);
        return OAM_ABSENT();
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.written).toEqual([]);
    expect(cap.stderr()).toMatch(/changed while install was running/);
    // The concurrent save survives byte-for-byte: no entry was merged over the
    // pre-probe snapshot and published on top of it.
    expect(readFileSync(clientPath, "utf8")).toBe(concurrent);
    // Nothing downstream ran either -- the settings.json patch was never written.
    expect(existsSync(join(synthHome, ".claude", "settings.json"))).toBe(false);
  });

  it("refuses when the file was absent at read time but exists by write time", async () => {
    // The fresh-install shape of the same race: Claude Code creates
    // ~/.claude.json while install is still deciding what to write into a file
    // it believes does not exist.
    const clientPath = join(synthHome, ".claude.json");
    const concurrent = JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2);
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: async () => {
        writeFileSync(clientPath, concurrent);
        return OAM_ABSENT();
      },
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toMatch(/changed while install was running/);
    expect(readFileSync(clientPath, "utf8")).toBe(concurrent);
  });
});

describe("runInstall — settings.json that changes between its read and its patch", () => {
  // The client-config guard above covered only the client config. settings.json
  // is read AFTER the oam probe and the collision prompt but BEFORE the client
  // config is published, and Claude Code rewrites settings.json on every
  // permission approval -- so an approval landing during that publish was
  // replaced by a patch computed on the pre-publish bytes, with no diagnostic.
  // The publish is the one awaited step inside that window, which is what the
  // atomicWriteSeam hook at the top of this file reaches.
  it("skips the permissions patch with a warning, keeps the concurrent bytes, and still exits 0", async () => {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Bash(git *)"] } }, null, 2));
    // What an approval leaves behind: the same file, one more rule. A different
    // byte length, so the fingerprint moves even on a coarse-mtime filesystem.
    const concurrent = JSON.stringify({ permissions: { allow: ["Bash(git *)", "Bash(npm test)"] } }, null, 2);
    atomicWriteSeam.beforeWrite = (path) => {
      if (basename(path) === ".claude.json") writeFileSync(settingsPath, concurrent);
    };
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    // The install itself succeeds: the launch entry landed, and only the
    // settings patch was withheld.
    expect(r.exitCode).toBe(0);
    expect(r.written).toHaveLength(1);
    expect(r.written).not.toContain(settingsPath);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
    const stderr = cap.stderr();
    expect(stderr).toMatch(/settings\.json changed while install was running/);
    expect(stderr).toContain(CLAUDE_CODE_ALLOW_PATTERN);
    // Not the client-config refusal, which names "nothing was written".
    expect(stderr).not.toContain("nothing was written");
    // The approval survives byte-for-byte: our pattern was not merged over the
    // pre-publish snapshot and published on top of it.
    expect(readFileSync(settingsPath, "utf8")).toBe(concurrent);
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
      io: cap.io,
      oamProbe: OAM_PROBE_FORBIDDEN,
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
      force: true,
      skip: true,
      io: cap.io,
      oamProbe: OAM_PROBE_FORBIDDEN,
    });
    expect(r.exitCode).toBe(2);
    expect(cap.stderr()).toMatch(/mutually exclusive/);
  });

  it("--all --force --skip is refused ONCE with exit 2, not per client", async () => {
    // The pair check has to sit ABOVE the --list/--all dispatch: run under
    // --all it fired inside every per-client sub-install instead, so the user
    // got "Installing into N clients", one refusal per planned client, and
    // exit 1 as "N/N client installs failed" -- a runtime-failure code for
    // what is a usage error, with the refusal restated N times.
    const cap = captureIo();
    const r = await runInstall({
      all: true,
      force: true,
      skip: true,
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_PROBE_FORBIDDEN,
    });
    expect(r.exitCode).toBe(2);
    const stderr = cap.stderr();
    const refusals = stderr.split("\n").filter((l) => /mutually exclusive/.test(l));
    expect(refusals).toHaveLength(1);
    // The run never starts: no per-client plan is announced, and nothing is written.
    expect(cap.stdout()).not.toContain("Installing into");
    expect(r.written).toEqual([]);
    expect(r.wouldWrite).toEqual([]);
  });

  it("--list + --all refused with exit 2", async () => {
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      listOnly: true,
      all: true,
      io: cap.io,
      oamProbe: OAM_PROBE_FORBIDDEN,
    });
    expect(r.exitCode).toBe(2);
    expect(cap.stderr()).toMatch(/mutually exclusive/);
  });
});

describe("runInstall — --project-dir at a scope that resolves none", () => {
  // Pins CURRENT behaviour: a `--project-dir` handed to a scope that reads no
  // project directory is REFUSED at exit 2 with nothing written, rather than
  // accepted-and-dropped. The refusal cannot live in the parser because the
  // scope is only known once the client's default has resolved -- claude-code,
  // claude-desktop and cursor all default to `user` (install-targets.ts) -- so
  // it is the runner that has to reject it, and nothing exercised the branch.
  // Load-bearing because the pre-refusal spelling was a SUCCESSFUL user-scope
  // install at exit 0: whether refusing is the right call, or the flag should
  // instead be ignored with a warning for a client that has no project scope,
  // is a product question these tests only record the answer to.

  it("claude-code (user) refuses at exit 2, writes nothing, and names the scopes that read it", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      // No explicit scope: claude-code DEFAULTS to user, which is the whole
      // point -- the plain `install claude-code --project-dir /repo` a user
      // types is the shape that used to quietly write ~/.claude.json.
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      projectDir: synthCwd,
      io: cap.io,
      // The refusal is ahead of the oam probe: a usage error must not pay for
      // (or be able to fail on) a machine probe it never uses.
      oamProbe: OAM_PROBE_FORBIDDEN,
    });
    expect(r.exitCode).toBe(2);
    expect(r.written).toEqual([]);
    expect(r.wouldWrite).toEqual([]);
    // The user-scope file it would otherwise have written is untouched.
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
    const stderr = cap.stderr();
    expect(stderr).toMatch(/cannot honor --project-dir/);
    // Both project-reading scopes are offered, in INSTALL_TARGETS order.
    expect(stderr).toMatch(/--scope project \| local/);
  });

  it("claude-desktop refuses at exit 2 and says it has no project scope at all", async () => {
    // The other half of the branch: with no project-reading scope to suggest,
    // the fix line must say so rather than print an empty `--scope `.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-desktop",
      // macos, so this is the not-available-on-linux refusal's sibling and not
      // that refusal itself -- claude-desktop ships on macos and windows.
      os: "macos",
      home: synthHome,
      cwd: synthCwd,
      projectDir: synthCwd,
      io: cap.io,
      oamProbe: OAM_PROBE_FORBIDDEN,
    });
    expect(r.exitCode).toBe(2);
    expect(r.written).toEqual([]);
    expect(r.wouldWrite).toEqual([]);
    expect(existsSync(join(synthHome, "Library", "Application Support", "Claude", "claude_desktop_config.json"))).toBe(
      false,
    );
    const stderr = cap.stderr();
    expect(stderr).toMatch(/cannot honor --project-dir/);
    expect(stderr).toMatch(/has no project-directory scope/);
    expect(stderr).not.toMatch(/--scope\s*$/m);
  });
});

describe("runInstall — Windows %APPDATA% redirection", () => {
  it("the write path and --list name the SAME redirected claude-desktop file", async () => {
    // Windows lets %APPDATA% be redirected (roaming profile, folder
    // redirection) away from `<home>\AppData\Roaming`, and Claude Desktop reads
    // the redirected location. resolveInstallPath used to read
    // process.env.APPDATA itself, but ONLY when the caller passed no `home` --
    // which is the write path alone (runInstall threads opts.home straight
    // through and there is no --home flag). Every reader resolves a home first
    // (probeClientsAsync requires `home: string`), so `--list` and doctor
    // reported the HOME-derived path while install wrote the redirected one.
    // resolveAppData now owns the env read for BOTH surfaces.
    const redirected = mkdtempSync(join(tmpdir(), "yaw-mcp-appdata-"));
    // homedir() is the fallback on the no-`home` path both calls below take;
    // stub it off the real machine so this stays hermetic.
    vi.stubEnv("APPDATA", redirected);
    vi.stubEnv("USERPROFILE", synthHome);
    vi.stubEnv("HOME", synthHome);
    try {
      const expected = join(redirected, "Claude", "claude_desktop_config.json");
      const capWrite = captureIo();
      const w = await runInstall({
        clientId: "claude-desktop",
        scope: "user",
        os: "windows",
        io: capWrite.io,
        oamProbe: OAM_ABSENT,
      });
      expect(w.exitCode).toBe(0);
      expect(w.written).toEqual([expected]);
      expect(existsSync(expected)).toBe(true);
      // ...and NOT the HOME-derived spelling the readers used to name.
      expect(existsSync(join(synthHome, "AppData", "Roaming", "Claude", "claude_desktop_config.json"))).toBe(false);

      const capList = captureIo();
      const l = await runInstall({ listOnly: true, os: "windows", io: capList.io });
      expect(l.exitCode).toBe(0);
      const row = l.messages.find((m) => m.includes("Claude Desktop"));
      expect(row).toBeDefined();
      // Same path, and read back as configured -- i.e. --list opened the file
      // install just wrote instead of describing a different one as absent.
      expect(row).toContain(expected);
      expect(row).toMatch(/installed/);
    } finally {
      vi.unstubAllEnvs();
      rmSync(redirected, { recursive: true, force: true });
    }
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

  it("rejects --all combined with --scope instead of silently dropping it", () => {
    // runInstallAll plans its own scope per client and used to spread-then-
    // override opts.scope -- so `--all --scope project` wrote claude-code
    // and cursor at USER scope with no message. A flag that is accepted and
    // ignored reads as honored; refuse at the boundary.
    const r = parseInstallArgs(["--all", "--scope", "project"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("cannot honor --scope");
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
    // No row's STATUS is a bare `installed`. Asserted on the row SHAPE, not on
    // the absence of the substring "installed " -- that only held because "not
    // installed" happens to be the widest status (so a bare one is padded) and
    // STATUS happens to be the last column; a wider status or a column reorder
    // would have flipped it silently.
    const installedRows = out.split("\n").filter((l) => /\binstalled\s*$/.test(l) && !/not installed/.test(l));
    expect(installedRows).toHaveLength(0);
    expect(out).toContain("0/");
  });

  it("--list honors --project-dir for the project-scope rows", async () => {
    // `install vscode --project-dir /repo` writes under /repo, so
    // `install --list --project-dir /repo` must report the same file --
    // accepting the flag and probing cwd instead made the two surfaces
    // describe different directories.
    const projDir = mkdtempSync(join(synthHome, "elsewhere-"));
    mkdirSync(join(projDir, ".vscode"), { recursive: true });
    writeFileSync(
      join(projDir, ".vscode", "mcp.json"),
      JSON.stringify({ servers: { [ENTRY_NAME]: { command: "npx" } } }),
      "utf8",
    );
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd, // deliberately different from projectDir
      projectDir: projDir,
      listOnly: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    // The seeded entry under projectDir is visible -- the probe ran against
    // --project-dir, not cwd (where nothing exists).
    expect(cap.stdout()).toMatch(/VS Code\s+project\s+\S*[\\/]\.vscode[\\/]mcp\.json\s+installed/);
  });

  it("detects an installed yaw-mcp entry in ~/.claude.json", async () => {
    // Seed Claude Code user-scope config with the entry.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp"] } } }),
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
    // EXACTLY one scope is configured (only claude-code user was seeded), and
    // the headline counts it. `\d+/\d+` accepted `0/N` -- so the counter was
    // never actually verified to count.
    expect(out).toMatch(/^1\/\d+ client scopes have yaw-mcp configured on linux\./m);
  });

  it("reports `other-entries` when the config exists but carries no yaw-mcp entry", async () => {
    // The fourth status, and the only one with no test: the file is there and
    // parses, it just holds someone else's servers. It reads differently from
    // `not installed` (nothing to lose) and from `malformed` (needs a fix) --
    // install will splice into this file, preserving what is already in it.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { spend: { url: "https://x" } } }),
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
    expect(out).toMatch(/Claude Code\s+user\s+~[\\/].claude\.json\s+other-entries/);
    // Present-but-unconfigured does not count toward the headline.
    expect(out).toMatch(/^0\/\d+ client scopes have yaw-mcp configured on linux\./m);
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
  it("installs into every user-scope client on linux", async () => {
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      all: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
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
    expect(out).toMatch(/Done: \d+\/\d+ clients installed successfully\./);
    // ~/.yaw-mcp/config.json is not part of an install any more.
    expect(existsSync(join(synthHome, ".yaw-mcp", "config.json"))).toBe(false);
  });

  it("--project-dir pulls the project-only client (vscode) into the plan", async () => {
    // The other side of the "skip vscode" line above, and the untested half of
    // runInstallAll's planner: a client with NO non-project scope is planned at
    // its first scope only when --project-dir is passed.
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      projectDir: synthCwd,
      all: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const out = cap.stdout();
    expect(out).not.toContain("skip vscode");
    // Planned at its workspace scope, and the file lands under the project dir.
    const vscodeConfig = join(synthCwd, ".vscode", "mcp.json");
    expect(existsSync(vscodeConfig)).toBe(true);
    expect(r.written).toContain(vscodeConfig);
    const config = JSON.parse(readFileSync(vscodeConfig, "utf8"));
    expect(config.servers[ENTRY_NAME]).toBeDefined();
    // The user-scope clients are still installed alongside it.
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(true);
    expect(existsSync(join(synthHome, ".cursor", "mcp.json"))).toBe(true);
  });

  it("--dry-run aggregates every client's would-writes and writes nothing", async () => {
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      all: true,
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    // Every planned client's preview is folded into ONE list: claude-code's
    // client config + its settings.json patch, plus cursor's config.
    expect(r.wouldWrite).toContain(join(synthHome, ".claude.json"));
    expect(r.wouldWrite).toContain(join(synthHome, ".claude", "settings.json"));
    expect(r.wouldWrite).toContain(join(synthHome, ".cursor", "mcp.json"));
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
    expect(existsSync(join(synthHome, ".cursor", "mcp.json"))).toBe(false);
    // A preview leaves entries in place for the purposes of the runtime tip:
    // wouldWrite is what feeds the "did this run leave an entry" gate, so the
    // consolidated oam-absent note still prints on a dry run.
    expect(cap.stdout()).toMatch(/Runtime: node \(oam is not installed/);
  });

  it("refuses with exit 1 when no clients are installable on the OS", async () => {
    const cap = captureIo();
    const r = await runInstall({
      // Synthetic OS value. Cast to bypass the TS guard since we're
      // probing the runtime error path.
      os: "plan9" as unknown as "linux",
      home: synthHome,
      cwd: synthCwd,
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
      all: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toMatch(/client install.*failed/);
  });

  it("consolidates collision-without-flag refusals into ONE hint", async () => {
    // Seed BOTH user-scope clients (claude-code, cursor) with an existing
    // yaw-mcp entry so each sub-install collides. Non-TTY + no --force/--skip
    // => each would emit its own "already has entry and stdin is not a TTY"
    // refusal. The consolidated path collapses them into one hint.
    const seeded = { mcpServers: { [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp"] } } };
    writeFileSync(join(synthHome, ".claude.json"), JSON.stringify(seeded), "utf8");
    mkdirSync(join(synthHome, ".cursor"), { recursive: true });
    writeFileSync(join(synthHome, ".cursor", "mcp.json"), JSON.stringify(seeded), "utf8");

    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      all: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    const stderr = cap.stderr();
    // Exactly ONE "not a TTY" line, naming both clients, with the re-run hint.
    const ttyLines = stderr.split("\n").filter((l) => /stdin is not a TTY/.test(l));
    expect(ttyLines).toHaveLength(1);
    expect(stderr).toContain("claude-code");
    expect(stderr).toContain("cursor");
    expect(stderr).toMatch(/--all --force/);
    expect(stderr).toMatch(/--skip/);
  });

  it("--all --force overwrites colliding clients without the consolidated hint", async () => {
    const seeded = { mcpServers: { [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp"] } } };
    writeFileSync(join(synthHome, ".claude.json"), JSON.stringify(seeded), "utf8");
    mkdirSync(join(synthHome, ".cursor"), { recursive: true });
    writeFileSync(join(synthHome, ".cursor", "mcp.json"), JSON.stringify(seeded), "utf8");

    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      all: true,
      force: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stderr()).not.toMatch(/stdin is not a TTY/);
  });
});

describe("install usage", () => {
  it("lists --token and --no-yaw-mcp-config as deprecated rather than dropping them", () => {
    // They must still be discoverable -- a user whose script breaks needs to
    // find out WHY from `install --help`, not just see the flag vanish.
    expect(INSTALL_USAGE).toMatch(/Deprecated \(accepted, ignored, warns\)/);
    expect(INSTALL_USAGE).toContain("--token");
    expect(INSTALL_USAGE).toContain("--no-yaw-mcp-config");
    expect(INSTALL_USAGE).toMatch(/local-only/);
  });
});

describe("runInstall — oam launch entry", () => {
  it("writes an oam entry when oam and a durable install both resolve", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      // Pinned like every sibling in this describe: without it the run takes
      // the HOST's os, and the assertion below passes only because the oam
      // entry happens to have no per-OS wrapping (the npx one does).
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_PRESENT,
      resolveOamEntry: () => OAM_ENTRY,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("/usr/local/bin/oam");
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["run", "--no-check", OAM_ENTRY]);
  });

  it("persists the absolute binPath, never the bare name the probe spawns", async () => {
    // The regression the whole binPath split exists for. `bin` is "oam" without
    // OAM_BIN -- correct to spawn from a shell-launched CLI, fatal to persist:
    // Claude Desktop launched from the Dock has no ~/.oam/bin on PATH, so the
    // broker ENOENTs with no fallback and doctor exempts non-absolute commands.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_BARE_RESOLVED,
      resolveOamEntry: () => OAM_ENTRY,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("/home/j/.oam/bin/oam");
    expect(client.mcpServers[ENTRY_NAME].command).not.toBe("oam");
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["run", "--no-check", OAM_ENTRY]);
  });

  it("stays on npx, and says why, when oam runs but has no persistable path", async () => {
    // oam works in THIS process and yaw-mcp is durably installed -- both halves
    // the old check looked at. There is still nothing portable to write, so npx
    // wins, and the user gets told rather than left with a silent downgrade.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_BARE_UNRESOLVED,
      resolveOamEntry: () => OAM_ENTRY,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
    const out = r.messages.join(" ");
    expect(out).toMatch(/absolute path could not be resolved/);
    expect(out).toContain("OAM_BIN");
  });

  it("does not claim the oam runtime when the resolved binPath is relative", async () => {
    // The Runtime line used to be derived from `oamBinPath && oamEntry` while
    // buildLaunchEntry additionally required isAbsolute(oamBinPath), so this
    // machine got "will run on oam" printed over an `npx` entry -- and no line
    // at all explaining why the broker was not on oam.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_RELATIVE_BINPATH,
      resolveOamEntry: () => OAM_ENTRY,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
    const out = r.messages.join(" ");
    expect(out).not.toMatch(/will run on oam/);
    // ...and the fallback is named, with the offending path and the remedy.
    expect(out).toMatch(/relative path/);
    expect(out).toContain("node_modules/.bin/oam");
    expect(out).toContain("OAM_BIN");
  });

  it("explains a below-min oam instead of printing the oam-absent output", async () => {
    // Before this, a below-min oam took the same branch as no oam at all and
    // said nothing -- byte-identical human output for two different machines.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_BELOW_MIN,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
    const out = r.messages.join(" ");
    // Both versions, so "upgrade oam" is actionable without a second command.
    expect(out).toContain("0.8.2");
    expect(out).toContain(MIN_OAM_VERSION);
  });

  it("distinguishes a broken oam from an absent one", async () => {
    const broken = captureIo();
    const withBroken = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: broken.io,
      oamProbe: OAM_BROKEN,
    });
    expect(withBroken.exitCode).toBe(0);
    const brokenOut = withBroken.messages.join(" ");
    expect(brokenOut).toMatch(/installed but unusable/);
    expect(brokenOut).toContain("did not answer in time");

    // Absence now gets a line too -- it used to be the one branch of the chain
    // that said nothing, so a fresh machine got an npx entry with no hint that
    // oam existed. What must NOT leak across is the broken wording: sending
    // someone with no oam to "fix or reinstall" it is the inverse of the bug the
    // branches above exist to prevent.
    const absentHome = mkdtempSync(join(tmpdir(), "yaw-mcp-install-absent-"));
    try {
      const absent = captureIo();
      const withAbsent = await runInstall({
        clientId: "claude-code",
        scope: "user",
        os: "linux",
        home: absentHome,
        io: absent.io,
        oamProbe: OAM_ABSENT,
      });
      expect(withAbsent.exitCode).toBe(0);
      const absentOut = withAbsent.messages.join(" ");
      expect(absentOut).toMatch(/Runtime: node \(oam is not installed/);
      expect(absentOut).toContain(OAM_INSTALL_SH);
      expect(absentOut).not.toMatch(/unusable/);
      // Nothing is broken, so it must not read as a repair instruction.
      expect(absentOut).not.toMatch(/Fix or reinstall/);
    } finally {
      rmSync(absentHome, { recursive: true, force: true });
    }
  });

  it("prints the oam-absent note ONCE under --all, not once per client", async () => {
    // Absence is a machine-level fact and the common case, so the per-client
    // Runtime line would stack up one identical copy per installed client --
    // the same noise the collision refusal is consolidated to avoid. The other
    // Runtime reasons are rare misconfigurations and still print per client.
    const allHome = mkdtempSync(join(tmpdir(), "yaw-mcp-install-all-absent-"));
    try {
      const cap = captureIo();
      const r = await runInstall({
        all: true,
        os: "linux",
        home: allHome,
        io: cap.io,
        oamProbe: OAM_ABSENT,
      });
      expect(r.exitCode).toBe(0);
      const out = r.messages.join("\n");
      // More than one client must actually have been installed, or this pins
      // nothing -- a single-client run would read as "once" either way. Counted
      // by HEADER LINE: a `──` token count passes on a single-client run too,
      // because each header carries two of them.
      const headers = r.messages.filter((m) => CLIENT_HEADER_LINE.test(m));
      expect(headers.length).toBeGreaterThan(1);
      expect(out.split(OAM_INSTALL_SH).length - 1).toBe(1);
    } finally {
      rmSync(allHome, { recursive: true, force: true });
    }
  });

  it("names the windows installer when install is asked about windows", async () => {
    // The install command is selected from the --os the report is ABOUT, never
    // process.platform: a report generated on linux for a windows machine that
    // hands back the curl line is a command that machine cannot run.
    const winHome = mkdtempSync(join(tmpdir(), "yaw-mcp-install-absent-win-"));
    try {
      const cap = captureIo();
      const r = await runInstall({
        clientId: "claude-code",
        scope: "user",
        os: "windows",
        home: winHome,
        io: cap.io,
        oamProbe: OAM_ABSENT,
      });
      expect(r.exitCode).toBe(0);
      const out = r.messages.join(" ");
      expect(out).toContain(OAM_INSTALL_PS1);
      expect(out).not.toContain(OAM_INSTALL_SH);
    } finally {
      rmSync(winHome, { recursive: true, force: true });
    }
  });

  it("withholds the installer on a machine oam publishes no binary for", async () => {
    // The absent note names an install one-liner, but oam ships no
    // linux-arm64 (or freebsd, or...) asset and install.sh refuses outright --
    // so on those machines the one-liner is a command that exits non-zero for
    // a runtime the user never needed. Reachable only via the seam: the branch
    // is gated on THIS machine's platform+arch, so on every runner that has a
    // published binary it is dead code the note's own tests cannot see.
    const hostInstaller = CURRENT_OS === "windows" ? OAM_INSTALL_PS1 : OAM_INSTALL_SH;
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      // CURRENT_OS, not a literal: the withhold branch only fires for the
      // machine the run is ON -- asked about another OS, install has no arch
      // to judge and must keep naming that OS's installer.
      os: CURRENT_OS,
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
      oamPublishesBinary: () => false,
    });
    expect(r.exitCode).toBe(0);
    const out = r.messages.join(" ");
    expect(out).toContain("oam is not an option on this machine");
    // One source for the wording, shared with doctor's OAM RUNTIME section.
    expect(out).toContain(oamNoBinaryReason());
    expect(out).not.toContain(hostInstaller);

    // Same run on a machine that DOES have a binary still names the one-liner.
    const publishedHome = mkdtempSync(join(tmpdir(), "yaw-mcp-install-published-"));
    try {
      const published = captureIo();
      const withBinary = await runInstall({
        clientId: "claude-code",
        scope: "user",
        os: CURRENT_OS,
        home: publishedHome,
        io: published.io,
        oamProbe: OAM_ABSENT,
        oamPublishesBinary: () => true,
      });
      expect(withBinary.exitCode).toBe(0);
      const publishedOut = withBinary.messages.join(" ");
      expect(publishedOut).toContain(hostInstaller);
      expect(publishedOut).not.toContain("oam is not an option on this machine");
    } finally {
      rmSync(publishedHome, { recursive: true, force: true });
    }
  });

  it("warns when the durable entry is a project-local node_modules", async () => {
    // resolveStableNpmEntry calls any non-_npx hit durable, including a repo's
    // own node_modules -- and this config is machine-global, so an `rm -rf
    // node_modules` weeks later kills the broker in every project at once.
    // Built with path.join so the fixture matches the runner's separators.
    const projectEntry = join(synthCwd, "node_modules", "@yawlabs", "mcp", "dist", "index.js");
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      io: cap.io,
      oamProbe: OAM_PRESENT,
      resolveOamEntry: () => projectEntry,
    });
    expect(r.exitCode).toBe(0);
    // The entry is still written -- this is a note, not a refusal.
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["run", "--no-check", projectEntry]);
    const out = r.messages.join(" ");
    expect(out).toMatch(/project-local install/);
    expect(out).toContain("npm i -g @yawlabs/mcp");
  });

  it("does not warn when the durable entry is a global install", async () => {
    const globalHome = mkdtempSync(join(tmpdir(), "yaw-mcp-install-global-"));
    try {
      const cap = captureIo();
      const r = await runInstall({
        clientId: "claude-code",
        scope: "user",
        os: "linux",
        home: globalHome,
        cwd: synthCwd,
        io: cap.io,
        oamProbe: OAM_PRESENT,
        resolveOamEntry: () => "/usr/local/lib/node_modules/@yawlabs/mcp/dist/index.js",
      });
      expect(r.exitCode).toBe(0);
      expect(r.messages.join(" ")).not.toMatch(/project-local/);
    } finally {
      rmSync(globalHome, { recursive: true, force: true });
    }
  });

  it("stays on npx when oam is present but nothing durable resolves", async () => {
    // The common shape: launched via `npx -y`, so yaw-mcp lives only in the
    // npx cache and there is no path safe to persist.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      home: synthHome,
      io: cap.io,
      os: "linux",
      oamProbe: OAM_PRESENT,
      resolveOamEntry: () => null,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].command).toBe("npx");
    expect(r.messages.join(" ")).toContain("not durably installed");
  });

  it("keeps an existing entry's env across a reinstall", async () => {
    // OAM_BIN pins WHICH oam hosts the sidecars. The merge replaces our entry
    // wholesale and the default entry carries no env, so without this the
    // setting silently vanished and the sidecars moved runtime.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({
        mcpServers: { [ENTRY_NAME]: { command: "npx", args: ["-y", "old"], env: { OAM_BIN: "/custom/oam" } } },
      }),
    );
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      home: synthHome,
      io: cap.io,
      os: "linux",
      force: true,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME].env).toEqual({ OAM_BIN: "/custom/oam" });
    // and the command was still refreshed -- preservation must not freeze the entry
    expect(client.mcpServers[ENTRY_NAME].args).toEqual(["-y", "@yawlabs/mcp@latest"]);
  });
});

describe("runInstall — preserves the user's bytes and perms", () => {
  it("keeps comments in a pre-existing client config instead of flattening it", async () => {
    // `.vscode/mcp.json` is documented JSONC and its `inputs` array is
    // routinely commented; ~/.claude.json carries user comments too. install
    // used to read-modify-write through JSON.parse + JSON.stringify, deleting
    // every one of them with no warning -- while `yaw-mcp try`, writing the
    // SAME files, preserved them.
    const clientPath = join(synthHome, ".claude.json");
    const original = [
      "{",
      "  // keep me: pinned for the design review",
      '  "model": "claude-opus-4-7",',
      '  "mcpServers": {',
      "    /* the spend server is scoped to the finance workspace */",
      '    "spend": { "url": "https://x" }',
      "  }",
      "}",
      "",
    ].join("\n");
    writeFileSync(clientPath, original, "utf8");

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);

    const after = readFileSync(clientPath, "utf8");
    expect(after).toContain("// keep me: pinned for the design review");
    expect(after).toContain("/* the spend server is scoped to the finance workspace */");
    // ...and the entry actually landed, next to what was already there.
    const parsed = parseJsonc(after) as {
      model: string;
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.model).toBe("claude-opus-4-7");
    expect(parsed.mcpServers.spend).toEqual({ url: "https://x" });
    expect(parsed.mcpServers[ENTRY_NAME]).toBeDefined();
  });

  it("keeps comments in settings.json when patching permissions.allow", async () => {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    const original = [
      "{",
      "  // team baseline -- do not reorder",
      '  "permissions": { "allow": ["Bash(git *)"] }',
      "}",
      "",
    ].join("\n");
    writeFileSync(settingsPath, original, "utf8");

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);

    const after = readFileSync(settingsPath, "utf8");
    expect(after).toContain("// team baseline -- do not reorder");
    const allow = (parseJsonc(after) as { permissions: { allow: string[] } }).permissions.allow;
    expect(allow).toEqual(["Bash(git *)", CLAUDE_CODE_ALLOW_PATTERN]);
  });

  // POSIX-only: Windows does not carry these mode bits.
  it.skipIf(process.platform === "win32")(
    "does not widen an owner-only client config to the umask default",
    async () => {
      // atomicWriteFile renames a NEW inode over the target, so install used to
      // hand a 0600 ~/.claude.json back at 0644 -- including one `yaw-mcp try`
      // had chmod'd 0600 because it holds an inline API key, which install then
      // rewrites (it deliberately carries a prior entry's env forward).
      const clientPath = join(synthHome, ".claude.json");
      writeFileSync(
        clientPath,
        JSON.stringify({ mcpServers: { "yaw-mcp-try-demo": { command: "npx", env: { API_KEY: "s" } } } }),
        { mode: 0o600 },
      );
      const cap = captureIo();
      const r = await runInstall({
        clientId: "claude-code",
        scope: "user",
        os: "linux",
        home: synthHome,
        force: true,
        io: cap.io,
        oamProbe: OAM_ABSENT,
      });
      expect(r.exitCode).toBe(0);
      expect(statSync(clientPath).mode & 0o777).toBe(0o600);
      // The secret-bearing trial entry is still in the file it was protecting.
      const client = JSON.parse(readFileSync(clientPath, "utf8"));
      expect(client.mcpServers["yaw-mcp-try-demo"].env.API_KEY).toBe("s");
    },
  );
});

describe("runInstall — legacy allow-patterns are never stripped", () => {
  function seedSettings(allow: string[]): string {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow } }), "utf8");
    return settingsPath;
  }

  it("keeps mcp__yaw_mcp__* while the legacy `yaw-mcp` entry is still wired", async () => {
    // install does NOT remove the legacy mcpServers entry -- it only warns
    // that it "remains". Stripping its allow-pattern in the same run revoked
    // a still-running server's grant, so Claude Code re-prompted on every one
    // of its tool calls until the user deleted the entry by hand.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "yaw-mcp": { command: "npx", args: ["-y", "@yawlabs/mcp"] } } }),
      "utf8",
    );
    const settingsPath = seedSettings(["Bash(git *)", "mcp__yaw_mcp__*"]);

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    // The warning still fires -- the entry is what should go, not the grant.
    expect(cap.stdout()).toMatch(/legacy "yaw-mcp" entry remains/);
    const allow = (JSON.parse(readFileSync(settingsPath, "utf8")) as { permissions: { allow: string[] } }).permissions
      .allow;
    expect(allow).toContain("mcp__yaw_mcp__*");
    expect(allow).toContain(CLAUDE_CODE_ALLOW_PATTERN);
  });

  it("leaves mcp__yaw_mcp__* in place at user scope even when the file being written has no legacy entry", async () => {
    // ~/.claude/settings.json is GLOBAL: its allow-list also covers a legacy
    // `yaw-mcp` entry wired in some repo's .mcp.json (project scope) or under
    // another project's local scope -- containers a user-scope install never
    // reads. The old rule stripped the pattern whenever the ONE container this
    // run writes lacked the entry, which revoked that still-running server's
    // grant and made Claude Code re-prompt on every one of its tool calls: the
    // same regression the previous test guards, one scope over. So install
    // never strips. The stale ENTRY still gets its "remove it" note; the
    // pattern goes when the user deletes the entry it serves.
    writeFileSync(join(synthHome, ".claude.json"), JSON.stringify({ mcpServers: {} }), "utf8");
    const settingsPath = seedSettings(["Bash(git *)", "mcp__yaw_mcp__*"]);

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const allow = (JSON.parse(readFileSync(settingsPath, "utf8")) as { permissions: { allow: string[] } }).permissions
      .allow;
    expect(allow).toEqual(["Bash(git *)", "mcp__yaw_mcp__*", CLAUDE_CODE_ALLOW_PATTERN]);
  });
});

describe("runInstall — project-scope approval note (claude-code)", () => {
  // Claude Code gates .mcp.json servers behind a one-time per-project
  // approval prompt (enabledMcpjsonServers / disabledMcpjsonServers in
  // ~/.claude.json). "Restart it" alone strands the user: they restart, see
  // no server, and have no pointer to the actual gate.
  it("tells the user to approve the .mcp.json server, not just restart", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "project",
      os: "linux",
      home: synthHome,
      projectDir: synthCwd,
      cwd: synthCwd,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const out = cap.stdout();
    expect(out).toMatch(/Done: Claude Code is configured\./);
    expect(out).toMatch(/approve/);
    expect(out).toMatch(/\.mcp\.json/);
  });

  it("user scope keeps the plain restart instruction (no approval gate there)", async () => {
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const out = cap.stdout();
    expect(out).toMatch(/Restart it to pick up the new MCP server\./);
    expect(out).not.toMatch(/approve/);
  });
});

describe("runInstall — cwd override drives project-scope writes", () => {
  it("resolves project scope against opts.cwd, not process.cwd()", async () => {
    // `cwd` is documented as the cwd override and --list honors it, but the
    // write path read process.cwd() directly -- so a call that looked hermetic
    // created .vscode/mcp.json in whatever directory the runner was in.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "vscode",
      scope: "project",
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(synthCwd, ".vscode", "mcp.json"))).toBe(true);
    expect(r.written).toContain(join(synthCwd, ".vscode", "mcp.json"));
  });
});

describe("runInstall — returned messages match what was printed", () => {
  it("--all carries the deprecation notice and the aggregate lines, not just the sub-installs", async () => {
    const cap = captureIo();
    const r = await runInstall({
      all: true,
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      token: "mcp_pat_all_aaaa",
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    const trail = r.messages.join("\n");
    // Emitted by the --all layer itself; a second, locally-built array dropped
    // every one of these while the user saw them all on stdout/stderr.
    expect(trail).toContain(TOKEN_FLAG_DEPRECATION);
    // Pinned ASCII, both glyphs -- see CLIENT_HEADER_LINE. install renders the
    // ellipsis as `...` and the header separator as `--` today, for the
    // Windows-console mojibake reason documented at oam-spawn.ts:285-287.
    // Accepting the box-drawing spelling alongside pinned neither: the code
    // could revert to `──` / `…` with the suite still green.
    expect(trail).toMatch(/Installing into \d+ clients?\.\.\./);
    expect(trail).toMatch(/^-- claude-code \(user\) --$/m);
    expect(trail).toMatch(/Done: \d+\/\d+ clients installed successfully\./);
    // ...and still carries each sub-install's own trail.
    expect(trail).toContain(`Wrote ${join(synthHome, ".claude.json")}`);
  });

  it("--list carries the deprecation notice alongside the table", async () => {
    const cap = captureIo();
    const r = await runInstall({
      listOnly: true,
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      token: "mcp_pat_list_aaaa",
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    const trail = r.messages.join("\n");
    expect(trail).toContain(TOKEN_FLAG_DEPRECATION);
    expect(trail).toContain("CLIENT");
  });
});

describe("readEntryAt", () => {
  it("returns the entry, or null for every shape that is not one", () => {
    const cfg = { mcpServers: { [ENTRY_NAME]: { command: "npx", env: { A: "1" } } } };
    expect(readEntryAt(cfg, ["mcpServers"], ENTRY_NAME)?.env).toEqual({ A: "1" });
    // Absent container, absent entry, and non-object shapes must all be null
    // rather than throw: these come from a user-editable config file.
    expect(readEntryAt({}, ["mcpServers"], ENTRY_NAME)).toBeNull();
    expect(readEntryAt({ mcpServers: {} }, ["mcpServers"], ENTRY_NAME)).toBeNull();
    expect(readEntryAt({ mcpServers: [] }, ["mcpServers"], ENTRY_NAME)).toBeNull();
    expect(readEntryAt({ mcpServers: "nope" }, ["mcpServers"], ENTRY_NAME)).toBeNull();
    expect(readEntryAt({ mcpServers: { [ENTRY_NAME]: "nope" } }, ["mcpServers"], ENTRY_NAME)).toBeNull();
    expect(readEntryAt({ mcpServers: { [ENTRY_NAME]: [] } }, ["mcpServers"], ENTRY_NAME)).toBeNull();
  });
});

describe("mergePermissionsAllow — non-string entries", () => {
  it("keeps non-string elements of a pre-existing allow array", () => {
    // The filter used to type-narrow to string, so anything else a user (or a
    // future Claude Code schema) had put in permissions.allow was DELETED on
    // the next install -- the opposite of what the surrounding code promises.
    const existing = { permissions: { allow: ["Bash(git *)", { rule: "custom" }, 7, ["nested"]] } };
    const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
    expect((merged.permissions as { allow: unknown[] }).allow).toEqual([
      "Bash(git *)",
      { rule: "custom" },
      7,
      ["nested"],
      CLAUDE_CODE_ALLOW_PATTERN,
    ]);
  });

  it("keeps a legacy pattern sitting beside a non-string element, in place and in order", () => {
    // Neither the legacy string (never stripped -- see the unit test above)
    // nor the non-string neighbour is touched; our pattern is appended.
    const existing = { permissions: { allow: ["mcp__yaw_mcp__*", { rule: "custom" }] } };
    const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
    expect((merged.permissions as { allow: unknown[] }).allow).toEqual([
      "mcp__yaw_mcp__*",
      { rule: "custom" },
      CLAUDE_CODE_ALLOW_PATTERN,
    ]);
  });

  it("a mixed-type allow array survives a real install", async () => {
    const settingsDir = join(synthHome, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      join(settingsDir, "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(git *)", { rule: "custom" }] } }),
    );

    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);

    const settings = JSON.parse(readFileSync(join(settingsDir, "settings.json"), "utf8"));
    expect(settings.permissions.allow).toEqual(["Bash(git *)", { rule: "custom" }, CLAUDE_CODE_ALLOW_PATTERN]);
  });
});

describe("runInstall — Runtime line ordering", () => {
  it("refuses a malformed client config WITHOUT first claiming a runtime", async () => {
    // The oam probe and its whole Runtime log chain used to run before the
    // target file was read, so a broken ~/.claude.json produced
    // "Runtime: node (oam is not installed...)" and THEN "not valid JSON ...
    // Refusing" -- a runtime claim for a write that never happened.
    writeFileSync(join(synthHome, ".claude.json"), "{ this is not json");
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toMatch(/not valid JSON/);
    // Nothing is written, so nothing describes a runtime.
    expect(r.messages.join("\n")).not.toMatch(/Runtime:/);
    expect(cap.stdout()).not.toMatch(/Runtime:/);
  });

  it("refuses a collision WITHOUT first claiming a runtime", async () => {
    // The malformed-JSON case above is only one of the refusals the Runtime
    // chain used to precede. A collision refusal is the one a user actually
    // meets repeatedly -- re-running install from a script or an agent shell
    // (non-TTY) with an entry already in place -- and it produced the same
    // shape: "Runtime: will run on oam ..." (or "Runtime: node (...)") above
    // "already has a ... entry and stdin is not a TTY".
    const initial = JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "npx" } } }, null, 2);
    writeFileSync(join(synthHome, ".claude.json"), initial);
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stderr()).toMatch(/stdin is not a TTY/);
    expect(r.messages.join("\n")).not.toMatch(/Runtime:/);
    expect(cap.stdout()).not.toMatch(/Runtime:/);
    expect(readFileSync(join(synthHome, ".claude.json"), "utf8")).toBe(initial);
  });

  it("leaves an entry alone under --skip WITHOUT describing the entry it did not write", async () => {
    // Same class, exit 0: --skip writes nothing, so a Runtime line here
    // describes the entry that WOULD have been written rather than the one
    // left in place -- which is the reverse of what the transcript implies.
    const initial = JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "npx" } } }, null, 2);
    writeFileSync(join(synthHome, ".claude.json"), initial);
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      skip: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toContain(`Existing "${ENTRY_NAME}" entry left untouched.`);
    expect(r.messages.join("\n")).not.toMatch(/Runtime:/);
    expect(cap.stdout()).not.toMatch(/Runtime:/);
    expect(readFileSync(join(synthHome, ".claude.json"), "utf8")).toBe(initial);
  });

  it("still prints the Runtime line on a run that goes on to write", async () => {
    // The move must not cost the line on the normal path.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "claude-code",
      scope: "user",
      os: "linux",
      home: synthHome,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.stdout()).toMatch(/Runtime: node \(oam is not installed/);
  });
});

describe("runInstall --list — display + flag handling", () => {
  it("renders the tilde separator of the LISTED os, not the host platform", async () => {
    // `install --list --os linux` on Windows used to print `~\.claude.json`:
    // the row's path came from the listed os while its separator came from
    // process.platform, so one row described two machines.
    const listedOs = process.platform === "win32" ? "linux" : "windows";
    const cap = captureIo();
    const r = await runInstall({
      os: listedOs,
      home: synthHome,
      cwd: synthCwd,
      listOnly: true,
      io: cap.io,
    });
    expect(r.exitCode).toBe(0);
    const out = cap.stdout();
    const expected = listedOs === "windows" ? "~\\" : "~/";
    const wrong = listedOs === "windows" ? "~/" : "~\\";
    expect(out).toContain(expected);
    expect(out).not.toContain(wrong);

    // A MULTI-SEGMENT row, not just the two-char prefix. `absolute` is built
    // with node:path on the host, so normalizing only the leading separator
    // still left `~/.cursor\mcp.json` -- which satisfies the prefix
    // assertions above while being a shape neither OS uses.
    const cursorRow = listedOs === "windows" ? "~\\.cursor\\mcp.json" : "~/.cursor/mcp.json";
    expect(out).toContain(cursorRow);
  });
});

describe("parseInstallArgs — --list and write-decision flags", () => {
  it("refuses --list combined with --force or --skip", () => {
    // Same silent-ignore class as --all --scope: runInstallList never writes a
    // file, so it never consults either flag, and an accepted-then-dropped flag
    // reads as honored.
    for (const flag of ["--force", "--skip"]) {
      const r = parseInstallArgs(["--list", flag]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(flag);
    }
  });

  it("still accepts --list --dry-run (the documented cross-OS preview spelling)", () => {
    const r = parseInstallArgs(["--list", "--dry-run"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.listOnly).toBe(true);
  });
});

describe("runInstall — --project-dir resolution", () => {
  it("resolves a RELATIVE --project-dir against opts.cwd, not process.cwd()", async () => {
    // The one place project resolution ignored the cwd override: `resolve(rel)`
    // is resolve-against-process.cwd(), so a hermetic caller passing both cwd
    // and a relative --project-dir got a path in the runner's directory.
    // --dry-run so the assertion is about the RESOLVED path, with no write.
    const cap = captureIo();
    const r = await runInstall({
      clientId: "vscode",
      scope: "project",
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      projectDir: "nested-proj",
      dryRun: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(r.wouldWrite).toContain(join(synthCwd, "nested-proj", ".vscode", "mcp.json"));
    expect(r.wouldWrite.join("|")).not.toContain(join(process.cwd(), "nested-proj"));
  });
});

describe("runInstall --all — an all-refused run", () => {
  // Both user-scope clients (claude-code, cursor) already carry an entry, and
  // stdin is not a TTY with no --force/--skip: every sub-install refuses.
  const seedBothColliding = (): void => {
    const seeded = { mcpServers: { [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp"] } } };
    writeFileSync(join(synthHome, ".claude.json"), JSON.stringify(seeded), "utf8");
    mkdirSync(join(synthHome, ".cursor"), { recursive: true });
    writeFileSync(join(synthHome, ".cursor", "mcp.json"), JSON.stringify(seeded), "utf8");
  };

  it("returns a trail with only the CONSOLIDATED refusal, not the swallowed per-client ones", async () => {
    // The per-client stderr shim suppresses each sub-install's refusal, but the
    // sub-install had already pushed it into its own `messages`, and those were
    // spliced into the parent trail wholesale -- so the returned trail carried N
    // lines the user never saw, plus the consolidated line, while `messages` is
    // documented as exactly what was printed.
    seedBothColliding();
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      all: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    const refusals = r.messages.filter((m) => /stdin is not a TTY/.test(m));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain("--all --force");
    // The trail matches the transcript: one refusal on each side.
    expect(cap.stderr().split("stdin is not a TTY").length - 1).toBe(1);
  });

  it("does not print the oam-absent runtime tip when nothing was written", async () => {
    // The note is advice ABOUT the entries a run produced. After an all-refused
    // run there are none, so it landed directly above the collision hint and the
    // failure summary as a tip for entries that do not exist.
    seedBothColliding();
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      all: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.stdout()).not.toContain(OAM_INSTALL_SH);
  });

  it("DOES print the oam-absent tip on a fully successful --all --skip run", async () => {
    // The other side of the gate above, and the case that had no coverage: a
    // client that already has an entry is a SUCCESS that writes nothing, so
    // both aggregate lists are empty. Gating on those alone made the tip
    // vanish from exactly the run where every entry it describes is present
    // and about to be used -- and the per-client copies are suppressed on
    // --all, so it disappeared entirely rather than merely being duplicated.
    seedBothColliding();
    const cap = captureIo();
    const r = await runInstall({
      os: "linux",
      home: synthHome,
      cwd: synthCwd,
      all: true,
      skip: true,
      io: cap.io,
      oamProbe: OAM_ABSENT,
    });
    expect(r.exitCode).toBe(0);
    expect(r.written).toHaveLength(0);
    expect(cap.stdout()).toContain(OAM_INSTALL_SH);
  });
});
