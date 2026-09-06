// `yaw-mcp doctor` — prints a one-screen diagnostic of the user's yaw-mcp setup.
// Goal: when a support ticket comes in ("nothing is working"), the user
// pastes the doctor output and we can usually pinpoint the issue from
// it alone (which config files loaded / which clients have yaw-mcp wired
// up vs. don't / what the local bundles + learning state look like).
//
// The output is plain text so it survives Discord / Slack pasting.
//
// Side effects: doctor is NOT purely read-only. It runs the expired-trial
// GC pass (gcExpiredTrials, both the text and --json paths), which is a
// read-modify-write + unlink on client config files: it peels expired
// `yaw-mcp-try-*` entries out of each client config and deletes the trial
// marker. Nothing leaves the MACHINE -- the expiry-gc telemetry event this
// used to fire went with the rest of the postEvent seam (see try-cmd.ts's
// header) -- but the sweep is still reported to the user on both surfaces,
// and an un-finishable sweep raises the exit code. There is
// no lock around that write, so it carries the same TOCTOU class as any
// other config mutation. The sweep is best-effort: any failure is swallowed
// and never aborts the diagnostic.
//
// Exit codes:
//   0  healthy — every config file parsed cleanly and raised no warnings
//   2  warnings (e.g., schema-version mismatch, a retired `token` /
//      `apiBase` key still sitting in a config file, a client config that
//      is malformed / unreadable or whose entry cannot launch yaw-mcp --
//      see clientLaunchWarnings). One unreadable state stays at exit 0: a
//      TRANSIENT read failure on a client config (win32 EBUSY while an AV
//      scanner or the search indexer holds the handle, EAGAIN). Its CLIENTS
//      line still prints, but it is a moment's contention, not a fault --
//      see clientCannotLaunch.
//   (1 = fatal is reserved and currently UNREACHABLE: nothing doctor
//   inspects is fatal — a bad config file degrades to a warning.)
//
// The exit-2 gate is UNCONDITIONALLY "any warning". It used to be gated on
// `config.token !== null`, which meant a warning-producing config exited 0
// whenever no token was configured -- i.e. always, once account mode went
// away. Do not re-introduce a precondition here.

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, resolve, win32 } from "node:path";
import { cliToNamespaces } from "./cli-shadows.js";
import {
  CURRENT_SCHEMA_VERSION,
  type LoadedConfigFile,
  loadYawMcpConfig,
  type ResolvedConfig,
} from "./config-loader.js";
import {
  type DefaultRuntimeInfo,
  describeDefaultRuntime,
  describeServerRuntime,
  oamFailureLabel,
  type ServerRuntimeInfo,
} from "./default-runtime.js";
import { type GuideFile, loadProjectGuide, projectGuideNotice } from "./guide.js";
import {
  CURRENT_OS,
  ENTRY_NAME,
  findLegacyEntry,
  INSTALL_TARGETS,
  type InstallClientId,
  type InstallOS,
  type InstallScope,
  resolveAppDataDir,
  resolveInstallPath,
} from "./install-targets.js";
import { parseJsonc } from "./jsonc.js";
import {
  loadLocalBundles,
  type ProjectTrustProbe,
  probeProjectTrust,
  projectFileIsHonoured,
  untrustedProjectWarning,
} from "./local-bundles.js";
import {
  compareVersions,
  isOamCommand,
  isOamLaunch,
  MIN_OAM_VERSION,
  nodeLaunchKind,
  type OamProbe,
  type OamProbeFailure,
  oamInstallAdvice,
  probeOam,
} from "./oam-spawn.js";
import { normalizeForCompare, userConfigDir } from "./paths.js";
import {
  isPersistenceDisabled,
  isReadableStateVersion,
  loadState,
  STATE_FILENAME,
  STATE_SCHEMA_VERSION,
} from "./persistence.js";
import {
  collectMalformedSecretRefs,
  collectSecretRefNames,
  listKeys,
  loadVault,
  SECRETS_SCHEMA_VERSION,
  vaultPath,
} from "./secrets-vault.js";
import { buildRefreshPlan, isSidecarRefreshDisabled } from "./sidecar-refresh.js";
import {
  collectSidecarSpecs,
  hasManagedSidecars,
  installedPlatform,
  installedVersion,
  type SidecarsPlatform,
  sidecarsRoot,
} from "./sidecars-cmd.js";
import { TRUST_BYPASS_ENV } from "./trust.js";
import { formatTtl, gcExpiredTrials, scanTrials, type TrialGcFailure, trialGcFailureWarning } from "./try-cmd.js";
import {
  BINARY_RETIRED_HINT,
  buildUpgradePlan,
  detectInstallMethod,
  detectSea,
  fetchLatestVersion,
  refineInstallMethod,
} from "./upgrade-cmd.js";
import { selectFlakyNamespaces } from "./usage-hints.js";

/**
 * Warning text for a project bundles.json that is NOT being loaded because
 * it has not been approved (or that IS being loaded only because the escape
 * hatch is set). Returns null when there is nothing to say.
 *
 * This belongs in doctor because the gate is deliberately silent-ish at
 * runtime: the server logs a warning to a stream most users never read, so
 * from their side "my project's servers stopped appearing" has no visible
 * cause. Any warning takes doctor to exit 2, which is the right signal --
 * the setup genuinely needs a decision from the user.
 */
function projectTrustWarning(probe: ProjectTrustProbe | null): string | null {
  if (!probe || probe.path === null) return null;
  // "none" = no project file at all; "trusted" is the healthy case.
  if (probe.status === "none" || probe.status === "trusted") return null;
  if (probe.status === "unreadable") {
    // Not a consent problem -- the bytes cannot be read at all, so neither
    // branch below applies. The loader raises its own one-line version of
    // this (`<path>: could not read file (...) -- skipping`); the detailed
    // form below replaces it, and foldBundleWarnings drops the short one so
    // the same fact is not printed twice.
    if (probe.pathTrusted === true || probe.bypassed) {
      // Approved-path (or bypassed) unreadable file: the loader stays
      // committed to it, which means ZERO servers from anywhere.
      return `${probe.path}: project bundles.json could not be read (${probe.error}). It was approved before, so yaw-mcp stays committed to that location and loads NO servers from it. Fix the file, or \`yaw-mcp trust --revoke\` it to fall back to your user-global bundles.json.`;
    }
    return untrustedProjectWarning(probe, { detail: true });
  }
  if (probe.bypassed) {
    // The escape hatch is only worth flagging when it is actually loading
    // something unreviewed -- staying quiet otherwise keeps doctor from
    // nagging a CI box where the var is set but every file is approved.
    return `${probe.path}: loaded WITHOUT approval because ${TRUST_BYPASS_ENV} is set -- every command in that file spawns as you, unreviewed. Unset it and run \`yaw-mcp trust\` to review and approve the file instead.`;
  }
  // Detailed form: the runtime warning is deliberately one short line (it
  // repeats on every command), and doctor is where the user gets sent to
  // find out what it actually means.
  return untrustedProjectWarning(probe, { detail: true });
}

/**
 * The bundles.json loader warnings doctor should fold into `config.warnings`.
 *
 * ALL of them, minus the ones projectTrustWarning above already renders in a
 * better (detailed) form. Folding is what makes a broken bundles.json visible
 * at all: `loadYawMcpConfig` never reads bundles.json, so a file that fails to
 * parse used to leave doctor printing "All good. yaw-mcp should start cleanly."
 * and exiting 0 with zero servers -- the exact ticket doctor exists to answer,
 * answered wrong. Once folded they reach the WARNINGS block, the always-on
 * stderr stream, and the unconditional exit-2 gate.
 *
 * The dedupe is keyed on the probe rather than on the warning text: the loader
 * PARSES the project file only when it is honoured AND readable, so in every
 * other state the only warnings it can raise about that path are the
 * trust/readability ones doctor already says itself. When it does parse (an
 * approved file, or one loaded under the env bypass) its schema diagnostics are
 * genuinely new information and all of them are kept -- including alongside the
 * bypass warning, which is a different fact about the same file.
 */
function foldBundleWarnings(warnings: readonly string[], probe: ProjectTrustProbe | null): string[] {
  if (!probe || probe.path === null) return [...warnings];
  if (projectFileIsHonoured(probe) && probe.status !== "unreadable") return [...warnings];
  const prefix = `${probe.path}:`;
  return warnings.filter((w) => !w.startsWith(prefix));
}

export interface DoctorOptions {
  cwd?: string;
  home?: string;
  os?: InstallOS;
  env?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to process.stdout.write. */
  out?: (s: string) => void;
  /** Override for tests; defaults to process.stderr.write. Used for the
   *  always-on warning stream so pipelines that capture stdout still see
   *  config warnings. */
  err?: (s: string) => void;
  /** Disable the npm registry freshness check (tests, offline use). */
  skipRegistryCheck?: boolean;
  /** Test hook: return the latest-version string for @yawlabs/mcp. */
  registryFetch?: () => Promise<string | null>;
  /** Test hook: return the latest-version string for a managed sidecar
   *  package. Same contract as registryFetch (null = unknown), but keyed by
   *  package -- the managed tree holds several. Like registryFetch, an
   *  explicit hook bypasses the VITEST auto-skip so the stale branches are
   *  reachable under tests. */
  sidecarRegistryFetch?: (pkg: string) => Promise<string | null>;
  /** Emit a single JSON blob instead of the human-readable text report. */
  json?: boolean;
  /** Test hook: override Date.now() used by the trial GC pass. */
  now?: () => number;
  /** Test hook: override the current version used for the staleness comparison
   *  and UPGRADE AVAILABLE hint. Defaults to VERSION (the build-time constant).
   *  Used ONLY in the upgrade-hint comparison and hint rendering; all other
   *  version references in doctor output continue to use the constant. */
  currentVersion?: string;
  /** Test hook: override process.argv[1] used for install-method detection in
   *  the UPGRADE AVAILABLE hint. Defaults to process.argv[1]. */
  argvPath?: string;
  /** Test hook: replace the real `oam --version` probe so the OAM RUNTIME
   *  section is deterministic regardless of what's installed on the host. */
  oamProbe?: () => OamProbe | Promise<OamProbe>;
  /** Test hook: the path semantics the CLIENTS launch checks judge an entry
   *  by. Defaults to process.platform. See ProbeOptions.platform. */
  platform?: NodeJS.Platform;
  /** Test hook: replaces the client-config read in the CLIENTS probe, so a
   *  transient EBUSY / EAGAIN can be injected. See
   *  ProbeOptions.readClientConfig. */
  readClientConfig?: (path: string) => string;
}

// Machine-readable shape emitted by `yaw-mcp doctor --json`. Mirrors the
// text sections so support / dashboard consumers can pick fields with jq.
//
// Sections deliberately NOT mirrored (text-only, by design):
//   - SHADOWED CLI USAGE is carried as `shellShadows` (same data, renamed).
//   - UPGRADE AVAILABLE's method-aware terminal hint is text-only; the JSON
//     `upgrade` block carries the version facts but no install-method copy.
// Everything else (CONFIG FILES, PROJECT GUIDE, ENVIRONMENT, OAM RUNTIME,
// SECRET VAULT, STATE, RELIABILITY, TRIALS, INSTALLED CLIENTS, WARNINGS,
// DIAGNOSIS) has a structured field below.
export interface DoctorJsonSnapshot {
  timestamp: string;
  version: string;
  platform: InstallOS;
  // DEPRECATED — every member is always `null`. yaw-mcp is local-only; there
  // is no token and no API base to report. The NESTED SHAPE is retained
  // rather than flattened to a bare `null` for the same reason as
  // `backgroundPosters` below: a consumer reading `.token.source` or
  // `.apiBase.value` keeps parsing instead of throwing on a null deref.
  // Dropped in a later release.
  token: { fingerprint: null; source: null };
  apiBase: { value: null; source: null };
  loadedFiles: Array<{ scope: string; path: string; schemaVersion?: number; schemaAhead: boolean }>;
  // Project-scoped YAW-MCP.md, or null when there isn't one. `unapproved` is
  // true when it is served from a directory whose bundles.json is not
  // approved -- repo-authored text reaching the model. Deliberately NOT a
  // warning (see renderProjectGuideSection): it does not move the exit code.
  projectGuide: { path: string; unapproved: boolean } | null;
  warnings: string[];
  // Behavior-modifier env vars, null when unset. `YAW_MCP_POLL_INTERVAL` is
  // DEPRECATED and always null -- the remote config poll loop it tuned was
  // removed with the hosted backend. The key is retained (same reasoning as
  // backgroundPosters below) so consumers reading it keep working through
  // the deprecation window.
  env: Record<string, string | null>;
  /** Local secret vault: entry NAMES, which servers reference them, and
   *  whether a passphrase is available. `passphraseSet` is a boolean and
   *  `entries` holds names only -- no secret value, and no passphrase, ever
   *  appears in this snapshot. Mirrors the text path's SECRET VAULT section
   *  (which is omitted when there is no vault and no refs; the JSON block is
   *  always present so consumers can read it unconditionally).
   *
   *  Declared as the collector's own type, not re-spelled here: the emitted
   *  object is a VaultStatus assigned wholesale (see runDoctorJson), which
   *  bypasses excess-property checking, so a re-spelled copy could only ever
   *  lag it -- which is exactly how `schemaVersion` reached the blob without
   *  reaching this contract. Field docs live on VaultStatus. */
  vault: VaultStatus;
  state: {
    disabled: boolean;
    /** Result of pre-parsing state.json, mirroring the text path's STATE
     *  section. "disabled" means persistence is off; the other values come
     *  straight from peekStateFile. WITHOUT this, loadState's swallow-and-
     *  return-empty behaviour made a corrupt file look healthy-and-fresh. */
    status: "disabled" | "ok" | "missing" | "malformed" | "stale-version" | "unreadable";
    /** Parse / read error message for the malformed + unreadable cases,
     *  or the on-disk schema version for stale-version. Null otherwise. */
    detail: string | null;
    path: string | null;
    savedAt: string | null;
    learningEntries: number | null;
    packHistoryEntries: number | null;
  };
  reliability: Array<{
    namespace: string;
    dispatched: number;
    succeeded: number;
    successRate: number;
    lastUsedAt: string;
  }>;
  clients: ClientProbeResult[];
  shellShadows: ShadowHit[];
  // Trial state. `cleared` is the count of expired trials swept this run
  // (the GC write side effect — runs on the --json path too, matching the
  // text path). `live` lists still-active trials with their TTL; `malformed`
  // lists marker files that failed to parse.
  trials: {
    cleared: number;
    /** Expired trials the sweep could NOT finish. `failed` is the count;
     *  `failures` says which slug / file / step, so a consumer (the MCP
     *  panel) can act on it. Each one is also folded into `warnings`. */
    failed: number;
    failures: TrialGcFailure[];
    live: Array<{ slug: string; clientName: string; clientPath: string; msUntilExpiry: number }>;
    malformed: string[];
  };
  // DEPRECATED — both members are always `null`. The background HTTP
  // posters (analytics, tool-report) that populated this were removed with
  // the hosted backend. The NESTED SHAPE is retained deliberately, not
  // flattened to a bare `null`: the latches that fed it were in-process
  // server state and `doctor` runs as a fresh process, so this block
  // already emitted `{"analytics": null, "toolReport": null}` in practice.
  // Keeping the object means `doctor --json` output is byte-identical for
  // external consumers, including anyone reading `.backgroundPosters.analytics`
  // — flattening to `null` would throw for them. Dropped in a later release.
  backgroundPosters: { analytics: null; toolReport: null };
  // oam runtime visibility: whether the oam binary is usable (installed AND
  // >= minVersion), the config-level default, and the per-server effective
  // runtime for locally-defined servers (bundles.json). Mirrors the text
  // path's OAM RUNTIME section so the oam->node silent fallback is
  // machine-readable too.
  oamRuntime: {
    binary: string | null;
    version: string | null;
    belowMin: boolean;
    minVersion: string;
    /** Why a PRESENT oam produced no usable binary ("timeout" / "exit" /
     *  "spawn"), or null. Null covers BOTH a healthy oam and an absent one --
     *  absence is `binary: null` with `failure: null`. Without this pair a
     *  wedged binary was indistinguishable from one that was never installed,
     *  so support read `binary: null` and told the user to install oam. */
    failure: OamProbeFailure | null;
    /** The underlying error message behind `failure`, or null. */
    failureDetail: string | null;
    defaultRuntime: "oam" | "node" | null;
    defaultRuntimeSource: "env" | "bundles" | null;
    defaultRuntimePath: string | null;
    servers: Array<{ namespace: string; runtime: "oam" | "node" | null; reason: string }>;
    /** The managed install (`yaw-mcp sidecars install`): where it lives, and
     *  the version of each configured package in it. A null version means the
     *  package is not in the managed tree, so that server resolves from the
     *  npx cache instead. This is the version an oam-hosted sidecar will
     *  ACTUALLY run -- bundles.json only says "@latest" and oam cannot
     *  re-resolve it, so nothing else reports this. `packages` is empty when
     *  no npx-launched server is configured.
     *
     *  `latest`/`stale` carry the registry freshness of each INSTALLED
     *  package: oam cannot re-resolve "@latest", so a pin only moves when
     *  `sidecars install` is re-run -- without this check a year-old pin reads
     *  identically to a current one. `latest` is null when the package is not
     *  installed, the registry did not answer, or the check is skipped
     *  (skipRegistryCheck / VITEST); `stale` is only ever true on a fetched
     *  answer.
     *
     *  `installedFor`/`platformMismatch`: which platform/arch last filled the
     *  tree (null when the marker is absent -- a pre-marker tree, or none at
     *  all), and whether it disagrees with THIS process. The tree is keyed on
     *  HOME alone, so a home shared across architectures holds bindings for
     *  the installing machine only -- a mismatch means packages can fail at
     *  spawn here while every version above reads as present and fine. */
    managed: {
      root: string;
      packages: Array<{ pkg: string; version: string | null; latest: string | null; stale: boolean }>;
      installedFor: SidecarsPlatform | null;
      platformMismatch: boolean;
    };
  };
  upgrade: { current: string; latest: string | null; stale: boolean };
  diagnosis: { exitCode: number; summary: string };
}

