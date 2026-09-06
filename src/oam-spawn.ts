// Host an MCP sidecar on the oam runtime (https://oamjs.org) instead of
// node/npx. This is the spawn-rewrite half of "run Yaw's MCP sidecars on oam":
// connectToUpstream() applies it after resolveUvSpawn (upstream.ts) for every
// server that has not opted out -- oam is the default when it is installed and
// meets MIN_OAM_VERSION (see default-runtime.ts for the resolution order).
//
// It is deliberately conservative -- a pure optimization, never a correctness
// dependency. It rewrites only Node-based launches and falls back to the
// original node/npx command whenever oam can't host the server:
//   * oam isn't installed (no `oam` on PATH / OAM_BIN)        -> Node
//   * the command isn't Node-based (uv/uvx/docker/python/...) -> unchanged
//   * an npx package can't be resolved on disk                -> npx (Node)
//     (oam run needs a real entry; it can't reproduce npx's fetch-on-demand)
//   * the npx spec is a git/path spec, not a registry package -> npx (Node)
//   * the npx spec constrains the version and no on-disk copy -> npx (Node)
//     satisfies it (npx honours the pin; `oam run <entry>` cannot)
//
// Compat note: oam is the DEFAULT for every node/npx sidecar (see
// default-runtime.ts), not an opt-in tier -- that changed in #99, and this note
// described the opt-in model for two releases after it.
//
// MEASURED: the SDK-hosting mechanism re-verified against oam 0.13.0 on
// 2026-09-02, and the floor moved to 0.13.1 the same day without re-running
// it -- 0.13.1 is a same-day patch on 0.13.0, so the mechanism check is
// carried forward, not re-measured (a stdio @modelcontextprotocol/sdk server completes
// initialize + tools/list + tools/call hosted on `oam run`); the full
// per-server matrix below was last run against 0.11.0 on 2026-08-22
// (first 0.9.0 on 2026-08-08). Re-run at least the mechanism check for
// each floor move, so nobody re-derives it: the
// pure-JS/SDK tier (memory, tailscale, lemonsqueezy, redis, postgres, ctxlint)
// completes an MCP initialize handshake hosted on oam, AND so do both
// bundled-browser servers -- @modelcontextprotocol/server-puppeteer and
// @playwright/mcp each launched a real Chromium and served a real
// tools/call navigate on oam, matching the node control. An earlier note here
// called bundled browsers "not oam-hostable yet"; that was true and is no
// longer. oam 0.9.0 is what changed it: before that release `child_process`
// ignored `stdio` entirely ('inherit'/'ignore' both behaved as 'pipe'), which
// is precisely the npm bin-shim shape every sidecar launches through -- they
// booted and then sat mute forever while the launcher reported success.
// MIN_OAM_VERSION gates that fix in, so a machine below the floor gets node.
//
// Native addons: oam refuses to dlopen a .node addon by default, throwing a
// CATCHABLE error with code OAM-NATIVE0001 (OAM_ENABLE_NATIVE_ADDONS=1 opts
// into oam's alpha N-API support). The refusal is designed to be catchable so
// the universal `try { require(native) } catch { pure-JS fallback }` pattern
// keeps working, and oam deliberately omits `process.versions.modules`/`napi`
// so addon loaders do not try in the first place.
//
// MEASURED against oam 0.11.0 on 2026-08-22: this does NOT break ssh2. With a
// compiled sshcrypto.node present on disk, ssh2 loads and its Client and kex
// layers work identically to the node control -- its binding require is
// try/catch-wrapped, so it degrades to the pure-JS cipher path. The addon is
// refused; the sidecar is not. Note OAM_ENABLE_NATIVE_ADDONS=1 would not even
// help there: that addon is NAN/node-gyp, and the alpha loader rejects it with
// "napi_register_module_v1 missing".
//
// The residual risk is narrower than "native addons are broken": a package that
// requires a .node with NO fallback, LAZILY at first tool call, would fail past
// the boot-scoped downgrade below. That case is untested.
//
// Boot failures ARE recovered: connectToUpstream respawns once on the original
// node/npx command when an oam-hosted child fails the connect handshake or dies
// during the initial capability fetch (see upstream.ts). There is still no
// auto-fallback after a healthy boot.

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_OS, type InstallOS } from "./install-targets.js";
import { stripInternalSecretsFromEnv } from "./internal-secret-env.js";
import { log } from "./logger.js";
import { sidecarsNodeModules } from "./paths.js";

/**
 * Strip an npm version/tag suffix from a package spec:
 *   "@yawlabs/x-mcp@latest" -> "@yawlabs/x-mcp"
 *   "server-memory@1.2.3"   -> "server-memory"
 *   "@scope/name"           -> "@scope/name"
 */
export function packageName(spec: string): string {
  // For a scoped package the leading "@" is part of the name; the version
  // separator is the SECOND "@".
  const start = spec.startsWith("@") ? 1 : 0;
  const at = spec.indexOf("@", start);
  return at === -1 ? spec : spec.slice(0, at);
}

/** The `@suffix` of a package spec ("pkg@1.2.3" -> "1.2.3"), or null when the
 *  spec carries none. The mirror of packageName, cutting at the same "@". */
function specSuffix(spec: string): string | null {
  const start = spec.startsWith("@") ? 1 : 0;
  const at = spec.indexOf("@", start);
  return at === -1 ? null : spec.slice(at + 1);
}

/** A single exact version, anchored -- `1.2.3`, `1.2.3-rc.1`, `1.2.3+build`.
 *  Deliberately NOT tolerant of a leading "v": npm accepts `pkg@v1.2.3`, but
 *  the version a package.json DECLARES never carries one, so treating it as
 *  exact would mean normalising before comparing. It falls into "range" below,
 *  which stays on npx -- the safe answer for a spec we can't verify. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * What an npx spec's version suffix asks for. Three answers, because the
 * rewrite can honour only one of them:
 *
 *   "any"   -- no suffix, or a dist-tag (`@latest`, `@next`, `@beta`). npx
 *              would re-resolve the tag against the registry; the newest copy
 *              on disk is the closest available answer, and notePinnedSidecar
 *              reports which one won. This is the everyday case.
 *   "exact" -- one version. The resolved copy must DECLARE it, or the rewrite
 *              stays on npx: `oam run <entry>` runs whatever is at that path,
 *              so a version-agnostic lookup would silently host a different
 *              build than the config asked for. buildLaunchEntry refuses the
 *              oam path for the broker's own pinned spec for the same reason
 *              (install-targets.ts) -- silently ignoring a pin is worse than
 *              not taking the oam path.
 *   "range" -- a range or partial (`^1.2.3`, `~1.2`, `1.x`, `>=2 <3`, `*`).
 *              Satisfiable by more than one version, so honouring it means a
 *              semver range parser this module has no dependency on. Treated
 *              like an unsatisfiable pin (stay on npx) rather than like a tag,
 *              because `^1.2.3` resolving to an on-disk 0.9.0 is the exact
 *              major-version jump the exact case exists to prevent.
 */
type SpecConstraint = { kind: "any" } | { kind: "exact"; version: string } | { kind: "range"; raw: string };

export function specConstraint(spec: string): SpecConstraint {
  const suffix = specSuffix(spec);
  if (suffix === null || suffix === "") return { kind: "any" };
  if (EXACT_VERSION.test(suffix)) return { kind: "exact", version: suffix };
  // A dist-tag is a name, not a version: npm forbids a tag that parses as
  // semver, so anything opening with a digit or a range operator is a version
  // expression and anything else ("latest", "next", "canary") is a tag.
  const versionish = /^[v=<>^~*\d]/.test(suffix) || suffix.includes("||");
  return versionish ? { kind: "range", raw: suffix } : { kind: "any" };
}

/**
 * Whether a launch spec names a plain REGISTRY package -- the only kind whose
 * name can be used as an on-disk lookup key.
 *
 * npx also accepts git and path specs (`npx -y github:owner/repo`, `npx -y
 * ./local-server`, `file:../x`), and packageName passes those through whole
 * because there is no `@version` separator to cut at. Handing one to
 * resolveNpmEntry is worse than useless: it splits on "/" and path.joins the
 * parts, so `./local-server` is looked up as a TOP-LEVEL package named
 * `local-server` (join collapses the "."), and on a machine whose managed tree
 * happens to hold a published package by that name the server is rewritten to
 * run a different program than the directory the user pointed at.
 *
 * A git or path spec is legitimate configuration, so callers skip rather than
 * error: those servers keep resolving through npx exactly as before.
 *
 * sidecars-cmd.ts consumes this export too (a git/path spec cannot be a
 * dependency KEY in a generated manifest).
 *
 * Character-level, the rule is validate-npm-package-name's: each part of the
 * name must survive encodeURIComponent unchanged. The looser "anything but a
 * separator" shape this used to accept let through names npm itself refuses,
 * and each of them broke a different consumer: a backslash in `foo\bar` is a
 * path separator to the Windows lookup below (the very traversal the leading-
 * character guard exists to stop), and `#`, `%` and `?` land raw in the
 * registry URL sidecar-refresh builds from the name.
 */
export function isRegistrySpec(spec: string): boolean {
  // A protocol (github:, file:, git+ssh:, http:) or a filesystem path.
  if (spec.includes(":") || /^[./~\\]/.test(spec)) return false;
  // @scope/name, or a bare name. npm forbids a leading "." or "_".
  const m = /^(?:@([^/]+)\/)?([^./_][^/]*)$/.exec(packageName(spec));
  if (!m) return false;
  const [, scope, name] = m;
  return (scope === undefined || encodeURIComponent(scope) === scope) && encodeURIComponent(name) === name;
}

/**
 * Index of the argv element an `npx` launch treats as the package spec: the
 * FIRST argument npx does not consume itself. -1 when there is none.
 *
 * Only `-y`/`--yes` are recognized as npx's own, and only ahead of the spec --
 * everything after it belongs to the SERVER. That distinction is why this is a
 * head-scan and not a whole-list filter: filtering the whole list also ate a
 * server's own trailing `--yes`, so the oam launch and the npx fallback handed
 * the child different arguments (the 0.74.2 bug). The two shapes agree on WHICH
 * element is the spec -- the first survivor of a filter is the first non-flag
 * element -- so the copies drifted apart silently rather than loudly.
 *
 * Shared because three callers must answer this identically: rewriteForOam
 * (which also needs the index, to slice the server's own args off the tail) and
 * both collectors in sidecars-cmd.ts, which PARTITION the same server set into
 * "installed" and "skipped". A one-sided edit there drops a server from both
 * reports with nothing to say why.
 */
export function npxSpecIndex(args: readonly string[]): number {
  return args.findIndex((a) => a !== "-y" && a !== "--yes");
}

/**
 * The package spec of an `npx` launch, or null when there is none or the first
 * unconsumed argument is a flag yaw-mcp does not parse (`--package`, `-p`,
 * `--node-options`, ...). A flag landing here would otherwise be treated as the
 * package name.
 *
 * rewriteForOam does not use this -- it needs the index for the tail slice, and
 * it logs the offending flag at debug -- but it applies the same two rules
 * through npxSpecIndex.
 */
export function npxSpec(args: readonly string[]): string | null {
  const idx = npxSpecIndex(args);
  if (idx === -1) return null;
  const spec = args[idx];
  return spec.startsWith("-") ? null : spec;
}

