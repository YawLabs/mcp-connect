// `mcph doctor` — prints a one-screen diagnostic of the user's mcph setup.
// Goal: when a support ticket comes in ("nothing is working"), the user
// pastes the doctor output and we can usually pinpoint the issue from
// it alone (no token / wrong token source / wrong API base / which
// clients have mcph wired up vs. don't / file permissions).
//
// The output is plain text so it survives Discord / Slack pasting.
// Tokens are always fingerprinted (first-8…last-4) — never raw.
//
// Exit codes:
//   0  healthy (token present, no warnings)
//   1  fatal   (no token resolvable — mcph won't start)
//   2  warnings (e.g., schema-version mismatch, loose file permissions)

import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AnalyticsFailure, getLastAnalyticsFailure } from "./analytics.js";
import { cliToNamespaces } from "./cli-shadows.js";
import {
  CURRENT_SCHEMA_VERSION,
  type LoadedConfigFile,
  type ResolvedConfig,
  loadMcphConfig,
  tokenFingerprint,
} from "./config-loader.js";
import {
  CURRENT_OS,
  ENTRY_NAME,
  INSTALL_TARGETS,
  type InstallClientId,
  type InstallOS,
  type InstallScope,
  resolveInstallPath,
} from "./install-targets.js";
import { parseJsonc } from "./jsonc.js";
import { userConfigDir } from "./paths.js";
import { STATE_FILENAME, STATE_SCHEMA_VERSION, loadState } from "./persistence.js";
import { type ReportFailure, getLastReportFailure } from "./tool-report.js";
import { selectFlakyNamespaces } from "./usage-hints.js";

export interface DoctorOptions {
  cwd?: string;
  home?: string;
  os?: InstallOS;
  env?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to process.stdout.write. */
  out?: (s: string) => void;
  /** Disable the npm registry freshness check (tests, offline use). */
  skipRegistryCheck?: boolean;
  /** Test hook: return the latest-version string for @yawlabs/mcph. */
  registryFetch?: () => Promise<string | null>;
  /** Emit a single JSON blob instead of the human-readable text report. */
  json?: boolean;
}

