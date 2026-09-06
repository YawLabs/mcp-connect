import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { log } from "./logger.js";

// Per-platform cache root for anything yaw-mcp fetches at runtime (uv
// binary today; potentially more later). Matches the conventions each
// OS uses for non-essential, regenerable data so users who wipe their
// home can recover without losing config.
export function cacheDir(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const base = localAppData && localAppData.length > 0 ? localAppData : path.join(homedir(), "AppData", "Local");
    return path.join(base, "yaw-mcp", "Cache");
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Caches", "yaw-mcp");
  }
  const xdg = process.env.XDG_CACHE_HOME;
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(homedir(), ".cache"), "yaw-mcp");
}

// Directory that holds all yaw-mcp config + guidance files. Mirrors the
// `.git/`, `.vscode/`, `.claude/` convention so everything related to
// yaw-mcp lives under one predictable folder a user can grep, gitignore,
// or blow away atomically.
export const CONFIG_DIRNAME = ".yaw-mcp";

/** Subdirectory of the config dir holding the sidecar install that
 *  `yaw-mcp sidecars install` manages. */
export const SIDECARS_DIRNAME = "sidecars";

/** Where `yaw-mcp sidecars install` installs MCP server packages. */
export function sidecarsRoot(home: string = homedir()): string {
  return path.join(userConfigDir(home), SIDECARS_DIRNAME);
}

/**
 * The `node_modules` of the managed sidecar install.
 *
 * Lives here rather than beside the command that writes it because
 * oam-spawn's resolver reads it, and oam-spawn is imported BY that command --
 * putting the path there would be an import cycle.
 *
 * IMPORT THIS (and sidecarsRoot) FROM HERE. sidecars-cmd.ts re-exports both,
 * which makes it read like the owner, and doctor-cmd.ts consumes sidecarsRoot
 * through that re-export -- but sidecars-cmd.ts also imports from oam-spawn.ts,
 * so pointing oam-spawn.ts at the re-export instead of at this module recreates
 * the cycle above. Nothing detects it: both cross-module uses are deferred to
 * call time (a function body, a default parameter), so the cycle would ship
 * latent and only bite once either module gains top-level initialization that
 * touches the other (TDZ on whichever side loads second). There is no cycle
 * linter in the repo; this note and the paragraph above are the only guard.
 */
export function sidecarsNodeModules(home: string = homedir()): string {
  return path.join(sidecarsRoot(home), "node_modules");
}

// User-global yaw-mcp config dir: `~/.yaw-mcp/`. Always this; no XDG
// variation -- config is small, human-edited, and lives next to shell
// dotfiles like `.gitconfig` rather than under a cache root.
export function userConfigDir(home: string = homedir()): string {
  return path.join(home, CONFIG_DIRNAME);
}

// Exported for doctor's shell-history dedupe, which keys on the same
// case-folded spelling so a case-variant HISTFILE cannot double count.
export function normalizeForCompare(p: string): string {
  // Case-fold on win32 AND darwin: both default to case-insensitive
  // filesystems (NTFS; APFS/HFS+ unless formatted case-sensitive), so a
  // case-variant spelling of $HOME must compare equal to the cwd's
  // spelling. Linux stays byte-exact.
  return process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p;
}

// Best-effort physical path: symlinked homes (/home -> /var/home), NFS
// automounts, and macOS's symlinked /tmp all make the logical spelling of a
// path differ from the physical one. Falls back to the raw path when
// realpath fails (nonexistent segment, permission error) so callers degrade
// to the plain lexical comparison rather than throwing.
export async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