/**
 * Minimum oam version yaw-mcp will host sidecars on.
 *
 * POLICY: this tracks the LATEST oam release. Bump it with every oam release,
 * not only when a release happens to fix something this code noticed. oam is
 * pre-1.0 and moves fast, the install channel (oamjs.org) only ever hands out
 * the current release, and hosting sidecars on a runtime older than that means
 * debugging against a build nobody else is running. There is no support
 * commitment for older builds, so there is no reason to admit them.
 *
 * Below-min is treated the same as oam-absent: the spawn falls back to
 * node/npx with one warn log naming both versions. That is a safe outcome --
 * the user gets node, which is what they had before oam existed -- so an
 * aggressive floor costs nothing but a fallback, while a lax one silently
 * hosts production sidecars on a runtime that is no longer current.
 */
export const MIN_OAM_VERSION = "0.13.1";

/** The oam installer one-liners, as oamjs.org publishes them. Both install the
 *  current release, which always satisfies MIN_OAM_VERSION. */
export const OAM_INSTALL_SH = "curl -fsSL https://oamjs.org/install.sh | sh";
export const OAM_INSTALL_PS1 = "irm https://oamjs.org/install.ps1 | iex";

/**
 * The install command to print for the platform a report is ABOUT.
 *
 * One source for the same reason oamFailureLabel is one source for the failure
 * wording: doctor's OAM RUNTIME section, `install`'s Runtime line, and the
 * opted-in-but-absent warn below all print it, and a second copy is how one
 * surface goes on naming a URL the installer has moved off of.
 *
 * `os` is a parameter, never process.platform: doctor and install both take an
 * --os override, and a report asked about windows must not hand back the curl
 * line. macos and linux share the shell installer, so only windows branches.
 */
export function oamInstallCommand(os: InstallOS): string {
  return os === "windows" ? OAM_INSTALL_PS1 : OAM_INSTALL_SH;
}

/**
 * Whether oamjs.org publishes an oam binary for the machine this process is
 * running on.
 *
 * oam ships five assets: windows x64/arm64, macos x64/arm64, and linux x64.
 * There is NO aarch64-unknown-linux-gnu build, and install.sh refuses rather
 * than degrading -- "no published oam binary for Linux aarch64 yet ... use an
 * x86_64 host or build from source". Handing a Linux/arm64 user the curl
 * one-liner is handing them a command that cannot succeed, which is worse than
 * saying nothing: node is already a full fallback, so there is no repair to
 * make, only a fact to report.
 *
 * Answers only for the CURRENT machine, deliberately. doctor and install both
 * take an --os override, and a report asked about a DIFFERENT os carries no
 * arch with it -- assuming the running machine's arch for it would turn "I do
 * not know" into a confident claim about a platform we cannot see. Callers
 * gate on `os === CURRENT_OS` before consulting this.
 */
export function oamPublishesBinaryFor(platform: string, arch: string): boolean {
  if (platform === "win32" || platform === "darwin") return arch === "x64" || arch === "arm64";
  if (platform === "linux") return arch === "x64";
  // Everything else (freebsd, aix, android...) has no asset at all. Refusing
  // by default rather than assuming keeps a new platform from being handed an
  // installer nobody has built for it.
  return false;
}

/** {@link oamPublishesBinaryFor} for the running machine. Split so the asset
 *  table can be table-tested without stubbing `process`. */
export function oamPublishesBinaryForThisMachine(): boolean {
  return oamPublishesBinaryFor(process.platform, process.arch);
}

/**
 * Why there is no oam to install on this machine. Only meaningful when
 * oamPublishesBinaryForThisMachine() is false.
 *
 * One source for the wording, for the same reason oamFailureLabel is one
 * source: doctor's OAM RUNTIME section and `install`'s absent note both reach
 * it, and a second copy is how one surface goes on naming a platform the other
 * has stopped naming.
 *
 * ASCII only: doctor prints this verbatim to a terminal, and a legacy Windows
 * console renders a UTF-8 em-dash as mojibake -- which is then copy-pasted
 * into the support thread the doctor output exists for.
 */
export function oamNoBinaryReason(): string {
  return `no published oam binary for ${process.platform}-${process.arch} yet -- build from source at https://oamjs.org`;
}

/**
 * The `install:` line for a report about `os`: the installer one-liner, or the
 * reason there is nothing to install.
 *
 * doctor prints this verbatim. `install` phrases the two cases itself, because
 * its note is a sentence rather than a labelled field -- it consults the
 * predicate and this reason directly.
 */
export function oamInstallAdvice(os: InstallOS): string {
  if (os === CURRENT_OS && !oamPublishesBinaryForThisMachine()) return oamNoBinaryReason();
  return oamInstallCommand(os);
}

/**
 * Recognize oam's heap-cap death in a child's stderr, and say what fixes it.
 *
 * Since 0.9.2 oam caps the V8 heap -- 4 GiB unless OAM_MAX_HEAP_MB overrides,
 * 0 disables -- and turns what node renders as an ungraceful "Ineffective
 * mark-compacts near heap limit" abort into a deterministic exit 134 with
 * `error[OAM-RT-OOM]` on stderr, stdout left clean so the protocol channel is
 * not corrupted on the way out. That is a BETTER death than node's: it is
 * bounded, it names its own cause, and it cannot be mistaken for a crash. But
 * only if something reads it -- unrecognized it lands inside a 500-char stderr
 * tail under a generic "failed to start", and the one lever that fixes it is
 * never mentioned to the person who needs it.
 *
 * Matches the stable error CODE, not the prose: the banner carries the
 * resolved cap and whether it came from the env, so matching the sentence
 * would break on the next release that rewords it.
 *
 * Returns null for every other stderr, including a node-hosted OOM -- node's
 * abort has no equivalent code, and inventing a hint for it here would put
 * OAM_MAX_HEAP_MB in front of someone not running oam.
 */
export function oamHeapOomHint(stderr: string): string | null {
  if (!stderr.includes("OAM-RT-OOM")) return null;
  return (
    "The oam-hosted child hit its V8 heap cap (oam defaults to 4 GiB). Raise it with " +
    'OAM_MAX_HEAP_MB=<mb> in this server\'s env, or set "runtime": "node" for this ' +
    "server in bundles.json."
  );
}

/** One "your oam opt-in landed on node" warning per process, not one per
 *  opted-in server -- whether the reason was an absent oam or a broken one.
 *  Both are the same event to the user (they asked for oam and did not get it),
 *  the probe result is cached for the process lifetime so only one of them can
 *  ever be the reason, and a broker hosting a dozen opted-in servers must not
 *  print either line a dozen times on every boot.
 *  Cleared by resetOamBinCache so tests do not leak it across cases. */
let warnedOamUnavailable = false;

/** Why the probe produced no usable binary even though oam was present on
 *  disk. `null` is BOTH "oam is usable" and "oam is absent" -- absence is the
 *  routine case and is already conveyed by `bin === null` with no failure.
 *    "timeout" -- `oam --version` outlived OAM_PROBE_TIMEOUT_MS
 *    "exit"    -- it ran and exited non-zero (or died on a signal)
 *    "spawn"   -- it could not be executed at all (EACCES, a non-executable
 *                 file, or an injected `run` that rejected without a code) */
export type OamProbeFailure = "timeout" | "exit" | "spawn";

/**
 * Plain-English form of an OamProbeFailure -- the one line a support ticket
 * actually pastes. The machine-readable code is what `doctor --json` carries.
 *
 * ONE wording, shared by every surface that reports a broken oam, because they
 * must not word it differently: doctor's OAM RUNTIME section prints it for the
 * binary, default-runtime's describeServerRuntime folds it into a per-server
 * `reason` (which is also how `sidecars install` reaches it), and
 * resolveOamSpawn below uses it for the opted-in-but-unusable warn. A second
 * copy is how "installed but UNUSABLE" in one line and "not installed" in the
 * next line of the same report happens.
 *
 * It lives HERE, next to the type it describes, rather than in default-runtime
 * where it started: resolveOamSpawn needs it and default-runtime already
 * imports from this module, so the other direction would be an import cycle on
 * the connect path. default-runtime re-exports it, so its existing importers
 * are unaffected.
 */
export function oamFailureLabel(failure: OamProbeFailure): string {
  if (failure === "timeout") return "`oam --version` did not answer in time";
  if (failure === "exit") return "`oam --version` exited non-zero";
  return "the binary could not be executed";
}

/** Result of probing the oam binary (`oam --version`). */
export interface OamProbe {
  /** The spawnable oam binary -- null when oam is not installed OR its
   *  version is below MIN_OAM_VERSION (both mean "fall back to node"). */
  bin: string | null;
  /**
   * The same binary as an ABSOLUTE path, or null when it could not be located.
   *
   * `bin` is what to SPAWN -- a bare name is correct there, because this
   * process already resolved it against its own PATH by successfully running
   * it. `binPath` is what to PERSIST into someone else's config, which is a
   * different question for the same reason resolveNpmEntry and
   * resolveStableNpmEntry are two functions: a GUI-launched MCP client does
   * not inherit the shell PATH that made the bare name work here, so a bare
   * `oam` written into its config is an ENOENT with no fallback. Null means
   * "do not persist an oam launch" -- see install-targets.ts.
   */
  binPath: string | null;
  /** Version reported by `oam --version` (e.g. "0.6.0"), or null when oam
   *  is not installed or the output was unparseable. */
  version: string | null;
  /** True when oam IS installed but below MIN_OAM_VERSION (bin is null). */
  belowMin: boolean;
  /** Set when oam could not be used AND "not installed" is the wrong thing to
   *  say, so callers can tell a BROKEN oam from an ABSENT one -- both carry
   *  bin=null, and reporting the former as "not installed" sends the user
   *  looking for an install they already have. Usually that means oam was
   *  present and did not answer `--version`; an OAM_BIN naming a path that does
   *  not exist lands here too, because the installer cannot fix that either. */
  failure: OamProbeFailure | null;
  /** The underlying error message behind `failure`, for diagnostics. Null
   *  whenever `failure` is null. */
  failureDetail: string | null;
}

let oamProbeCache: OamProbe | undefined;

/**
 * Extract the first version from `oam --version` output ("oam 0.6.0").
 *
 * The PRERELEASE suffix is part of the match, and that is the whole point: an
 * `x.y.z`-only capture read "oam 0.8.3-rc.1" as "0.8.3", which went wrong
 * twice at once. The rc compared EQUAL to a 0.8.3 floor and was hosted, and
 * every place that prints probe.version -- doctor's runtime line, upstream's
 * `oamVersion` log field -- named a release the machine does not have, so a bug
 * found on the rc would be reported against the release. Build metadata is
 * captured for the same reporting reason; comparison ignores it, per semver.
 */
export function parseOamVersion(out: string): string | null {
  const m = /\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?/.exec(out);
  return m ? m[0] : null;
}

/** A parsed version: the release triple plus prerelease identifiers. Build
 *  metadata is dropped on purpose -- semver says it carries no precedence. */
interface Semver {
  release: [number, number, number];
  /** Empty for a release; ["rc", 1] for "-rc.1". Numeric identifiers are kept
   *  as numbers because they compare numerically ("9" < "10", not "10" < "9"). */
  pre: Array<string | number>;
}

/** Parse a LEADING x.y.z[-pre][+build], or null when the string does not open
 *  with one. Anchored: this reads a version it was handed, it does not search
 *  for one in free text -- that is parseOamVersion's job. */
