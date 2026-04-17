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

  // Probe every supported client/scope combo on the current OS.
  const clients = probeClients({ home, os, cwd });
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
    print("  If `mcph` is globally installed it shadows `npx` — upgrade with:");
    print("    npm install -g @yawlabs/mcph@latest");
    print("  Otherwise restart your MCP client; `npx -y @yawlabs/mcph` will fetch the new version.");
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
