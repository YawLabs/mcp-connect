import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIRNAME } from "../paths.js";
import { STATE_FILENAME, STATE_SCHEMA_VERSION } from "../persistence.js";
import { runResetLearning } from "../reset-learning-cmd.js";

// All tests use an isolated fake home dir so we never touch the real
// user's ~/.mcph/state.json. userConfigDir(home) joins home + ".mcph".
describe("runResetLearning", () => {
  let home: string;
  let mcphDir: string;
  let stateFile: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mcph-reset-"));
    mcphDir = join(home, CONFIG_DIRNAME);
    stateFile = join(mcphDir, STATE_FILENAME);
    mkdirSync(mcphDir, { recursive: true });
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

  it("removes a malformed state file and reports 0 counts", async () => {
    // loadState is tolerant and returns emptyState here; the unlink
    // still deletes the file, which is what we want — a corrupt state
    // file is exactly the kind of thing reset-learning should clear.
    writeFileSync(stateFile, "{{not json", "utf8");
    const io = captureIO();
    const r = await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(r.removed).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
    const combined = io.out.join("");
    expect(combined).toContain("learning entries removed:     0");
    expect(combined).toContain("pack history entries removed: 0");
  });

  it("is a no-op when MCPH_DISABLE_PERSISTENCE=1 (leaves the file alone)", async () => {
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
      env: { MCPH_DISABLE_PERSISTENCE: "1" },
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
  });

  it("also treats MCPH_DISABLE_PERSISTENCE=true as disabled", async () => {
    writeFileSync(stateFile, "{}", "utf8");
    const io = captureIO();
    const r = await runResetLearning({
      home,
      env: { MCPH_DISABLE_PERSISTENCE: "true" },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(r.removed).toBe(false);
    expect(existsSync(stateFile)).toBe(true);
  });

  it("treats MCPH_DISABLE_PERSISTENCE empty string as not-disabled", async () => {
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
      env: { MCPH_DISABLE_PERSISTENCE: "" },
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

  it("returns exit code 0 when the ~/.mcph dir itself is missing", async () => {
    // Fresh home with no ~/.mcph/ at all — the common case on a
    // brand-new install where the user is just poking at CLI commands.
    rmSync(mcphDir, { recursive: true, force: true });
    const io = captureIO();
    const r = await runResetLearning({ home, env: {}, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(r.removed).toBe(false);
    expect(io.out.join("")).toContain("no persisted state to reset");
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