function parseSemver(s: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?/.exec(s);
  if (!m) return null;
  const pre = m[4] === undefined ? [] : m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id));
  return { release: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

/** Prerelease precedence, semver rules 11.3-11.4. Split out because it is the
 *  half that is easy to get wrong: a release outranks every prerelease of the
 *  same triple, numeric identifiers rank BELOW alphanumeric ones, and a
 *  shorter identifier list loses when every shared identifier is equal. */
function comparePre(a: Array<string | number>, b: Array<string | number>): number {
  if (a.length === 0 || b.length === 0) {
    if (a.length === b.length) return 0;
    return a.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    if (a.release[i] !== b.release[i]) return a.release[i] < b.release[i] ? -1 : 1;
  }
  return comparePre(a.pre, b.pre);
}

/** Semver compare on two version STRINGS: negative when a < b, positive when
 *  a > b, 0 when equal or when either side does not parse.
 *
 *  Canonical for the whole package, and it lives HERE rather than in
 *  doctor-cmd (which used to keep a triple-only copy of the same idea) because
 *  the dependency direction only works one way: upstream -> oam-spawn is on the
 *  connect path, and importing doctor-cmd from here would drag the whole
 *  diagnostic command into it. doctor-cmd already imports this module, so it
 *  takes this one -- and the divergence that made the duplicate worth removing
 *  was real: the triple-only parse read "0.8.3-rc.1" as EQUAL to a 0.8.3 floor,
 *  so doctor would have said a prerelease met a floor this file ranks it below.
 *
 *  Anchored, per parseSemver: a leading "v" does not parse. Callers whose input
 *  can carry one (a git-tag-shaped version) normalise before calling. */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  return compareSemver(pa, pb);
}

/** Whether an on-disk copy's DECLARED version satisfies an exact pin.
 *
 *  Compared as semver when both parse, so a spec pinning `1.2.3` accepts a copy
 *  declaring `1.2.3+build` (build metadata carries no precedence). Falls back to
 *  string equality so a package whose version field is not semver at all can
 *  still match a spec that names it verbatim. A copy that declares NO version
 *  never satisfies a pin: it cannot be shown to be the requested build, and the
 *  point of the check is that "probably right" is what it replaces. */
function satisfiesExactPin(declared: string | null, want: string): boolean {
  if (declared === null) return false;
  const d = parseSemver(declared);
  const w = parseSemver(want);
  if (d && w) return compareSemver(d, w) === 0;
  return declared === want;
}

/**
 * Convert forward slashes to backslashes on Windows, because a forward-slash
 * command path mis-parses in cmd.exe ("C:/Users/.../oam.exe" makes cmd read
 * "/Users" as a switch). A backslash path (or a bare "oam.exe" on PATH) is
 * safe everywhere. No-op off Windows. `platform` is injectable so the
 * behaviour is testable cross-OS.
 *
 * The consumer that needs this is the PERSIST path, not the broker's own spawn.
 * `install` writes the resolved binary into a third-party MCP client's config
 * (install-cmd.ts -> buildLaunchEntry), and that client launches it however it
 * likes -- through cmd.exe in the shapes that already require the `cmd /c` wrap
 * for npx's `.cmd` shim. A backslash path survives all of them.
 *
 * It is NOT because of the MCP SDK: @modelcontextprotocol/sdk spawns stdio
 * servers with `shell: false` (dist/esm/client/stdio.js), so the broker's own
 * children go straight to CreateProcess and a forward-slash path spawns fine.
 * An earlier version of this comment claimed `shell: true`, which sent anyone
 * debugging a Windows spawn to cmd.exe quoting rules that were never involved.
 */
export function winNormalize(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? p.replace(/\//g, "\\") : p;
}

/**
 * Whether a candidate is something the OS loader would actually execute: a
 * regular file (following symlinks -- a shim on PATH is normally one), with the
 * execute bit off Windows.
 *
 * `existsSync` alone -- which this replaced -- accepted a DIRECTORY named `oam`
 * and a non-executable file, both of which the loader skips in favour of the
 * real binary further down PATH. Returning one of those means the install path
 * persists a launch that cannot start, which is strictly worse than the node
 * fallback it displaced.
 *
 * X_OK is checked only off Windows because it is a no-op there (Node treats it
 * as F_OK): on Windows executability IS the extension, which PATHEXT has
 * already decided by the time a candidate gets here. Gated on the INJECTED
 * platform, not process.platform, so the search stays testable cross-OS.
 */
function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform !== "win32") accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    // ENOENT, ENOTDIR, EACCES, a loop of symlinks -- every one of them means
    // "not the binary", and the caller's next candidate is the answer.
    return false;
  }
}

/**
 * Locate a binary as an ABSOLUTE path, the way the OS loader would: an already
 * absolute path is accepted if it is an executable file, and a bare name is
 * searched across PATH (times PATHEXT on Windows, where a bare `oam` is
 * spawnable but the file on disk is `oam.exe`).
 *
 * Deliberately NOT a `which`/`where` subprocess: this runs on the install path
 * and, via probeOam, on the connect path, where the async-probe rewrite above
 * exists precisely to keep child processes off it. Reading directory entries is
 * cheap and cannot hang the way a spawn can.
 *
 * ABSOLUTE is a promise, not a description of the usual case: every caller
 * either persists the result into someone else's config or prints it as the
 * resolved binary, and install-targets' buildLaunchEntry silently drops a
 * non-absolute path back to npx. So a candidate that does not come out absolute
 * is skipped rather than returned -- otherwise `install` printed "will run on
 * oam" from a truthy binPath while writing the npx entry into the config file,
 * and the command output disagreed with what it had just written.
 *
 * `env` and `platform` are injectable so the search is testable cross-OS.
 */
export function resolveBinAbsolute(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (isAbsolute(bin)) return isExecutableFile(bin, platform) ? winNormalize(bin, platform) : null;
  // A RELATIVE name that carries a separator (`./tools/oam`, `tools\oam`) is
  // NOT a PATH lookup: the OS loader spawns it against the CWD and never
  // consults PATH at all. Joining it onto every PATH entry can therefore only
  // produce a coincidence -- some unrelated `<pathdir>/tools/oam` -- which
  // would be persisted into a client config as "the oam we found". Refuse
  // instead. `\` counts only on Windows, where it is a separator; off Windows
  // it is an ordinary (if exotic) filename character.
  if (bin.includes("/") || (platform === "win32" && bin.includes("\\"))) return null;
  // Windows env vars are case-insensitive but process.env is not, and a
  // sanitized child env can carry either spelling.
  const pathVar = env.PATH ?? env.Path ?? env.path ?? "";
  if (!pathVar) return null;
  // An empty PATH entry means "cwd" to the shell; skip it rather than resolve
  // a config-bound absolute path against whatever directory we happen to be in.
  const dirs = pathVar.split(platform === "win32" ? ";" : ":").filter(Boolean);
  const pathext = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  // On Windows the empty extension is offered ONLY when the name already ends
  // in a PATHEXT extension. CreateProcess appends an extension to a name that
  // has none, so an extensionless regular file named `oam` sitting beside
  // `oam.exe` is a file Windows would never run -- a POSIX shim checked into a
  // bin dir is the everyday shape. Trying "" first regardless returned that
  // shim as binPath (isExecutableFile cannot tell them apart: X_OK is a no-op
  // on Windows), and install then persisted a launch that cannot start.
  // Keeping "" for an already-extensioned name is what stops `oam.exe` being
  // searched as `oam.exe.exe`.
  const carriesExt = pathext.some((e) => bin.toLowerCase().endsWith(e.toLowerCase()));
  const exts = platform === "win32" ? (carriesExt ? ["", ...pathext] : pathext) : [""];
  for (const dir of dirs) {
    // Windows PATH entries are commonly quoted; the quotes are shell syntax,
    // not part of the directory name.
    const clean = dir.replace(/^"|"$/g, "");
    for (const ext of exts) {
      const candidate = join(clean, bin + ext);
      // A RELATIVE PATH entry resolves the candidate against whatever directory
      // the broker happens to be in, and `join` hides it: both "." and a
      // quoted-empty `""` (which survives the filter(Boolean) empty-entry guard
      // above, because the quotes make the string non-empty) collapse to the
      // bare name. Skip rather than return -- see the ABSOLUTE promise above.
      if (!isAbsolute(candidate)) continue;
      if (isExecutableFile(candidate, platform)) return winNormalize(candidate, platform);
    }
  }
  return null;
}

/** Classify a probe rejection so callers can distinguish a BROKEN oam from an
 *  absent one. An injected `run` that rejects without a recognizable code is
 *  reported as "spawn" -- the conservative answer, since the one thing it
 *  definitely was not is a clean run. */
function classifyProbeFailure(err: unknown): OamProbeFailure {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "ETIMEDOUT") return "timeout";
  if (code === "EOAMEXIT") return "exit";
  return "spawn";
}

/**
 * Probe the oam binary once (`oam --version`) and cache the result. OAM_BIN
 * overrides the binary path; it's normalized to a cmd-safe path so a
 * forward-slash OAM_BIN still spawns. The version output is parsed and gated
 * against MIN_OAM_VERSION: a below-min install is reported with bin=null
 * (same fallback as oam-absent) plus ONE warn log naming both versions. An
 * unparseable version is treated as usable -- a working `--version` proves
 * oam exists, and refusing on a future format change would silently disable
 * every opted-in server.
 *
 * `run` is injectable so the parse + gate logic is testable without a real
 * binary on PATH.
 */
/** How long `oam --version` gets before we give up and fall back to node.
 *  Matches the 3s budget uv-bootstrap's onPath() probe already uses. */
export const OAM_PROBE_TIMEOUT_MS = 3_000;

/**
 * SIGKILL, not the SIGTERM default. The kill is best-effort either way (see
 * below), but SIGTERM is strictly weaker: a child that traps or ignores it
 * simply keeps running, and Node does not escalate on its own.
 *
 * Measured on Linux (node v18) against the old synchronous probe, timeout 1500:
 *   child traps SIGTERM,  default killSignal -> never returned (killed at 12s)
 *   child traps SIGTERM,  killSignal SIGKILL -> threw at 1508ms, ETIMEDOUT
 *   child traps nothing,  default killSignal -> threw at 1504ms  (control)
 * Windows was unaffected either way: TerminateProcess cannot be trapped.
 */
export const OAM_PROBE_KILL_SIGNAL = "SIGKILL";

/** Hard cap on retained `oam --version` stdout. Replaces the 1MB maxBuffer
 *  that execFileSync applied for free before the async rewrite. */
export const OAM_PROBE_MAX_OUTPUT = 8 * 1024;

/** Bytes of the previous chunk kept so a version split across a chunk
 *  boundary ("0.6" | ".0") still matches. A dotted triple is ~20 chars. */
const VERSION_CARRY = 32;

/**
 * Accumulator for probe stdout.
 *
 * A naive prefix cap (`if (out.length < MAX) out += chunk`) is wrong twice
 * over, and both were shipped before this existed:
 *
 *   1. It is SOFT. The length check runs before the append, so one oversized
 *      chunk lands whole -- an 80KB chunk was retained in full under the old
 *      code. The bound was "MAX plus one chunk", not MAX.
 *   2. It DISCARDS THE VERSION when a binary prints more than MAX of banner
 *      first. parseOamVersion then returns null, and because the below-min
 *      branch is guarded on `version !== null`, the MIN_OAM_VERSION gate is
 *      skipped entirely -- yaw-mcp hosts on an oam it never version-checked.
 *      That gate exists because old builds produce hangs that look like
 *      server bugs, so truncation reintroduces exactly what it guards.
 *
 * So: scan every chunk for a version regardless of position, retain only a
 * hard-capped head for the no-version case, and never grow past the cap.
 * Exported for direct unit testing -- asserting the constant's value proves
 * nothing about whether anything is actually capped.
 */
