// Cross-session persistence for session-scoped signal (learning +
// detected packs + learned tool lists). Stored at `~/.yaw-mcp/state.json`.
// Functions with no state of their own except `saveChain` (see saveState),
// which serializes every save in this process -- ConnectServer owns the
// load/save lifecycle.
//
// Design principles:
//   - Silent failure. A corrupt or unreadable state file must never
//     prevent yaw-mcp from starting. Missing file returns empty state;
//     parse errors log once and also return empty state.
//   - Schema-versioned. An UNREADABLE version drops the old state
//     entirely rather than trying to migrate — the signal is small and
//     cheap to rebuild, and migration bugs would corrupt fresh data. A
//     purely ADDITIVE bump (v1 -> v2 added `toolCache`) is the one case
//     that migrates instead, since there is no field to reinterpret:
//     the missing key simply reads as empty. See READABLE_STATE_VERSIONS.
//   - Privacy-conserving. Only namespace names, tool names, and tool
//     descriptions (all schema identifiers published by the upstream
//     server, not user inputs) are persisted. No tool arguments,
//     response payloads, or credentials ever touch disk.
//   - Bounded. The tool cache is capped on both read and write — see
//     the TOOLCACHE_* limits — so a long-lived install can't grow
//     state.json without limit.
//   - Atomic writes. Write-rename so a crash mid-flush can't leave
//     half-written JSON where the loader would see garbage.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { setJsonKey } from "./json-key.js";
import { log } from "./logger.js";
import { userConfigDir } from "./paths.js";

export const STATE_SCHEMA_VERSION = 2;
export const STATE_FILENAME = "state.json";

/** The env var that turns this whole module off. */
export const DISABLE_PERSISTENCE_ENV = "YAW_MCP_DISABLE_PERSISTENCE";

/**
 * Opt-out for cross-session persistence: `YAW_MCP_DISABLE_PERSISTENCE=1` (or
 * "true") keeps learning + pack history scoped to the current process --
 * nothing is loaded at start, nothing is written on shutdown. Intended for
 * ephemeral/shared environments (CI runners, containers, on-call relief boxes)
 * where a stale state file would lie about recent usage patterns.
 *
 * THE single source of truth for that truthiness rule, and it lives here
 * because this is the module the flag actually disables. Three copies used to
 * exist -- server.ts (process.env), doctor-cmd.ts (injected env), and an
 * open-coded expression in reset-learning-cmd.ts. They agreed, but nothing made
 * them: the first one to start accepting "yes"/"on" would have doctor reporting
 * persistence ON while the server had it OFF, or `reset-learning` deleting the
 * file a running broker still believed it owned.
 *
 * `env` is a parameter rather than a straight `process.env` read because the
 * CLI commands thread an injected environment (doctor's `opts.env`), and a
 * predicate they cannot pass their own env to is a predicate they cannot share.
 * The default is evaluated per call, so a test mutating process.env between
 * calls still gets the current value.
 */
export function isPersistenceDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DISABLE_PERSISTENCE_ENV];
  if (raw === undefined || raw === "") return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

// Versions loadState will still read. v1 is identical to v2 minus the
// `toolCache` key, so it migrates for free: the user keeps the learning
// and pack signal they already earned, and the tool cache starts empty
// (one final pre-warm repopulates it). The first save rewrites the file
// at STATE_SCHEMA_VERSION.
const READABLE_STATE_VERSIONS: ReadonlySet<number> = new Set([1, STATE_SCHEMA_VERSION]);

/** True when loadState can read a state file carrying this `version`.
 *  Exported so callers that peek at the raw file (doctor, reset-learning)
 *  can classify it the same way the loader does instead of comparing
 *  against STATE_SCHEMA_VERSION alone. */
export function isReadableStateVersion(version: unknown): boolean {
  return typeof version === "number" && READABLE_STATE_VERSIONS.has(version);
}

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

/** One tool as learned from a live upstream handshake. Mirrors the shape
 *  of `UpstreamServerConfig.toolCache` entries so the two are
 *  interchangeable at the call sites that read either. */
