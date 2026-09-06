import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, posix as posixPath, win32 as winPath } from "node:path";
import { fileURLToPath } from "node:url";
import { stripInternalSecretsFromEnv } from "./internal-secret-env.js";

interface ComplianceReport {
  grade: string;
  score: number;
  url: string;
  summary: { total: number; passed: number; failed: number; required: number; requiredPassed: number };
  tests: unknown[];
  [extra: string]: unknown;
}

export const COMPLIANCE_USAGE =
  "\n  Usage: yaw-mcp compliance <target> [extraArgs...]\n\n" +
  "  Examples:\n" +
  '    yaw-mcp compliance "npx -y @modelcontextprotocol/server-filesystem /tmp"\n' +
  "    yaw-mcp compliance https://example.com/mcp\n\n";

/** Rejection text for the retired `--publish` flag. Exported so the test can
 *  assert on the exact message rather than a substring that could drift. */
export const PUBLISH_REMOVED_MESSAGE =
  "\n  --publish was removed: yaw-mcp no longer publishes compliance reports.\n" +
  "  Run `yaw-mcp compliance <target>` for a local report, or `yaw-mcp audit\n" +
  "  <namespace>` to cache a grade for a server in your bundles.json.\n\n";

/** Injectable output sinks. Every sibling subcommand (audit, doctor, ...)
 *  takes out/err hooks so tests can capture output without spying on the
 *  real process streams; compliance now matches. Defaults keep the CLI
 *  call site (index.ts) unchanged. */