export function createProbeCollector(max: number = OAM_PROBE_MAX_OUTPUT) {
  let head = "";
  let carry = "";
  let found: string | null = null;
  // A match that ended FLUSH with everything seen so far: the next chunk may
  // still extend it, so it is held rather than latched. See push().
  let pending: string | null = null;

  return {
    push(chunk: string): void {
      // Once a TERMINATED version is in hand there is nothing left for a
      // further chunk to do: `found` is monotonic, `carry` is read only on the
      // not-yet-found branch, and `head` is unreachable through result().
      // Returning early matters for the exact case the cap exists for -- a
      // binary that keeps spewing after printing its version otherwise costs a
      // full-chunk concat plus a slice on every data event, with nothing
      // retained to show for it.
      if (found !== null) return;
      // Scan across the boundary so a version straddling two chunks is seen.
      const scan = carry + chunk;
      const hit = parseOamVersion(scan);
      if (hit !== null) {
        // A hit that runs to the very end of what has been seen is only a
        // PREFIX of the token being printed: stdout split between "oam 0.12.1"
        // and "-rc.1" would otherwise latch "0.12.1", and a floor-equal
        // prerelease then compares EQUAL to MIN_OAM_VERSION and is hosted --
        // exactly the below-min build the gate exists to refuse. Hold it until
        // a later chunk either extends it or terminates it; result() finalizes
        // whatever is held when the stream closes without another chunk.
        if (scan.endsWith(hit)) pending = hit;
        else found = hit;
      }
      carry = scan.slice(-VERSION_CARRY);
      if (head.length >= max) return;
      head += chunk.slice(0, max - head.length); // slice, so the cap is HARD
    },
    /** The version if one appeared anywhere, else the capped head (which
     *  parses to null either way, so the caller's contract is unchanged).
     *  Called after the stream closes, so a still-pending match is final: no
     *  further chunk can extend it. */
    result(): string {
      return found ?? pending ?? head;
    },
    /** Test hook: bytes actually retained. */
    retainedLength(): number {
      return head.length;
    },
  };
}

/**
 * Run `oam --version` WITHOUT blocking the event loop.
 *
 * This was execFileSync until issue #91. A synchronous probe on the upstream
 * connect path of a single-threaded broker means any oam binary that fails to
 * exit freezes the whole hub -- the client stdio transport and every in-flight
 * upstream call stop being serviced. `timeout` did not fix that: spawnSync's
 * timer only *sends* killSignal and then keeps waiting for the child to exit,
 * so an unkillable child hangs the call regardless. A process in
 * uninterruptible sleep (D state) on a wedged NFS/FUSE mount takes no signal
 * at all, SIGKILL included, until the kernel completes the I/O -- which was
 * precisely the reported failure mode.
 *
 * Async is the only actual fix: the timer settles the promise and the event
 * loop keeps turning whether or not the orphan ever dies. We still try to kill
 * it, and `unref()` the timer so a pending probe cannot hold the process open
 * at shutdown.
 *
 * Resolves to the version found in stdout (or the capped head when none was
 * found -- see createProbeCollector), or rejects with `code: "ETIMEDOUT"` on
 * expiry -- the same shape probeOam's catch already distinguishes.
 */
function spawnVersionProbe(bin: string): Promise<string> {
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
      child = spawn(bin, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: process.platform === "win32",
        // oam is a binary yaw-mcp did not write; README promises the vault
        // passphrase is stripped from every child yaw-mcp starts, and this
        // probe was one of two spawns that still inherited process.env whole.
        env: stripInternalSecretsFromEnv(process.env),
      });
    } catch (err) {
      reject(err);
      return;
    }

    // Bounded, position-independent collection -- see createProbeCollector for
    // why a plain prefix cap loses the version and does not actually cap.
    const collector = createProbeCollector();
    child.stdout?.setEncoding("utf8");
    // A pipe 'error' with no listener is an uncaught exception, which would
    // take the broker down -- precisely what the header promises this file
    // never does. And the riskiest moment is one we create on purpose: the
    // timeout path below destroys this pipe while a wedged child may still be
    // writing to it. Swallow it; there is nothing to recover, and the probe
    // still settles via 'close' or the deadline.
    child.stdout?.on("error", () => {});
    child.stdout?.on("data", (chunk: string) => collector.push(chunk));
    // 'error' fires for ENOENT (oam not installed) -- the routine case.
    child.on("error", (err) => settle(() => reject(err)));
    // `code` is null when the child died on a signal, so reporting it alone
    // yields "oam exited null" -- the one diagnostic the message carries,
    // dropped in the case most worth diagnosing.
    child.on("close", (code, signal) =>
      settle(() => {
        if (code === 0) {
          resolve(collector.result());
          return;
        }
        // Tagged so probeOam can classify this as "ran and failed" rather than
        // "could not be run" -- the two send the user to different fixes.
        const err = new Error(`oam exited ${code ?? signal}`) as Error & { code?: string };
        err.code = "EOAMEXIT";
        reject(err);
      }),
    );

    timer = setTimeout(() => {
      settle(() => {
        // Best-effort. A D-state child ignores this, which is exactly why the
        // promise is settled independently rather than waiting on the kill.
        try {
          child.kill(OAM_PROBE_KILL_SIGNAL);
        } catch {
          /* already gone */
        }
        // DETACH, do not merely kill. A live child with a piped stdout keeps
        // the PARENT's event loop alive -- verified: a parent with an unkilled
        // child and nothing else pending was still running after 6s. So when
        // the kill above does not take effect (the D-state case this whole
        // probe exists for, or a grandchild inheriting the pipe), settling the
        // promise unblocks the connect path but the broker can then never
        // exit. Trading a connect-path hang for a shutdown hang is not a fix.
        // unref drops the child from the loop's handle count; destroying stdout
        // releases the pipe the grandchild case would otherwise hold open.
        try {
          child.stdout?.destroy();
          child.unref();
        } catch {
          /* already gone */
        }
        const err = new Error(`oam --version exceeded ${OAM_PROBE_TIMEOUT_MS}ms`) as Error & { code?: string };
        err.code = "ETIMEDOUT";
        reject(err);
      });
    }, OAM_PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
}

/** In-flight probe, so N concurrent connects share ONE spawn rather than
 *  racing to start their own before any of them has populated the cache. */
let oamProbeInFlight: Promise<OamProbe> | undefined;

/** Bumped by resetOamBinCache. A probe that was already in flight when the
 *  reset landed must NOT write its result afterwards -- otherwise the reset is
 *  silently undone by a probe the caller believes it discarded, and one test's
 *  probe can populate the cache for the next. */
let oamProbeGeneration = 0;

export async function probeOam(run: (bin: string) => Promise<string> = spawnVersionProbe): Promise<OamProbe> {
  if (oamProbeCache !== undefined) return oamProbeCache;
  if (oamProbeInFlight !== undefined) return oamProbeInFlight;
  const generation = oamProbeGeneration;
  oamProbeInFlight = probeOamUncached(run, generation).finally(() => {
    if (generation === oamProbeGeneration) oamProbeInFlight = undefined;
  });
  return oamProbeInFlight;
}

/**
 * Deliberately does NOT re-check oamProbeCache. Its only caller is probeOam,
 * which reads the cache and then calls this with no await in between -- so on a
 * single-threaded loop the cache cannot have been populated since. A guard here
 * used to suggest a race that cannot happen, and an unreachable branch is worse
 * than none: it reads as tested when nothing can reach it. The real concurrency
 * is handled elsewhere -- oamProbeInFlight collapses racing callers onto one
 * spawn, and `generation` is what stops a stale result publishing.
 */
