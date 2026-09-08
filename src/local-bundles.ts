// Local server-definitions file -- the source of truth for which MCP
// servers yaw-mcp loads when running in "no account" Free mode.
//
// File path: ~/.yaw-mcp/bundles.json (user-global) or
//            <project>/.yaw-mcp/bundles.json (project-local override).
//
// Project-local FULLY overrides user-global -- no merge. That keeps the
// mental model simple: if you've committed a .yaw-mcp/bundles.json with
// your repo, the team gets exactly that set, no surprises from a
// teammate's user-global file leaking in.
//
// SECURITY: that override only applies to a project file the user has
// EXPLICITLY approved via `yaw-mcp trust` (see trust.ts). A project
// bundles.json is usually committed to a repo, so without a consent gate
// cloning a hostile repo and starting an MCP client inside it was enough to
// spawn its argv as you -- entries default to isActive:true and the server
// prewarms active servers at startup. An UNTRUSTED project file is ignored
// completely: none of its servers load, AND it does not suppress the
// user-global file (suppressing it would be a denial-of-service variant of
// the same bug -- a hostile repo blanking out your real servers). That
// covers a project file yaw-mcp cannot READ, too: unreadability is
// attacker-controlled from inside a repo (commit `.yaw-mcp` as a regular
// file -> ENOTDIR; commit `bundles.json` as a symlink loop -> ELOOP), so an
// unreadable file counts as authoritative only when its path was approved
// before -- see projectFileIsHonoured. The user-global
// ~/.yaw-mcp/bundles.json is the user's own file and is NEVER gated.
// YAW_MCP_TRUST_PROJECT=1 opts out of the check for CI/automation.
//
// If neither file exists, yaw-mcp starts with an empty server list and
// surfaces the "no servers configured" hint pointing at `yaw-mcp add <slug>`
// (NOT `install`, which connects a CLIENT to yaw-mcp).
//
// Exception to winner-takes-all: the top-level `defaultRuntime` knob
// ("oam" | "node") is a MACHINE-level preference, not a server definition --
// a shared bundles.json committed to a repo has no per-machine concept of
// "oam is installed here", so a project file that does not set it falls back
// to the user-global value instead of silently turning it off. See
// default-runtime.ts for the resolution order
// (YAW_MCP_DEFAULT_RUNTIME env > this file's defaultRuntime > unset).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
// The cross-process write lock reuses the auto-upgrade lock primitive (O_EXCL
// sidecar, ownership-checked release, stale steal by rename) instead of
// growing a second copy here. See the write-path header for what it buys.
import { acquireUpgradeLock } from "./auto-upgrade.js";
import { parseJsonc } from "./jsonc.js";
import { log } from "./logger.js";
import { findProjectConfigDir, userConfigDir } from "./paths.js";
import {
  hashTrustContent,
  isTrustBypassEnabled,
  normalizeTrustKey,
  readTrustStore,
  TRUST_BYPASS_ENV,
  type TrustStatus,
  trustStatusFor,
  trustStorePath,
} from "./trust.js";
import type { ConnectConfig, UpstreamServerConfig } from "./types.js";

/** Canonical filename for the local bundles file. */
export const BUNDLES_FILENAME = "bundles.json";

/** Schema version emitted by current yaw-mcp. Older files load fine
 *  (back-compat is permissive); newer files trigger a warning. */
export const CURRENT_BUNDLES_SCHEMA_VERSION = 1;

/** The on-disk shape. Mirrors ConnectConfig but with `version` (a schema
 *  version the file may carry) instead of `configVersion`, which is never
 *  stored: the loader derives it from a content hash (see hashContent). */
export interface LocalBundlesFile {
  version?: number;
  servers: Array<Partial<UpstreamServerConfig>>;
  /** Config-level default runtime for servers that don't set a per-server
   *  `runtime`. Per-server `"node"` stays an escape hatch under a default of
   *  `"oam"`. Applied in connectToUpstream (via default-runtime.ts) rather than
   *  at load time because the effective default is a MACHINE fact -- whether
   *  oam is installed on the box that spawns the sidecar -- not a property of
   *  the file. */
  defaultRuntime?: "oam" | "node";
}

/** Build the absolute path to bundles.json inside a given config dir. */
export function localBundlesPath(configDir: string): string {
  return join(configDir, BUNDLES_FILENAME);
}

/** Canonical regex for valid MCP server namespaces. validateEntry below is
 *  the only production consumer left -- the remote-config fetcher (config.ts)
 *  that used to share it was deleted with the hosted backend. Still exported
 *  so the test suite (and any future validator) pins the SAME definition
 *  instead of maintaining an independent copy that drifts from the loader's. */
export const NAMESPACE_RE = /^[a-z][a-z0-9_]{0,29}$/;

/** Coerce a raw entry from bundles.json into a strict UpstreamServerConfig.
 *  Returns null when required fields are missing or malformed so the loader
 *  can skip the entry with a warning instead of crashing the whole load. */
