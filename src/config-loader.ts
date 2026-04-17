// mcph config loader for token, apiBase, version, servers, blocked.
//
// Config lives in three optional files, highest-precedence first:
//
//   1. <project>/.mcph/config.local.json  — machine-local override; gitignore by convention
//   2. <project>/.mcph/config.json        — project-shared file (committed); MUST NOT contain a token
//   3. ~/.mcph/config.json                — user-global default
//
// The project `.mcph/` directory is discovered by walking up from cwd
// (see paths.ts findProjectConfigDir), stopping exclusively before $HOME
// so a `.mcph/` sitting at $HOME is treated as user-global only.
//
// Token precedence:    MCPH_TOKEN env  >  local  >  global   (project never holds a token)
// apiBase precedence:  MCPH_URL env    >  local  >  project  >  global  >  https://mcp.hosting
//
// servers/blocked merging: allow-list picks the most specific scope that
// sets it (local > project > global); deny-list unions across all scopes.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseJsonc } from "./jsonc.js";
import { log } from "./logger.js";
import { migrateLegacyConfigPaths } from "./migrate.js";
import { CONFIG_DIRNAME, findProjectConfigDir, userConfigDir } from "./paths.js";

export const CONFIG_FILENAME = "config.json";
export const LOCAL_CONFIG_FILENAME = "config.local.json";
/** Schema version we currently emit. Older files load fine; newer files
 *  trigger a warning so a user running an old mcph doesn't silently
 *  ignore fields it doesn't understand. */
export const CURRENT_SCHEMA_VERSION = 1;

export type ConfigScope = "local" | "project" | "global";

export interface LoadedConfigFile {
  path: string;
  scope: ConfigScope;
  version?: number;
  token?: string;
  apiBase?: string;
  servers?: string[];
  blocked?: string[];
}

export type TokenSource = "env" | "local" | "global" | "missing";
export type ApiBaseSource = "env" | "local" | "project" | "global" | "default";

export interface ResolvedConfig {
  token: string | null;
  tokenSource: TokenSource;
  apiBase: string;
  apiBaseSource: ApiBaseSource;
  /** Allow-list (local > project > global). Undefined when no scope sets it. */
  servers?: string[];
  /** Deny-list (union across all scopes that set it). */
  blocked?: string[];
  /** Absolute path to the discovered project `.mcph/` dir, or null if none. */
  projectConfigDir: string | null;
  /** Files actually read + parsed (in load order). */
  loadedFiles: LoadedConfigFile[];
  /** Soft problems that don't fail loading. Surface in `mcph doctor`. */
  warnings: string[];
}

