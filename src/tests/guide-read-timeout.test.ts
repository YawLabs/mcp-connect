import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Replace ONLY createReadStream. The stream it hands back never emits a byte
// and never ends -- a hung NFS mount, from readGuide's point of view -- but it
// honours the abort signal exactly the way node's own fs stream does
// (addAbortSignal -> destroy(AbortError)), so the code under test sees the
// same ABORT_ERR it would see on the real thing. Everything else in node:fs
// stays real; guide.ts imports nothing else from it.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { PassThrough, addAbortSignal } = await import("node:stream");
  return {
    ...actual,
    createReadStream: (_path: unknown, opts?: { signal?: AbortSignal }) => {
      const s = new PassThrough();
      if (opts?.signal) addAbortSignal(opts.signal, s);
      return s;
    },
  };
});

import { loadUserGuide } from "../guide.js";

describe("readGuide -- the read timeout", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-guide-timeout-"));
    // The assertion below reads a warn line off stderr; logger.ts resolves
    // LOG_LEVEL per call, so an operator shell that exports LOG_LEVEL=error
    // would silence the line and fail the test for a reason unrelated to the
    // code under test (paths.test.ts pins it the same way).
    vi.stubEnv("LOG_LEVEL", "warn");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("returns null and logs the TIMEOUT warning, not the generic unreadable one, when the read hangs", async () => {
    // The branch relies on node wrapping `ac.abort(reason)` as an AbortError
    // with code ABORT_ERR. Nothing pinned that: a refactor that destroyed the
    // stream with the reason directly would have routed a hung disk into
    // "Guide exists but could not be read" and lost the one word that tells
    // the user what to look at.
    const warned: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      warned.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const pending = loadUserGuide(home);
      // GUIDE_READ_TIMEOUT_MS is 1000; the fake clock is the only thing that
      // can end this read, which is what makes the test deterministic.
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toBeNull();
    } finally {
      process.stderr.write = orig;
    }
    const joined = warned.join("");
    expect(joined).toContain("Guide read timed out");
    expect(joined).not.toContain("could not be read");
  });
});