function validateEntry(entry: unknown, warnings: string[]): UpstreamServerConfig | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    warnings.push("bundles.json: skipping non-object server entry");
    return null;
  }
  const e = entry as Record<string, unknown>;

  const namespace = typeof e.namespace === "string" ? e.namespace : "";
  if (!namespace || !NAMESPACE_RE.test(namespace)) {
    warnings.push(`bundles.json: skipping server with invalid namespace ${JSON.stringify(namespace)}`);
    return null;
  }
  const name = typeof e.name === "string" && e.name.length > 0 ? e.name : namespace;
  // Default type to "local" -- bundles.json is the local-mode file by
  // definition. Existing configs use "local" for stdio/spawned
  // servers and "remote" for HTTP/SSE; users can override via the field.
  const type: "local" | "remote" = e.type === "remote" ? "remote" : "local";
  const transport =
    e.transport === "streamable-http" || e.transport === "sse" || e.transport === "stdio"
      ? (e.transport as "stdio" | "streamable-http" | "sse")
      : undefined;

  // Stdio servers need command; remote servers need url. Don't enforce
  // here -- the upstream connector will surface a clear error if the
  // entry can't be spawned/dialed. The validator's job is shape, not
  // semantics.
  const command = typeof e.command === "string" ? e.command : undefined;
  const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === "string") : undefined;
  // String values only -- and DROP blank ones. `yaw-mcp add` seeds every
  // required key with "" to record the requirement while deliberately NOT
  // persisting the ambient shell value ("" means "nothing stored; the server
  // depends on that var being in the shell wherever yaw-mcp launches"). The
  // spawn env is `{ ...parentEnv, ...serverEnv }` (upstream.ts), so a loaded
  // "" would CLOBBER the inherited shell value and start the server with the
  // var blanked -- the opposite of what `add` prints. Dropping blanks here
  // keeps the on-disk seed intact (the raw file still documents the required
  // keys for the removal preview and `add --json`) while every loader
  // consumer (spawn, `audit`, `list`) sees only the values actually stored.
  // Trim-blank, not just === "", matching the add path's uniform treatment of
  // whitespace-only values as missing.
  const env =
    e.env && typeof e.env === "object" && !Array.isArray(e.env)
      ? (Object.fromEntries(
          Object.entries(e.env as Record<string, unknown>).filter(([, v]) => typeof v === "string" && v.trim() !== ""),
        ) as Record<string, string>)
      : undefined;
  const url = typeof e.url === "string" ? e.url : undefined;
  const description = typeof e.description === "string" ? e.description : undefined;
  // Per-server runtime override. "oam" hosts the server on the oam runtime
  // (connectToUpstream's resolveOamSpawn rewrites node/npx -> `oam run`).
  // Absent = oam when it is installed and meets MIN_OAM_VERSION, else node (see
  // default-runtime.ts for the full resolution order). An explicit "node" is the
  // escape hatch that keeps a server off oam. Without propagating this here, a
  // bundles.json `"runtime": "oam"` is silently dropped and never reaches the
  // resolver -- and note that absent must stay UNDEFINED rather than being
  // normalized to "node": normalizing would pin every unconfigured server off
  // oam, and per-server wins over YAW_MCP_DEFAULT_RUNTIME (upstream.ts), so
  // nothing could undo it.
  const runtime = e.runtime === "oam" || e.runtime === "node" ? e.runtime : undefined;

  // Per-server connect timeout (types.ts). Carried through for the same reason
  // as `runtime` above: the return below is a fixed whitelist, so a field
  // missing from it is DROPPED, and bundles.json is now the only server source
  // -- without this line nothing in the process can ever set the value
  // connectToUpstream reads, and a user's `"connectTimeoutMs": 60000` silently
  // falls back to the global default. Non-numeric and non-positive values are
  // dropped rather than passed on: upstream ignores anything <= 0 anyway, and
  // dropping keeps a typo from reading as configured.
  //
  // A dropped value gets a WARNING, unlike transport/runtime/env above, because
  // this is the one field whose whole purpose is to change a FAILURE the user is
  // already staring at. `MCP_CONNECT_TIMEOUT`'s help says a server's own
  // connectTimeoutMs wins, so the natural response to a handshake timeout is to
  // set it here -- and `"60000"` with the quotes (or a `0`, or a `null`) then
  // leaves the same timeout firing at the same ceiling with nothing anywhere
  // saying the setting was thrown away. Only a PRESENT key warns; absent is the
  // normal case for nearly every entry and must stay silent.
  const connectTimeoutMs =
    typeof e.connectTimeoutMs === "number" && Number.isFinite(e.connectTimeoutMs) && e.connectTimeoutMs > 0
      ? e.connectTimeoutMs
      : undefined;
  if (connectTimeoutMs === undefined && e.connectTimeoutMs !== undefined) {
    warnings.push(
      `bundles.json: ignoring invalid connectTimeoutMs ${JSON.stringify(e.connectTimeoutMs)} on "${namespace}" (expected a positive number)`,
    );
  }

  // Per-server compliance grade. Carried for the same reason as `runtime` and
  // `connectTimeoutMs` above -- the return below is a fixed whitelist, so a
  // field missing from it is DROPPED -- and this was the next instance of that
  // bug. hydrateComplianceGrades (server.ts) and runList both say outright
  // that bundles.json "never carries a grade of its own", which was true only
  // because this line was missing: grades.json, written by `yaw-mcp audit`
  // one server at a time, was the sole supplier, so on a fresh install every
  // server was ungraded and YAW_MCP_MIN_COMPLIANCE gated nothing at all.
  // `yaw-mcp add` now records the catalog's published grade here.
  //
  // Any non-empty string is passed through, NOT just A-F, and that is
  // deliberate: compliance.ts three-way classifies a grade as graded,
  // ungraded, or UNRECOGNIZED, and treats the third as a signal of
  // misconfiguration or tampering rather than a synonym for ungraded.
  // Narrowing here would make that arm unreachable from the one file a user
  // hand-edits, which is exactly where a garbled letter is worth reporting.
  // Uppercased to match the grades cache's own normalization so "a" and "A"
  // cannot rank differently.
  const complianceGrade =
    typeof e.complianceGrade === "string" && e.complianceGrade.trim() !== ""
      ? (e.complianceGrade.trim().toUpperCase() as UpstreamServerConfig["complianceGrade"])
      : undefined;

  // Default isActive=true in local mode -- if the user wrote a server
  // into bundles.json they presumably want it loadable. Toggle off with
  // explicit `"isActive": false`.
  const isActive = e.isActive !== false;

  // Synthesize an id from the namespace when absent. The id is mainly
  // a stable handle; not strictly needed, but the
  // downstream code paths use it as a stable handle.
  const id = typeof e.id === "string" && e.id.length > 0 ? e.id : `local-${namespace}`;

  return {
    id,
    name,
    namespace,
    type,
    transport,
    command,
    args,
    env,
    url,
    isActive,
    connectTimeoutMs,
    description,
    runtime,
    complianceGrade,
  };
}

/** Tri-state read result so the caller can distinguish "file doesn't
 *  exist" (fall through to next location) from "file exists but is
 *  malformed" (commit to this location, don't silently substitute
 *  someone else's config). */
interface ReadResult {
  exists: boolean;
  file: LocalBundlesFile | null;
}

/** Raw read outcome, before any parsing. Split out from readBundlesAt so
 *  the trust gate can hash the EXACT bytes it is about to parse: reading
 *  once for the hash and again for the parse would open a TOCTOU window in
 *  which a hostile repo swaps the file between the two reads and gets
 *  unreviewed argv past an approved hash. */
type RawRead =
  | { kind: "ok"; raw: Buffer }
  | { kind: "absent" }
  | { kind: "error"; message: string; code: string | undefined };

/** Detail text attached when the bundles.json path is a DIRECTORY. Shared with
 *  readRawUserBundles (never re-spelled there) so the write path can turn the
 *  warning back into an actionable message. */
const IS_A_DIRECTORY_DETAIL = "the path is a directory, not a file";

async function readBundlesRawAt(path: string): Promise<RawRead> {
  try {
    // Read BYTES, not utf8 text: the trust hash must cover exactly what is
    // on disk. Decoding to a string and back is lossy for invalid UTF-8,
    // which would let two different files produce the same hash.
    return { kind: "ok", raw: await readFile(path) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    // EISDIR is NOT absent. A directory at the bundles.json path is a real,
    // fixable problem: existsSync() says true, so the write path committed to
    // the location and -- because "absent" produced no warning at all --
    // reported it as a phantom parse failure ("could not be parsed -- fix the
    // JSON") with an EMPTY detail, sending the user to hunt a syntax error in
    // a file that is not a file. Classify it as the read error it is and name
    // the shape, so every consumer (loader warning, `add`, doctor) says what
    // is actually wrong.
    if (code === "EISDIR") return { kind: "error", message: IS_A_DIRECTORY_DETAIL, code };
    // Any other error (EPERM, EACCES, ...) means the file likely exists but
    // we can't read it.
    return { kind: "error", message: err instanceof Error ? err.message : String(err), code };
  }
}

/** Marker readBundlesAt puts in EVERY read-failure warning, and in no parse
 *  warning. Read-vs-parse is told apart by matching this against the warning's
 *  known `<path>: ` prefix -- NOT by sniffing errno words out of the joined
 *  text, which embeds the full path and so let a home directory containing
 *  "eaccess" turn an ordinary JSON syntax error into the permissions message. */
const READ_FAILURE_MARKER = "could not read file (";

/** Read a bundles.json from `path`. Returns:
 *   - { exists: false, file: null } when the file doesn't exist
 *   - { exists: true,  file: <parsed> } when valid
 *   - { exists: true,  file: null } when present-but-malformed (warnings
 *     populated). Caller must NOT fall through in this case -- see
 *     loadLocalBundles. */
async function readBundlesAt(path: string, warnings: string[]): Promise<ReadResult> {
  const r = await readBundlesRawAt(path);
  if (r.kind === "absent") return { exists: false, file: null };
  if (r.kind === "error") {
    // Return exists:true so the caller stays committed to this path instead
    // of silently falling through to the user-global file.
    warnings.push(`${path}: ${READ_FAILURE_MARKER}${r.message}) -- skipping`);
    log("warn", "Could not read bundles.json", { path, error: r.message, code: r.code });
    return { exists: true, file: null };
  }
  return { exists: true, file: parseBundlesContent(path, r.raw, warnings) };
}

/** Parse already-read bundles.json bytes. Returns null (with warnings
 *  populated) when the content is unusable. Separate from the read so the
 *  trust gate can decide whether to parse at all -- an untrusted file must
 *  produce ONLY the untrusted warning, not a pile of schema diagnostics
 *  about content we are refusing to look at. */
function parseBundlesContent(path: string, rawBytes: Buffer, warnings: string[]): LocalBundlesFile | null {
  const raw = rawBytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`${path}: invalid JSON (${msg}) -- file ignored`);
    log("warn", "bundles.json is not valid JSON; ignoring", { path, error: msg });
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push(`${path}: root must be a JSON object -- file ignored`);
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const version = typeof obj.version === "number" ? obj.version : undefined;
  if (version !== undefined && version > CURRENT_BUNDLES_SCHEMA_VERSION) {
    warnings.push(
      `${path}: schema version ${version} is newer than this yaw-mcp (${CURRENT_BUNDLES_SCHEMA_VERSION}); upgrade with \`npm i -g @yawlabs/mcp@latest\`. Loading best-effort.`,
    );
  }
  const rawServers = obj.servers;
  if (!Array.isArray(rawServers)) {
    warnings.push(`${path}: 'servers' must be an array -- file ignored`);
    return null;
  }
  // Top-level default runtime. Only "oam"/"node" are meaningful; anything
  // else is dropped with a warning (matching the per-server `runtime`
  // validation in validateEntry, which drops silently -- top-level gets a
  // warning because a typo here changes EVERY server's runtime).
  let defaultRuntime: "oam" | "node" | undefined;
  if (obj.defaultRuntime === "oam" || obj.defaultRuntime === "node") {
    defaultRuntime = obj.defaultRuntime;
  } else if (obj.defaultRuntime !== undefined) {
    warnings.push(
      `${path}: ignoring invalid 'defaultRuntime' ${JSON.stringify(obj.defaultRuntime)} (expected "oam" or "node")`,
    );
  }
  return { version, servers: rawServers as Array<Partial<UpstreamServerConfig>>, defaultRuntime };
}