export interface ClientProbeResult {
  clientId: InstallClientId;
  scope: InstallScope;
  path: string;
  exists: boolean;
  hasMcpEntry: boolean;
  /** Pre-rename `"mcp.hosting"` key still in the container. Surfaced so
   *  upgraded users know to trim by hand — nothing in the runtime writes
   *  this key anymore. */
  hasLegacyEntry: boolean;
  /** The specific legacy entry key found (e.g. "mcp.hosting" / "yaw-mcp"), or
   *  null. Lets the status line name the stale key in the trim hint. */
  legacyEntryName: string | null;
  /** The file exists but its content did not PARSE as a JSON object. Never
   *  set for a read failure -- that is `unreadable`. */
  malformed: boolean;
  /** The file exists but its BYTES could not be read (EISDIR for a directory
   *  at the path, EACCES, a win32 EBUSY while an AV scanner holds the handle)
   *  -- the error message, or null. Kept apart from `malformed`: a read
   *  failure used to be reported as "JSON is malformed -- fix or rerun
   *  `yaw-mcp install`", sending the user to fix a syntax error that does not
   *  exist. Doctor cannot tell what such a file says, so it counts as a
   *  cannot-launch state for the warning fold (see clientLaunchWarnings) --
   *  unless the code below says the failure is transient. */
  unreadable: string | null;
  /** The errno code behind `unreadable` ("EISDIR", "EACCES", "EBUSY"), or
   *  null -- also null when the error carried no code. Additive JSON field.
   *  Carried so the exit-code gate can tell a transient read (EBUSY / EAGAIN,
   *  see clientCannotLaunch) from a real one WITHOUT parsing the message,
   *  whose wording node reshapes across versions. */
  unreadableCode: string | null;
  unavailable: boolean;
  /** An absolute launch `command` in the entry that no longer exists on disk,
   *  or null. Only absolute paths are checked -- a bare "npx"/"cmd" is
   *  PATH-resolved and cannot be verified cheaply. This catches the failure
   *  mode an absolute entry introduces: `install` can write a path (an oam
   *  binary, a global node_modules entry), and if that later moves or is
   *  uninstalled the client cannot start the broker AT ALL, where the npx
   *  entry would simply have kept working. */
  launchCommandMissing: string | null;
  /** What the WRITTEN entry will launch the broker on: "oam" when its command
   *  is an oam binary, "node" for the npx/node/cmd shapes, null when there is
   *  no entry. Derived from the config, not from this process -- `yaw-mcp
   *  doctor` in a shell runs on node even when the configured entry uses oam,
   *  so the running process cannot answer "did my install put the broker on
   *  oam?". The config can. */
  launchRuntime: "oam" | "node" | null;
  /** A BARE oam launch command in the entry (`"command": "oam"`), or null.
   *  Distinct from launchCommandMissing, which only inspects ABSOLUTE paths and
   *  therefore cannot see this one. `install` used to write it; a bare name
   *  resolves against the client's PATH, which a GUI-launched client does not
   *  inherit from the shell, so the broker fails to start with no fallback.
   *  Existing configs still carry it, so doctor reports it. */
  launchOamNotAbsolute: string | null;
  /** The absolute `oam run` entry path in the entry that no longer exists, or
   *  null. oam has no fetch-on-demand, so unlike the npx shape a stale entry
   *  here cannot be recovered at launch. */
  launchOamEntryMissing: string | null;
  /** A launch command (or the oam it wraps) that is an absolute path for
   *  ANOTHER operating system -- a `C:\` drive-letter path seen by a doctor
   *  running on POSIX (WSL reading a Windows profile) -- or null. Neither the
   *  exists check nor the bare-oam check can be applied to it from here, so
   *  the entry is reported as unverifiable rather than as missing or bare
   *  (see isForeignAbsoluteLaunch). Not a cannot-launch state: the OS the
   *  entry was written for may well run it fine. */
  launchForeignPath: string | null;
}

export interface DoctorResult {
  exitCode: number;
  /** Lines printed to stdout, in order — exposed for tests. */
  lines: string[];
  /** Structured snapshot of what doctor inspected. */
  snapshot: {
    version: string;
    config: ResolvedConfig;
    clients: ClientProbeResult[];
  };
}

// __VERSION__ is substituted at build time by tsup; guard for unbundled
// source (tests) where the declare keeps it undefined.
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";

// The YAW_MCP_DISABLE_PERSISTENCE predicate is imported from persistence.ts,
// which owns the state file the flag disables. Doctor used to keep its own
// copy (as did server.ts and reset-learning-cmd.ts); doctor passes its INJECTED
// `env` rather than process.env, which is why the shared one takes an env.
// Its one doctor call site is collectStateStatus, which the STATE/RELIABILITY
// pair on each of the text and json paths reads from, so no section can read
// state.json while another treats persistence as off.

export const DOCTOR_USAGE = `Usage: yaw-mcp doctor [--json]

  Print a diagnostic of your yaw-mcp setup.

  --json  Emit machine-readable JSON instead of text.`;

/** The subset of DoctorOptions that argv can set. Everything else on
 *  DoctorOptions is a test seam the CLI never supplies. */
export interface ParsedDoctorArgs {
  json: boolean;
}

/** Parse `yaw-mcp doctor` argv into the same `{ok}` shape every sibling
 *  subcommand parser returns, so index.ts routes doctor through the shared
 *  parse-then-dispatch tail instead of open-coding the branch.
 *
 *  Doctor's parsing used to live inline in the dispatcher -- the ONE branch
 *  the completion / help tests could not import, because importing index.ts
 *  runs the dispatcher's top-level side effects. Here it is testable.
 *
 *  Precedence, preserved from the inline version: an explicit --help wins,
 *  but only when no unknown argument PRECEDES it, matching the parse-first
 *  siblings (which reject unknown flags before honoring help). Every stray
 *  arg is collected, not just the first, so `doctor --bad --worse` names
 *  both in one run. */
export function parseDoctorArgs(
  argv: string[],
): { ok: true; options: ParsedDoctorArgs } | { ok: false; error: string; help?: boolean } {
  const isHelpArg = (a: string): boolean => a === "--help" || a === "-h";
  const isUnknown = (a: string): boolean => a !== "--json" && !isHelpArg(a);
  const firstHelpIdx = argv.findIndex(isHelpArg);
  const firstUnknownIdx = argv.findIndex(isUnknown);
  if (firstHelpIdx !== -1 && (firstUnknownIdx === -1 || firstHelpIdx < firstUnknownIdx)) {
    return { ok: false, error: DOCTOR_USAGE, help: true };
  }
  const unknowns = argv.filter(isUnknown);
  if (unknowns.length > 0) {
    const quoted = unknowns.map((a) => `"${a}"`).join(", ");
    return { ok: false, error: `yaw-mcp doctor: unknown argument${unknowns.length > 1 ? "s" : ""} ${quoted}` };
  }
  return { ok: true, options: { json: argv.includes("--json") } };
}

/** Everything both doctor paths collect BEFORE they diverge into printing or
 *  JSON assembly: the option defaults, the config load, the project-trust
 *  fold, and the CLAUDE_CONFIG_DIR override.
 *
 *  Shared rather than copied. The text and --json paths ran these same lines
 *  verbatim, so a fix to one was easy to miss in the other -- which is exactly
 *  how the two surfaces drifted before (the --json path skipped the trial GC
 *  entirely). Anything that must be identical on both paths belongs here. */
async function collectDoctorBase(opts: DoctorOptions): Promise<{
  cwd: string;
  home: string;
  appData: string | undefined;
  os: InstallOS;
  env: NodeJS.ProcessEnv;
  timestamp: string;
  config: ResolvedConfig;
  trustProbe: ProjectTrustProbe | null;
  claudeConfigDir: string | undefined;
}> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  // Keep the %APPDATA%-based claude-desktop path inside a synthetic home
  // whenever home is overridden (test seam hermeticity; see ProbeOptions), and
  // otherwise read the ambient %APPDATA% -- the shared helper, so doctor names
  // the same claude_desktop_config.json that install writes on a box where
  // %APPDATA% is redirected away from <home>\AppData\Roaming.
  const appData = resolveAppDataDir({ home: opts.home, env: opts.env });
  const os = opts.os ?? CURRENT_OS;
  const env = opts.env ?? process.env;
  const timestamp = new Date().toISOString();

  const config = await loadYawMcpConfig({ cwd, home, env });
  // Project-trust gate (see trust.ts). Folded into config.warnings so it
  // renders in WARNINGS (text) / `.warnings` (json), hits the always-on stderr
  // stream, and drives the exit-2 gate like every other warning.
  const trustProbe = await probeProjectTrust({ cwd, home, env }).catch(() => null);
  const trustWarning = projectTrustWarning(trustProbe);
  if (trustWarning) config.warnings = [...config.warnings, trustWarning];

  // Honor CLAUDE_CONFIG_DIR so doctor sees the same file Claude Code reads
  // when run inside a wrapper (Yaw Mode, dev container with the env set).
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : undefined;

  return { cwd, home, appData, os, env, timestamp, config, trustProbe, claudeConfigDir };
}

/** state.json, peeked and (when usable) loaded ONCE, for the STATE and
 *  RELIABILITY sections of BOTH paths.
 *
 *  Shared for the same reason collectDoctorBase is: the text and --json paths
 *  carried separate copies of this prologue, and the copies had already
 *  drifted (one loaded a "missing" file, the other did not). One helper
 *  means one answer to "what is state.json right now".
 *
 *  Reads the file at most twice (peek + load) rather than once per section,
 *  and not at all when persistence is disabled. The peek runs FIRST because
 *  loadState swallows a parse / version / read problem into an empty state
 *  that reads as brand-new -- so only an "ok" peek is loaded, and everything
 *  else is reported from the peek alone. A MISSING file is `persisted: null`
 *  too: both renderers treat null the same as a never-saved state, so there
 *  is nothing to load. */
async function collectStateStatus(opts: { env: NodeJS.ProcessEnv; home: string }): Promise<{
  disabled: boolean;
  filePath: string;
  peek: StatePeek | null;
  persisted: Awaited<ReturnType<typeof loadState>> | null;
}> {
  const disabled = isPersistenceDisabled(opts.env);
  const filePath = join(userConfigDir(opts.home), STATE_FILENAME);
  const peek: StatePeek | null = disabled ? null : await peekStateFile(filePath);
  const persisted = peek?.kind === "ok" ? await loadState(filePath) : null;
  return { disabled, filePath, peek, persisted };
}

/** The CLIENTS-section wording for one probe: the bare client label, the
 *  same label with its scope, and its status line. One function for the text
 *  section and the warning fold below, so the same state cannot be worded two
 *  ways. */
function describeClient(c: ClientProbeResult): { client: string; label: string; status: string } {
  const installCmd = `yaw-mcp install ${c.clientId}${c.scope === "user" ? "" : ` --scope ${c.scope}`}`;
  const client = INSTALL_TARGETS.find((t) => t.clientId === c.clientId)?.label ?? c.clientId;
  return { client, label: `${client} (${c.scope})`, status: renderClientStatus(c, installCmd) };
}

/** errno codes for a read failure that is a moment's contention, not a state
 *  of the file. EBUSY is the one live member: win32's answer while an AV
 *  scanner or the search indexer holds the handle (libuv maps
 *  ERROR_SHARING_VIOLATION to it). EAGAIN is defensive only -- a blocking
 *  read of a regular file never returns it on any supported platform -- and
 *  is kept so nobody re-adds it on the same reasoning. The file is fine and
 *  the next read succeeds. */
const TRANSIENT_READ_CODES: ReadonlySet<string> = new Set(["EBUSY", "EAGAIN"]);

/** True when the probe's read failure is one of TRANSIENT_READ_CODES. Decided
 *  on the errno, never on the message text -- see ClientProbeResult.unreadableCode. */
function isTransientRead(c: ClientProbeResult): boolean {
  return c.unreadable !== null && c.unreadableCode !== null && TRANSIENT_READ_CODES.has(c.unreadableCode);
}

/** True when the probe found a config file whose CONTENTS are known: it is on
 *  disk, on a client available on this OS, and doctor could both read and
 *  parse it. This is the gate `yaw-mcp try`'s auto-detect picks "the client
 *  the user is actively using" by. Both failure kinds are excluded on
 *  purpose: `malformed` always was, but `unreadable` (split out of it later)
 *  was not, so a directory or an EACCES file at ~/.claude.json was
 *  auto-selected as the trial target and `try` then aborted on the very read
 *  the probe had just failed -- while a readable ~/.cursor/mcp.json sat one
 *  slot further along. */
export function probeUsable(c: ClientProbeResult): boolean {
  return !c.unavailable && c.exists && !c.malformed && c.unreadable === null;
}

/** True for every probe state renderClientStatus describes as "the client
 *  cannot start yaw-mcp", plus a config doctor could not read at all -- which
 *  it cannot vouch for either way, and the header's exit-0 promise ("every
 *  config file parsed cleanly") does not hold for.
 *
 *  EXCEPT a transient read (isTransientRead). Yaw Terminal polls `doctor
 *  --json`, and one AV / indexer handle race must not flip a healthy machine's
 *  diagnosis to "Warnings need attention" for the length of a poll. The
 *  CLIENTS line still says what happened (renderClientStatus); it just does
 *  not move the exit code. */
function clientCannotLaunch(c: ClientProbeResult): boolean {
  return (
    (c.unreadable !== null && !isTransientRead(c)) ||
    c.malformed ||
    c.launchCommandMissing !== null ||
    c.launchOamEntryMissing !== null ||
    c.launchOamNotAbsolute !== null
  );
}

/**
 * The client probe states doctor folds into `config.warnings`, one per
 * (client, scope), in the house `<path>: <message>` shape every other warning
 * uses.
 *
 * WHY: the exit code and DIAGNOSIS derive from config.warnings ALONE, and the
 * CLIENTS section never fed it. So a ~/.claude.json that was malformed, or
 * whose entry named a launch command that no longer exists, printed "the
 * client cannot start yaw-mcp" under CLIENTS and then "All good. yaw-mcp
 * should start cleanly." under DIAGNOSIS, exit 0 -- on --json too, where Yaw
 * Terminal reads `.diagnosis` and `.warnings` and showed All good. Folding is
 * the same fix foldBundleWarnings and the trial-GC failures got: the WARNINGS
 * block, the always-on stderr stream and the exit-2 gate all see it, on both
 * surfaces, in the same order (trust -> bundle -> trials -> clients).
 *
 * Only the cannot-launch states qualify. "not configured", "present, no
 * entry" and a lone legacy entry are ordinary (a client the user never
 * installed to); a PATH-resolved `npx` entry is the healthy default; a
 * launch path written for another OS is unverifiable, not broken. None of
 * them may drag a working machine to exit 2.
 *
 * One warning per (file, client, status), NOT one per probe. Claude Code's
 * user and local scopes read the SAME ~/.claude.json (different containers
 * inside it), so a FILE-level state -- malformed, unreadable -- is true of
 * both scopes at once, and a per-probe fold said the same thing about the
 * same file twice with only the scope label changed. The scopes are listed
 * on the one line instead ("Claude Code (user, local)"). Entry-level states
 * still come out one per scope on their own: each scope has its own entry,
 * and its status names that scope's install command, so the key differs.
 * Insertion order is kept, so the list reads in probe order like the CLIENTS
 * section above it.
 */
