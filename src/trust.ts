// Consent store for PROJECT-scoped bundles.json files.
//
// WHY THIS EXISTS
// ~/.yaw-mcp/bundles.json is the user's OWN file and is always trusted --
// nothing here ever gates it. <project>/.yaw-mcp/bundles.json is a
// different thing entirely: it is typically committed to a repo, so
// cloning a hostile repo and opening an editor in it was enough to make
// yaw-mcp spawn whatever argv that file named, as the user, at startup
// (loadLocalBundles let the project file win, entries default to
// isActive:true, and the server prewarms active servers). Peers gate this
// same surface: Claude Code prompts on .mcp.json, VS Code has Workspace
// Trust, direnv has `direnv allow`.
//
// WHY A STORE AND NOT A PROMPT
// yaw-mcp runs as an MCP *stdio* server spawned by the client, so there is
// no TTY at load time and we cannot ask. Consent is therefore granted
// out-of-band via `yaw-mcp trust` (which does have a TTY) and persisted
// here, then consulted at load time.
//
// WHAT IS PINNED
// The store maps an absolute project bundles.json path -> the SHA-256 of
// that file's EXACT BYTES at the moment trust was granted. Hashing the
// content and not just the path is deliberate: a repo you trusted last
// month can add a malicious server in a later commit, and that must
// re-require consent. A hash mismatch is reported as "changed", which the
// loader treats exactly like "never trusted".
//
// FAIL CLOSED
// This is the security boundary, so a missing / malformed / unreadable
// store means NOTHING is trusted. That is deliberately the OPPOSITE of the
// config loader's permissive fail-open posture (right there, wrong here).
//
// FAILING CLOSED IS ABOUT READS, NOT WRITES
// Denying on an unusable store is right; DISCARDING it is not. A store we
// could not READ (antivirus lock, a stray chmod, EIO) almost certainly still
// holds every grant the user made, so rebuilding it from empty would revoke
// every other project over a transient error -- security state destroyed by
// the very code that exists to protect it. A store written by a NEWER schema
// likewise holds real grants, in a shape this build must not reinterpret. A
// store we could not PARSE is genuinely garbage and there is nothing to
// preserve. readTrustStore therefore reports WHICH of the three happened
// (`malformedKind`), all deny, and only the parse case may be overwritten.

import { createHash } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { setJsonKey } from "./json-key.js";
import { log } from "./logger.js";
import { realpathOrSelf, userConfigDir } from "./paths.js";

/** Canonical filename for the trust store, inside ~/.yaw-mcp/. */
export const TRUST_FILENAME = "trusted.json";

/** Schema version emitted by current yaw-mcp. */
export const TRUST_SCHEMA_VERSION = 1;

/**
 * Escape hatch for CI / automation: when set to a truthy value the project
 * trust check is skipped entirely and a project bundles.json loads as it
 * did before this gate existed. Opting out means any repo you run yaw-mcp
 * inside can spawn arbitrary commands as you -- only set it where the
 * checkout is already trusted (your own CI, a container you built).
 */
export const TRUST_BYPASS_ENV = "YAW_MCP_TRUST_PROJECT";

/** One granted consent. */
export interface TrustRecord {
  /** Absolute path as resolved when trust was granted (display form -- the
   *  lookup key is the normalized variant, see normalizeTrustKey). */
  path: string;
  /** SHA-256 (hex) of the file's exact bytes at grant time. */
  sha256: string;
  /** ISO-8601 timestamp of the grant. */
  grantedAt: string;
}