export interface PersistedTool {
  name: string;
  description?: string;
}

/** A namespace's learned tool list plus when it was learned. `learnedAt`
 *  drives both TTL expiry and the eviction order when the namespace cap
 *  is exceeded. */
export interface PersistedToolCacheEntry {
  tools: PersistedTool[];
  learnedAt: number;
}

// Bounds on the persisted tool cache. Without these, state.json grows with
// every server a user ever activates and never shrinks. Applied on BOTH
// load and save so a hand-edited or older oversized file is trimmed on the
// way in, not just on the way out.
/** Keep at most this many namespaces — the most recently learned win. */
export const TOOLCACHE_MAX_NAMESPACES = 64;
/** Keep at most this many tools per namespace. */
export const TOOLCACHE_MAX_TOOLS_PER_NAMESPACE = 512;
/** Truncate a tool description past this many characters. Real MCP
 *  descriptions run 80-150 chars, so this only bites on pathological input. */
export const TOOLCACHE_MAX_DESCRIPTION_CHARS = 2000;
/** Drop entries older than this. Bounds staleness: a server that gained or
 *  renamed tools gets re-learned by the next pre-warm after expiry. */
export const TOOLCACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface PersistedState {
  version: number;
  savedAt: number;
  learning: Record<string, PersistedLearningUsage>;
  packHistory: PersistedPackCall[];
  /** Learned tool lists keyed by namespace. Added in schema v2; absent in
   *  a v1 file, which reads as `{}`. */
  toolCache: Record<string, PersistedToolCacheEntry>;
  /** Set by loadState when the file EXISTS but could not be READ (EACCES,
   *  EBUSY, EISDIR, ...). The state on disk is presumed healthy, so the
   *  caller must not save over it with the empty state returned alongside
   *  this flag -- server.ts leaves persistenceReady false for the session.
   *  Never set for ENOENT/ENOTDIR (no file to protect) or for a
   *  parse/version failure (the file is genuinely unusable; overwriting it
   *  with fresh state is the documented start-over behavior). Never
   *  persisted: saveState builds its own object from the fields it is
   *  handed. */
  loadFailed?: boolean;
}

export function statePath(configDir: string = userConfigDir()): string {
  return path.join(configDir, STATE_FILENAME);
}

export function emptyState(): PersistedState {
  return { version: STATE_SCHEMA_VERSION, savedAt: 0, learning: {}, packHistory: [], toolCache: {} };
}

/** How many entries the FILE carried, counted before sanitization dropped
 *  anything. Zero across the board when there was no file, or when it could
 *  not be read/parsed (nothing was counted, so nothing is claimed). */
export interface RawStateCounts {
  learning: number;
  packHistory: number;
  toolCache: number;
}

const NO_RAW_COUNTS: RawStateCounts = { learning: 0, packHistory: 0, toolCache: 0 };

/** loadState's result plus how the file was classified on the way in. */
export interface ClassifiedState {
  state: PersistedState;
  /**
   * Pre-sanitization entry counts (see RawStateCounts). The sanitized `state`
   * is what yaw-mcp will USE; these are what the file HELD, and the two differ
   * whenever an entry was dropped -- a TTL-expired tool cache, a hand-edited
   * learning row with a negative `lastUsedAt`. A caller reporting on a file it
   * is about to delete (reset-learning) must use these, or it tells the user
   * "0 entries removed" about a file that really held five.
   */
  rawCounts: RawStateCounts;
  /**
   * True when the returned state reflects what was actually ON DISK: the file
   * parsed as an object at a readable version, or there was no file at all
   * (nothing to misreport). False when the returned state is the empty
   * fallback standing in for real content we could not use -- an unreadable
   * file, invalid JSON, a non-object root, or an unreadable schema version.
   *
   * Exists so a caller that REPORTS on the file (reset-learning) can tell
   * "0 entries" from "we could not read it" without a second read+parse of
   * the same bytes -- the shape that let the peek's parser drift from this
   * one (a BOM was accepted here and rejected there, so a perfectly good
   * state file was reported as unreadable).
   */
  parsedCleanly: boolean;
}