/** What a bundles.json would actually contribute if it loaded. Used by
 *  `yaw-mcp trust` to show the user the exact argv they are approving --
 *  it runs the SAME parse + validateEntry the loader runs, so the preview
 *  cannot drift from what would really spawn. */
export interface BundlePreview {
  /** False when the file is unparseable / structurally wrong. */
  ok: boolean;
  servers: UpstreamServerConfig[];
  warnings: string[];
}

export function previewBundlesContent(path: string, rawBytes: Buffer): BundlePreview {
  const warnings: string[] = [];
  const file = parseBundlesContent(path, rawBytes, warnings);
  if (!file) return { ok: false, servers: [], warnings };
  const servers: UpstreamServerConfig[] = [];
  for (const entry of file.servers) {
    const validated = validateEntry(entry, warnings);
    if (validated) servers.push(validated);
  }
  return { ok: true, servers, warnings };
}

/** Deterministic content-derived configVersion. Nothing polls for a change
 *  any more -- the hosted backend whose ETag this once stood in for is gone.
 *  Its one remaining reader is server.ts, which folds it into a cache key so
 *  two loads of a byte-identical server list share an entry and any edit to
 *  the list misses. Same servers in, same version out, on every machine. */
function hashContent(servers: UpstreamServerConfig[]): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(servers));
  return `local-${h.digest("hex").slice(0, 16)}`;
}

// --- Project-trust gate -----------------------------------------------------

/** Everything a caller needs to know about the project bundles.json in
 *  play, WITHOUT re-reading it. `raw` carries the exact bytes the status
 *  was computed from so `yaw-mcp trust` can render the argv it is about to
 *  approve and grant against the very same content. */
export interface ProjectTrustProbe {
  /** Absolute path of the project bundles.json, or null when no `.yaw-mcp/`
   *  directory was found by walking up from cwd. Set even when the file
   *  itself is absent (status "none"), so the CLI can say where it looked. */
  path: string | null;
  status: "none" | "unreadable" | TrustStatus;
  /** YAW_MCP_TRUST_PROJECT is enabled -- the loader honours the project file
   *  regardless of `status`. Kept separate from `status` so diagnostics keep
   *  reporting the REAL trust state while the escape hatch is on. */
  bypassed: boolean;
  /** Exact bytes; null unless status is trusted/changed/untrusted/store-unreadable. */
  raw: Buffer | null;
  /** SHA-256 of `raw`; null when raw is null. */
  sha256: string | null;
  /** Read-error message when status === "unreadable". */
  error: string | null;
  /** Absolute path of the trust store consulted. */
  storePath: string;
  /** Is this PATH in the trust store at all, ignoring the content hash?
   *
   *  Only consulted for status "unreadable": we cannot hash a file we cannot
   *  read, so the content pin is unavailable and a path record is the only
   *  evidence of prior consent there is. Every other status uses the
   *  hash-checked `status` -- a path-only match must NEVER stand in for it,
   *  or a repo could swap an approved file's contents and keep loading.
   *  False when the store is malformed (fail closed) and when the store was
   *  never consulted (status "none").
   *
   *  Optional so callers that synthesize a probe for display purposes (the
   *  `untrustedProjectWarning` fixtures) don't have to name it; absent is
   *  read as false. probeProjectTrust always sets it. */
  pathTrusted?: boolean;
}

/**
 * Locate the project bundles.json from `cwd` and classify it against the
 * trust store. Reads the file exactly ONCE and hands the bytes back, so no
 * caller has to re-read (and no TOCTOU window opens between the hash and
 * the parse / the display / the grant).
 */
export async function probeProjectTrust(
  opts: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ProjectTrustProbe> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const bypassed = isTrustBypassEnabled(env);
  const storePath = trustStorePath(home);

  // `env` goes into the walk too: outside $HOME its ownership gate answers
  // from the env's ALLOW_UNOWNED opt-in (win32 has no uid to compare), and
  // reading process.env there instead of the env this probe was told to run
  // under made an injected opt-in a silent no-op for the project-dir half
  // while the trust half (isTrustBypassEnabled above) honoured it.
  const projectDir = await findProjectConfigDir(cwd, home, env).catch(() => null);
  const path = projectDir ? localBundlesPath(projectDir) : null;
  if (path === null) {
    return {
      path: null,
      status: "none",
      bypassed,
      raw: null,
      sha256: null,
      error: null,
      storePath,
      pathTrusted: false,
    };
  }
  const read = await readBundlesRawAt(path);
  if (read.kind === "absent") {
    return { path, status: "none", bypassed, raw: null, sha256: null, error: null, storePath, pathTrusted: false };
  }
  // The store is read for the unreadable case too: an unreadable file is
  // honoured only when its PATH was approved before (see
  // projectFileIsHonoured), and that question needs the store.
  const store = await readTrustStore(home);
  const pathTrusted = !store.malformed && normalizeTrustKey(path) in store.entries;
  if (read.kind === "error") {
    return {
      path,
      status: "unreadable",
      bypassed,
      raw: null,
      sha256: null,
      error: read.message,
      storePath,
      pathTrusted,
    };
  }
  return {
    path,
    status: trustStatusFor(path, read.raw, store),
    bypassed,
    raw: read.raw,
    sha256: hashTrustContent(read.raw),
    error: null,
    storePath,
    pathTrusted,
  };
}

/**
 * The warning a blocked project bundles.json produces. Names the ignored
 * path and the exact command to approve it -- a security gate the user
 * cannot see their way out of just reads as "my servers stopped working".
 *
 * SHORT BY DEFAULT. This fires on EVERY yaw-mcp invocation inside an
 * unapproved repo (`list`, `add`, the server's own startup), so the default
 * form is one line: what was ignored, and how to approve it. Pass
 * `{ detail: true }` for the full explanation -- `yaw-mcp doctor` does, and
 * doctor is the surface a confused user is pointed at.
 */
export function untrustedProjectWarning(probe: ProjectTrustProbe, opts: { detail?: boolean } = {}): string {
  const path = probe.path ?? "(unknown)";
  const approve = "`yaw-mcp trust` to approve";
  // Only the detailed form spells out the fallback and the escape hatch; the
  // short form names the env var without the paragraph explaining it.
  const detail = opts.detail === true;
  const fallback = detail
    ? " Falling back to your user-global ~/.yaw-mcp/bundles.json."
    : " Using user-global instead.";
  const escapeHatch = detail
    ? ` Set ${TRUST_BYPASS_ENV}=1 to skip this check (CI/automation only -- it lets any repo you run inside spawn commands as you).`
    : ` (${TRUST_BYPASS_ENV}=1 skips this check; CI only.)`;
  if (probe.status === "changed") {
    const why = detail ? " The new contents could spawn commands you never reviewed." : "";
    return `${path}: project bundles.json CHANGED since you approved it -- IGNORED.${why}${fallback} Re-review, then run ${approve}.${escapeHatch}`;
  }
  if (probe.status === "store-unreadable") {
    const fix = detail ? " Fix or delete that file, then re-approve from inside this project." : "";
    return `${path}: project bundles.json IGNORED -- the trust store at ${probe.storePath} could not be read, so nothing is trusted (fail-closed).${fallback}${fix} Then run ${approve}.${escapeHatch}`;
  }
  if (probe.status === "unreadable") {
    // Not a consent refusal: the bytes could not be read at all, so there is
    // nothing to hash and nothing to approve until the file is fixed. Kept
    // distinct so the user goes and looks at the file instead of at the
    // trust store. See projectFileIsHonoured for why this falls through.
    const why = detail
      ? " An unreadable project file that has never been approved is treated as absent rather than as authoritative -- otherwise a repo could blank out your servers just by committing something yaw-mcp cannot read."
      : "";
    return `${path}: project bundles.json could not be read (${probe.error}) and was never approved -- IGNORED.${why}${fallback} Fix the file, then run ${approve}.`;
  }
  const why = detail
    ? " A project file is usually committed to the repo and can spawn arbitrary commands as you, so it has to be approved first."
    : "";
  return `${path}: untrusted project bundles.json -- IGNORED.${why}${fallback} Review the servers, then run ${approve}.${escapeHatch}`;
}