/** In-memory view of ~/.yaw-mcp/trusted.json. */
export interface TrustStore {
  /** Schema version the file declared (defaults to TRUST_SCHEMA_VERSION when
   *  absent). A value ABOVE TRUST_SCHEMA_VERSION makes the whole store
   *  unusable -- see malformedKind "schema". */
  version: number;
  /** normalized-path -> record. Never contains a partially-valid entry. */
  entries: Record<string, TrustRecord>;
  /** True when a store file EXISTS but could not be read or parsed. When
   *  this is set, every lookup denies (fail closed) regardless of entries. */
  malformed: boolean;
  /** Human-readable reason for `malformed`; null otherwise. */
  malformedReason: string | null;
  /**
   * WHY the store is unusable; null when it is healthy.
   *
   *   "io"     -- the file exists but could not be READ (EACCES, EPERM, EIO,
   *               EBUSY, EISDIR...). The grants are almost certainly still on
   *               disk and intact, so this store must never be overwritten.
   *   "schema" -- the file parsed, but declares a schema version NEWER than
   *               this build emits. Its grants are real; their key derivation
   *               or digest may not be the one this build computes, so
   *               reinterpreting them with v1 semantics could match the wrong
   *               file. Deny and tell the user to upgrade -- and never
   *               overwrite, or a downgrade silently revokes everything.
   *   "parse"  -- the bytes were read fine but are not valid JSON, or the
   *               root / `trusted` shape is wrong. Nothing recoverable is in
   *               there, so rebuilding over it loses nothing.
   *
   * All three deny every lookup. The distinction only governs WRITES: only
   * "parse" may be replaced.
   */
  malformedKind: "io" | "schema" | "parse" | null;
  /** errno of the failed read when `malformedKind` is "io" (e.g. "EACCES").
   *  Null otherwise, and null when the platform reported no code. */
  errorCode: string | null;
}

/**
 * Thrown when a trust-store WRITE is refused because the existing store still
 * holds real grants this build must not replace: it could not be read
 * (usually a transient lock), or it was written by a newer schema. Rebuilding
 * in either case silently revokes every project the user approved, so the
 * write does not happen and the caller has to tell the user how to fix it.
 * A separate error type (rather than a flag on the result) so a caller that
 * forgets to check cannot accidentally proceed.
 */
export class TrustStoreUnreadableError extends Error {
  /** Absolute path of the store that could not be used. */
  readonly storePath: string;
  /** errno from the failed read, when the platform gave one. Always null for
   *  the "schema" kind -- nothing failed at the syscall level there. */
  readonly code: string | null;
  /** The store's `malformedReason` -- already names the path and the cause. */
  readonly reason: string;
  /** Why the write was refused, so callers can print the right remedy
   *  (fix permissions vs upgrade yaw-mcp). */
  readonly kind: "io" | "schema";
  constructor(storePath: string, reason: string, code: string | null, kind: "io" | "schema" = "io") {
    super(`refusing to write the trust store: ${reason}`);
    this.name = "TrustStoreUnreadableError";
    this.storePath = storePath;
    this.reason = reason;
    this.code = code;
    this.kind = kind;
  }
}

/** Absolute path to the trust store for a given home. */
export function trustStorePath(home: string = homedir()): string {
  return join(userConfigDir(home), TRUST_FILENAME);
}

/**
 * Canonical lookup key for a bundles.json path.
 *
 * `resolve` collapses `.`/`..`, makes the path absolute, and (on Windows)
 * rewrites forward slashes to backslashes, so `C:/foo` and `C:\foo` agree.
 * Windows AND macOS paths are additionally lowercased because the default
 * filesystems there (NTFS; APFS as Apple ships it) are case-INSENSITIVE --
 * without it, `C:\Repo\...` and `c:\repo\...` (or `/Users/x/Repo` and
 * `/Users/x/repo` on a Mac) name the same file but hash to two different
 * trust entries, so approving from one casing leaves the other casing
 * re-prompting and `trust --list` grows duplicate rows for one project.
 * Linux and the other POSIX platforms are case-sensitive, so their keys are
 * left exactly as resolved. On the RARE case-sensitive APFS volume (opt-in
 * at format time) this folds two genuinely distinct paths into one key; the
 * grant is still pinned to the file's content hash, so what was approved
 * stays byte-exact -- the same trade Windows has always made. NOTE:
 * paths.ts:normalizeForCompare keeps its win32-only split; it compares
 * walk-up boundaries against $HOME, whose casing comes from the OS
 * consistently, so the duplicate-key failure cannot arise there.
 *
 * `platform` is a PARAMETER rather than a read of the global so a test can
 * exercise another platform's folding branch without faking
 * `process.platform` for the duration: that fake also reaches
 * atomic-write.ts (whose rename retry is win32-only) and the POSIX chmod in
 * writeTrustStore, which makes every grant/revoke performed under it flakier
 * than the code being tested. Production callers never pass it.
 *
 * Deliberately LEXICAL and synchronous: no realpath. Every lookup goes
 * through here -- including the read-time fold, once per stored entry, on
 * every readTrustStore (i.e. at server startup) -- so a filesystem walk here
 * would put N uninterruptible syscalls in the startup path (one dead UNC
 * share or disconnected drive letter stalls the event loop) and would make
 * the canonical key depend on live filesystem state. Where a physical
 * spelling is genuinely needed it is resolved at that call site instead; see
 * revokeKeyCandidates.
 */