function clientLaunchWarnings(clients: readonly ClientProbeResult[]): string[] {
  const grouped = new Map<string, { path: string; client: string; scopes: string[]; status: string }>();
  for (const c of clients) {
    if (!clientCannotLaunch(c)) continue;
    const { client, status } = describeClient(c);
    const key = `${c.path}\0${client}\0${status}`;
    const seen = grouped.get(key);
    if (seen) seen.scopes.push(c.scope);
    else grouped.set(key, { path: c.path, client, scopes: [c.scope], status });
  }
  return [...grouped.values()].map((g) => `${g.path}: ${g.client} (${g.scopes.join(", ")}) ${g.status}`);
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorResult> {
  if (opts.json) return runDoctorJson(opts);

  const lines: string[] = [];
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const print = (s = ""): void => {
    lines.push(s);
    write(`${s}\n`);
  };

  const { cwd, home, appData, os, env, timestamp, config, trustProbe, claudeConfigDir } = await collectDoctorBase(opts);

  print(`yaw-mcp doctor -- ${timestamp}`);
  print(`yaw-mcp version: ${VERSION}`);
  print(`platform: ${os}`);
  print("");

  print("CONFIG FILES");
  if (config.loadedFiles.length === 0) {
    print("  (none -- using defaults + env)");
  } else {
    for (const f of config.loadedFiles) {
      print(`  ${f.scope.padEnd(7)} ${f.path}${schemaSuffix(f)}`);
    }
  }
  print("");

  // Project YAW-MCP.md that reaches the model from an unapproved project dir
  // (see guide.ts). Informational, NOT folded into config.warnings: the setup
  // is legitimate, so it must not drive exit 2 the way the bundles gate does.
  const projectGuide = await loadProjectGuide(cwd, home, env).catch(() => null);
  renderProjectGuideSection({ guide: projectGuide, print });

  // Behavior-modifier env vars that yaw-mcp actually reads at runtime.
  // Surfaced here so support diagnostics can see at a glance whether an
  // override is active (e.g., "my auto-load isn't working" — doctor
  // says AUTO_LOAD is not set). DISABLE_PERSISTENCE has its own dedicated
  // section and is intentionally omitted.
  renderEnvSection({ env, print });

  // oam runtime visibility — which runtime each server would ACTUALLY get
  // (oam vs node) and why. The oam spawn-rewrite falls back to node
  // silently by design (oam absent / below min / non-node command), so
  // this section is where that fallback becomes visible.
  const oamStatus = await collectOamRuntimeStatus({
    env,
    cwd,
    home,
    probeFn: opts.oamProbe ?? probeOam,
    sidecarLatest: sidecarLatestFetcher(opts),
  });
  // bundles.json diagnostics (unparseable file, bad schema version, invalid
  // defaultRuntime, skipped server entries) come back from the loader the
  // collector already ran. They were DISCARDED here, which is how a hand-edited
  // bundles.json that no longer parses -- every server gone -- still printed
  // "All good" and exited 0. See foldBundleWarnings.
  config.warnings = [...config.warnings, ...foldBundleWarnings(oamStatus.bundleWarnings, trustProbe)];
  renderOamRuntimeSection({ status: oamStatus, print, os });

  // Secret vault: what is stored, which servers reference it, and whether a
  // passphrase is available to unlock it. This is the only surface that
  // connects a `${secret:NAME}` in bundles.json to the env var that makes it
  // work -- without it, "my server won't start" has no visible cause short of
  // reading the spawn error. Informational; see renderVaultSection for why it
  // never becomes a warning.
  renderVaultSection({ status: await collectVaultStatus({ home, env, servers: oamStatus.servers }), print });

  // state.json, peeked and loaded ONCE for both the STATE and RELIABILITY
  // sections -- by the same helper the --json path uses, so the two surfaces
  // read the file identically. See collectStateStatus.
  const {
    disabled: persistenceDisabled,
    filePath: stateFilePath,
    peek: statePeek,
    persisted: persistedState,
  } = await collectStateStatus({ env, home });

  // Persisted cross-session state — ~/.yaw-mcp/state.json. Shows whether
  // persistence is disabled by env, and otherwise reports the file path
  // + how fresh the snapshot is + how much signal it carries.
  renderStateSection({
    filePath: stateFilePath,
    disabled: persistenceDisabled,
    persisted: persistedState,
    peek: statePeek,
    print,
  });

  // Reliability roll-up — pulls flaky namespaces from the same
  // state.json the STATE section introspected. Same definition as the
  // cross-session block in mcp_connect_health, so "flaky" means the
  // same thing whether you check via the LLM or via the CLI.
  renderReliabilitySection({ disabled: persistenceDisabled, persisted: persistedState, print });

  // Trial GC + live-trial readout. Runs the expired-trial sweep first
  // so the readout shows the post-GC state (no stale "expired" rows
  // hanging around). Best-effort: any sweep failure is logged via
  // try-cmd's debug logger; doctor itself never errors out on it.
  // Un-finishable expired trials come back as warnings and are folded into
  // config.warnings, so the text path gates exit 2 exactly like --json does
  // for the same state (they used to diverge: text printed the line and
  // exited 0 "All good", json exited 2).
  const trialWarnings = await renderTrialsSection({ home, print, now: opts.now });
  if (trialWarnings.length > 0) config.warnings = [...config.warnings, ...trialWarnings];

  // Probe every supported client/scope combo on the current OS, against the
  // CLAUDE_CONFIG_DIR-aware paths collectDoctorBase resolved.
  const clients = probeClients({
    home,
    os,
    cwd,
    claudeConfigDir,
    appData,
    platform: opts.platform,
    readClientConfig: opts.readClientConfig,
  });
  print("INSTALLED CLIENTS (probed config files)");
  for (const c of clients) {
    const { label, status } = describeClient(c);
    print(`  ${label}: ${status}`);
    print(`    ${c.path}`);
  }
  print("");
  // A client that cannot start yaw-mcp is a WARNING, not just a CLIENTS
  // line -- see clientLaunchWarnings. Folded last (trust -> bundle -> trials
  // -> clients); the --json path folds the same helper at the same position.
  config.warnings = [...config.warnings, ...clientLaunchWarnings(clients)];

  if (config.warnings.length > 0) {
    print("WARNINGS");
    for (const w of config.warnings) print(`  ! ${w}`);
    print("");
  }

  // Shell-history CLI-shadow scan. Reads recent bash/zsh/PowerShell
  // history lines and flags any that invoked a CLI an MCP server
  // shadows (per the static registry in cli-shadows.ts). Non-fatal —
  // purely informational. History files may not exist, may be
  // unreadable, or may use a format we can't parse; any failure is
  // silently skipped and this section is omitted.
  const shadowHits = scanShellHistoryForShadows({ home, env });
  if (shadowHits.length > 0) {
    print("SHADOWED CLI USAGE (recent shell history)");
    print("  Commands below have MCP servers that can replace them;");
    print("  activate the server and prefer its tools over the CLI.");
    for (const hit of shadowHits) {
      const pluralHit = hit.count === 1 ? "time" : "times";
      print(`  ${hit.cli.padEnd(12)} ${hit.count} ${pluralHit} -> server(s): ${hit.namespaces.join(", ")}`);
    }
    print("");
  }

  // Freshness check: is this binary behind the npm registry? Skip in
  // source ("dev") mode and absorb any network error silently — a
  // stale-version warning that depends on an external service must not
  // block the diagnostic. Times out after DOCTOR_REGISTRY_TIMEOUT_MS to keep
  // doctor snappy -- see that constant for why doctor's budget is shorter than
  // upgrade's. The skip rule itself lives in registrySkipCheck (below).
  const skipCheck = registrySkipCheck(opts, opts.registryFetch);
  const latest = skipCheck
    ? null
    : await fetchLatestVersion({ timeoutMs: DOCTOR_REGISTRY_TIMEOUT_MS, override: opts.registryFetch });
  const effectiveVersion = opts.currentVersion ?? VERSION;
  const staleHint = latest && effectiveVersion !== "dev" && compareSemver(effectiveVersion, latest) < 0 ? latest : null;
  if (staleHint) {
    // Method-aware so the hint is always the user's TERMINAL action --
    // never a command that turns around and prints another command.
    // Refinement consults `npm prefix -g` for the ambiguous methods
    // (auto-skipped under vitest; see refineInstallMethod).
    const effectiveArgvPath = opts.argvPath ?? process.argv[1];
    const method = (await detectSea())
      ? "binary"
      : await refineInstallMethod(detectInstallMethod(effectiveArgvPath), effectiveArgvPath);
    print("UPGRADE AVAILABLE");
    if (method === "bundled-app") {
      print(`  Running ${effectiveVersion}; npm latest is ${staleHint}. This copy ships inside`);
      print("  Yaw Terminal and updates with the app -- update Yaw Terminal to get it.");
    } else if (method === "npx") {
      print(`  Running ${effectiveVersion}; npm latest is ${staleHint}. npx fetches the latest`);
      print("  on each spawn -- restart your MCP client to pick it up.");
    } else if (method === "binary") {
      print(`  Running ${effectiveVersion}; npm latest is ${staleHint}. This is a standalone`);
      print(`  binary; ${BINARY_RETIRED_HINT}`);
    } else if (
      method === "global-npm" ||
      method === "pnpm-global" ||
      method === "bun-global" ||
      method === "local-node-modules"
    ) {
      print(`  Running ${effectiveVersion}; npm latest is ${staleHint}. To upgrade in place:`);
      print("");
      print("    yaw-mcp upgrade --run");
    } else {
      const plan = buildUpgradePlan({ current: effectiveVersion, latest: staleHint, method });
      print(`  Running ${effectiveVersion}; npm latest is ${staleHint}. To upgrade:`);
      print("");
      print(`    ${plan.command ?? "npm install -g @yawlabs/mcp@latest"}`);
    }
    print("");
  }

  let exitCode = 0;
  // Warnings are emitted to stderr UNCONDITIONALLY so a pipeline that
  // captures only stdout still sees them. The text WARNINGS section above
  // is part of the human report (stdout); the stderr stream below is the
  // always-on signal.
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  if (config.warnings.length > 0) {
    for (const w of config.warnings) writeErr(`warning: ${w}\n`);
  }
  // Any warning is exit 2. See the exit-code note at the top of this file:
  // this gate must stay unconditional. The old form ran the warning branch
  // only when a token was resolved, so once account mode went away a
  // malformed config would have exited 0 with the warnings buried.
  if (config.warnings.length > 0) {
    exitCode = 2;
    print("DIAGNOSIS");
    print("  Warnings above need attention.");
  } else {
    print("DIAGNOSIS");
    print(
      staleHint ? "  Healthy, but an upgrade is available (see above)." : "  All good. yaw-mcp should start cleanly.",
    );
  }

  return { exitCode, lines, snapshot: { version: VERSION, config, clients } };
}

// JSON counterpart to runDoctor. Same data-collection sequence, no
// print calls — emits a single JSON blob so pipelines and dashboards
// can consume the diagnostic without parsing the text layout.
async function runDoctorJson(opts: DoctorOptions): Promise<DoctorResult> {
  const lines: string[] = [];
  const write = opts.out ?? ((s: string) => process.stdout.write(s));

  // Same collection prologue as the text path -- option defaults, config load,
  // project-trust fold, CLAUDE_CONFIG_DIR -- so `doctor --json` reports the
  // gate in `.warnings` and exits 2 identically. See collectDoctorBase.
  const { cwd, home, appData, os, env, timestamp, config, trustProbe, claudeConfigDir } = await collectDoctorBase(opts);

  // Trial GC + readout. The --json path MUST run gcExpiredTrials too, so
  // `doctor` and `doctor --json` have the SAME persistent side effects
  // (peel expired entries out of client configs, delete markers). Previously
  // the JSON path returned early and
  // skipped GC entirely, leaving expired trials wired up. Best-effort:
  // any sweep failure is swallowed, matching renderTrialsSection.
  // Scan once, then hand the scan to the GC pass so the trials dir isn't
  // read twice (GC only unlinks expired markers, so live/malformed in this
  // pre-sweep scan match the post-sweep readout state).
  //
  // Runs BEFORE probeClients, matching the text path (renderTrialsSection GCs
  // at its own section, then the CLIENTS section probes). gcExpiredTrials
  // REWRITES client config files to peel expired `yaw-mcp-try-*` entries out,
  // so probing first would snapshot pre-GC configs and report entries this
  // same run just deleted -- the "Same data-collection sequence" claim in the
  // header above is only true with the GC ahead of the probe.
  const trialScan = await scanTrials({ home, now: opts.now });
  const trialGc = await gcExpiredTrials({
    home,
    now: opts.now,
    scan: trialScan,
  }).catch(() => ({ cleared: 0, failed: 0, failures: [] }));

  const clients = probeClients({
    home,
    os,
    cwd,
    claudeConfigDir,
    appData,
    platform: opts.platform,
    readClientConfig: opts.readClientConfig,
  });

  // Same project-guide probe as the text path's PROJECT GUIDE section.
  const guide = await loadProjectGuide(cwd, home, env).catch(() => null);
  const projectGuide: DoctorJsonSnapshot["projectGuide"] = guide
    ? { path: guide.path, unapproved: guide.unapproved === true }
    : null;

  const envVarNames = DOCTOR_ENV_VARS.map((v) => v.name);
  // DEPRECATED key, seeded first so it keeps its position in the emitted
  // object. YAW_MCP_POLL_INTERVAL configured the remote config poll loop,
  // which went with the hosted backend; nothing reads the var any more, so
  // it reports null even when it IS set. The key survives the deprecation
  // window so `.env.YAW_MCP_POLL_INTERVAL` consumers don't break on a
  // missing property. Dropped in a later release.
  const envOverrides: Record<string, string | null> = { YAW_MCP_POLL_INTERVAL: null };
  for (const name of envVarNames) {
    const raw = env[name];
    envOverrides[name] = raw === undefined || raw === "" ? null : raw;
  }

  // STATE + RELIABILITY section data, from the SAME peek-then-load helper the
  // text path uses (collectStateStatus), so the two surfaces cannot disagree
  // about what state.json is. They used to carry separate copies of this
  // prologue, and the copies differed on whether a missing file was loaded.
  // The peek-first order is what keeps a corrupt / stale-schema / unreadable
  // state.json from being reported here as healthy-and-fresh (loadState
  // swallows those into an empty state) while `doctor` (text) calls it out.
  const {
    disabled: persistDisabled,
    filePath: stateFilePath,
    peek: statePeek,
    persisted,
  } = await collectStateStatus({ env, home });
  const state: DoctorJsonSnapshot["state"] = ((): DoctorJsonSnapshot["state"] => {
    if (persistDisabled || statePeek === null) {
      return {
        disabled: true,
        status: "disabled",
        detail: null,
        path: null,
        savedAt: null,
        learningEntries: null,
        packHistoryEntries: null,
      };
    }
    if (statePeek.kind === "missing") {
      // Nothing on disk, so nothing to load: the counts are zero by
      // construction. Zero -- not the null the unusable cases below report --
      // is what keeps "never written" distinguishable from "could not be
      // read" for a consumer, and it is the shape this block has always
      // emitted for a missing file.
      return {
        disabled: false,
        status: "missing",
        detail: null,
        path: stateFilePath,
        savedAt: null,
        learningEntries: 0,
        packHistoryEntries: 0,
      };
    }
    if (!persisted) {
      return {
        disabled: false,
        status: statePeek.kind,
        detail: statePeekDetail(statePeek),
        path: stateFilePath,
        savedAt: null,
        learningEntries: null,
        packHistoryEntries: null,
      };
    }
    const fresh = persisted.savedAt === 0;
    return {
      disabled: false,
      status: statePeek.kind,
      detail: null,
      path: stateFilePath,
      savedAt: fresh ? null : new Date(persisted.savedAt).toISOString(),
      learningEntries: fresh ? 0 : Object.keys(persisted.learning).length,
      packHistoryEntries: fresh ? 0 : persisted.packHistory.length,
    };
  })();

  // Reliability rollup — same selectFlakyNamespaces path as renderReliabilitySection
  // and mcp_connect_health, so all three surfaces agree on "flaky."
  const reliability: DoctorJsonSnapshot["reliability"] = [];
  if (!persistDisabled && persisted) {
    if (persisted.savedAt !== 0) {
      const entries = Object.entries(persisted.learning).map(([namespace, usage]) => ({ namespace, usage }));
      for (const { namespace, usage } of selectFlakyNamespaces(entries, 5)) {
        reliability.push({
          namespace,
          dispatched: usage.dispatched,
          // `succeeded` is a graded-reward SUM (learning.ts), so adding [0,1]
          // rewards can leave IEEE-754 noise (e.g. 48.00000000000001). Round for
          // a clean diagnostic; successRate stays computed from the raw value.
          succeeded: Math.round(usage.succeeded * 1000) / 1000,
          successRate: usage.succeeded / usage.dispatched,
          lastUsedAt: new Date(usage.lastUsedAt).toISOString(),
        });
      }
    }
  }

  const shellShadows = scanShellHistoryForShadows({ home, env });

  const trials: DoctorJsonSnapshot["trials"] = {
    cleared: trialGc.cleared,
    failed: trialGc.failed,
    failures: trialGc.failures,
    live: trialScan.live.map(({ marker, msUntilExpiry }) => ({
      slug: marker.slug,
      clientName: marker.clientName,
      clientPath: marker.clientPath,
      msUntilExpiry,
    })),
    malformed: trialScan.malformed,
  };

  // oam runtime block — same collector as the text path's OAM RUNTIME
  // section, so the two surfaces can't drift.
  const oamStatus = await collectOamRuntimeStatus({
    env,
    cwd,
    home,
    probeFn: opts.oamProbe ?? probeOam,
    sidecarLatest: sidecarLatestFetcher(opts),
  });
  // Identical fold to the text path -- a malformed bundles.json must reach
  // `.warnings` and exit 2 on both surfaces.
  config.warnings = [...config.warnings, ...foldBundleWarnings(oamStatus.bundleWarnings, trustProbe)];
  // Same collector as the text path's SECRET VAULT section. Emitted
  // unconditionally here (the text section hides itself when there is no
  // vault and no refs) so a consumer can read `.vault` without a presence
  // check. Names and booleans only -- never a value, never the passphrase.
  const vault = await collectVaultStatus({ home, env, servers: oamStatus.servers });
  // Trial-GC failures fold AFTER the bundle warnings, matching the text
  // path's order (trust -> bundle -> trials) so the two surfaces emit the
  // same warning list in the same order. Same per-failure wording helper
  // as the text path, so they cannot drift on content either.
  if (trialGc.failures.length > 0) {
    config.warnings = [...config.warnings, ...trialGc.failures.map(trialGcFailureWarning)];
  }
  // Client cannot-launch states fold LAST, through the same helper and at the
  // same position as the text path (trust -> bundle -> trials -> clients), so
  // `.warnings` and `.diagnosis` say what the text report says.
  config.warnings = [...config.warnings, ...clientLaunchWarnings(clients)];
  const oamRuntime: DoctorJsonSnapshot["oamRuntime"] = {
    binary: oamStatus.probe.bin,
    version: oamStatus.probe.version,
    belowMin: oamStatus.probe.belowMin,
    minVersion: MIN_OAM_VERSION,
    failure: oamStatus.probe.failure,
    failureDetail: oamStatus.probe.failureDetail,
    defaultRuntime: oamStatus.dflt.runtime,
    defaultRuntimeSource: oamStatus.dflt.source,
    defaultRuntimePath: oamStatus.dflt.path,
    servers: oamStatus.servers.map((s) => ({
      namespace: s.namespace,
      runtime: s.info.runtime,
      reason: s.info.reason,
    })),
    // Mirrored, not dropped. collectOamRuntimeStatus already pays for these
    // reads on both paths, and the text renderer has always printed them --
    // emitting only on the text path made the shared-collector claim above
    // false and hid the one machine-level fact from every --json consumer.
    managed: oamStatus.managed,
  };

  // DEPRECATED key, emitted with its original nested shape (both members
  // null) so `doctor --json` output is unchanged for consumers during the
  // deprecation window. See DoctorJsonSnapshot.backgroundPosters.
  const backgroundPosters: DoctorJsonSnapshot["backgroundPosters"] = { analytics: null, toolReport: null };

  // Mirrors the text path's hook handling (see runDoctor and
  // registrySkipCheck): an explicit registryFetch bypasses the VITEST guard,
  // and currentVersion overrides the build-time VERSION. opts.argvPath is
  // intentionally unused here -- the JSON snapshot's upgrade block carries no
  // install method.
  const skipCheck = registrySkipCheck(opts, opts.registryFetch);
  const latest = skipCheck
    ? null
    : await fetchLatestVersion({ timeoutMs: DOCTOR_REGISTRY_TIMEOUT_MS, override: opts.registryFetch });
  const effectiveVersion = opts.currentVersion ?? VERSION;
  const stale = latest !== null && effectiveVersion !== "dev" && compareSemver(effectiveVersion, latest) < 0;

  let exitCode = 0;
  let summary: string;
  // Always-on warning stream: mirrors the text path so JSON-mode pipelines
  // that capture stdout (the JSON blob) still surface config warnings on
  // stderr even when the exit code is 0.
  const writeErrJson = opts.err ?? ((s: string) => process.stderr.write(s));
  if (config.warnings.length > 0) {
    for (const w of config.warnings) writeErrJson(`warning: ${w}\n`);
  }
  // Unconditional warning gate, identical to the text path.
  if (config.warnings.length > 0) {
    exitCode = 2;
    summary = "Warnings need attention.";
  } else {
    summary = stale ? "Healthy, but an upgrade is available." : "All good. yaw-mcp should start cleanly.";
  }

  const snapshotJson: DoctorJsonSnapshot = {
    timestamp,
    version: VERSION,
    platform: os,
    // DEPRECATED keys, emitted with their original nested shape and null
    // members so `doctor --json` stays parseable for consumers reading
    // `.token.source` / `.apiBase.value`. See DoctorJsonSnapshot.
    token: { fingerprint: null, source: null },
    apiBase: { value: null, source: null },
    loadedFiles: config.loadedFiles.map((f) => ({
      scope: f.scope,
      path: f.path,
      ...(f.version !== undefined ? { schemaVersion: f.version } : {}),
      schemaAhead: f.version !== undefined && f.version > CURRENT_SCHEMA_VERSION,
    })),
    projectGuide,
    warnings: config.warnings,
    env: envOverrides,
    vault,
    state,
    reliability,
    clients,
    shellShadows,
    trials,
    backgroundPosters,
    oamRuntime,
    upgrade: { current: effectiveVersion, latest, stale },
    diagnosis: { exitCode, summary },
  };

  const blob = JSON.stringify(snapshotJson, null, 2);
  lines.push(blob);
  write(`${blob}\n`);

  return { exitCode, lines, snapshot: { version: VERSION, config, clients } };
}

// THE single list of behavior-modifier env vars yaw-mcp reads at runtime,
// shared by the text ENVIRONMENT section and the --json `env` block so a
// support ticket can paste doctor output and we can tell at a glance
// which knobs are turned on. Keep it in lockstep with the env table in
// `yaw-mcp --help` (index.ts) -- the two drifted apart by SEVEN variables
// once, which is exactly where the drift hurts: doctor is the
// paste-into-a-ticket surface. Deliberate exclusions when diffing against
// --help: DISABLE_PERSISTENCE stays in the STATE section (richer context
// there); YAW_MCP_TRUST_PROJECT and YAW_MCP_ALLOW_UNOWNED_PROJECT_DIRS in the
// trust gate; YAW_MCP_CATALOG_URL is an endpoint override, not a behavior
// toggle, and stays out. YAW_MCP_VAULT_PASSPHRASE and
// YAW_MCP_VAULT_PASSPHRASE_NEW are excluded for a stronger reason than any of
// those: this list prints RAW VALUES, and those two are themselves
// credentials -- putting either here would paste the user's vault passphrase
// into every support ticket. Vault state is reported as a boolean by the
// SECRET VAULT section instead (see VaultStatus.passphraseSet), so the drift
// check should read them as covered, not missing.
//
// The lockstep is PINNED, not just asked for: the "env table lockstep with
// `yaw-mcp --help`" suite in doctor-cmd.test.ts reads the help table straight
// out of index.ts and fails on a var added to either side without the other
// (the exclusions above are that suite's allow-list, so widening one means
// widening the other deliberately). Exported for it.
//
// The "default when unset" hint next to each unset value is the most
// useful bit — without it users don't know what the omission means.
export const DOCTOR_ENV_VARS: ReadonlyArray<{ name: string; defaultHint: string }> = [
  { name: "YAW_MCP_SERVER_CAP", defaultHint: "default 6" },
  { name: "YAW_MCP_MIN_COMPLIANCE", defaultHint: "filter inactive" },
  { name: "YAW_MCP_AUTO_LOAD", defaultHint: "auto-load inactive" },
  { name: "YAW_MCP_AUTO_ACTIVATE", defaultHint: "default on" },
  { name: "YAW_MCP_PRUNE_RESPONSES", defaultHint: "pruning active" },
  { name: "YAW_MCP_DEFAULT_RUNTIME", defaultHint: "oam when installed" },
  { name: "YAW_MCP_TOOL_EXPOSURE", defaultHint: "gateway" },
  { name: "YAW_MCP_AUTO_UPGRADE", defaultHint: "default on" },
  { name: "YAW_MCP_SIDECAR_REFRESH", defaultHint: "default on" },
  { name: "YAW_MCP_IDLE_THRESHOLD", defaultHint: "adaptive, base 10" },
  { name: "YAW_MCP_ROUTE_EFFORT", defaultHint: "auto" },
  { name: "YAW_MCP_REWARD_GRADER", defaultHint: "off" },
  { name: "YAW_MCP_FOUNDRY", defaultHint: "harvest off" },
  { name: "YAW_MCP_INSTALL_NUDGE", defaultHint: "nudge off" },
];
function renderEnvSection(opts: { env: NodeJS.ProcessEnv; print: (s?: string) => void }): void {
  const { env, print } = opts;
  const vars = DOCTOR_ENV_VARS;
  const widest = vars.reduce((m, v) => Math.max(m, v.name.length), 0);
  print("ENVIRONMENT (behavior overrides)");
  for (const v of vars) {
    const raw = env[v.name];
    const value = raw === undefined || raw === "" ? `(not set -- ${v.defaultHint})` : raw;
    print(`  ${v.name.padEnd(widest)}  ${value}`);
  }
  print("");
}

/** Everything the SECRET VAULT section (text) / `vault` block (json) needs.
 *
 *  Secret VALUES are never read, decrypted, or reported -- entry NAMES only,
 *  which is exactly what `yaw-mcp secrets list` already prints without a
 *  passphrase (the vault stores them as plaintext object keys; only the
 *  values are ciphertext). `passphraseSet` is a boolean for the same reason
 *  YAW_MCP_VAULT_PASSPHRASE is deliberately absent from DOCTOR_ENV_VARS,
 *  which prints raw values: doctor output is the paste-into-a-ticket surface,
 *  and the one env var here that is itself a credential must never be in it.
 *
 *  Exported because it IS the `vault` block of DoctorJsonSnapshot -- the
 *  --json consumer contract -- rather than a private shape the block copies. */
export interface VaultStatus {
  path: string;
  exists: boolean;
  /** Entry names, or null when the file exists but could not be read/parsed. */
  entries: string[] | null;
  /** Why the vault could not be read. Non-null only when `entries` is null. */
  unreadable: string | null;
  /** On-disk schema version, or null when there is no readable vault. A vault
   *  stays at the version it was created with until `secrets rotate` rewrites
   *  it (setSecret preserves it), so this is the ONLY place a user learns that
   *  a v1 vault never gained the v2 name binding. Additive JSON field. */
  schemaVersion: number | null;
  /** Whether a passphrase is present in this process's env. NEVER the value. */
  passphraseSet: boolean;
  /** Servers whose configured env carries `${secret:NAME}` refs. */
  refs: Array<{ namespace: string; secretNames: string[] }>;
  /** Local servers whose env carries a `${secret:` the strict regex cannot
   *  parse (a space in the name, a missing `}`), each as secrets-vault's
   *  bounded display form of the span -- never the raw env value.
   *  resolveServerEnv refuses these spawns exactly as it does a missing name,
   *  and without this line the section said "no server env references
   *  ${secret:NAME}" about the very ref the spawn was refused over. Additive
   *  JSON field. */
  malformed: Array<{ namespace: string; refs: string[] }>;
  /** Referenced names that are NOT in the vault. Empty when the vault is
   *  unreadable -- we cannot tell, and guessing would invent a false alarm. */
  missing: string[];
}

async function collectVaultStatus(opts: {
  home: string;
  env: NodeJS.ProcessEnv;
  servers: OamRuntimeStatus["servers"];
}): Promise<VaultStatus> {
  const path = vaultPath(opts.home);
  const exists = existsSync(path);
  let entries: string[] | null = exists ? null : [];
  let unreadable: string | null = null;
  let schemaVersion: number | null = null;
  if (exists) {
    try {
      const vault = await loadVault(path);
      // loadVault returns null only for ENOENT, which existsSync just ruled
      // out -- but a race between the two is possible, and "no entries" is
      // the honest reading of a vault file that vanished mid-run.
      entries = vault ? listKeys(vault) : [];
      schemaVersion = vault ? vault.version : null;
    } catch (err) {
      unreadable = err instanceof Error ? err.message : String(err);
    }
  }

  const refs: VaultStatus["refs"] = [];
  const malformed: VaultStatus["malformed"] = [];
  for (const s of opts.servers) {
    // LOCAL servers only. A remote entry's env is never sent anywhere --
    // upstream.ts logs "Ignoring env on a remote server" and connects
    // unauthenticated -- so resolveServerEnv never runs for one and no
    // passphrase changes its outcome. Listing it here would put it under the
    // "these servers FAIL TO START while the vault is locked" note, which is
    // simply untrue of a remote: it starts fine and gets a 401 from the far
    // end. A diagnostic that invents a cause is worse than one that says
    // nothing, so the vault section stays silent about remotes rather than
    // sending the user to unlock a vault that was never in the path.
    if (s.type === "remote") continue;
    // secrets-vault's shared scanner, not a local matchAll over SECRET_REF_RE:
    // that object carries /g and is module-shared, so scanning against it
    // directly leaves a lastIndex other callers trip over. This loop used to be
    // a hand copy of collectSecretRefNames re-deriving that rule, as did
    // meta-tools.ts's and upstream.ts's.
    const names = collectSecretRefNames(s.env);
    if (names.size > 0) refs.push({ namespace: s.namespace, secretNames: [...names].sort() });
    const malformedRefs = collectMalformedSecretRefs(s.env);
    if (malformedRefs.length > 0) malformed.push({ namespace: s.namespace, refs: malformedRefs });
  }

  const known = entries;
  const referenced = new Set(refs.flatMap((r) => r.secretNames));
  const missing = known === null ? [] : [...referenced].filter((n) => !known.includes(n)).sort();

  return {
    path,
    exists,
    entries,
    unreadable,
    schemaVersion,
    passphraseSet: (opts.env.YAW_MCP_VAULT_PASSPHRASE ?? "") !== "",
    refs,
    malformed,
    missing,
  };
}

/** SECRET VAULT section.
 *
 *  Informational, and deliberately NOT folded into config.warnings (same call
 *  as renderProjectGuideSection). An unset passphrase is the NORMAL state for
 *  a terminal run: it belongs in the env your MCP client spawns yaw-mcp with,
 *  which doctor -- running as its own process from a shell -- cannot see. A
 *  warning would take a perfectly healthy machine to exit 2.
 *
 *  Omitted entirely when there is no vault and nothing references one. */
function renderVaultSection(opts: { status: VaultStatus; print: (s?: string) => void }): void {
  const { status, print } = opts;
  if (!status.exists && status.refs.length === 0 && status.malformed.length === 0) return;
  print("SECRET VAULT");
  print(`  file:       ${status.path}${status.exists ? "" : " (does not exist yet)"}`);
  if (status.unreadable !== null) {
    print(`  entries:    unreadable -- ${status.unreadable}`);
  } else {
    const entries = status.entries ?? [];
    print(`  entries:    ${entries.length === 0 ? "(none)" : `${entries.length} -- ${entries.join(", ")}`}`);
  }
  // Schema line only when a vault was read. A vault created before v2 stays
  // v1 forever (setSecret preserves the version), so its entries are never
  // bound to their names and a blob swap between two names still decrypts --
  // and until this line nothing told the user, who had no reason to run
  // `secrets rotate` on a vault that works.
  if (status.schemaVersion !== null) {
    if (status.schemaVersion < SECRETS_SCHEMA_VERSION) {
      print(`  schema:     v${status.schemaVersion} -- entries are NOT bound to their names until`);
      print(`              \`yaw-mcp secrets rotate\` rewrites the file as v${SECRETS_SCHEMA_VERSION}`);
    } else {
      print(`  schema:     v${status.schemaVersion}`);
    }
  }
  print(`  passphrase: ${status.passphraseSet ? "set in this environment" : "not set in this environment"}`);
  if (status.refs.length === 0) {
    print("  refs:       no server env references ${secret:NAME}");
  } else {
    print("  refs:");
    for (const r of status.refs) {
      print(`    ${r.namespace}: ${r.secretNames.map((n) => `\${secret:${n}}`).join(", ")}`);
    }
  }
  // A ref the strict regex could not parse is refused at spawn exactly like a
  // missing name, so it gets the same prominence -- and its own remedy: the
  // fix is the typo in bundles.json, not the vault.
  if (status.malformed.length > 0) {
    print("  malformed:  refs the spawn is REFUSED over (fix the typo in bundles.json):");
    for (const m of status.malformed) {
      print(`    ${m.namespace}: ${m.refs.join(", ")}`);
    }
  }
  if (status.refs.length > 0 && !status.passphraseSet) {
    print("  note:       the servers above FAIL TO START while the vault is locked -- yaw-mcp");
    print("              refuses the spawn rather than passing the literal placeholder through.");
    print("              Set YAW_MCP_VAULT_PASSPHRASE in yaw-mcp's OWN env (the `env` block of");
    print("              the yaw-mcp entry in your MCP client config), NOT in the upstream");
    print("              server's -- it is stripped from every child env. A client that");
    print("              supports MCP elicitation prompts for it instead, for that session.");
    print("              Unset HERE is expected: doctor cannot see your client's env.");
  }
  if (status.missing.length > 0) {
    print(`  missing:    referenced but not stored -- ${status.missing.join(", ")}`);
    print("              store each with `yaw-mcp secrets set <name>`");
  }
  print("");
}

// Everything the OAM RUNTIME section (text) / oamRuntime block (json) needs,
// collected once so the two paths can't drift: the binary probe, the
// config-level default (+ provenance), and a per-server verdict for every
// configured server. The list covers bundles.json because bundles.json is now
// the ONLY server source -- account mode is gone (`yaw-mcp servers` is a
// deprecated stub that always exits 1), so there is no second source of server
// definitions for this section to be missing.
interface OamRuntimeStatus {
  probe: OamProbe;
  dflt: DefaultRuntimeInfo;
  /** `command` rides along so the renderer can qualify an `oam` verdict for an
   *  `npx` server: describeServerRuntime deliberately does not probe package
   *  resolution (it would make doctor flap), but rewriteForOam DOES, and keeps
   *  npx when the package is on disk nowhere. */
  /** `env` and `type` ride along for the SECRET VAULT section, which needs to
   *  know which servers carry `${secret:...}` refs AND which of them the vault
   *  can actually serve. Threaded through here rather than loaded again:
   *  loadLocalBundles warns on a file it cannot parse, and a second read would
   *  print every bundles.json diagnostic twice per run (the same trap
   *  described on the `bundles` load below). */
  servers: Array<{
    namespace: string;
    command: string | undefined;
    env: Record<string, string> | undefined;
    type: "local" | "remote";
    info: ServerRuntimeInfo;
  }>;
  /** The managed install (`yaw-mcp sidecars install`): where it is, the
   *  version + registry freshness of each package in it, and which
   *  platform/arch filled it. Empty when it has never been run. Field
   *  semantics are documented on DoctorJsonSnapshot.oamRuntime.managed, which
   *  mirrors this object verbatim. */
  managed: {
    root: string;
    packages: Array<{ pkg: string; version: string | null; latest: string | null; stale: boolean }>;
    installedFor: SidecarsPlatform | null;
    platformMismatch: boolean;
  };
  /** Why the background sidecar refresh (sidecar-refresh.ts) will pass a
   *  package OVER, keyed by package name -- buildRefreshPlan's `skipped`
   *  reasons, verbatim. Rendered only beside a package doctor has
   *  independently found stale, so the ordinary "nothing to do" skips (not
   *  installed, already current) never reach the report.
   *
   *  Deliberately a sibling of `managed` rather than a field on its
   *  packages: `managed` is mirrored verbatim into --json (see
   *  DoctorJsonSnapshot.oamRuntime.managed), and this is a text-report hint
   *  whose wording belongs to another module. Keeping it out holds the --json
   *  package shape byte-identical -- consumers deep-compare that array. */
  refreshSkips: Map<string, string>;
  /** True when YAW_MCP_SIDECAR_REFRESH turns the background refresher off, so
   *  the stale-package hint names the manual remedy instead of promising an
   *  automatic one that will never run. */
  refreshDisabled: boolean;
  /** Diagnostics from the bundles.json read (unparseable file, schema ahead,
   *  invalid defaultRuntime, skipped entries). The caller folds these into
   *  config.warnings -- see foldBundleWarnings. */
  bundleWarnings: string[];
}

// Latest-version probe for a managed sidecar package. Same contract and
// response validation as upgrade-cmd's fetchLatestVersion (null on any
// failure, hard abort at doctor's budget) but keyed by package -- that one is
// hardwired to @yawlabs/mcp itself, and doctor is the only caller that asks
// about arbitrary packages, so it lives here rather than generalizing the
// shared probe. The unencoded scoped-name URL matches the shape upgrade-cmd
// has always used against this registry.
async function fetchSidecarLatest(pkg: string): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DOCTOR_REGISTRY_TIMEOUT_MS);
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      signal: ac.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** THE registry-probe gate, in one place. doctor makes three network probes
 *  (the @yawlabs/mcp freshness check on the text path, the same check on the
 *  --json path, and the per-sidecar check below) and all three must agree
 *  about whether the check ran -- this expression used to be copy-pasted at
 *  each one, so a fourth probe was a coin-flip on whether it inherited the
 *  VITEST guard.
 *
 *  `skipRegistryCheck` or a VITEST env both suppress the real fetch. But an
 *  explicitly-supplied `override` hook wins over both, so a test can reach
 *  the stale-version branches that the auto-skip would otherwise hide.
 *
 *  NOTE: `process.env.VITEST` here is THE deliberate process.env read in
 *  doctor (everything else routes through opts.env). Tests pass a stripped
 *  `env: {}`, so VITEST is never visible via opts.env; reading process.env
 *  directly is exactly what lets the auto-skip fire under vitest. Kept
 *  intentional -- do not "fix" it to opts.env. */
