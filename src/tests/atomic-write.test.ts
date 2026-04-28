import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFile } from "../atomic-write.js";

describe("atomicWriteFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcph-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes contents to a fresh path", async () => {
    const file = join(dir, "fresh.json");
    await atomicWriteFile(file, '{"a":1}');
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
  });

  it("creates parent directories recursively", async () => {
    const file = join(dir, "nested", "deeper", "file.json");
    await atomicWriteFile(file, '{"a":1}');
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
  });

  it("replaces an existing file in place", async () => {
    const file = join(dir, "existing.json");
    writeFileSync(file, '{"old":true}', "utf8");
    await atomicWriteFile(file, '{"new":true}');
    expect(readFileSync(file, "utf8")).toBe('{"new":true}');
  });

  it("leaves no orphan .tmp- siblings on success", async () => {
    const file = join(dir, "clean.json");
    await atomicWriteFile(file, "ok");
    const siblings = readdirSync(dir);
    expect(siblings).toEqual(["clean.json"]);
  });

  it("leaves the original file untouched and rethrows when the rename target is unwritable", async () => {
    // Simulate failure by passing a path whose parent is a regular file --
    // mkdir returns ok (it sees the existing 'parent'), but writeFile/
    // rename can't write through it. The original 'parent' file should
    // remain unchanged and no .tmp orphan should remain in the parent's
    // own directory.
    const blockingParent = join(dir, "block.txt");
    writeFileSync(blockingParent, "do not touch", "utf8");
    const target = join(blockingParent, "child.json"); // parent is a file, not a dir

    await expect(atomicWriteFile(target, "should fail")).rejects.toThrow();

    // Original blocking file is untouched.
    expect(readFileSync(blockingParent, "utf8")).toBe("do not touch");
    // No leaked tmp file in the test dir.
    const orphans = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(orphans).toEqual([]);
    // child.json was never created.
    expect(existsSync(target)).toBe(false);
  });
});