async function probeOamUncached(run: (bin: string) => Promise<string>, generation: number): Promise<OamProbe> {
  /** Whether the path probed was CHOSEN by the user rather than guessed by us.
   *  It changes what an ENOENT MEANS: a bare `oam` missing from PATH is "oam is
   *  not installed", the routine node-only case. An OAM_BIN that does not exist
   *  is a broken CONFIGURATION -- reporting it as absence hands the user the
   *  installer, which cannot fix it, because OAM_BIN still wins after they run
   *  it. That is exactly the "reinstall software you already have" loop the
   *  failure/absence split at OamProbe.failure exists to prevent. */
  const explicit = Boolean(process.env.OAM_BIN);
  const bin = winNormalize(process.env.OAM_BIN || (process.platform === "win32" ? "oam.exe" : "oam"));
  /** Publish only if no reset landed while we were awaiting the spawn. The
   *  result is still RETURNED to this call's own caller either way -- it is
   *  correct for the state it observed; it just must not become the cache a
   *  post-reset caller reads. */
  const publish = (probe: OamProbe): OamProbe => {
    if (generation === oamProbeGeneration) oamProbeCache = probe;
    return probe;
  };
  try {
    const version = parseOamVersion(await run(bin));
    if (version !== null && compareVersions(version, MIN_OAM_VERSION) < 0) {
      log("warn", "oam is installed but below the minimum supported version; falling back to node", {
        // The full token, prerelease suffix included: a build reporting
        // "0.8.3-rc.1" against a 0.8.3 floor lands here deliberately (semver
        // ranks a prerelease below its release), and naming it as "0.8.3" would
        // make this line look like a comparator bug.
        oamVersion: version,
        minVersion: MIN_OAM_VERSION,
        // The floor tracks the latest release, so below-min always means out
        // of date, and oam updates itself in place.
        updateWith: "oam self-update",
        // ...but updating alone changes nothing here. oamProbeCache is written
        // once per process and only ever cleared by a test hook, so every
        // opted-in server keeps landing on node until the broker restarts --
        // and an MCP broker under a desktop client lives for days. Without this
        // the user runs the update, sees no further log line, and reads a
        // working fix as a fix that did not work. The timeout and generic
        // failure warns say "for this process" for the same reason.
        thenRestart: "restart yaw-mcp; this probe is cached for the process lifetime",
      });
      return publish({ bin: null, binPath: null, version, belowMin: true, failure: null, failureDetail: null });
    }
    if (version === null) {
      // A clean exit with nothing version-shaped in stdout is treated as
      // usable -- a working --version proves oam exists, and an oam that
      // prints its version to stderr is the known shape here (the probe only
      // pipes stdout). But it means the MIN_OAM_VERSION gate above never ran
      // for this binary, so the "old builds hang in ways that read as server
      // bugs" class it guards is back on the table with nothing said about it.
      // Debug rather than warn: the binary works, and this is diagnostic
      // context for a hang, not something the user must act on.
      log("debug", "oam --version printed no parsable version; the minimum-version gate did not run for this binary", {
        bin,
        minVersion: MIN_OAM_VERSION,
      });
    }
    return publish({
      bin,
      // Resolved once, alongside the probe that proved the name spawns, so the
      // install path never has to re-derive it (or spawn `where`/`which`).
      binPath: resolveBinAbsolute(bin),
      version,
      belowMin: false,
      failure: null,
      failureDetail: null,
    });
  } catch (err) {
    // "oam is not installed" is the expected, silent case -- an ENOENT on the
    // bare name we guessed is routine, and logging it would be noise on every
    // node-only setup. An ENOENT on an OAM_BIN the user SET is not that case at
    // all (see `explicit` above); it gets the same treatment as a broken oam.
    //
    // EVERY other failure is not routine: oam IS on disk and did not produce a
    // usable --version. Since the probe result is cached for the process
    // lifetime, that one moment silently downgrades every opted-in server to
    // node until restart, with nothing to explain why. So warn once, matching
    // the belowMin path, and let the timeout keep its own message -- it is the
    // only failure with an actionable budget attached to it.
    const code = (err as { code?: unknown } | null)?.code;
    /** ENOENT is absence ONLY when the name was ours to guess. */
    const absent = code === "ENOENT" && !explicit;
    if (code === "ETIMEDOUT") {
      log("warn", "oam did not respond to --version in time; falling back to node for this process", {
        timeoutMs: OAM_PROBE_TIMEOUT_MS,
        bin,
      });
    } else if (code !== "ENOENT") {
      // A non-zero exit, a signal death, an EACCES on a non-executable file,
      // or a spawn that threw outright. All of them mean a present-but-broken
      // oam, which is worth strictly more noise than an absent one.
      log("warn", "oam --version failed; falling back to node for this process", {
        bin,
        error: err instanceof Error ? err.message : String(err),
      });
    } else if (explicit) {
      // The stale-OAM_BIN case. Named separately from the line above because
      // the fix is different: nothing is broken, the variable points somewhere
      // that no longer exists, and the path it names is the whole message.
      log("warn", "OAM_BIN points at a path that does not exist; falling back to node for this process", {
        bin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // A guessed-name ENOENT is absence, not a failure -- see OamProbeFailure.
    // Everything else, an explicit OAM_BIN that resolves to nothing included, is
    // an oam the user believes they have, which doctor must not report as "not
    // installed".
    return publish({
      bin: null,
      binPath: null,
      version: null,
      belowMin: false,
      failure: absent ? null : classifyProbeFailure(err),
      failureDetail: absent ? null : err instanceof Error ? err.message : String(err),
    });
  }
}

// There used to be an `oamBin()` convenience here -- `(await probeOam()).bin`.
// It had no callers, and it was the one API shape in this module that ERASED
// the below-min distinction the rest of it carefully preserves: probeOam
// returns `belowMin`, and both consumers branch on it (doctor-cmd's runtime
// line, default-runtime's "oam-below-min" verdict) to say "oam is out of date"
// rather than "oam is not installed". A future caller reaching for the
// convenient one-liner would have silently lost that, so it is gone rather
// than kept as an attractive nuisance -- `(await probeOam()).bin` is the same
// length and does not throw the distinction away invisibly.

/** Reset the cached oam-binary probe (test hook). Bumps the generation so a
 *  probe still in flight cannot publish its result afterwards. */
export function resetOamBinCache(): void {
  warnedOamUnavailable = false;
  oamProbeCache = undefined;
  oamProbeInFlight = undefined;
  oamProbeGeneration++;
  // Cleared here too so the once-per-package pinned notice does not leak
  // across cases in tests that already reset the probe.
  pinnedReported.clear();
}

export interface OamRewriteDeps {
  /** The oam binary, or null when oam is unavailable (-> Node fallback). */
  oamBin: string | null;
  /** Resolve a package name to an on-disk entry, or null if unresolvable.
   *  `wantVersion` is the exact version the spec pinned, or null when it named
   *  a tag or nothing -- the resolver must return null rather than a copy that
   *  declares something else, because `oam run <entry>` has no way to honour a
   *  pin the path does not already satisfy. */
  resolveEntry: (pkg: string, wantVersion: string | null) => string | null;
}

/** Trailing Windows executable extension. A config's `command` may carry one
 *  (`node.exe`, `npx.cmd` -- npm ships both shims), and it says nothing about
 *  what the program IS.
 *
 *  Case-INSENSITIVE, because Windows is: a hand-written or installer-generated
 *  config carries `NODE.EXE` as readily as `node.exe`, and the whole point of
 *  the basename match below is that every real shape of the same launcher is
 *  recognised. Matching only lowercase left `C:\Program Files\nodejs\NODE.EXE`
 *  classified as not-Node, so an opted-in server silently ran on node forever
 *  and doctor -- which calls the same helper -- agreed with the spawn, leaving
 *  nothing anywhere to explain why the opt-in did nothing. */
const WIN_EXE_EXT = /\.(?:exe|cmd|bat)$/i;

/**
 * Which Node launcher a command names, or null for anything else.
 *
 * Matched on the BASENAME, with any Windows executable extension removed, so
 * every real shape of the same launcher is recognised: `node`, `node.exe`,
 * `/usr/local/bin/node`, `C:\Program Files\nodejs\node.exe`, an nvm/volta shim,
 * `npx.cmd`. Exact string equality against "node"/"npx" -- which is what this
 * replaced -- silently opted those launches out of the oam runtime, and an
 * absolute interpreter path is an ordinary MCP config shape, not an edge case.
 * README's "only non-Node launches are left alone" is only true with this.
 *
 * Exported because doctor answers the same question independently
 * (default-runtime.ts, the `not-node-command` verdict) and the two MUST agree:
 * a spawn that hosts on oam while doctor reports node is a worse failure than
 * either behaviour on its own.
 */
export function nodeLaunchKind(command: string): "node" | "npx" | null {
  const base = (command.split(/[\\/]/).pop() ?? command).replace(WIN_EXE_EXT, "").toLowerCase();
  if (base === "node") return "node";
  if (base === "npx") return "npx";
  return null;
}

/** Entry extensions oam type-checks. `oam run` defaults to `--check warn`, so a
 *  TypeScript entry spawns tsgo alongside the server. */
const TS_ENTRY_RE = /\.[mc]?ts$/i;

/**
 * Pure rewrite of a Node-based launch to `oam run`. Returns {command,args}
 * UNCHANGED for the Node-fallback cases described in the module header.
 *   node <entry> [..rest]      -> oam run <entry> [-- ..rest]
 *   node <entry>.ts [..rest]   -> oam run --no-check <entry>.ts [-- ..rest]
 *   npx [-y] <pkg> [..rest]    -> oam run <resolved> [-- ..rest]
 */
export function rewriteForOam(
  command: string,
  args: string[],
  deps: OamRewriteDeps,
): { command: string; args: string[] } {
  const bin = deps.oamBin;
  if (!bin) return { command, args };

  const toOam = (entry: string, rest: string[]) => {
    // `oam run` type-checks a TypeScript entry concurrently by default
    // (--check warn), which spawns tsgo beside the sidecar and writes its
    // diagnostics to the child's stderr -- where, on a boot failure, they are
    // what lands in the 500-char failure tail instead of the real error. The
    // rewrite is billed as a pure optimization of a launch node was already
    // going to run unchecked, so checking is not ours to add: `--no-check`
    // keeps the hosted launch behaving like the one it replaced.
    const flags = TS_ENTRY_RE.test(entry) ? ["--no-check"] : [];
    return {
      command: bin,
      args: rest.length > 0 ? ["run", ...flags, entry, "--", ...rest] : ["run", ...flags, entry],
    };
  };

  const kind = nodeLaunchKind(command);

  if (kind === "node") {
    const [entry, ...rest] = args;
    if (!entry) return { command, args };
    // A leading-dash arg is a node flag (--enable-source-maps, --inspect, ...),
    // not the entry file; oam would eat it and mis-launch. Stay on node --
    // mirrors the npx flag guard below.
    if (entry.startsWith("-")) return { command, args };
    return toOam(entry, rest);
  }

  if (kind === "npx") {
    // Only -y/--yes are recognized, so any OTHER npx flag (--package, -p,
    // --node-options, ...) lands in `spec` and would be treated as the
    // package name. Staying on npx is the safe answer -- reimplementing
    // npx's arg parser here is not worth it -- but say WHY at debug level:
    // from the outside, an opted-in server quietly running on node is
    // indistinguishable from oam being absent.
    //
    // -y/--yes are skipped only where npx ITSELF consumes them: before the
    // spec. Everything after the spec belongs to the SERVER, so `rest` is
    // sliced from the original argv rather than from a filtered copy.
    // Filtering the whole list also ate a server's own trailing `--yes`, so
    // the oam launch and the npx fallback handed the child different
    // arguments -- the one thing this rewrite promises never to do. The scan
    // itself lives in npxSpecIndex so sidecars-cmd's two collectors cannot
    // drift from it.
    const specIdx = npxSpecIndex(args);
    const spec = specIdx === -1 ? undefined : args[specIdx];
    if (!spec) return { command, args };
    if (spec.startsWith("-")) {
      // The flag and the argv LENGTH, never the argv itself: everything after
      // the flag belongs to the server, and a server's args are where a token
      // rides (`--token <secret>`). The logger does no redaction, and
      // LOG_LEVEL=debug is exactly what support asks a user to turn on before
      // sending the client's log files over -- this was the one line in the
      // broker that copied a server's whole command line into them.
      log("debug", "npx launch carries flags yaw-mcp does not parse; staying on npx instead of oam", {
        flag: spec,
        argc: args.length,
      });
      return { command, args };
    }
    // A git or path spec (`github:owner/repo`, `./local-server`) is not a
    // package NAME, and resolveNpmEntry would look it up as one -- path.join
    // collapses the "." so `./local-server` becomes a top-level `local-server`,
    // i.e. a different program than the directory the config points at. See
    // isRegistrySpec.
    if (!isRegistrySpec(spec)) {
      log("debug", "npx spec is a git/path target, not a registry package; staying on npx instead of oam", { spec });
      return { command, args };
    }
    const pkg = packageName(spec);
    // What the spec asks for version-wise. `oam run <entry>` runs whatever sits
    // at that path, so anything the resolver cannot prove has to keep npx --
    // npx re-resolves the spec against the registry and therefore honours it.
    const constraint = specConstraint(spec);
    if (constraint.kind === "range") {
      log("debug", "npx spec constrains the version with a range yaw-mcp cannot evaluate; staying on npx", {
        package: pkg,
        range: constraint.raw,
      });
      return { command, args };
    }
    const wantVersion = constraint.kind === "exact" ? constraint.version : null;
    const entry = deps.resolveEntry(pkg, wantVersion);
    if (!entry) {
      // oam run needs a real on-disk entry; it can't reproduce npx's
      // fetch-on-demand. Keep npx.
      //
      // Two different reasons land here and they send the reader to different
      // places, so they get different lines: nothing on disk at all (install it,
      // or leave it -- npx will fetch it) versus nothing on disk AT THE PINNED
      // VERSION, where npx is not a fallback but the only thing that can honour
      // the pin at all.
      if (wantVersion !== null) {
        log("debug", "no on-disk copy declares the pinned version; staying on npx so the pin is honoured", {
          package: pkg,
          version: wantVersion,
        });
      } else {
        log("debug", "npx package has no on-disk entry; staying on npx instead of oam", { package: pkg });
      }
      return { command, args };
    }
    return toOam(entry, args.slice(specIdx + 1));
  }

  return { command, args };
}

/** The path fragment that marks an npm `_npx` cache directory. Derived once:
 *  npxCacheNodeModules locates the cache with it and both resolvers CLASSIFY
 *  on it (cache copies are fine to spawn but wrong to persist, and they take
 *  different refresh advice), so three local copies of the same magic
 *  fragment is exactly how those three decisions drift apart. */
const NPX_CACHE_MARKER = `${sep}_npx${sep}`;

/** Every `_npx/<hash>/node_modules` under one `_npx` root, or `[]` when the
 *  root cannot be read -- `npm cache clean` during a long-lived broker's life,
 *  a pruned or unreadable directory. The catch is what keeps that a quiet node
 *  fallback instead of an unhandled throw on the connect path. ONE body for the
 *  two locators below, which differ only in how they find the root: a
 *  byte-identical copy in each is how the two came to be maintained apart. */
function npxHashNodeModules(npxRoot: string): string[] {
  try {
    return readdirSync(npxRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(npxRoot, e.name, "node_modules"));
  } catch {
    return [];
  }
}

/**
 * The `node_modules` directories of every npx install cache, derived from a
 * module path that lives under `_npx/<hash>/...`. When the broker is itself
 * launched via `npx -y @yawlabs/mcp`, its own location is inside one such
 * cache, so the SIBLING caches -- where other `npx -y <pkg>` servers were
 * fetched -- are reachable from here. Returns `[]` when the path is not under
 * an npx cache (e.g. a global or `node <abs>` launch).
 *
 * `fromUrl` is injectable for testing; it defaults to this module's own URL.
 */
export function npxCacheNodeModules(fromUrl: string = import.meta.url): string[] {
  let here: string;
  try {
    here = fileURLToPath(fromUrl);
  } catch {
    return [];
  }
  const idx = here.indexOf(NPX_CACHE_MARKER);
  if (idx === -1) return [];
  const npxRoot = here.slice(0, idx + NPX_CACHE_MARKER.length - sep.length); // ".../_npx"
  return npxHashNodeModules(npxRoot);
}

/**
 * An npmrc value, decoded the way npm's own ini parser decodes one.
 *
 * Worth doing properly because the two shapes a hand-written npmrc actually
 * contains are the two a naive `(.+?)\s*$` capture gets wrong, and both produce
 * a cache directory that does not exist -- after which readdirSync throws, the
 * npx-cache search finds nothing, and every npx sidecar quietly stays on npx,
 * indistinguishable from "no sidecars installed":
 *
 *   * An INLINE comment. `cache=/tmp/x ; scratch dir` is `/tmp/x` to npm; the
 *     naive capture takes the comment with it. (A comment on its own LINE was
 *     already handled -- by the `^\s*cache` anchor, which cannot match one --
 *     so the explicit `^\s*[;#]` guard that used to sit here was unreachable
 *     code guarding against the one case that could not occur.)
 *   * Quoting. A quoted value is unquoted, and a `\;` inside an unquoted one is
 *     a literal semicolon rather than the start of a comment.
 *
 * The backslash handling is the subtle part and it is why this mirrors ini
 * rather than simplifying: an escape that does NOT precede `\`, `;` or `#` is
 * kept WITH its backslash, which is the only reason a Windows
 * `cache=C:\Users\me\npm-cache` survives at all. A generic unescape would eat
 * every separator and hand back `C:Usersmenpm-cache`.
 */
function npmrcValue(raw: string): string {
  const v = raw.trim();
  const quoted = v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")));
  if (quoted) {
    if (v.startsWith('"')) {
      try {
        return JSON.parse(v) as string;
      } catch {
        // Not valid JSON -- a Windows path is the everyday case ("C:\Users\me"
        // has invalid JSON escapes). Take it literally, quotes removed.
        return v.slice(1, -1);
      }
    }
    return v.slice(1, -1);
  }
  let out = "";
  let esc = false;
  for (const c of v) {
    if (esc) {
      out += ";#\\".includes(c) ? c : `\\${c}`;
      esc = false;
      continue;
    }
    if (c === ";" || c === "#") break; // start of an inline comment
    if (c === "\\") {
      esc = true;
      continue;
    }
    out += c;
  }
  if (esc) out += "\\"; // a trailing lone backslash is itself
  return out.trim();
}

/** The `cache=` setting in an npmrc, or null when the file is absent or does
 *  not set one. npmrc is `key=value` per line with `;`/`#` comments.
 *
 *  The LAST `cache=` wins, because that is what npm's ini parser does: a
 *  duplicate key overwrites the earlier one as the file is parsed. Taking the
 *  first match instead resolved to a directory npm has stopped filling, the
 *  `_npx` readdir under it found nothing, and every npx sidecar quietly stayed
 *  on npx -- indistinguishable from "no sidecars installed".
 *
 *  `${VAR}` references are expanded from the environment, because npm's config
 *  layer does that to every value it loads from a file (@npmcli/config's
 *  envReplace) and `cache=${XDG_CACHE_HOME}/npm` is how a dotfiles repo writes
 *  a relocated cache. Left literal, the result was a directory that exists on
 *  no machine, readdirSync threw, and every npx sidecar quietly stayed on npx.
 *  Mirrored exactly, escapes included: `\${VAR}` is a literal `${VAR}` (an odd
 *  run of backslashes escapes), and a name the environment does not carry is
 *  left as written rather than replaced with "" -- which is what npm does too.
 *  Expanded BEFORE the `~/` step below, in npm's order.
 *
 *  `~/` is expanded, because npm expands it for path-typed config fields
 *  (@npmcli/config's parse-field) and `cache=~/.npm-cache` is a natural thing
 *  to write. Only the `~/` form, which is the only one npm itself expands -- a
 *  bare `~` or a Windows `~\` is left alone rather than resolved to something
 *  npm would not have resolved. */
function npmrcCache(file: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  // Scan every line and keep the last hit -- see the last-key-wins note above.
  let last: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    // The anchor is what excludes a whole-line comment: `;cache=/x` does not
    // match `^\s*cache`.
    const m = /^\s*cache\s*=(.*)$/.exec(line);
    if (!m) continue;
    const value = expandNpmrcEnv(npmrcValue(m[1]));
    // An empty value is skipped rather than latched as "the last one": it
    // cannot name a directory, and treating it as the winner would let a
    // stray `cache=` line erase a real setting above it.
    if (!value) continue;
    last = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  }
  return last;
}

/** npm's envReplace, verbatim in behaviour: `${NAME}` becomes the environment's
 *  value for NAME; an odd number of backslashes ahead of it escapes (half of
 *  them survive, the reference stays literal); an even number is halved and
 *  the reference expands; an unset NAME is left as the literal `${NAME}`. */
function expandNpmrcEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/(\\*)\$\{([^${}]+)\}/g, (orig, esc: string, name: string) => {
    if (esc.length % 2 === 1) return orig.slice((esc.length + 1) / 2);
    const val = env[name];
    return esc.slice(esc.length / 2) + (val === undefined ? `\${${name}}` : val);
  });
}

