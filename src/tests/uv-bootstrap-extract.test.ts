import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// uv-bootstrap -- extractArchive win32 path-validation tests (coverage gaps 12/13)
//
// extractArchive() is win32-only and reached only through ensureUv() ->
// resolveUv(). It builds a PowerShell `Expand-Archive -Command` string from
// archivePath + destDir, both derived from cacheDir(). Its guard hard-rejects
// paths containing a CR/LF or a Unicode smart-quote (U+2018/2019/201A/201B);
// its -Command builder escapes an ASCII apostrophe (' -> '') so a username
// like O'Brien is handled safely rather than rejected. (Both live in
// extractArchive's win32 branch; line numbers are deliberately not cited.)
//
// Both gaps require process.platform === 'win32'. Everything external is
// mocked (spawn, undici, cacheDir), so these run on every platform -- they
// are NOT skipped on a non-win32 host, and nothing here is gated on a runner
// (this repo ships no CI workflows; the gates are local). We stub
// process.platform/arch via Object.defineProperty (same technique the
// unsupported-platform test in uv-bootstrap-fixes.test.ts uses).
//
// Own file (like the sibling uv-bootstrap-*.test.ts) because it needs a
// module-level vi.mock for node:child_process whose spawn distinguishes the
// onPath("uv") probe (must fail) from the extractArchive powershell.exe call
// (must resolve so we can capture the -Command string), plus a *controllable*
// cacheDir() mock so each test can inject an apostrophe- or smart-quote-bearing
// root. The sibling files' mocks are fixed and would not fit.
// ═══════════════════════════════════════════════════════════════════════

vi.mock("../logger.js", () => ({ log: vi.fn() }));

// cacheDir() is a vi.fn each test points at an apostrophe- or smart-quote-
// bearing root so the derived archivePath/destDir carry the char under test.
vi.mock("../paths.js", () => ({
  cacheDir: vi.fn(),
}));

// undici.request feeds resolveUv's download: a checksum-matching archive plus
// its .sha256 sidecar, so the checksum gate passes and control reaches
// extractArchive (the SUT for these gaps).
vi.mock("undici", () => ({
  request: vi.fn(),
}));

// spawn mock records every call. The onPath("uv") probe (cmd "uv") emits
// "error" so onPath returns false and resolveUv proceeds to the download +
// extract path. The extractArchive runCommand (cmd "powershell.exe") emits
// "close" 0 so runCommand resolves and we can assert the captured -Command.
//
// extractMode.materializeBinary additionally makes that mocked Expand-Archive
// drop a uv.exe into its -DestinationPath, so findBinary succeeds and control
// reaches the winner-takes-all rename underneath it (the rename-race tests at
// the bottom of this file). It stays OFF by default: the path-validation tests
// above depend on an EMPTY extract dir yielding "uv binary not found".
const spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
const extractMode = { materializeBinary: false };

vi.mock("node:child_process", () => {
  const { EventEmitter } = require("node:events");
  const nodeFs = require("node:fs");
  const nodePath = require("node:path");
  return {
    spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnCalls.push({ cmd, args: [...(args ?? [])], opts: { ...opts } });
      const fake = new EventEmitter();
      fake.kill = () => {};
      fake.stderr = new EventEmitter();
      fake.stdout = new EventEmitter();
      if (cmd === "powershell.exe") {
        if (extractMode.materializeBinary) {
          // Expand-Archive is mocked, so the destination stays empty unless we
          // put the archive's payload there ourselves.
          const dest = /-DestinationPath '(.+?)' -Force/.exec(String(args?.at(-1) ?? ""))?.[1];
          if (dest) {
            nodeFs.mkdirSync(dest, { recursive: true });
            nodeFs.writeFileSync(nodePath.join(dest, "uv.exe"), "extracted-uv-bytes");
          }
        }
        // runCommand success: exit 0.
        setImmediate(() => fake.emit("close", 0));
      } else {
        // onPath probe: ENOENT -> onPath returns false.
        setImmediate(() => fake.emit("error", new Error("ENOENT (mocked)")));
      }
      return fake;
    },
  };
});

import { request } from "undici";
import { cacheDir } from "../paths.js";
import { __resetUvBootstrap, ensureUv, UV_VERSION } from "../uv-bootstrap.js";

