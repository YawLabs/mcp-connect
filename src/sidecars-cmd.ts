// `yaw-mcp sidecars install` -- install the configured MCP servers durably.
//
// The problem this exists for. A server configured `npx -y <pkg>@latest` gets
// its package from npm's `_npx` cache, and that arrangement has two properties
// that only became load-bearing once oam started hosting sidecars:
//
//   * The cache is keyed by content hash, so it accumulates every version ever
//     fetched and nothing ever names which one is current.
//   * `npx` re-resolved `@latest` on every spawn, which is what kept those
//     servers up to date. `oam run <entry>` cannot -- oam has no fetch-on-
//     demand -- so once oam is the default, npx stops running for that server
//     and the cache stops being refreshed. The version pins itself.
//
// Installing into a directory yaw-mcp owns fixes both: one copy per package, a
// version that is written down, and a single command that moves it forward.
// resolveNpmEntry prefers this tree over any cache copy (oam-spawn.ts).
//
// Deliberately NOT automatic. Acquiring packages means network and minutes, and
// the connect path is what an MCP client blocks on while waiting for its tools
// -- a first connect that silently turns into an npm install is the wrong
// trade. Nothing breaks without running it; resolution falls back to the cache
// exactly as before.
//
// Why npm and not `oam install`, which sounds like the obvious tool here:
//
//   * It is frozen-lockfile only ("the default and only mode for MVP"), so it
//     reproduces an existing lockfile and cannot acquire `@latest` into an
//     empty directory. Something has to create the lockfile first.
//   * Its `--precompile` buys nothing for this workload. It pre-compiles
//     TypeScript found in installed packages, and MCP servers ship compiled
//     JavaScript to npm -- measured across every sidecar in the default
//     bundle, the count of runnable .ts files is zero and the precompile
//     cache comes back empty.
//   * Running it OVER an npm-installed tree is worse than useless: it skips
//     lifecycle scripts unless the package is trusted (`oam trust add`), so a
//     server that needs a postinstall -- puppeteer downloading a browser --
//     silently loses it and fails at spawn rather than at install.
//
// So npm does the install, and this file does not chain `oam install` after
// it. That is a deliberate decision with the measurement behind it, not an
// oversight to be tidied up later.
//
// It DOES take two npm steps: `install` acquires, and `update` is the only one
// of the two that can move an already-locked `@latest` forward on a re-run. See
// the note at the update call for the measurement behind that.

