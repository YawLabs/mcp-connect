// Cross-session persistence for session-scoped signal (learning +
// detected packs). Stored at `~/.mcph/state.json`. Pure functions —
// ConnectServer owns the load/save lifecycle.
//
// Design principles:
//   - Silent failure. A corrupt or unreadable state file must never
//     prevent mcph from starting. Missing file returns empty state;
//     parse errors log once and also return empty state.
//   - Schema-versioned. A version mismatch drops the old state
//     entirely rather than trying to migrate — the signal is small and
//     cheap to rebuild, and migration bugs would corrupt fresh data.
//   - Privacy-conserving. Only namespace names and tool names (which
//     are schema identifiers, not user inputs) are persisted. No tool
//     arguments, response payloads, or credentials ever touch disk.
//   - Atomic writes. Write-rename so a crash mid-flush can't leave
//     half-written JSON where the loader would see garbage.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";
import { userConfigDir } from "./paths.js";

export const STATE_SCHEMA_VERSION = 1;
export const STATE_FILENAME = "state.json";

export interface PersistedLearningUsage {
  dispatched: number;
  succeeded: number;
  lastUsedAt: number;
}

export interface PersistedPackCall {
  namespace: string;
  toolName: string;
  at: number;
}

export interface PersistedState {
  version: number;
  savedAt: number;
  learning: Record<string, PersistedLearningUsage>;
  packHistory: PersistedPackCall[];
}

export function statePath(configDir: string = userConfigDir()): string {
  return path.join(configDir, STATE_FILENAME);
}

export function emptyState(): PersistedState {
  return { version: STATE_SCHEMA_VERSION, savedAt: 0, learning: {}, packHistory: [] };
}

// Load persisted state from disk. Always returns a PersistedState
// object — on any failure (missing file, bad JSON, version mismatch,
// sanitization drops everything) we silently fall through to empty.
export async function loadState(filePath: string = statePath()): Promise<PersistedState> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyState();
    if ((parsed as { version?: unknown }).version !== STATE_SCHEMA_VERSION) return emptyState();
    const p = parsed as Record<string, unknown>;
    return {
      version: STATE_SCHEMA_VERSION,
      savedAt: typeof p.savedAt === "number" ? p.savedAt : 0,
      learning: sanitizeLearning(p.learning),
      packHistory: sanitizePackHistory(p.packHistory),
    };
  } catch (err) {
    if (isFileNotFound(err)) return emptyState();
    log("warn", "Failed to load mcph state, starting fresh", { error: errorMessage(err) });
    return emptyState();
  }
}

// Save persisted state to disk atomically. Best-effort — failures log
// but never throw, since a missing save shouldn't crash the session.
export async function saveState(
  state: Pick<PersistedState, "learning" | "packHistory">,
  filePath: string = statePath(),
): Promise<void> {
  const payload: PersistedState = {
    version: STATE_SCHEMA_VERSION,
    savedAt: Date.now(),
    learning: state.learning,
    packHistory: state.packHistory,
  };
  const dir = path.dirname(filePath);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    log("warn", "Failed to save mcph state", { error: errorMessage(err) });
  }
}

function sanitizeLearning(input: unknown): Record<string, PersistedLearningUsage> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, PersistedLearningUsage> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!k) continue;
    if (!v || typeof v !== "object") continue;
    const u = v as Record<string, unknown>;
    if (typeof u.dispatched !== "number" || !Number.isFinite(u.dispatched) || u.dispatched < 0) continue;
    if (typeof u.succeeded !== "number" || !Number.isFinite(u.succeeded) || u.succeeded < 0) continue;
    if (typeof u.lastUsedAt !== "number" || !Number.isFinite(u.lastUsedAt) || u.lastUsedAt < 0) continue;
    out[k] = { dispatched: u.dispatched, succeeded: u.succeeded, lastUsedAt: u.lastUsedAt };
  }
  return out;
}

function sanitizePackHistory(input: unknown): PersistedPackCall[] {
  if (!Array.isArray(input)) return [];
  const out: PersistedPackCall[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.namespace !== "string" || !c.namespace) continue;
    if (typeof c.toolName !== "string" || !c.toolName) continue;
    if (typeof c.at !== "number" || !Number.isFinite(c.at) || c.at < 0) continue;
    out.push({ namespace: c.namespace, toolName: c.toolName, at: c.at });
  }
  return out;
}

function isFileNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