// Memoized PER fromUrl: the answer cannot change within a process, and this
// sits behind the connect path. Keyed rather than a single slot because the
// result genuinely depends on the argument -- a single slot would make the
// first caller's fromUrl decide the answer for every later one, which is a
// parameter that silently stops mattering.
const npmCacheDirCache = new Map<string, string | null>();

/**
 * npm's cache directory -- the parent of `_npx`, where `npx -y <pkg>` puts the
 * package it fetched.
 *
 * Resolved WITHOUT shelling out to `npm config get cache`: that is ~half a
 * second of process spawn on a path that runs while an MCP client waits for
 * its tools. Instead this walks npm's own precedence order over the npmrc
 * files, which are plain text and cheap to read.
 *
 * The builtin npmrc is the one that matters in practice and the easy one to
 * forget: version managers (scoop, nvm, volta, asdf) relocate the cache there,
 * NOT in the user's `~/.npmrc`, so a resolver that checks only the user file
 * and the platform default misses the cache entirely on a managed install. It
 * lives beside npm itself in the global `node_modules`, which is exactly what
 * ownNodeModules() already computes -- `process.execPath` is no good for this,
 * because a shimmed install (scoop's `current` junction) points somewhere the
 * global tree is not.
 *
 * Returns null when nothing resolves, which just means "no npx cache to
 * search" -- callers fall back to node/npx as always.
 */
export function npmCacheDir(fromUrl: string = import.meta.url): string | null {
  const cached = npmCacheDirCache.get(fromUrl);
  if (cached !== undefined) return cached;
  const resolved = resolveNpmCacheDir(fromUrl);
  npmCacheDirCache.set(fromUrl, resolved);
  return resolved;
}

/** Reset the memoized npm cache dirs (test hook). */
export function resetNpmCacheDir(): void {
  npmCacheDirCache.clear();
}

function resolveNpmCacheDir(fromUrl: string): string | null {
  // npm's precedence, highest first.
  //
  // The env key is matched CASE-INSENSITIVELY because npm matches it that way:
  // it lowercases the `npm_config_` prefix when folding the environment into
  // config, so `NPM_CONFIG_CACHE` -- the spelling CI images and Dockerfiles
  // reach for, since the rest of their env is uppercase -- is applied by npm.
  // Reading only the lowercase spelling meant npm filled one cache while this
  // resolver scanned the `_npx` under a different one, and every npx sidecar
  // silently stayed on npx. A POSIX-only bug: process.env is already
  // case-insensitive on Windows, which is why it survived. If BOTH spellings
  // are set (a user error either way) the first one enumerated wins.
  const envKey = Object.keys(process.env).find((k) => /^npm_config_cache$/i.test(k));
  const fromEnv = envKey === undefined ? undefined : process.env[envKey];
  if (fromEnv) return fromEnv;

  const candidates = [join(homedir(), ".npmrc")];
  for (const nodeModules of ownNodeModules(fromUrl)) {
    // The GLOBAL npmrc is `<prefix>/etc/npmrc`, and how far the prefix sits
    // above the global root DIFFERS BY PLATFORM: Windows installs globals into
    // `<prefix>\node_modules` (prefix is one level up, so dirname IS the
    // prefix), POSIX into `<prefix>/lib/node_modules` (prefix is two levels
    // up). Only the one-level form used to be pushed, so on mac/Linux this
    // candidate was `$PREFIX/lib/etc/npmrc` -- a path npm never writes. A
    // `cache=` set in the real global npmrc was therefore never read, the
    // resolver fell through to the compiled-in default, and npmCacheNpxNodeModules
    // then scanned an `_npx` npm no longer writes to: every `npx -y <pkg>`
    // sidecar silently stayed on npx. Push BOTH shapes -- the one that does not
    // match the running layout simply does not exist, so the extra candidate
    // costs one failed read.
    //
    // NOT covered: npm's PROJECT config, which outranks the user file. npm
    // reads `.npmrc` at the localPrefix (the nearest ancestor with a
    // package.json / node_modules), not at the cwd, and approximating that walk
    // with `<cwd>/.npmrc` would read a file npm itself would ignore whenever the
    // broker is launched from a subdirectory. A missed project `cache=` costs a
    // fallback to npx; a wrongly-read one hosts sidecars out of a cache npm is
    // not filling, so the omission is the safe side of that trade.
    candidates.push(
      join(dirname(nodeModules), "etc", "npmrc"), // <prefix>/node_modules      (Windows)
      join(dirname(dirname(nodeModules)), "etc", "npmrc"), // <prefix>/lib/node_modules  (POSIX)
      join(nodeModules, "npm", "npmrc"), // builtin, beside npm itself
    );
  }
  // npm as it sits beside the running node itself. This is what covers a
  // broker that is NOT globally installed -- a repo checkout or a project
  // `node_modules` has no npm inside it, so the loop above finds nothing.
  const nodeDir = dirname(process.execPath);
  candidates.push(
    join(nodeDir, "node_modules", "npm", "npmrc"), // Windows layout
    join(nodeDir, "..", "lib", "node_modules", "npm", "npmrc"), // POSIX layout
  );
  for (const file of candidates) {
    const cache = npmrcCache(file);
    if (cache) return cache;
  }

  // npm's compiled-in default, used when no npmrc overrides it.
  const fallback =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "npm-cache")
      : join(homedir(), ".npm");
  return fallback && existsSync(fallback) ? fallback : null;
}

/**
 * Every `_npx/<hash>/node_modules` under npm's cache directory.
 *
 * The sibling npxCacheNodeModules() finds these too, but ONLY when the broker
 * itself was launched through npx, because it derives the cache root from the
 * broker's own module path. A globally installed broker has no `_npx` segment
 * in its path, so it saw nothing -- and `npm i -g @yawlabs/mcp` is precisely
 * what `install` recommends in order to host on oam. The result was that the
 * oam runtime silently did nothing for every `npx -y <pkg>` sidecar on the
 * most common install shape, while doctor still reported them as "oam".
 *
 * Locating the cache independently of the broker's own path is what closes
 * that gap.
 */
export function npmCacheNpxNodeModules(cacheDir: string | null): string[] {
  if (!cacheDir) return [];
  return npxHashNodeModules(join(cacheDir, "_npx"));
}

/**
 * The `node_modules` that contains the broker itself, derived from the LAST
 * `node_modules` segment of a module path. Lets the broker's own dependencies
 * be searched even when it is launched as a global / `node <abs>` install (not
 * via npx). Returns `[]` when the path has no `node_modules` segment.
 *
 * `fromUrl` is injectable for testing; it defaults to this module's own URL.
 */