/** Does the loader honour this project file? True for an approved file and
 *  for the env escape hatch.
 *
 *  UNREADABLE IS THE SUBTLE CASE. Being honoured commits the loader to the
 *  project location, and an unreadable file parses to nothing -- so honouring
 *  one yields zero servers AND suppresses the user-global file. That is
 *  exactly the denial-of-service variant the module header warns about, and
 *  unreadability is attacker-controlled from inside a repo: committing
 *  `.yaw-mcp` as a regular FILE makes the read fail with ENOTDIR, and
 *  committing `bundles.json` as a symlink loop makes it fail with ELOOP.
 *  Both survive `git clone` byte-for-byte on Linux/macOS, so any client
 *  opened in that checkout would silently lose every server.
 *
 *  So an unreadable file is honoured ONLY when its PATH is already in the
 *  trust store -- the user approved that exact file before, and "an approved
 *  bundles.json is authoritative even when it is broken" still applies (a
 *  chmod 000 on a file you trust must not silently swap in a different
 *  config). A path we have never seen falls through to user-global like any
 *  other unapproved state, with a warning. The path-only lookup is confined
 *  to this branch: there are no bytes to hash, so the content pin cannot be
 *  checked, and it must never substitute for the hash anywhere else.
 *
 *  The env escape hatch still honours it -- YAW_MCP_TRUST_PROJECT means
 *  "treat this checkout as approved", which is a strictly larger grant than
 *  the one being made here.
 *
 *  Exported for tests: the unreadable shapes that reach this branch (ENOTDIR,
 *  ELOOP, EACCES) cannot all be produced on every platform -- Windows maps
 *  the ENOTDIR shape to ENOENT and needs a privileged account for symlinks --
 *  so the decision itself is unit-tested over synthesized probes. */
export function projectFileIsHonoured(probe: ProjectTrustProbe): boolean {
  if (probe.status === "none") return false;
  if (probe.status === "unreadable") return probe.bypassed || probe.pathTrusted === true;
  return probe.bypassed || probe.status === "trusted";
}

export interface LoadLocalBundlesResult {
  config: ConnectConfig | null;
  path: string | null;
  warnings: string[];
  /** Top-level `defaultRuntime`. A project file that SETS it wins; a project
   *  file that doesn't falls back to the user-global file's value -- the
   *  knob is a MACHINE-level preference, so a committed team bundles.json
   *  (which will never carry a machine fact) must not silently turn it off.
   *  This is the one deliberate departure from the winner-takes-all
   *  server-list precedence. Undefined when nothing sets it. */
  defaultRuntime?: "oam" | "node";
  /** Absolute path of the bundles.json the defaultRuntime came from (may be
   *  the user-global file even when servers came from a project file -- see
   *  above). Undefined when defaultRuntime is undefined. */
  defaultRuntimePath?: string;
  /** Every path this load READ or would have read, whether or not it
   *  contributed: the project candidate (when the walk found a `.yaw-mcp/`,
   *  trusted or not) and the user-global file, deduped.
   *
   *  Exists so a caller that CACHES a verdict can invalidate on any input
   *  that could change it. Deriving that set from `path` alone is wrong in
   *  both directions -- a broken PROJECT file still falls back to the global
   *  file for defaultRuntime, and a broken GLOBAL file can be superseded by a
   *  project file created later -- and each direction was a separate bug in
   *  default-runtime's negative cache. A path is listed even when it does not
   *  exist: its ABSENCE is part of the verdict, so creating it must
   *  invalidate too.
   *
   *  ORDERING IS PART OF THE CONTRACT: the user-global path is always LAST,
   *  and a project candidate, when the walk found one, is first. A caller can
   *  therefore tell the two apart without re-deriving either path. */
  consultedPaths: string[];
}

/** Load bundles.json from the canonical locations. An APPROVED project-local
 *  file (`<project>/.yaw-mcp/bundles.json`, see probeProjectTrust) wins over
 *  user-global (`~/.yaw-mcp/bundles.json`) -- no merge (defaultRuntime
 *  excepted; see LoadLocalBundlesResult). An unapproved project file is
 *  ignored entirely and the user-global file loads as if it weren't there.
 *  Returns null config when neither file exists, so the caller can render
 *  the empty-state hint. */