// Machine-readable shape emitted by `mcph doctor --json`. Mirrors the
// text sections 1:1 so support / dashboard consumers can pick fields
// with jq. The raw token is NEVER included — only its fingerprint.
export interface DoctorJsonSnapshot {
  timestamp: string;
  version: string;
  platform: InstallOS;
  token: { fingerprint: string; source: string };
  apiBase: { value: string; source: string };
  loadedFiles: Array<{ scope: string; path: string; schemaVersion?: number; schemaAhead: boolean }>;
  warnings: string[];
  env: Record<string, string | null>;
  state: {
    disabled: boolean;
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
  upgrade: { current: string; latest: string | null; stale: boolean };
  diagnosis: { exitCode: number; summary: string };
}

export interface ClientProbeResult {
  clientId: InstallClientId;
  scope: InstallScope;
  path: string;
  exists: boolean;
  hasMcphEntry: boolean;
  malformed: boolean;
  unavailable: boolean;
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

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorResult> {
  if (opts.json) return runDoctorJson(opts);

  const lines: string[] = [];
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const print = (s = ""): void => {
    lines.push(s);
    write(`${s}\n`);
  };

  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const os = opts.os ?? CURRENT_OS;
  const env = opts.env ?? process.env;

  print(`mcph doctor — ${new Date().toISOString()}`);
  print(`mcph version: ${VERSION}`);
  print(`platform: ${os}`);
  print("");

  const config = await loadMcphConfig({ cwd, home, env });

  print("CONFIG FILES");
  if (config.loadedFiles.length === 0) {
    print("  (none — using defaults + env)");
  } else {
    for (const f of config.loadedFiles) {
      print(`  ${f.scope.padEnd(7)} ${f.path}${schemaSuffix(f)}`);
    }
  }
  print("");

  print("TOKEN");
  print(`  value:  ${tokenFingerprint(config.token)}`);
  print(`  source: ${config.tokenSource}`);
  print("");

  print("API BASE");
  print(`  value:  ${config.apiBase}`);
  print(`  source: ${config.apiBaseSource}`);
  print("");

  // Behavior-modifier env vars that mcph actually reads at runtime.
  // Surfaced here so support diagnostics can see at a glance whether an
  // override is active (e.g., "my auto-load isn't working" — doctor
  // says AUTO_LOAD is not set). TOKEN / URL / DISABLE_PERSISTENCE have
  // their own dedicated sections and are intentionally omitted.
  renderEnvSection({ env, print });

  // Persisted cross-session state — ~/.mcph/state.json. Shows whether
  // persistence is disabled by env, and otherwise reports the file path
  // + how fresh the snapshot is + how much signal it carries.
  await renderStateSection({ home, env, print });

  // Reliability roll-up — pulls flaky namespaces from the same
  // state.json the STATE section introspected. Same definition as the
  // cross-session block in mcp_connect_health, so "flaky" means the
  // same thing whether you check via the LLM or via the CLI.
  await renderReliabilitySection({ home, env, print });

  // Background HTTP posters (analytics, tool-report) fire-and-forget by
  // design, but a 401/403 there means the user's token has lost write
  // scope and their analytics is silently disappearing. Latches in the
  // poster modules capture only the most recent rejection per module;
  // the section is rendered ONLY when at least one latch is set so
  // healthy installs stay quiet.
  renderBackgroundPostersSection({ print });

  // Probe every supported client/scope combo on the current OS. Honor
  // CLAUDE_CONFIG_DIR so doctor sees the same file Claude Code reads
  // when run inside a wrapper (Yaw Mode, dev container with the env set).
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : undefined;
  const clients = probeClients({ home, os, cwd, claudeConfigDir });
  print("INSTALLED CLIENTS (probed config files)");
  for (const c of clients) {
    const status = c.unavailable
      ? "unavailable on this OS"
      : c.malformed
        ? "exists but JSON is malformed — fix or rerun `mcph install`"
        : c.hasMcphEntry
          ? `OK — has "${ENTRY_NAME}" entry`
          : c.exists
            ? `present, no "${ENTRY_NAME}" entry — run \`mcph install ${c.clientId}${c.scope === "user" ? "" : ` --scope ${c.scope}`}\``
            : `not configured — run \`mcph install ${c.clientId}${c.scope === "user" ? "" : ` --scope ${c.scope}`}\``;
    const label = INSTALL_TARGETS.find((t) => t.clientId === c.clientId)?.label ?? c.clientId;
    print(`  ${label} (${c.scope}): ${status}`);
    print(`    ${c.path}`);
  }
  print("");

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
      print(`  ${hit.cli.padEnd(12)} ${hit.count} ${pluralHit} → server(s): ${hit.namespaces.join(", ")}`);
    }
    print("");
  }

  // Freshness check: is this binary behind the npm registry? Skip in
  // source ("dev") mode and absorb any network error silently — a
  // stale-version warning that depends on an external service must not
  // block the diagnostic. Times out after 2s to keep doctor snappy.
  // Auto-skipped under vitest (check process.env directly since tests
  // pass a stripped `env: {}`).
  const skipCheck = opts.skipRegistryCheck === true || Boolean(process.env.VITEST);
  const latest = skipCheck ? null : await fetchLatestVersion(opts.registryFetch);
  const staleHint = latest && VERSION !== "dev" && compareSemver(VERSION, latest) < 0 ? latest : null;
  if (staleHint) {
    print("UPGRADE AVAILABLE");
    print(`  Running ${VERSION}; npm latest is ${staleHint}.`);
    print("  Run `mcph upgrade` to see the exact command for your install, or");
    print("  `mcph upgrade --run` to execute it (global-npm installs only).");
    print("");
  }