export function normalizeTrustKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = resolve(p);
  const caseInsensitiveFs = platform === "win32" || platform === "darwin";
  return caseInsensitiveFs ? resolved.toLowerCase() : resolved;
}

/**
 * SHA-256 (hex) of a bundles.json's exact bytes.
 *
 * Callers should pass the raw Buffer, not a decoded string: decoding to
 * UTF-8 and back is lossy for invalid byte sequences, which would let two
 * different files hash identically. The string overload exists only for
 * tests and for callers that already hold text they produced themselves.
 */
export function hashTrustContent(contents: Buffer | string): string {
  return createHash("sha256").update(contents).digest("hex");
}

/** Is the CI/automation escape hatch enabled? Same truthiness convention as
 *  YAW_MCP_DISABLE_PERSISTENCE (persistence.ts:isPersistenceDisabled). */
export function isTrustBypassEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[TRUST_BYPASS_ENV];
  return raw !== undefined && raw !== "" && (raw === "1" || raw.toLowerCase() === "true");
}

function emptyStore(
  kind: "io" | "schema" | "parse" | null = null,
  reason: string | null = null,
  errorCode: string | null = null,
  version: number = TRUST_SCHEMA_VERSION,
): TrustStore {
  return {
    version,
    entries: {},
    malformed: kind !== null,
    malformedReason: reason,
    malformedKind: kind,
    errorCode,
  };
}

/**
 * Read ~/.yaw-mcp/trusted.json.
 *
 * FAIL CLOSED, unlike every other reader in this codebase: an absent store
 * yields an empty (nothing-trusted) store, and a store that exists but is
 * unreadable / unparseable / structurally wrong yields an empty store with
 * `malformed: true` so callers deny instead of silently proceeding. Strict
 * JSON.parse (not parseJsonc): this file is tool-managed, never hand-edited,
 * so accepting comments would only widen what an attacker can smuggle past
 * a reviewer's eye.
 *
 * `malformedKind` splits the failures the readFile / JSON.parse boundary
 * already distinguishes: everything readFile rejects (other than ENOENT) is
 * "io", everything after it is "parse" -- plus "schema" for a store this
 * build is too old to interpret. All deny; only "parse" may be overwritten
 * later. See the FAILING CLOSED IS ABOUT READS note at the top.
 *
 * Individual malformed ENTRIES are dropped (with a log line) rather than
 * poisoning the whole store -- one corrupt record must not silently revoke
 * every other project the user approved.
 *
 * Keys are folded through normalizeTrustKey at READ time, not only at write
 * time. Older builds wrote keys under folding rules that have since changed
 * (the darwin lowercasing arrived after real macOS stores existed, full of
 * mixed-case /Users/... keys), and every lookup goes through the CURRENT
 * normalizeTrustKey -- so without the read-time fold those legacy grants are
 * orphaned: approved projects re-prompt, revoke cannot find the row, and
 * re-granting adds exactly the duplicate `trust --list` row the folding was
 * meant to prevent. Folding here migrates legacy rows on every read (the next
 * write persists the folded form), on both platforms for free. When two
 * legacy keys fold together they name the same file on a case-insensitive
 * filesystem, so keeping both WOULD be the duplicate bug: last write wins.
 *
 * `platform` is forwarded verbatim to that fold; see normalizeTrustKey for
 * why the platform is threaded instead of read off the global.
 */
