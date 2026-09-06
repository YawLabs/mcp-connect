// Legacy-path migration: fold pre-0.12 flat config dotfiles into the
// new `.yaw-mcp/` directory layout on startup.
//
// Pre-0.12, yaw-mcp read three flat files at the root:
//
//   ~/.yaw-mcp.json                 (user-global)
//   <project>/.yaw-mcp.json         (project-shared)
//   <project>/.yaw-mcp.local.json   (machine-local, gitignored)
//
// 0.12 moved these under `.yaw-mcp/` so all yaw-mcp state lives in one
// predictable dir. Existing 0.11.x users would otherwise see their
// allow/deny lists (`servers` / `blocked`) silently disappear on upgrade --
// the loader only discovers `.yaw-mcp/` dirs, so an unmigrated flat file is
// read by nothing. (The flat file once also carried the hosted-backend
// token; that backend is retired and the loader ignores the key, so the
// lists are the whole surviving payload.) This migrator fixes that:
//
//   - Idempotent: if the new location already exists, DON'T overwrite.
//   - Fail-open: a locked/unwritable path logs and continues — the
//     user isn't worse off than if they'd never upgraded.
//   - One-way: we rename the legacy file rather than copy + delete, so
//     downgrading doesn't silently revive a stale version.
//   - Quiet but visible: every successful move logs at INFO so users
//     can trace where their config went.