  let exitCode = 0;
  if (config.token === null) {
    exitCode = 1;
    print("DIAGNOSIS");
    print("  No token resolved — mcph cannot start.");
    print("  Run `mcph install <client> --token mcp_pat_…` to seed ~/.mcph/config.json.");
  } else if (config.warnings.length > 0) {
    exitCode = 2;
    print("DIAGNOSIS");
    print("  Token present, but warnings above need attention.");
  } else {
    print("DIAGNOSIS");
    print(staleHint ? "  Healthy, but an upgrade is available (see above)." : "  All good. mcph should start cleanly.");
  }

  return { exitCode, lines, snapshot: { version: VERSION, config, clients } };
}

// JSON counterpart to runDoctor. Same data-collection sequence, no
// print calls — emits a single JSON blob so pipelines and dashboards
// can consume the diagnostic without parsing the text layout. Token is
// always fingerprinted, never raw, matching the text renderer's rule.
async function runDoctorJson(opts: DoctorOptions): Promise<DoctorResult> {
  const lines: string[] = [];
  const write = opts.out ?? ((s: string) => process.stdout.write(s));

  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const os = opts.os ?? CURRENT_OS;
  const env = opts.env ?? process.env;

  const timestamp = new Date().toISOString();
  const config = await loadMcphConfig({ cwd, home, env });
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : undefined;
  const clients = probeClients({ home, os, cwd, claudeConfigDir });

  const envVarNames = [
    "MCPH_POLL_INTERVAL",
    "MCPH_SERVER_CAP",
    "MCPH_MIN_COMPLIANCE",
    "MCPH_AUTO_LOAD",
    "MCPH_AUTO_ACTIVATE",
    "MCPH_PRUNE_RESPONSES",
  ] as const;
  const envOverrides: Record<string, string | null> = {};
  for (const name of envVarNames) {
    const raw = env[name];
    envOverrides[name] = raw === undefined || raw === "" ? null : raw;
  }

  // STATE section data. Mirrors renderStateSection: MCPH_DISABLE_PERSISTENCE
  // short-circuits, otherwise we peek the file.
  const persistRaw = env.MCPH_DISABLE_PERSISTENCE;
  const persistDisabled =
    persistRaw !== undefined && persistRaw !== "" && (persistRaw === "1" || persistRaw.toLowerCase() === "true");
  const state: DoctorJsonSnapshot["state"] = persistDisabled
    ? { disabled: true, path: null, savedAt: null, learningEntries: null, packHistoryEntries: null }
    : await (async () => {
        const filePath = join(userConfigDir(home), STATE_FILENAME);
        const persisted = await loadState(filePath);
        const fresh = persisted.savedAt === 0;
        return {
          disabled: false,
          path: filePath,
          savedAt: fresh ? null : new Date(persisted.savedAt).toISOString(),
          learningEntries: fresh ? 0 : Object.keys(persisted.learning).length,
          packHistoryEntries: fresh ? 0 : persisted.packHistory.length,
        };
      })();

  // Reliability rollup — same selectFlakyNamespaces path as renderReliabilitySection
  // and mcp_connect_health, so all three surfaces agree on "flaky."
  const reliability: DoctorJsonSnapshot["reliability"] = [];
  if (!persistDisabled) {
    const filePath = join(userConfigDir(home), STATE_FILENAME);
    const persisted = await loadState(filePath);
    if (persisted.savedAt !== 0) {
      const entries = Object.entries(persisted.learning).map(([namespace, usage]) => ({ namespace, usage }));
      for (const { namespace, usage } of selectFlakyNamespaces(entries, 5)) {
        reliability.push({
          namespace,
          dispatched: usage.dispatched,
          succeeded: usage.succeeded,
          successRate: usage.succeeded / usage.dispatched,
          lastUsedAt: new Date(usage.lastUsedAt).toISOString(),
        });
      }
    }
  }

  const shellShadows = scanShellHistoryForShadows({ home, env });

  const skipCheck = opts.skipRegistryCheck === true || Boolean(process.env.VITEST);
  const latest = skipCheck ? null : await fetchLatestVersion(opts.registryFetch);
  const stale = latest !== null && VERSION !== "dev" && compareSemver(VERSION, latest) < 0;

  let exitCode = 0;
  let summary: string;
  if (config.token === null) {
    exitCode = 1;
    summary = "No token resolved — mcph cannot start.";
  } else if (config.warnings.length > 0) {
    exitCode = 2;
    summary = "Token present, but warnings need attention.";
  } else {
    summary = stale ? "Healthy, but an upgrade is available." : "All good. mcph should start cleanly.";
  }

  const snapshotJson: DoctorJsonSnapshot = {
    timestamp,
    version: VERSION,
    platform: os,
    token: { fingerprint: tokenFingerprint(config.token), source: config.tokenSource },
    apiBase: { value: config.apiBase, source: config.apiBaseSource },
    loadedFiles: config.loadedFiles.map((f) => ({
      scope: f.scope,
      path: f.path,
      ...(f.version !== undefined ? { schemaVersion: f.version } : {}),
      schemaAhead: f.version !== undefined && f.version > CURRENT_SCHEMA_VERSION,
    })),
    warnings: config.warnings,
    env: envOverrides,
    state,
    reliability,
    clients,
    shellShadows,
    upgrade: { current: VERSION, latest, stale },
    diagnosis: { exitCode, summary },
  };

  const blob = JSON.stringify(snapshotJson, null, 2);
  lines.push(blob);
  write(`${blob}\n`);

  return { exitCode, lines, snapshot: { version: VERSION, config, clients } };
}

