import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CachedGrade } from "../grades-cache.js";
import { gradesCachePath, readGradesCache, writeGrade } from "../grades-cache.js";
import { CONFIG_DIRNAME } from "../paths.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write grades.json directly into the synthetic home dir. */
function writeGradesFile(home: string, content: string): void {
  const dir = join(home, CONFIG_DIRNAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "grades.json"), content, "utf8");
}

const VALID_ENTRY: CachedGrade = {
  grade: "A",
  score: 97.7,
  gradedAt: "2026-06-11T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let synthHome: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-grades-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// gradesCachePath
// ---------------------------------------------------------------------------

describe("gradesCachePath", () => {
  it("returns <home>/.yaw-mcp/grades.json", () => {
    expect(gradesCachePath("/Users/test")).toBe(join("/Users/test", CONFIG_DIRNAME, "grades.json"));
  });
});

// ---------------------------------------------------------------------------
// readGradesCache
// ---------------------------------------------------------------------------

describe("readGradesCache -- ENOENT (first run)", () => {
  it("returns an empty map when grades.json does not exist", async () => {
    const result = await readGradesCache(synthHome);
    expect(result).toEqual({});
  });
});

describe("readGradesCache -- valid file", () => {
  it("parses and returns entries from a well-formed grades.json", async () => {
    writeGradesFile(
      synthHome,
      JSON.stringify({
        ctxlint: VALID_ENTRY,
        github: { grade: "B", score: 83.0, gradedAt: "2026-06-10T12:00:00.000Z" },
      }),
    );

    const result = await readGradesCache(synthHome);
    expect(Object.keys(result).sort()).toEqual(["ctxlint", "github"]);
    expect(result.ctxlint).toEqual(VALID_ENTRY);
    expect(result.github).toEqual({ grade: "B", score: 83.0, gradedAt: "2026-06-10T12:00:00.000Z" });
  });

  it("drops individual entries that are malformed, preserving valid ones", async () => {
    writeGradesFile(
      synthHome,
      JSON.stringify({
        good: VALID_ENTRY,
        bad: { grade: "Z", score: 0, gradedAt: "2026-01-01T00:00:00.000Z" },
      }),
    );

    const result = await readGradesCache(synthHome);
    expect(Object.keys(result)).toEqual(["good"]);
    expect(result.good).toEqual(VALID_ENTRY);
  });
});

describe("readGradesCache -- corrupt JSON", () => {
  it("returns an empty map when grades.json contains invalid JSON", async () => {
    writeGradesFile(synthHome, "{ this is not valid json !!");
    const result = await readGradesCache(synthHome);
    expect(result).toEqual({});
  });

  it("returns an empty map when grades.json root is a non-object (e.g. array)", async () => {
    writeGradesFile(synthHome, JSON.stringify([{ grade: "A", score: 100, gradedAt: "2026-01-01T00:00:00.000Z" }]));
    const result = await readGradesCache(synthHome);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// validateEntry (exercised through readGradesCache)
// ---------------------------------------------------------------------------

describe("validateEntry -- exercised via readGradesCache", () => {
  const cases: Array<{ label: string; entry: unknown }> = [
    { label: "missing grade", entry: { score: 90, gradedAt: "2026-01-01T00:00:00.000Z" } },
    { label: "invalid grade letter", entry: { grade: "E", score: 90, gradedAt: "2026-01-01T00:00:00.000Z" } },
    { label: "missing score", entry: { grade: "A", gradedAt: "2026-01-01T00:00:00.000Z" } },
    { label: "non-finite score (NaN)", entry: { grade: "A", score: NaN, gradedAt: "2026-01-01T00:00:00.000Z" } },
    { label: "missing gradedAt", entry: { grade: "A", score: 90 } },
    { label: "empty gradedAt string", entry: { grade: "A", score: 90, gradedAt: "" } },
    { label: "null entry", entry: null },
    { label: "array entry", entry: [1, 2, 3] },
    // Score is a 0-100 percentage; anything outside that is corrupt.
    { label: "negative score", entry: { grade: "A", score: -5, gradedAt: "2026-01-01T00:00:00.000Z" } },
    { label: "score above 100", entry: { grade: "A", score: 1e9, gradedAt: "2026-01-01T00:00:00.000Z" } },
    { label: "score just above 100", entry: { grade: "A", score: 100.1, gradedAt: "2026-01-01T00:00:00.000Z" } },
  ];

  for (const { label, entry } of cases) {
    // validateEntry returns CachedGrade | null, never a boolean -- name the
    // observable instead: the namespace is absent from the map readGradesCache
    // hands back.
    it(`drops the entry for: ${label}`, async () => {
      writeGradesFile(synthHome, JSON.stringify({ ns: entry }));
      const result = await readGradesCache(synthHome);
      expect(result).toEqual({});
    });
  }

  it("keeps entries at both ends of the 0-100 score range", async () => {
    writeGradesFile(
      synthHome,
      JSON.stringify({
        floor: { grade: "F", score: 0, gradedAt: "2026-06-01T00:00:00.000Z" },
        ceiling: { grade: "A", score: 100, gradedAt: "2026-06-01T00:00:00.000Z" },
      }),
    );
    const result = await readGradesCache(synthHome);
    expect(result.floor?.score).toBe(0);
    expect(result.ceiling?.score).toBe(100);
  });

  it("keeps a valid entry whose grade letter is lowercased in JSON", async () => {
    // grade.toUpperCase() is applied inside validateEntry -- lowercase input should work
    writeGradesFile(synthHome, JSON.stringify({ ns: { grade: "b", score: 75, gradedAt: "2026-06-01T00:00:00.000Z" } }));
    const result = await readGradesCache(synthHome);
    expect(result.ns).toEqual({ grade: "B", score: 75, gradedAt: "2026-06-01T00:00:00.000Z" });
  });
});

// ---------------------------------------------------------------------------
// writeGrade
// ---------------------------------------------------------------------------

describe("writeGrade -- add new entry", () => {
  it("writes a new namespace entry to grades.json and returns the path", async () => {
    const path = await writeGrade("ctxlint", VALID_ENTRY, synthHome);

    expect(path).toBe(gradesCachePath(synthHome));

    const disk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(disk.ctxlint).toEqual(VALID_ENTRY);
  });

  it("adds to an existing cache without losing prior entries", async () => {
    const firstEntry: CachedGrade = { grade: "B", score: 80, gradedAt: "2026-06-01T00:00:00.000Z" };
    writeGradesFile(synthHome, JSON.stringify({ existing: firstEntry }));

    await writeGrade("new-ns", VALID_ENTRY, synthHome);

    const disk = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")) as Record<string, unknown>;
    expect(disk.existing).toEqual(firstEntry);
    expect(disk["new-ns"]).toEqual(VALID_ENTRY);
  });

  it("overwrites an existing entry for the same namespace", async () => {
    const old: CachedGrade = { grade: "C", score: 70, gradedAt: "2026-01-01T00:00:00.000Z" };
    writeGradesFile(synthHome, JSON.stringify({ ctxlint: old }));

    await writeGrade("ctxlint", VALID_ENTRY, synthHome);

    const disk = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")) as Record<string, unknown>;
    expect(disk.ctxlint).toEqual(VALID_ENTRY);
  });
});

describe("writeGrade -- concurrent writes (serialization)", () => {
  it("two simultaneous writeGrade calls do not lose either entry", async () => {
    const entryA: CachedGrade = { grade: "A", score: 99, gradedAt: "2026-06-11T00:00:00.000Z" };
    const entryB: CachedGrade = { grade: "B", score: 80, gradedAt: "2026-06-11T01:00:00.000Z" };

    // Fire both writes concurrently without await between them so they both
    // contend for the lock before either read-modify-write starts.
    await Promise.all([writeGrade("ns-a", entryA, synthHome), writeGrade("ns-b", entryB, synthHome)]);

    const disk = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")) as Record<string, unknown>;
    expect(disk["ns-a"]).toEqual(entryA);
    expect(disk["ns-b"]).toEqual(entryB);
  });

  it("concurrent writes to different namespaces preserve all pre-existing entries", async () => {
    const pre: CachedGrade = { grade: "C", score: 70, gradedAt: "2026-01-01T00:00:00.000Z" };
    writeGradesFile(synthHome, JSON.stringify({ pre }));

    const newA: CachedGrade = { grade: "A", score: 95, gradedAt: "2026-06-11T02:00:00.000Z" };
    const newB: CachedGrade = { grade: "F", score: 42, gradedAt: "2026-06-11T03:00:00.000Z" };

    await Promise.all([writeGrade("new-a", newA, synthHome), writeGrade("new-b", newB, synthHome)]);

    const disk = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")) as Record<string, unknown>;
    expect(disk.pre).toEqual(pre);
    expect(disk["new-a"]).toEqual(newA);
    expect(disk["new-b"]).toEqual(newB);
  });
});

// ---------------------------------------------------------------------------
// writeGrade -- the cross-process lock
// ---------------------------------------------------------------------------

// Every production writeGrade runs in its own one-shot `yaw-mcp audit`
// process, so the writers that collide on grades.json are PROCESSES, not
// promises -- and the in-process chain this file used to test could not see a
// second process at all: both audits loaded the pre-write snapshot and the
// second rename dropped the first grade. The sidecar lock is what closes that.
// These cases drive it from the outside, as another process would: a lock
// file someone else holds, drops, or abandoned.
describe("writeGrade -- cross-process lock", () => {
  const lockPath = (home: string): string => `${gradesCachePath(home)}.lock`;

  it("waits for a lock another process holds, then merges onto what that process wrote", async () => {
    // The other audit holds the lock, publishes ITS grade while ours waits,
    // then releases. Pre-lock, our write ignored the sidecar, read the empty
    // cache and published {a} at once; the other process's {b} then landed
    // second and `a` was gone -- both audits having printed "Cached to".
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(lockPath(synthHome), "other-process\n");
    const ours = writeGrade("a", VALID_ENTRY, synthHome);
    await delay(150);
    // Still waiting: nothing published, and the holder's lock is untouched.
    expect(existsSync(gradesCachePath(synthHome))).toBe(false);
    expect(readFileSync(lockPath(synthHome), "utf8")).toBe("other-process\n");
    const other: CachedGrade = { grade: "B", score: 80, gradedAt: "2026-06-11T01:00:00.000Z" };
    writeGradesFile(synthHome, JSON.stringify({ b: other }));
    rmSync(lockPath(synthHome));
    await ours;
    const disk = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")) as Record<string, unknown>;
    expect(disk.a).toEqual(VALID_ENTRY);
    expect(disk.b).toEqual(other);
    // Released: nothing left behind for the next audit to wait on.
    expect(existsSync(lockPath(synthHome))).toBe(false);
  });

  it("steals a lock whose holder is gone (older than the stale age) instead of waiting on it", async () => {
    // An MCP client tearing the process tree down mid-audit leaves the lock
    // behind. Its age is the only evidence of abandonment; a lock that could
    // never be stolen would disable grade caching on this machine for good.
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(lockPath(synthHome), "dead-process\n");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath(synthHome), past, past);
    const started = Date.now();
    await writeGrade("gh", VALID_ENTRY, synthHome, { lockWaitMs: 5_000 });
    // Stolen at once -- not after sitting out the wait budget.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8")).gh).toEqual(VALID_ENTRY);
    // Neither the lock nor the renamed stale copy survives the steal.
    expect(existsSync(lockPath(synthHome))).toBe(false);
    expect(readdirSync(join(synthHome, CONFIG_DIRNAME)).filter((f) => f.includes(".lock"))).toEqual([]);
  });

  it("treats a lock dated further ahead of the clock than filesystem skew allows as stale too", async () => {
    // A clock stepped backwards between two runs leaves a lock no live process
    // on this clock could have written; honouring it would block every audit
    // until wall-clock caught up.
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(lockPath(synthHome), "future\n");
    const future = new Date(Date.now() + 60_000);
    utimesSync(lockPath(synthHome), future, future);
    await writeGrade("gh", VALID_ENTRY, synthHome, { lockWaitMs: 5_000 });
    expect(existsSync(lockPath(synthHome))).toBe(false);
  });

  it("gives up with a clear error when a live lock outlasts the wait budget, leaving the cache untouched", async () => {
    // A holder that is alive but slow is not stolen; past the budget the write
    // is refused rather than raced. audit-cmd reports that as exit 3 (grade
    // computed, cache not written), which one re-audit repairs.
    writeGradesFile(synthHome, JSON.stringify({ keep: VALID_ENTRY }));
    writeFileSync(lockPath(synthHome), "slow-process\n");
    await expect(writeGrade("gh", VALID_ENTRY, synthHome, { lockWaitMs: 200 })).rejects.toThrow(
      /locked by another yaw-mcp audit/,
    );
    expect(JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8"))).toEqual({ keep: VALID_ENTRY });
    // The holder's lock is still theirs.
    expect(readFileSync(lockPath(synthHome), "utf8")).toBe("slow-process\n");
  });

  it("leaves no lock behind after an ordinary write", async () => {
    await writeGrade("gh", VALID_ENTRY, synthHome);
    expect(existsSync(lockPath(synthHome))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readGradesCache -- a "__proto__" namespace
// ---------------------------------------------------------------------------

// Rebuilding the cache with plain assignment onto a fresh {} drops a
// "__proto__" key (assignment hits Object.prototype's inherited setter) and,
// because the value is an object, leaves the cache inheriting that entry's
// fields. See src/json-key.ts.
describe("readGradesCache -- a __proto__ namespace", () => {
  it("keeps it as an own property without touching the prototype", async () => {
    // Raw JSON text, not an object literal: `{ __proto__: ... }` in source
    // SETS the prototype rather than creating an own key -- the very bug
    // under test -- so a literal fixture would be empty and pass for the
    // wrong reason.
    writeGradesFile(
      synthHome,
      `{"__proto__":{"grade":"A","score":97.7,"gradedAt":"2026-06-11T00:00:00.000Z"},"ctxlint":${JSON.stringify(VALID_ENTRY)}}`,
    );

    const cache = await readGradesCache(synthHome);

    expect(Object.hasOwn(cache, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(cache)).toBe(Object.prototype);
    expect(cache.ctxlint).toEqual(VALID_ENTRY);
    // Without the fix the cache inherits the entry's fields, so a namespace
    // named "grade" resolves to a string instead of undefined.
    expect(cache.grade).toBeUndefined();
  });
});

describe("suiteVersion round-trip", () => {
  it("preserves suiteVersion through write and read", async () => {
    const entry = { grade: "A" as const, score: 99, gradedAt: "2026-08-23T00:00:00.000Z", suiteVersion: "0.17.1" };
    await writeGrade("ctxlint", entry, synthHome);
    const cache = await readGradesCache(synthHome);
    expect(cache.ctxlint).toEqual(entry);
  });

  it("keeps a legacy entry without suiteVersion valid, with the field absent", async () => {
    writeGradesFile(synthHome, JSON.stringify({ legacy: VALID_ENTRY }));
    const cache = await readGradesCache(synthHome);
    expect(cache.legacy).toEqual(VALID_ENTRY);
    expect("suiteVersion" in cache.legacy).toBe(false);
  });

  it("drops a malformed suiteVersion from the entry without dropping the entry", async () => {
    writeGradesFile(synthHome, JSON.stringify({ ctxlint: { ...VALID_ENTRY, suiteVersion: 17 } }));
    const cache = await readGradesCache(synthHome);
    expect(cache.ctxlint).toEqual(VALID_ENTRY);
    expect(cache.ctxlint.suiteVersion).toBeUndefined();
  });
});

describe("writeGrade -- read failures must not clobber the cache", () => {
  it("rejects (and leaves the path alone) when grades.json exists but cannot be read", async () => {
    // A DIRECTORY at the cache path makes readFile fail with EISDIR --
    // standing in for the transient EACCES/EBUSY handle class. The old
    // behavior treated ANY read failure as an empty cache and published a
    // one-entry file, silently destroying every other cached grade. The
    // strict read on the write path rethrows instead, which audit-cmd
    // reports as grade-computed-but-cache-write-failed (exit 3).
    const dirAtCachePath = gradesCachePath(synthHome);
    mkdirSync(dirAtCachePath, { recursive: true });
    await expect(writeGrade("gh", VALID_ENTRY, synthHome)).rejects.toThrow();
    // Still a directory -- nothing was renamed over it.
    expect(statSync(dirAtCachePath).isDirectory()).toBe(true);
  });

  it("still treats an absent file as an empty cache and creates it", async () => {
    await writeGrade("gh", VALID_ENTRY, synthHome);
    const parsed = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8"));
    expect(parsed.gh.grade).toBe("A");
  });
});

describe('writeGrade -- "__proto__" namespace', () => {
  it("persists it as an own key instead of invoking the inherited setter", async () => {
    // Mirrors the setJsonKey discipline the READ side already has: plain
    // assignment of "__proto__" would drop the grade from the serialized
    // file (JSON.stringify only sees own properties).
    writeGradesFile(synthHome, JSON.stringify({ gh: VALID_ENTRY }));
    await writeGrade("__proto__", VALID_ENTRY, synthHome);
    const parsed = JSON.parse(readFileSync(gradesCachePath(synthHome), "utf8"));
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value.grade).toBe("A");
    // The pre-existing entry survived the read-modify-write.
    expect(parsed.gh).toEqual(VALID_ENTRY);
  });
});