import type { Stats } from "node:fs";
import { lstat, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { log } from "./logger.js";
import { CONFIG_DIRNAME, isUnderHome, realpathOrSelf, userConfigDir } from "./paths.js";

export const LEGACY_GLOBAL_FILENAME = ".yaw-mcp.json";
export const LEGACY_PROJECT_FILENAME = ".yaw-mcp.json";
export const LEGACY_LOCAL_FILENAME = ".yaw-mcp.local.json";

const NEW_CONFIG_FILENAME = "config.json";
const NEW_LOCAL_FILENAME = "config.local.json";

// Existence probe for the WALKER only (findLegacyProjectRoot), which just asks
// "is there a legacy file here" -- following a symlink is the right answer for
// discovery. migrateFile does its own lstat instead; see the comment there for
// why the thing it renames must be the thing it inspected.
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Move legacy → new, but only if the new path is empty. Ensures the
// parent dir exists first (the whole point of this migration is that
// `.yaw-mcp/` may not have been created yet). Logs on move, logs on skip
// due to an already-populated target, logs on error.
async function migrateFile(legacy: string, target: string, scope: string): Promise<void> {
  // ONE lstat serves as both the existence probe and the ownership check
  // below -- the path used to be stat'ed twice, and the two stats could
  // disagree about the file they described.
  //
  // lstat, not stat: a symlink at the legacy path has to be judged as
  // ITSELF. stat() follows the link, so the ownership decision was about the
  // TARGET inode while rename() below moves the LINK -- two different files,
  // and a link with a RELATIVE target dangles the moment it lands one
  // directory deeper in `.yaw-mcp/`. A missing/unreadable path throws here
  // and is treated as "nothing to migrate", exactly as the old existence
  // probe did.
  let st: Stats;
  try {
    st = await lstat(legacy);
  } catch {
    return;
  }

  if (st.isSymbolicLink()) {
    // Skipped rather than followed: renaming the link breaks a relative
    // target, and copying through it would hoist a file the ownership check
    // above never covered. Left in place with a warn so the drop is visible.
    log("warn", "yaw-mcp config: legacy path is a symlink -- skipping migration", {
      scope,
      legacy,
      target,
      action: "move the file the link points at into .yaw-mcp/ by hand, then delete the link",
    });
    return;
  }

  // POSIX-only owner check: confirm the legacy file is owned by the
  // current effective uid before we rename it. A hostile or stale file
  // dropped into the walker's range (a path we walked up into, a shared
  // /tmp-style dir, a hand-off after `chown`) shouldn't get hoisted into
  // ~/.yaw-mcp/ where it'd be trusted by the loader. process.geteuid is
  // Posix-only -- on win32 it doesn't exist, and Windows uses a different
  // ACL model, so we accept legacy files as-is there.
  if (process.platform !== "win32") {
    const geteuid = (process as { geteuid?: () => number }).geteuid;
    if (typeof geteuid === "function") {
      const myUid = geteuid.call(process);
      if (typeof st.uid === "number" && st.uid !== myUid) {
        log("warn", "yaw-mcp config: legacy file not owned by current user -- skipping migration", {
          scope,
          legacy,
          fileUid: st.uid,
          processUid: myUid,
        });
        return;
      }
    }
  }

  if (await exists(target)) {
    // Target exists AND legacy exists — ambiguous. Prefer the new one,
    // but warn so the user knows the legacy is orphaned and can delete
    // it manually. We do NOT silently overwrite the new file; that
    // would lose whatever the user wrote there.
    log("warn", "yaw-mcp config: legacy file exists alongside new location -- legacy is ignored", {
      scope,
      legacy,
      target,
      action: "manually delete the legacy file after confirming the new one is correct",
    });
    return;
  }

  try {
    await mkdir(dirname(target), { recursive: true });
    await rename(legacy, target);
    log("info", "yaw-mcp config: migrated legacy file into .yaw-mcp/ directory", {
      scope,
      from: legacy,
      to: target,
    });
  } catch (err) {
    // `exists(target)` above and the rename are a check-then-act pair, and
    // config-loader memoizes the migration per PROCESS only: two yaw-mcp
    // processes starting together (several MCP client panes) both pass the
    // check, and the loser's rename ENOENTs on a file its sibling has already
    // moved. That is the migration succeeding, not failing -- re-check both
    // ends before warning about a file that is exactly where it should be.
    if (!(await exists(legacy)) && (await exists(target))) {
      log("info", "yaw-mcp config: legacy file was migrated by another yaw-mcp process meanwhile", {
        scope,
        from: legacy,
        to: target,
      });
      return;
    }
    log("warn", "yaw-mcp config: legacy migration failed -- leaving file in place", {
      scope,
      legacy,
      target,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface MigrateOptions {
  cwd: string;
  home: string;
}

// Runs all three migrations. Called from loadYawMcpConfig before any
// file resolution so the rest of the loader only ever sees the new
// layout. Intentionally does NOT return anything — failures are
// absorbed via log so a bad filesystem state can't brick startup.
export async function migrateLegacyConfigPaths(opts: MigrateOptions): Promise<void> {
  const { cwd, home } = opts;

  // User-global: ~/.yaw-mcp.json → ~/.yaw-mcp/config.json
  const legacyGlobal = join(home, LEGACY_GLOBAL_FILENAME);
  const newGlobal = join(userConfigDir(home), NEW_CONFIG_FILENAME);
  await migrateFile(legacyGlobal, newGlobal, "global");

  // A `.yaw-mcp.local.json` sitting AT $HOME is the one legacy file with no
  // new-layout home: the loader's machine-local scope is per-project
  // (config-loader.ts reads <project>/.yaw-mcp/config.local.json only), and
  // the project walk below stops strictly BEFORE $HOME, so this file is read
  // by nothing after the upgrade. Renaming it into ~/.yaw-mcp/config.local.json
  // would move it somewhere equally unread, so we warn and leave it -- the
  // drop used to be entirely silent.
  const homeLocal = join(home, LEGACY_LOCAL_FILENAME);
  if (await exists(homeLocal)) {
    log("warn", "yaw-mcp config: legacy machine-local file at $HOME has no new location -- leaving it in place", {
      scope: "local",
      legacy: homeLocal,
      action: `merge its contents into a project ${CONFIG_DIRNAME}/config.local.json, or into ${newGlobal} for user-global scope, then delete it`,
    });
  }

  // Project scope: find the nearest legacy file by walking up from cwd.
  // We use a dedicated walker rather than findProjectConfigDir because
  // the legacy layout has no `.yaw-mcp/` marker — the file IS the marker.
  const legacyProjectRoot = await findLegacyProjectRoot(cwd, home);
  if (legacyProjectRoot) {
    // A project dir found by the legacy walker is ALSO a valid target
    // for a `.yaw-mcp/` directory. findProjectConfigDir will discover the
    // `.yaw-mcp/` we're about to create on the next startup, so this is a
    // one-shot conversion.
    const newDir = join(legacyProjectRoot, CONFIG_DIRNAME);

    const legacyLocal = join(legacyProjectRoot, LEGACY_LOCAL_FILENAME);
    const newLocal = join(newDir, NEW_LOCAL_FILENAME);
    await migrateFile(legacyLocal, newLocal, "local");

    const legacyProject = join(legacyProjectRoot, LEGACY_PROJECT_FILENAME);
    const newProject = join(newDir, NEW_CONFIG_FILENAME);
    await migrateFile(legacyProject, newProject, "project");
  }
}

// Walk up from `cwd` looking for either a legacy `.yaw-mcp.json` or
// `.yaw-mcp.local.json`. Returns the directory that contains the legacy
// file(s), or null if none found.
//
// The walk is bounded to directories STRICTLY under $HOME, using the SAME
// isUnderHome predicate as findProjectConfigDir (paths.ts) -- a local copy
// once drifted (bare `startsWith("..")` vs the anchored test), which made
// a legacy config under any `~/..config`-style directory discoverable by
// the loader but never migrated. Sharing the predicate closes that class.
//
// This bound is deliberately NARROWER than the loader's: this migrator
// destructively renames `.yaw-mcp.json` -> `.yaw-mcp/config.json`, so it
// must only ever touch directories the loader also searches (strictly
// under $HOME always qualifies). findProjectConfigDir additionally walks
// to the filesystem root for a cwd OUTSIDE $HOME, but extending the
// DESTRUCTIVE rename out there would revive the old failure mode of
// hoisting files from unrelated ancestors (a shared /tmp, `/`), so
// outside $HOME the migration stays a no-op -- legacy files are left in
// place for the user to move by hand.
async function findLegacyProjectRoot(cwd: string, home: string): Promise<string | null> {
  // Realpath BOTH inputs, exactly like findProjectConfigDir (paths.ts):
  // sharing the isUnderHome predicate is not enough when the INPUTS differ.
  // On a symlinked $HOME (/home -> /var/home, NFS automounts), the lexical
  // home spelling and the physical process.cwd() never match, the first
  // loop iteration bailed, and pre-0.12 project configs were silently
  // never migrated -- with the loader only discovering .yaw-mcp/ dirs, the
  // legacy allow/deny list was lost with no warning.
  const homeResolved = resolve(await realpathOrSelf(resolve(home)));
  let dir = resolve(await realpathOrSelf(resolve(cwd)));
  let prev = "";
  while (dir !== prev) {
    if (!isUnderHome(dir, homeResolved)) return null;
    const legacyProject = join(dir, LEGACY_PROJECT_FILENAME);
    const legacyLocal = join(dir, LEGACY_LOCAL_FILENAME);
    if ((await exists(legacyProject)) || (await exists(legacyLocal))) return dir;
    prev = dir;
    dir = dirname(dir);
  }
  return null;
}