export async function readTrustStore(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<TrustStore> {
  const path = trustStorePath(home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyStore();
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", "Trust store unreadable; nothing is trusted", { path, error: msg, code });
    return emptyStore("io", `could not read ${path} (${msg})`, code ?? null);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", "Trust store is not valid JSON; nothing is trusted", { path, error: msg });
    return emptyStore("parse", `${path} is not valid JSON (${msg})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyStore("parse", `${path} root must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  // Version FIRST, before the `trusted` shape check: a future schema may not
  // spell the entry map `trusted` at all, and misreporting that as "parse"
  // would let grantTrust rebuild over a store full of real grants.
  //
  // A PRESENT but non-numeric version is a corrupt file, never "assume
  // current": defaulting it to TRUST_SCHEMA_VERSION let a hand edit of
  // `"version": 2` to `"version": "2"` walk straight past the newer-schema
  // guard below and be reinterpreted under v1 semantics -- the one thing that
  // guard exists to prevent. Absent stays "assume current" (v1 stores were
  // written without the field).
  if (obj.version !== undefined && typeof obj.version !== "number") {
    log("warn", "Trust store has a non-numeric version; nothing is trusted", { path });
    return emptyStore("parse", `${path} has a non-numeric "version" field; the store is corrupt`);
  }
  const version = typeof obj.version === "number" ? obj.version : TRUST_SCHEMA_VERSION;
  // The range check is TWO-sided. A version above ours is a real store from a
  // newer build ("schema" below -- denied and never overwritten), but 0, a
  // negative, or a fraction names a schema that has never existed, so the file
  // is corrupt rather than newer. Accepting those as "healthy, current" was
  // the same hole the non-numeric check above closes: `"version": 0` was read
  // with v1 semantics on the strength of a field that says it is not v1.
  // "parse", like every other corrupt shape, so a later grant may rebuild it.
  if (!Number.isInteger(version) || version < 1) {
    log("warn", "Trust store has an out-of-range version; nothing is trusted", { path, version });
    return emptyStore("parse", `${path} has an invalid "version" (${version}); the store is corrupt`);
  }
  if (version > TRUST_SCHEMA_VERSION) {
    log("warn", "Trust store was written by a newer yaw-mcp; nothing is trusted", { path, version });
    return emptyStore(
      "schema",
      `${path} was written by a newer yaw-mcp (schema version ${version}; this build understands ${TRUST_SCHEMA_VERSION})`,
      null,
      version,
    );
  }
  const rawEntries = obj.trusted;
  if (!rawEntries || typeof rawEntries !== "object" || Array.isArray(rawEntries)) {
    return emptyStore("parse", `${path} is missing a 'trusted' object`, null, version);
  }
  const entries: Record<string, TrustRecord> = {};
  for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      log("warn", "Dropping malformed trust entry", { path, key });
      continue;
    }
    const v = value as Record<string, unknown>;
    // A record without a usable hash can never match anything, and treating
    // it as a wildcard would be exactly the bug this module exists to stop.
    if (typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256)) {
      log("warn", "Dropping trust entry with a missing or malformed sha256", { path, key });
      continue;
    }
    // normalizeTrustKey on the STORED key: legacy stores hold keys written
    // under older folding rules (see the read-time fold note above), and only
    // the folded form is reachable by today's lookups. The display `path`
    // keeps the raw key as its fallback -- folding is for matching, not for
    // what the user reads in `trust --list`. setJsonKey, not entries[k]: the
    // key comes straight from the parsed trust file, and plain assignment to
    // "__proto__" would silently drop the record AND repoint `entries`'
    // prototype at it (the fold makes that key absolute today, but the guard
    // must not depend on it staying that way).
    setJsonKey(entries, normalizeTrustKey(key, platform), {
      path: typeof v.path === "string" && v.path.length > 0 ? v.path : key,
      sha256: v.sha256,
      grantedAt: typeof v.grantedAt === "string" ? v.grantedAt : "",
    });
  }
  return { version, entries, malformed: false, malformedReason: null, malformedKind: null, errorCode: null };
}