// Prints the STATE section. Broken out so the control flow in
// runDoctor stays linear — this is already the third file-reading
// section (config, client probes, history scan).
// Enumerates the behavior-modifier env vars mcph actually reads so a
// support ticket can paste doctor output and we can tell at a glance
// which knobs are turned on. Leaves TOKEN / URL / DISABLE_PERSISTENCE
// to their dedicated sections (they have richer context there).
//
// The "default when unset" hint next to each unset value is the most
// useful bit — without it users don't know what the omission means.
function renderEnvSection(opts: {
  env: NodeJS.ProcessEnv;
  print: (s?: string) => void;
}): void {
  const { env, print } = opts;
  const vars: Array<{ name: string; defaultHint: string }> = [
    { name: "MCPH_POLL_INTERVAL", defaultHint: "default 60s" },
    { name: "MCPH_SERVER_CAP", defaultHint: "default 6" },
    { name: "MCPH_MIN_COMPLIANCE", defaultHint: "filter inactive" },
    { name: "MCPH_AUTO_LOAD", defaultHint: "auto-load inactive" },
    { name: "MCPH_AUTO_ACTIVATE", defaultHint: "default on" },
    { name: "MCPH_PRUNE_RESPONSES", defaultHint: "pruning active" },
  ];
  const widest = vars.reduce((m, v) => Math.max(m, v.name.length), 0);
  print("ENVIRONMENT (behavior overrides)");
  for (const v of vars) {
    const raw = env[v.name];
    const value = raw === undefined || raw === "" ? `(not set — ${v.defaultHint})` : raw;
    print(`  ${v.name.padEnd(widest)}  ${value}`);
  }
  print("");
}