// Load persisted state from disk. Always returns a PersistedState
// object — on any failure (missing file, bad JSON, version mismatch,
// sanitization drops everything) we silently fall through to empty.
export async function loadState(filePath: string = statePath()): Promise<PersistedState> {
  return (await loadStateClassified(filePath)).state;
}

// loadState plus the parsedCleanly classification. THE single read+parse of
// the state file: loadState is a thin wrapper over this, so a caller that
// needs both cannot end up with two parsers that disagree.
export async function loadStateClassified(filePath: string = statePath()): Promise<ClassifiedState> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    // ENOENT: no file. ENOTDIR: a path component is a regular file, so the
    // state file CANNOT exist either -- both mean "nothing to protect",
    // start empty. Same split as grades-cache/config-loader. Clean, not
    // failed: with no file on disk the empty state IS what is there.
    if (isFileNotFound(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR")
      return { state: emptyState(), rawCounts: NO_RAW_COUNTS, parsedCleanly: true };
    // The file EXISTS but we could not read it -- a transient handle error
    // (win32 AV/indexer EBUSY, EACCES) on a presumed-HEALTHY file. Flag it
    // so the caller does not overwrite real learning/packHistory/toolCache
    // with the empty state we are about to return: without the flag, one
    // transient read error plus one debounced save silently wiped the file.
    //
    // The message describes what THIS function did, not what the caller will
    // do next: it used to promise "state saves are disabled for this session",
    // which is true for server.ts and flatly false for reset-learning, whose
    // very next act is to delete the file.
    log("warn", "Could not read yaw-mcp state file; flagged unreadable so a save cannot overwrite it", {
      error: errorMessage(err),
    });
    return { state: { ...emptyState(), loadFailed: true }, rawCounts: NO_RAW_COUNTS, parsedCleanly: false };
  }
  try {
    // Strip a leading UTF-8 BOM (U+FEFF) before parsing -- same strip
    // parseJsonc (jsonc.ts) does, for the same reason: Notepad on Windows
    // defaults to BOM-prefixed UTF-8, and JSON.parse rejects the BOM. This
    // module explicitly anticipates hand-edited state files (see
    // sanitizeLearning); without the strip, one Notepad save would drop ALL
    // learning, pack history, and tool cache via the empty-state fallback.
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (!parsed || typeof parsed !== "object")
      return { state: emptyState(), rawCounts: NO_RAW_COUNTS, parsedCleanly: false };
    // Any version loadState can READ counts as clean, not just the current
    // one: v1 MIGRATES (see READABLE_STATE_VERSIONS), so treating it as
    // unreadable would discard real counts for the one session before the
    // first save rewrites the file.
    if (!isReadableStateVersion((parsed as { version?: unknown }).version))
      return { state: emptyState(), rawCounts: NO_RAW_COUNTS, parsedCleanly: false };
    const p = parsed as Record<string, unknown>;
    return {
      state: {
        version: STATE_SCHEMA_VERSION,
        savedAt: typeof p.savedAt === "number" ? p.savedAt : 0,
        learning: sanitizeLearning(p.learning),
        packHistory: sanitizePackHistory(p.packHistory),
        // Absent on a v1 file -> sanitizeToolCache(undefined) -> {}. That IS
        // the v1 -> v2 migration; no other field changed shape.
        toolCache: sanitizeToolCache(p.toolCache),
      },
      // Counted off `p`, BEFORE the sanitizers above run: what the file held,
      // not what survived. See RawStateCounts.
      rawCounts: {
        learning: countRawEntries(p.learning),
        packHistory: countRawEntries(p.packHistory),
        toolCache: countRawEntries(p.toolCache),
      },
      parsedCleanly: true,
    };
  } catch (err) {
    // Reached only for a parse failure -- read errors are handled above.
    // The file is genuinely unusable, so starting fresh (and letting the
    // next save replace it) is the intended behavior; no loadFailed flag.
    log("warn", "Failed to load yaw-mcp state, starting fresh", { error: errorMessage(err) });
    return { state: emptyState(), rawCounts: NO_RAW_COUNTS, parsedCleanly: false };
  }
}

