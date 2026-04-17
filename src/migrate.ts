// Legacy-path migration: fold pre-0.12 flat config dotfiles into the
// new `.mcph/` directory layout on startup.
//
// Pre-0.12, mcph read three flat files at the root:
//
//   ~/.mcph.json                 (user-global)
//   <project>/.mcph.json         (project-shared)
//   <project>/.mcph.local.json   (machine-local, gitignored)
//
// 0.12 moved these under `.mcph/` so all mcph state lives in one
// predictable dir. Existing 0.11.x users would otherwise see their token
// silently disappear on upgrade. This migrator fixes that:
//
//   - Idempotent: if the new location already exists, DON'T overwrite.
//   - Fail-open: a locked/unwritable path logs and continues — the
//     user isn't worse off than if they'd never upgraded.
//   - One-way: we rename the legacy file rather than copy + delete, so
//     downgrading doesn't silently revive a stale version.
//   - Quiet but visible: every successful move logs at INFO so users
//     can trace where their config went.

import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "./logger.js";
import { CONFIG_DIRNAME, findProjectConfigDir, userConfigDir } from "./paths.js";

export const LEGACY_GLOBAL_FILENAME = ".mcph.json";
export const LEGACY_PROJECT_FILENAME = ".mcph.json";
export const LEGACY_LOCAL_FILENAME = ".mcph.local.json";

const NEW_CONFIG_FILENAME = "config.json";
const NEW_LOCAL_FILENAME = "config.local.json";

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
// `.mcph/` may not have been created yet). Logs on move, logs on skip
// due to an already-populated target, logs on error.
async function migrateFile(legacy: string, target: string, scope: string): Promise<void> {
  if (!(await exists(legacy))) return;

  if (await exists(target)) {
    // Target exists AND legacy exists — ambiguous. Prefer the new one,
    // but warn so the user knows the legacy is orphaned and can delete
    // it manually. We do NOT silently overwrite the new file; that
    // would lose whatever the user wrote there.
    log("warn", "mcph config: legacy file exists alongside new location — legacy is ignored", {
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
    log("info", "mcph config: migrated legacy file into .mcph/ directory", {
      scope,
      from: legacy,
      to: target,
    });
  } catch (err) {
    log("warn", "mcph config: legacy migration failed — leaving file in place", {
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

// Runs all three migrations. Called from loadMcphConfig before any
// file resolution so the rest of the loader only ever sees the new
// layout. Intentionally does NOT return anything — failures are
// absorbed via log so a bad filesystem state can't brick startup.
export async function migrateLegacyConfigPaths(opts: MigrateOptions): Promise<void> {
  const { cwd, home } = opts;

  // User-global: ~/.mcph.json → ~/.mcph/config.json
  const legacyGlobal = join(home, LEGACY_GLOBAL_FILENAME);
  const newGlobal = join(userConfigDir(home), NEW_CONFIG_FILENAME);
  await migrateFile(legacyGlobal, newGlobal, "global");

  // Project scope: find the nearest legacy file by walking up from cwd.
  // We use a dedicated walker rather than findProjectConfigDir because
  // the legacy layout has no `.mcph/` marker — the file IS the marker.
  const legacyProjectRoot = await findLegacyProjectRoot(cwd, home);
  if (legacyProjectRoot) {
    // A project dir found by the legacy walker is ALSO a valid target
    // for a `.mcph/` directory. findProjectConfigDir will discover the
    // `.mcph/` we're about to create on the next startup, so this is a
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

// Walk up from `cwd` looking for either a legacy `.mcph.json` or
// `.mcph.local.json`, stopping EXCLUSIVELY before $HOME so a file at
// $HOME is handled by the global migration path alone. Returns the
// directory that contains the legacy file(s), or null if none found.
async function findLegacyProjectRoot(cwd: string, home: string): Promise<string | null> {
  const { resolve, dirname } = await import("node:path");
  const homeResolved = resolve(home);
  let dir = resolve(cwd);
  let prev = "";
  while (dir !== prev) {
    if (dir === homeResolved) return null;
    const legacyProject = join(dir, LEGACY_PROJECT_FILENAME);
    const legacyLocal = join(dir, LEGACY_LOCAL_FILENAME);
    if ((await exists(legacyProject)) || (await exists(legacyLocal))) return dir;
    prev = dir;
    dir = dirname(dir);
  }
  return null;
}