export function registrySkipCheck(opts: DoctorOptions, override: unknown): boolean {
  return (opts.skipRegistryCheck === true || Boolean(process.env.VITEST)) && !override;
}

// The gate for the per-sidecar freshness probe, shared by the text and --json
// paths so the two cannot disagree about whether the check ran.
function sidecarLatestFetcher(opts: DoctorOptions): ((pkg: string) => Promise<string | null>) | null {
  const skip = registrySkipCheck(opts, opts.sidecarRegistryFetch);
  return skip ? null : (opts.sidecarRegistryFetch ?? fetchSidecarLatest);
}

async function collectOamRuntimeStatus(opts: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  // Accepts sync OR async so doctor's own test fixtures can keep passing a
  // plain object while production passes the async probeOam (issue #91).
  probeFn: () => OamProbe | Promise<OamProbe>;
  /** Latest-version probe for a managed sidecar package, or null when the
   *  registry check is skipped. See sidecarLatestFetcher. */
  sidecarLatest: ((pkg: string) => Promise<string | null>) | null;
}): Promise<OamRuntimeStatus> {
  const probe = await opts.probeFn();
  // `env` is threaded through so the loader's trust gate sees the SAME
  // environment doctor's own probeProjectTrust does. Without it the loader read
  // process.env while doctor read opts.env, and the two could disagree about
  // whether the project file is honoured -- which would print a bypass warning
  // and an "IGNORED" warning about the same file in the same report.
  const bundles = await loadLocalBundles({ cwd: opts.cwd, home: opts.home, env: opts.env }).catch(() => null);
  // Hand describeDefaultRuntime the load we just did instead of letting it do
  // its own -- it reads the SAME file. Two reads was not merely wasteful: the
  // loader warns on a bundles.json it cannot parse, so a malformed file logged
  // "bundles.json is not valid JSON" TWICE per doctor run. Passing null when the
  // load failed is the same answer it would have reached itself (its own catch
  // collapses a failed load to null), so the resolution is unchanged.
  const dflt = await describeDefaultRuntime({ env: opts.env, cwd: opts.cwd, home: opts.home, bundles });
  const servers = (bundles?.config?.servers ?? []).map((s) => ({
    namespace: s.namespace,
    command: s.command,
    env: s.env,
    type: s.type,
    info: describeServerRuntime(s, dflt.runtime, probe),
  }));
  // Report the version actually installed for each package the config asks
  // for -- that is the number an oam-hosted server will run, and the one thing
  // the config file itself cannot tell you.
  const specs = collectSidecarSpecs(bundles?.config?.servers ?? []);
  // Skip the per-package reads entirely when the tree was never created --
  // `sidecars install` is opt-in, so "never run" is the common case, and each
  // package would otherwise cost a stat + read + JSON.parse that can only come
  // back null.
  const anyManaged = hasManagedSidecars(opts.home);
  const packages = await Promise.all(
    specs.map(async (s) => {
      const version = anyManaged ? installedVersion(s.pkg, opts.home) : null;
      // Freshness only for a package that is actually INSTALLED (a missing one
      // already reads as "not in the managed tree" -- its problem is not
      // staleness) and only when the registry check is on at all. In parallel,
      // so N packages cost one timeout window, not N -- doctor must not hang.
      //
      // A REJECTING probe is absorbed here, not trusted to the hook: the
      // documented contract (null = unknown) is the same one registryFetch
      // has, and that one is absorbed inside fetchLatestVersion. Left bare,
      // a rejection propagated through this Promise.all and rejected
      // runDoctor -- the one freshness probe that could take the whole
      // diagnostic down, on a report that exists to be readable when things
      // are broken.
      const latest =
        version !== null && opts.sidecarLatest !== null ? await opts.sidecarLatest(s.pkg).catch(() => null) : null;
      // Strictly behind, on a fetched answer only -- compareSemver treats
      // unparseable as equal, so a weird version cannot invent a false stale.
      const stale = version !== null && latest !== null && compareSemver(version, latest) < 0;
      return { pkg: s.pkg, version, latest, stale };
    }),
  );
  // Why a stale package will NOT be picked up by the background refresh.
  // Asked of buildRefreshPlan rather than re-derived here, because the rule is
  // subtle enough that a second copy would drift: the refresher moves only
  // specs configured "@latest" or unpinned, since an explicit `pkg@0.13.3` is
  // the user's stated version and auto-moving it would defeat the reason
  // sidecars exist (sidecars-cmd.ts: "The version pins itself"). A doctor that
  // decided that separately could advise a refresh the refresher will never
  // perform. Pure and local -- specs, installed versions and latest versions
  // are all already in hand, so this adds no I/O and no network to the report.
  //
  // Guarded because doctor is the command people run WHEN things are broken: a
  // diagnostic that throws while composing a HINT is strictly worse than one
  // that omits the hint. buildRefreshPlan is pure, so this should never fire;
  // if it does, every stale line falls back to the generic suffix.
  const refreshSkips = new Map<string, string>();
  try {
    const plan = buildRefreshPlan({
      specs,
      // Explicit tuple returns: without them TS widens the callback's result
      // to (string | null)[] and the Map constructor rejects it, and relying
      // on contextual typing from another module's parameter type is a
      // needless coupling for two characters of annotation.
      installed: new Map(packages.map((p): [string, string | null] => [p.pkg, p.version])),
      latest: new Map(packages.map((p): [string, string | null] => [p.pkg, p.latest])),
    });
    for (const skip of plan.skipped) refreshSkips.set(skip.pkg, skip.reason);
  } catch {
    // Intentionally empty -- see above.
  }
  // maybeRefreshSidecars' own opt-out predicate, called rather than re-spelled:
  // without it every eligible stale package is described as one the background
  // refresher will carry forward, which is simply false on a machine where the
  // user turned the refresher off -- exactly the reader who most needs to be
  // told to run `sidecars install` by hand. Doctor takes the environment as
  // input, which is why the helper accepts one instead of reading process.env.
  const refreshDisabled = isSidecarRefreshDisabled(opts.env);
  // Who filled the tree vs who is asking. npm resolves native bindings for the
  // node that RUNS the install, so a marker from another platform/arch means
  // the versions above can be present, current, and still fail at spawn here.
  const installedFor = anyManaged ? installedPlatform(opts.home) : null;
  const managed = {
    root: sidecarsRoot(opts.home),
    packages,
    installedFor,
    platformMismatch:
      installedFor !== null && (installedFor.platform !== process.platform || installedFor.arch !== process.arch),
  };
  return { probe, dflt, servers, managed, refreshSkips, refreshDisabled, bundleWarnings: bundles?.warnings ?? [] };
}