export async function loadLocalBundles(
  opts: { cwd?: string; home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<LoadLocalBundlesResult> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const warnings: string[] = [];

  const globalPath = localBundlesPath(userConfigDir(home));

  // Consent gate. An unapproved project file is dropped BEFORE it is parsed
  // (so it contributes no servers and no schema diagnostics) and does NOT
  // shadow the user-global file -- otherwise a hostile repo could blank out
  // the user's real server list just by committing a bundles.json (or by
  // committing one yaw-mcp cannot read; see projectFileIsHonoured).
  const probe = await probeProjectTrust({ cwd, home, env: opts.env });
  const honoured = projectFileIsHonoured(probe);
  const projectPath = honoured ? probe.path : null;
  // probe.path, NOT projectPath: an UNTRUSTED project file is still an input
  // to the verdict (approving it later changes the answer), so a caller
  // caching on this set has to see it.
  const consultedPaths = probe.path !== null && probe.path !== globalPath ? [probe.path, globalPath] : [globalPath];
  if (probe.path !== null && probe.status !== "none" && !honoured) {
    warnings.push(untrustedProjectWarning(probe));
    // DEBUG, not warn: the same facts are already in the warning above, which
    // every CLI entry point prints as `warning: ...`. Logging at warn too put
    // a raw JSON envelope on stderr in front of the prose version of itself
    // on every single command run inside an unapproved repo.
    log("debug", "Ignoring untrusted project bundles.json", {
      path: probe.path,
      status: probe.status,
      sha256: probe.sha256,
    });
  }

  // The honoured project file wins entirely. If it is present but malformed
  // (or unreadable), we commit to that location (config null, warnings
  // surfaced) instead of silently substituting the user-global config -- an
  // APPROVED bundles.json is authoritative even when it is broken. Note the
  // unreadable branch below is reachable ONLY for a previously-approved path
  // or under the env bypass; an unknown unreadable path never gets here
  // (projectFileIsHonoured drops it), so this cannot be used to suppress the
  // user-global file from a fresh checkout.
  let projectResult: ReadResult = { exists: false, file: null };
  if (projectPath !== null) {
    if (probe.status === "unreadable") {
      warnings.push(`${projectPath}: ${READ_FAILURE_MARKER}${probe.error}) -- skipping`);
      log("warn", "Could not read bundles.json", { path: projectPath, error: probe.error });
      projectResult = { exists: true, file: null };
    } else {
      // probe.raw is non-null for every non-"none"/non-"unreadable" status.
      projectResult = { exists: true, file: parseBundlesContent(projectPath, probe.raw as Buffer, warnings) };
    }
  }

  let file: LocalBundlesFile | null;
  let sourcePath: string | null;
  if (projectResult.exists) {
    file = projectResult.file;
    sourcePath = projectPath;
  } else {
    const globalResult = await readBundlesAt(globalPath, warnings);
    file = globalResult.file;
    sourcePath = globalResult.exists ? globalPath : null;
  }

  if (!file) {
    // Even when the winning project file is present-but-malformed (config
    // null, warnings surfaced), defaultRuntime is still a MACHINE-level knob
    // -- fall through to the user-global file for it, same rationale as the
    // valid-project case below. The scratch array keeps the global file's own
    // diagnostics out of the result (its servers are shadowed either way).
    if (sourcePath === projectPath && projectPath !== null) {
      const scratch: string[] = [];
      const globalResult = await readBundlesAt(globalPath, scratch);
      if (globalResult.file?.defaultRuntime !== undefined) {
        return {
          config: null,
          path: sourcePath,
          warnings,
          defaultRuntime: globalResult.file.defaultRuntime,
          defaultRuntimePath: globalPath,
          consultedPaths,
        };
      }
    }
    return { config: null, path: sourcePath, warnings, consultedPaths };
  }

  const servers: UpstreamServerConfig[] = [];
  for (const raw of file.servers) {
    const validated = validateEntry(raw, warnings);
    if (validated) servers.push(validated);
  }

  // defaultRuntime is machine-level: when a VALID project file won but
  // doesn't set it, fall back to the user-global file's value. The scratch
  // warnings array keeps the global file's diagnostics out of the result --
  // its servers are deliberately shadowed, so "file ignored"-class warnings
  // about it would only confuse.
  let defaultRuntime = file.defaultRuntime;
  let defaultRuntimePath = defaultRuntime !== undefined ? (sourcePath ?? undefined) : undefined;
  if (defaultRuntime === undefined && sourcePath === projectPath && projectPath !== null) {
    const scratch: string[] = [];
    const globalResult = await readBundlesAt(globalPath, scratch);
    if (globalResult.file?.defaultRuntime !== undefined) {
      defaultRuntime = globalResult.file.defaultRuntime;
      defaultRuntimePath = globalPath;
    }
  }

  return {
    config: {
      servers,
      configVersion: hashContent(servers),
    },
    path: sourcePath,
    warnings,
    defaultRuntime,
    defaultRuntimePath,
    consultedPaths,
  };
}

// --- Write path (used by `yaw-mcp add` / `remove`) --------------------------
//
// These mutate the USER-GLOBAL ~/.yaw-mcp/bundles.json. They are the only
// writers of local server definitions in the CLI. A project-local
// <cwd>/.yaw-mcp/bundles.json FULLY overrides user-global on load (see
// loadLocalBundles), so the add/remove commands warn separately when a
// project file would shadow the write -- they don't silently target it.
//
// LOSSY REWRITE: add/remove serialize the file back out via JSON.stringify
// (readRawUserBundles -> {version, servers, defaultRuntime?} -> atomicWriteFile).
// The reader (readBundlesAt) accepts JSONC comments and tolerates unknown
// top-level keys, but this write path preserves NEITHER: any `//` or `/* */`
// comments the user hand-added, and any top-level key beyond version/servers/
// defaultRuntime, are dropped the first time `add`/`remove` touches the file.
// bundles.json is a tool-managed file; hand-edits survive READS but not the
// next tool-driven WRITE. (Per-server unknown fields inside a server object
// ARE preserved -- readRawUserBundles round-trips the raw server entries.)
//
// Two serializers, one per scope. Both exist because a read-modify-write
// that overlaps another's silently drops the loser's change: both read the
// same on-disk snapshot, both write a different modified copy, and the
// second write erases the first's entry (and any stored --env value on it).
// atomicWriteFile only ever prevented TORN files, never lost updates.
//
//   1. In-process promise chain (bundleWriteChain): concurrent upsert/remove
//      calls inside ONE process run one at a time. Same pattern as saveState
//      in persistence.ts.
//
//   2. Cross-process lockfile (withBundlesLock): two yaw-mcp PROCESSES -- two
//      terminals running `yaw-mcp add`, or the CLI racing the Yaw Terminal
//      app's own bundles.json writer -- take an O_EXCL sidecar
//      (BUNDLES_LOCK_NAME, next to bundles.json) across the whole
//      read-modify-write, so neither can read a snapshot the other is about
//      to replace.
//
// GUARANTEED: two writers that both take the lock never lose each other's
// update. NOT guaranteed: a writer that does not take it (an app build that
// predates BUNDLES_LOCK_NAME, a hand edit in a text editor) is still
// last-write-wins against a locked one; a lock this process cannot CREATE
// (EACCES on the dir) does not block the write, which then fails on its own
// with its own message; and a lock whose holder is still RUNNING but stuck is
// honoured until it goes stale by mtime (acquireUpgradeLock's
// UPGRADE_LOCK_STALE_MS) or the user deletes it -- a writer that waits
// BUNDLES_LOCK_WAIT_MS on one gives up with a message naming the file rather
// than writing around it. (A lock whose holder process is GONE is stolen on
// the first take: this lock opts into acquireUpgradeLock's pid probe, which
// is correct here because the critical section is in-process.)
let bundleWriteChain: Promise<void> = Promise.resolve();

/** Sidecar the cross-process write lock is taken on, inside the user config
 *  dir next to bundles.json. Exported by NAME so the other writer of that
 *  file (the Yaw Terminal app) can take the same lock. */
export const BUNDLES_LOCK_NAME = `${BUNDLES_FILENAME}.lock`;

/** How long a writer waits for another process to let go before giving up.
 *  A holder keeps the lock for one read plus one atomic write -- milliseconds
 *  -- so a lock still held after this long belongs to a crashed or wedged
 *  process, and the bound is what keeps `add` from hanging on it. Exported so
 *  the test pinning the give-up path derives its clock from the constant. */
export const BUNDLES_LOCK_WAIT_MS = 5_000;
const BUNDLES_LOCK_POLL_MS = 20;

/** Run `fn` holding the cross-process bundles.json lock. Polls while a live
 *  holder has it; throws once the wait is exhausted. Writing AROUND a held
 *  lock is exactly the lost update the lock exists to prevent, so the give-up
 *  path is an error that names the file, never a silent unlocked write. A
 *  lock whose holder PROCESS is gone is stolen on the first take
 *  (acquireUpgradeLock probes the recorded pid), so a crashed Yaw Terminal or
 *  `serve` never blocks an add/remove; what reaches the give-up path is a
 *  live-but-stuck holder, and "delete that lock file" is advice for that. */
async function withBundlesLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const dir = userConfigDir(home);
  // O_EXCL cannot create the sidecar in a dir that does not exist yet, and
  // acquireUpgradeLock reads that ENOENT as "no lock possible, proceed" --
  // which would leave the very first write on a fresh machine unlocked. Born
  // 0o700, the same mode atomicWriteFile births it with for the write below.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, BUNDLES_LOCK_NAME);
  const deadline = Date.now() + BUNDLES_LOCK_WAIT_MS;
  let release = acquireUpgradeLock(dir, BUNDLES_LOCK_NAME, { probeHolder: true });
  while (release === null) {
    if (Date.now() >= deadline) {
      throw new Error(
        `${localBundlesPath(dir)} is locked by another yaw-mcp process (${lockPath}). Retry in a moment; if no yaw-mcp or Yaw Terminal is running, delete that lock file.`,
      );
    }
    // Global setTimeout rather than timers/promises so a fake-timer test can
    // drive the wait to its deadline without sleeping through it for real.
    await new Promise<void>((resolve) => setTimeout(resolve, BUNDLES_LOCK_POLL_MS));
    release = acquireUpgradeLock(dir, BUNDLES_LOCK_NAME, { probeHolder: true });
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Derive a namespace from a server's DISPLAY NAME. This MUST stay
 * byte-for-byte identical to the Yaw Terminal app's deriveNamespace
 * (yaw-install-handler.ts) -- both write to the same ~/.yaw-mcp/bundles.json,
 * so a divergent algorithm would make the same catalog server land under two
 * different namespaces (CLI-added vs app/badge-added), duplicating tool
 * prefixes and breaking cross-path dedup + the app's "installed" check.
 *
 * Algorithm (identical to the app): lowercase, strip ALL non-alphanumerics,
 * 's'-prefix a leading non-letter (so "1Password" -> "s1password"), cap at 30,
 * fall back to "server" when nothing survives. Always returns a NAMESPACE_RE-
 * valid string (never null), so callers don't need a failure branch.
 */
export function deriveNamespace(name: string): string {
  let ns = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (ns.length === 0) return "server";
  if (!/^[a-z]/.test(ns)) ns = `s${ns}`;
  if (ns.length > 30) ns = ns.slice(0, 30);
  return ns;
}

/**
 * Read the RAW user-global bundles.json (no validate/coerce) so a save
 * round-trips fields validateEntry would otherwise drop. Returns a fresh
 * skeleton when the file is absent; THROWS when present-but-malformed so a
 * write never clobbers a file the user hand-edited into an invalid state.
 *
 * Non-fatal diagnostics -- an invalid `defaultRuntime` the rewrite is about
 * to drop -- go into `warnings` for the caller to hand back to the CLI, which
 * prints them as `warning: ...`, the same channel the loader's warnings take.
 * They used to be log()ged at warn instead, which put a raw JSON envelope on
 * stderr right above the "Updated ..." line: the exact shape the loader's
 * untrusted-file path avoids, for the same reason.
 */
async function readRawUserBundles(home: string, warnings: string[]): Promise<LocalBundlesFile> {
  const path = localBundlesPath(userConfigDir(home));
  const r = await readBundlesAt(path, warnings);
  // readBundlesAt already tells absent (exists:false) from present-but-broken,
  // so it is the only existence check. A separate existsSync() beforehand
  // raced it: a file removed between the two calls read as "present" with no
  // warning, and fell into the "could not be parsed" branch below with an
  // empty detail.
  if (!r.exists) return { version: CURRENT_BUNDLES_SCHEMA_VERSION, servers: [] };
  if (!r.file) {
    // Branch on the warning content to give the user the most actionable
    // message: a read error (EPERM / EACCES) hints at permissions; a directory
    // at the path says so outright; a parse failure hints at invalid JSON.
    //
    // The test is the EXACT `<path>: could not read file (` prefix readBundlesAt
    // emits for read failures, never an errno keyword search over the joined
    // text: that text embeds the full path, so a home directory containing
    // "eaccess" (or a project literally named "eperm") matched the
    // /EPERM|EACCES/i alternation and printed the permissions message for a
    // plain JSON syntax error.
    const warningText = warnings.join("; ");
    const readWarning = warnings.find((w) => w.startsWith(`${path}: ${READ_FAILURE_MARKER}`));
    if (readWarning) {
      // A DIRECTORY is not a permissions problem, and telling the user to
      // check permissions on one sends them nowhere useful.
      if (readWarning.includes(IS_A_DIRECTORY_DETAIL)) {
        throw new Error(`${path} is a directory, not a file -- move or remove it before adding servers.`);
      }
      throw new Error(`${path} could not be read (${warningText}) -- check file permissions before adding servers.`);
    }
    // Default: parse failure or structural mismatch.
    const detail = warnings.length > 0 ? ` (${warningText})` : "";
    throw new Error(`${path} could not be parsed -- fix the JSON${detail} before adding servers.`);
  }
  // DEBUG, not warn: the same facts are in `warnings`, which the caller
  // prints in prose (see the doc above).
  for (const w of warnings) {
    log("debug", "bundles.json warning (write path)", { warning: w });
  }
  // Round-trip defaultRuntime so an add/remove never drops the user's
  // config-level runtime knob (validateEntry-style coercion already ran in
  // readBundlesAt; an invalid value was warned about and dropped there).
  return {
    version: r.file.version ?? CURRENT_BUNDLES_SCHEMA_VERSION,
    servers: r.file.servers,
    ...(r.file.defaultRuntime !== undefined ? { defaultRuntime: r.file.defaultRuntime } : {}),
  };
}

/** A raw `env` map off disk, narrowed to its string-valued keys (the only
 *  shape validateEntry honours). Undefined when the field is absent or isn't
 *  a plain object, so the merge below leaves a garbage value untouched
 *  instead of laundering it into a well-formed one. */
function envStrings(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
  ) as Record<string, string>;
}

/**
 * Fold an incoming entry onto the one already on disk. An upsert is a PARTIAL
 * update, not a wholesale slot replacement: everything the caller does not
 * speak to keeps the value the user has there.
 *
 * Why this is not `file.servers[idx] = entry`: `yaw-mcp add <slug>` rebuilds
 * its entry from the catalog every time, so a re-add (to pick up a new catalog
 * command, say) used to blow away state only the user could have put there --
 * a persisted `--env` secret, an explicit `"isActive": false`, a per-server
 * `"runtime": "oam"` override, a hand-tuned `connectTimeoutMs`, and any field
 * outside the writer's vocabulary. All of it silently, under an "Updated ..."
 * success line.
 *
 * Three rules, in order:
 *   1. A field the incoming entry leaves UNDEFINED keeps its on-disk value.
 *      (Defined fields win: command/args/description are exactly what a
 *      re-add is FOR.)
 *   2. `env` merges per KEY rather than being swapped wholesale, and an EMPTY
 *      incoming value never blanks a stored one -- `add` seeds every required
 *      key with "" and only fills in what came from an explicit `--env`, so a
 *      wholesale swap is how the stored secret disappeared. The one thing a
 *      merge DOES drop is a stored key that is itself blank and absent from
 *      the incoming entry: that is a stale requirement marker, not a value
 *      (see the env block below).
 *   3. An incoming `isActive: true` does NOT re-enable an entry the user
 *      explicitly disabled. `true` is boilerplate every writer stamps;
 *      `"isActive": false` is a deliberate hand-edit, and there is no `enable`
 *      verb for `add` to be the accidental inverse of. An explicit `false`
 *      still disables.
 *   4. An incoming STDIO launch (command + transport "stdio") replaces the
 *      WHOLE launch shape: a stored `url` is dropped rather than carried
 *      along as a stale remote endpoint beside the new command. The one
 *      exception to rule 1 -- `url` belongs to the launch being replaced, not
 *      to state the user put there separately, and the entry it used to
 *      describe (a hand-added remote server) is reported through
 *      launchChanged so the swap is never silent.
 */
function mergeServerEntry(
  existing: Partial<UpstreamServerConfig>,
  incoming: Partial<UpstreamServerConfig>,
): Partial<UpstreamServerConfig> {
  const base = existing as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
    if (v === undefined) continue;
    merged[k] = v;
  }
  if (base.isActive === false && incoming.isActive !== false) merged.isActive = false;
  if (typeof incoming.command === "string" && incoming.transport === "stdio" && incoming.url === undefined) {
    delete merged.url;
  }

  const storedEnv = envStrings(base.env);
  const incomingEnv = envStrings((incoming as Record<string, unknown>).env);
  if (storedEnv || incomingEnv) {
    const env: Record<string, string> = {};
    // Carry the stored env forward, MINUS any blank seed the incoming entry no
    // longer lists. A blank value is not data -- it is `add`'s "this key is
    // required, nothing stored" marker (validateEntry drops it before spawn),
    // so once the catalog stops requiring the key the marker documents a
    // requirement that no longer exists. Without this, a dropped required key
    // stuck around forever: every later re-add kept re-copying it, and `list
    // --json` plus the removal preview kept reporting it as a required var.
    // A NON-EMPTY stored value is never dropped -- that is the user's own
    // persisted secret, and rule 2 below exists precisely to protect it.
    for (const [k, v] of Object.entries(storedEnv ?? {})) {
      if (v.trim() === "" && incomingEnv?.[k] === undefined) continue;
      env[k] = v;
    }
    for (const [k, v] of Object.entries(incomingEnv ?? {})) {
      if (v.trim() === "" && (env[k] ?? "").trim() !== "") continue;
      env[k] = v;
    }
    // Undefined rather than {} when nothing survives, so a re-add of a server
    // whose last required key was dropped leaves no empty husk on disk.
    merged.env = Object.keys(env).length > 0 ? env : undefined;
  }
  return merged as Partial<UpstreamServerConfig>;
}