/** Count entries in a raw (unsanitized) state section: object keys for the
 *  learning/toolCache maps, elements for the packHistory array. Anything that
 *  is not an object or array held no entries, so it counts as 0. */
function countRawEntries(input: unknown): number {
  if (!input || typeof input !== "object") return 0;
  return Array.isArray(input) ? input.length : Object.keys(input).length;
}

// In-process serializer. Two saveState calls debounced too close in time
// would otherwise race -- both would mkdir, both would write to distinct
// .tmp- files (the pid-timestamp suffix makes the temp names unique),
// and both would rename onto the same target. Atomic-rename means we
// never see torn JSON, but the loser's increments are silently dropped.
// Chaining via this promise serializes the writes -- ONE chain for every
// path, not one per path: the only file anything saves is ~/.yaw-mcp/
// state.json, so per-path granularity would buy nothing. The .catch reset
// keeps a failed save from poisoning the chain for subsequent callers.
//
// The cross-process race (two yaw-mcp instances writing the same file) is
// a separate problem that needs an OS-level file lock; not handled here.
let saveChain: Promise<void> = Promise.resolve();

// Save persisted state to disk atomically. Best-effort -- failures log
// but never throw, since a missing save shouldn't crash the session.
// `toolCache` is optional so the many callers that only carry learning +
// pack history (tests, and any future partial writer) keep compiling; an
// omitted cache persists as `{}` rather than silently preserving whatever
// was on disk -- the caller always owns the full snapshot.
export type SavableState = Pick<PersistedState, "learning" | "packHistory"> &
  Partial<Pick<PersistedState, "toolCache">>;

export function saveState(state: SavableState, filePath: string = statePath()): Promise<void> {
  const next = saveChain.then(() => doSaveState(state, filePath));
  saveChain = next.catch(() => undefined);
  return next;
}

async function doSaveState(state: SavableState, filePath: string): Promise<void> {
  const payload: PersistedState = {
    version: STATE_SCHEMA_VERSION,
    savedAt: Date.now(),
    learning: state.learning,
    packHistory: state.packHistory,
    // Sanitize on the way out too: the caps must hold for the bytes we
    // WRITE, not merely for what a later load is willing to read back.
    toolCache: sanitizeToolCache(state.toolCache),
  };
  try {
    await atomicWriteFile(filePath, JSON.stringify(payload, null, 2));
  } catch (err) {
    log("warn", "Failed to save yaw-mcp state", { error: errorMessage(err) });
  }
}

function sanitizeLearning(input: unknown): Record<string, PersistedLearningUsage> {
  // Arrays are rejected outright, exactly like sanitizeToolCache does: without
  // the check, a hand-edited `"learning": [{...}]` walks Object.entries and
  // lands as namespaces literally named "0", "1", "2" -- entries that can
  // never match a real namespace but do occupy the learning map forever.
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, PersistedLearningUsage> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!k) continue;
    if (!v || typeof v !== "object") continue;
    const u = v as Record<string, unknown>;
    if (typeof u.dispatched !== "number" || !Number.isFinite(u.dispatched) || u.dispatched < 0) continue;
    if (typeof u.succeeded !== "number" || !Number.isFinite(u.succeeded) || u.succeeded < 0) continue;
    if (typeof u.lastUsedAt !== "number" || !Number.isFinite(u.lastUsedAt) || u.lastUsedAt < 0) continue;
    // succeeded cannot exceed dispatched — clamp rather than reject so we
    // salvage otherwise-valid entries from corrupted/hand-edited state files.
    const succeeded = Math.min(u.succeeded, u.dispatched);
    // setJsonKey, not out[k]: k comes from a parsed (and per the comment
    // above, possibly hand-edited) state file, and plain assignment to
    // "__proto__" would drop the entry AND repoint `out`'s prototype at it.
    setJsonKey(out, k, { dispatched: u.dispatched, succeeded, lastUsedAt: u.lastUsedAt });
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

