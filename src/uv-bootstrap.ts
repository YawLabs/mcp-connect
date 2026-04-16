import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { request } from "undici";
import { log } from "./logger.js";
import { cacheDir } from "./paths.js";

// Ship the default catalog on the premise that "if mcph runs, every
// server in Explore runs." That means we have to handle Python-based
// servers (fetch, sqlite, time, sentry) without forcing users to
// install `uv` first. On first encounter with a `uv`/`uvx` command
// we fetch Astral's standalone `uv` binary into our cache and spawn
// from there.
//
// Lazy: nothing happens until a Python server is actually added.
// Memoized: concurrent Python server activations share one download.
// Verified: we fetch the `.sha256` alongside the archive and refuse
// to install on mismatch — protects against in-transit tampering and
// partial downloads. A compromise of Astral's release pipeline itself
// is out of scope; users who need that guarantee pre-install `uv`.

const UV_VERSION = "0.11.7";
const RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;

// uv target triples per (platform, arch). Left null for combinations
// Astral doesn't publish a binary for — callers get a clear error
// rather than a silently-wrong download.
function uvTarget(): string | null {
  const { platform, arch } = process;
  if (platform === "win32") {
    if (arch === "x64") return "x86_64-pc-windows-msvc";
    if (arch === "arm64") return "aarch64-pc-windows-msvc";
    if (arch === "ia32") return "i686-pc-windows-msvc";
    return null;
  }
  if (platform === "darwin") {
    if (arch === "arm64") return "aarch64-apple-darwin";
    if (arch === "x64") return "x86_64-apple-darwin";
    return null;
  }
  if (platform === "linux") {
    if (arch === "x64") return "x86_64-unknown-linux-gnu";
    if (arch === "arm64") return "aarch64-unknown-linux-gnu";
    return null;
  }
  return null;
}

function binName(): string {
  return process.platform === "win32" ? "uv.exe" : "uv";
}

function archiveExt(): "zip" | "tar.gz" {
  return process.platform === "win32" ? "zip" : "tar.gz";
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Resolve a bare command against PATH. Runs the binary with
// `--version` and considers exit 0 as "present." Faster and more
// portable than rolling our own PATH walk (which has to cope with
// PATHEXT on Windows and symlinks on Unix). 3s cap guards against a
// wedged shim.
async function onPath(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, ["--version"], {
        stdio: "ignore",
        shell: false,
        windowsHide: process.platform === "win32",
      });
    } catch {
      settle(false);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      settle(false);
    }, 3_000);
    timer.unref?.();

    child.on("error", () => {
      clearTimeout(timer);
      settle(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      settle(code === 0);
    });
  });
}

// GitHub release URLs redirect to objects.githubusercontent.com.
// undici doesn't follow redirects by default — walk up to 5 hops.
async function fetchWithRedirects(url: string, maxHops = 5): Promise<Buffer> {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const res = await request(current, { method: "GET" });
    if (res.statusCode >= 300 && res.statusCode < 400) {
      const loc = res.headers.location;
      if (!loc) throw new Error(`Redirect without Location header from ${current}`);
      current = Array.isArray(loc) ? loc[0] : loc;
      await res.body.dump();
      continue;
    }
    if (res.statusCode !== 200) {
      await res.body.dump();
      throw new Error(`GET ${current} failed: HTTP ${res.statusCode}`);
    }
    return Buffer.from(await res.body.arrayBuffer());
  }
  throw new Error(`Too many redirects starting at ${url}`);
}

// Shell out to the system's archive tools rather than adding a tar/
// zip dependency. tar is present on every Unix and on Windows 10
// 1803+; Expand-Archive is the Windows zip path.
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  if (process.platform === "win32") {
    await runCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ]);
  } else {
    await runCommand("tar", ["-xzf", archivePath, "-C", destDir]);
  }
}

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: process.platform === "win32",
    });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
    });
  });
}

// Walk the extracted tree to find the uv binary. Astral's archives
// put it inside a `uv-<target>/` subdir, but we don't hard-code the
// exact name in case they restructure — searching is cheap.
async function findBinary(root: string, name: string): Promise<string | null> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) {
      const found = await findBinary(full, name);
      if (found) return found;
    }
  }
  return null;
}