export interface ComplianceIo {
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export async function runComplianceCommand(argv: string[], io: ComplianceIo = {}): Promise<number> {
  const out =
    io.out ??
    ((s: string) => {
      process.stdout.write(s);
    });
  const err =
    io.err ??
    ((s: string) => {
      process.stderr.write(s);
    });

  // Handle --help BEFORE spawning -- otherwise "--help" falls through to the
  // mcp-compliance subprocess (a suite launch, plus the sub-tool's help),
  // never the documented usage. Print to stdout + exit 0 like every sibling.
  if (argv.includes("--help") || argv.includes("-h")) {
    out(COMPLIANCE_USAGE);
    return 0;
  }

  // `--publish` used to POST the report to the hosted backend, which no longer
  // exists. Reject it HERE rather than letting it fall through: as an
  // unrecognized extra arg it reaches the mcp-compliance child, which fails
  // with its own opaque child-process error instead of telling the user the
  // flag is gone. Exit 2 -- same arg-error convention as a missing <target>.
  //
  // Both spellings, because a removed flag is exactly the one a user is most
  // likely to type with its old ARGUMENT still attached (`--publish=public`,
  // the value the retired backend took). An exact-match check let that form
  // through to the child as an unrecognized extra arg, which is precisely the
  // opaque failure this branch exists to replace.
  if (argv.some((a) => a === "--publish" || a.startsWith("--publish="))) {
    err(PUBLISH_REMOVED_MESSAGE);
    return 2;
  }

  if (argv.length === 0) {
    // Missing required <target> is an arg error -> exit 2, matching the
    // 2-for-usage-errors convention every other subcommand follows.
    err(COMPLIANCE_USAGE);
    return 2;
  }

  const resolved = await resolveSuiteLaunch(argv);
  if (!resolved.ok) {
    err(formatLaunchFailure(resolved.npxArgs));
    return 1;
  }
  const run = await runTest(resolved.launch, err);
  if (!run) return 1;

  // Cancelled by the operator (or a supervisor): there is no report to print
  // and runTest has already said so on stderr. Hand back the 128 + signal
  // status -- 130 for Ctrl-C, 143 for SIGTERM -- so a scripted caller can tell
  // a cancellation from a `--min-grade` failure, which also exits non-zero.
  if ("interrupted" in run) return run.code;

  printSummary(run.report, out);

  // Propagate the child's exit status. `--strict` and `--min-grade` are
  // forwarded verbatim (see suiteArgs in resolveSuiteLaunch) and COMPLIANCE_USAGE advertises
  // [extraArgs...], but their ONLY effect is a non-zero exit -- the JSON report
  // is byte-identical either way. Returning 0 unconditionally made both flags
  // silent no-ops through yaw-mcp: `yaw-mcp compliance <target> --min-grade A`
  // printed "Grade F is below threshold A" on stderr and exited 0, so the CI
  // gate never fired. A signal death (code null) is reported as 1: the run did
  // not complete normally even though a report was parsed.
  return run.code ?? 1;
}

// Guard rails on the child: a hung MCP server blocks forever, and a
// runaway/garbage child can stream unbounded stdout into memory. Cap both.
const MAX_STDOUT_BYTES = 16 * 1024 * 1024; // 16 MB
const CHILD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes wall-clock

/** npm package the compliance suite ships as. One constant so the local
 *  lookup, the pinned spec and the unpinned fallback cannot drift apart. */
const COMPLIANCE_PKG = "@yawlabs/mcp-compliance";

/** The `bin` entry the suite's manifest names its launcher under. Read from
 *  the manifest rather than hard-coding the script path, so an upstream move
 *  of the file degrades to the npx fallback instead of a spawn ENOENT. */
const COMPLIANCE_BIN_NAME = "mcp-compliance";

/** The nearest installed @yawlabs/mcp-compliance: where it lives and what its
 *  manifest says about it. */
export interface ComplianceSuiteInstall {
  /** The package directory: <ancestor>/node_modules/@yawlabs/mcp-compliance. */
  dir: string;
  /** Its package.json version -- the rubric identifier `audit` records as
   *  suiteVersion. Undefined when the manifest carries no usable version. */
  version: string | undefined;
  /** Its launcher script, relative to `dir`; undefined when the manifest
   *  names none, in which case the suite can only be launched through npx. */
  bin: string | undefined;
}

/**
 * Locate the INSTALLED @yawlabs/mcp-compliance package -- the copy `audit`
 * imports in-process and the copy `compliance` spawns directly.
 *
 * Read straight off the package.json on disk rather than through the module
 * system: the package's `exports` map carries only an `import` condition (no
 * `require`/`default` and no "./package.json" subpath), so both createRequire
 * resolution and a package.json subpath import throw
 * ERR_PACKAGE_PATH_NOT_EXPORTED. The ancestor walk mirrors Node's own
 * node_modules lookup (<dir>/node_modules at every level up to the root), so
 * the copy found is the copy `import()` loads.
 *
 * `fromUrl` is injectable for tests; it defaults to this module's own URL.
 * Returns undefined (never throws) when nothing resolvable is found, or when
 * the nearest manifest is unreadable: `audit`'s cache entry then simply omits
 * `suiteVersion`, and `compliance` falls back to npx.
 */
export async function locateComplianceSuite(
  fromUrl: string = import.meta.url,
): Promise<ComplianceSuiteInstall | undefined> {
  let here: string;
  try {
    here = fileURLToPath(fromUrl);
  } catch {
    return undefined;
  }
  for (let dir = dirname(here); ; dir = dirname(dir)) {
    const pkgDir = join(dir, "node_modules", "@yawlabs", "mcp-compliance");
    let raw: string;
    try {
      raw = await readFile(join(pkgDir, "package.json"), "utf8");
    } catch {
      if (dirname(dir) === dir) return undefined;
      continue;
    }
    // Nearest installed copy found -- the one Node resolves. Do NOT keep
    // walking on a bad manifest: an ancestor's copy would be a DIFFERENT
    // install, and attributing its version here would mislabel the rubric.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const manifest = parsed as Record<string, unknown>;
    const version = typeof manifest.version === "string" && manifest.version.length > 0 ? manifest.version : undefined;
    // npm's `bin` is either one path (a single-bin package) or a name -> path
    // map; the suite ships the map form, but both are read so a packaging
    // change upstream cannot silently route every run through npx.
    const bin = manifest.bin;
    const binPath =
      typeof bin === "string"
        ? bin
        : bin && typeof bin === "object" && !Array.isArray(bin)
          ? (bin as Record<string, unknown>)[COMPLIANCE_BIN_NAME]
          : undefined;
    return { dir: pkgDir, version, bin: typeof binPath === "string" && binPath.length > 0 ? binPath : undefined };
  }
}

/** `<pkg>@<version>` when the version is known, the bare name otherwise. */
function suiteSpec(version: string | undefined): string {
  return version ? `${COMPLIANCE_PKG}@${version}` : COMPLIANCE_PKG;
}

/**
 * The npx spec for the FALLBACK launch: `<pkg>@<version>` pinned to the copy
 * this build depends on, or the bare package name when that cannot be read.
 *
 * `compliance` and `audit` are two front doors onto the same suite, and they
 * must grade under ONE rubric. `audit` imports the pinned dependency and
 * records the version it graded under as `suiteVersion` in grades.json;
 * `compliance` used to shell out to `npx -y @yawlabs/mcp-compliance` with no
 * pin at all, so it ran whatever npm called `latest`. The moment latest moved
 * ahead of the dependency the two commands could hand the same server different
 * letters, with nothing in either output naming which rubric produced them.
 *
 * The version comes from the same manifest audit reads (locateComplianceSuite:
 * the nearest installed node_modules/@yawlabs/mcp-compliance/package.json), so
 * there is one source of truth rather than a hard-coded string to forget.
 *
 * Only the fallback needs a spec at all. When the dependency IS installed
 * beside this build, resolveSuiteLaunch runs its bin script directly and npx
 * never enters into it; the unpinned name is what remains when it is not
 * installed -- a global install whose node_modules was pruned, or a bundled
 * single-file build. npx then fetches `latest`, which is exactly the oldest
 * behaviour: degraded to what shipped before, never broken.
 */
export async function resolveComplianceSuiteSpec(fromUrl?: string): Promise<string> {
  return suiteSpec((await locateComplianceSuite(fromUrl))?.version);
}

/** How to launch the suite: node + a script (the installed bin, or npm's
 *  npx-cli.js), or a shell-quoted command line (last resort, only when the
 *  dependency is absent AND npx-cli.js can't be found). `shell` args are
 *  already quoted for the target platform. */
export interface SuiteLaunch {
  command: string;
  args: string[];
  shell: boolean;
  /** "local": the installed dependency's own bin script. "npx": fetched (or
   *  served from npx's cache) at resolveComplianceSuiteSpec's spec. */
  via: "local" | "npx";
}

/** resolveSuiteLaunch's answer: a launch, or the npx argv it could not launch,
 *  handed back so formatLaunchFailure can name the offending argument. */
export type SuiteLaunchResult = { ok: true; launch: SuiteLaunch } | { ok: false; npxArgs: string[] };

/**
 * Decide how to run `mcp-compliance test --format json <args>`.
 *
 * LOCAL FIRST. @yawlabs/mcp-compliance is a runtime dependency of this
 * package, and `audit` already imports it in-process, so the suite is on disk
 * beside this build with a `bin` entry. Spawning that script with the current
 * node binary costs no network round-trip, no npx cache probe and no shell.
 * `npx -y <pkg>@<version>` resolved the SAME package against the registry on
 * every run -- npx looks for a package in the CALLER's project, never in
 * yaw-mcp's own node_modules, so a global install never hit the local copy --
 * and on a machine without npm beside node it had no way to run at all.
 *
 * npx stays as the fallback for the absent-dependency case (a pruned global
 * install, a bundled single-file build, a manifest that names no bin):
 * resolveNpxLaunch at the pinned spec when the manifest is readable and the
 * bare name otherwise -- see resolveComplianceSuiteSpec. Only that path can
 * fail to launch, which is why the failure carries the npx argv.
 *
 * The seams (`fromUrl`, `execPath`, `platform`, `exists`) are for tests;
 * production callers pass nothing.
 */
export async function resolveSuiteLaunch(
  args: string[],
  opts: { fromUrl?: string; execPath?: string; platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {},
): Promise<SuiteLaunchResult> {
  const execPath = opts.execPath ?? process.execPath;
  const fileExists = opts.exists ?? existsSync;
  const suiteArgs = ["test", "--format", "json", ...args];
  const installed = await locateComplianceSuite(opts.fromUrl);
  if (installed?.bin !== undefined) {
    // Host-flavoured join: `dir` came off this machine's filesystem.
    const bin = join(installed.dir, installed.bin);
    if (fileExists(bin)) {
      return { ok: true, launch: { command: execPath, args: [bin, ...suiteArgs], shell: false, via: "local" } };
    }
  }
  const npxArgs = ["-y", suiteSpec(installed?.version), ...suiteArgs];
  const launch = resolveNpxLaunch(npxArgs, { execPath, platform: opts.platform, exists: fileExists });
  return launch ? { ok: true, launch } : { ok: false, npxArgs };
}

/** Candidate locations of npm's `npx-cli.js`, relative to the running node
 *  binary. Windows lays npm out beside node.exe; POSIX installs put it under
 *  `<prefix>/lib/node_modules`. Both shapes are probed on every platform so
 *  unusual layouts (nvm, volta, scoop, a portable unpack) still resolve. */
function npxCliCandidates(execPath: string, platform: NodeJS.Platform): string[] {
  // Use the path flavour of the TARGET platform, not the host's. resolveNpxLaunch
  // accepts `platform` as an injectable, and until this was keyed off it the
  // injectable was a lie: dirname("C:\nodejs\node.exe") is "." under POSIX
  // semantics, so every candidate came out wrong, nothing matched, and the
  // function silently fell back to the shell path. In production `platform` is
  // always the host so behaviour is unchanged -- but the win32 branch could
  // only ever be exercised ON win32, which is how it stayed untested on Linux.
  const p = platform === "win32" ? winPath : posixPath;
  const binDir = p.dirname(execPath);
  return [
    p.join(binDir, "node_modules", "npm", "bin", "npx-cli.js"),
    p.join(binDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
    p.join(binDir, "..", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
}

/** Quote one argument for a `shell: true` spawn, or return null when the
 *  argument cannot be quoted safely on this platform. Strict by design: the
 *  shell path is a fallback for a broken node install, not a place to get
 *  clever about escaping operator-supplied target strings. */
function quoteForShell(arg: string, platform: NodeJS.Platform): string | null {
  // A newline / NUL ends the command line no matter how it is quoted.
  if (/[\r\n\0]/.test(arg)) return null;
  if (platform === "win32") {
    // cmd.exe still expands %VAR% inside double quotes, and a literal quote
    // terminates the quoted run. Everything else (& | < > ^) is inert there.
    if (/["%]/.test(arg)) return null;
    // A TRAILING backslash escapes the closing quote for the receiving
    // program's parser. cmd.exe passes the wrapped run through as text, but
    // CommandLineToArgvW (which every Windows runtime, node's included, uses to
    // split the command line back into argv) reads the `\"` as a LITERAL quote,
    // so the quoted run never closes and the next argument is merged into this
    // one: `"C:\dir\" "next"` arrives as the single argv element
    // `C:\dir" next`. Doubling the run would encode it correctly, but this
    // fallback is deliberately strict (see the header) -- a Windows path with a
    // trailing separator is trivially respellable by the operator, and refusing
    // routes into formatLaunchFailure, which names the offending argument.
    if (arg.endsWith("\\")) return null;
    return `"${arg}"`;
  }
  // POSIX single quotes are fully literal -- the only unquotable char is `'`.
  if (arg.includes("'")) return null;
  return `'${arg}'`;
}

/** Operator-facing name for the characters quoteForShell refuses on a given
 *  platform. Lives beside quoteForShell so the two cannot drift. */
function unquotableCharsFor(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "double quotes, percent signs, newlines, NUL bytes or a trailing backslash"
    : "single quotes, newlines or NUL bytes";
}

/**
 * Failure text for "no installed suite, no npx-cli.js on disk AND an argument
 * we refuse to quote". Names the character class that actually applies on
 * THIS platform and echoes the offending argument: the old wording said
 * "quotes / newlines" on every platform, so a target rejected for a `%`
 * (win32-only) or a `'` (POSIX-only) got an explanation naming nothing that
 * was wrong with it. Installing npm is still a primary remedy -- it removes
 * the shell fallback entirely -- and so is reinstalling @yawlabs/mcp, which
 * brings the suite back beside it and removes npx from the picture too.
 *
 * The `offender === undefined` branch below is DEFENSIVE, not a production
 * path: runComplianceCommand -- the only production caller -- reaches here
 * exactly when resolveSuiteLaunch's npx fallback returned null, and the only
 * way resolveNpxLaunch returns null is quoteForShell refusing one of these
 * same arguments, so the find always hits. The branch survives for direct
 * callers (which is all its test exercises) and for a future resolveNpxLaunch
 * that fails for some other reason, because rendering
 * `JSON.stringify(undefined)` into the diagnostic would be strictly worse than
 * one vaguer sentence.
 */
export function formatLaunchFailure(npxArgs: string[], platform: NodeJS.Platform = process.platform): string {
  const offender = npxArgs.find((a) => quoteForShell(a, platform) === null);
  const detail =
    offender === undefined
      ? "and the target arguments cannot be safely quoted for a shell fallback.\n"
      : // JSON.stringify so a newline / NUL in the argument is shown escaped
        // instead of mangling the diagnostic it appears in.
        `and this argument cannot be safely quoted for a shell fallback: ${JSON.stringify(offender)}\n`;
  return (
    "\nFailed to launch mcp-compliance: it is not installed beside yaw-mcp, npm's npx-cli.js was not found next to this node binary,\n" +
    detail +
    `Install npm, reinstall @yawlabs/mcp (the suite ships as its dependency), or pass a target without ${unquotableCharsFor(platform)}.\n`
  );
}

/**
 * Decide how to spawn `npx <args>` -- the FALLBACK launcher, used only when
 * resolveSuiteLaunch finds no installed suite to run directly.
 *
 * The obvious `spawn("npx.cmd", args)` is BROKEN on Windows: since the
 * CVE-2024-27980 hardening (Node 18.20.2 / 20.12.2 / 21.7.3 and up) spawning
 * a `.cmd` / `.bat` without `shell: true` throws `EINVAL` synchronously, so
 * `yaw-mcp compliance` could never launch the suite there at all. Resolving
 * npm's `npx-cli.js` and running it with the CURRENT node binary sidesteps
 * both that hardening and the PATHEXT problem, and keeps the no-shell
 * guarantee: an operator-supplied target string with a quote / `&&` / `;`
 * never reaches a shell parser.
 *
 * Returns null when neither strategy is usable (no npx-cli.js on disk AND an
 * argument that can't be safely shell-quoted) so the caller can fail loudly
 * instead of guessing.
 */
export function resolveNpxLaunch(
  npxArgs: string[],
  opts: { execPath?: string; platform?: NodeJS.Platform; exists?: (p: string) => boolean } = {},
): SuiteLaunch | null {
  const execPath = opts.execPath ?? process.execPath;
  const platform = opts.platform ?? process.platform;
  const fileExists = opts.exists ?? existsSync;

  for (const candidate of npxCliCandidates(execPath, platform)) {
    if (fileExists(candidate)) {
      return { command: execPath, args: [candidate, ...npxArgs], shell: false, via: "npx" };
    }
  }

  // Fallback: no npx-cli.js next to this node. Go through the shell, but only
  // with arguments we can quote safely -- never by concatenating raw input.
  const quoted: string[] = [];
  for (const arg of npxArgs) {
    const q = quoteForShell(arg, platform);
    if (q === null) return null;
    quoted.push(q);
  }
  return { command: "npx", args: quoted, shell: true, via: "npx" };
}

/** Finite-number check for one field of a parsed (untrusted) report. */
function isFiniteNumber(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Is a parsed report safe to render? Everything printSummary FORMATS is
 * checked here rather than at print time. The child is the installed
 * dependency itself -- or, without one, npx at the PINNED suite version (see
 * resolveSuiteLaunch) -- which makes a restructured field far less likely.
 * But the local copy is whatever a user's install resolved, the pin degrades
 * to the bare package name whenever the manifest cannot be read off disk, and
 * the child is a separate process whose output this one does not control
 * either way, so the gate stays.
 *
 * `score` is the crash case: printSummary calls `score.toFixed(1)`, so a
 * missing / non-numeric / NaN score would take the CLI down with a raw
 * TypeError. The summary counters and `url` are the SILENT case: a
 * truthy-but-empty `summary` used to pass this gate and print
 * "undefined/undefined passed, undefined/undefined required" with exit 0.
 * Failing the gate routes both into the "unexpected JSON" diagnostic + exit 1.
 *
 * `summary.failed` is deliberately NOT required -- printSummary does not
 * render it, and this gate exists to protect what is printed, not to
 * re-declare the whole child schema.
 */
export function isRenderableReport(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const r = parsed as Partial<ComplianceReport>;
  // `grade` is interpolated into the summary line, so it must be a non-empty
  // STRING, not merely truthy: a numeric grade (a suite that switched the field
  // to a 0-100 score) passed a truthiness-only check and printed
  // "Compliance: 5 (91.5%)" as if 5 were a letter.
  if (typeof r.grade !== "string" || r.grade.length === 0) return false;
  if (!r.summary) return false;
  if (!isFiniteNumber(r.score)) return false;
  if (typeof r.url !== "string") return false;
  if (typeof r.summary !== "object" || Array.isArray(r.summary)) return false;
  const s = r.summary as Record<string, unknown>;
  return (
    isFiniteNumber(s.total) &&
    isFiniteNumber(s.passed) &&
    isFiniteNumber(s.required) &&
    isFiniteNumber(s.requiredPassed)
  );
}

/**
 * Best-effort kill of the child AND its descendants. `child.kill()` signals
 * only the npx wrapper; the MCP server it spawned is a grandchild and would
 * survive, holding its ports/stdio open after the timeout fired.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined) {
    if (process.platform === "win32") {
      // taskkill /T walks the whole descendant tree; /F is required because
      // the wrapper won't forward a graceful signal.
      try {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        killer.on("error", () => {});
        return;
      } catch {
        // fall through to the direct kill below
      }
    } else {
      // The child was spawned `detached`, so it leads its own process group;
      // a negative pid signals the whole group (wrapper + grandchildren).
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // group already gone, or the child never became a group leader
      }
    }
  }
  try {
    child.kill();
  } catch {
    // already exited
  }
}

/** How long one Ctrl-C waits for killTree to actually take the child down
 *  before the CLI stops waiting and exits itself. Long enough for taskkill to
 *  spawn and walk a small tree, short enough that a stuck run does not read as
 *  a hang. */
export const INTERRUPT_GRACE_MS = 3000;

/** Exit status for a run the operator interrupted with Ctrl-C: the POSIX
 *  128 + SIGINT(2) convention, so a shell / CI wrapper can tell "user
 *  cancelled" from a real compliance failure. */
export const INTERRUPT_EXIT_CODE = 130;

/** Exit status for a run a supervisor terminated: 128 + SIGTERM(15). SIGTERM
 *  shares SIGINT's handler -- one child, one teardown -- and reporting BOTH as
 *  130 defeated the very discrimination these constants exist for: a wrapper
 *  reading 130 as "the operator pressed Ctrl-C" got the same answer when
 *  systemd or a CI runner killed the job. */
export const TERMINATED_EXIT_CODE = 143;

/** The 128 + signal status for whichever signal ended the run. Everything but
 *  SIGTERM is an interrupt: SIGINT is the only other signal handled here, and
 *  an absent signal (a direct call, not the process listener) means Ctrl-C. */
export function signalExitCode(signal: NodeJS.Signals | undefined): number {
  return signal === "SIGTERM" ? TERMINATED_EXIT_CODE : INTERRUPT_EXIT_CODE;
}

/**
 * Ctrl-C handling for one spawned child, as a cancellable pair.
 *
 * Registering a `process.once` SIGINT listener SUPPRESSES node's default
 * behaviour (die on the signal) for that one signal, so the handler now owns
 * the promise that the run ends. killTree is best-effort by construction --
 * on Windows it shells out to taskkill and deliberately swallows the error, on
 * POSIX the process-group kill can throw -- and when it fails to land, the
 * handler consumed the only listener, nothing killed the child, and the CLI sat
 * waiting on a child that will never close until a SECOND Ctrl-C. Requiring two
 * interrupts to cancel is exactly the shape a user reads as "hung".
 *
 * So the first interrupt arms a bounded fallback: direct `child.kill()` (which
 * at least reaches the wrapper even when the tree walk failed) and then a
 * forced exit, so ONE Ctrl-C always ends the run. `cancel()` disarms it, and is
 * called from every path that settles the run -- a child that dies promptly, the
 * normal case, never reaches the fallback.
 *
 * The forced exit reports 128 + the signal that arrived, not a fixed 130:
 * node hands its signal listeners the signal name, so a SIGTERM teardown ends
 * 143 even though it shares this handler with Ctrl-C.
 *
 * Exported (with injectable clock/exit/kill seams) because the failure it
 * guards against is a killTree that does nothing, which cannot be provoked
 * through the real process signal path in a test.
 */
export function createInterruptHandler(
  child: ChildProcess,
  opts: {
    graceMs?: number;
    exit?: (code: number) => void;
    kill?: (c: ChildProcess) => void;
  } = {},
): { onInterrupt: (signal?: NodeJS.Signals) => void; cancel: () => void } {
  const graceMs = opts.graceMs ?? INTERRUPT_GRACE_MS;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const kill = opts.kill ?? killTree;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    onInterrupt: (signal?: NodeJS.Signals): void => {
      kill(child);
      // A repeat interrupt must not stack a second fallback timer; the first
      // one is already counting down against the same child. The FIRST signal
      // also fixes the status -- a SIGTERM arriving after a Ctrl-C does not
      // relabel a cancellation as a termination.
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // already exited, or never started -- the exit below is the point
        }
        exit(signalExitCode(signal));
      }, graceMs);
      // The fallback must not be the reason the process stays alive: if
      // everything else has finished, node should exit on its own.
      timer.unref?.();
    },
    cancel: (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/** A completed child run: the parsed report plus the exit status that carries
 *  the `--strict` / `--min-grade` verdict. `code` is null when the child died
 *  on a signal. */
interface ComplianceRun {
  report: ComplianceReport;
  code: number | null;
}

/** A run the operator cancelled before the child produced a usable report.
 *  A distinct shape rather than a ComplianceRun with a missing report: the
 *  caller must route it AROUND printSummary, which would throw on
 *  `report.score.toFixed` -- the exact crash isRenderableReport exists to
 *  prevent. `code` is the 128 + signal status (see signalExitCode). */
interface InterruptedRun {
  interrupted: true;
  code: number;
}

type ComplianceOutcome = ComplianceRun | InterruptedRun;

/** Spawn the suite as `launch` says (see resolveSuiteLaunch), drive it to a
 *  report or a diagnostic. */
function runTest(launch: SuiteLaunch, err: (s: string) => void): Promise<ComplianceOutcome | null> {
  return new Promise((resolve) => {
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      err(message);
      resolve(null);
    };

    let child: ChildProcess;
    try {
      child = spawn(launch.command, launch.args, {
        stdio: ["ignore", "pipe", "inherit"],
        shell: launch.shell,
        // Own process group on POSIX so the timeout can take the whole tree
        // down. NOT on Windows, where `detached` would pop a console window.
        detached: process.platform !== "win32",
        // The suite is a registry package running arbitrary code; yaw-mcp's
        // own vault passphrase has no business in its env (README: stripped
        // from every child yaw-mcp starts). `audit` scrubs process.env before
        // it spawns; this command passes a stripped copy instead.
        env: stripInternalSecretsFromEnv(process.env),
      });
    } catch (e: unknown) {
      // spawn can throw SYNCHRONOUSLY (EINVAL on a .cmd, ENOENT on some
      // shells) -- without this catch the throw escapes the Promise executor
      // as a rejection and the CLI prints a raw Node error instead of the
      // normal "Failed to launch" line + exit 1.
      fail(`\nFailed to launch mcp-compliance: ${e instanceof Error ? e.message : String(e)}\n`);
      return;
    }

    // Ctrl-C: on POSIX the child now leads its OWN process group, so the
    // terminal's SIGINT no longer reaches it -- take the tree down by hand
    // rather than orphaning an MCP server. Listeners are removed as soon as
    // the promise settles so nothing leaks into the rest of the CLI, and the
    // handler's bounded fallback (see createInterruptHandler) is disarmed with
    // them so a run that ended normally never force-exits.
    //
    // The signal is recorded because installing these listeners SUPPRESSED
    // node's default die-on-signal: without the record the killed child's
    // close event landed in the "exited N without valid JSON output" branch,
    // which reads as a tool malfunction and exits 1 -- indistinguishable from
    // a genuine parse failure or a --min-grade gate failure. First signal
    // wins, so a follow-up SIGTERM cannot relabel a cancellation.
    const interrupt = createInterruptHandler(child);
    let interruptedBy: NodeJS.Signals | undefined;
    const onInterrupt = (signal: NodeJS.Signals): void => {
      interruptedBy ??= signal;
      interrupt.onInterrupt(signal);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    const releaseSignals = (): void => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
      interrupt.cancel();
    };

    // Accumulate raw Buffers and decode ONCE at close: decoding each chunk
    // independently corrupts a multi-byte UTF-8 sequence that straddles a
    // pipe-boundary chunk (both halves become U+FFFD), which turned a valid
    // report bigger than the pipe's highWaterMark into "exited N without
    // valid JSON output". Byte counting stays exact on the raw chunks.
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      releaseSignals();
      killTree(child);
      err(`\nmcp-compliance timed out after ${CHILD_TIMEOUT_MS / 1000}s; killed.\n`);
      resolve(null);
    }, CHILD_TIMEOUT_MS);
    // Don't let the timer keep the process alive on its own.
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        settled = true;
        clearTimeout(timer);
        releaseSignals();
        killTree(child);
        err(`\nmcp-compliance produced more than ${MAX_STDOUT_BYTES / (1024 * 1024)} MB of output; killed.\n`);
        resolve(null);
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.on("error", (e) => {
      if (settled) return;
      clearTimeout(timer);
      releaseSignals();
      fail(`\nFailed to launch mcp-compliance: ${e.message}\n`);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      releaseSignals();
      // A cancelled run has no usable report -- the child was killed
      // mid-write, so the parse below is EXPECTED to fail. Say "interrupted"
      // and hand back 128 + signal instead of a diagnostic that reads as a
      // tool malfunction. Deliberately scoped to the report-failure branches:
      // in the race where the child completed as the signal arrived, the
      // parsed report and its --strict / --min-grade verdict still win.
      const cancelled = (): void => {
        err("\nmcp-compliance interrupted.\n");
        resolve({ interrupted: true, code: signalExitCode(interruptedBy) });
      };
      // mcp-compliance exits non-zero on --strict / --min-grade failures but
      // still writes a valid JSON report. Try parsing regardless of exit code,
      // and hand the code back so the caller can propagate it.
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      try {
        const parsed = JSON.parse(stdout) as ComplianceReport;
        if (!isRenderableReport(parsed)) {
          if (interruptedBy !== undefined) {
            cancelled();
            return;
          }
          err(`\nmcp-compliance returned unexpected JSON (exit ${code}).\n`);
          resolve(null);
          return;
        }
        resolve({ report: parsed, code });
      } catch {
        if (interruptedBy !== undefined) {
          cancelled();
          return;
        }
        err(`\nmcp-compliance exited ${code} without valid JSON output.\n`);
        resolve(null);
      }
    });
  });
}

function printSummary(report: ComplianceReport, out: (s: string) => void): void {
  const { grade, score, summary, url } = report;
  out(
    `\nCompliance: ${grade} (${score.toFixed(1)}%) -- ${summary.passed}/${summary.total} passed, ` +
      `${summary.requiredPassed}/${summary.required} required\n` +
      `Target: ${url}\n`,
  );
}