// True iff `dir` is STRICTLY under `homeResolved` ($HOME itself is false).
// Exported for migrate.ts's findLegacyProjectRoot, whose walk-up bound must
// be a subset of this one -- sharing the predicate keeps the two from
// drifting (a bare `startsWith("..")` copy over there once disagreed with
// the anchored test below, so a legacy config under `~/..config/` was
// discoverable by the loader but never migrated).
export function isUnderHome(dir: string, homeResolved: string): boolean {
  const dirKey = normalizeForCompare(dir);
  const homeKey = normalizeForCompare(homeResolved);
  if (dirKey === homeKey) return false;
  // Relative is computed on the case-folded keys: path.relative is
  // case-sensitive on POSIX, so on darwin a case-variant $HOME spelling
  // would otherwise yield a `../`-shaped result for a dir genuinely under
  // it (win32's relative already folds; folded input is a no-op there).
  const rel = path.relative(homeKey, dirKey);
  if (rel === "" || path.isAbsolute(rel)) return false;
  // Anchor the "escapes $HOME" test on a path SEPARATOR. A bare
  // `startsWith("..")` also rejects a directory literally NAMED `..`-
  // something: path.relative("/home/alice", "/home/alice/..config/app") is
  // "..config/app", which starts with ".." while being genuinely under
  // $HOME. findProjectConfigDir treats a false here as "stop the walk", so
  // that one character made every `.yaw-mcp/` below `~/..config/`
  // undiscoverable. Only a segment that IS ".." actually escapes.
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

// Trust gate for candidates found OUTSIDE $HOME: on POSIX, only accept a
// `.yaw-mcp/` owned by the current effective uid. A hostile `.yaw-mcp/`
// planted on the walk-up path (a shared /tmp-style dir, `/` in a container)
// shouldn't get loaded as project config -- same stance as migrate.ts's
// owner check on legacy files.
//
// process.geteuid is POSIX-only. On win32 there is no uid to compare and no
// cheap ownership probe, and the "dirs above a non-home checkout need admin
// rights to write into" assumption only holds for the system drive root:
// UNC network shares, `C:\Users\Public`-style dirs, and non-system NTFS
// volume roots are frequently writable by any authenticated user, so a
// third party could plant a `.yaw-mcp/` there to inject YAW-MCP.md text
// into the model context and apply config.json allow/block lists. Without a
// verifiable owner, outside-$HOME candidates are therefore REJECTED unless
// the user explicitly opts in via YAW_MCP_ALLOW_UNOWNED_PROJECT_DIRS=1
// (e.g. for a trusted checkout on `D:\`).
export const ALLOW_UNOWNED_ENV = "YAW_MCP_ALLOW_UNOWNED_PROJECT_DIRS";

// Candidate dirs we have already warned about in THIS process. The walk runs
// once per config load and there are three independent callers (config-loader,
// guide.ts, local-bundles), so an untrusted `.yaw-mcp/` on the walk-up path --
// the normal shape for any win32 checkout on a second drive without the env
// opt-in -- otherwise emits the same warn on every doctor / list / profile
// refresh. The warning is advice about a static condition, so the first
// occurrence carries all of its information; the rest are noise that buries
// real diagnostics. Keyed on the candidate path, so a DIFFERENT untrusted dir
// still warns. Unbounded by design: the set can only grow with the number of
// distinct directories walked in one process, which is bounded by the depth of
// the trees the session actually visits.
const warnedUntrustedDirs = new Set<string>();

// `st` is the walk's OWN stat of the candidate -- the one that just proved it
// is a directory. Re-statting here was a second syscall and a second TOCTOU
// window on a path we had already examined, for no new information.
//
// `env` is the CALLER's environment, not process.env. doctor and guide thread
// an injected env into this walk so a synthetic run can be probed; reading
// process.env here made that injection a silent no-op for the one key the
// walk cares about, and the tests only stayed green because they stubbed the
// real environment as well.
function ownedByCurrentUser(st: Awaited<ReturnType<typeof stat>>, env: NodeJS.ProcessEnv): boolean {
  const geteuid = (process as { geteuid?: () => number }).geteuid;
  if (typeof geteuid !== "function") return env[ALLOW_UNOWNED_ENV] === "1";
  return typeof st.uid === "number" && st.uid === geteuid.call(process);
}

// Walks up from `start` looking for a `.yaw-mcp/` directory, stopping
// just BEFORE $HOME (exclusive) or the filesystem root. Returns the
// absolute path to the `.yaw-mcp/` directory, or null if none was found.
//
// Why exclusive of $HOME: a `.yaw-mcp/` sitting at $HOME is the
// user-global scope (handled separately by userConfigDir). Returning
// it here would double-load it as both project and user-global.
// `env` feeds the ownership gate's ALLOW_UNOWNED_ENV opt-in (see
// ownedByCurrentUser); callers that probe with a synthetic environment pass
// theirs, everything else gets process.env.
export async function findProjectConfigDir(
  start: string,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  // os.homedir() is already the USERPROFILE reader on win32, and it is this
  // parameter's own default -- an empty explicit `home` just means "use the
  // default after all".
  const homeFallback = home && home.length > 0 ? home : homedir();
  // Bound and walk in PHYSICAL terms: when the logical $HOME is a symlink
  // to the cwd's physical prefix (/home -> /var/home, NFS automounts), the
  // lexical spelling of home and cwd never match, so boundedByHome would
  // compute false and the outside-$HOME walk would climb into the physical
  // home -- claiming the user's own ~/.yaw-mcp as PROJECT config, which
  // double-loads it and trips the project-trust probe on the user's own
  // global file. realpathOrSelf degrades to the raw path when realpath
  // fails, restoring the plain lexical walk.
  const homeResolved = path.resolve(await realpathOrSelf(path.resolve(homeFallback)));
  let dir = path.resolve(await realpathOrSelf(path.resolve(start)));
  // The user-global config dir in the same physical terms: any candidate
  // that RESOLVES to it (a symlink inside a project tree, an alias the
  // bound did not catch) is the user-global scope handled by userConfigDir,
  // never project config.
  const userConfigKey = normalizeForCompare(await realpathOrSelf(path.join(homeResolved, CONFIG_DIRNAME)));
  // The bound depends on where the walk STARTS. Starting at or under $HOME,
  // the walk stops just before $HOME (exclusive): a hijacked `.yaw-mcp/`
  // ABOVE the user's home (`/home/.yaw-mcp`, `/.yaw-mcp`) must never be
  // picked up as project config, and $HOME itself is the user-global scope
  // (userConfigDir). Starting OUTSIDE $HOME -- a second drive (`D:\proj`),
  // a container workspace (`/workspaces/proj` with HOME=/home/vscode), an
  // `/srv` checkout -- $HOME is not on the walk-up path at all, so bounding
  // at $HOME would (and once did) disable project config, the YAW-MCP.md
  // guide, and project bundles for every such checkout. There the walk runs
  // to the filesystem root instead, with the ownership check above (POSIX
  // uid match; win32 env opt-in) as the trust boundary on each hit.
  const boundedByHome =
    isUnderHome(dir, homeResolved) || normalizeForCompare(dir) === normalizeForCompare(homeResolved);
  let prev = "";
  while (dir !== prev) {
    // Bound the walk at $HOME when it started there: only consider dirs
    // strictly under $HOME, skipping $HOME itself (handled separately by
    // userConfigDir).
    if (boundedByHome && !isUnderHome(dir, homeResolved)) return null;
    const candidate = path.join(dir, CONFIG_DIRNAME);
    try {
      // stat, not access: EXISTS is not enough. A regular FILE named
      // `.yaw-mcp` (a stray note, a `touch` typo, an editor swap file) would
      // otherwise be returned as the project config dir -- every later read
      // under it fails with ENOTDIR, and because the walk stops at the first
      // hit it also MASKS a real `.yaw-mcp/` further up. stat follows
      // symlinks, so a junction or link pointing at a real directory still
      // qualifies (the resolves-to-user-global check below handles aliasing).
      const st = await stat(candidate);
      if (!st.isDirectory()) {
        log("debug", "Skipping a .yaw-mcp that exists but is not a directory", { candidate });
      } else if (normalizeForCompare(await realpathOrSelf(candidate)) === userConfigKey) {
        // The candidate IS the user-global dir, reached through a symlink
        // or alias. Returning it here would double-load it as both project
        // and user-global scope; skip it and keep walking.
        log("debug", "Skipping a .yaw-mcp/ that resolves to the user-global config dir", { candidate });
      } else if (boundedByHome || ownedByCurrentUser(st, env)) {
        return candidate;
      } else {
        // Found but not trusted: skip it and keep walking, mirroring the
        // unreadable-dir trade-off below -- a planted dir shouldn't be able
        // to mask a legitimate config further up either. Warn ONCE per
        // candidate per process (see warnedUntrustedDirs): the skip itself
        // still happens on every walk, only the log line is deduplicated.
        if (!warnedUntrustedDirs.has(candidate)) {
          warnedUntrustedDirs.add(candidate);
          log("warn", "Skipping an untrusted .yaw-mcp/ dir outside $HOME", {
            candidate,
            hint: `owned by another user, or ownership is unverifiable on this platform (set ${ALLOW_UNOWNED_ENV}=1 to trust it)`,
          });
        }
      }
    } catch {
      // Accepted trade-off: we treat ALL errors (ENOENT, EPERM, EACCES,
      // etc.) as "not found here" and keep walking up the directory tree.
      // An unreadable .yaw-mcp/ dir is therefore silently skipped rather
      // than surfaced as an error, which means the walk may reach a
      // parent-directory config instead of stopping at the unreadable one.
      // The risk is low in practice (permission errors on .yaw-mcp/ itself
      // are unusual), and the alternative -- treating the stat error as
      // fatal -- would break startup for the common ENOENT case. Callers
      // that need stricter semantics (e.g. readBundlesAt in local-bundles.ts)
      // handle their own permission errors explicitly.
    }
    prev = dir;
    dir = path.dirname(dir);
  }
  return null;
}

// Name of the human-authored guidance file yaw-mcp surfaces to clients via
// the yaw-mcp://guide resource. Lives next to config.json inside `.yaw-mcp/`.
export const GUIDE_FILENAME = "YAW-MCP.md";

// Absolute path to the YAW-MCP.md file inside a given `.yaw-mcp/` directory.
export function guidePath(configDir: string): string {
  return path.join(configDir, GUIDE_FILENAME);
}