let pending: Promise<string> | null = null;

// Return the absolute path to a `uv` binary, or the literal "uv" if
// the user already has it on PATH. Memoized so simultaneous Python
// server activations share one download. Throws on unsupported
// platforms or download/verify failures so `upstream.ts` can wrap the
// error into an ActivationError with a useful message.
export function ensureUv(): Promise<string> {
  pending ??= resolveUv();
  return pending;
}

async function resolveUv(): Promise<string> {
  if (await onPath("uv")) return "uv";

  const target = uvTarget();
  if (!target) {
    throw new Error(
      `No prebuilt uv binary for ${process.platform}/${process.arch}. Install uv manually: https://docs.astral.sh/uv/`,
    );
  }

  const installDir = path.join(cacheDir(), "uv", UV_VERSION);
  const finalBin = path.join(installDir, binName());
  if (await exists(finalBin)) return finalBin;

  await fs.mkdir(installDir, { recursive: true });
  log("info", "Bootstrapping uv", { version: UV_VERSION, target, cache: installDir });

  const archiveName = `uv-${target}.${archiveExt()}`;
  const archiveUrl = `${RELEASE_BASE}/${archiveName}`;
  const shaUrl = `${archiveUrl}.sha256`;

  const [archiveBuf, shaBuf] = await Promise.all([fetchWithRedirects(archiveUrl), fetchWithRedirects(shaUrl)]);

  const expected = shaBuf.toString("utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(archiveBuf).digest("hex");
  if (!expected || expected.toLowerCase() !== actual.toLowerCase()) {
    throw new Error(`uv archive checksum mismatch (expected ${expected}, got ${actual})`);
  }

  const archivePath = path.join(installDir, archiveName);
  await pipeline(async function* () {
    yield archiveBuf;
  }, createWriteStream(archivePath));

  const extractDir = path.join(installDir, "extract");
  await fs.rm(extractDir, { recursive: true, force: true });
  await extractArchive(archivePath, extractDir);

  const extracted = await findBinary(extractDir, binName());
  if (!extracted) throw new Error(`uv binary not found inside ${archiveName}`);

  await fs.rename(extracted, finalBin);
  await fs.chmod(finalBin, 0o755).catch(() => {}); // no-op on Windows
  await fs.rm(extractDir, { recursive: true, force: true });
  await fs.rm(archivePath, { force: true });

  log("info", "uv bootstrap complete", { bin: finalBin });
  return finalBin;
}

// Rewrite a spawn target so uv/uvx resolves to our managed binary
// when the user doesn't have it. Returns the (possibly new) command +
// args to hand to StdioClientTransport. No-op for any other command.
//
// Historical note: we used to pass `uvx` through unchanged when `uv`
// was found on PATH, assuming uvx ships alongside. That assumption
// broke on Windows when a user installed uv via a path that didn't
// extend PATHEXT to uvx.exe (or only dropped uv.exe somewhere), so
// `spawn("uvx", ...)` hit `'uvx' is not recognized` from cmd.exe and
// activation failed. Since `uvx ARGS` is documented as sugar for
// `uv tool run ARGS`, we ALWAYS rewrite uvx to the canonical form
// using whichever `uv` we have — PATH or bootstrapped. That makes the
// actual spawn target always `uv`, which we've already verified is
// reachable (either because onPath("uv") said so, or we just
// downloaded it).
export async function resolveUvSpawn(command: string, args: string[]): Promise<{ command: string; args: string[] }> {
  if (command !== "uv" && command !== "uvx") return { command, args };

  const uvBin = await ensureUv();

  if (command === "uvx") {
    // Always rewrite to `uv tool run`. Works regardless of whether
    // uvBin is the literal "uv" (PATH) or an absolute path
    // (bootstrapped cache). Avoids requiring uvx.exe separately.
    return { command: uvBin, args: ["tool", "run", ...args] };
  }

  // command === "uv" — pass through. uvBin is either "uv" (PATH) or
  // the absolute path to our managed binary; either way, the spawn
  // target resolves correctly.
  return { command: uvBin, args };
}

// Test hook — resets the memoized promise so a unit test can exercise
// multiple code paths within one process.
export function __resetUvBootstrap(): void {
  pending = null;
}