async function renderStateSection(opts: {
  home: string;
  env: NodeJS.ProcessEnv;
  print: (s?: string) => void;
}): Promise<void> {
  const { home, env, print } = opts;
  const raw = env.MCPH_DISABLE_PERSISTENCE;
  const disabled = raw !== undefined && raw !== "" && (raw === "1" || raw.toLowerCase() === "true");
  print("STATE");
  if (disabled) {
    print("  status: disabled via MCPH_DISABLE_PERSISTENCE");
    print("");
    return;
  }
  const filePath = join(userConfigDir(home), STATE_FILENAME);
  print(`  path:   ${filePath}`);
  // Peek before delegating to loadState. loadState swallows malformed
  // JSON and version mismatches silently (returns emptyState), which is
  // correct for runtime but hides real diagnostic info from doctor. We
  // re-read the bytes here so a user with a corrupted state file gets
  // an actionable message instead of "(no persisted state yet)".
  const peek = await peekStateFile(filePath);
  if (peek.kind === "malformed") {
    print("  status: corrupt -- file exists but JSON is unparseable");
    print(`  fix:    \`mcph reset-learning\` to clear, or open ${filePath} and fix by hand`);
    print(`  detail: ${peek.message}`);
    print("");
    return;
  }
  if (peek.kind === "stale-version") {
    print(`  status: schema mismatch (file is v${peek.version ?? "?"}, this mcph reads v${peek.expected})`);
    print("  fix:    `mcph reset-learning` to drop the old file -- learning will rebuild on use");
    print("");
    return;
  }
  if (peek.kind === "unreadable") {
    print(`  status: unreadable (${peek.message})`);
    print("");
    return;
  }
  const persisted = await loadState(filePath);
  if (persisted.savedAt === 0) {
    print("  (no persisted state yet — will be created on the first tool call)");
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
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: "malformed", message: err instanceof Error ? err.message : String(err) };
  }
  if (!parsed || typeof parsed !== "object") return { kind: "malformed", message: "top-level value is not an object" };
  const version = (parsed as { version?: unknown }).version;
  if (version !== STATE_SCHEMA_VERSION) {
    return { kind: "stale-version", version, expected: STATE_SCHEMA_VERSION };
  }
  return { kind: "ok" };
}

// Roll up the flaky-dormant list from persisted state.json. Mirrors the
// cross-session reliability block in mcp_connect_health so the CLI
// diagnostic and the LLM-facing health tool agree on what counts as
// flaky. Silently omitted when persistence is disabled or nothing
// qualifies — no point printing an empty header.
async function renderReliabilitySection(opts: {
  home: string;
  env: NodeJS.ProcessEnv;
  print: (s?: string) => void;
}): Promise<void> {
  const { home, env, print } = opts;
  const raw = env.MCPH_DISABLE_PERSISTENCE;
  const disabled = raw !== undefined && raw !== "" && (raw === "1" || raw.toLowerCase() === "true");
  if (disabled) return;

  const filePath = join(userConfigDir(home), STATE_FILENAME);
  const persisted = await loadState(filePath);
  if (persisted.savedAt === 0) return;

  const entries = Object.entries(persisted.learning).map(([namespace, usage]) => ({ namespace, usage }));
  const flaky = selectFlakyNamespaces(entries, 5);
  if (flaky.length === 0) return;

  print("RELIABILITY (dormant, <80% success)");
  const now = Date.now();
  for (const { namespace, usage } of flaky) {
    const rate = Math.round((usage.succeeded / usage.dispatched) * 100);
    const age = formatRelativeAge(now - usage.lastUsedAt);
    print(`  ${namespace} — ${usage.dispatched} calls, ${rate}% success, last used ${age} ago`);
  }
  print("");
}

// Render the BACKGROUND POSTERS section -- only when at least one
// latch is set. The point is to be silent when everything is working;
// a healthy install must not see this header. Reads the latches via
// the module getters (no cross-module circular: doctor depends on
// analytics/tool-report, never the reverse). The "no recent failure"
// row appears only alongside a sibling that DID fail, so the user can
// tell which poster is broken vs. which is fine.
function renderBackgroundPostersSection(opts: {
  print: (s?: string) => void;
}): void {
  const { print } = opts;
  const analyticsFailure = getLastAnalyticsFailure();
  const reportFailure = getLastReportFailure();
  if (!analyticsFailure && !reportFailure) return;

  const now = Date.now();
  const fmt = (f: AnalyticsFailure | ReportFailure): string =>
    `HTTP ${f.statusCode} from ${f.url}, ${formatRelativeAge(now - f.at)} ago`;

  print("BACKGROUND POSTERS (recent failures)");
  print(`  analytics:    ${analyticsFailure ? fmt(analyticsFailure) : "(no recent failure)"}`);
  print(`  tool-report:  ${reportFailure ? fmt(reportFailure) : "(no recent failure)"}`);
  print("");
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
    return ` (schema v${f.version}, this mcph supports v${CURRENT_SCHEMA_VERSION})`;
  return ` (schema v${f.version})`;
}

