import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// uv-bootstrap -- network layer tests
//
// Covers fetchWithRedirects (via ensureUv / resolveUv) and the
// sha256 checksum verification step in resolveUv. Lives in its own
// file (like uv-bootstrap-fixes.test.ts) because it needs
// module-level vi.mock for undici and node:child_process; those
// mocks would collide with the "uv present" tests in the main
// uv-bootstrap.test.ts which rely on real spawn to probe PATH.
// ═══════════════════════════════════════════════════════════════════════

vi.mock("../logger.js", () => ({ log: vi.fn() }));

// Point cacheDir() at a throwaway temp dir so the cached-binary short-circuit
// in resolveUv (a non-empty finalBin stat) never finds a real cached binary
// from a previous developer bootstrap and skips the download path.
vi.mock("../paths.js", () => {
  const nodeOs = require("node:os");
  const nodePath = require("node:path");
  return {
    cacheDir: () => nodePath.join(nodeOs.tmpdir(), "yaw-mcp-uvbn-test-cache"),
  };
});

// Mock undici so we control every request() call without touching the network.
// Individual tests configure the mock via vi.mocked(request).mockImplementation.
vi.mock("undici", () => ({
  request: vi.fn(),
}));

// Mock node:child_process so onPath("uv") always returns false -- we want
// to exercise the download path, not the PATH-hit short-circuit.
// spawnSync is also stubbed so the "uv present" describe (in the other
// test file) would skip, though it is not loaded here at all.
vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  return {
    spawn: (_cmd: string, _args: unknown, _opts: unknown) => {
      const fake = new EventEmitter();
      fake.kill = () => {};
      setImmediate(() => fake.emit("error", new Error("ENOENT (mocked)")));
      return fake;
    },
    spawnSync: () => ({ status: 1 }),
  };
});

import { request } from "undici";
import { __resetUvBootstrap, ensureUv, UV_VERSION, uvTarget } from "../uv-bootstrap.js";

// ── helpers ──────────────────────────────────────────────────────────────

// Build a minimal fake undici response object that resolveUv / fetchWithRedirects
// can consume. The body needs arrayBuffer() and dump() methods.
function fakeResponse(
  statusCode: number,
  bodyBytes: Buffer,
  headers: Record<string, string> = {},
): {
  statusCode: number;
  headers: Record<string, string>;
  body: { arrayBuffer: () => Promise<ArrayBuffer>; dump: () => Promise<void> };
} {
  return {
    statusCode,
    headers,
    body: {
      arrayBuffer: () =>
        Promise.resolve(
          bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer,
        ),
      dump: () => Promise.resolve(),
    },
  };
}

// ── shared setup ─────────────────────────────────────────────────────────

const mockRequest = vi.mocked(request);
const TEMP_CACHE = path.join(os.tmpdir(), "yaw-mcp-uvbn-test-cache");

beforeEach(() => {
  __resetUvBootstrap();
  mockRequest.mockReset();
});

afterEach(async () => {
  __resetUvBootstrap();
  await fs.rm(TEMP_CACHE, { recursive: true, force: true }).catch(() => {});
});

// ── install dir keying: version AND target triple ─────────────────────────

describe("resolveUv install dir keying", () => {
  it("keys the install dir by uv/<version>/<target-triple>, not version alone", async () => {
    // Version-only keying shared one binary across architectures: on Windows
    // 11 ARM64 an x64 Node bootstrapped x86_64 uv.exe and a later arm64 Node
    // reused it (emulated, not native). resolveUv mkdirs installDir BEFORE
    // the download starts, so a failed fetch still leaves the key path on
    // disk for this test to assert on.
    mockRequest.mockRejectedValue(new Error("network mocked out"));
    await ensureUv().catch(() => {});

    const target = uvTarget();
    expect(target).not.toBeNull();
    const st = await fs.stat(path.join(TEMP_CACHE, "uv", UV_VERSION, target as string));
    expect(st.isDirectory()).toBe(true);
  });
});

// ── sha256 checksum mismatch ──────────────────────────────────────────────

describe("resolveUv checksum mismatch", () => {
  it("throws with 'checksum mismatch' when the downloaded archive sha256 does not match", async () => {
    const archiveBody = Buffer.from("fake-archive-bytes");
    // Compute the CORRECT sha256 of a DIFFERENT buffer so the check fails.
    const wrongHash = createHash("sha256").update(Buffer.from("different-content")).digest("hex");
    const shaBody = Buffer.from(`${wrongHash}  uv-x86_64-pc-windows-msvc.zip\n`);

    // resolveUv calls fetchWithRedirects twice: the .sha256 sidecar, then the
    // archive. Keyed on the URL rather than queued positionally, so the test
    // asserts the checksum gate and not the fetch order: a positional queue
    // handed the archive bytes to the sidecar fetch once the order changed,
    // and the "mismatch" it produced was between two wrong operands.
    mockRequest.mockImplementation((url: unknown) =>
      Promise.resolve(fakeResponse(200, String(url).endsWith(".sha256") ? shaBody : archiveBody) as never),
    );

    const err = await ensureUv().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("checksum mismatch");
  });
});

// ── fetch order: the sidecar first, so a missing sidecar costs no archive ──