// ── helpers ──────────────────────────────────────────────────────────────

// Minimal fake undici response: body.arrayBuffer() + body.dump().
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

// Serve a checksum-matching archive for any URL, and the correct sha256
// sidecar for the *.sha256 URL, so resolveUv's checksum gate passes.
function serveGoodArchive(): void {
  const archiveBody = Buffer.from("fake-uv-archive-bytes-for-extract-test");
  const correctHash = createHash("sha256").update(archiveBody).digest("hex");
  const shaBody = Buffer.from(`${correctHash}  uv-x86_64-pc-windows-msvc.zip\n`);
  vi.mocked(request).mockImplementation((url: unknown) =>
    Promise.resolve(
      String(url).endsWith(".sha256")
        ? (fakeResponse(200, shaBody) as never)
        : (fakeResponse(200, archiveBody) as never),
    ),
  );
}

const mockCacheDir = vi.mocked(cacheDir);

// Both fixtures live under os.tmpdir(); afterEach removes them.
const APOSTROPHE_ROOT = path.join(os.tmpdir(), "yaw-mcp-O'Brien-extract-test");
// Third fixture root, for the rename-race tests at the bottom of the file.
const RENAME_ROOT = path.join(os.tmpdir(), "yaw-mcp-uv-rename-race-test");
// Smart-quote roots keyed by code point (built at use time to avoid literal
// smart-quote bytes floating in the file header).
function smartRoot(codePoint: number): string {
  return path.join(os.tmpdir(), `yaw-mcp-O${String.fromCharCode(codePoint)}Brien-smart-${codePoint.toString(16)}`);
}

// win32 stub scope. process.platform/arch are read at call time inside
// uv-bootstrap, so defining them before ensureUv() is enough.
let origPlatform: PropertyDescriptor | undefined;
let origArch: PropertyDescriptor | undefined;

function forceWin32(): void {
  origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  origArch = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  Object.defineProperty(process, "arch", { value: "x64", configurable: true });
}

function restorePlatform(): void {
  if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
  if (origArch) Object.defineProperty(process, "arch", origArch);
  origPlatform = undefined;
  origArch = undefined;
}

beforeEach(() => {
  spawnCalls.length = 0;
  extractMode.materializeBinary = false;
  __resetUvBootstrap();
  mockCacheDir.mockReset();
  vi.mocked(request).mockReset();
});

afterEach(async () => {
  restorePlatform();
  extractMode.materializeBinary = false;
  __resetUvBootstrap();
  // resolveUv writes/extracts under cacheDir()/uv/<version>; clean every root.
  await fs.rm(APOSTROPHE_ROOT, { recursive: true, force: true }).catch(() => {});
  await fs.rm(RENAME_ROOT, { recursive: true, force: true }).catch(() => {});
  for (const cp of [0x2018, 0x2019, 0x201a, 0x201b]) {
    await fs.rm(smartRoot(cp), { recursive: true, force: true }).catch(() => {});
  }
});

// ── Gap 12: ASCII apostrophe is allowed and reaches Expand-Archive ─────────
describe("extractArchive apostrophe path (gap 12)", () => {
  it("passes validation and calls runCommand with ' -> '' escaped Expand-Archive command", async () => {
    forceWin32();
    mockCacheDir.mockReturnValue(APOSTROPHE_ROOT);
    serveGoodArchive();

    // extractArchive resolves (powershell mock exits 0) but the extracted dir
    // is empty, so resolveUv then throws "uv binary not found" -- that is the
    // expected post-extract failure, NOT a validation rejection. Reaching it
    // proves the apostrophe path cleared the line-198 guard.
    const err = await ensureUv().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("uv binary not found");
    expect((err as Error).message).not.toContain("smart quote");

    const psCall = spawnCalls.find((c) => c.cmd === "powershell.exe");
    expect(psCall, "extractArchive should have invoked powershell.exe runCommand").toBeDefined();

    const command = (psCall as NonNullable<typeof psCall>).args.at(-1) as string;
    expect(command.startsWith("Expand-Archive -Path '")).toBe(true);
    // The ASCII apostrophe in "O'Brien" must be doubled to "O''Brien" in BOTH
    // the -Path and -DestinationPath quoted literals.
    expect(command).toContain("O''Brien");
    // And no single (un-doubled) "O'Brien" remains from the path segment.
    expect(command).not.toContain("O'Brien");
    // Sanity: it also carries the DestinationPath + -Force tail.
    expect(command).toContain("-DestinationPath '");
    expect(command).toContain("-Force");
  });
});