/** Result of checking one path+content pair against the store. */
export type TrustStatus =
  /** Path is in the store AND the content hash still matches. */
  | "trusted"
  /** Path is in the store but the file's bytes changed since the grant. */
  | "changed"
  /** Path was never granted. */
  | "untrusted"
  /** The store itself is unusable -- deny everything. */
  | "store-unreadable";

/**
 * Classify one path + its exact bytes against an already-loaded store.
 *
 * Every consumer (local-bundles, trust-cmd, doctor) holds a store already and
 * classifies through here, so the file is read once per command; there is no
 * one-shot "load and check" wrapper any more -- one existed, had no caller,
 * and was deleted rather than kept for a hypothetical embedder.
 *
 * NOTE: neither this nor readTrustStore consults TRUST_BYPASS_ENV. The bypass
 * is a LOADER-level policy decision (see local-bundles.ts), not a claim that
 * the file is trusted -- keeping it out of here means `yaw-mcp trust --list`
 * and doctor keep reporting the real state even when the escape hatch is on.
 * That property is pinned by trust.test.ts ("ignores the env escape hatch"),
 * which sets the variable before asserting it changes nothing here.
 */
export function trustStatusFor(path: string, contents: Buffer | string, store: TrustStore): TrustStatus {
  if (store.malformed) return "store-unreadable";
  const record = store.entries[normalizeTrustKey(path)];
  if (!record) return "untrusted";
  return record.sha256 === hashTrustContent(contents) ? "trusted" : "changed";
}

/** Serialize + atomically persist a store. Mode 0600 (the file records
 *  which paths on this machine are allowed to spawn processes; another
 *  local user must not be able to append to it), parent dir 0700. */
async function writeTrustStore(home: string, entries: Record<string, TrustRecord>): Promise<string> {
  const path = trustStorePath(home);
  const body = { version: TRUST_SCHEMA_VERSION, trusted: entries };
  await atomicWriteFile(path, `${JSON.stringify(body, null, 2)}\n`, "utf8", 0o600, 0o700);
  if (process.platform !== "win32") {
    try {
      await chmod(path, 0o600);
    } catch {
      // chmod unsupported on this filesystem; not fatal.
    }
  }
  return path;
}

/**
 * Record consent for `path` pinned to the hash of `contents`.
 *
 * If the store is UNPARSEABLE we start from an EMPTY set rather than
 * refusing: the file is already unusable (every lookup was denying), so the
 * alternative is a user who can never grant anything again. Callers should
 * surface `storeWasMalformed` so the user knows other grants were dropped.
 *
 * If the store is UNREADABLE, or was written by a NEWER schema, this throws
 * TrustStoreUnreadableError and writes nothing. An EACCES/EPERM/EIO/EBUSY at
 * this moment says nothing about the store's contents -- the grants are still
 * there, just behind a lock -- so replacing it would revoke every other
 * approved project because an antivirus scanner happened to hold the file
 * open. A newer-schema store is the same situation with a different cause:
 * its grants are real, so an older binary must not stamp a v1 file over them.
 *
 * The store is read TWICE: once up front so an unusable store is refused
 * before any work, and again immediately before the write so this grant is
 * merged onto whatever is on disk NOW. The gap the second read closes is this
 * function's OWN read-modify-write window -- NOT the [y/N] prompt, which
 * trust-cmd renders and answers BEFORE calling in here, so both reads happen
 * microseconds apart and after the user has decided. That window is small
 * (hashing, then the mkdir + atomic rename inside the write) but not empty: a
 * `yaw-mcp trust` run from another terminal landing inside it would otherwise
 * be reverted by this call's older snapshot. A caller that does hold a store
 * across a prompt of its own has to re-read it there; nothing in here can
 * cover a gap it never sees.
 */