function renderOamRuntimeSection(opts: {
  status: OamRuntimeStatus;
  print: (s?: string) => void;
  /** Which platform's install command the not-installed branch names. Doctor's
   *  own --os override, so a report generated for another machine names that
   *  machine's installer. */
  os: InstallOS;
}): void {
  const { status, print } = opts;
  const { probe, dflt, servers } = status;
  print("OAM RUNTIME");
  if (probe.belowMin) {
    print(`  binary:  installed (v${probe.version}) -- below min ${MIN_OAM_VERSION}; IGNORED, servers run on node`);
    // The floor tracks the latest oam release, so "below min" is always
    // "out of date" rather than "wrong build" -- and oam updates itself in
    // place. Naming the one command that fixes it beats re-running an
    // installer that has to be looked up.
    print("           fix: oam self-update");
  } else if (probe.failure !== null) {
    // PRESENT but unusable. This used to print "not installed", which sent a
    // user who has oam installed (and often OAM_BIN set at it) off to install
    // it again, while the real cause -- a binary that wedges or errors on
    // --version -- appeared only as a raw JSON log line on stderr.
    print(`  binary:  installed but UNUSABLE (${oamFailureLabel(probe.failure)}); servers run on node`);
    if (probe.failureDetail !== null) print(`           detail: ${probe.failureDetail}`);
    print("           fix: run `oam --version` by hand; OAM_BIN overrides which binary is probed");
  } else if (probe.bin === null) {
    print("  binary:  not installed -- node/npx spawns are used directly");
    // The one branch a reader can act on and the one that used to end without
    // saying how. Nothing is broken here -- node is a full fallback -- so this
    // is `install:`, not the `fix:` the below-min and unusable branches print.
    // A user who opens doctor to find out why a server says "oam is not
    // installed" was, until now, sent to the README for the URL.
    print(`           install: ${oamInstallAdvice(opts.os)}`);
  } else if (probe.version === null) {
    // A working --version proves oam exists, so the probe treats an
    // unparseable version as usable and hosts on it (oam-spawn.ts) -- but the
    // MIN_OAM_VERSION floor is gated on a parsed version, so it never ran.
    // Rendering this as "(vunknown, min <floor>)" read exactly like a version
    // that PASSED the floor, which is the one thing this line must not do.
    print(`  binary:  ${probe.bin} (version unparseable -- min ${MIN_OAM_VERSION} NOT verified, hosting anyway)`);
  } else {
    print(`  binary:  ${probe.bin} (v${probe.version}, min ${MIN_OAM_VERSION})`);
  }
  // What THIS process runs on -- the shell's node in practice, since
  // runDoctor is only ever reached from the CLI dispatcher (index.ts); it
  // reads "oam" only if someone runs `oam run dist/index.js doctor` by hand.
  // Explicitly labelled so it is not mistaken for what a client's configured
  // entry will launch: `yaw-mcp doctor` typed into a shell runs on node no
  // matter what the entry says. The per-client "(runs on oam)" marker in
  // CLIENTS answers that one.
  // Guarded, not just cast: process.versions is another runtime's surface, and
  // an unexpected shape would otherwise render "[object Object]" into the one
  // line whose whole job is to be trustworthy.
  const rawOamVersion = (process.versions as Record<string, unknown>).oam;
  const runningOam = typeof rawOamVersion === "string" && rawOamVersion.length > 0 ? rawOamVersion : null;
  print(`  this process: ${runningOam ? `oam ${runningOam}` : `node ${process.version}`}`);
  // Name the exact source: the connect path resolves project-local bundles
  // from the BROKER's cwd, doctor from the shell's cwd — printing the file
  // path makes a divergence between the two spottable.
  const dfltLabel =
    dflt.runtime !== null
      ? `${dflt.runtime} (${dflt.source === "env" ? "env YAW_MCP_DEFAULT_RUNTIME" : `bundles.json defaultRuntime @ ${dflt.path}`})`
      : `(not set -- oam when installed, currently ${probe.bin !== null ? "oam" : "node"})`;
  print(`  default runtime: ${dfltLabel}`);
  if (servers.length > 0) {
    print("  servers (local bundles.json):");
    const widest = servers.reduce((m, s) => Math.max(m, s.namespace.length), 0);
    for (const s of servers) {
      print(`    ${s.namespace.padEnd(widest)}  ${(s.info.runtime ?? "-").padEnd(4)}  ${s.info.reason}`);
    }
    // An `oam` verdict for an npx server is conditional in a way the verdict
    // itself cannot express: the spawn rewrite needs a real on-disk entry
    // (oam has no fetch-on-demand), so a package present in no node_modules
    // and no npx cache stays on npx/node. describeServerRuntime deliberately
    // does not probe that -- it depends on the caches at spawn time and would
    // make this section flap -- so say it once here instead of claiming oam
    // unconditionally.
    // nodeLaunchKind, not `=== "npx"`: an absolute `/usr/local/bin/npx` or a
    // `npx.cmd` shim is the same launch and needs the same caveat.
    const anyNpxOnOam = servers.some(
      (s) => s.info.runtime === "oam" && s.command !== undefined && nodeLaunchKind(s.command) === "npx",
    );
    if (anyNpxOnOam) {
      print("    note: an npx server reaches oam only once its package is on disk (managed");
      print("          tree or npx cache); until then the spawn stays on npx/node.");
    }
  }
  // Which VERSION each sidecar will run. An oam-hosted server runs a copy from
  // disk and cannot re-resolve "@latest" the way npx did, so the version is a
  // fact about this machine that nothing else reports.
  const { managed } = status;
  if (managed.packages.length > 0) {
    const anyInstalled = managed.packages.some((p) => p.version !== null);
    print(`  managed install: ${anyInstalled ? managed.root : "none -- run `yaw-mcp sidecars install`"}`);
    if (anyInstalled) {
      const widest = managed.packages.reduce((m, p) => Math.max(m, p.pkg.length), 0);
      for (const p of managed.packages) {
        // Says what was actually CHECKED. The old wording ("resolves from the
        // npx cache") asserted a lookup doctor never performs -- nothing here
        // reads any npx cache -- and was wrong whenever the package sits in no
        // cache either, which is the case that keeps the server on npx/node.
        //
        // The stale suffix is the registry check: oam cannot re-resolve
        // "@latest", so a pin only moves when `sidecars install` is re-run --
        // without this, "0.3.6" reads identically whether that is current or a
        // year old. Advisory like the UPGRADE AVAILABLE hint, never a warning.
        //
        // WHICH remedy the suffix names is conditional, because only one of
        // them can work, and there are three cases -- not two.
        //
        //   1. Skipped by the plan (an explicit pin or range). "re-run
        //      `yaw-mcp sidecars install`" is advice that cannot succeed: the
        //      generated manifest carries the same pin, npm reinstalls the
        //      same version, and the line reads identical next run. Name the
        //      plan's own reason instead.
        //   2. Eligible, refresher ON. The background check will move it
        //      unattended, so telling the user to run anything is busywork --
        //      and the previous wording did exactly that, because an eligible
        //      package is absent from refreshSkips and fell through to the
        //      generic manual remedy.
        //   3. Eligible, refresher OFF. Nothing automatic is coming, so the
        //      manual remedy is the true one.
        //
        // The skip reason comes from buildRefreshPlan so this report and the
        // refresher cannot disagree about what is going to happen.
        const refreshSkip = status.refreshSkips.get(p.pkg);
        const remedy =
          refreshSkip ??
          (status.refreshDisabled
            ? "re-run `yaw-mcp sidecars install` (background refresh is off)"
            : "the daily background refresh will update it");
        const staleNote = p.stale && p.latest !== null ? `  (latest ${p.latest} -- ${remedy})` : "";
        print(`    ${p.pkg.padEnd(widest)}  ${p.version ?? "not in the managed tree"}${staleNote}`);
      }
      // The versions above can all be present and current and the tree still
      // unusable HERE: npm resolved native bindings for the machine that ran
      // the install, and the tree is keyed on HOME alone (see
      // installedPlatform in sidecars-cmd.ts).
      if (managed.platformMismatch && managed.installedFor !== null) {
        print(
          `    ! installed on ${managed.installedFor.platform}/${managed.installedFor.arch}; this process is ${process.platform}/${process.arch}.`,
        );
        print("      Native bindings resolve for the installing machine, so these packages can fail");
        print("      at spawn here -- re-run `yaw-mcp sidecars install` on this machine.");
      }
    }
  }
  print("");
}