import { type StdioOptions, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { acquireUpgradeLock } from "./auto-upgrade.js";
import { describeDefaultRuntime, describeServerRuntime } from "./default-runtime.js";
import { stripInternalSecretsFromEnv } from "./internal-secret-env.js";
import { type LoadLocalBundlesResult, loadLocalBundles, localBundlesPath } from "./local-bundles.js";
import {
  isRegistrySpec,
  nodeLaunchKind,
  npxSpec,
  type OamProbe,
  packageName,
  probeOam,
  specConstraint,
} from "./oam-spawn.js";
import { sidecarsNodeModules, sidecarsRoot, userConfigDir } from "./paths.js";
import type { UpstreamServerConfig } from "./types.js";

// paths.ts owns these; they are re-exported for the callers that think of them
// as part of this command's surface (doctor-cmd + the tests). SIDECARS_DIRNAME
// is deliberately NOT among them -- it had no importer here, and one more
// re-export hides paths.ts as the actual owner.
export { sidecarsNodeModules, sidecarsRoot } from "./paths.js";

// isRegistrySpec is imported from oam-spawn.ts rather than reimplemented here.
// The two files want it for DIFFERENT reasons -- oam-spawn needs a package NAME
// it can use as an on-disk lookup key, this file needs one it can use as a
// dependency KEY in a generated manifest -- but the predicate that answers both
// is the same one, and it was maintained twice as a byte-identical copy. Two
// copies of a spec-parsing rule is how the spawn path and the install path come
// to disagree about which servers are registry packages, which is exactly the
// pair that must not drift: a server the manifest installs but the rewrite
// skips (or vice versa) is a tree nothing reads.
//
// Why THIS file cares, since the reason no longer sits on the function:
// `packageName` passes a git or path spec through whole -- there is no
// `@version` separator to cut at -- so `npx -y github:owner/repo` would land in
// the manifest as `{"github:owner/repo": "latest"}`. npm rejects that as an
// invalid name and fails the WHOLE install, so one unusually-configured server
// would stop every other package from installing.
//
// A git or path spec is legitimate configuration, so both call sites below skip
// rather than error: those servers keep resolving through npx exactly as
// before, and collectNonRegistrySpecs reports which ones were passed over.
// Resolving them properly would mean fetching the target just to learn the name
// it declares, which is more than this command should do.

export interface SidecarSpec {
  /** Bare package name, e.g. "@yawlabs/fetch-mcp". */
  pkg: string;
  /** The spec as configured, e.g. "@yawlabs/fetch-mcp@latest". */
  spec: string;
  /** Namespaces that launch this package -- one package can back several. */
  namespaces: string[];
  /** Other specs configured for this same package, when they disagree with
   *  `spec`. A flat node_modules holds ONE version, so the others cannot be
   *  honoured -- they are carried here so the command can say so instead of
   *  dropping them silently. Empty in the ordinary case. */
  conflicting: string[];
}

/**
 * The servers this command means by "an npx server": a LOCAL server whose
 * command classifies as an npx launch.
 *
 * ONE predicate, not one per caller. Three sites have to answer this
 * identically -- collectSidecarSpecs and the two skip collectors, which
 * PARTITION the same server set into "installed" and "passed over", and
 * unhostedReasons, which decides whether the question of who reads the tree
 * arises at all. It was written out three times, kept in step only by comments
 * saying it must be, and a fourth copy would have drifted silently.
 *
 * "npx" is recognised via nodeLaunchKind, NOT string equality: `npx.cmd` and
 * an absolute `/usr/local/bin/npx` are the same launch, and rewriteForOam
 * hosts them on oam through that same classifier. A collector matching only
 * the bare string would install nothing for such a server while the rewrite
 * happily reads the (empty) managed tree for it -- the server silently keeps
 * resolving out of the npx cache, which is the failure this module exists to
 * prevent.
 */
function isLocalNpxServer(s: Partial<UpstreamServerConfig>): boolean {
  return s.type === "local" && s.command !== undefined && nodeLaunchKind(s.command) === "npx";
}

/**
 * The npx-launched packages in a server list, de-duplicated by package name.
 *
 * Only `npx` servers are candidates (isLocalNpxServer). `node <abs>` already
 * points at a real file, and docker/uvx/native commands are not npm packages
 * at all. An npx launch carrying flags yaw-mcp does not parse is skipped for
 * the same reason rewriteForOam skips it: the first positional is not reliably
 * the package.
 *
 * Two further shapes are passed over because rewriteForOam refuses them on
 * EVERY machine, so installing them would fill the managed tree with copies
 * nothing can ever read: a git or path target (collectNonRegistrySpecs) and a
 * version range (collectRangeSpecs). Both are reported by the runner rather
 * than dropped silently.
 *
 * When the same package is configured twice at DIFFERENT versions, the first
 * spec wins and the rest are recorded in `conflicting`. One flat node_modules
 * cannot hold two versions of a package, so a loser is unavoidable -- but a
 * server configured `pkg@1.0.0` that silently starts on `@latest` is a lie the
 * caller should get to see, so the runner prints it.
 */
export function collectSidecarSpecs(servers: Array<Partial<UpstreamServerConfig>>): SidecarSpec[] {
  const byPkg = new Map<string, SidecarSpec>();
  for (const s of servers) {
    if (!isLocalNpxServer(s)) continue;
    // Which argument is the package spec is oam-spawn's rule, not a second copy
    // of it: this collector and the two skip collectors PARTITION the same
    // server set into "installed" and "skipped", so a rule that lives in two
    // places can drop a server out of both reports with nothing to say why.
    const spec = npxSpec(s.args ?? []);
    if (spec === null) continue;
    // A git or path spec cannot be a dependency key; including it would make
    // npm reject the manifest and fail the install for every other package
    // too. See isRegistrySpec.
    if (!isRegistrySpec(spec)) continue;
    // A version RANGE (`^1.2.3`, `1.x`) is refused by rewriteForOam everywhere
    // -- honouring it needs a semver resolver oam-spawn deliberately does not
    // carry -- so the server spawns through npx and never looks at the managed
    // tree. Installing it anyway put a package in a tree nothing reads while
    // "These versions are now fixed" claimed the opposite for it, which is the
    // install/spawn drift this module's header says must not happen.
    // collectRangeSpecs reports it instead.
    if (specConstraint(spec).kind === "range") continue;
    // Never empty: isRegistrySpec above only passes a spec whose name part
    // matched a non-empty name pattern, so there is nothing to guard here.
    const pkg = packageName(spec);
    const existing = byPkg.get(pkg);
    if (existing) {
      if (s.namespace && !existing.namespaces.includes(s.namespace)) existing.namespaces.push(s.namespace);
      // Only a DIFFERENT spec is a conflict; the same package pinned the same
      // way by two servers is the common case and says nothing.
      if (spec !== existing.spec && !existing.conflicting.includes(spec)) existing.conflicting.push(spec);
      continue;
    }
    byPkg.set(pkg, { pkg, spec, namespaces: s.namespace ? [s.namespace] : [], conflicting: [] });
  }
  return [...byPkg.values()];
}

/**
 * npx servers whose spec is a git or path target rather than a registry
 * package, paired with the namespace that configured them. Reported so the
 * skip is visible -- a server missing from the install list with no
 * explanation reads as a bug.
 */
export function collectNonRegistrySpecs(
  servers: Array<Partial<UpstreamServerConfig>>,
): Array<{ namespace: string; spec: string }> {
  const out: Array<{ namespace: string; spec: string }> = [];
  for (const s of servers) {
    if (!isLocalNpxServer(s)) continue;
    // Same shared rule as collectSidecarSpecs -- see the note there.
    const spec = npxSpec(s.args ?? []);
    if (spec === null || isRegistrySpec(spec)) continue;
    out.push({ namespace: s.namespace ?? "(unnamed)", spec });
  }
  return out;
}

/**
 * npx servers whose spec pins a version RANGE (`pkg@^1.2.3`, `pkg@1.x`),
 * paired with the namespace that configured them.
 *
 * The other half of the same partition collectNonRegistrySpecs reports:
 * rewriteForOam refuses a range on every machine (specConstraint -> "range"),
 * so those servers keep spawning through npx and never read the managed tree.
 * Installing one therefore put a package in a tree nothing reads while the
 * command still printed "These versions are now fixed" for it. Reported so the
 * skip is visible -- a server missing from the install list with no
 * explanation reads as a bug.
 *
 * An exact pin is NOT in here: the rewrite honours it whenever the on-disk copy
 * declares that version, so the managed copy IS read for it.
 */
export function collectRangeSpecs(
  servers: Array<Partial<UpstreamServerConfig>>,
): Array<{ namespace: string; spec: string }> {
  const out: Array<{ namespace: string; spec: string }> = [];
  for (const s of servers) {
    if (!isLocalNpxServer(s)) continue;
    const spec = npxSpec(s.args ?? []);
    if (spec === null || !isRegistrySpec(spec) || specConstraint(spec).kind !== "range") continue;
    out.push({ namespace: s.namespace ?? "(unnamed)", spec });
  }
  return out;
}

/**
 * The configured version range for a spec: everything after the package name,
 * with the `@` separator stripped, and a bare name reading as `latest` (which
 * is what npx would have resolved).
 *
 * ONE derivation, exported, because two callers have to agree on it exactly.
 * sidecarsManifest writes it into the managed package.json as the dependency
 * value npm then acts on; sidecar-refresh asks whether a spec ASKED to float
 * before it will schedule a background refresh for it. A refresher that read
 * `pkg@^1.0.0` as floating while the manifest wrote `^1.0.0` would schedule a
 * refresh npm then refuses to perform, and re-schedule it every day forever.
 *
 * It lives HERE rather than beside its other caller because sidecar-refresh
 * already imports this module -- the other direction would close a cycle.
 */
export function configuredRange(spec: SidecarSpec): string {
  // collectSidecarSpecs derives `pkg` FROM `spec` via packageName, so the name
  // is always a prefix -- but a caller constructing a SidecarSpec by hand (or a
  // future collector) could break that, and slicing by a length that does not
  // correspond to a prefix yields a nonsense range. Report the whole spec as
  // the range: it will not equal "latest", so the package is left alone, which
  // is the safe direction for an input we do not understand.
  if (!spec.spec.startsWith(spec.pkg)) return spec.spec;
  const raw = spec.spec.slice(spec.pkg.length).replace(/^@/, "");
  return raw === "" ? "latest" : raw;
}

/**
 * The package.json yaw-mcp writes into the managed directory.
 *
 * `private` so a stray `npm publish` in that directory cannot do anything, and
 * the dependency VALUE is the version range from the configured spec -- a bare
 * `<pkg>` with no `@version` becomes `latest`, matching what npx would have
 * resolved.
 */
export function sidecarsManifest(specs: SidecarSpec[]): string {
  const dependencies: Record<string, string> = {};
  for (const spec of specs.slice().sort((a, b) => a.pkg.localeCompare(b.pkg))) {
    // The same derivation sidecar-refresh measures staleness against, called
    // rather than re-inlined -- see configuredRange on why the two must not
    // drift.
    dependencies[spec.pkg] = configuredRange(spec);
  }
  return `${JSON.stringify(
    {
      name: "yaw-mcp-sidecars",
      version: "0.0.0",
      private: true,
      description: "MCP servers installed by `yaw-mcp sidecars install`. Managed file -- edits are overwritten.",
      dependencies,
    },
    null,
    2,
  )}\n`;
}

/** What `sidecars install` records about the machine that filled the tree. */
export interface SidecarsPlatform {
  /** `process.platform` of the installing process, e.g. "darwin". */
  platform: string;
  /** `process.arch` of the installing process, e.g. "arm64". */
  arch: string;
}

/** Marker file recording which platform/arch last filled the managed tree. */
export function sidecarsPlatformPath(home: string = homedir()): string {
  return join(sidecarsRoot(home), "platform.json");
}

/**
 * The platform/arch the managed tree was installed FOR, or null when unknown
 * (no marker -- a tree from before the marker existed, or none at all).
 *
 * Why this exists: the tree is keyed on HOME alone, deliberately -- one tree
 * per machine is the documented design, and keying by arch would double the
 * disk for the overwhelmingly common single-arch machine. But npm resolves
 * native bindings (platform-specific optional deps, node-gyp builds) for the
 * node that RUNS the install, so a home directory shared across architectures
 * -- an x64 node under Rosetta, an NFS home mounted on two machines -- leaves
 * a tree whose bindings fail at spawn on the other arch, while the package
 * version reads as present and fine. Recording who installed it is the cheap
 * half of the fix: doctor compares this against its own process and says so,
 * instead of reporting a tree that cannot load as healthy.
 */
export function installedPlatform(home: string = homedir()): SidecarsPlatform | null {
  try {
    const raw = JSON.parse(readFileSync(sidecarsPlatformPath(home), "utf8"));
    if (typeof raw?.platform === "string" && typeof raw?.arch === "string") {
      return { platform: raw.platform, arch: raw.arch };
    }
    return null;
  } catch {
    return null;
  }
}

/** The installed version of a package in the managed tree, or null. */
export function installedVersion(pkg: string, home: string = homedir()): string | null {
  const pj = join(sidecarsNodeModules(home), ...pkg.split("/"), "package.json");
  try {
    const v = JSON.parse(readFileSync(pj, "utf8")).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export interface SidecarsInstallOptions {
  home?: string;
  cwd?: string;
  json?: boolean;
  out?: (s: string) => void;
  /** Where load-time diagnostics go. Defaults to stderr, which is what keeps
   *  them out of the `--json` document on stdout -- the same split bundles-cmd
   *  and local-add-cmd already use. Injected in tests. */
  err?: (s: string) => void;
  /** Injected in tests. Resolves to the child's exit code. */
  runNpm?: (args: string[], cwd: string) => Promise<number>;
  /** Platform the npm spawn shape is decided for; defaults to the running one.
   *  Injected so a test can exercise the Windows shell branch and the POSIX one
   *  wherever the suite runs, WITHOUT redefining `process.platform` for the
   *  whole call -- doing that also takes atomicWriteFile's Windows-only rename
   *  retry away from the very host that needs it (AV / indexer EPERM), which
   *  made a test about spawn options flaky under Defender. Ignored when
   *  `runNpm` is injected: that runner does its own spawning, if any. */
  platform?: NodeJS.Platform;
  /** Injected in tests. Answers "can oam host these servers", which decides
   *  whether anything will READ the tree this command fills. Defaults to the
   *  real (process-cached) probe. */
  oamProbe?: () => Promise<OamProbe>;
  /** The lock that serializes every writer of the managed tree; defaults to
   *  {@link acquireSidecarsLock} on the sidecars root. Null means another live
   *  process is mid-refresh on this tree and the install must not run.
   *  Injected in tests, and by sidecar-refresh -- which already HOLDS that lock
   *  when it calls this command, so it hands over a no-op rather than contend
   *  with itself (see backgroundInstallOptions there). */
  acquireLock?: (dir: string) => (() => void) | null;
}

export interface SidecarsInstallResult {
  exitCode: number;
  installed: Array<{ pkg: string; version: string | null; namespaces: string[] }>;
  lines: string[];
}

/** Every key the `--json` document carries, on every path. */
interface SidecarsJson {
  /** The managed directory. Present even when nothing was installed, so a
   *  consumer never has to branch on its absence to learn where it looks. */
  root: string;
  installed: Array<{ pkg: string; version: string | null; namespaces: string[] }>;
  /** Why nothing was installed, else null. */
  reason: string | null;
  /** What went wrong, else null. */
  error: string | null;
  /** Why the refresh step failed, else null. Separate from `error` because the
   *  install itself SUCCEEDED: the packages are on disk and usable, they just
   *  may not have moved forward. A consumer that treats this as fatal would
   *  discard a perfectly good tree. */
  updateError: string | null;
  /** Why the platform marker beside the tree could not be written, else null.
   *  Like `updateError`, the install itself SUCCEEDED; doctor will just read
   *  the tree as pre-marker until the next successful install. */
  markerError: string | null;
  /** Why nothing on this machine will READ the tree that was just filled -- one
   *  entry per distinct reason, from the same verdicts as the human note (see
   *  unhostedReasons). Empty means at least one server resolves to oam, which
   *  is the healthy case; NON-empty is the state where `installed` is full and
   *  every server nonetheless still resolves through the npx cache, so a
   *  consumer reporting install health has to look here and not only at
   *  `error`. Empty on the paths that installed nothing, where the question
   *  does not arise. */
  unhosted: string[];
  /** Packages configured at two different versions; the winner is the version
   *  reported in `installed`. Empty in the ordinary case. */
  conflicts: Array<{ pkg: string; used: string; ignored: string[] }>;
  /** npx servers passed over because the managed tree cannot serve them: their
   *  spec is a git or path target rather than a registry package, or it pins a
   *  version range the oam rewrite refuses on every machine. Both classes mean
   *  the same thing to a consumer -- that server keeps resolving through npx --
   *  so they share one field; the human notes name which is which. */
  skipped: Array<{ namespace: string; spec: string }>;
}

/**
 * Emit the `--json` document.
 *
 * One shape on EVERY path. The three exit paths previously emitted three
 * different objects -- `{root, installed}`, `{installed, reason}`, and
 * `{installed, error}` -- so a caller could not read `root` without first
 * working out which path it had hit, and had to probe for keys to tell
 * success from failure. Defaulting every field here means the document has
 * the same keys whether the install worked, found nothing, or failed.
 */
function jsonDocument(root: string, over: Partial<SidecarsJson> = {}): string {
  const doc: SidecarsJson = {
    root,
    installed: [],
    reason: null,
    error: null,
    updateError: null,
    markerError: null,
    unhosted: [],
    conflicts: [],
    skipped: [],
    ...over,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * The npm to spawn, preferring the one installed BESIDE the running node.
 *
 * npm resolves native bindings (platform-specific optional deps, node-gyp
 * builds) for whichever node RUNS it, and the platform marker written after a
 * successful install records THIS process's platform/arch. A bare `npm` off
 * PATH need not be the same node -- a mixed-arch machine (an x64 node under
 * Rosetta, two installs on one PATH, an arm64 shell calling an x64 shim) is
 * exactly the case the marker exists for -- so a marker written from here would
 * certify an arch the tree was not built for. Taking the sibling keeps the two
 * describing the same node. Residual assumption when there is NO sibling (a
 * standalone node build, a container image with npm elsewhere): the PATH shim's
 * node is this one.
 *
 * On Windows the command line goes through cmd.exe (see defaultRunNpm), so an
 * absolute path has to carry its own quotes -- the default install location is
 * `C:\Program Files\nodejs`, which would otherwise split at the space. Still no
 * user-controlled string in the command line: this path comes from
 * process.execPath.
 *
 * `platform` and `nodeDir` are injectable so both branches are exercisable on
 * one machine.
 */
export function npmBin(
  platform: NodeJS.Platform = process.platform,
  nodeDir: string = dirname(process.execPath),
): string {
  const name = platform === "win32" ? "npm.cmd" : "npm";
  const sibling = join(nodeDir, name);
  if (!existsSync(sibling)) return name;
  return platform === "win32" ? `"${sibling}"` : sibling;
}

/** What a caller of {@link defaultRunNpm} may need to differ on. Everything
 *  else about the spawn is fixed, and deliberately so. */
export interface RunNpmOptions {
  /** Platform whose spawn shape to use; defaults to the running one. See
   *  SidecarsInstallOptions.platform for why this is a parameter rather than a
   *  `process.platform` a test redefines. */
  platform?: NodeJS.Platform;
  /** The child's stdio. Defaults to the CLI shape (see below). Pass "ignore"
   *  for a BACKGROUND install: from inside `serve` the default sprays npm's
   *  progress into the stream the MCP client reads diagnostics from. */
  stdio?: StdioOptions;
  /** Hide the console window Windows allocates for a console child of a
   *  process that has none. Off by default and on for the BACKGROUND install
   *  only, because the two callers want opposite things. `serve` under a
   *  GUI-launched MCP client has no console, so without the flag cmd.exe and
   *  npm pop a blank window onto the desktop for the 10-60s the two runs take
   *  -- once a day, from a process the user never sees (the oam probe hides
   *  for the same reason, oam-spawn.ts). The CLI is attached to a terminal,
   *  and there the flag is CREATE_NO_WINDOW: it detaches npm from that console,
   *  so a Ctrl-C that kills the CLI no longer reaches npm and the install
   *  keeps running, half-owned, after the user thought they stopped it. */
  windowsHide?: boolean;
}

/** Spawn npm so the user sees progress on a long install.
 *
 *  Exported because this is the one spawn shape in the package that must not be
 *  re-derived by hand: the Windows-shell concession below is safe only under
 *  conditions a second copy cannot be trusted to keep. sidecar-refresh's
 *  background install needs the same shape with silent stdio and a hidden
 *  window, which is what `stdio` and `windowsHide` are for -- a caller differing
 *  on output must not have to restate the security-sensitive part. */
export function defaultRunNpm(args: string[], cwd: string, opts: RunNpmOptions = {}): Promise<number> {
  return new Promise((resolve) => {
    // npm on Windows is a .cmd shim, and since the CVE-2024-27980 fix Node
    // REFUSES to spawn .cmd/.bat without a shell -- it fails EINVAL before the
    // process starts. So Windows must go through the shell. That is safe here
    // only because every argument is a fixed literal: `cwd` travels as a spawn
    // option rather than in the command line, so no user-controlled path is
    // ever parsed by cmd. Do not interpolate a package name into these args.
    const platform = opts.platform ?? process.platform;
    const isWindows = platform === "win32";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(npmBin(platform), args, {
        cwd,
        // npm's own progress ("added 220 packages in 12s") goes to its STDOUT,
        // and inheriting that put it ahead of the JSON document under --json --
        // enough to make `yaw-mcp sidecars install --json | jq` fail outright.
        // Routing the child's stdout to fd 2 keeps the progress visible while
        // leaving OUR stdout carrying only the result, which is what a caller
        // parses. The DEFAULT for every mode rather than a --json-only shape:
        // progress belongs on stderr in both, and a mode-dependent stdio is a
        // second shape to get wrong. Only a caller with nowhere to PUT the
        // progress overrides it (see RunNpmOptions.stdio).
        stdio: opts.stdio ?? ["ignore", 2, "inherit"],
        shell: isWindows,
        // Always an explicit boolean so BOTH shapes are pinned by the spawn
        // test rather than one of them reading as "unset"; ignored off Windows.
        windowsHide: opts.windowsHide ?? false,
        // npm runs arbitrary lifecycle scripts from the registry, and the
        // in-server daily refresh reaches this spawn with the vault passphrase
        // sitting in process.env. README promises yaw-mcp strips its own
        // secrets from EVERY child it starts; this was the one npm run that
        // did not (upstream.ts and auto-upgrade.ts already do).
        env: stripInternalSecretsFromEnv(process.env),
      });
    } catch {
      // spawn can fail SYNCHRONOUSLY rather than emitting 'error' -- an option
      // the platform rejects (the EINVAL above, before the shell workaround) or
      // a cwd that vanished between mkdir and here. Without this catch the
      // throw escapes the executor, rejects runSidecarsInstall, and the CLI
      // prints a raw Node message instead of the "keeps resolving from the npx
      // cache" degradation the ENOENT path reports. Same -1 as that path.
      resolve(-1);
      return;
    }
    child.on("error", () => resolve(-1));
    child.on("close", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
  });
}

/** Name of the lockfile that serializes every writer of the managed tree --
 *  this command and sidecar-refresh's background refresh -- in the sidecars
 *  root. Passed to acquireUpgradeLock explicitly rather than leaning on its
 *  default, so the heartbeat below touches the SAME file the take created by
 *  construction and not because two modules agree on a string. The value
 *  still equals auto-upgrade's historical default on purpose: a `serve` from
 *  a build before this constant existed holds the lock under that name, and a
 *  rename would let this build run npm beside it during the one mixed-version
 *  window an upgrade creates. Free to rename once that window is past. */
export const SIDECARS_LOCK_NAME = ".yaw-mcp-upgrade.lock";

/** How often a held lock's mtime is refreshed while an install runs. An order
 *  of magnitude inside auto-upgrade's ten-minute stale window, so a heartbeat
 *  that is merely late (a loaded machine, a paused VM) still lands well before
 *  the lock reads as abandoned. */
export const SIDECAR_LOCK_HEARTBEAT_MS = 60 * 1000;

/** The lock every writer of the managed tree takes: this command's install and
 *  sidecar-refresh's background refresh. Two npm reify passes rewriting one
 *  node_modules at once retire and extract the same package dirs concurrently
 *  -- ENOTEMPTY/EPERM mid-reify, or a torn package dir -- and each reports its
 *  own exit code with no idea the other ran.
 *
 *  auto-upgrade's acquireUpgradeLock, not a second implementation of it: the
 *  O_EXCL take, the stale-steal window and the backwards-clock skew margin are
 *  subtle enough that a copy would drift. It is keyed on the DIRECTORY, so a
 *  lock in the sidecars root cannot contend with a lock in a global npm prefix
 *  -- the two features serialize independently even though they share the
 *  primitive. Null means another live process holds it. A directory the lock
 *  cannot be CREATED in yields a no-op release and the install runs
 *  unserialized, exactly as before the lock existed: it is advisory.
 *
 *  What IS added on top: a heartbeat. auto-upgrade's ten-minute stale-steal
 *  window was sized for its own hold -- one `npm install -g` of one package,
 *  seconds long -- and an unstealable lock there would disable self-upgrade
 *  forever, so ten minutes is generous for THAT caller. This lock is held
 *  across a whole-tree `npm install` plus `npm update` that this module's
 *  header calls "network and minutes", and on a cold cache or a slow link
 *  minutes can pass ten of them. A second writer starting inside a live
 *  install would then read the lock as abandoned, steal it, and run a second
 *  npm into the same tree -- the exact concurrent install the lock exists to
 *  prevent. Touching the file every minute keeps the mtime acquireUpgradeLock
 *  measures inside the window for as long as the holder is alive, so only a
 *  lock whose owner really is gone gets stolen. The timer is unref'd (it must
 *  never hold the process open) and cleared by the release callback, and a
 *  failed touch stops the heartbeat rather than logging once a minute. */
export function acquireSidecarsLock(dir: string): (() => void) | null {
  const release = acquireUpgradeLock(dir, SIDECARS_LOCK_NAME);
  // Null is "someone else holds it": nothing was taken, so there is nothing to
  // keep warm. (acquireUpgradeLock's other degraded answer -- a no-op release
  // for a directory it could not write -- is indistinguishable from a real
  // take here, and needs no special case: the first touch fails ENOENT and
  // switches the heartbeat off.)
  if (release === null) return null;
  const lockPath = join(dir, SIDECARS_LOCK_NAME);
  const beat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lockPath, now, now);
    } catch {
      // Gone (stolen as stale after all, or the tree was cleaned up) or not
      // writable. Nothing to keep alive; stop rather than retry every minute.
      clearInterval(beat);
    }
  }, SIDECAR_LOCK_HEARTBEAT_MS);
  // Guarded the way settledWithin (server.ts) guards its own: under an embedded
  // host whose global setInterval is the browser one, there is no unref to call.
  if (typeof beat.unref === "function") beat.unref();
  return () => {
    clearInterval(beat);
    release();
  };
}

export const SIDECARS_USAGE = `Usage: yaw-mcp sidecars install [--json]

  Install the MCP servers from your bundles.json into ~/.yaw-mcp/sidecars,
  so they run from one known version instead of whatever npm's npx cache
  happens to hold.

  Worth running when servers are hosted on oam: oam runs the copy already on
  disk and cannot re-resolve "@latest" the way npx did, so without a managed
  install a server stays pinned at whatever was last fetched. Re-run this to
  move them forward.

  Only npx-launched servers naming a registry package are installed. docker,
  uvx, and native commands are left alone, as are node launches that already
  name a file and npx launches pointing at a git or path target or pinning
  a version range.`;

export function parseSidecarsArgs(
  argv: string[],
): { ok: true; options: { json: boolean } } | { ok: false; error: string; help?: boolean } {
  let json = false;
  let sawInstall = false;
  for (const a of argv) {
    if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      return { ok: false, error: SIDECARS_USAGE, help: true };
    } else if (a === "install") {
      sawInstall = true;
    } else if (a.startsWith("-")) {
      return { ok: false, error: `yaw-mcp sidecars: unknown argument "${a}"\n\n${SIDECARS_USAGE}` };
    } else {
      return { ok: false, error: `yaw-mcp sidecars: unknown subcommand "${a}"\n\n${SIDECARS_USAGE}` };
    }
  }
  if (!sawInstall) return { ok: false, error: `yaw-mcp sidecars: expected "install"\n\n${SIDECARS_USAGE}` };
  return { ok: true, options: { json } };
}