export async function grantTrust(
  path: string,
  contents: Buffer | string,
  opts: { home?: string; now?: () => number; platform?: NodeJS.Platform } = {},
): Promise<{ storePath: string; record: TrustRecord; storeWasMalformed: boolean }> {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const store = await readTrustStore(home, platform);
  refuseUnusableStore(home, store);
  const record: TrustRecord = {
    path: resolve(path),
    sha256: hashTrustContent(contents),
    grantedAt: new Date(opts.now ? opts.now() : Date.now()).toISOString(),
  };
  // Re-read and merge. The refusal is repeated on the fresh read: a store that
  // became unreadable (or was replaced by a newer-schema one) while we were
  // deciding must not be stamped over either.
  const fresh = await readTrustStore(home, platform);
  refuseUnusableStore(home, fresh);
  // Only the "parse" case reaches here, where there is nothing to preserve.
  const entries = fresh.malformed ? {} : { ...fresh.entries };
  // setJsonKey, not entries[k] = record, for the same reason the read fold
  // uses it (see there): the guard must hold on its own rather than on
  // normalizeTrustKey happening to return an absolute path. `path` is
  // caller-supplied and this is the one write that names the key.
  setJsonKey(entries, normalizeTrustKey(path, platform), record);
  const storePath = await writeTrustStore(home, entries);
  log("info", "Granted project bundles.json trust", { path: record.path, sha256: record.sha256 });
  // Either read seeing garbage means grants were dropped, so the caller's
  // "your other approvals are gone" note must fire for both.
  return { storePath, record, storeWasMalformed: store.malformed || fresh.malformed };
}

/** Throw TrustStoreUnreadableError when `store` holds real grants this build
 *  must not replace (unreadable, or written by a newer schema). Shared by the
 *  pre-check and the pre-write re-check so both refuse identically. */
function refuseUnusableStore(home: string, store: TrustStore): void {
  const kind = store.malformedKind;
  if (kind !== "io" && kind !== "schema") return;
  throw new TrustStoreUnreadableError(
    trustStorePath(home),
    store.malformedReason ?? `could not use ${trustStorePath(home)}`,
    store.errorCode,
    kind,
  );
}

/**
 * Every lookup key a revoke has to clear: the caller's own spelling, plus the
 * PHYSICAL one (parent realpath'd, basename rejoined). A revoke removes ALL of
 * them that are present, not the first hit -- both can name one bundles.json in
 * the same store, and leaving either behind keeps the file trusted.
 *
 * Grants are keyed physically in practice. Every `yaw-mcp trust` grant reaches
 * the store through findProjectConfigDir, which realpaths the project dir, so
 * a checkout reached through a symlink, a Windows junction, or an 8.3-short
 * prefix is stored under its RESOLVED spelling. `--revoke <path>` takes
 * whatever the user typed, so a lexical-only key missed that row and the
 * command answered "was not approved (nothing to do)" with exit 0 -- a false
 * confirmation on a consent-WITHDRAWAL command, with the grant still live and
 * the project's bundles.json still loading.
 *
 * Only the PARENT is resolved: a symlinked bundles.json must keep keying under
 * the project that contains it, which is what a grant stores. realpathOrSelf,
 * so a path whose target no longer exists degrades to the lexical key instead
 * of throwing -- and the extra candidate can only ever find a row, never hide
 * one, so this cannot make a trusted project untrusted.
 *
 * Confined to revoke on purpose. Doing the same inside normalizeTrustKey would
 * put a synchronous realpath per entry in every store read -- server startup
 * included -- and make the canonical key depend on live filesystem state.
 */
async function revokeKeyCandidates(p: string, platform: NodeJS.Platform): Promise<string[]> {
  const lexical = normalizeTrustKey(p, platform);
  const resolved = resolve(p);
  const physical = normalizeTrustKey(join(await realpathOrSelf(dirname(resolved)), basename(resolved)), platform);
  return physical === lexical ? [lexical] : [lexical, physical];
}