// ── Gap 13: Unicode smart-quote is rejected BEFORE runCommand ──────────────
describe("extractArchive smart-quote guard (gap 13)", () => {
  // U+2018 U+2019 U+201A U+201B -- every char the line-198 regex guards.
  // The label is carried alongside the code point rather than formatted from
  // it: a bare %s renders the NUMBER, so these titles used to read "U+8216"
  // .. "U+8219" (decimal) for the hex code points they name.
  it.each([
    { codePoint: 0x2018, hex: "2018" },
    { codePoint: 0x2019, hex: "2019" },
    { codePoint: 0x201a, hex: "201A" },
    { codePoint: 0x201b, hex: "201B" },
  ])("throws 'contains a newline or smart quote' and never spawns powershell for U+$hex", async ({ codePoint }) => {
    forceWin32();
    mockCacheDir.mockReturnValue(smartRoot(codePoint));
    serveGoodArchive();

    const err = await ensureUv().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("contains a newline or smart quote");

    // The guard fires before runCommand, so no powershell.exe spawn happened.
    const psCall = spawnCalls.find((c) => c.cmd === "powershell.exe");
    expect(psCall, "smart-quote path must not reach Expand-Archive").toBeUndefined();
  });
});

// ── Winner-takes-all rename: a lost race is success, an empty finalBin is not ─
//
// resolveUv's rename fallback is the only place a failed syscall is
// deliberately treated as success, and it was untested. It lives in THIS file
// because this is the only sibling whose spawn mock lets extractArchive
// succeed (powershell.exe exits 0), which is what makes the rename reachable
// at all; extractMode.materializeBinary supplies the extracted binary that
// findBinary must locate just above it.
describe("resolveUv rename race fallback", () => {
  // forceWin32() pins arch to x64, so the install dir is fully determined.
  const finalBinPath = (): string => path.join(RENAME_ROOT, "uv", UV_VERSION, "x86_64-pc-windows-msvc", "uv.exe");

  // The concurrent winner installs finalBin and is EXECUTING it, so Win32
  // refuses to replace the open image handle. Written from inside the mocked
  // rename on purpose: a finalBin present BEFORE ensureUv() would be taken by
  // resolveUv's cache-hit fast path and the rename would never run.
  function mockRenameLosingTo(contents: string) {
    return vi.spyOn(fs, "rename").mockImplementation(async () => {
      const finalBin = finalBinPath();
      await fs.mkdir(path.dirname(finalBin), { recursive: true });
      await fs.writeFile(finalBin, contents);
      const err = new Error("EPERM: operation not permitted, rename") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
  }

  it("resolves to finalBin when the rename fails but a good binary is already there", async () => {
    forceWin32();
    mockCacheDir.mockReturnValue(RENAME_ROOT);
    serveGoodArchive();
    extractMode.materializeBinary = true;

    // Every racer verified the same UV_VERSION archive against the same
    // published sha256, so a non-empty finalBin is a good binary: the lost
    // race must read as success, not as a broken install.
    const renameSpy = mockRenameLosingTo("winner-installed-uv-bytes");
    try {
      await expect(ensureUv()).resolves.toBe(finalBinPath());
    } finally {
      renameSpy.mockRestore();
    }
  });

  it("rethrows the rename failure when finalBin is empty (nothing usable to fall back on)", async () => {
    forceWin32();
    mockCacheDir.mockReturnValue(RENAME_ROOT);
    serveGoodArchive();
    extractMode.materializeBinary = true;

    // A zero-byte finalBin is a truncated/failed install, not a race winner --
    // swallowing the error here would hand upstream.ts a path to an unusable
    // binary and turn a clear failure into an inscrutable spawn error later.
    const renameSpy = mockRenameLosingTo("");
    try {
      const err = await ensureUv().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("EPERM");
    } finally {
      renameSpy.mockRestore();
    }
  });
});