describe("resolveUv fetch order", () => {
  it("fetches the .sha256 sidecar before the archive, so a missing sidecar never starts the download", async () => {
    // A Promise.all over both let the tiny sidecar 404 (the shape of a
    // UV_VERSION bump that outruns Astral's upload) while the 18-23 MB archive
    // download carried on into memory with nothing to abort it -- each fetch
    // arms its own AbortSignal.timeout and nothing cancelled the survivor.
    // Sequential sidecar-first turns that into one small failed request.
    const seen: string[] = [];
    mockRequest.mockImplementation((url: unknown) => {
      seen.push(String(url));
      return Promise.resolve(fakeResponse(String(url).endsWith(".sha256") ? 404 : 200, Buffer.alloc(0)) as never);
    });

    const err = await ensureUv().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("failed: HTTP 404");
    // Exactly one request, and it was the sidecar: the archive never started.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/\.sha256$/);
  });
});

// ── fetchWithRedirects: redirect following ────────────────────────────────

describe("fetchWithRedirects redirect following", () => {
  it("follows a 302 and returns the body from the final 200 response", async () => {
    const finalBody = Buffer.from("real-archive-content");
    // The CORRECT sha256 of finalBody so the checksum check passes and we
    // can confirm that fetchWithRedirects actually returned the right buffer.
    const correctHash = createHash("sha256").update(finalBody).digest("hex");
    const shaBody = Buffer.from(`${correctHash}  archive.zip\n`);

    // URL-keyed, NOT a positional mockResolvedValueOnce chain: resolveUv
    // fetches the .sha256 sidecar and then the archive, and a positional queue
    // bakes that order into the mock -- when the two ran concurrently under
    // Promise.all, the sha fetch consumed the queued archive 200 and the
    // checksum never passed, so the very thing this test is named for went
    // unasserted. Keying on the URL makes each fetch get its own response, and
    // only the FIRST archive-URL hit redirects (the CDN target does not end in
    // .sha256 either, so it correctly falls through to the archive branch).
    let archiveHits = 0;
    mockRequest.mockImplementation((url: unknown) => {
      if (String(url).endsWith(".sha256")) return Promise.resolve(fakeResponse(200, shaBody) as never);
      archiveHits++;
      return Promise.resolve(
        archiveHits === 1
          ? (fakeResponse(302, Buffer.alloc(0), { location: "https://cdn.example.com/uv.zip" }) as never)
          : (fakeResponse(200, finalBody) as never),
      );
    });

    // The checksum gate sits directly downstream of the redirect follow, so
    // "the rejection is NOT a checksum mismatch" is what proves the final 200's
    // body came back intact -- an earlier hop's body or an empty buffer hashes
    // differently and trips the gate. What actually fails here is the extract
    // step: this file's spawn mock ENOENTs every child, so ensureUv rejects
    // with that raw error, which resolveUv does not wrap.
    const err = await ensureUv().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("checksum mismatch");

    // The sidecar is fetched first, then the archive, so the calls are:
    //   shaUrl -> 200
    //   archiveUrl -> 302
    //   redirect Location -> 200 (archive follow-through)
    expect(mockRequest).toHaveBeenCalledTimes(3);
    const urls = mockRequest.mock.calls.map((c) => (c as [string, ...unknown[]])[0]);
    expect(urls[0]).toMatch(/\.sha256$/);
    expect(urls).toContain("https://cdn.example.com/uv.zip");
  });
});

// ── fetchWithRedirects: too many redirects ────────────────────────────────

describe("fetchWithRedirects too many redirects", () => {
  it("throws 'Too many redirects' after 5 consecutive 302 responses", async () => {
    // Return a 302 with a fresh location every time so fetchWithRedirects
    // keeps following until it exhausts the maxHops (5) cap.
    mockRequest.mockImplementation((_url: unknown) =>
      Promise.resolve(fakeResponse(302, Buffer.alloc(0), { location: "https://redir.example.com/next" }) as never),
    );

    const err = await ensureUv().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Too many redirects");
  });
});

// ── fetchWithRedirects: 302 with no Location header ───────────────────────

describe("fetchWithRedirects missing Location header", () => {
  it("throws when a 302 response has no Location header", async () => {
    // URL-keyed so the concurrent sha fetch gets a well-formed 200 of its own.
    // A single queued response left the sha fetch awaiting `undefined` and
    // dying on a TypeError, so the asserted rejection only won by racing --
    // here the Location-less 302 is the only thing that can reject.
    const shaBody = Buffer.from(`${"0".repeat(64)}  archive.zip\n`);
    mockRequest.mockImplementation((url: unknown) =>
      Promise.resolve(
        String(url).endsWith(".sha256")
          ? (fakeResponse(200, shaBody) as never)
          : (fakeResponse(302, Buffer.alloc(0)) as never),
      ),
    );

    const err = await ensureUv().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Redirect without Location header");
  });
});

// ── fetchWithRedirects: non-200 status ────────────────────────────────────

describe("fetchWithRedirects non-200 status", () => {
  it("throws 'failed: HTTP 404' when the release asset is missing", async () => {
    // The likeliest real-world download failure: a UV_VERSION bump lands
    // before Astral publishes the asset, or the triple has no asset at all.
    mockRequest.mockImplementation(() => Promise.resolve(fakeResponse(404, Buffer.alloc(0)) as never));

    const err = await ensureUv().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("failed: HTTP 404");
  });
});

// ── fetchWithRedirects: undici idle timeouts -> one clear message ──────────

describe("fetchWithRedirects timeout mapping", () => {
  it.each([
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ])("maps %s to the 'uv download timed out' message", async (code) => {
    // undici's headersTimeout/bodyTimeout surface as coded errors; both must
    // come out as one actionable message rather than a raw undici code.
    mockRequest.mockImplementation(() => {
      const undiciErr = new Error("undici timeout (mocked)") as Error & { code: string };
      undiciErr.code = code;
      return Promise.reject(undiciErr);
    });

    const err = await ensureUv().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("uv download timed out");
  });
});