/**
 * Drop consent for `path` -- EVERY row that names it, in one write, not just
 * the first candidate key that matches (see revokeKeyCandidates). Returns
 * removed:false when the path was not in the store (a no-op revoke is a
 * success -- "make it absent" happened) or when the store is malformed.
 *
 * A malformed store is REPORTED rather than rewritten: nothing is trusted
 * while it is unusable, so there is nothing for a revoke to remove, and
 * rebuilding it would turn a withdrawal into a destructive write the user
 * never asked for. That preservation is revoke-local, and deliberately so --
 * grantTrust DOES rebuild over a parse-malformed store (it must, or the user
 * could never grant anything again), so the damaged bytes survive only until
 * the next `yaw-mcp trust` anywhere on the machine. Treat them as a file to
 * inspect NOW, not as an archive.
 *
 * Like grantTrust, the store is re-read immediately before the write so a
 * concurrent grant from another terminal is preserved instead of being
 * reverted by this command's older snapshot.
 *
 * A refused revoke reports WHICH kind of unusable store it met
 * (`malformedKind` / `malformedReason`, the same triple readTrustStore
 * classifies), not just that it was one: the three kinds carry three
 * different remedies (fix permissions / upgrade / delete), and collapsing them
 * to a boolean forced trust-cmd to read the store a second time just to
 * recover the distinction this function had already made.
 */
export interface RevokeTrustResult {
  storePath: string;
  /** True when a row was removed; false for a no-op revoke AND for a refused
   *  one -- `storeWasMalformed` tells the two apart. */
  removed: boolean;
  /** True when the store was unusable, so nothing could be (or was) revoked. */
  storeWasMalformed: boolean;
  /** Why the store was unusable -- see TrustStore.malformedKind. Null when it
   *  was fine. */
  malformedKind: TrustStore["malformedKind"];
  malformedReason: string | null;
}

export async function revokeTrust(
  path: string,
  opts: { home?: string; platform?: NodeJS.Platform } = {},
): Promise<RevokeTrustResult> {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const store = await readTrustStore(home, platform);
  const storePath = trustStorePath(home);
  const refused = (s: TrustStore): RevokeTrustResult => ({
    storePath,
    removed: false,
    storeWasMalformed: true,
    malformedKind: s.malformedKind,
    malformedReason: s.malformedReason,
  });
  const done = (removed: boolean): RevokeTrustResult => ({
    storePath,
    removed,
    storeWasMalformed: false,
    malformedKind: null,
    malformedReason: null,
  });
  if (store.malformed) return refused(store);
  const candidates = await revokeKeyCandidates(path, platform);
  // Object.hasOwn, not `in`: entries comes from JSON.parse and carries
  // Object.prototype, so `"toString" in entries` is true for every store.
  // normalizeTrustKey yields an absolute path today, which is why this was
  // never reachable -- the guard must not depend on that staying true.
  //
  // filter, not find: ALL matching rows go, not just the first. One
  // bundles.json can legitimately hold BOTH candidate keys -- findProjectConfigDir
  // was purely lexical until it started realpath'ing the project dir, so a
  // checkout reached through a symlink granted a lexical row then, and the
  // re-grant every upgrade forces (the key derivation changed under it) adds
  // the physical one beside it. Removing one and reporting "Revoked" left the
  // survivor keeping the file trusted and loading -- a false confirmation on a
  // consent-WITHDRAWAL command, the same class of bug the physical candidate
  // was added to fix.
  const keys = candidates.filter((c) => Object.hasOwn(store.entries, c));
  if (keys.length === 0) return done(false);
  const fresh = await readTrustStore(home, platform);
  if (fresh.malformed) return refused(fresh);
  const present = keys.filter((k) => Object.hasOwn(fresh.entries, k));
  if (present.length === 0) return done(false);
  const entries = { ...fresh.entries };
  for (const k of present) delete entries[k];
  await writeTrustStore(home, entries);
  log("info", "Revoked project bundles.json trust", { path: resolve(path) });
  return done(true);
}

/** Every granted record in an already-loaded store, sorted by display path.
 *  Empty when the store is malformed (nothing is trusted then). The pure half
 *  of listTrusted, for a caller that already holds the store: trust-cmd's
 *  --list reads it once to name the failure kind and must not read it a
 *  second time just to render the rows. */
export function trustedRecords(store: TrustStore): TrustRecord[] {
  if (store.malformed) return [];
  return Object.values(store.entries).sort((a, b) => a.path.localeCompare(b.path));
}

/** Every granted record, sorted by display path. Empty when the store is
 *  absent OR malformed (nothing is trusted in either case). */
export async function listTrusted(opts: { home?: string } = {}): Promise<TrustRecord[]> {
  return trustedRecords(await readTrustStore(opts.home ?? homedir()));
}
