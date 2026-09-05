import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { request } from "undici";
import { stripInternalSecretsFromEnv } from "./internal-secret-env.js";
import { log } from "./logger.js";
import { cacheDir } from "./paths.js";

// Ship the default catalog on the premise that "if yaw-mcp runs, every
// server in Explore runs." That means we have to handle Python-based
// servers (sqlite, time, sentry, and other uvx-launched entries)
// without forcing users to install `uv` first. On first encounter
// with a `uv`/`uvx` command we fetch Astral's standalone `uv` binary
// into our cache and spawn from there.
//
// Lazy: nothing happens until a Python server is actually added.
// Memoized: concurrent Python server activations share one download.
// Verified: we fetch the `.sha256` alongside the archive and refuse
// to install on mismatch — protects against in-transit tampering and
// partial downloads. A compromise of Astral's release pipeline itself
// is out of scope; users who need that guarantee pre-install `uv`.

/**
 * The uv release this bootstrap downloads.
 *
 * POLICY: this tracks the LATEST uv release (same policy as MIN_OAM_VERSION in
 * oam-spawn.ts -- bump it with every uv release we notice, not only when a
 * release happens to fix something this code hit). The install dir is keyed by
 * this constant, so a stale pin does not merely download an old build once --
 * it keeps every user on that build indefinitely, because the cached binary
 * short-circuits the download forever. There is no auto-upgrade hook; a human
 * editing this line is the only way the pin moves. Nothing else needs
 * updating on a bump: the sha256 is fetched alongside the archive from the
 * same release, so there are no hash constants to refresh.
 *
 * Exported for the test that pins the freshness floor.
 */
export const UV_VERSION = "0.12.10";
const RELEASE_BASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;

// glibc vs musl. Node's diagnostic report carries `glibcVersionRuntime` on
// every glibc build and omits it on musl (this is the same probe detect-libc
// and esbuild use). On any error, default to glibc: that keeps the common case
// working, and a wrong guess on actual musl fails exactly as loudly as the
// pre-detection behavior did.
//
// The probe answers for the HOST, so it is gated on the host actually BEING
// linux rather than on uvTarget's platform PARAMETER. On win32/darwin the
// field is absent too, which the report cannot distinguish from musl -- so
// uvTarget("linux", "x64") called from a Windows or Mac host (a cross-platform
// caller, or doctor describing another OS) came back with the -musl triple,
// derived from a libc reading that machine never had. Refusing to answer off
// linux keeps the default meaning "a real libc reading", and a caller who
// genuinely knows the target's libc still passes `musl` explicitly.
function isMuslLibc(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const raw: unknown = process.report?.getReport();
    const report = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    const header = (report as { header?: { glibcVersionRuntime?: unknown } } | null)?.header;
    return typeof header?.glibcVersionRuntime !== "string";
  } catch {
    return false;
  }
}