/**
 * Coerce the persisted tool cache into shape, dropping anything malformed
 * and enforcing every TOOLCACHE_* bound.
 *
 * Drops, in order: non-object input, entries with a blank namespace, a
 * non-object body, or a non-finite/negative `learnedAt`; entries older than
 * TOOLCACHE_TTL_MS; tools without a usable name; and entries whose tools ALL
 * failed that name check -- a raw list that collapsed to empty is corruption,
 * not an observation. A GENUINELY empty `tools: []` is KEPT: a
 * resources/prompts-only upstream really does expose zero tools, and dropping
 * that answer is what made pre-warm re-spawn such a server every session (see
 * the inline note at the length check below). Survivors are then trimmed to
 * the most recently learned TOOLCACHE_MAX_NAMESPACES.
 */
function sanitizeToolCache(input: unknown): Record<string, PersistedToolCacheEntry> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  // Read the clock once so every entry is aged against the same instant --
  // a per-entry Date.now() could expire one entry and keep its neighbour
  // across a TTL boundary. This used to be a `now` parameter defaulted to
  // Date.now(), documented as test-injectable, but no caller ever passed
  // one: both call sites hand it a single argument. Tests pin TTL behavior
  // by choosing `learnedAt` relative to Date.now() instead.
  const now = Date.now();
  const kept: Array<[string, PersistedToolCacheEntry]> = [];
  for (const [namespace, value] of Object.entries(input as Record<string, unknown>)) {
    if (!namespace) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const learnedAt = entry.learnedAt;
    if (typeof learnedAt !== "number" || !Number.isFinite(learnedAt) || learnedAt < 0) continue;
    // A future timestamp (clock skew, a hand-edited file) is kept rather
    // than expired -- `now - learnedAt` is negative, so it can't exceed the
    // TTL. Expiry only ever drops entries that are genuinely old.
    if (now - learnedAt > TOOLCACHE_TTL_MS) continue;
    if (!Array.isArray(entry.tools)) continue;
    const tools: PersistedTool[] = [];
    for (const raw of entry.tools) {
      if (tools.length >= TOOLCACHE_MAX_TOOLS_PER_NAMESPACE) break;
      if (!raw || typeof raw !== "object") continue;
      const t = raw as Record<string, unknown>;
      if (typeof t.name !== "string" || !t.name) continue;
      const description =
        typeof t.description === "string" ? t.description.slice(0, TOOLCACHE_MAX_DESCRIPTION_CHARS) : undefined;
      tools.push(description === undefined ? { name: t.name } : { name: t.name, description });
    }
    // A GENUINELY empty list is a known state, not a missing one: an upstream
    // that exposes only resources/prompts really does have zero tools, and
    // dropping the entry here (on both the save and the load path) is what
    // made pre-warm re-spawn such a server on every single session start --
    // it could never record the answer it had already paid for.
    //
    // An entry whose tools were ALL rejected above is a different thing:
    // that is a corrupt or hand-edited file, not a zero-tool server, so it
    // is still dropped and re-learned. The raw length is what separates them.
    if (tools.length === 0 && Array.isArray(entry.tools) && entry.tools.length > 0) continue;
    kept.push([namespace, { tools, learnedAt }]);
  }

  // Namespace cap: newest-learned wins. Sorting only when over the cap keeps
  // the common path (a handful of namespaces) allocation-free.
  if (kept.length > TOOLCACHE_MAX_NAMESPACES) {
    kept.sort((a, b) => b[1].learnedAt - a[1].learnedAt);
    kept.length = TOOLCACHE_MAX_NAMESPACES;
  }
  return Object.fromEntries(kept);
}

/** True for an ENOENT errno -- "the file is not there", as distinct from
 *  "the file is there and something went wrong reading it". Exported because
 *  reset-learning needs exactly this split on its unlink (ENOENT is the benign
 *  nothing-to-reset path, anything else is a real I/O failure) and used to
 *  carry a byte-identical private copy: two predicates that could drift into
 *  disagreeing about which errnos are benign. */
export function isFileNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