/**
 * Why NOTHING will read the tree this command just filled -- the distinct
 * reasons, or [] when at least one server would be hosted on oam.
 *
 * collectSidecarSpecs filters on the npx launch shape and nothing else -- it
 * cannot see per-server `runtime: "node"`, the config default, or whether oam
 * is installed at all. But the managed tree is consumed ONLY by resolveNpmEntry
 * on the oam rewrite path (oam-spawn.ts): a server that resolves to the node
 * runtime spawns through npx and never looks here. So on a machine with no oam,
 * "These versions are now fixed" on its own is a claim the user cannot act on
 * -- every spawn still goes through the npx cache. Say which gate is closed,
 * using describeServerRuntime's own reason strings so this and doctor cannot
 * drift apart.
 *
 * The install is still worth having in that state -- the copies are used the
 * moment oam arrives -- so this is a note, not a failure.
 *
 * Returns the REASONS rather than the finished prose so the human note and the
 * `--json` document are the same verdict rendered twice, not two computations
 * that can disagree. The probe is paid for in both modes deliberately: the
 * cheaper alternative was skipping it under `--json`, but the caller that most
 * needs this answer is a script -- the Yaw Terminal MCP panel shells out to
 * `sidecars install --json` and would otherwise read a full `installed` array
 * with `error: null` as a healthy install on a machine where every server still
 * resolves through the npx cache. probeOam is process-cached, so the cost is one
 * `oam --version` per run.
 *
 * `bundles` is the load the runner ALREADY did. describeDefaultRuntime reads the
 * same file, so letting it do its own read meant bundles.json parsed twice per
 * run -- and the project-trust walk with it, which is a directory walk plus a
 * hash, and which logs the loader's read-time diagnostics a second time.
 */
