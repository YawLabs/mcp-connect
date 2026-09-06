// yaw-mcp config loader for version, servers, blocked, installNudge.
//
// Config lives in three optional files, highest-precedence first:
//
//   1. <project>/.yaw-mcp/config.local.json  — machine-local override; gitignore by convention
//   2. <project>/.yaw-mcp/config.json        — project-shared file (committed)
//   3. ~/.yaw-mcp/config.json                — user-global default
//
// The project `.yaw-mcp/` directory is discovered by walking up from cwd
// (see paths.ts findProjectConfigDir) -- stopping before $HOME when the
// walk started under it, so a `.yaw-mcp/` sitting at $HOME is treated as
// user-global only; a cwd OUTSIDE $HOME walks to the filesystem root with
// a per-directory ownership check instead.
//
// DEPRECATED KEYS: `token` and `apiBase` are no longer read by anything --
// yaw-mcp is local-only and never contacts a hosted API. A file carrying
// either key still loads (soft deprecation: rejecting it would break every
// existing install), but the loader emits a warning telling the user to
// delete the key and revoke the PAT. Deleting the apiBase precedence chain
// also closes a real hole: a committed project-scope `apiBase` could
// redirect the API base while a global-scope token was attached, sending
// that token to an attacker-chosen host.
//
// servers/blocked merging: allow-list picks the most specific scope that
// sets it (local > project > global); deny-list unions across all scopes.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseJsonc } from "./jsonc.js";
import { NAMESPACE_RE } from "./local-bundles.js";
import { log } from "./logger.js";
import { migrateLegacyConfigPaths } from "./migrate.js";
import { findProjectConfigDir, userConfigDir } from "./paths.js";

export const CONFIG_FILENAME = "config.json";
export const LOCAL_CONFIG_FILENAME = "config.local.json";
/** Schema version we currently emit. Older files load fine; newer files
 *  trigger a warning so a user running an old yaw-mcp doesn't silently
 *  ignore fields it doesn't understand. */
export const CURRENT_SCHEMA_VERSION = 1;

export type ConfigScope = "local" | "project" | "global";

export interface LoadedConfigFile {
  path: string;
  scope: ConfigScope;
  version?: number;
  servers?: string[];
  blocked?: string[];
  /** Opt-in flag for the shadow-driven install nudge. Off (undefined)
   *  by default; only `true` enables it. See install-nudge.ts. */
  installNudge?: boolean;
}

export interface ResolvedConfig {
  /** Allow-list (local > project > global). Undefined when no scope sets it. */
  servers?: string[];
  /** Deny-list (union across all scopes that set it). */
  blocked?: string[];
  /** Opt-in: enable the shadow-driven install nudge in discover. Resolved
   *  most-specific-scope-wins (local > project > global). Undefined when no
   *  scope sets it (treated as off). The env var YAW_MCP_INSTALL_NUDGE=1
   *  also enables it independently — see install-nudge.ts installNudgeEnabled. */
  installNudge?: boolean;
  /** Absolute path to the discovered project `.yaw-mcp/` dir, or null if none. */
  projectConfigDir: string | null;
  /** Files actually read + parsed (in load order). */
  loadedFiles: LoadedConfigFile[];
  /** Soft problems that don't fail loading. Surface in `yaw-mcp doctor`. */
  warnings: string[];
}

export interface LoadConfigOptions {
  /** Directory to start project-config discovery from. Defaults to process.cwd(). */
  cwd?: string;
  /** Home directory override for tests. Defaults to os.homedir(). */
  home?: string;
  /** Process env the loader consults. Read for exactly ONE key: paths.ts's
   *  ALLOW_UNOWNED_ENV opt-in, which the project-dir walk needs when
   *  ownership is unverifiable (win32). Everything else this loader once read
   *  from the env (YAW_MCP_TOKEN / YAW_MCP_URL) retired with the hosted
   *  backend. Defaults to process.env; doctor (doctor-cmd.ts, the shared
   *  collector) and the tests pass a synthetic one so the walk's trust
   *  decision can be probed without stubbing the real environment.
   *
   *  Wire any future env-dependent key up explicitly, the way this one is --
   *  do not turn the field back into a general escape hatch. */
  env?: NodeJS.ProcessEnv;
}

/** Config keys that used to drive the hosted backend and are now inert.
 *  Detected (not consumed) so the loader can tell the user to clean up.
 *  Exported alongside KNOWN_CONFIG_KEYS for the schema drift test. */
export const DEPRECATED_KEYS = ["token", "apiBase"] as const;