export function ownNodeModules(fromUrl: string = import.meta.url): string[] {
  let here: string;
  try {
    here = fileURLToPath(fromUrl);
  } catch {
    return [];
  }
  const seg = `${sep}node_modules${sep}`;
  const idx = here.lastIndexOf(seg);
  if (idx === -1) return [];
  return [here.slice(0, idx + seg.length - sep.length)];
}

/**
 * Read a package's RUNNABLE entry from its package.json: the `bin` (the CLI
 * `npx` would execute), falling back to `main`. Deliberately NOT
 * `require.resolve`, which returns the `exports["."]` LIBRARY entry -- often a
 * different file than the bin (e.g. fetch-mcp: bin=dist/index.js vs
 * exports.=dist/server.js) AND throws ERR_PACKAGE_PATH_NOT_EXPORTED on an
 * ESM-only `exports` with no `require`/`default` condition. Reading
 * package.json directly sidesteps the package's own `exports` gating entirely.
 *
 * Returns the declared `version` alongside the entry. Choosing between cached
 * copies needs it, and this function has already parsed the file the version
 * lives in -- reading it a second time would mean two reads and two JSON
 * parses per candidate, across every npx cache directory (well over a hundred
 * on a machine that has used npx for a while) on the connect path.
 */
interface PackageHit {
  entry: string;
  /** null when the package declares no usable `version` string. */
  version: string | null;
}

function packageEntry(pkgDir: string, pkg: string): PackageHit | null {
  const pjPath = join(pkgDir, "package.json");
  if (!existsSync(pjPath)) return null;
  // Parsed as `unknown` and narrowed by hand, because the SHAPE is as
  // untrusted as the syntax: this reads every `_npx/<hash>` cache dir on the
  // machine plus the managed tree, and a manifest that is valid JSON but not a
  // package.json object (`null`, an array) or that declares a non-string bin
  // (`"bin": {"x": 1}`) used to throw a TypeError out of the connect path.
  // That throw is fatal where a null would have been free: upstream.ts wraps
  // it as an ActivationError, and its one-shot node respawn only fires once the
  // rewrite has been APPLIED -- which it never was, so the server fails to
  // activate at all instead of staying on npx. The header's "never a
  // correctness dependency" holds only if every malformed shape here is a null.
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pjPath, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const j = parsed as { bin?: unknown; main?: unknown; name?: unknown; version?: unknown };
  let rel: unknown;
  if (typeof j.bin === "string") {
    rel = j.bin;
  } else if (j.bin && typeof j.bin === "object") {
    // Prefer the bin keyed by the unscoped name, then the full name, then the
    // first declared bin (servers often name the bin differently from the pkg).
    // OWN keys only: a package whose unscoped name is "constructor" (or any
    // other Object.prototype key) would otherwise read the prototype's function
    // through a plain index, and that is not a path either.
    const bins = j.bin as Record<string, unknown>;
    const own = (key: unknown): unknown =>
      typeof key === "string" && Object.hasOwn(bins, key) ? bins[key] : undefined;
    const unscoped = pkg.slice(pkg.lastIndexOf("/") + 1);
    rel = own(unscoped) ?? own(j.name) ?? Object.values(bins)[0];
  }
  if (!rel && typeof j.main === "string") rel = j.main;
  // Anything but a non-empty string is not an entry -- and isAbsolute throws
  // ERR_INVALID_ARG_TYPE on a non-string rather than returning false.
  if (typeof rel !== "string" || rel.length === 0) return null;
  const entry = isAbsolute(rel) ? rel : join(pkgDir, rel);
  // A DECLARED entry is not an entry on disk. package.json is the manifest, not
  // the file listing: a `files` field that omits the bin, a partially pruned
  // cache directory, or an interrupted install all leave a package.json whose
  // `bin` points at nothing. Without this check the module header's "an npx
  // package can't be resolved on disk -> npx" and rewriteForOam's "oam run
  // needs a real entry" were both promises this function did not keep, and the
  // cost of breaking them is a guaranteed-failing spawn: `oam run <missing>`
  // exits 1 immediately (error[OAM-RT0002]), the boot fails on transport close,
  // and upstream burns its one-shot node respawn -- where staying on npx was
  // free. One existsSync per candidate, on a path this function has already
  // built, is the cheapest possible way to keep the promise.
  if (!existsSync(entry)) return null;
  return {
    entry,
    version: typeof j.version === "string" ? j.version : null,
  };
}

/**
 * Resolve a package name to an on-disk RUNNABLE entry, or `null`. Searches the
 * broker's own node_modules first, then every npx cache -- an `npx -y <pkg>`
 * server lives in a `_npx/<hash>/node_modules` the broker's own resolver can't
 * see, so without this an opted-in npx server silently falls back to Node.
 * Among cached copies the HIGHEST version wins. Resolves the package's BIN
 * (read straight from package.json) rather than require.resolve's library "."
 * export. `null` keeps the npx/node command.
 *
 * `wantVersion` is the exact version an `npx -y <pkg>@1.2.3` spec pinned. When
 * set, a copy is a candidate ONLY if it declares that version -- including the
 * durable trees, which are otherwise authoritative: a deliberate `npm i` is
 * still the wrong build if the config asked for a different one, and falling
 * through to a cache copy that DOES declare it honours the pin where taking the
 * managed copy would quietly break it. Returning null then keeps npx, which is
 * the only thing that can actually fetch the pinned version.
 *
 * `fromUrl`, `npmCache`, and `managedRoot` are injectable for testing; they
 * default to this module's own URL, the resolved npm cache, and the managed
 * sidecar tree. Tests should pass `npmCache` and `managedRoot` explicitly (a
 * temp dir, or null) so they never read the host's real cache or home dir.
 */
export function resolveNpmEntry(
  pkg: string,
  fromUrl: string = import.meta.url,
  npmCache: string | null = npmCacheDir(fromUrl),
  managedRoot: string | null = sidecarsNodeModules(),
  wantVersion: string | null = null,
): string | null {
  const parts = pkg.split("/"); // "@scope/name" -> ["@scope", "name"]

  // A durable install is authoritative: it is a deliberate `npm i`, it is the
  // single copy, and it is what npx itself would prefer. Take it outright.
  //
  // The managed tree (`yaw-mcp sidecars install`) comes first among these: it
  // is the only one the user asked yaw-mcp to maintain, so when it and some
  // ambient node_modules both have the package, the managed answer is the one
  // they can actually move forward by re-running the command.
  // The broker's OWN node_modules sits UNDER _npx whenever yaw-mcp was itself
  // launched via `npx -y @yawlabs/mcp` -- the common install shape, not an edge
  // case. Calling that "durable" would advertise `npm install <pkg>@latest`,
  // which cannot refresh a content-hashed cache directory.
  // resolveStableNpmEntry draws the same distinction for the same reason.
  const own = ownNodeModules(fromUrl);
  const ownCache = own.filter((nodeModules) => nodeModules.includes(NPX_CACHE_MARKER));
  const ownDurable = own.filter((nodeModules) => !nodeModules.includes(NPX_CACHE_MARKER));
  const durable: Array<{ nodeModules: string; source: PinSource }> = [
    ...(managedRoot ? [{ nodeModules: managedRoot, source: "managed" as const }] : []),
    // Only the copies that are genuinely durable take part in the take-outright
    // loop. A sidecar sitting in the broker's OWN _npx hash dir is a cache copy
    // like any other, so it belongs in the highest-version scan below -- taking
    // it outright let an old build in our own hash dir beat a NEWER copy in a
    // sibling cache dir, which is the opposite of the rule that scan exists to
    // enforce. (Only the ranking was wrong: the replaced branch already keyed
    // `source` off NPX_CACHE_MARKER, so an own `_npx` copy was tagged
    // "npx-cache" and did get the `npx -y <pkg>@latest` refresh advice.)
    ...ownDurable.map((nodeModules) => ({ nodeModules, source: "durable" as PinSource })),
  ];
  for (const { nodeModules, source } of durable) {
    const hit = packageEntry(join(nodeModules, ...parts), pkg);
    if (!hit) continue;
    // A pin outranks "authoritative": this tree is the right PLACE but the
    // wrong BUILD, so keep looking rather than host a version the config
    // explicitly did not ask for.
    if (wantVersion !== null && !satisfiesExactPin(hit.version, wantVersion)) continue;
    // Every source is reported here, but not at the same level: an ambient
    // durable copy pins as hard as a cache copy and is just as invisible
    // otherwise, so both go to info -- while the managed tree is a pin the
    // user deliberately chose, so it goes to debug. See notePinnedSidecar.
    notePinnedSidecar(pkg, hit.version, source, nodeModules);
    return hit.entry;
  }

  // The npx cache is keyed by content hash, not by package, so a machine that
  // has run a server for months holds every version it ever fetched -- 15
  // copies of one sidecar is real, observed. Iteration order is the hash
  // order, i.e. arbitrary, so taking the first hit silently pinned whatever
  // the directory listing happened to surface: a config that says `@latest`
  // ran a months-old build with no warning anywhere. Pick the highest version
  // instead, which is the closest on-disk answer to what `@latest` asked for.
  // ownCache is folded in explicitly rather than left to npxCacheNodeModules:
  // that helper enumerates the _npx root by readdir, which yields our own hash
  // dir too on a good day but nothing at all when the readdir fails. The Set
  // makes the overlap free.
  const roots = new Set([...ownCache, ...npxCacheNodeModules(fromUrl), ...npmCacheNpxNodeModules(npmCache)]);
  let best: PackageHit | null = null;
  let bestRoot: string | null = null;
  // The PARSED version of `best`, or null when it has none / declares one that
  // is not semver. Kept beside `best` rather than re-derived from
  // best.version because comparing through compareVersions cannot express the
  // difference: it returns 0 both for "equal" and for "one of these does not
  // parse", so a non-null-but-unparseable incumbent could never be displaced.
  // That is not the symmetric rule the old comment here claimed -- it made the
  // FIRST such copy win outright and left the highest-version pick, the entire
  // reason this loop exists, decided by directory-hash order instead.
  let bestParsed: Semver | null = null;
  for (const nodeModules of roots) {
    const hit = packageEntry(join(nodeModules, ...parts), pkg);
    if (!hit) continue;
    if (wantVersion !== null && !satisfiesExactPin(hit.version, wantVersion)) continue;
    const parsed = hit.version === null ? null : parseSemver(hit.version);
    // Take it when nothing has been found yet, or when this candidate has a
    // real version and the incumbent's is missing/unparseable, or when both
    // parse and this one is higher. A GENUINE tie -- the same version in two
    // cache dirs, or "1.2.3" against "1.2.3+build" -- keeps the incumbent, i.e.
    // directory order decides; that is fine, because the copies are the same
    // release. Prerelease precedence is part of the compare, so "0.4.0" beats
    // "0.4.0-rc.1" rather than tying with it.
    const wins = best === null || (parsed !== null && (bestParsed === null || compareSemver(parsed, bestParsed) > 0));
    if (wins) {
      best = hit;
      bestRoot = nodeModules;
      bestParsed = parsed;
    }
  }
  if (best !== null && bestRoot !== null) notePinnedSidecar(pkg, best.version, "npx-cache", bestRoot);
  return best?.entry ?? null;
}

/** Where a resolved entry came from. Governs the command that actually moves
 *  that copy forward -- the three are genuinely different, and naming the
 *  wrong one is worse than naming none. */
type PinSource = "managed" | "durable" | "npx-cache";

/** How to refresh a pinned copy, per source.
 *
 *  None of these can be fully scoped from here: a durable tree may be global
 *  (the command needs `-g`) or project-local (it needs to run in that
 *  project), and this cannot tell which. So the command names WHAT to run and
 *  the notice's `from` field names WHERE -- printing a bare `npm install`
 *  with no directory is advice that silently updates the wrong tree. */