async function unhostedReasons(
  servers: Array<Partial<UpstreamServerConfig>>,
  opts: SidecarsInstallOptions,
  home: string,
  bundles: Pick<LoadLocalBundlesResult, "defaultRuntime" | "defaultRuntimePath">,
): Promise<string[]> {
  // isLocalNpxServer, not a fourth copy of the same test -- the same classifier
  // the collectors and rewriteForOam use, so `npx.cmd` / an absolute npx path
  // gets the same hosted-or-not verdict here as everywhere else.
  const npx = servers.filter(isLocalNpxServer);
  if (npx.length === 0) return [];
  const probe = await (opts.oamProbe ?? probeOam)();
  const { runtime: configDefault } = await describeDefaultRuntime({ cwd: opts.cwd, home, bundles });
  const verdicts = npx.map((s) =>
    // `args` rides along because describeServerRuntime now mirrors
    // rewriteForOam's launch-shape gates too: a spec it refuses (a git/path
    // target, a version range, an npx flag yaw-mcp does not parse) never
    // reaches oam, and dropping the args here would report those servers as
    // hosted while the spawn keeps npx.
    describeServerRuntime(
      { type: "local", command: s.command, args: s.args, runtime: s.runtime },
      configDefault,
      probe,
    ),
  );
  if (verdicts.some((v) => v.runtime === "oam")) return [];
  return [...new Set(verdicts.map((v) => v.reason))];
}