interface ProbeOptions {
  home: string;
  os: InstallOS;
  cwd: string;
  /** Claude Code's `CLAUDE_CONFIG_DIR`. When set, claude-code probes hit
   *  `<DIR>/.claude.json` instead of `<HOME>/.claude.json` so doctor and
   *  `mcph install --list` see the same file Claude Code reads. */
  claudeConfigDir?: string;
}

function probeClients(opts: ProbeOptions): ClientProbeResult[] {
  const out: ClientProbeResult[] = [];
  for (const target of INSTALL_TARGETS) {
    const unavailable = !target.availableOn.includes(opts.os);
    if (unavailable) {
      out.push({
        clientId: target.clientId,
        scope: target.scopes[0].scope,
        path: "(n/a)",
        exists: false,
        hasMcphEntry: false,
        malformed: false,
        unavailable: true,
      });
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
          projectDir: scope.requiresProjectDir ? opts.cwd : undefined,
          claudeConfigDir: opts.claudeConfigDir,
        });
      } catch {
        // resolveInstallPath throws when project is required but missing —
        // shouldn't happen here since we always pass cwd, but defensive.
        continue;
      }
      const exists = existsSync(resolved.absolute);
      let hasMcphEntry = false;
      let malformed = false;
      if (exists) {
        try {
          // statSync to make sure it's a file (not a dir) before reading.
          // Synchronous probe is fine here — these are tiny config files
          // and doctor runs once interactively, not in a hot loop.
          statSync(resolved.absolute);
          const raw = readFileSync(resolved.absolute, "utf8");
          if (raw.trim().length > 0) {
            const parsed = parseJsonc(raw);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              const container = walkContainer(parsed as Record<string, unknown>, resolved.containerPath);
              if (container) hasMcphEntry = ENTRY_NAME in container;
            } else {
              malformed = true;
            }
          }
        } catch {
          malformed = true;
        }
      }
      out.push({
        clientId: target.clientId,
        scope: scope.scope,
        path: resolved.absolute,
        exists,
        hasMcphEntry,
        malformed,
        unavailable: false,
      });
    }
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

// Async variant for code paths that prefer non-blocking I/O. Currently
// unused — doctor runs once and the config files are tiny — but exported
// so the dashboard could embed doctor output via an API later without
// blocking the event loop.
export async function probeClientsAsync(opts: ProbeOptions): Promise<ClientProbeResult[]> {
  const result: ClientProbeResult[] = [];
  for (const target of INSTALL_TARGETS) {
    const unavailable = !target.availableOn.includes(opts.os);
    if (unavailable) {
      result.push({
        clientId: target.clientId,
        scope: target.scopes[0].scope,
        path: "(n/a)",
        exists: false,
        hasMcphEntry: false,
        malformed: false,
        unavailable: true,
      });
      continue;
    }
    for (const scope of target.scopes) {
      const resolved = resolveInstallPath({
        clientId: target.clientId,
        scope: scope.scope,
        os: opts.os,
        home: opts.home,
        projectDir: scope.requiresProjectDir ? opts.cwd : undefined,
        claudeConfigDir: opts.claudeConfigDir,
      });
      const exists = existsSync(resolved.absolute);
      let hasMcphEntry = false;
      let malformed = false;
      if (exists) {
        try {
          const raw = await readFile(resolved.absolute, "utf8");
          if (raw.trim().length > 0) {
            const parsed = parseJsonc(raw);
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
              const container = walkContainer(parsed as Record<string, unknown>, resolved.containerPath);
              if (container) hasMcphEntry = ENTRY_NAME in container;
            } else {
              malformed = true;
            }
          }
        } catch {
          malformed = true;
        }
      }
      result.push({
        clientId: target.clientId,
        scope: scope.scope,
        path: resolved.absolute,
        exists,
        hasMcphEntry,
        malformed,
        unavailable: false,
      });
    }
  }
  return result;
}

