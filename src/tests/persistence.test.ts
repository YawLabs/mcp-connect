import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LearningStore } from "../learning.js";
import { PackDetector } from "../pack-detect.js";
import { STATE_SCHEMA_VERSION, emptyState, loadState, saveState } from "../persistence.js";

describe("persistence.loadState", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcph-state-"));
    file = join(dir, "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty state when file does not exist", async () => {
    const s = await loadState(file);
    expect(s).toEqual(emptyState());
  });

  it("parses a valid state file", async () => {
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: 123,
      learning: { gh: { dispatched: 4, succeeded: 3, lastUsedAt: 100 } },
      packHistory: [{ namespace: "gh", toolName: "listPrs", at: 101 }],
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    const s = await loadState(file);
    expect(s.learning.gh).toEqual({ dispatched: 4, succeeded: 3, lastUsedAt: 100 });
    expect(s.packHistory).toHaveLength(1);
    expect(s.packHistory[0]).toEqual({ namespace: "gh", toolName: "listPrs", at: 101 });
  });

  it("returns empty state on unparseable JSON", async () => {
    writeFileSync(file, "not json at all", "utf8");
    const s = await loadState(file);
    expect(s).toEqual(emptyState());
  });

  it("drops state with a version mismatch", async () => {
    const payload = {
      version: 99,
      savedAt: 0,
      learning: { gh: { dispatched: 1, succeeded: 1, lastUsedAt: 1 } },
      packHistory: [],
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    const s = await loadState(file);
    expect(s).toEqual(emptyState());
  });

  it("sanitizes invalid learning entries", async () => {
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: 0,
      learning: {
        good: { dispatched: 2, succeeded: 1, lastUsedAt: 10 },
        badNegative: { dispatched: -1, succeeded: 0, lastUsedAt: 0 },
        badMissingField: { dispatched: 1, succeeded: 1 },
        badType: "not an object",
        "": { dispatched: 1, succeeded: 1, lastUsedAt: 1 },
      },
      packHistory: [],
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    const s = await loadState(file);
    expect(Object.keys(s.learning)).toEqual(["good"]);
  });

  it("sanitizes invalid pack history entries", async () => {
    const payload = {
      version: STATE_SCHEMA_VERSION,
      savedAt: 0,
      learning: {},
      packHistory: [
        { namespace: "gh", toolName: "listPrs", at: 1 },
        { namespace: "", toolName: "x", at: 2 },
        { namespace: "y", toolName: "", at: 3 },
        { namespace: "z", toolName: "fn", at: "bad" },
        "not an object",
      ],
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    const s = await loadState(file);
    expect(s.packHistory).toHaveLength(1);
    expect(s.packHistory[0].namespace).toBe("gh");
  });
});

describe("persistence.saveState", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcph-state-"));
    file = join(dir, "nested", "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the target directory recursively", async () => {
    await saveState({ learning: {}, packHistory: [] }, file);
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(STATE_SCHEMA_VERSION);
  });

  it("writes with the current schema version and a timestamp", async () => {
    const before = Date.now();
    await saveState({ learning: {}, packHistory: [] }, file);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.version).toBe(STATE_SCHEMA_VERSION);
    expect(parsed.savedAt).toBeGreaterThanOrEqual(before);
  });

  it("round-trips learning + packHistory without loss", async () => {
    await saveState(
      {
        learning: { gh: { dispatched: 5, succeeded: 4, lastUsedAt: 200 } },
        packHistory: [
          { namespace: "gh", toolName: "listPrs", at: 1 },
          { namespace: "linear", toolName: "createIssue", at: 2 },
        ],
      },
      file,
    );
    const loaded = await loadState(file);
    expect(loaded.learning.gh).toEqual({ dispatched: 5, succeeded: 4, lastUsedAt: 200 });
    expect(loaded.packHistory).toHaveLength(2);
    expect(loaded.packHistory[0].namespace).toBe("gh");
    expect(loaded.packHistory[1].namespace).toBe("linear");
  });

  it("serializes concurrent saves so the later call's data wins on disk", async () => {
    const stateA = {
      learning: { gh: { dispatched: 1, succeeded: 1, lastUsedAt: 1 } },
      packHistory: [{ namespace: "gh", toolName: "a", at: 1 }],
    };
    const stateB = {
      learning: { linear: { dispatched: 9, succeeded: 9, lastUsedAt: 99 } },
      packHistory: [{ namespace: "linear", toolName: "b", at: 99 }],
    };
    await Promise.all([saveState(stateA, file), saveState(stateB, file)]);
    const loaded = await loadState(file);
    expect(loaded.learning).toEqual(stateB.learning);
    expect(loaded.packHistory).toEqual(stateB.packHistory);
    expect(loaded.learning.gh).toBeUndefined();
  });
});

describe("LearningStore snapshot round-trip", () => {
  it("export then load reproduces usage", () => {
    const a = new LearningStore();
    a.recordDispatch("gh");
    a.recordSuccess("gh");
    a.recordDispatch("linear");
    const snapshot = a.exportSnapshot();

    const b = new LearningStore();
    b.loadSnapshot(snapshot);
    expect(b.get("gh")?.dispatched).toBe(1);
    expect(b.get("gh")?.succeeded).toBe(1);
    expect(b.get("linear")?.dispatched).toBe(1);
    expect(b.get("linear")?.succeeded).toBe(0);
  });

  it("loadSnapshot replaces prior state", () => {
    const s = new LearningStore();
    s.recordDispatch("old");
    s.loadSnapshot({ fresh: { dispatched: 2, succeeded: 1, lastUsedAt: 99 } });
    expect(s.get("old")).toBeUndefined();
    expect(s.get("fresh")?.succeeded).toBe(1);
  });
});

describe("PackDetector snapshot round-trip", () => {
  it("export then load reproduces history", () => {
    const a = new PackDetector();
    a.recordCall("gh", "listPrs", 1);
    a.recordCall("linear", "createIssue", 2);
    const snapshot = a.exportSnapshot();

    const b = new PackDetector();
    b.loadSnapshot(snapshot);
    expect(b.getHistory()).toHaveLength(2);
    expect(b.getHistory()[0]).toEqual({ namespace: "gh", toolName: "listPrs", at: 1 });
  });

  it("loadSnapshot honors maxHistory cap — drops oldest", () => {
    const d = new PackDetector({ maxHistory: 3 });
    const oversized = [
      { namespace: "a", toolName: "t", at: 1 },
      { namespace: "b", toolName: "t", at: 2 },
      { namespace: "c", toolName: "t", at: 3 },
      { namespace: "d", toolName: "t", at: 4 },
      { namespace: "e", toolName: "t", at: 5 },
    ];
    d.loadSnapshot(oversized);
    const hist = d.getHistory();
    expect(hist).toHaveLength(3);
    expect(hist[0].namespace).toBe("c");
    expect(hist[2].namespace).toBe("e");
  });

  it("exported snapshot is a defensive copy", () => {
    const d = new PackDetector();
    d.recordCall("gh", "t", 1);
    const snap = d.exportSnapshot();
    snap[0].namespace = "tampered";
    expect(d.getHistory()[0].namespace).toBe("gh");
  });
});