export async function runSidecarsInstall(opts: SidecarsInstallOptions = {}): Promise<SidecarsInstallResult> {
  const home = opts.home ?? homedir();
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const lines: string[] = [];
  const print = (s = "") => {
    lines.push(s);
    if (!opts.json) write(`${s}\n`);
  };

  const printErr = opts.err ?? ((s: string) => process.stderr.write(`${s}\n`));

  const bundles = await loadLocalBundles({ cwd: opts.cwd, home });
  // Surface the loader's diagnostics, the way bundles-cmd and local-add-cmd
  // already do. Without this an invalid JSON / non-array `servers` / EACCES
  // read reached the user as "you have no servers" with the one line that names
  // the actual defect thrown away. stderr, so a `--json` consumer's stdout stays
  // parseable.
  for (const w of bundles.warnings) printErr(`warning: ${w}`);

  const servers = bundles.config?.servers ?? [];
  const specs = collectSidecarSpecs(servers);
  // The two classes of npx server the managed tree cannot serve, kept apart for
  // the notes and merged for the report: a git/path target (not a dependency
  // key) and a version range (refused by rewriteForOam on every machine). What a
  // consumer needs from `skipped` is the same for both -- that server was passed
  // over and keeps resolving through npx.
  const nonRegistry = collectNonRegistrySpecs(servers);
  const ranges = collectRangeSpecs(servers);
  const skipped = [...nonRegistry, ...ranges];
  const root = sidecarsRoot(home);
  const conflicts = specs
    .filter((s) => s.conflicting.length > 0)
    .map((s) => ({ pkg: s.pkg, used: s.spec, ignored: s.conflicting }));

  // Printed on every path INCLUDING the nothing-to-do one: a config whose only
  // npx servers are git targets (or version ranges) would otherwise report
  // "nothing to install" and leave the reason to be guessed at.
  const printSkipped = () => {
    if (skipped.length === 0) return;
    print();
    for (const k of nonRegistry) {
      print(`  note: ${k.namespace} launches ${k.spec}, not a registry package; it keeps using npx`);
    }
    for (const k of ranges) {
      print(`  note: ${k.namespace} launches ${k.spec}, a version range oam cannot resolve; it keeps using npx`);
    }
  };

  if (specs.length === 0) {
    // Four different empty states, and telling a first-time user with no config
    // at all that their bundles.json has no npx servers describes a file that
    // does not exist. Each wants a different next step.
    //
    // A null `config` is TWO of them, which is the distinction this branch
    // exists to keep: loadLocalBundles also returns config=null for a file that
    // IS there and could not be used -- invalid JSON, a non-array `servers`, an
    // EACCES read -- and it reports which by leaving `path` set. Reporting that
    // as "no servers configured yet" tells the user to add a server to a file
    // whose real problem is that it cannot be parsed, and hands a scripted
    // caller `reason: "no-config", error: null` for a broken machine.
    if (bundles.config === null && bundles.path !== null) {
      // Non-zero, and `error` non-null with it: nothing was installed and the
      // cause is a defect the user has to fix, not an empty config. The npm-
      // failure path below reports the same shape for the same reason.
      const detail =
        bundles.warnings.length > 0 ? bundles.warnings.join("; ") : `${bundles.path}: could not be read or parsed`;
      print(`Could not read ${bundles.path} -- nothing to install.`);
      print("Fix the file (the warning above says what is wrong), then run this again.");
      if (opts.json) write(jsonDocument(root, { reason: "unreadable-config", error: detail }));
      return { exitCode: 1, installed: [], lines };
    }
    if (bundles.config === null) {
      print("No servers configured yet -- nothing to install.");
      print("Add one with `yaw-mcp add <slug>`, then run this again.");
      printSkipped();
      if (opts.json) write(jsonDocument(root, { reason: "no-config", skipped }));
      return { exitCode: 0, installed: [], lines };
    }
    if (skipped.length > 0) {
      // Every npx server was passed over. Saying "no npx-launched servers" here
      // would flatly contradict the config the user is looking at, so lead with
      // the skips instead of appending them as a footnote. The headline names
      // the git/path case only when that IS the whole story -- a config whose
      // only npx server pins a range would otherwise be described as something
      // it is not.
      print(
        ranges.length === 0
          ? "Nothing to install -- every npx server points at a git or path target."
          : "Nothing to install -- no npx server names a package this command can install.",
      );
      printSkipped();
      if (opts.json) {
        write(
          jsonDocument(root, {
            reason: ranges.length === 0 ? "only-non-registry-specs" : "only-skipped-specs",
            skipped,
          }),
        );
      }
      return { exitCode: 0, installed: [], lines };
    }
    print("No npx-launched servers in bundles.json -- nothing to install.");
    print("docker, uvx, and native commands run as configured; only npx servers are installed here.");
    if (opts.json) write(jsonDocument(root, { reason: "no-npx-servers", skipped }));
    return { exitCode: 0, installed: [], lines };
  }

  // Guarded: on EACCES/EROFS/ENOSPC these used to reject out of the command,
  // and the dispatcher printed `yaw-mcp sidecars: <errno>` on stderr with
  // NOTHING on stdout -- breaking the one-shape-on-every-path --json contract
  // the MCP panel relies on (it shells out to `sidecars install --json`).
  const couldNotPrepare = (err: unknown): SidecarsInstallResult => {
    const msg = err instanceof Error ? err.message : String(err);
    print(`Could not prepare ${root}: ${msg}. Servers keep resolving from the npx cache.`);
    if (opts.json) write(jsonDocument(root, { error: `manifest write failed: ${msg}`, conflicts, skipped }));
    return { exitCode: 1, installed: [], lines };
  };
  try {
    mkdirSync(root, { recursive: true });
  } catch (err) {
    return couldNotPrepare(err);
  }

  // Serialize against the OTHER writer of this tree -- sidecar-refresh's
  // background refresh, which runs this very command from inside `serve` --
  // before the first byte of the tree changes. AFTER the mkdir, because the
  // lockfile lives in the root and an O_EXCL open cannot create it in a
  // directory that is not there yet; BEFORE the manifest write, because that
  // write already changes what the other npm is reifying against. Null is a
  // live holder: say so and stop rather than put a second npm on the tree (see
  // acquireSidecarsLock for what two reify passes do to one node_modules).
  // Exit 1 with `error` set, not exit 0 with a note: nothing was installed and
  // the caller has to come back, which a script cannot learn from a clean
  // document.
  const release = (opts.acquireLock ?? acquireSidecarsLock)(root);
  if (release === null) {
    // Name the lock: acquireUpgradeLock already steals a lock whose holder
    // process is gone, so what is left here is a genuinely live refresh (or a
    // holder it could not identify), and the one thing an operator can do
    // with that is look at the file.
    print(
      `Another yaw-mcp process is refreshing ${root} right now (lock: ${join(root, SIDECARS_LOCK_NAME)}); try again once it finishes.`,
    );
    if (opts.json) {
      write(
        jsonDocument(root, {
          reason: "locked",
          error: "another yaw-mcp process is refreshing the managed tree",
          conflicts,
          skipped,
        }),
      );
    }
    return { exitCode: 1, installed: [], lines };
  }
  // Released on EVERY path out of the install below -- a failed manifest
  // write, a failed npm, an exception -- via the one `finally`; a lock left
  // behind would hold the background refresh off this tree for auto-upgrade's
  // whole stale window over a failure that has already been reported.
  try {
    try {
      await atomicWriteFile(join(root, "package.json"), sidecarsManifest(specs));
    } catch (err) {
      return couldNotPrepare(err);
    }

    print(`Installing ${specs.length} server package(s) into ${root}`);
    // Name the config the list came from. The managed tree is keyed on HOME
    // alone, while the server list can come from an approved PROJECT
    // bundles.json -- so an install run in project A writes A's dependency set
    // into the one directory every project shares, and npm prunes whatever B
    // put there. The broker in B then resolves out of that same tree (managed
    // wins over the npx cache, oam-spawn.ts), on A's versions, with nothing in
    // B to say why. The in-config conflict note below cannot see this: it
    // compares specs WITHIN one config. Naming the source is the cheap half of
    // the fix.
    if (bundles.path !== null) {
      print(`  from ${bundles.path}`);
      if (bundles.path !== localBundlesPath(userConfigDir(home))) {
        print(`  note: ${root} is shared by every project on this machine; installing from a project`);
        print("        bundles.json replaces what another project's install put there.");
      }
    }
    for (const s of specs) print(`  ${s.spec}${s.namespaces.length ? `  (${s.namespaces.join(", ")})` : ""}`);
    printSkipped();
    // A flat tree holds one version per package, so a second spec for the same
    // package cannot be honoured. Say which one won rather than letting a
    // server pinned to an exact version quietly start on something else.
    if (conflicts.length > 0) {
      print();
      for (const c of conflicts) {
        print(`  note: ${c.pkg} is also configured as ${c.ignored.join(", ")}; installing ${c.used}`);
      }
    }
    print();

    const runNpm =
      opts.runNpm ?? ((args: string[], cwd: string) => defaultRunNpm(args, cwd, { platform: opts.platform }));
    // `--no-audit --no-fund` keep the output about the install; `--install-
    // strategy=nested` is NOT used -- a flat tree is what resolveNpmEntry walks.
    const code = await runNpm(["install", "--no-audit", "--no-fund"], root);
    if (code !== 0) {
      print(`npm install failed (exit ${code}). Servers keep resolving from the npx cache.`);
      if (opts.json) write(jsonDocument(root, { error: `npm exited ${code}`, conflicts, skipped }));
      return { exitCode: 1, installed: [], lines };
    }

    // Record which platform/arch just filled the tree (see installedPlatform
    // for why). AFTER the install-succeeded gate, so a failed install leaves
    // the marker describing whatever tree is actually still on disk -- and
    // this process's own platform/arch, because that is the node npm resolved
    // native bindings for. That last claim holds only because npmBin prefers
    // the npm beside THIS node over whatever `npm` PATH resolves to; where
    // there is no such sibling it stays an assumption, documented there.
    // Guarded like the manifest write: the tree itself is installed at this
    // point, so a marker-write failure does not undo the install (exit 0) --
    // but it is reported on stderr (visible under --json, where `print` is
    // suppressed) AND carried as `markerError` in the --json document, so the
    // panel never reads a clean install that doctor will later call pre-marker
    // with no trail to why.
    let markerError: string | null = null;
    try {
      await atomicWriteFile(
        sidecarsPlatformPath(home),
        `${JSON.stringify({ platform: process.platform, arch: process.arch }, null, 2)}\n`,
      );
    } catch (err) {
      markerError = err instanceof Error ? err.message : String(err);
      printErr(
        `note: could not record the platform marker (${markerError}); doctor will read this tree as pre-marker.`,
      );
    }

    // The second step is what makes "re-run this command to move them forward"
    // true. `npm install` CANNOT re-resolve a dist-tag against an existing
    // tree: with a lockfile present, arborist's dep-valid treats a `tag` spec
    // as satisfied by ANY node that already carries a `resolved` URL, so a
    // package locked at 0.3.6 under a `latest` range reports "up to date" and
    // stays there. Measured against npm on a real tree -- dep at 3.0.0 with
    // the spec rewritten to `latest` and 3.0.1 published: `install` printed
    // "up to date" and left 3.0.0; `update` moved it to 3.0.1. Without this
    // the version pins itself permanently, which is the exact failure this
    // module exists to fix.
    //
    // `update` honours the manifest's ranges, so an exact-pinned spec
    // (`pkg@1.0.0`) still cannot drift -- only the ranges that asked to float
    // do. Fixed literals only, like the install above: see defaultRunNpm on
    // why the Windows shell is safe here, and do not interpolate a package
    // name.
    const updateCode = await runNpm(["update", "--no-audit", "--no-fund"], root);
    const updateError = updateCode === 0 ? null : `npm update exited ${updateCode}`;

    const installed = specs.map((s) => ({
      pkg: s.pkg,
      version: installedVersion(s.pkg, home),
      namespaces: s.namespaces,
    }));
    const missing = installed.filter((i) => i.version === null);

    print("Installed:");
    for (const i of installed) print(`  ${i.pkg}  ${i.version ?? "NOT FOUND"}`);
    if (missing.length > 0) {
      print();
      print(`${missing.length} package(s) did not land; those servers keep resolving from the npx cache.`);
    }
    if (updateError !== null) {
      print();
      print(`npm update failed (exit ${updateCode}). The installed copies are usable, but a server`);
      print('configured "@latest" may still be on the version it was already on.');
    }
    print();
    print("These versions are now fixed. Re-run this command to move them forward.");
    const unhosted = await unhostedReasons(servers, opts, home, bundles);
    if (unhosted.length > 0) {
      print();
      print("Nothing reads these copies yet:");
      for (const reason of unhosted) print(`  ${reason}`);
      print("Those servers keep resolving through the npx cache; the managed copies are read only");
      print("on the oam runtime.");
    }

    // npm exited 0 but not one requested package resolved in the tree. A
    // scripted caller has to be able to tell that from a real install, so it
    // exits non-zero AND fills in `error` -- the field this document exists to
    // make the single success/failure discriminator. Reporting exit 1 with
    // `error: null` meant a consumer branching on `error` read it as clean.
    const nothingLanded = missing.length === installed.length;
    const error = nothingLanded ? "npm exited 0 but no requested package resolved in the managed tree" : null;

    if (opts.json) {
      write(jsonDocument(root, { installed, conflicts, skipped, error, updateError, unhosted, markerError }));
    }
    return { exitCode: nothingLanded ? 1 : 0, installed, lines };
  } finally {
    release();
  }
}

/** True when a managed install exists. Lets a caller skip the per-package
 *  reads entirely when the tree was never created. */
export function hasManagedSidecars(home: string = homedir()): boolean {
  return existsSync(sidecarsNodeModules(home));
}
