import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Per-platform cache root for anything mcph fetches at runtime (uv
// binary today; potentially more later). Matches the conventions each
// OS uses for non-essential, regenerable data so users who wipe their
// home can recover without losing config.
export function cacheDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const base = localAppData && localAppData.length > 0 ? localAppData : path.join(homedir(), "AppData", "Local");
    return path.join(base, "mcph", "Cache");
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Caches", "mcph");
  }
  const xdg = process.env.XDG_CACHE_HOME;
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(homedir(), ".cache"), "mcph");
}

// Directory that holds all mcph config + guidance files. Mirrors the
// `.git/`, `.vscode/`, `.claude/` convention so everything related to
// mcph lives under one predictable folder a user can grep, gitignore,
// or blow away atomically.
export const CONFIG_DIRNAME = ".mcph";

// User-global mcph config dir: `~/.mcph/`. Always this; no XDG
// variation — config is small, human-edited, and lives next to shell
// dotfiles like `.gitconfig` rather than under a cache root.
export function userConfigDir(home: string = homedir()): string {
  return path.join(home, CONFIG_DIRNAME);
}

// Walks up from `start` looking for a `.mcph/` directory, stopping
// just BEFORE $HOME (exclusive) or the filesystem root. Returns the
// absolute path to the `.mcph/` directory, or null if none was found.
//
// Why exclusive of $HOME: a `.mcph/` sitting at $HOME is the
// user-global scope (handled separately by userConfigDir). Returning
// it here would double-load it as both project and user-global.
export async function findProjectConfigDir(start: string, home: string = homedir()): Promise<string | null> {
  const homeResolved = path.resolve(home);
  let dir = path.resolve(start);
  let prev = "";
  while (dir !== prev) {
    if (dir === homeResolved) return null;
    const candidate = path.join(dir, CONFIG_DIRNAME);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not here, keep walking
    }
    prev = dir;
    dir = path.dirname(dir);
  }
  return null;
}

// Name of the human-authored guidance file mcph surfaces to clients via
// the mcph://guide resource. Lives next to config.json inside `.mcph/`.
export const GUIDE_FILENAME = "MCPH.md";

// Absolute path to the MCPH.md file inside a given `.mcph/` directory.
export function guidePath(configDir: string): string {
  return path.join(configDir, GUIDE_FILENAME);
}