// PROJECT GUIDE section — printed ONLY when a project-scoped YAW-MCP.md is
// being served from a directory whose bundles.json is not approved. An
// approved (or absent) project guide is silent, matching the
// silence-on-empty convention of the reliability / trials sections.
function renderProjectGuideSection(opts: { guide: GuideFile | null; print: (s?: string) => void }): void {
  const notice = projectGuideNotice(opts.guide);
  if (!notice) return;
  opts.print("PROJECT GUIDE");
  // Same `  ! ` shape as the WARNINGS section so it reads as a flag, even
  // though it deliberately does not feed the exit code.
  opts.print(`  ! ${notice}`);
  opts.print("");
}

// Prints the STATE section. Broken out so the control flow in
// runDoctor stays linear — this is already the third file-reading
// section (config, client probes, history scan).
function renderStateSection(opts: {
  filePath: string;
  disabled: boolean;
  /** State loaded once by collectStateStatus, or null. Null does NOT mean
   *  "persistence is disabled": it is also null when the peek says the file
   *  is missing, malformed, an unreadable version, or unreadable at all --
   *  only an "ok" peek is loaded. Read `disabled` / `peek` for which of those
   *  it is. */
  persisted: Awaited<ReturnType<typeof loadState>> | null;
  /** Peek result from collectStateStatus, so state.json is not re-read. */
  peek: StatePeek | null;
  print: (s?: string) => void;
}): void {
  const { filePath, disabled, persisted, peek, print } = opts;
  print("STATE");
  if (disabled || !peek) {
    if (disabled) print("  status: disabled via YAW_MCP_DISABLE_PERSISTENCE");
    print("");
    return;
  }
  print(`  path:   ${filePath}`);
  if (peek.kind === "malformed") {
    print("  status: corrupt -- file exists but JSON is unparseable");
    print(`  fix:    \`yaw-mcp reset-learning\` to clear, or open ${filePath} and fix by hand`);
    print(`  detail: ${peek.message}`);
    print("");
    return;
  }
  if (peek.kind === "stale-version") {
    print(`  status: schema mismatch (file is v${peek.version ?? "?"}, this yaw-mcp reads v${peek.expected})`);
    print("  fix:    `yaw-mcp reset-learning` to drop the old file -- learning will rebuild on use");
    print("");
    return;
  }
  if (peek.kind === "unreadable") {
    print(`  status: unreadable (${peek.message})`);
    print("");
    return;
  }
  // persisted can still be null here even though the malformed / stale-version
  // / unreadable peeks returned above: collectStateStatus only loads state on
  // an "ok" peek, so a MISSING file arrives as null. That is the same thing to
  // a reader as a file that exists but has never been saved, and both take
  // the "no persisted state yet" line below.
  if (!persisted || persisted.savedAt === 0) {
    print("  (no persisted state yet -- will be created on the first tool call)");
  } else {
    print(`  last saved:           ${formatRelativeAge(Date.now() - persisted.savedAt)} ago`);
    print(`  learning entries:     ${Object.keys(persisted.learning).length}`);
    print(`  pack history entries: ${persisted.packHistory.length}`);
  }
  print("");
}

type StatePeek =
  | { kind: "missing" }
  | { kind: "ok" }
  | { kind: "malformed"; message: string }
  | { kind: "stale-version"; version: unknown; expected: number }
  | { kind: "unreadable"; message: string };

async function peekStateFile(filePath: string): Promise<StatePeek> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "unreadable", message: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown;
  try {
    // Same BOM strip loadState applies (persistence.ts), so a Notepad-saved
    // state.json is not reported malformed by doctor while loading fine.
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    return { kind: "malformed", message: err instanceof Error ? err.message : String(err) };
  }
  // Arrays are typeof "object" too. Without the explicit test a top-level
  // `[]` slipped through to the version check below and was reported as
  // "schema mismatch (file is v?)" -- the fix for which (`reset-learning`)
  // happens to be right, for a reason the line did not give. Same guard
  // classifyProbeContent applies to a client config.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed", message: "top-level value is not an object" };
  }
  const version = (parsed as { version?: unknown }).version;
  // Readable, not identical. STATE_SCHEMA_VERSION went 1 -> 2 for the
  // additive toolCache field, and loadState MIGRATES a v1 file rather than
  // discarding it -- so an exact-equality check here would report a healthy
  // v1 file as "stale-version" for the one session before its first save
  // rewrites it at v2, while learning and packHistory were loading fine.
  if (!isReadableStateVersion(version)) {
    return { kind: "stale-version", version, expected: STATE_SCHEMA_VERSION };
  }
  return { kind: "ok" };
}

/** One-line explanation for a non-ok peek, for the --json state.detail
 *  field. The text path prints the same facts as `detail:` / `status:`
 *  lines; this keeps the two surfaces carrying the same information. */
function statePeekDetail(peek: StatePeek): string | null {
  if (peek.kind === "malformed" || peek.kind === "unreadable") return peek.message;
  if (peek.kind === "stale-version") {
    return `file is v${String(peek.version ?? "?")}, this yaw-mcp reads v${peek.expected}`;
  }
  return null;
}

// Roll up the flaky-dormant list from persisted state.json. Mirrors the
// cross-session reliability block in mcp_connect_health so the CLI
// diagnostic and the LLM-facing health tool agree on what counts as
// flaky. Silently omitted when persistence is disabled or nothing
// qualifies — no point printing an empty header.
function renderReliabilitySection(opts: {
  disabled: boolean;
  /** State loaded once by the caller, or null. Null covers persistence being
   *  disabled AND every unusable-file case (missing, malformed, unreadable
   *  version, unreadable), which is why the guard below tests `persisted`
   *  rather than trusting `disabled` alone. */
  persisted: Awaited<ReturnType<typeof loadState>> | null;
  print: (s?: string) => void;
}): void {
  const { disabled, persisted, print } = opts;
  if (disabled || !persisted) return;
  if (persisted.savedAt === 0) return;

  const entries = Object.entries(persisted.learning).map(([namespace, usage]) => ({ namespace, usage }));
  const flaky = selectFlakyNamespaces(entries, 5);
  if (flaky.length === 0) return;

  print("RELIABILITY (dormant, <80% success)");
  const now = Date.now();
  for (const { namespace, usage } of flaky) {
    const rate = Math.round((usage.succeeded / usage.dispatched) * 100);
    const age = formatRelativeAge(now - usage.lastUsedAt);
    print(`  ${namespace} -- ${usage.dispatched} calls, ${rate}% success, last used ${age} ago`);
  }
  print("");
}

// Trials section — runs the expired-trial GC pass first (peels each
// expired entry out of its client config + deletes the marker), then
// renders the still-live trials
// with their countdown. Section is OMITTED when there are no trials
// at all so healthy installs stay quiet. Mirrors the silence-on-empty
// convention of the reliability and background-posters sections.
async function renderTrialsSection(opts: {
  home: string;
  print: (s?: string) => void;
  now?: () => number;
}): Promise<string[]> {
  const { home, print, now } = opts;
  // Scan once, then hand the scan to the GC pass (GC only unlinks expired
  // markers, so live/malformed here match the post-sweep readout state).
  const scan = await scanTrials({ home, now });
  const gc = await gcExpiredTrials({ home, now, scan }).catch(() => ({
    cleared: 0,
    failed: 0,
    failures: [],
  }));
  // The failures are part of the visibility predicate AND are returned as
  // warnings: an expired trial the sweep could not finish used to vanish
  // from this section entirely (the sweep logged it at debug and doctor
  // said "All good"). Returning them lets the text path fold them into
  // config.warnings exactly like the --json path, so both surfaces exit 2
  // for the same state.
  const warnings = gc.failures.map(trialGcFailureWarning);
  if (scan.live.length === 0 && gc.cleared === 0 && gc.failed === 0 && scan.malformed.length === 0) return warnings;
  print("TRIALS (yaw-mcp try)");
  if (gc.cleared > 0) {
    print(`  swept ${gc.cleared} expired trial${gc.cleared === 1 ? "" : "s"} this run`);
  }
  if (gc.failed > 0) {
    // The per-failure detail is a WARNING -- the caller folds `warnings` into
    // config.warnings, and the WARNINGS block prints each one -- so it is
    // printed THERE, once, like the trust and bundle warnings. This section
    // used to print the same line as well, so every un-finishable trial
    // appeared twice in the report. Say how many here and point at the block
    // that carries the detail.
    print(`  ${gc.failed} expired trial${gc.failed === 1 ? "" : "s"} could not be swept -- see WARNINGS`);
  }
  for (const { marker, msUntilExpiry } of scan.live) {
    print(`  ${marker.slug} -> ${marker.clientName} (${marker.clientPath}) -- expires in ${formatTtl(msUntilExpiry)}`);
  }
  for (const path of scan.malformed) {
    print(`  ! malformed marker at ${path} (delete by hand)`);
  }
  print("");
  return warnings;
}