/** Every top-level key the loader reads. Mirrors the shipped JSON schema
 *  (schemas/yaw-mcp.config.v1.json, additionalProperties:false) so an
 *  unrecognized key gets a warning instead of being a silent no-op --
 *  `$schema` is the editor-autocomplete pointer the schema itself allows.
 *
 *  Exported so config-loader.test.ts can diff it against that schema's
 *  `properties`: the two are the same contract written twice (the schema
 *  refuses an unknown key in the editor, this set warns about it at load),
 *  and the schema is shipped to users by URL, so a key added here and not
 *  there would be flagged invalid in their editor while working fine. */
export const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "$schema",
  "version",
  "servers",
  "blocked",
  "installNudge",
]);

/** Public URL of the shipped JSON Schema (schemas/yaw-mcp.config.v1.json).
 *  It is the only place a user can see the whole key list WITH its types and
 *  constraints, and nothing in the product pointed at it -- so it went
 *  undiscovered. Named in the unknown-key warning below (the one moment a
 *  user is demonstrably looking for the key list) and in the README's
 *  Configuration section. Same URL as the schema's own `$id`; dropping it
 *  into a config as `"$schema"` turns on editor completion. */
const CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/YawLabs/mcp/main/schemas/yaw-mcp.config.v1.json";

/** Build the soft-deprecation warning for a file that still carries
 *  `token` / `apiBase`. Named separately so the exact wording is
 *  assertable from tests and identical on every surface (startup log,
 *  `doctor`, `doctor --json` warnings array). */
function deprecatedKeyWarning(path: string, keys: string[]): string {
  const quoted = keys.map((k) => `'${k}'`).join(" and ");
  const isAre = keys.length > 1 ? "are" : "is";
  const them = keys.length > 1 ? "them" : "it";
  const revoke = keys.includes("token")
    ? ` Revoke that PAT at its source -- deleting it here does not deactivate it.`
    : "";
  return (
    `${path}: ${quoted} ${isAre} no longer used -- yaw-mcp is local-only and never contacts a hosted API. ` +
    `Delete ${them} from ${path}.${revoke}`
  );
}

/** Filter a config array field down to its usable string entries. Warns when
 *  entries are dropped, when the field isn't an array at all, and when a
 *  surviving entry can't be a namespace (warning rather than silently
 *  swallowing an unusable value -- the rule every field in this loader
 *  follows; the retired `apiBase` / `token` keys are warned about the same
 *  way when they are merely present). Returns undefined
 *  when the field isn't an array OR when every entry was invalid: a
 *  non-empty array that filters to [] must fall THROUGH to the parent scope
 *  rather than resolve to [] -- an empty allow-list means allow-all in
 *  isAllowed, so a `servers:[123]` at a specific scope would otherwise
 *  silently shadow a valid parent scope's allow-list with allow-all. A
 *  genuinely empty [] is preserved as-is (an explicit "no filter"). */
function filterStringArray(raw: unknown, field: string, path: string, warnings: string[]): string[] | undefined {
  if (!Array.isArray(raw)) {
    // A PRESENT but non-array value (`"servers": "github"` -- the plausible
    // hand-edit for "lock this session to one server") used to be dropped in
    // silence, so the field failed OPEN to allow-all while `doctor` reported
    // an empty warnings array. Absence is the normal case for every scope the
    // user hasn't configured and stays silent. Only the FIELD is dropped here
    // -- the rest of the file still loads.
    if (raw !== undefined) {
      warnings.push(
        `${path}: '${field}' must be an array of namespace strings (found ${raw === null ? "null" : typeof raw}) -- ignored.`,
      );
    }
    return undefined;
  }
  // Non-strings AND blank strings are dropped (the shipped schema says
  // minLength 1). A kept "" was a silent deny-everything: isAllowed then
  // required namespace === "", which NAMESPACE_RE makes unreachable.
  // Survivors are kept TRIMMED: validating `" github".trim()` while KEEPING
  // the untrimmed spelling produced an allow-list no installed namespace can
  // ever match -- a silent deny-all that also shadows a valid parent scope.
  // On `blocked` the same trim turns an inert `" slack"` into a real deny,
  // which is the honest reading of what the user wrote.
  const strings = raw
    .map((v) => (typeof v === "string" ? v.trim() : v))
    .filter((v): v is string => typeof v === "string" && v !== "");
  const dropped = raw.length - strings.length;
  if (dropped > 0) {
    warnings.push(
      `${path}: '${field}' dropped ${dropped} non-string or empty ${dropped === 1 ? "entry" : "entries"} -- only non-empty string namespaces are honored.`,
    );
  }
  // Namespace-shape check is a WARNING, never a drop: dropping would empty the
  // array, hit the fall-through below, and silently promote a specific scope's
  // deny-all into the parent scope's allow-all -- the exact bug this function
  // exists to prevent. NAMESPACE_RE is imported from local-bundles.ts rather
  // than re-spelled so the validator and the installer pin one definition.
  for (const s of strings) {
    if (!NAMESPACE_RE.test(s)) {
      warnings.push(
        `${path}: '${field}' entry '${s}' is not a valid namespace (a lowercase letter followed by [a-z0-9_]) -- it can never match an installed server.`,
      );
    }
  }
  // All entries invalid (non-empty array that filtered to []): treat as
  // unset so the resolver falls through to the parent scope instead of
  // resolving to an empty (allow-all) list that shadows it.
  if (strings.length === 0 && raw.length > 0) return undefined;
  return strings;
}