const REFRESH_COMMAND: Record<PinSource, (pkg: string) => string> = {
  managed: () => "yaw-mcp sidecars install",
  durable: (pkg) => `npm install ${pkg}@latest`,
  // No trailing flag. `npx -y <pkg>@latest` re-resolves the tag and refreshes
  // the cache tree BEFORE it execs the binary, which is all the refresh
  // needs -- and stdio MCP servers ignore flags like `--help` and simply
  // start, so tacking one on turns "runs briefly" into "hangs the terminal
  // on a server waiting for stdin" (measured on
  // @modelcontextprotocol/server-memory). `npm cache add` is no substitute:
  // it only fills _cacache, never the _npx install tree this resolver reads.
  // No inline `#` comment either: that is comment syntax only in sh and
  // PowerShell -- cmd.exe hands `#` and everything after it to npx as literal
  // argv for the spawned server, which arg-parsing servers fail on. The
  // Ctrl-C guidance rides in REFRESH_NOTE instead, so the command itself is
  // copy-paste safe in all three shells.
  "npx-cache": (pkg) => `npx -y ${pkg}@latest`,
};

/** Guidance that belongs NEXT TO a refresh command but must not live IN it.
 *
 *  The npx-cache command starts the server it just refreshed, so the user
 *  needs to know that Ctrl-C at that point is success, not failure. Appending
 *  that as a `# ...` comment made the string non-runnable in cmd.exe (see the
 *  REFRESH_COMMAND comment above), so it is a sibling field: every consumer
 *  of refreshWith surfaces refreshNote beside it when one exists. */
const REFRESH_NOTE: Partial<Record<PinSource, string>> = {
  "npx-cache": "then Ctrl-C -- the cache is refreshed before the server starts",
};

/** Packages already reported as pinned -- one line each, not one per connect. */
const pinnedReported = new Set<string>();

/** Reset the pinned-sidecar log dedupe (test hook). */
export function resetPinnedSidecarLog(): void {
  pinnedReported.clear();
}

/**
 * Say, once per package, that a sidecar is running from an on-disk copy rather
 * than through npx.
 *
 * This is the one user-visible consequence of hosting on oam that is otherwise
 * invisible. `npx -y <pkg>@latest` re-resolves the tag on every spawn, so those
 * servers used to update themselves; `oam run <entry>` cannot, because oam has
 * no fetch-on-demand. Worse, once oam is the default, npx stops running for
 * these servers at all, so the cache that supplied the entry also stops being
 * refreshed -- the version pins itself indefinitely.
 *
 * Logged at info, not debug: a debug-level line is exactly how the resolver's
 * failure to find these packages at all went unnoticed.
 *
 * EXCEPT for the managed tree, which is the one source the user explicitly
 * chose: they ran `sidecars install`, that command printed the versions on
 * its way out, and doctor reports them on demand. Repeating it per package on
 * every boot restates a decision they already made, so it drops to debug. The
 * other two sources are genuinely invisible otherwise, which is the whole
 * reason this notice exists.
 */
function notePinnedSidecar(pkg: string, version: string | null, source: PinSource, from: string): void {
  if (pinnedReported.has(pkg)) return;
  pinnedReported.add(pkg);
  log(
    source === "managed" ? "debug" : "info",
    "hosting sidecar on oam from an on-disk copy; it will not self-update the way npx does",
    {
      package: pkg,
      version: version ?? "unknown",
      source,
      // The node_modules the entry was actually resolved out of. refreshWith
      // cannot name it -- a durable tree may be global or project-local, and
      // the command differs -- so this is what makes the advice actionable
      // rather than something to run in whatever cwd the user happens to be.
      from,
      refreshWith: REFRESH_COMMAND[source](pkg),
      // Only npx-cache has one today; JSON.stringify drops the field entirely
      // for the sources that do not, rather than printing "undefined".
      refreshNote: REFRESH_NOTE[source],
    },
  );
}

/**
 * Resolve a package entry ONLY from a durable install -- a real global or
 * project `node_modules`, never the npx cache.
 *
 * Writing a launch entry into a client's config is a different problem from
 * spawning a sidecar right now, so it needs a different resolver:
 *
 *   * An npx-cache path is fine to spawn (it exists this instant) but wrong to
 *     PERSIST. `~/.npm/_npx/<hash>` is a cache; `npm cache clean` or an
 *     eviction turns the client's MCP entry into a path that isn't there, and
 *     a broker that fails to launch at all is strictly worse than one running
 *     on node.
 *   * A durable path also keeps updates working. `npm update -g` rewrites the
 *     global install IN PLACE, so a pinned path still picks up new versions.
 *     That matters because the npx entry it replaces carries `@latest`, which
 *     re-resolves on every spawn -- pointing at a cache path keyed by content
 *     hash would silently freeze the broker at one version forever.
 *
 * Returning null means "stay on npx", and it is the common answer: when
 * yaw-mcp is itself launched via `npx -y`, its own module lives in the cache,
 * so there is nothing durable to point at.
 */
export function resolveStableNpmEntry(pkg: string, fromUrl: string = import.meta.url): string | null {
  for (const nodeModules of ownNodeModules(fromUrl)) {
    if (nodeModules.includes(NPX_CACHE_MARKER)) continue;
    const hit = packageEntry(join(nodeModules, ...pkg.split("/")), pkg);
    if (hit) return hit.entry;
  }
  return null;
}

/**
 * Resolve a server's launch to run on oam unless it has opted OUT -- oam is
 * the default whenever it is installed and meets MIN_OAM_VERSION. A no-op for
 * non-Node commands and a safe Node fallback when oam isn't installed or the
 * package can't be resolved on disk.
 *
 * `optedIn` says whether oam was actually ASKED for (per-server `runtime` or a
 * config default) as opposed to merely being the default; it only governs
 * whether an absent oam is worth a warning.
 */
export async function resolveOamSpawn(
  command: string,
  args: string[],
  optedIn = true,
): Promise<{ command: string; args: string[] }> {
  const probe = await probeOam();
  // Absence is silent inside the probe on purpose -- warning there would fire
  // on every node-only install, which is noise -- but when the user EXPLICITLY
  // opted in and is getting node anyway, that is indistinguishable from oam
  // working, so say it once. `optedIn` is false when oam is merely the default
  // (nothing configured); an absent oam is then the expected state, not a
  // misconfiguration, and must stay quiet. belowMin already warns in the probe
  // with its own actionable numbers, so it is excluded here.
  // Gated on the launch actually being one oam would host: upstream.ts calls
  // this for EVERY local server whose effective runtime is oam, including
  // docker / uvx / python commands rewriteForOam would never touch. For
  // those, "opted in to oam but oam is not installed; running it on node
  // instead" told the user to install oam (doctor reports the same server
  // as `not-node-command`) and claimed a node fallback that never happens.
  if (optedIn && probe.bin === null && !probe.belowMin && !warnedOamUnavailable && nodeLaunchKind(command) !== null) {
    warnedOamUnavailable = true;
    // A BROKEN oam and an ABSENT one both arrive here with bin=null and send
    // the user to OPPOSITE fixes, so they get opposite messages. Telling
    // someone whose oam timed out or is non-executable to "install oam" -- with
    // the install commands attached, one line after the probe already said
    // `oam --version` failed -- sends them to reinstall software they have.
    // doctor and describeServerRuntime already branch on `failure`; this was
    // the last surface reporting every failure as absence.
    if (probe.failure !== null) {
      log("warn", "a server opted in to oam but oam is installed and unusable; running it on node instead", {
        reason: oamFailureLabel(probe.failure),
        // The raw error behind the label. It is the part a support ticket needs
        // and the part the plain-English line deliberately does not carry.
        detail: probe.failureDetail,
        // No install commands: the install is already there. Pointing OAM_BIN
        // at a working copy is the actionable move, and the probe is cached for
        // the process lifetime, so repairing it needs a restart to take effect.
        overrideWith: "OAM_BIN",
        thenRestart: "restart yaw-mcp; this probe is cached for the process lifetime",
      });
    } else {
      log("warn", "a server opted in to oam but oam is not installed; running it on node instead", {
        // Both, not oamInstallCommand(CURRENT_OS): this is a structured log
        // line read off a server's stderr, which is routinely a different
        // machine from the one reading it. The rendered REPORTS (doctor,
        // install) are the surfaces that know which platform they are about.
        install: OAM_INSTALL_SH,
        installWindows: OAM_INSTALL_PS1,
        overrideWith: "OAM_BIN",
      });
    }
  }
  return rewriteForOam(command, args, {
    oamBin: probe.bin,
    // The three injectables (fromUrl, npmCache, managedRoot) keep their
    // production defaults -- explicit `undefined` rather than a reorder,
    // because they are positional and every test call site passes them.
    resolveEntry: (pkg, wantVersion) => resolveNpmEntry(pkg, undefined, undefined, undefined, wantVersion),
  });
}

/** True when a launch command names an oam binary -- bare "oam"/"oam.exe" or
 *  any path ending in one. Splits on BOTH separators: Windows is the platform
 *  that writes a backslash path here (`C:\...\oam.exe`), so a "/"-only split
 *  would fail to recognise oam on the very platform the entry came from.
 *  Not a PATH lookup -- this classifies what the config ASKS for, and a bare
 *  name resolves at spawn time. */
export function isOamCommand(command: string): boolean {
  const base = command.split(/[\\/]/).pop() ?? command;
  return /^oam(\.exe)?$/i.test(base);
}

/**
 * Whether a launch entry runs the broker on oam, including through a shell
 * wrapper.
 *
 * `install` never writes the wrapped shape -- the `cmd /c` wrap exists for
 * npx's `.cmd` shim and oam is a real executable -- but a hand-edited config
 * reasonably might, and reporting "node" for an entry that plainly launches
 * oam is worse than not reporting at all.
 */
export function isOamLaunch(command: string, args: readonly string[] = []): boolean {
  if (isOamCommand(command)) return true;
  const base = command.split(/[\\/]/).pop() ?? command;

  // cmd and POSIX shells package their payload DIFFERENTLY, and treating them
  // alike is why the first version of this recognised neither real shape.
  if (/^cmd(\.exe)?$/i.test(base)) {
    // cmd takes the command as separate argv entries. Skip its own switches:
    // `/d /s /c` is the everyday shape (npm emits it), not just `/c`. The
    // pattern is deliberately "slash + ONE letter" so a POSIX path argument
    // like /usr/local/bin/oam is never mistaken for a switch.
    const first = args.find((a) => !/^\/[a-z]$/i.test(a));
    return first !== undefined && isOamCommand(first);
  }

  if (/^(sh|bash|zsh|dash)$/i.test(base)) {
    // A POSIX shell takes the WHOLE command as one string after -c
    // ("oam run /path/index.js"), so the payload has to be tokenised. Reading
    // it as a bare command name is what made this return false for every
    // realistic `sh -c` entry.
    const dashC = args.indexOf("-c");
    const payload = dashC >= 0 ? args[dashC + 1] : args[0];
    if (payload === undefined) return false;
    // Strip quotes that do not hide a space. Tokenising on whitespace cannot
    // recover a quoted path that CONTAINS one, and a display marker does not
    // justify a shell parser -- such an entry reports "node". Under-reporting
    // is the safe direction: it never claims oam for something that is not.
    const firstToken = payload
      .trim()
      .split(/\s+/)[0]
      ?.replace(/^["']|["']$/g, "");
    return firstToken !== undefined && firstToken.length > 0 && isOamCommand(firstToken);
  }

  return false;
}
