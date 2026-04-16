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
export interface Profile {
  path: string;
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

export async function loadProfile(start: string): Promise<Profile | null> {
  const override = process.env.MCPH_PROFILE;
  const path = override ? resolve(override) : await findProfilePath(start);
  if (!path) return null;

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