// uv target triples per (platform, arch). Left null for combinations
// Astral doesn't publish a binary for — callers get a clear error
// rather than a silently-wrong download. On Linux the triple also
// encodes the libc: Astral publishes separate -musl assets, and a
// glibc uv on Alpine dies with a loader error that reads as a broken
// MCP server rather than a wrong download.
//
// Parameters exist for tests (a win32 host cannot vary process.platform
// or its libc); production callers use the defaults.
export function uvTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = platform === "linux" && isMuslLibc(),
): string | null {
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
    const libc = musl ? "musl" : "gnu";
    if (arch === "x64") return `x86_64-unknown-linux-${libc}`;
    if (arch === "arm64") return `aarch64-unknown-linux-${libc}`;
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

// Resolve a bare command against PATH. Runs the binary with
// `--version` and considers exit 0 as "present." Faster and more
// portable than rolling our own PATH walk (which has to cope with
// PATHEXT on Windows and symlinks on Unix). 3s cap guards against a
// wedged shim. Exported for the timeout-path test; production callers
// stay inside this module.
export async function onPath(cmd: string): Promise<boolean> {
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
        // Windows needs a shell here so PATHEXT shims (uv.cmd / uv.bat)
        // resolve, and that MATCHES the real spawn: the SDK's
        // StdioClientTransport spawns through cross-spawn, which resolves
        // the bare name via PATHEXT and wraps a non-.exe/.com target in
        // `cmd.exe /d /s /c` itself. So a .cmd-only uv that passes this
        // probe DOES spawn at activation. A shell-less probe here was tried
        // and reverted: it false-NEGATIVED on that shim, sent every such
        // host to the ~20MB bootstrap download, and broke activation
        // outright on hosts with no route to github.com.
        shell: process.platform === "win32",
        windowsHide: process.platform === "win32",
        // uv is a binary yaw-mcp did not write; README promises the vault
        // passphrase is stripped from every child yaw-mcp starts.
        env: stripInternalSecretsFromEnv(process.env),
      });
    } catch {
      settle(false);
      return;
    }

    const timer = setTimeout(() => {
      // SIGKILL, not the SIGTERM default a trapping child ignores -- and on
      // win32 the shell:true wrapper means the kill lands on cmd.exe, not on
      // uv itself, so the kill alone proves nothing either way. unref is the
      // guarantee: a still-live child no longer holds the broker's event loop
      // open at shutdown. Mirrors runCommand below and spawnVersionProbe in
      // oam-spawn.ts.
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      try {
        child.unref();
      } catch {
        /* already gone */
      }
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
//
// Trade-off: the entire archive is buffered in memory before being
// written to disk (~20 MB for the uv binary today). This is a
// deliberate choice: sha256 verification (below) requires the full
// buffer to be in memory before we write anything, so streaming
// directly to disk would leave a partially-written, unverified file
// if the process is killed mid-download. The one-shot memory cost is
// acceptable given that this path runs at most once per uv version.
// undici's request() has no default headersTimeout/bodyTimeout, so a
// stalled GitHub CDN connection would hang ensureUv() (and thus first
// Python-server activation) indefinitely. Cap both at 30s and surface
// a clear "uv download timed out" error rather than blocking forever.
//
// Those two are IDLE timers (bodyTimeout resets on every chunk), so they
// do not bound a connection that trickles: a CDN delivering one byte per
// 29s would keep ensureUv pending for hours, and -- because upstream.ts
// awaits resolveUvSpawn BEFORE arming its connect timer, and ensureUv
// memoizes the pending promise -- that one wedged download would then be
// handed to every later uv/uvx activation for the life of the process.
// UV_FETCH_TOTAL_MS is the wall-clock bound on the whole download. Sized to
// the ARTIFACT, not to a fast link: the uv archives are 18-23 MB, so a
// 5-minute bound demanded ~0.6 Mbit/s sustained and killed slow-but-steady
// links (throttled hotspot, satellite, congested proxy) that used to finish
// in 10-20 min -- and because ensureUv clears its memo on rejection, every
// later activation re-burned the budget. 20 minutes still bounds the
// one-byte-per-29s wedge this exists for (that shape would take ~10 hours).
const UV_FETCH_TIMEOUT_MS = 30_000;
const UV_FETCH_TOTAL_MS = 20 * 60_000;

async function fetchWithRedirects(url: string, maxHops = 5): Promise<Buffer> {
  let current = url;
  const totalDeadline = AbortSignal.timeout(UV_FETCH_TOTAL_MS);
  for (let i = 0; i < maxHops; i++) {
    let res: Awaited<ReturnType<typeof request>>;
    try {
      res = await request(current, {
        method: "GET",
        headersTimeout: UV_FETCH_TIMEOUT_MS,
        bodyTimeout: UV_FETCH_TIMEOUT_MS,
        signal: totalDeadline,
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
        throw new Error(`uv download timed out after ${UV_FETCH_TIMEOUT_MS}ms (${current})`);
      }
      if (totalDeadline.aborted) {
        throw new Error(`uv download exceeded the ${UV_FETCH_TOTAL_MS}ms total budget (${current})`);
      }
      throw e;
    }
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
    try {
      return Buffer.from(await res.body.arrayBuffer());
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
        throw new Error(`uv download timed out after ${UV_FETCH_TIMEOUT_MS}ms (${current})`);
      }
      if (totalDeadline.aborted) {
        throw new Error(`uv download exceeded the ${UV_FETCH_TOTAL_MS}ms total budget (${current})`);
      }
      throw e;
    }
  }
  throw new Error(`Too many redirects starting at ${url}`);
}

// Shell out to the system's archive tools rather than adding a tar/
// zip dependency. tar is present on every Unix and on Windows 10
// 1803+; Expand-Archive is the Windows zip path.
async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  if (process.platform === "win32") {
    // SECURITY INVARIANT: archivePath and destDir MUST remain
    // non-user-controlled. Both derive from cacheDir() + fixed
    // ("uv"/UV_VERSION/archiveName/extract-<pid>-<ts>) segments -- no
    // user input flows in. The PowerShell -Command string below
    // single-quote-escapes them (' -> ''), which correctly handles any
    // apostrophe (a single-quoted PS literal treats only ' specially, and
    // doubling it is the canonical escape -- so a username like O'Brien is
    // fine). A CR/LF -- or a Unicode single-quote variant (U+2018/2019/201A/
    // 201B), which PowerShell also treats as a single-quoted-string delimiter
    // and the ASCII-only '' escaping above does NOT neutralize -- could still
    // break the -Command parse across the process boundary, so we hard-validate
    // against those and throw rather than build a command we can't prove
    // safe. If a future change ever routes user input into either path,
    // this guard must be revisited (proper arg-array escaping), not relaxed.
    for (const [label, p] of [
      ["archivePath", archivePath],
      ["destDir", destDir],
    ] as const) {
      if (/[\r\n‘’‚‛]/.test(p)) {
        throw new Error(
          `Refusing to extract uv archive: ${label} contains a newline or smart quote (${JSON.stringify(p)})`,
        );
      }
    }
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

// How long an extract child (tar / powershell Expand-Archive) gets before it is
// killed and the bootstrap fails.
//
// Everything else on this path is already bounded -- onPath's 3s probe,
// UV_FETCH_TIMEOUT_MS (idle) plus UV_FETCH_TOTAL_MS (wall-clock) on the
// download -- and this was the one hole left. A
// wedged extractor is not hypothetical: tar on a stalled network mount takes no
// signal at all, and the consequence here is worse than one slow activation.
// upstream.ts awaits resolveUvSpawn BEFORE it arms its own connect timeout, so
// a hang inside ensureUv never becomes an ActivationError and never expires;
// and because ensureUv memoizes, the same never-settling promise is then handed
// to every later uv/uvx activation for the life of the process. One wedged tar
// takes out every Python server, permanently.
//
// Generous on purpose: this budget is for one archive holding one binary
// (~20MB), where tar is sub-second and Expand-Archive is a few seconds on a
// cold PowerShell start. Two minutes is well clear of a slow-but-working
// machine, so expiry means genuinely stuck rather than merely slow.
export const UV_EXTRACT_TIMEOUT_MS = 120_000;

/** Cap on retained stderr, so a chatty failure cannot grow unboundedly in a
 *  message nobody reads past the first lines of. */
const RUN_COMMAND_MAX_STDERR = 8 * 1024;

/**
 * Run a child to completion, bounded.
 *
 * stdout is "ignore", not "pipe". Nothing here reads it, and an unread pipe is a
 * hang waiting to happen: an extractor that writes more than the pipe buffer
 * (tar -v, a PowerShell progress stream) blocks on write and never reaches
 * 'close'. Letting the OS discard it removes the failure mode rather than
 * managing it.
 *
 * On expiry the child is SIGKILLed -- not the SIGTERM default, which a child
 * that traps it simply ignores -- and the promise settles independently of
 * whether the kill lands, because the D-state case this timeout exists for
 * takes no signal at all. The timer is unref'd so a pending extract cannot hold
 * the process open at shutdown. Mirrors spawnVersionProbe in oam-spawn.ts.
 *
 * `timeoutMs` is a parameter so a test can exercise the deadline without
 * waiting two minutes.
 */
export function runCommand(cmd: string, args: string[], timeoutMs: number = UV_EXTRACT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        stdio: ["ignore", "ignore", "pipe"],
        shell: false,
        windowsHide: process.platform === "win32",
        // Same rule as the probe above: a child yaw-mcp did not write never
        // sees yaw-mcp's own secrets.
        env: stripInternalSecretsFromEnv(process.env),
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stderr = "";
    // A pipe 'error' with no listener is an uncaught exception that would take
    // the whole broker down, and the timeout path below destroys this pipe
    // while a wedged child may still be writing to it.
    child.stderr?.on("error", () => {});
    child.stderr?.on("data", (c: Buffer) => {
      if (stderr.length >= RUN_COMMAND_MAX_STDERR) return;
      stderr += c.toString("utf8").slice(0, RUN_COMMAND_MAX_STDERR - stderr.length);
    });
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code, signal) =>
      settle(() => {
        if (code === 0) resolve();
        // `code` is null when the child died on a signal; naming the signal is
        // the only diagnostic that case carries.
        else reject(new Error(`${cmd} exited ${code ?? signal}: ${stderr.trim()}`));
      }),
    );

    timer = setTimeout(() => {
      settle(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        // Detach, do not merely kill: a live child with an open pipe keeps the
        // PARENT's event loop alive, so settling the promise without this
        // trades an activation hang for a shutdown hang.
        try {
          child.stderr?.destroy();
          child.unref();
        } catch {
          /* already gone */
        }
        reject(new Error(`${cmd} did not finish within ${timeoutMs}ms`));
      });
    }, timeoutMs);
    timer.unref?.();
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
  if (!pending) {
    // Clear the memo on rejection so the next call retries rather than
    // returning the same rejected promise for the process lifetime.
    pending = resolveUv().catch((err: unknown) => {
      pending = null;
      return Promise.reject(err);
    });
  }
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

  // Keyed by version AND target triple. Version alone shared one binary
  // across architectures: on Windows 11 ARM64 an x64 Node bootstraps
  // x86_64 uv.exe and a later arm64 Node would reuse it (emulated, not
  // native); on Apple Silicon an `arch -x86_64 node` session would leave
  // the native session depending on Rosetta. The triple also encodes
  // linux libc, so a glibc cache entry can't shadow a musl one.
  const installDir = path.join(cacheDir(), "uv", UV_VERSION, target);
  const finalBin = path.join(installDir, binName());
  // Same predicate the race fallback below uses -- isFile() AND non-empty, not
  // a bare existence check. Nothing on this path ever invalidates the cache, so
  // a truncated (interrupted rename/copy) or non-regular finalBin accepted here
  // is trusted for the life of the install dir; requiring a real, non-empty
  // file lets a poisoned entry fall through to a re-download instead.
  const cached = await fs.stat(finalBin).catch(() => null);
  if (cached?.isFile() && cached.size > 0) return finalBin;

  await fs.mkdir(installDir, { recursive: true });
  log("info", "Bootstrapping uv", { version: UV_VERSION, target, cache: installDir });

  const archiveName = `uv-${target}.${archiveExt()}`;
  const archiveUrl = `${RELEASE_BASE}/${archiveName}`;
  const shaUrl = `${archiveUrl}.sha256`;

  // The .sha256 sidecar FIRST, then the archive -- sequential on purpose. A
  // Promise.all over the two let the tiny sidecar fetch reject first (a 404
  // right after a UV_VERSION bump outruns Astral's upload; a DNS blip) while
  // the 18-23 MB archive download carried on into memory with nothing to
  // cancel it: each fetch arms its own AbortSignal.timeout and nothing aborted
  // the survivor, so the rejection the caller saw was followed by up to
  // UV_FETCH_TOTAL_MS of wasted transfer. Sidecar-first costs one extra round
  // trip (milliseconds against a multi-second download) and makes every
  // "asset is missing" failure fail before a byte of the archive moves.
  const shaBuf = await fetchWithRedirects(shaUrl);
  const archiveBuf = await fetchWithRedirects(archiveUrl);

  const expected = shaBuf.toString("utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(archiveBuf).digest("hex");
  if (!expected || expected.toLowerCase() !== actual.toLowerCase()) {
    throw new Error(`uv archive checksum mismatch (expected ${expected}, got ${actual})`);
  }

  // Per-pid archive filename so two concurrent yaw-mcp processes racing the
  // same uv version do not stomp each other's mid-flight download. If the
  // shared path were used, the `finally` rm below would delete the OTHER
  // process's archive while it is still mid-extract -- which then fails
  // ENOENT on tar/Expand-Archive. Scoping the name to process.pid means
  // each process writes, extracts from, and removes only ITS own archive.
  // (The per-pid extractDir below already isolates the extraction tree;
  // this completes the symmetry on the archive file too.)
  const archiveBase = archiveName.endsWith(".tar.gz")
    ? `${archiveName.slice(0, -".tar.gz".length)}.${process.pid}.tar.gz`
    : archiveName.endsWith(".zip")
      ? `${archiveName.slice(0, -".zip".length)}.${process.pid}.zip`
      : `${archiveName}.${process.pid}`;
  const archivePath = path.join(installDir, archiveBase);
  await pipeline(async function* () {
    yield archiveBuf;
  }, createWriteStream(archivePath));

  // Extract into a per-attempt unique dir so two concurrent yaw-mcp
  // processes (separate PIDs) don't clobber each other's mid-extract
  // files in a shared fixed path. We rm only OUR dir in finally; the
  // final atomic rename onto finalBin handles winner-takes-all between
  // the racing processes.
  const extractDir = path.join(installDir, `extract-${process.pid}-${Date.now()}`);
  try {
    await extractArchive(archivePath, extractDir);

    const extracted = await findBinary(extractDir, binName());
    if (!extracted) throw new Error(`uv binary not found inside ${archiveName}`);

    // Winner-takes-all rename. On Windows this can fail EPERM/EBUSY when a
    // concurrent winner already renamed its copy onto finalBin AND is
    // executing it (Win32 refuses to replace a file with an open image
    // handle) -- a lost race, not a broken install. Every racer verified the
    // same UV_VERSION archive against the same published sha256, so an
    // existing non-empty finalBin is a good binary: treat the failure as
    // success. Rethrow only when there is nothing usable there.
    try {
      await fs.rename(extracted, finalBin);
    } catch (err) {
      const st = await fs.stat(finalBin).catch(() => null);
      if (!st?.isFile() || st.size === 0) throw err;
      log("info", "uv install race lost; using the copy another process installed", {
        bin: finalBin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await fs.chmod(finalBin, 0o755).catch(() => {}); // no-op on Windows
  } finally {
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(archivePath, { force: true }).catch(() => {});
  }

  log("info", "uv bootstrap complete", { bin: finalBin });
  return finalBin;
}

/** Trailing Windows executable extension, any casing -- mirrors WIN_EXE_EXT
 *  in oam-spawn.ts: a hand-written or installer-generated config carries
 *  `uvx.exe` or `UV.EXE` as readily as the bare name, and the extension says
 *  nothing about what the program IS. */
const UV_WIN_EXE_EXT = /\.(?:exe|cmd|bat)$/i;

/**
 * Which uv launcher a BARE command names, or null for anything else.
 *
 * Matched with any Windows executable extension stripped, case-insensitively,
 * so `uvx.exe` / `UV.CMD` get the same bootstrap-and-rewrite treatment as
 * `uvx` / `uv`. Exact string equality -- which is what this replaced --
 * silently passed those shapes through, reintroducing the exact Windows
 * failure the uvx rewrite below exists to prevent (mirrors nodeLaunchKind in
 * oam-spawn.ts).
 *
 * A command WITH a path separator (`C:\...\uv.exe`, `./bin/uvx`) returns null
 * DELIBERATELY: an explicit path is a user pin on one concrete binary.
 * Substituting the managed download behind it would silently override the
 * pin, and rewriting a pinned uvx's args to `tool run` without switching the
 * binary would mis-launch (a uvx binary does not take `tool run`). A pinned
 * path either spawns as written or fails with an ENOENT naming exactly what
 * the user wrote -- both better than quiet substitution.
 *
 * Exported so server.ts's startup uv prewarm gate matches the SAME set of
 * commands resolveUvSpawn will bootstrap at activation -- an exact-string
 * gate there let `uvx.exe` / `UV.CMD` configs skip the prewarm and pay the
 * 2-10s ensureUv download on the activation path instead.
 */
export function uvLaunchKind(command: string): "uv" | "uvx" | null {
  if (/[\\/]/.test(command)) return null;
  const base = command.replace(UV_WIN_EXE_EXT, "").toLowerCase();
  if (base === "uv") return "uv";
  if (base === "uvx") return "uvx";
  return null;
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
  const kind = uvLaunchKind(command);
  if (kind === null) return { command, args };

  const uvBin = await ensureUv();

  if (kind === "uvx") {
    // Always rewrite to `uv tool run`. Works regardless of whether
    // uvBin is the literal "uv" (PATH) or an absolute path
    // (bootstrapped cache). Avoids requiring uvx.exe separately.
    return { command: uvBin, args: ["tool", "run", ...args] };
  }

  // kind === "uv" — pass through. uvBin is either "uv" (PATH) or
  // the absolute path to our managed binary; either way, the spawn
  // target resolves correctly.
  return { command: uvBin, args };
}

// Test hook — resets the memoized promise so a unit test can exercise
// multiple code paths within one process.
export function __resetUvBootstrap(): void {
  pending = null;
}