// Compact relative age for STATE output. We'd rather show "3m" than a
// raw millisecond count; finer granularity isn't useful when the file
// is only written after a 1s debounce.
export function formatRelativeAge(ms: number): string {
  const clamped = Math.max(0, ms);
  const s = Math.floor(clamped / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function schemaSuffix(f: LoadedConfigFile): string {
  if (f.version === undefined) return "";
  if (f.version > CURRENT_SCHEMA_VERSION)
    return ` (schema v${f.version}, this yaw-mcp supports v${CURRENT_SCHEMA_VERSION})`;
  return ` (schema v${f.version})`;
}

/** One-line status string for the CLIENTS section of doctor output.
 *  Centralises the per-state wording so the renderer in `runDoctor`
 *  doesn't carry a nested ternary tree as more states get added. */
function renderClientStatus(c: ClientProbeResult, installCmd: string): string {
  if (c.unavailable) return "unavailable on this OS";
  // A READ failure, named as one. It used to fall into the malformed line
  // below and send the user hunting for a syntax error in a file that is a
  // directory, or that the process simply cannot open. No install hint: on
  // the shapes that produce this (EISDIR, EACCES) `install` cannot write the
  // file either, and on the transient one (win32 EBUSY) nothing needs fixing.
  if (c.unreadable !== null) {
    // The transient shape gets no "check its permissions": there is nothing
    // to check, the file is fine and the next read succeeds. It also raises
    // no warning -- see clientCannotLaunch -- so this line is the only place
    // the contention is reported at all.
    if (isTransientRead(c)) {
      return `exists but could not be read just now (${c.unreadable}) -- another process holds it; rerun doctor`;
    }
    return `exists but could not be read (${c.unreadable}) -- check the file and its permissions, then rerun doctor`;
  }
  if (c.malformed) return "exists but JSON is malformed -- fix or rerun `yaw-mcp install`";
  // Checked BEFORE the combined legacy branch: a launch command that no longer
  // exists is the one state that means the client cannot start yaw-mcp AT ALL,
  // and the combined branch used to swallow it -- a config carrying both a
  // legacy entry and a rotted absolute command reported "OK" and told the user
  // to remove the OTHER entry, leaving only the broken one. When both are true
  // the legacy trim hint is appended rather than dropped, so neither problem
  // goes unnamed.
  //
  // Hoisted above all THREE cannot-launch branches, not just the first: a
  // bare `oam` command (or a rotted oam entry file) plus a legacy entry used
  // to report only the launch problem, so fixing it took two doctor runs --
  // the legacy hint only appeared once the first fault was gone. All three
  // states mean "cannot start", so all three carry the same trim hint.
  const legacy = c.hasLegacyEntry
    ? `; legacy "${c.legacyEntryName}" entry also present -- remove it once the working entry is back`
    : "";
  if (c.launchCommandMissing) {
    return `has "${ENTRY_NAME}" entry, but its launch command does not exist: ${c.launchCommandMissing} -- the client cannot start yaw-mcp; rerun \`${installCmd}\`${legacy}`;
  }
  // Both oam-specific states below are "the entry looks fine and will not
  // start", so they rank with launchCommandMissing rather than with the OK
  // branches -- reporting "OK (runs on oam)" for either is the wrong answer.
  if (c.launchOamEntryMissing) {
    return `has "${ENTRY_NAME}" entry running on oam, but its entry file does not exist: ${c.launchOamEntryMissing} -- oam cannot fetch it on demand the way npx would; rerun \`${installCmd}\`${legacy}`;
  }
  if (c.launchOamNotAbsolute) {
    return `has "${ENTRY_NAME}" entry with a bare "${c.launchOamNotAbsolute}" command -- it resolves against the client's PATH, which a GUI-launched client does not inherit from your shell; rerun \`${installCmd}\` to write an absolute path, or set OAM_BIN${legacy}`;
  }
  // Below the cannot-launch branches and above the OK ones: doctor knows
  // neither. The path is absolute on the OS the entry was written for, and
  // that OS is not this one, so the exists / bare-oam checks were not run
  // (see isForeignAbsoluteLaunch). Reporting OK would claim a check that did
  // not happen; reporting broken would flag a Windows profile as seen from
  // WSL for being a Windows profile.
  if (c.launchForeignPath) {
    return `has "${ENTRY_NAME}" entry${c.launchRuntime === "oam" ? " (runs on oam)" : ""} whose launch path is for another OS: ${c.launchForeignPath} -- not verified from here${c.hasLegacyEntry ? `; legacy "${c.legacyEntryName}" entry also present -- remove it to avoid running yaw-mcp twice` : ""}`;
  }
  if (c.hasMcpEntry && c.hasLegacyEntry) {
    return `OK -- has "${ENTRY_NAME}" entry${c.launchRuntime === "oam" ? " (runs on oam)" : ""}; legacy "${c.legacyEntryName}" entry also present -- remove it to avoid running yaw-mcp twice`;
  }
  if (c.hasMcpEntry) {
    return `OK -- has "${ENTRY_NAME}" entry${c.launchRuntime === "oam" ? " (runs on oam)" : ""}`;
  }
  if (c.hasLegacyEntry) {
    return `legacy "${c.legacyEntryName}" entry present -- run \`${installCmd}\` to migrate, then remove the legacy entry by hand`;
  }
  if (c.exists) return `present, no "${ENTRY_NAME}" entry -- run \`${installCmd}\``;
  return `not configured -- run \`${installCmd}\``;
}

interface ProbeOptions {
  home: string;
  os: InstallOS;
  cwd: string;
  /** Windows %APPDATA% override, threaded to resolveInstallPath so the
   *  claude-desktop path stays inside a test's synthetic home. Derived from
   *  home at the call sites whenever home itself is overridden -- without
   *  it, a home override was NOT hermetic for the one client that lives
   *  under %APPDATA% on Windows. */
  appData?: string;
  /** Claude Code's `CLAUDE_CONFIG_DIR`. When set, claude-code probes hit
   *  `<DIR>/.claude.json` instead of `<HOME>/.claude.json` so doctor and
   *  `yaw-mcp install --list` see the same file Claude Code reads. */
  claudeConfigDir?: string;
  /** Path semantics for the launch checks: which `isAbsolute` an entry's
   *  command is judged by, and whether a drive-letter path is foreign (see
   *  isForeignAbsoluteLaunch). Defaults to process.platform -- what the
   *  machine running the probe actually resolves paths with -- and is a seam
   *  so the WSL-reads-a-Windows-profile branches run from a Windows box and
   *  the native-drive-letter branch from POSIX, instead of each being tested
   *  only where it happens to be native. Distinct from `os`, which picks the
   *  client LAYOUT to inspect, not the path semantics of the inspector. */
  platform?: NodeJS.Platform;
  /** Test seam: replaces the config-file read. Synchronous on purpose, so
   *  the one hook serves probeClients (sync) and probeClientsAsync alike.
   *  It is the only way to produce a transient EBUSY / EAGAIN read
   *  deterministically -- a directory at the path gives EISDIR, a chmod
   *  gives EACCES, but nothing a test can arrange holds a handle at just the
   *  right moment. Production never sets it. */
  readClientConfig?: (path: string) => string;
}

/** One (client, scope) probe slot: the result skeleton plus, when a config
 *  file is actually on disk, the read the caller still has to perform.
 *  `read` is null for unavailable clients and for missing files — those
 *  results are already final. */
interface ProbeSlot {
  result: ClientProbeResult;
  read: { path: string; containerPath: string[] } | null;
}

/** The content-derived part of a ClientProbeResult -- everything a slot does
 *  not already know before its file is read. The empty skeleton and
 *  classifyProbeContent are both typed against it, so a field added to
 *  ClientProbeResult that neither sets is a compile error rather than an
 *  `undefined` in the --json blob. */
type ProbeClassification = Omit<ClientProbeResult, "clientId" | "scope" | "path" | "exists" | "unavailable">;

// The "nothing found" probe skeleton, in ONE place. classifyProbeContent
// returns this shape from four separate exits (empty file, non-object JSON,
// missing container, parse throw) and enumerateProbeSlots spreads it into
// both of its result literals; spelled out at each one, a newly-added
// ClientProbeResult field only had to be forgotten at a single site to read
// as `undefined` there while every other exit reported it properly.
const EMPTY_PROBE: Readonly<ProbeClassification> = {
  hasMcpEntry: false,
  hasLegacyEntry: false,
  legacyEntryName: null,
  malformed: false,
  unreadable: null,
  unreadableCode: null,
  launchCommandMissing: null,
  launchRuntime: null,
  launchOamNotAbsolute: null,
  launchOamEntryMissing: null,
  launchForeignPath: null,
};

const MALFORMED: Readonly<ProbeClassification> = { ...EMPTY_PROBE, malformed: true };

/** What a slot reports when its config file's BYTES could not be read.
 *  Distinct from MALFORMED on purpose: both probes used to wrap the read AND
 *  the classification in one catch that assigned MALFORMED, but
 *  classifyProbeContent has its own catch for parse failures, so that outer
 *  catch only ever saw READ errors -- and reported a directory at
 *  ~/.claude.json, or a transient win32 EBUSY, as "JSON is malformed". */
function unreadableProbe(err: unknown): ProbeClassification {
  // The errno rides along as its own field: the exit-code gate keys the
  // transient / real split on it (isTransientRead), and node's message
  // wording is not a stable thing to grep.
  const code = (err as { code?: unknown } | null)?.code;
  return {
    ...EMPTY_PROBE,
    unreadable: err instanceof Error ? err.message : String(err),
    unreadableCode: typeof code === "string" ? code : null,
  };
}

/** Enumerate every (client, scope) combo for the current OS and resolve its
 *  config path. Shared by the sync and async probe variants so the client
 *  walk, the path resolution and the result shape live in exactly one place —
 *  the two used to be ~55-line copy-paste twins that could silently drift. */
function* enumerateProbeSlots(opts: ProbeOptions): Generator<ProbeSlot> {
  for (const target of INSTALL_TARGETS) {
    if (!target.availableOn.includes(opts.os)) {
      yield {
        result: {
          clientId: target.clientId,
          scope: target.scopes[0].scope,
          path: "(n/a)",
          exists: false,
          unavailable: true,
          ...EMPTY_PROBE,
        },
        read: null,
      };
      continue;
    }
    // Probe each scope the client supports. For user scope we always
    // know the path; for project/local we use cwd (typical: the user
    // ran doctor inside the repo they care about).
    for (const scope of target.scopes) {
      let resolved: ReturnType<typeof resolveInstallPath>;
      try {
        resolved = resolveInstallPath({
          clientId: target.clientId,
          scope: scope.scope,
          os: opts.os,
          home: opts.home,
          appData: opts.appData,
          projectDir: scope.requiresProjectDir ? opts.cwd : undefined,
          claudeConfigDir: opts.claudeConfigDir,
        });
      } catch {
        // resolveInstallPath throws when project is required but missing —
        // shouldn't happen here since we always pass cwd, but defensive.
        continue;
      }
      const exists = existsSync(resolved.absolute);
      yield {
        result: {
          clientId: target.clientId,
          scope: scope.scope,
          path: resolved.absolute,
          exists,
          unavailable: false,
          ...EMPTY_PROBE,
        },
        read: exists ? { path: resolved.absolute, containerPath: resolved.containerPath } : null,
      };
    }
  }
}

function probeClients(opts: ProbeOptions): ClientProbeResult[] {
  const out: ClientProbeResult[] = [];
  const readConfig = opts.readClientConfig ?? ((p: string): string => readFileSync(p, "utf8"));
  const platform = opts.platform ?? process.platform;
  for (const { result, read } of enumerateProbeSlots(opts)) {
    if (read) {
      // The READ is caught on its own, and the classification is not caught
      // here at all -- it catches its own parse failures. See unreadableProbe
      // for why the two must not share a catch.
      let raw: string | null = null;
      try {
        raw = readConfig(read.path);
      } catch (err) {
        Object.assign(result, unreadableProbe(err));
      }
      if (raw !== null) Object.assign(result, classifyProbeContent(raw, read.containerPath, existsSync, platform));
    }
    out.push(result);
  }
  return out;
}

/** Walk a JSON-key path to the mcpServers/servers container.
 *  Returns the object at the path, or null if any segment is missing/non-object. */
function walkContainer(root: Record<string, unknown>, path: string[]): Record<string, unknown> | null {
  let cur: unknown = root;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return null;
  return cur as Record<string, unknown>;
}

/**
 * The oam a launch entry ultimately runs and the argv it runs it with, with
 * any shell wrapper peeled off -- or null when this entry is not an oam launch
 * we can read.
 *
 * `oam` is the token the client will actually resolve (`"oam"`, `"oam.exe"`,
 * an absolute path), which inside a wrapper is NOT `command`: the bare-oam
 * check in classifyProbeContent used to test `command` alone, so
 * `cmd /d /s /c oam run ...` -- which isOamLaunch accepts and which resolves
 * against the GUI client's PATH exactly like a bare `"command": "oam"` --
 * read as "OK (runs on oam)". `rest` is what oamRunEntryPath scans.
 *
 * DELIBERATE DUPLICATION of the unwrap in `isOamLaunch` (oam-spawn.ts). That
 * function answers "is this oam?" and throws the unwrapped tokens away;
 * everything after the wrapper is what THIS needs. The two must stay in step:
 * `isOamLaunch` is what sets `launchRuntime === "oam"`, so any wrapper shape it
 * starts accepting has to be added here too, or the entry scan below falls back
 * to reading the wrapper's own switches as an oam path.
 */
function oamArgvTokens(command: string, args: readonly string[]): { oam: string; rest: readonly string[] } | null {
  if (isOamCommand(command)) return { oam: command, rest: args };
  const base = command.split(/[\\/]/).pop() ?? command;

  if (/^cmd(\.exe)?$/i.test(base)) {
    // cmd's payload is separate argv entries after its own switches, and the
    // everyday shape is `/d /s /c` (what npm emits), not just `/c`. Matching
    // "slash + ONE letter" keeps a POSIX path like /usr/local/bin/oam out of
    // the switch set.
    const i = args.findIndex((a) => !/^\/[a-z]$/i.test(a));
    if (i < 0 || !isOamCommand(args[i])) return null;
    return { oam: args[i], rest: args.slice(i + 1) };
  }

  if (/^(sh|bash|zsh|dash)$/i.test(base)) {
    // A POSIX shell carries the whole command as one string after -c, so the
    // payload has to be tokenised on whitespace.
    const dashC = args.indexOf("-c");
    const payload = dashC >= 0 ? args[dashC + 1] : args[0];
    if (payload === undefined) return null;
    // A quote anywhere in the payload means whitespace tokenising can cut a
    // path in half, and half a path fails the exists() check below -- doctor
    // would report a healthy entry as missing. Under-reporting is the safe
    // direction here (isOamLaunch takes the same position), so bail instead.
    if (/["']/.test(payload)) return null;
    const tokens = payload.trim().split(/\s+/);
    if (tokens[0] === undefined || !isOamCommand(tokens[0])) return null;
    return { oam: tokens[0], rest: tokens.slice(1) };
  }

  return null;
}

/** True when a launch command is an absolute path for ANOTHER operating
 *  system -- today, a drive-letter path (`C:\...\oam.exe`) seen by a doctor
 *  running on POSIX, which is what WSL reading a Windows profile looks like.
 *
 *  node:path answers for the RUNNING platform, so posix `isAbsolute` calls
 *  that path relative: the missing-command check skips it (fine) but the
 *  bare-oam check then flags it as "resolves against the client's PATH" --
 *  advice about PATH lookup for a path that is fully absolute on the OS the
 *  entry was written for. Neither check can be applied from here, so the
 *  entry is reported as unverifiable (ClientProbeResult.launchForeignPath)
 *  rather than as broken. On win32 a drive-letter path is native and takes
 *  the ordinary checks; a POSIX path seen from win32 is not detected here
 *  (win32 isAbsolute accepts it and existsSync answers for the local disk).
 *
 *  `platform` is the probe's path-semantics seam (ProbeOptions.platform),
 *  process.platform in production because that is what the machine doing the
 *  inspecting resolves paths with -- never the `os` option, which picks the
 *  client layout to inspect, not the path semantics of the inspector. */
export function isForeignAbsoluteLaunch(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32" && /^[A-Za-z]:[\\/]/.test(command);
}

/**
 * The entry file an `oam run` launch entry points at, or null when there is
 * nothing to check.
 *
 * Anchored on the `run` SUBCOMMAND rather than on "first non-flag arg in argv":
 * the raw argv can start with a wrapper's switches (`cmd /d /s /c ...`), and
 * picking args[1] off that shape yields `/s` -- which `isAbsolute` accepts on
 * both platforms and `existsSync` then rejects, reporting a working install as
 * broken. Anything that is not `<oam> [flags] run [flags] <entry>` returns null
 * and is simply not checked.
 *
 * Known limit: a flag taking a SEPARATE value after `run` (`run --profile x
 * entry.js`) would pick `x`. No such flag exists today -- install writes
 * `run --no-check <entry>` -- and the fallout is bounded to a spurious report
 * only if that value also looks like an absolute path that does not exist.
 */
export function oamRunEntryPath(command: string, args: readonly string[]): string | null {
  const unwrapped = oamArgvTokens(command, args);
  return unwrapped === null ? null : oamRunEntryFromTokens(unwrapped.rest);
}

/** The `run` half of oamRunEntryPath, over an already-unwrapped oam argv --
 *  so classifyProbeContent, which needs the unwrap's oam token as well, does
 *  not unwrap the same entry twice. */
function oamRunEntryFromTokens(tokens: readonly string[]): string | null {
  // Leading flags belong to oam itself; the first bare token is the subcommand.
  const sub = tokens.findIndex((t) => !t.startsWith("-"));
  if (sub < 0 || tokens[sub] !== "run") return null;
  return tokens.slice(sub + 1).find((t) => !t.startsWith("-")) ?? null;
}

/** Classify raw config file content for a probe result. Shared by both
 *  the sync and async probe variants so the parsing logic lives once.
 *
 *  `platform` picks the path semantics for every launch check below (see
 *  ProbeOptions.platform): node:path's bare `isAbsolute` is bound to the
 *  running platform, and with it the foreign-path branches could only ever
 *  execute on a POSIX runner and the native-drive-letter one only on win32
 *  -- so on a Windows-only maintainer box the WSL wiring here never ran. */
function classifyProbeContent(
  raw: string,
  containerPath: string[],
  exists: (p: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): ProbeClassification {
  const isAbsolute = platform === "win32" ? win32.isAbsolute : posix.isAbsolute;
  if (raw.trim().length === 0) {
    return { ...EMPTY_PROBE };
  }
  try {
    const parsed = parseJsonc(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ...MALFORMED };
    }
    const container = walkContainer(parsed as Record<string, unknown>, containerPath);
    if (!container) {
      return { ...EMPTY_PROBE };
    }
    const legacyEntryName = findLegacyEntry(container);
    const entry = container[ENTRY_NAME];
    let launchCommandMissing: string | null = null;
    let launchRuntime: "oam" | "node" | null = null;
    let launchOamNotAbsolute: string | null = null;
    let launchOamEntryMissing: string | null = null;
    let launchForeignPath: string | null = null;
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const command = (entry as { command?: unknown }).command;
      if (typeof command === "string") {
        const entryArgs = (entry as { args?: unknown }).args;
        // FILTERED to strings, not cast to them. A hand-edited config whose
        // args carry a number or a null parses fine, but every consumer below
        // (isOamLaunch, oamArgvTokens) calls string methods on each token --
        // so the old `as string[]` threw a TypeError into this function's outer
        // catch and reported a perfectly parseable file as "exists but JSON is
        // malformed", sending the user to fix a syntax error that isn't there.
        const args = Array.isArray(entryArgs) ? entryArgs.filter((a): a is string => typeof a === "string") : [];
        launchRuntime = isOamLaunch(command, args) ? "oam" : "node";
        if (isForeignAbsoluteLaunch(command, platform)) {
          // Written for another OS: none of the checks below can be applied
          // from here, and applying them anyway is what produced a "bare oam"
          // PATH warning for a fully absolute Windows path.
          launchForeignPath = command;
        } else {
          if (isAbsolute(command) && !exists(command)) launchCommandMissing = command;
          if (launchRuntime === "oam") {
            // Every oam-specific check reads the UNWRAPPED launch, not the raw
            // argv: launchRuntime is "oam" for the `cmd /d /s /c oam run ...`
            // and `sh -c "oam run ..."` shapes too, and on those `command` is
            // the wrapper and the raw argv's first non-flag token is the
            // wrapper's own switch. A null unwrap (a quoted `sh -c` payload,
            // which isOamLaunch still classifies) means nothing is checked --
            // under-reporting is the safe direction.
            const oamArgv = oamArgvTokens(command, args);
            if (oamArgv !== null) {
              // A BARE oam is the one shape the absolute-path check above
              // cannot see, and it is the shape older installs actually
              // wrote. It resolves against the CLIENT's PATH, not the shell's,
              // so a GUI-launched client (Claude Desktop from the Dock, Cursor
              // from Explorer) never finds an oam that lives in ~/.oam/bin --
              // the broker fails to start with no fallback. `install` no
              // longer writes this, but nothing rewrites the configs that
              // already carry it, so doctor is the only thing that can
              // surface it. Tested on the unwrapped token: a bare `oam`
              // reached through a wrapper resolves the same way and used to
              // read as "OK (runs on oam)".
              if (isForeignAbsoluteLaunch(oamArgv.oam, platform)) launchForeignPath = oamArgv.oam;
              else if (!isAbsolute(oamArgv.oam)) launchOamNotAbsolute = oamArgv.oam;
              // `oam run [--no-check] <entry>`: unlike npx, oam cannot fetch a
              // missing entry on demand, so a stale path here is a hard
              // launch failure rather than a slow start.
              const entryPath = oamRunEntryFromTokens(oamArgv.rest);
              if (entryPath !== null && isAbsolute(entryPath) && !exists(entryPath)) {
                launchOamEntryMissing = entryPath;
              }
            }
          }
        }
      }
    }
    return {
      hasMcpEntry: ENTRY_NAME in container,
      hasLegacyEntry: legacyEntryName !== null,
      legacyEntryName,
      malformed: false,
      unreadable: null,
      unreadableCode: null,
      launchCommandMissing,
      launchRuntime,
      launchOamNotAbsolute,
      launchOamEntryMissing,
      launchForeignPath,
    };
  } catch {
    // Parse failures only: the READ happens in the caller, under its own
    // catch (see unreadableProbe), so nothing but the parse can throw here.
    return { ...MALFORMED };
  }
}

// Async variant for code paths that prefer non-blocking I/O. Used by
// install-cmd.ts (runInstallList, for `yaw-mcp install --list`) and
// try-cmd.ts (autoDetectClient, picking a client for a trial) — both
// async contexts where the synchronous probeClients would block. Doctor
// itself uses the sync probeClients (it runs once, interactively).
export async function probeClientsAsync(opts: ProbeOptions): Promise<ClientProbeResult[]> {
  const out: ClientProbeResult[] = [];
  const platform = opts.platform ?? process.platform;
  for (const { result, read } of enumerateProbeSlots(opts)) {
    if (read) {
      // Same read-vs-classify split as probeClients; see unreadableProbe.
      // The (sync) read seam is honoured here too -- it exists to inject a
      // read failure, and only the default is the non-blocking read.
      let raw: string | null = null;
      try {
        raw = opts.readClientConfig ? opts.readClientConfig(read.path) : await readFile(read.path, "utf8");
      } catch (err) {
        Object.assign(result, unreadableProbe(err));
      }
      if (raw !== null) Object.assign(result, classifyProbeContent(raw, read.containerPath, existsSync, platform));
    }
    out.push(result);
  }
  return out;
}

// Doctor's abort budget for the freshness probe, deliberately SHORTER than
// upgrade-cmd's 3000ms default.
//
// The asymmetry is the requirement, not an oversight. `upgrade` exists to answer
// "is there a newer version"; it has nothing at all to print until the registry
// replies, so waiting longer is strictly better there. Doctor's freshness line
// is one of ~20 checks, and every other one is local and instant -- a firewalled
// or black-holed registry that stalls the whole report is a worse outcome than
// an UPGRADE AVAILABLE banner that stays silent for one run. Doctor must not
// hang.
//
// The cost of the shorter budget, stated plainly: on a registry slow enough to
// answer between 2s and 3s, doctor reports nothing while `upgrade` would have
// reported an available upgrade. That is the intended trade, and it is why this
// is a parameter of the shared probe rather than a second implementation --
// upgrade-cmd's `fetchLatestVersion` owns the URL, the response validation and
// the failure-to-null semantics for all three callers, and only the number
// differs here.
const DOCTOR_REGISTRY_TIMEOUT_MS = 2000;

export interface ShadowHit {
  cli: string;
  count: number;
  namespaces: string[];
}

// How many lines from the tail of each history file we examine. 500 is
// long enough to catch a day or two of normal terminal usage without
// loading massive archives into memory. History files grow unbounded
// on many setups — reading the whole thing would be wasteful here.
const SHELL_HISTORY_TAIL_LINES = 500;

// Hard cap on the BYTES read from the end of each history file. This is what
// makes the memory claim above true: readTailLines seeks to `size - this` and
// reads forward, so a 400 MB PSReadLine archive costs one 256 KB buffer rather
// than the whole file (plus a full line array) per doctor run. 256 KB holds
// far more than 500 lines of any realistic history, so the line cap above is
// still the binding limit in practice.
const SHELL_HISTORY_TAIL_BYTES = 256 * 1024;

/** Scan recent bash / zsh / PowerShell history for commands that an
 *  MCP server shadows. Returns a sorted (count desc) list of hits.
 *  Any I/O error on a history file is swallowed — this is purely
 *  diagnostic, never fatal. */
export function scanShellHistoryForShadows(opts: { home: string; env: NodeJS.ProcessEnv }): ShadowHit[] {
  const shadowMap = cliToNamespaces();
  const counts = new Map<string, number>();

  for (const source of shellHistorySources(opts)) {
    const lines = readTailLines(source.path, SHELL_HISTORY_TAIL_LINES);
    for (const raw of lines) {
      const cmd = source.extractCommand(raw);
      if (!cmd) continue;
      const binary = extractLeadingBinary(cmd);
      if (!binary) continue;
      if (!shadowMap.has(binary)) continue;
      counts.set(binary, (counts.get(binary) ?? 0) + 1);
    }
  }

  const hits: ShadowHit[] = [];
  for (const [cli, count] of counts) {
    const namespaces = shadowMap.get(cli) ?? [];
    hits.push({ cli, count, namespaces });
  }
  hits.sort((a, b) => b.count - a.count);
  return hits;
}

interface ShellHistorySource {
  path: string;
  /** Given a raw line, return the command or null to skip. */
  extractCommand: (line: string) => string | null;
}

function shellHistorySources(opts: { home: string; env: NodeJS.ProcessEnv }): ShellHistorySource[] {
  const sources: ShellHistorySource[] = [];
  const plain = (l: string): string | null => l.trim() || null;
  // HISTFILE wins for bash: a user who relocated history (a shared dotfiles
  // setup, `HISTFILE=~/.cache/bash_history`) has an EMPTY ~/.bash_history, so
  // hardcoding the default path silently reported zero shadowed commands for
  // exactly the users who customise their shell the most. opts.env is already
  // threaded in for APPDATA below; this just uses it.
  sources.push({ path: opts.env.HISTFILE || join(opts.home, ".bash_history"), extractCommand: plain });
  sources.push({
    path: join(opts.home, ".zsh_history"),
    // Zsh extended-history lines look like `: 1700000000:0;npm audit`.
    // Strip the metadata prefix so we get just the command.
    extractCommand: (l) => {
      const trimmed = l.trim();
      if (!trimmed) return null;
      if (trimmed.startsWith(":")) {
        const semi = trimmed.indexOf(";");
        return semi === -1 ? null : trimmed.slice(semi + 1);
      }
      return trimmed;
    },
  });
  const appData = opts.env.APPDATA;
  if (appData) {
    sources.push({
      path: join(appData, "Microsoft", "Windows", "PowerShell", "PSReadLine", "ConsoleHost_history.txt"),
      extractCommand: plain,
    });
  }
  // PowerShell 7+ on macOS / Linux. PSReadLine writes the same
  // one-command-per-line file, just under the XDG data dir instead of
  // %APPDATA% -- gating the ONLY pwsh source on APPDATA meant a pwsh-primary
  // mac or Linux user got an empty SHADOWED CLI USAGE section.
  const xdgData = opts.env.XDG_DATA_HOME || join(opts.home, ".local", "share");
  sources.push({
    path: join(xdgData, "powershell", "PSReadLine", "ConsoleHost_history.txt"),
    extractCommand: plain,
  });
  // fish. Its history is a YAML-ish record per command:
  //   - cmd: npm audit
  //     when: 1700000000
  // Only the `- cmd:` lines carry a command; `when:`/`paths:` continuation
  // lines are skipped. Escapes inside the value (fish writes `\n` for an
  // embedded newline) are left alone: extractLeadingBinary only ever looks at
  // the FIRST word, which is never the escaped part.
  sources.push({
    path: join(xdgData, "fish", "fish_history"),
    extractCommand: (l) => {
      const trimmed = l.trim();
      if (!trimmed.startsWith("- cmd:")) return null;
      return trimmed.slice("- cmd:".length).trim() || null;
    },
  });
  // Dedupe by resolved path. The sources overlap the moment a user points
  // HISTFILE at a file another entry already names -- `export
  // HISTFILE=$HOME/.zsh_history` is the canonical case -- and
  // scanShellHistoryForShadows then counted every command in that file TWICE,
  // inflating the SHADOWED CLI USAGE counts and pushing a CLI over the
  // reporting threshold on half the real invocations.
  //
  // LAST entry wins, not the first. The duplicate is always HISTFILE (pushed
  // first, with the line-is-the-command `plain` reader) colliding with a
  // format-specific entry below it. Keeping the first would dedupe correctly
  // and then MIS-PARSE the file: zsh writes `: 1700000000:0;npm audit`, whose
  // leading binary under `plain` is `:`, so the count would silently go to
  // zero instead of double. The later entry is the one that knows the format.
  const lastIndex = new Map<string, number>();
  sources.forEach((s, i) => {
    // Keyed on the case-folded spelling (win32 / darwin), not the byte-exact
    // resolve() output: a HISTFILE that names ~/.zsh_history in a different
    // case is the same file on those platforms and used to be counted twice.
    lastIndex.set(normalizeForCompare(resolve(s.path)), i);
  });
  return sources.filter((s, i) => lastIndex.get(normalizeForCompare(resolve(s.path))) === i);
}

/** Read at most the last `n` lines of a file, reading at most
 *  SHELL_HISTORY_TAIL_BYTES from the END of it rather than the whole file.
 *
 *  The whole-file read this replaces made the "without loading massive
 *  archives into memory" claim above false: it allocated the entire file PLUS
 *  a line array for every one of the three sources on every doctor run, and on
 *  a multi-hundred-MB history readFileSync throws ERR_STRING_TOO_LONG -- which
 *  the catch swallowed, so the SHADOWED CLI section silently disappeared with
 *  no diagnostic. Any I/O error still yields [] (purely diagnostic section).
 */
function readTailLines(path: string, n: number): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = size > SHELL_HISTORY_TAIL_BYTES ? size - SHELL_HISTORY_TAIL_BYTES : 0;
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    const got = readSync(fd, buf, 0, length, start);
    let text = buf.subarray(0, got).toString("utf8");
    if (start > 0) {
      // The window almost certainly opens mid-line, and its first bytes can be
      // the tail of a multi-byte character. Drop through the first newline so
      // only whole, correctly-decoded lines are parsed.
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    const all = text.split(/\r?\n/);
    // A newline-TERMINATED file (the normal shape for every history file we
    // read) makes split() yield a trailing "" that is not a line. Left in, it
    // consumed one of the n slots, so the documented 500-line window was
    // really 499 -- the oldest real line in the window was dropped for a
    // sentinel. Popping it first makes the constant mean what it says.
    if (all.length > 0 && all[all.length - 1] === "") all.pop();
    return all.length <= n ? all : all.slice(all.length - n);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do with a close failure on a read-only probe.
      }
    }
  }
}