async function readConfigAt(path: string, scope: ConfigScope, warnings: string[]): Promise<LoadedConfigFile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    // "Not there" is the overwhelmingly common case and stays silent:
    // ENOENT (no such file) and ENOTDIR (a component of the path isn't a
    // directory, i.e. `.yaw-mcp/` doesn't exist) both mean there is no file
    // to load. Anything ELSE means the file IS there and we could not read
    // it -- EACCES on a root-owned `~/.yaw-mcp/config.json` (sudo-run
    // install, restored backup), EISDIR on a `config.json/` directory, EIO
    // on a flaky mount. Swallowing those made the user's allow/deny lists
    // vanish with `doctor --json` reporting an empty warnings array, while
    // the far less dangerous invalid-JSON case below did warn. Warn on both.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`${path}: unreadable (${code ?? msg}) -- file ignored`);
    log("warn", "Config file exists but could not be read; ignoring", { path, error: msg, code });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`${path}: invalid JSON (${msg}) -- file ignored`);
    log("warn", "Config file is not valid JSON; ignoring", { path, error: msg });
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(`${path}: root must be a JSON object -- file ignored`);
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  const version = typeof obj.version === "number" ? obj.version : undefined;
  // A PRESENT but wrong-typed version (`"version": "2"` -- the likeliest
  // hand-edit typo, since every other value in the file is a string or an
  // array of them) used to collapse to undefined and skip the newer-schema
  // warning below, so the one user who most needs to be told their file is
  // from a newer yaw-mcp got silence. Warn instead of coercing: guessing a
  // schema version from a string is exactly the kind of leniency that makes
  // the "loading best-effort" claim untrue.
  if ("version" in obj && version === undefined) {
    warnings.push(
      `${path}: 'version' must be a number (found ${obj.version === null ? "null" : typeof obj.version}) -- ignored; schema-version checks are skipped for this file.`,
    );
  }
  if (version !== undefined && version > CURRENT_SCHEMA_VERSION) {
    warnings.push(
      `${path}: schema version ${version} is newer than this yaw-mcp (${CURRENT_SCHEMA_VERSION}); upgrade with \`npm i -g @yawlabs/mcp@latest\`. Loading best-effort.`,
    );
  }

  // Soft deprecation: detect the retired hosted-backend keys, warn, and
  // keep loading. A hard error here would break every config file written
  // by a pre-local-only yaw-mcp -- and the rest of the file (allow/deny
  // lists, installNudge) is still perfectly valid. Key PRESENCE is the
  // trigger, not a usable value: `"token": ""` still needs cleaning up.
  const staleKeys = DEPRECATED_KEYS.filter((k) => k in obj);
  if (staleKeys.length > 0) {
    warnings.push(deprecatedKeyWarning(path, [...staleKeys]));
    log("warn", "Config file carries retired hosted-backend keys", { path, keys: staleKeys.join(",") });
  }

  // Unknown top-level keys warn (the shipped schema is
  // additionalProperties:false): a typo like "blocke" was a silent no-op
  // that fails OPEN to allow-all. Deprecated keys are reported above with
  // their own migration hint, so they are excluded here.
  const unknownKeys = Object.keys(obj).filter(
    (k) => !KNOWN_CONFIG_KEYS.has(k) && !(DEPRECATED_KEYS as readonly string[]).includes(k),
  );
  if (unknownKeys.length > 0) {
    warnings.push(
      `${path}: unknown ${unknownKeys.length === 1 ? "key" : "keys"} ${unknownKeys.map((k) => `'${k}'`).join(", ")} ignored -- known keys: ${[...KNOWN_CONFIG_KEYS].join(", ")}. Full schema: ${CONFIG_SCHEMA_URL}`,
    );
  }

  const servers = filterStringArray(obj.servers, "servers", path, warnings);
  const blocked = filterStringArray(obj.blocked, "blocked", path, warnings);
  // Only a literal boolean is honored — a non-boolean (string "true",
  // number 1) is ignored rather than coerced, so a typo can't silently
  // flip on a privacy-sensitive nudge.
  const installNudge = typeof obj.installNudge === "boolean" ? obj.installNudge : undefined;
  // ...but the discard is announced, exactly like the wrong-typed `version`
  // above. `"installNudge": "true"` used to be swallowed with no diagnostic
  // on any surface, so a user who opted in read their own config as enabled
  // while the nudge stayed off.
  if ("installNudge" in obj && installNudge === undefined) {
    warnings.push(
      `${path}: 'installNudge' must be a boolean (found ${obj.installNudge === null ? "null" : typeof obj.installNudge}) -- ignored; the nudge stays off for this file.`,
    );
  }

  return { path, scope, version, servers, blocked, installNudge };
}