// Hit the public npm registry for the latest `@yawlabs/mcph` version.
// Intentionally thin: on ANY error (offline, timeout, rate-limited,
// corp proxy) we return null and doctor just skips the upgrade section.
// This function is NEVER awaited on a hot path — it only runs in doctor,
// which is user-interactive.
async function fetchLatestVersion(override?: () => Promise<string | null>): Promise<string | null> {
  if (override) {
    try {
      return await override();
    } catch {
      return null;
    }
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2000);
  try {
    const res = await fetch("https://registry.npmjs.org/@yawlabs/mcph/latest", {
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

/** Scan recent bash / zsh / PowerShell history for commands that an
 *  MCP server shadows. Returns a sorted (count desc) list of hits.
 *  Any I/O error on a history file is swallowed — this is purely
 *  diagnostic, never fatal. */
export function scanShellHistoryForShadows(opts: {
  home: string;
  env: NodeJS.ProcessEnv;
}): ShadowHit[] {
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

function shellHistorySources(opts: {
  home: string;
  env: NodeJS.ProcessEnv;
}): ShellHistorySource[] {
  const sources: ShellHistorySource[] = [];
  sources.push({ path: join(opts.home, ".bash_history"), extractCommand: (l) => l.trim() || null });
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
      extractCommand: (l) => l.trim() || null,
    });
  }
  return sources;
}

function readTailLines(path: string, n: number): string[] {
  try {
    const raw = readFileSync(path, "utf8");
    const all = raw.split(/\r?\n/);
    return all.length <= n ? all : all.slice(all.length - n);
  } catch {
    return [];
  }
}

// Pull the leading binary out of a shell command, stripping any
// leading env-var assignments (`FOO=bar CMD=quux cmd arg`), `sudo`,
// and path-style invocations (`/usr/local/bin/npm` → `npm`). Returns
// null for lines we can't confidently parse (pipes, command
// substitution, assignments only).
function extractLeadingBinary(command: string): string | null {
  let rest = command.trimStart();
  if (!rest) return null;
  // Drop leading control chars like `! ` (bang-prefixed history
  // references from bash shouldn't even land here, but defensive).
  if (rest.startsWith("!")) return null;
  // Strip leading env-var assignments.
  while (/^[A-Z_][A-Z0-9_]*=/i.test(rest)) {
    const space = rest.indexOf(" ");
    if (space === -1) return null;
    rest = rest.slice(space + 1).trimStart();
  }
  // Strip `sudo` / `time` / `command` prefixes.
  const prefixes = ["sudo", "time", "command", "exec"];
  const firstWord = rest.split(/\s+/)[0];
  if (prefixes.includes(firstWord)) {
    const space = rest.indexOf(" ");
    if (space === -1) return null;
    rest = rest.slice(space + 1).trimStart();
  }
  const first = rest.split(/\s+/)[0];
  if (!first) return null;
  // Reject pipes, redirects, subshells, empty assignments.
  if (/[|&;<>()`$]/.test(first)) return null;
  // Strip path prefix — we match on the binary name.
  const slash = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\"));
  return slash === -1 ? first : first.slice(slash + 1);
}

// Tiny semver compare — full semver is overkill; we only need to
// recognize "a is older than b" for dotted numeric x.y.z tags. Anything
// unparseable returns 0 (treated as equal) so a weird version string
// can't accidentally show a false "upgrade available" banner.
export function compareSemver(a: string, b: string): number {
  const parse = (s: string): [number, number, number] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(s);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}
