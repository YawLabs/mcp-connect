import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIRNAME } from "../paths.js";
import { STATE_FILENAME, STATE_SCHEMA_VERSION, TOOLCACHE_TTL_MS } from "../persistence.js";
import { parseResetLearningArgs, RESET_LEARNING_USAGE, runResetLearning } from "../reset-learning-cmd.js";

// All tests use an isolated fake home dir so we never touch the real
// user's ~/.yaw-mcp/state.json. userConfigDir(home) joins home + ".yaw-mcp".
describe("runResetLearning", () => {
  let home: string;
  let yawMcpDir: string;
  let stateFile: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-reset-"));
    yawMcpDir = join(home, CONFIG_DIRNAME);
    stateFile = join(yawMcpDir, STATE_FILENAME);
    mkdirSync(yawMcpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function captureIO(): { out: string[]; err: string[]; push: (s: string) => void; pushErr: (s: string) => void } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      push: (s: string) => {
        out.push(s);
      },
      pushErr: (s: string) => {
        err.push(s);
      },
    };
  }

  it("reports nothing to reset when state.json does not exist", async () => {
    const io = captureIO();
    const r = await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(r.removed).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
    expect(io.out.join("")).toContain("no persisted state to reset");
    expect(io.out.join("")).toContain(stateFile);
    expect(io.err).toEqual([]);
  });

  it("removes an existing state.json and reports entry counts", async () => {
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: Date.now(),
      learning: {
        gh: { dispatched: 10, succeeded: 4, lastUsedAt: 100 },
        linear: { dispatched: 5, succeeded: 5, lastUsedAt: 200 },
      },
      packHistory: [
        { namespace: "gh", toolName: "listPrs", at: 300 },
        { namespace: "linear", toolName: "listIssues", at: 400 },
        { namespace: "slack", toolName: "sendMessage", at: 500 },
      ],
    };
    writeFileSync(stateFile, JSON.stringify(payload), "utf8");

    const io = captureIO();
    const r = await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });

    expect(r.exitCode).toBe(0);
    expect(r.removed).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
    const combined = io.out.join("");
    expect(combined).toContain("cleared persisted state");
    expect(combined).toContain("learning entries removed:     2");
    expect(combined).toContain("pack history entries removed: 3");
    expect(io.err).toEqual([]);
  });

  it("reports real counts for a BOM-prefixed state file (Notepad save), like loadState reads it", async () => {
    // persistence.ts strips U+FEFF before parsing, and the report's
    // classification rides on loadStateClassified -- the SAME read+parse
    // loadState performs. The regression this guards is the shape that
    // preceded it: a separate peek helper with its own bare JSON.parse, which
    // rejected the BOM, so a Notepad-saved state.json that loadState read FINE
    // was reported "contents unreadable" and its real counts thrown away.
    // Built in code -- never hand-type an escape into a fixture.
    const BOM = String.fromCharCode(0xfeff);
    writeFileSync(
      stateFile,
      `${BOM}${JSON.stringify({
        version: STATE_SCHEMA_VERSION,
        savedAt: 1,
        learning: {
          gh: { dispatched: 2, succeeded: 2, lastUsedAt: 1 },
          slack: { dispatched: 1, succeeded: 1, lastUsedAt: 1 },
        },
        packHistory: [{ namespace: "gh", toolName: "t", at: 1 }],
        toolCache: {},
      })}`,
      "utf8",
    );
    const io = captureIO();
    const r = await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(r.removed).toBe(true);
    const combined = io.out.join("");
    expect(combined).not.toContain("contents unreadable");
    expect(combined).toContain("learning entries removed:     2");
    expect(combined).toContain("pack history entries removed: 1");
  });

  // Regression: the report accounted for two of the v2 file's three
  // sections. The tool cache was deleted in silence, and every namespace
  // whose learned tool list went with it costs an extra upstream handshake
  // on the next session -- a consequence the person running the reset ought
  // to see before it surprises them.
  it("reports the tool-cache namespaces it deleted", async () => {
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: Date.now(),
      learning: { gh: { dispatched: 1, succeeded: 1, lastUsedAt: 1 } },
      packHistory: [],
      toolCache: {
        gh: { tools: [{ name: "list_prs" }, { name: "create_issue" }], learnedAt: Date.now() },
        linear: { tools: [{ name: "list_issues" }], learnedAt: Date.now() },
      },
    };
    writeFileSync(stateFile, JSON.stringify(payload), "utf8");
    const io = captureIO();
    const r = await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(r.removed).toBe(true);
    const combined = io.out.join("");
    // Namespaces, not tools: the cache is keyed per server.
    expect(combined).toContain("tool caches removed:          2");
    expect(combined).toContain("learning entries removed:     1");
  });

  it("reports a concrete 0 for a clean file with no tool cache at all (a v1 file)", async () => {
    writeFileSync(stateFile, JSON.stringify({ version: 1, savedAt: 1, learning: {}, packHistory: [] }), "utf8");
    const io = captureIO();
    const r = await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
    expect(r.removed).toBe(true);
    const combined = io.out.join("");
    expect(combined).not.toContain("contents unreadable");
    expect(combined).toContain("tool caches removed:          0");
  });

  it("counts what the FILE held, not what survived sanitization", async () => {
    // The report is about content the unlink destroyed, so it reads the
    // pre-sanitization counts. Two of the rows below never make it into the
    // loaded state -- the tool cache aged past TOOLCACHE_TTL_MS, the learning
    // row carries a hand-edited negative lastUsedAt -- but they were really in
    // the file and are really gone now. Counting the sanitized state instead
    // reported "0 removed" for a file that plainly held them.
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: Date.now(),
      learning: {
        gh: { dispatched: 1, succeeded: 1, lastUsedAt: 1 },
        handEdited: { dispatched: 3, succeeded: 1, lastUsedAt: -1 },
      },
      packHistory: [{ namespace: "gh", toolName: "listPrs", at: 1 }],
      toolCache: {
        expired: { tools: [{ name: "list_prs" }], learnedAt: Date.now() - TOOLCACHE_TTL_MS - 1000 },
      },
    };
    writeFileSync(stateFile, JSON.stringify(payload), "utf8");
    const io = captureIO();
    const r = await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
    expect(r.removed).toBe(true);
    const combined = io.out.join("");
    expect(combined).toContain("learning entries removed:     2");
    expect(combined).toContain("pack history entries removed: 1");
    expect(combined).toContain("tool caches removed:          1");
  });

  it("removes a malformed state file and reports it as unreadable (not 0 counts)", async () => {
    // loadState is tolerant and returns emptyState here; the unlink
    // still deletes the file, which is what we want — a corrupt state
    // file is exactly the kind of thing reset-learning should clear.
    // But reporting "0 entries removed" would be misleading: we never
    // got real counts, so we say the contents were unreadable instead.
    writeFileSync(stateFile, "{{not json", "utf8");
    const io = captureIO();
    const r = await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(r.removed).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
    const combined = io.out.join("");
    expect(combined).toContain("cleared persisted state (contents unreadable)");
    // Must NOT claim a concrete entry count it never read.
    expect(combined).not.toContain("learning entries removed:");
    expect(combined).not.toContain("pack history entries removed:");
  });

  it("removes a version-mismatched state file and reports it as unreadable", async () => {
    // A version bump drops the old state (loadState returns emptyState),
    // so the counts are 0/0 even though a non-trivial file existed.
    // Report it as unreadable rather than "0 entries removed".
    const payload = {
      version: STATE_SCHEMA_VERSION + 1,
      savedAt: Date.now(),
      learning: { gh: { dispatched: 9, succeeded: 1, lastUsedAt: 1 } },
      packHistory: [{ namespace: "gh", toolName: "listPrs", at: 2 }],
    };
    writeFileSync(stateFile, JSON.stringify(payload), "utf8");
    const io = captureIO();
    const r = await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(r.removed).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
    const combined = io.out.join("");
    expect(combined).toContain("cleared persisted state (contents unreadable)");
    expect(combined).not.toContain("learning entries removed:");
  });

  it("reports concrete 0/0 counts for a cleanly-parsed empty state file", async () => {
    // A well-formed current-version file with no entries is NOT
    // unreadable — it parsed fine, it just held nothing. The report
    // should show the concrete 0/0 counts, not the unreadable message.
    writeFileSync(
      stateFile,
      JSON.stringify({ version: STATE_SCHEMA_VERSION, savedAt: 1, learning: {}, packHistory: [] }),
      "utf8",
    );
    const io = captureIO();
    const r = await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(r.removed).toBe(true);
    const combined = io.out.join("");
    expect(combined).toContain("cleared persisted state.");
    expect(combined).not.toContain("contents unreadable");
    expect(combined).toContain("learning entries removed:     0");
    expect(combined).toContain("pack history entries removed: 0");
  });

  it("is a no-op when YAW_MCP_DISABLE_PERSISTENCE=1 (leaves the file alone)", async () => {
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: Date.now(),
      learning: { gh: { dispatched: 3, succeeded: 0, lastUsedAt: 1 } },
      packHistory: [],
    };
    writeFileSync(stateFile, JSON.stringify(payload), "utf8");

    const io = captureIO();
    const r = await runResetLearning({
      home,
      env: { YAW_MCP_DISABLE_PERSISTENCE: "1" },
      out: io.push,
      err: io.pushErr,
    });

    expect(r.exitCode).toBe(0);
    expect(r.removed).toBe(false);
    // Critical: file must still exist — opt-out is temporary, not destructive.
    expect(existsSync(stateFile)).toBe(true);
    const combined = io.out.join("");
    expect(combined).toContain("persistence is disabled");
    expect(combined).toContain("nothing to clear");
    // The line reaches a terminal, where a non-ASCII dash renders as mojibake
    // under a non-UTF-8 Windows console codepage. Checked on the one line
    // that carries no path, so a user-named tmpdir cannot trip it.
    const line = io.out.find((l) => l.includes("nothing to clear"));
    expect(line).toBeDefined();
    expect(line ?? "").toMatch(/^[\x20-\x7e\r\n]*$/);
  });

  it("also treats YAW_MCP_DISABLE_PERSISTENCE=true as disabled", async () => {
    writeFileSync(stateFile, "{}", "utf8");
    const io = captureIO();
    const r = await runResetLearning({
      home,
      env: { YAW_MCP_DISABLE_PERSISTENCE: "true" },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(r.removed).toBe(false);
    expect(existsSync(stateFile)).toBe(true);
  });

  it("treats YAW_MCP_DISABLE_PERSISTENCE empty string as not-disabled", async () => {
    // Matches the same logic as renderStateSection in doctor-cmd.ts:
    // unset OR empty string means the flag isn't active.
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: STATE_SCHEMA_VERSION,
        savedAt: 1,
        learning: {},
        packHistory: [],
      }),
      "utf8",
    );

    const io = captureIO();
    const r = await runResetLearning({
      home,
      env: { YAW_MCP_DISABLE_PERSISTENCE: "" },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(r.removed).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
  });

  it("persists the path in the result regardless of outcome", async () => {
    const io = captureIO();
    const r = await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
    expect(r.path).toBe(stateFile);
  });

  it("returns exit code 0 when the ~/.yaw-mcp dir itself is missing", async () => {
    // Fresh home with no ~/.yaw-mcp/ at all — the common case on a
    // brand-new install where the user is just poking at CLI commands.
    rmSync(yawMcpDir, { recursive: true, force: true });
    const io = captureIO();
    const r = await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(r.removed).toBe(false);
    expect(io.out.join("")).toContain("no persisted state to reset");
  });

  // The delete is a pure filesystem operation with no channel to a live
  // `yaw-mcp serve`, and serve re-saves its in-memory snapshot without ever
  // re-reading the file. Deleting state.json while a client is attached
  // therefore gets silently undone on the next proxied tool call, so the
  // success report has to say that out loud.
  describe("running-serve warning", () => {
    function writeState(): void {
      writeFileSync(
        stateFile,
        JSON.stringify({
          version: STATE_SCHEMA_VERSION,
          savedAt: 1,
          learning: { gh: { dispatched: 10, succeeded: 4, lastUsedAt: 100 } },
          packHistory: [],
        }),
        "utf8",
      );
    }

    it("warns that a running serve process will re-save its in-memory state", async () => {
      writeState();
      const io = captureIO();
      await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
      const combined = io.out.join("\n");
      expect(combined).toContain("running yaw-mcp serve");
      expect(combined).toContain("Restart your MCP client");
      // Counts must still be reported -- the warning is additive.
      expect(combined).toContain("learning entries removed:     1");
    });

    it("warns on the unreadable-contents path too", async () => {
      writeFileSync(stateFile, "{{not json", "utf8");
      const io = captureIO();
      await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
      const combined = io.out.join("\n");
      expect(combined).toContain("contents unreadable");
      expect(combined).toContain("Restart your MCP client");
    });

    it("stays silent when there was nothing to remove", async () => {
      const io = captureIO();
      await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
      expect(io.out.join("\n")).not.toContain("Restart your MCP client");
    });

    it("stays silent when persistence is disabled", async () => {
      writeState();
      const io = captureIO();
      await runResetLearning({
        home,
        env: { YAW_MCP_DISABLE_PERSISTENCE: "1" },
        out: io.push,
        err: io.pushErr,
      });
      expect(io.out.join("\n")).not.toContain("Restart your MCP client");
    });

    it("is documented in the usage text, not just the success report", () => {
      expect(RESET_LEARNING_USAGE).toContain("Restart your MCP client");
    });
  });

  it("preserves the state file contents until unlink succeeds (peek then delete ordering)", async () => {
    // Regression guard: report counts must come from the pre-delete
    // read. If the implementation ever flipped to delete-then-report,
    // the counts would always be 0.
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: 1,
      learning: {
        a: { dispatched: 1, succeeded: 1, lastUsedAt: 1 },
        b: { dispatched: 1, succeeded: 1, lastUsedAt: 1 },
        c: { dispatched: 1, succeeded: 1, lastUsedAt: 1 },
      },
      packHistory: [],
    };
    writeFileSync(stateFile, JSON.stringify(payload), "utf8");
    // Sanity: file is readable before we call reset.
    expect(readFileSync(stateFile, "utf8").length).toBeGreaterThan(0);

    const io = captureIO();
    const r = await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(io.out.join("")).toContain("learning entries removed:     3");
  });
});