/** The launch shape of an entry, as DATA: the command + args of a stdio
 *  server, or the url of a remote one -- whichever the loader would actually
 *  use (command wins when both are present, matching every renderer).
 *  Reported rather than rendered because rendering for a terminal is the
 *  CLI's job: bundles.json is a file a repo can ship or a badge can write, so
 *  the stored half needs the same control-byte neutering the CLI applies to
 *  every other field it prints from that file -- and that helper lives in
 *  trust-cmd, which imports this module. Empty when the entry has neither. */
export interface LaunchShape {
  command?: string;
  args?: string[];
  url?: string;
}

/** A launch swap an upsert performed (or, from previewUpsertUserBundle,
 *  would perform) on a slug-less stored entry. See the upsertUserBundle doc. */
export interface LaunchChange {
  from: LaunchShape;
  to: LaunchShape;
}

function launchShapeOf(entry: Record<string, unknown>): LaunchShape {
  if (typeof entry.command === "string" && entry.command.length > 0) {
    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
    return { command: entry.command, args };
  }
  return typeof entry.url === "string" && entry.url.length > 0 ? { url: entry.url } : {};
}

function sameLaunch(a: LaunchShape, b: LaunchShape): boolean {
  return a.command === b.command && a.url === b.url && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []);
}

