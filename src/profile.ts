import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { log } from "./logger.js";

// Project-scoped filter: a .mcph.json at the project root declares which
// configured servers are allowed to activate within that project. This
// gives users a way to share "the github repo uses github+pg, nothing
// else" via source-controlled config, without pruning their user-wide
// mcp.hosting config.
//
// Schema:
//   {
//     "servers": ["github", "postgres"],   // allow-list (optional)
//     "blocked": ["staging-prod"]           // deny-list (optional)
//   }
//
// Both fields are optional. An empty/malformed file is logged and
// ignored — failing closed on a user project config would break every
// tool call, which is worse than the profile just not being applied.
//
// User-global profile: a .mcph.json at $HOME provides personal defaults
// ("here are the servers I trust for any project"). When both a project
// and a user-global profile are present, the project one wins where it
// speaks — see mergeProfiles() for the exact semantics.
export interface Profile {
  path: string;
  // When a user-global profile was merged with a project-local one,
  // userPath records the user-global file so handleHealth() can show
  // both sources. Absent for single-source profiles.
  userPath?: string;
  servers?: string[];
  blocked?: string[];
}

export const PROFILE_FILENAME = ".mcph.json";

// Walks up from `start` looking for .mcph.json, stopping at the user's
// home directory (inclusive) or the filesystem root. Returns null if
// none is found. We stop at $HOME because scanning past it crosses into
// other users' directories on shared systems.
export async function findProfilePath(start: string): Promise<string | null> {
  const home = resolve(homedir());
  let dir = resolve(start);
  let prev = "";
  while (dir !== prev) {
    const candidate = join(dir, PROFILE_FILENAME);
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // file not here; keep walking
    }
    if (dir === home) return null;
    prev = dir;
    dir = dirname(dir);
  }
  return null;
}

// Reads and parses a single profile file at `path`. Returns null on any
// I/O or JSON error — fail-open matches the philosophy of the rest of
// the module (a bad profile shouldn't brick the session).
async function readProfileAt(path: string): Promise<Profile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    log("warn", "Profile file unreadable; ignoring", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log("warn", "Profile file is not valid JSON; ignoring", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    log("warn", "Profile root must be an object; ignoring", { path });
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const servers = Array.isArray(obj.servers)
    ? obj.servers.filter((v): v is string => typeof v === "string")
    : undefined;
  const blocked = Array.isArray(obj.blocked)
    ? obj.blocked.filter((v): v is string => typeof v === "string")
    : undefined;

  return { path, servers, blocked };
}

// Loads the project-local profile: either MCPH_PROFILE (explicit
// override) or the first .mcph.json found walking up from `start`.
// Returns null if neither is found.
export async function loadProfile(start: string): Promise<Profile | null> {
  const override = process.env.MCPH_PROFILE;
  const path = override ? resolve(override) : await findProfilePath(start);
  if (!path) return null;
  return readProfileAt(path);
}

// Loads the user-global profile at ~/.mcph.json. Returns null if the
// file doesn't exist or can't be parsed — fail-open like everything
// else in this module.
export async function loadUserGlobalProfile(): Promise<Profile | null> {
  const path = join(resolve(homedir()), PROFILE_FILENAME);
  return readProfileAt(path);
}

// Merge a project-local profile with a user-global one. The rules:
//   - servers (allow-list): project wins if it sets it; otherwise fall
//     back to user-global. "The project explicitly says what it wants."
//   - blocked (deny-list): union. A server blocked in either scope
//     stays blocked. Denies compose; you can't un-block from a narrower
//     scope.
//   - path: the project path (the primary identity for display).
//   - userPath: the user-global path, so handleHealth() can render both.
// Either input may be null; if both are null the caller should have
// short-circuited already, but we return null defensively.
export function mergeProfiles(project: Profile | null, userGlobal: Profile | null): Profile | null {
  if (!project && !userGlobal) return null;
  if (!project) return userGlobal;
  if (!userGlobal) return project;

  const servers = project.servers !== undefined ? project.servers : userGlobal.servers;

  let blocked: string[] | undefined;
  if (project.blocked || userGlobal.blocked) {
    const union = new Set<string>([...(userGlobal.blocked ?? []), ...(project.blocked ?? [])]);
    blocked = [...union];
  }

  return {
    path: project.path,
    userPath: userGlobal.path,
    servers,
    blocked,
  };
}

// Loads the effective profile for a session, orchestrating project and
// user-global discovery. Rules:
//   - If MCPH_PROFILE is set, treat it as project-local and IGNORE
//     user-global entirely. The override is explicit; don't surprise
//     the caller by silently merging in $HOME/.mcph.json.
//   - Else: walk up from `start` for a project-local .mcph.json.
//     - If found, also load user-global and merge.
//     - If not found, fall back to user-global alone.
//   - Returns null if nothing is loadable.
export async function loadEffectiveProfile(start: string): Promise<Profile | null> {
  if (process.env.MCPH_PROFILE) {
    return loadProfile(start);
  }

  const projectPath = await findProfilePath(start);
  const project = projectPath ? await readProfileAt(projectPath) : null;
  const userHome = resolve(homedir());
  const userGlobalPath = join(userHome, PROFILE_FILENAME);
  // If the project-local profile IS the user-global one (user ran mcph
  // from $HOME with no deeper profile), don't double-load it — that
  // would produce userPath === path in the merged output, which is
  // confusing in handleHealth().
  const userGlobal = projectPath === userGlobalPath ? null : await loadUserGlobalProfile();

  return mergeProfiles(project, userGlobal);
}

// Returns true iff `namespace` is allowed by the (possibly absent) profile.
// When profile is null or neither field is set, everything is allowed.
export function profileAllows(profile: Profile | null, namespace: string): boolean {
  if (!profile) return true;
  if (profile.blocked?.includes(namespace)) return false;
  if (profile.servers && profile.servers.length > 0) {
    return profile.servers.includes(namespace);
  }
  return true;
}