describe("parseResetLearningArgs", () => {
  it("returns help kind for --help / -h (so dispatch never falls through to delete)", () => {
    expect(parseResetLearningArgs(["--help"]).kind).toBe("help");
    expect(parseResetLearningArgs(["-h"]).kind).toBe("help");
  });

  it("returns ok kind with empty options when no argv", () => {
    const r = parseResetLearningArgs([]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.options).toEqual({});
  });

  it("returns error kind on unknown flag, with usage hint", () => {
    const r = parseResetLearningArgs(["--bogus"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.error).toContain("--bogus");
      expect(r.error).toContain("Usage: yaw-mcp reset-learning");
    }
  });

  it("returns error kind on stray positional too", () => {
    const r = parseResetLearningArgs(["something"]);
    expect(r.kind).toBe("error");
  });

  it("decides solely on the first arg (zero-arg-only contract; argv[1..] are not inspected)", () => {
    // A help flag in position 0 wins regardless of trailing args.
    expect(parseResetLearningArgs(["--help", "extra", "--bogus"]).kind).toBe("help");
    // A non-help first arg errors on THAT arg; a later --help does not rescue it.
    const r = parseResetLearningArgs(["--bogus", "--help"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.error).toContain('"--bogus"');
      expect(r.error).not.toContain('"--help"');
    }
  });
});