/** A namespace collision between two different catalog slugs, as data. The
 *  stored half comes straight out of bundles.json (a hand-editable file), so
 *  a terminal caller renders it through its control-byte neutering -- see
 *  formatBundleCollision's `safe` parameter. */
export interface BundleCollision {
  /** The catalog slug being added. */
  slug: string;
  /** The namespace both servers derive. */
  namespace: string;
  /** The stored entry's display name, or its slug when it has no name. */
  storedLabel: string;
  /** The slug the stored entry was added as -- the `remove` target. */
  storedSlug: string;
}

/** The one spelling of the collision refusal. `safe` is applied to every
 *  interpolated value so a caller printing to a terminal can neuter control
 *  bytes without re-spelling the sentence; the default is verbatim, for the
 *  Error message and for callers that are not terminals. */
export function formatBundleCollision(c: BundleCollision, safe: (s: string) => string = (s) => s): string {
  return (
    `can't add catalog server "${safe(c.slug)}": namespace "${safe(c.namespace)}" is already used by ` +
    `"${safe(c.storedLabel)}" (added as "${safe(c.storedSlug)}"). Remove it first with \`yaw-mcp remove ${safe(c.storedSlug)}\`.`
  );
}

/** Thrown by upsertUserBundle on a cross-slug collision. Carries the
 *  structured collision so a terminal caller can re-render it neutered;
 *  `message` is the verbatim formatBundleCollision text. */
export class BundleCollisionError extends Error {
  readonly collision: BundleCollision;
  /** Read diagnostics collected before the refusal (a malformed entry the
   *  loader skipped, an invalid defaultRuntime). The dry run prints these;
   *  the real run's refusal used to drop them on the floor, so the two
   *  disagreed on exactly the path where the user is about to edit the file
   *  by hand. */
  readonly warnings: readonly string[];
  constructor(collision: BundleCollision, warnings: readonly string[] = []) {
    super(formatBundleCollision(collision));
    this.name = "BundleCollisionError";
    this.collision = collision;
    this.warnings = warnings;
  }
}

export interface UpsertUserBundleResult {
  path: string;
  replaced: boolean;
  entry: Partial<UpstreamServerConfig>;
  launchChanged?: LaunchChange;
  /** Non-fatal read diagnostics (see readRawUserBundles); print as `warning: ...`. */
  warnings: string[];
}

export interface RemoveUserBundleResult {
  path: string;
  removed: boolean;
  /** Non-fatal read diagnostics (see readRawUserBundles); print as `warning: ...`. */
  warnings: string[];
}

/**
 * Insert or update a server entry in the user-global bundles.json. The
 * lookup is TWO-PASS, namespace first and display name only as a fallback
 * -- mirroring the app's merge path (yaw-install-handler.ts
 * addCatalogServer): a name collision with an unrelated server must not
 * hijack the merge away from an exact namespace match. The name fallback
 * exists so a server added on the other path (e.g. a legacy entry written
 * without a namespace) isn't duplicated -- and a name-matched entry KEEPS
 * its stored namespace and id ("never rename out from under the user",
 * ditto the app): config allow/deny lists, grades.json and vault refs are
 * all keyed by namespace, and a silent rename would detach every one.
 *
 * A namespace match against a DIFFERENT catalog slug REFUSES (throws)
 * instead of merging: two catalog servers can derive the same namespace
 * (live example: slugs "redis" and "redis-yawlabs" both display as
 * "Redis" -> namespace "redis"), and merging silently swapped the launch
 * command AND overwrote the stored slug -- after which `yaw-mcp remove
 * <old-slug>` was an exit-0 no-op. (The app's one-click doInstall refuses
 * ALL duplicates; this is the CLI's equivalent for the case where the
 * merge would provably change which server runs.)
 *
 * A SLUG-LESS namespace match (entries written by the Yaw Terminal app or
 * a pre-0.76 CLI) is genuinely ambiguous: "same server whose catalog row
 * drifted" and "different server with the same display name" are
 * indistinguishable without the slug, and refusing would break the
 * deliberate re-add-to-refresh flow. So it MERGES (gaining the slug
 * stamp) -- but the merge reports a launchChanged note whenever the launch
 * shape it replaced differs (command/args, or the url of a hand-added remote
 * entry -- see launchShapeOf), so a swap is never silent; there is also no
 * stored slug to orphan, so `remove <namespace>` keeps working either way.
 *
 * An existing entry is otherwise UPDATED, not overwritten: see
 * mergeServerEntry for exactly what survives. Atomic write.
 *
 * Returns the path written, whether an existing entry was updated (vs a
 * fresh add), the entry AS WRITTEN -- callers that report what landed on
 * disk (`add --json`, the ambient-env note, the kept-namespace note) must
 * describe the merged result, not the pre-merge input they handed in -- and
 * the non-fatal `warnings` the read raised (see readRawUserBundles).
 *
 * Serialized via bundleWriteChain (in-process) and withBundlesLock (cross-
 * process) so concurrent calls don't lose writes.
 */