export interface LoadConfigOptions {
  /** Directory to start project-config discovery from. Defaults to process.cwd(). */
  cwd?: string;
  /** Home directory override for tests. Defaults to os.homedir(). */
  home?: string;
  /** Process env override for tests. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_API_BASE = "https://mcp.hosting";

async function readConfigAt(path: string, scope: ConfigScope, warnings: string[]): Promise<LoadedConfigFile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`${path}: invalid JSON (${msg}) — file ignored`);
    log("warn", "Config file is not valid JSON; ignoring", { path, error: msg });
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(`${path}: root must be a JSON object — file ignored`);
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  const version = typeof obj.version === "number" ? obj.version : undefined;
  if (version !== undefined && version > CURRENT_SCHEMA_VERSION) {
    warnings.push(
      `${path}: schema version ${version} is newer than this mcph (${CURRENT_SCHEMA_VERSION}); upgrade with \`npm i -g @yawlabs/mcph@latest\`. Loading best-effort.`,
    );
  }

  const token = typeof obj.token === "string" && obj.token.length > 0 ? obj.token : undefined;
  const apiBase = typeof obj.apiBase === "string" && obj.apiBase.length > 0 ? obj.apiBase : undefined;
  const servers = Array.isArray(obj.servers)
    ? obj.servers.filter((v): v is string => typeof v === "string")
    : undefined;
  const blocked = Array.isArray(obj.blocked)
    ? obj.blocked.filter((v): v is string => typeof v === "string")
    : undefined;

  if (token) {
    if (scope === "project") {
      warnings.push(
        `${path}: 'token' should not appear in a project-shared file. Move it to ${CONFIG_DIRNAME}/${LOCAL_CONFIG_FILENAME} (gitignored) or ~/${CONFIG_DIRNAME}/${CONFIG_FILENAME}.`,
      );
    }
    await checkPermissions(path, warnings);
  }

  return { path, scope, version, token, apiBase, servers, blocked };
}

async function checkPermissions(path: string, warnings: string[]): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const st = await stat(path);
    const mode = st.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      warnings.push(
        `${path}: contains a token but is readable by group/other (mode ${mode.toString(8)}). Run \`chmod 600 ${path}\` to restrict.`,
      );
    }
  } catch {
    // Stat failure is rare; not worth surfacing.
  }
}

/** Merge servers (allow-list): most specific scope wins. */
function pickServers(files: LoadedConfigFile[]): string[] | undefined {
  const local = files.find((f) => f.scope === "local")?.servers;
  if (local !== undefined) return local;
  const project = files.find((f) => f.scope === "project")?.servers;
  if (project !== undefined) return project;
  return files.find((f) => f.scope === "global")?.servers;
}

/** Merge blocked (deny-list): union across all scopes that declare it. */
function unionBlocked(files: LoadedConfigFile[]): string[] | undefined {
  const set = new Set<string>();
  let touched = false;
  for (const f of files) {
    if (f.blocked) {
      touched = true;
      for (const b of f.blocked) set.add(b);
    }
  }
  return touched ? [...set] : undefined;
}

export async function loadMcphConfig(opts: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const home = resolve(opts.home ?? homedir());
  const env = opts.env ?? process.env;

  const warnings: string[] = [];
  const loadedFiles: LoadedConfigFile[] = [];

  // Fold any pre-0.12 flat config dotfiles into `.mcph/` before the
  // resolver runs — otherwise a user who upgrades from 0.11.x would
  // silently lose their token until they moved the file by hand.
  // Fail-open: migration errors are logged, never thrown.
  await migrateLegacyConfigPaths({ cwd, home });

  const projectConfigDir = await findProjectConfigDir(cwd, home).catch((err) => {
    log("warn", "Failed searching for project .mcph/ dir", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });

  const globalDir = userConfigDir(home);
  const localPath = projectConfigDir ? join(projectConfigDir, LOCAL_CONFIG_FILENAME) : null;
  const projectPath = projectConfigDir ? join(projectConfigDir, CONFIG_FILENAME) : null;
  const globalPath = join(globalDir, CONFIG_FILENAME);

  const local = localPath ? await readConfigAt(localPath, "local", warnings) : null;
  if (local) loadedFiles.push(local);

  // Avoid double-loading when the discovered project dir IS the user-global dir.
  // findProjectConfigDir excludes $HOME, so this only triggers if someone passes
  // a non-homedir `home` override that happens to equal the walk-up match.
  const projectIsGlobal = projectConfigDir !== null && projectConfigDir === globalDir;
  const project = projectIsGlobal || !projectPath ? null : await readConfigAt(projectPath, "project", warnings);
  if (project) loadedFiles.push(project);

  const global = await readConfigAt(globalPath, "global", warnings);
  if (global) loadedFiles.push(global);

  let token: string | null = null;
  let tokenSource: TokenSource = "missing";
  if (typeof env.MCPH_TOKEN === "string" && env.MCPH_TOKEN.length > 0) {
    token = env.MCPH_TOKEN;
    tokenSource = "env";
  } else if (local?.token) {
    token = local.token;
    tokenSource = "local";
  } else if (global?.token) {
    token = global.token;
    tokenSource = "global";
  }

  let apiBase = DEFAULT_API_BASE;
  let apiBaseSource: ApiBaseSource = "default";
  if (typeof env.MCPH_URL === "string" && env.MCPH_URL.length > 0) {
    apiBase = env.MCPH_URL;
    apiBaseSource = "env";
  } else if (local?.apiBase) {
    apiBase = local.apiBase;
    apiBaseSource = "local";
  } else if (project?.apiBase) {
    apiBase = project.apiBase;
    apiBaseSource = "project";
  } else if (global?.apiBase) {
    apiBase = global.apiBase;
    apiBaseSource = "global";
  }

  return {
    token,
    tokenSource,
    apiBase,
    apiBaseSource,
    servers: pickServers(loadedFiles),
    blocked: unionBlocked(loadedFiles),
    projectConfigDir,
    loadedFiles,
    warnings,
  };
}

/** Last-4-of-token fingerprint for safe display in `mcph doctor`. */
export function tokenFingerprint(token: string | null): string {
  if (!token) return "(none)";
  if (token.length <= 8) return `***${token.slice(-2)}`;
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

// --- Profile compatibility layer ---------------------------------------
//
// server.ts and a few call sites still speak in terms of a "Profile": a
// { path, servers?, blocked? } record describing which namespaces are
// allowed in this session. The new ResolvedConfig carries the same
// allow/deny lists, so we expose a thin shim that converts the relevant
// slice and preserves the exact shape server.ts already consumes.

export interface Profile {
  /** Primary identity: project config file if one was loaded, else user-global. */
  path: string;
  /** When both project + user-global contributed, the user-global path is surfaced too. */
  userPath?: string;
  servers?: string[];
  blocked?: string[];
}

/** Derive a Profile from a ResolvedConfig, or null if no allow/deny
 *  rules are set anywhere. Display-only: it condenses which files
 *  contributed into `path` (+ `userPath`) for `handleHealth()`. */
export function toProfile(config: ResolvedConfig): Profile | null {
  if (config.servers === undefined && config.blocked === undefined) return null;
  const byScope = new Map<ConfigScope, LoadedConfigFile>();
  for (const f of config.loadedFiles) byScope.set(f.scope, f);

  const local = byScope.get("local");
  const project = byScope.get("project");
  const global = byScope.get("global");

  const primary = local ?? project ?? global;
  if (!primary) return null;

  const result: Profile = {
    path: primary.path,
    servers: config.servers,
    blocked: config.blocked,
  };
  if (primary !== global && global) {
    result.userPath = global.path;
  }
  return result;
}

/** Load the effective profile for a session. Thin wrapper around
 *  loadMcphConfig + toProfile — kept as a named function so server.ts
 *  can import it without reaching into ResolvedConfig internals. */
export async function loadEffectiveProfile(cwd: string, home?: string): Promise<Profile | null> {
  const config = await loadMcphConfig({ cwd, home });
  return toProfile(config);
}

/** Returns true iff `namespace` is allowed by the resolved allow/deny lists. */
export function isAllowed(rules: { servers?: string[]; blocked?: string[] } | null, namespace: string): boolean {
  if (!rules) return true;
  if (rules.blocked?.includes(namespace)) return false;
  if (rules.servers && rules.servers.length > 0) {
    return rules.servers.includes(namespace);
  }
  return true;
}

/** Back-compat alias for isAllowed when the caller is holding a Profile. */
export function profileAllows(profile: Profile | null, namespace: string): boolean {
  return isAllowed(profile, namespace);
}