/** Merge servers (allow-list): most specific scope wins. */
function pickServers(files: LoadedConfigFile[]): string[] | undefined {
  const local = files.find((f) => f.scope === "local")?.servers;
  if (local !== undefined) return local;
  const project = files.find((f) => f.scope === "project")?.servers;
  if (project !== undefined) return project;
  return files.find((f) => f.scope === "global")?.servers;
}

/** Resolve installNudge: most specific scope that sets it wins (local >
 *  project > global), mirroring pickServers. Undefined when no scope sets
 *  it — the gate treats that as off. */
function pickInstallNudge(files: LoadedConfigFile[]): boolean | undefined {
  const local = files.find((f) => f.scope === "local")?.installNudge;
  if (local !== undefined) return local;
  const project = files.find((f) => f.scope === "project")?.installNudge;
  if (project !== undefined) return project;
  return files.find((f) => f.scope === "global")?.installNudge;
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

// migrateLegacyConfigPaths stat-walks from cwd up to $HOME on every call.
// loadYawMcpConfig runs several times in a single process (server boot,
// doctor, each CLI subcommand, every profile refresh), and the migration
// is idempotent and one-way: once it has run to completion for a given
// (cwd, home) pair there is nothing left to move. Memoize the in-flight /
// settled promise so the walk is paid once per process (and concurrent
// callers share one walk rather than racing each other on rename).
const migrationOnce = new Map<string, Promise<void>>();

function migrateLegacyConfigPathsOnce(cwd: string, home: string): Promise<void> {
  const key = `${cwd}\u0000${home}`;
  let pending = migrationOnce.get(key);
  if (pending === undefined) {
    // Fail-open (matches the migrator's own contract): a rejection is
    // logged, never propagated, and never re-tried -- a broken filesystem
    // state must not brick startup or re-throw on every later load.
    pending = migrateLegacyConfigPaths({ cwd, home }).catch((err) => {
      log("warn", "Legacy config migration failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    migrationOnce.set(key, pending);
  }
  return pending;
}

export async function loadYawMcpConfig(opts: LoadConfigOptions = {}): Promise<ResolvedConfig> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const home = resolve(opts.home ?? homedir());

  const warnings: string[] = [];
  const loadedFiles: LoadedConfigFile[] = [];

  // Fold any pre-0.12 flat config dotfiles into `.yaw-mcp/` before the
  // resolver runs — otherwise a user who upgrades from 0.11.x would
  // silently lose their allow/deny lists until they moved the file by hand.
  // Fail-open: migration errors are logged, never thrown. Memoized per
  // (cwd, home) so repeat loads in one process don't re-walk the tree.
  await migrateLegacyConfigPathsOnce(cwd, home);

  const projectConfigDir = await findProjectConfigDir(cwd, home, opts.env).catch((err) => {
    log("warn", "Failed searching for project .yaw-mcp/ dir", {
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
  // Normalize through resolve() (and case-fold on win32) so a case-variant or
  // unnormalized home override doesn't byte-mismatch and double-load.
  const normalizeDir = (d: string): string => {
    const r = resolve(d);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const projectIsGlobal = projectConfigDir !== null && normalizeDir(projectConfigDir) === normalizeDir(globalDir);
  const project = projectIsGlobal || !projectPath ? null : await readConfigAt(projectPath, "project", warnings);
  if (project) loadedFiles.push(project);

  const global = await readConfigAt(globalPath, "global", warnings);
  if (global) loadedFiles.push(global);

  return {
    servers: pickServers(loadedFiles),
    blocked: unionBlocked(loadedFiles),
    installNudge: pickInstallNudge(loadedFiles),
    projectConfigDir,
    loadedFiles,
    warnings,
  };
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
  // Unreachable at runtime, and deliberately kept: `config.servers` /
  // `config.blocked` are only ever populated FROM a loadedFiles entry, so the
  // guard above already implies at least one scope is present here. What this
  // line does is narrow `primary` for the compiler (Map.get is optional) --
  // and it degrades a hypothetical future resolver that synthesizes rules
  // with no backing file to "no profile" instead of a TypeError on `.path`.
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