export function upsertUserBundle(
  entry: Partial<UpstreamServerConfig>,
  opts: { home?: string } = {},
): Promise<UpsertUserBundleResult> {
  const result = bundleWriteChain.then(() => doUpsertUserBundle(entry, opts));
  bundleWriteChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** How doUpsertUserBundle will treat `entry` against the given on-disk
 *  server array. Pure -- shared by the write path and by
 *  previewUpsertUserBundle so `add --dry-run` can never contradict the
 *  run it previews. */
function resolveUpsertTarget(
  servers: Array<Partial<UpstreamServerConfig> | undefined>,
  entry: Partial<UpstreamServerConfig>,
): {
  idx: number;
  matchedByNamespace: boolean;
  refusal: BundleCollision | null;
  namespace?: string;
  id?: string;
  launchChanged?: LaunchChange;
} {
  const incoming = entry as Record<string, unknown>;
  // Two-pass lookup, namespace first -- see the upsertUserBundle doc.
  let idx = servers.findIndex((s) => s?.namespace === entry.namespace);
  const matchedByNamespace = idx >= 0;
  if (idx < 0 && entry.name != null) {
    idx = servers.findIndex((s) => s?.name === entry.name);
  }
  if (idx < 0) return { idx, matchedByNamespace, refusal: null };
  const stored = (servers[idx] ?? {}) as Record<string, unknown>;
  // Cross-slug collision -- see the upsertUserBundle doc. Checked on BOTH
  // match paths: a name-fallback hit on an entry that carries a different
  // slug is the same "different server, same display name" case.
  if (typeof stored.slug === "string" && typeof incoming.slug === "string" && stored.slug !== incoming.slug) {
    return {
      idx,
      matchedByNamespace,
      refusal: {
        slug: incoming.slug,
        namespace: typeof stored.namespace === "string" ? stored.namespace : (entry.namespace ?? ""),
        storedLabel: typeof stored.name === "string" ? stored.name : stored.slug,
        storedSlug: stored.slug,
      },
    };
  }
  // Slug-less stored entry: merges on either match path, but a launch swap
  // must be LOUD -- see the upsertUserBundle doc for why this cannot refuse.
  // The name-fallback path needs it MORE than the namespace path: a
  // name-only match is the weaker identity signal. Compared as launch SHAPES
  // (launchShapeOf), so a stored url-only remote entry -- the documented way
  // to hand-add a remote server -- counts as a change too: joining only
  // command/args rendered it as "" and a "nothing stored" guard then
  // swallowed the note, while the merge carried the stale url along.
  let launchChanged: LaunchChange | undefined;
  if (typeof stored.slug !== "string" && typeof incoming.command === "string") {
    const from = launchShapeOf(stored);
    const to = launchShapeOf(incoming);
    if (!sameLaunch(from, to)) launchChanged = { from, to };
  }
  if (matchedByNamespace) return { idx, matchedByNamespace, refusal: null, launchChanged };
  // Name-fallback match: keep the stored namespace and id (see doc).
  return {
    idx,
    matchedByNamespace,
    refusal: null,
    namespace: typeof stored.namespace === "string" ? stored.namespace : undefined,
    id: typeof stored.id === "string" ? stored.id : undefined,
    launchChanged,
  };
}

/** The entry doUpsertUserBundle would actually put on disk for `target`.
 *  Pure -- shared with previewUpsertUserBundle for the same reason
 *  resolveUpsertTarget is: a dry run has to describe the run it previews.
 *  Rendering the caller's PRE-MERGE input instead drifted from the write on
 *  exactly the entries a user hand-edited -- a stored `--env` value, a
 *  per-server `"runtime"`, and above all an explicit `"isActive": false`,
 *  which mergeServerEntry deliberately keeps (rule 3) while every incoming
 *  entry carries `isActive: true`. The preview showed an entry that would
 *  load; the run wrote one that stays disabled. */
function mergedUpsertEntry(
  servers: Array<Partial<UpstreamServerConfig> | undefined>,
  entry: Partial<UpstreamServerConfig>,
  target: ReturnType<typeof resolveUpsertTarget>,
): Partial<UpstreamServerConfig> {
  if (target.idx < 0) return entry;
  const written = mergeServerEntry(servers[target.idx] ?? {}, entry);
  if (target.matchedByNamespace) return written;
  // Name-fallback match: keep the stored namespace and id -- never rename out
  // from under the user (see the upsertUserBundle doc).
  return { ...written, namespace: target.namespace ?? written.namespace, id: target.id ?? written.id };
}

/** Read-only preview of what upsertUserBundle would do -- the refusal it
 *  would throw (if any), the namespace the file would actually hold, and the
 *  MERGED entry the write would land (mergedUpsertEntry, the same fold the
 *  real run applies -- so a stored env value, a per-server override and a
 *  hand-set `"isActive": false` all show up in the preview exactly as they
 *  will on disk). `add --dry-run` reports THIS instead of re-deriving its own
 *  answer, so the preview and the real run can never disagree. Throws the same
 *  could-not-be-parsed error the real run throws for an unreadable file. */
export async function previewUpsertUserBundle(
  entry: Partial<UpstreamServerConfig>,
  opts: { home?: string } = {},
): Promise<{
  replaced: boolean;
  refusal: BundleCollision | null;
  namespace: string | undefined;
  entry: Partial<UpstreamServerConfig>;
  launchChanged?: LaunchChange;
  /** Same read diagnostics the real run would surface (see readRawUserBundles). */
  warnings: string[];
}> {
  const home = opts.home ?? homedir();
  const warnings: string[] = [];
  const file = await readRawUserBundles(home, warnings);
  const target = resolveUpsertTarget(file.servers, entry);
  return {
    replaced: target.idx >= 0,
    refusal: target.refusal,
    namespace: target.namespace ?? entry.namespace,
    entry: mergedUpsertEntry(file.servers, entry, target),
    launchChanged: target.launchChanged,
    warnings,
  };
}

async function doUpsertUserBundle(
  entry: Partial<UpstreamServerConfig>,
  opts: { home?: string },
): Promise<UpsertUserBundleResult> {
  const home = opts.home ?? homedir();
  const path = localBundlesPath(userConfigDir(home));
  // The read is INSIDE the lock: a snapshot taken before acquiring it is the
  // stale one the lock exists to keep from being written back.
  return withBundlesLock(home, async () => {
    const warnings: string[] = [];
    const file = await readRawUserBundles(home, warnings);
    const target = resolveUpsertTarget(file.servers, entry);
    if (target.refusal) throw new BundleCollisionError(target.refusal, warnings);
    const idx = target.idx;
    const replaced = idx >= 0;
    // The fold itself lives in mergedUpsertEntry so `add --dry-run` runs the
    // identical merge -- see previewUpsertUserBundle.
    const written = mergedUpsertEntry(file.servers, entry, target);
    if (replaced) file.servers[idx] = written;
    else file.servers.push(written);
    // `file.version` is written back exactly as readRawUserBundles produced
    // it: it already preserves a newer on-disk version rather than
    // downgrading it, and already stamps CURRENT for the absent-file and
    // version-less cases. A `?? CURRENT` here used to look like the
    // defaulting step, but it could never fire -- both of that function's
    // returns carry a number.
    //
    // dirMode 0o700 so a freshly-created ~/.yaw-mcp/ is born owner-only
    // (matching secrets-vault): bundles.json can carry per-server `--env`
    // secrets, so its parent dir must not be group/other-listable.
    await atomicWriteFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8", 0o600, 0o700);
    if (process.platform !== "win32") {
      try {
        await chmod(path, 0o600);
      } catch {
        // chmod not supported on this filesystem; not fatal.
      }
    }
    return { path, replaced, entry: written, launchChanged: target.launchChanged, warnings };
  });
}

/**
 * Remove a server entry (by namespace) from the user-global bundles.json.
 * No-op (removed:false) when the file or the namespace is absent. Atomic
 * write when a removal actually happens. `warnings` carries the read's
 * non-fatal diagnostics (see readRawUserBundles).
 *
 * Serialized via bundleWriteChain (in-process) and withBundlesLock (cross-
 * process) so concurrent calls don't lose writes.
 */
export function removeUserBundle(namespace: string, opts: { home?: string } = {}): Promise<RemoveUserBundleResult> {
  const result = bundleWriteChain.then(() => doRemoveUserBundle(namespace, opts));
  bundleWriteChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function doRemoveUserBundle(namespace: string, opts: { home?: string }): Promise<RemoveUserBundleResult> {
  const home = opts.home ?? homedir();
  const path = localBundlesPath(userConfigDir(home));
  // Early-out BEFORE the lock: taking it creates ~/.yaw-mcp/ (see
  // withBundlesLock), and a no-op remove on a machine that has no bundles.json
  // must not leave a config dir behind as its only effect. Absence is
  // re-checked by the read inside the lock either way.
  if (!existsSync(path)) return { path, removed: false, warnings: [] };
  return withBundlesLock(home, async () => {
    const warnings: string[] = [];
    const file = await readRawUserBundles(home, warnings);
    const before = file.servers.length;
    file.servers = file.servers.filter((s) => s?.namespace !== namespace);
    if (file.servers.length === before) return { path, removed: false, warnings };
    // `file.version` round-trips from readRawUserBundles, which already
    // preserves a newer on-disk version and defaults a version-less file to
    // CURRENT -- see the same note in doUpsertUserBundle.
    //
    // dirMode 0o700 so a freshly-created ~/.yaw-mcp/ is born owner-only
    // (matching secrets-vault): bundles.json can carry per-server `--env`
    // secrets, so its parent dir must not be group/other-listable.
    await atomicWriteFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8", 0o600, 0o700);
    if (process.platform !== "win32") {
      try {
        await chmod(path, 0o600);
      } catch {
        // chmod not supported on this filesystem; not fatal.
      }
    }
    return { path, removed: true, warnings };
  });
}

/**
 * Does a project-local bundles.json exist that would shadow a user-global
 * write? `add`/`remove` warn when this returns a path, since a write to
 * user-global won't load while the project file is in effect.
 *
 * Trust-aware: an UNAPPROVED project file no longer shadows anything (see
 * loadLocalBundles), so reporting it as a shadow would send the user off to
 * edit a file that is being ignored. Only a file the loader would actually
 * honour is returned.
 */
export async function findShadowingProjectBundles(
  cwd: string,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const probe = await probeProjectTrust({ cwd, home, env });
  return projectFileIsHonoured(probe) ? probe.path : null;
}
