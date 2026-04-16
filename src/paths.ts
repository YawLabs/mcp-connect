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