// Pull the leading binary out of a shell command, stripping any
// leading env-var assignments (`FOO=bar CMD=quux cmd arg`), launcher
// wrappers (`sudo` / `env` / `nohup` / `nice` / ...), path-style
// invocations (`/usr/local/bin/npm` → `npm`) and a Windows executable
// suffix (`npm.cmd` → `npm`), and lowercasing the result (`NPM` → `npm`)
// so it matches the lowercase-keyed tables in cli-shadows.ts. Returns null
// for lines we can't confidently parse (pipes, command substitution,
// assignments only).
function extractLeadingBinary(command: string): string | null {
  let rest = command.trimStart();
  if (!rest) return null;
  // Drop leading control chars like `! ` (bang-prefixed history
  // references from bash shouldn't even land here, but defensive).
  if (rest.startsWith("!")) return null;
  // Strip leading env-var assignments AND wrapper prefixes, repeatedly:
  // real history lines stack them (`sudo time npm audit`, `sudo FOO=1 npm
  // ci`), and peeling exactly one wrapper left `time` as the "binary".
  // Both classes are handled in ONE loop so any interleaving works.
  // `env` / `nohup` / `nice` join the list for the same reason `sudo` is on
  // it: they are launchers, so `nohup npm ci` is an npm invocation and
  // reporting `nohup` (which no server shadows) just loses the hit.
  const prefixes = ["sudo", "time", "command", "exec", "env", "nohup", "nice"];
  for (;;) {
    const firstWord = rest.split(/\s+/)[0] ?? "";
    const isAssignment = /^[A-Z_][A-Z0-9_]*=/i.test(rest);
    if (!isAssignment && !prefixes.includes(firstWord)) break;
    // Advance past the first word by WHITESPACE, not a literal " ": a
    // tab-separated wrapper (`sudo<TAB>npm audit`) made indexOf(" ") skip
    // clean past `npm` to the space inside the args and report `audit` as the
    // binary. `\s` matches the tab the same as the space.
    const ws = /\s/.exec(rest);
    if (ws === null) return null;
    const next = rest.slice(ws.index).trimStart();
    // Defensive: a line of pure separators can't shrink further.
    if (next === rest || next.length === 0) return null;
    rest = next;
  }
  const first = rest.split(/\s+/)[0];
  if (!first) return null;
  // Reject pipes, redirects, subshells, empty assignments.
  if (/[|&;<>()`$]/.test(first)) return null;
  // Strip path prefix — we match on the binary name.
  const slash = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\"));
  const name = slash === -1 ? first : first.slice(slash + 1);
  // Strip a Windows executable suffix, then lowercase. PowerShell / cmd
  // history records what the user typed, and on Windows that is routinely
  // `npm.cmd audit`, `gh.EXE pr list` or plain `NPM audit` -- none of which
  // matches the shadow map, whose keys are bare lowercase binary names and are
  // compared exactly. Both tables in cli-shadows.ts push that normalization
  // onto the caller, and this is the caller. Lowercasing the whole name (not
  // just the suffix) is safe because ShadowHit.cli is only displayed and
  // looked up, never executed.
  return name.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

// Version compare, delegated to oam-spawn's `compareVersions` -- the canonical
// implementation for the package.
//
// This used to be a local triple-only copy, and the duplication was not
// harmless: it read "0.8.3-rc.1" as EQUAL to a 0.8.3 floor, so doctor could
// report that a prerelease met a MIN_OAM_VERSION floor that oam-spawn (which
// implements real prerelease precedence) ranks it BELOW. doctor printing one
// verdict while the spawn path acts on another is the failure this whole
// section exists to prevent, so the two must share one comparator.
//
// `compareVersions` is anchored and does NOT accept a leading "v"; the old copy
// did. That tolerance is preserved here rather than dropped, because these
// inputs include a version read from a package.json that a git-tag-shaped build
// can write as "v1.2.3", and silently returning 0 for it would suppress the
// upgrade banner instead of showing a wrong one. Unparseable still compares
// equal, so a weird version string cannot invent a false "upgrade available".
export function compareSemver(a: string, b: string): number {
  const strip = (s: string) => (s.startsWith("v") ? s.slice(1) : s);
  return compareVersions(strip(a), strip(b));
}
