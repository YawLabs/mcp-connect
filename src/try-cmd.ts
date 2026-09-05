// `yaw-mcp try <slug>` — one-shot trial: fetches the canonical launch
// shape for an MCP server from the yaw.sh/mcp catalog (catalog.ts), wires
// it into the user's AI client config under a `yaw-mcp-try-<slug>` entry
// (NOT through yaw-mcp -- the trial entry points DIRECTLY at the upstream
// MCP server's command + args), drops a trial marker file under
// ~/.yaw-mcp/trials/<slug>.json so the doctor's GC pass can sweep it
// after expiry, and prints a 3-line "trial wired" nudge.
//
// Design notes:
//   - The trial entry is upstream-shape so the user can evaluate the
//     server end-to-end without onboarding yaw-mcp first. yaw-mcp's
//     value-add (learning, compliance gating, one connection for many
//     servers) is offered AFTER the user has decided the server is worth
//     keeping.
//   - The Windows `cmd /c` wrap is delegated to `buildLaunchEntry` —
//     same code path the canonical `yaw-mcp install` flow uses, so a
//     future fix to the wrapping logic propagates to trials for free.
//   - Trial marker fields are versioned (`schemaVersion`) so the GC pass can
//     refuse to act on a marker written by a NEWER yaw-mcp, whose
//     containerPath/entryName semantics it cannot know. Enforced in
//     scanTrials + runTryCleanup: a schemaVersion ABOVE TRIAL_SCHEMA_VERSION
//     is reported as malformed for the user to delete by hand. A marker with
//     no schemaVersion at all is read as v1 rather than rejected -- older
//     hand-rolled and third-party markers omit it, and stranding those would
//     leave real trial entries wired with no path to reclaim them.
//   - The GC also refuses any marker whose entryName is not `yaw-mcp-try-*`.
//     Every value it acts on (clientPath, containerPath, entryName) comes
//     straight out of the marker file, so without that guard a corrupt or
//     hand-edited marker makes the sweep delete an arbitrary key from an
//     arbitrary JSON file.
//   - NOTHING IS SENT ANYWHERE AND NOTHING IS FINGERPRINTED. `try` used to
//     POST a {slug, action, anonId} triple to /api/try/event; that endpoint
//     died with the hosted backend and the poster is now a no-op, so no trial
//     event leaves the machine. The anonId (a truncated SHA-256 of hostname +
//     username) is gone with it: it is no longer computed and no longer
//     persisted to ~/.yaw-mcp/trials/.anon.
//   - A `.anon` file left behind by an older version is inert -- scanTrials
//     only reads *.json, so nothing loads it -- and `try` deliberately does
//     NOT delete it. Silently removing a file from the user's home dir as a
//     side effect of an unrelated command is more surprising than leaving 17
//     dead bytes; `rm ~/.yaw-mcp/trials/.anon` clears it for anyone who cares.
//   - The postEvent seam is GONE too, along with TryEventBody, the
//     ANON_ID_PLACEHOLDER literal, and doctor's `postTryEvent` option. It
//     had become an injection point that existed only to be injected: the
//     default implementation was a no-op, so every test that passed one was
//     overriding nothing with nothing. `--base` and $YAW_MCP_BASE_URL went
//     with it: the value was parsed, threaded into the catalog seam and
//     ignored there, so the flag was a no-op that --help still described as
//     a base URL. It was accepted-and-ignored for one release (v0.79.x) and
//     is now rejected as an unknown flag like any other.
//   - A project-scope target (VS Code's .vscode/mcp.json is the only one
//     `try` can reach) is commit-to-share config, and the trial entry carries
//     its secret INLINE. Writing a plaintext credential into a file that
//     `git add -A` sweeps up is refused unless --yes is passed; see step 5b.

import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { CATALOG_SLUG_RE, resolveCatalogSlug } from "./catalog.js";
import { probeClientsAsync, probeUsable } from "./doctor-cmd.js";
import { mergeClientConfig } from "./install-cmd.js";
import {
  buildLaunchEntry,
  CURRENT_OS,
  INSTALL_TARGETS,
  type InstallClientId,
  type InstallOS,
  type InstallScope,
  resolveAppDataDir,
  resolveInstallPath,
} from "./install-targets.js";
import { editJsoncEntry, parseJsonc, removeJsoncEntry } from "./jsonc.js";
import { log } from "./logger.js";
import { CONFIG_DIRNAME } from "./paths.js";

export const TRY_USAGE = `Usage: yaw-mcp try <slug> [flags]

  Wire a one-off trial of an MCP server into your AI client. No account
  needed; the trial points directly at the upstream server. Nothing sweeps
  it on a timer -- once --ttl has elapsed it is removed by the next
  \`yaw-mcp doctor\` run. Run \`yaw-mcp try-cleanup <slug>\` to remove it now.

  --client <name>      claude-code | claude-desktop | cursor | vscode
                       (default: auto-detect, prefers the first installed
                       client in the order probed by \`yaw-mcp install --list\`)
  --ttl <duration>     How long the trial lives before doctor GCs it
                       (default: 1h; accepts e.g. 30m, 2h, 7d)
  --env KEY=value      Set an env var on the trial entry. Repeatable.
                       Required env vars not supplied here AND not in your
                       shell's env block the trial with an explainer.
  --dry-run            Print what would happen without writing anything.
  --yes, -y            Confirm writing an inline secret into a PROJECT-scope
                       config (vscode's .vscode/mcp.json -- a per-project
                       file that is routinely committed). Without it, a trial
                       whose entry carries a secret refuses that target and
                       says why; user-scope clients never need it.

  Point the catalog somewhere else with $YAW_MCP_CATALOG_URL.`;

export const TRY_CLEANUP_USAGE = `Usage: yaw-mcp try-cleanup <slug>

  Remove a previously-wired trial: peels the yaw-mcp-try-<slug> entry out of
  the AI client config and deletes the marker under ~/.yaw-mcp/trials/. Safe
  to run after the trial expires (no-op if nothing is wired).`;

export const TRIAL_SCHEMA_VERSION = 1;
export const TRIALS_DIRNAME = "trials";

/** Every entry `try` writes is named `yaw-mcp-try-<slug>`. The cleanup and GC
 *  paths delete `marker.entryName` from `marker.clientPath` using values read
 *  verbatim out of the marker file, so they check this prefix before acting:
 *  a marker naming anything else is corrupt, hand-edited, or from a writer we
 *  don't know, and honoring it would remove an arbitrary key from an
 *  arbitrary JSON file on disk. */
export const TRIAL_ENTRY_PREFIX = "yaw-mcp-try-";

export interface ExploreServerResponse {
  slug: string;
  name: string;
  command: string;
  args: string[];
  /** Names of env vars the server needs to function. yaw-mcp try refuses
   *  to wire the trial if any of these are missing from both --env and
   *  process.env, so the user sees the requirement up front instead of
   *  a silent runtime failure in the client. */
  requiredEnvVars?: string[];
  docUrl?: string;
}

export interface TrialMarker {
  schemaVersion: number;
  slug: string;
  name: string;
  /** Epoch ms when doctor's GC pass should evict the entry. */
  expiresAt: number;
  /** Absolute path of the client config file the entry was written to. */
  clientPath: string;
  /** Human-friendly client id (claude-code, cursor, ...). Used by doctor
   *  to surface "trial expires in Nm for <client>" without re-probing. */
  clientName: InstallClientId;
  /** Container path (mcpServers/servers/projects[..]) under which the
   *  trial entry was written. Doctor needs this to GC the entry from
   *  the right scope (especially Claude Code local-scope under projects). */
  containerPath: string[];
  /** Entry name in the container — almost always `yaw-mcp-try-<slug>` but
   *  persisted so a future rename doesn't orphan old markers. */
  entryName: string;
  /** Epoch ms when the trial was created. Diagnostic. */
  createdAt: number;
}

export interface TryCommandOptions {
  slug?: string;
  clientId?: InstallClientId;
  /** Trial TTL as a duration string (e.g. "30m", "1h", "7d"). */
  ttl?: string;
  envOverrides?: Record<string, string>;
  dryRun?: boolean;
  /** `--yes`: write an inline secret into a project-scope (commit-to-share)
   *  config anyway. Without it runTry refuses that combination -- see the
   *  step-5b gate. Irrelevant to user-scope targets and secret-free trials. */
  yes?: boolean;
  /** Override for tests. */
  home?: string;
  cwd?: string;
  os?: InstallOS;
  env?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to process.platform. Decides ONE thing --
   *  whether the 0600 tightening in step 7 applies, since POSIX perms are a
   *  no-op on win32. Injected rather than read globally so a test can pin the
   *  POSIX arm without redefining process.platform for the whole process,
   *  which also flips atomicWriteFile out of its Windows rename-retry path
   *  (the AV/indexer EPERM dance) on the machine this suite runs on. */
  platform?: NodeJS.Platform;
  /** Override for tests; defaults to the catalog read in defaultFetchExplore.
   *  `catalogUrl` carries runTry's resolved $YAW_MCP_CATALOG_URL override
   *  (undefined when unset or empty) so the seam never has to read
   *  process.env behind the caller's injected `env`. */
  fetchExplore?: (slug: string, catalogUrl?: string) => Promise<ExploreServerResponse>;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Override for tests; defaults to Date.now(). */
  now?: () => number;
}

export interface TryCleanupOptions {
  slug?: string;
  home?: string;
  os?: InstallOS;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export interface TryCommandResult {
  exitCode: number;
  /** Files written (empty in --dry-run or on error). */
  written: string[];
  /** Marker that was persisted (or would have been, in --dry-run). */
  marker?: TrialMarker;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

// Slug shape `try` and `try-cleanup` accept is CATALOG_SLUG_RE from catalog.ts
// -- the module that owns the slug set -- shared with `add` so the three
// sites cannot drift. It also keeps the entry name and marker filename free
// of shell-special characters.

/** Parse argv slice for `yaw-mcp try`. Exported for tests. */
export function parseTryArgs(
  argv: string[],
): { ok: true; options: TryCommandOptions } | { ok: false; error: string; help?: boolean } {
  if (argv.length === 0) return { ok: false, error: TRY_USAGE };
  const positional: string[] = [];
  const opts: TryCommandOptions = {};
  const env: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--client": {
        const v = next();
        // Validate against the canonical client set so a new INSTALL_TARGETS
        // entry is accepted here without touching this literal.
        if (!v || !INSTALL_TARGETS.some((t) => t.clientId === v)) {
          return {
            ok: false,
            error: `--client requires ${INSTALL_TARGETS.map((t) => t.clientId).join("|")}`,
          };
        }
        opts.clientId = v as InstallClientId;
        break;
      }
      case "--ttl": {
        const v = next();
        if (!v) return { ok: false, error: "--ttl requires a value (e.g. 1h, 30m, 7d)" };
        if (parseDurationMs(v) === null) {
          return { ok: false, error: `--ttl: cannot parse "${v}" (try 30m, 1h, 2d)` };
        }
        opts.ttl = v;
        break;
      }
      case "--env": {
        const v = next();
        if (!v?.includes("=")) return { ok: false, error: "--env requires KEY=value" };
        const eq = v.indexOf("=");
        const key = v.slice(0, eq);
        const val = v.slice(eq + 1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return { ok: false, error: `--env: invalid KEY "${key}"` };
        }
        env[key] = val;
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
      // -y / --yes is the spelling `trust` and `remove` accept for the same
      // job (confirming a write the command would otherwise refuse).
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      case "-h":
      case "--help":
        return { ok: false, error: TRY_USAGE, help: true };
      default:
        if (a.startsWith("--")) return { ok: false, error: `Unknown flag: ${a}\n${TRY_USAGE}` };
        // A bare "-" is not a valid slug; reject it here with a clear
        // arg-parse error rather than letting it slip to the slug regex,
        // which would only reject it later with a generic "invalid slug".
        if (a === "-") return { ok: false, error: `Invalid argument "-".\n${TRY_USAGE}` };
        positional.push(a);
    }
  }
  if (positional.length !== 1) {
    return { ok: false, error: `Expected exactly one server slug, got ${positional.length}.\n${TRY_USAGE}` };
  }
  opts.slug = positional[0];
  if (Object.keys(env).length > 0) opts.envOverrides = env;
  return { ok: true, options: opts };
}

export function parseTryCleanupArgs(
  argv: string[],
): { ok: true; options: TryCleanupOptions } | { ok: false; error: string; help?: boolean } {
  if (argv.length === 0) return { ok: false, error: TRY_CLEANUP_USAGE };
  const opts: TryCleanupOptions = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { ok: false, error: TRY_CLEANUP_USAGE, help: true };
    if (a.startsWith("--")) return { ok: false, error: `Unknown flag: ${a}\n${TRY_CLEANUP_USAGE}` };
    // Reject a bare "-" with a clear arg-parse error rather than deferring
    // to the slug regex's generic "invalid slug" message.
    if (a === "-") return { ok: false, error: `Invalid argument "-".\n${TRY_CLEANUP_USAGE}` };
    positional.push(a);
  }
  if (positional.length !== 1) {
    return { ok: false, error: `Expected exactly one slug.\n${TRY_CLEANUP_USAGE}` };
  }
  opts.slug = positional[0];
  return { ok: true, options: opts };
}

/** Upper bound on a TTL: 100 years in ms, comfortably inside the ~±8.64e15ms
 *  range a JS Date can represent. `--ttl 100000000d` is a perfectly good digit
 *  run, but it pushes `now + ttl` past that range, where the dry-run preview's
 *  `new Date(expiresAt).toISOString()` throws a bare RangeError ("Invalid time
 *  value") that dispatch() renders as an opaque error -- and the real run
 *  persists the absurd marker without complaint. Rejecting at parse time gives
 *  both paths the same clear "cannot parse" message instead. */
const MAX_TTL_MS = 100 * 365 * 86_400_000;

/** Parse a duration suffix string (10s, 30m, 1h, 7d) into milliseconds.
 *  Returns null when the string is unparseable OR names a duration beyond
 *  MAX_TTL_MS, so callers can surface a clear error either way. */
export function parseDurationMs(s: string): number | null {
  const m = /^(\d+)\s*([smhd])$/i.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const factor = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const ms = n * factor;
  return ms > MAX_TTL_MS ? null : ms;
}

/** Trials root: `~/.yaw-mcp/trials/`. */
export function trialsDir(home: string = homedir()): string {
  return join(home, CONFIG_DIRNAME, TRIALS_DIRNAME);
}

export function trialMarkerPath(slug: string, home: string = homedir()): string {
  return join(trialsDir(home), `${slug}.json`);
}

/** Why a marker must NOT be acted on, as a phrase that completes
 *  "marker at <path> ...", or null when it is safe to honor.
 *
 *  Both consumers (runTryCleanup, scanTrials -> gcExpiredTrials) delete
 *  `entryName` at `containerPath` from `clientPath` using values read verbatim
 *  from the marker file, so the blast radius of a bad marker is any JSON key
 *  on disk. `try` only ever writes `yaw-mcp-try-<slug>` at schemaVersion
 *  TRIAL_SCHEMA_VERSION; anything else is corrupt, hand-edited, or from a
 *  writer we don't know. */
function rejectUntrustedMarker(marker: { entryName: string; schemaVersion?: number }): string | null {
  if (!marker.entryName.startsWith(TRIAL_ENTRY_PREFIX)) {
    return `names a non-trial entry ("${marker.entryName}", expected "${TRIAL_ENTRY_PREFIX}*")`;
  }
  // An ABSENT schemaVersion is read as v1 (see the file header): markers
  // written by hand or by older tooling omit it, and rejecting those would
  // strand a live trial entry with nothing able to reclaim it. A version
  // ABOVE ours is the case the field exists for -- a newer yaw-mcp may mean
  // something different by containerPath/entryName, and we don't guess.
  if (typeof marker.schemaVersion === "number" && marker.schemaVersion > TRIAL_SCHEMA_VERSION) {
    return `was written by a newer yaw-mcp (schemaVersion ${marker.schemaVersion} > ${TRIAL_SCHEMA_VERSION})`;
  }
  return null;
}

/** The marker fields every consumer reads VERBATIM off disk and hands to the
 *  peel. Throws rather than returning a boolean so the one caller that reports
 *  the reason -- runTryCleanup's "marker at <path> is unreadable (...)" -- has
 *  a message, while the callers that treat "cannot tell" as "nothing to do"
 *  simply catch. Checking one field instead of all three let a marker with no
 *  clientPath through: existsSync(undefined) is false, so the peel was
 *  skipped, the marker was unlinked, and the user was told the trial was
 *  "cleaned up" while its entry -- inline secret and all -- stayed wired with
 *  nothing left on disk naming it. */
function assertTrialMarkerShape(parsed: unknown): asserts parsed is TrialMarker {
  const m = parsed as TrialMarker | null;
  if (
    !m ||
    typeof m !== "object" ||
    typeof m.clientPath !== "string" ||
    typeof m.entryName !== "string" ||
    !Array.isArray(m.containerPath)
  ) {
    throw new Error("marker is missing required fields");
  }
}

/** Load a trial marker off disk without throwing. Returns null when the file
 *  is absent, unreadable, unparseable, or missing the fields the peel path
 *  needs -- callers treat "cannot tell" the same as "nothing to do".
 *
 *  The RAW bytes come back alongside the parsed marker: runTry's rollback has
 *  to be able to put the previous marker back byte-for-byte when its own
 *  client-config write fails (re-serializing would be close, but the bytes on
 *  disk are what the user had). */
async function readTrialMarker(markerPath: string): Promise<{ marker: TrialMarker; raw: string } | null> {
  try {
    const raw = await readFile(markerPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    assertTrialMarkerShape(parsed);
    return { marker: parsed, raw };
  } catch {
    return null;
  }
}

/** The read -> parse -> remove -> write core the three peel sites share
 *  (peelTrialEntry, runTryCleanup, gcExpiredTrials). It reports WHAT happened
 *  and lets each caller decide what that MEANS -- the part that legitimately
 *  differs between them:
 *   - "removed":    the entry was present and the file was rewritten (or, with
 *                   `dryRun`, would have been).
 *   - "absent":     nothing to do (no file, empty file, entry already gone).
 *   - "not-object": valid JSON that is NOT an object, so there is no container
 *                   to name the entry in and no peel is possible. The GC
 *                   refuses to unlink the marker on this; try-cleanup warns
 *                   and carries on.
 *  Read/parse/write errors propagate to the caller's own catch. */
async function peelEntryFromConfig(
  clientPath: string,
  containerPath: string[],
  entryName: string,
  dryRun = false,
): Promise<"removed" | "absent" | "not-object"> {
  if (!existsSync(clientPath)) return "absent";
  const raw = await readFile(clientPath, "utf8");
  if (raw.trim().length === 0) return "absent";
  const parsed = parseJsonc(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "not-object";
  const next = removeJsoncEntry(raw, containerPath, entryName);
  if (next === raw) return "absent";
  if (dryRun) return "removed";
  // No explicit mode: atomicWriteFile carries the config's existing perms
  // forward, so peeling a trial can never widen a 0600 file that still
  // holds another trial's inline secret.
  await atomicWriteFile(clientPath, next.endsWith("\n") ? next : `${next}\n`);
  return "removed";
}

/** Peel `marker.entryName` out of the client config the marker names,
 *  preserving the user's comments. Best-effort; never throws.
 *   - "removed": the entry was present and the file was rewritten.
 *   - "absent":  nothing to do (no file, empty file, entry already gone).
 *   - "failed":  the marker is untrusted, or the file could not be read /
 *                parsed / written. The caller warns and carries on.
 *
 *  With `dryRun`, every check runs but the write does not -- so --dry-run can
 *  promise a removal only when the real run would actually perform one. */
async function peelTrialEntry(marker: TrialMarker, dryRun = false): Promise<"removed" | "absent" | "failed"> {
  if (rejectUntrustedMarker(marker) !== null) return "failed";
  try {
    const outcome = await peelEntryFromConfig(marker.clientPath, marker.containerPath, marker.entryName, dryRun);
    return outcome === "not-object" ? "failed" : outcome;
  } catch {
    return "failed";
  }
}

// NOTE: `computeAnonId` / `loadOrCreateAnonId` / `anonIdPath` used to live
// here. They hashed hostname + username into a durable id under
// ~/.yaw-mcp/trials/.anon purely to populate the anonId of an event body for
// a poster that no longer posts. Deleted rather than left dead so nothing
// re-adopts a machine fingerprint by accident; see the .anon note in the
// file header.

// Resolve the launch shape from the SAME static catalog the website and the
// Yaw Terminal app read (catalog.ts), so `try <slug>` accepts the exact slug
// set the catalog shows. (The old /api/explore/:slug endpoint was never
// deployed -- this is the path that actually works.)
//
// `catalogUrl` is PASSED IN rather than read from process.env here: runTry
// resolves every other env lookup through its injectable `opts.env`, and a
// lone process.env read inside the seam means an embedded caller (or a test)
// that supplies `env` is silently overridden by the ambient environment.
async function defaultFetchExplore(slug: string, catalogUrl?: string): Promise<ExploreServerResponse> {
  const resolved = await resolveCatalogSlug(slug, { catalogUrl });
  const out: ExploreServerResponse = {
    slug: resolved.slug,
    name: resolved.name,
    command: resolved.command,
    args: resolved.args,
    requiredEnvVars: resolved.requiredEnvKeys,
  };
  if (resolved.docUrl) out.docUrl = resolved.docUrl;
  return out;
}

/** Auto-detect which AI client to install the trial into. Probes in the
 *  same order as `yaw-mcp install --list` (claude-code -> claude-desktop ->
 *  cursor -> vscode, per INSTALL_TARGETS -- one slot per client AND scope),
 *  picking the first slot whose config file already EXISTS and could be read
 *  and parsed (probeUsable). Failing that it takes the first client merely
 *  AVAILABLE on this OS, which is always claude-code (the most likely target)
 *  since that is first in INSTALL_TARGETS and ships on every InstallOS.
 *
 *  Readability is part of the gate, not just parseability: the probe reports
 *  a read failure (a directory at ~/.claude.json, EACCES) as `unreadable`,
 *  NOT `malformed`, and filtering on malformed alone picked such a file as
 *  "the client in use" -- after which runTry aborted on the same read the
 *  probe had just watched fail, while a readable ~/.cursor/mcp.json sat one
 *  slot further along.
 *
 *  There is no writability probe: availability is decided by OS, not by
 *  whether the config directory can be written. A client whose directory is
 *  read-only is still selected here and fails later, at the write, with a
 *  path in the message. */
async function autoDetectClient(opts: {
  home: string;
  os: InstallOS;
  cwd: string;
  claudeConfigDir: string | undefined;
  appData?: string;
}): Promise<InstallClientId> {
  const probes = await probeClientsAsync({
    home: opts.home,
    os: opts.os,
    cwd: opts.cwd,
    claudeConfigDir: opts.claudeConfigDir,
    appData: opts.appData,
  });
  // First: any client whose config file already exists AND whose contents
  // doctor could read (the user is actively using it, and `try` will be able
  // to splice into it).
  for (const p of probes) {
    if (probeUsable(p)) return p.clientId;
  }
  // Second: any client that's available on this OS (config file not
  // yet created -- we'll create it). claude-code is availableOn every
  // InstallOS (see INSTALL_TARGETS), so it is always present and never
  // `unavailable` -- this loop always returns it (first in probe order)
  // when nothing else matches, which IS the claude-code fallback.
  for (const p of probes) {
    if (!p.unavailable) return p.clientId;
  }
  // Unreachable: the loop above always returns (claude-code is available on
  // every OS). Throw rather than return a redundant literal so a future
  // INSTALL_TARGETS change that breaks the invariant fails loud.
  throw new Error("autoDetectClient: no available install client for this OS");
}

export async function runTry(opts: TryCommandOptions): Promise<TryCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  if (!opts.slug) {
    printErr(TRY_USAGE);
    return { exitCode: 2, written: [] };
  }
  const slug = opts.slug;
  if (!CATALOG_SLUG_RE.test(slug)) {
    printErr(`yaw-mcp try: invalid slug "${slug}" (lowercase letters, digits, and dashes only).`);
    return { exitCode: 2, written: [] };
  }

  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const os = opts.os ?? CURRENT_OS;
  const now = opts.now ? opts.now() : Date.now();
  // The CLI pre-validates --ttl in parseTryArgs, so only programmatic callers
  // can reach this with an unparseable value -- error out rather than
  // silently substituting the 1h default (which would mask the caller's bug).
  let ttlMs = DEFAULT_TTL_MS;
  if (opts.ttl !== undefined) {
    const parsedTtl = parseDurationMs(opts.ttl);
    if (parsedTtl === null) {
      printErr(`yaw-mcp try: invalid ttl "${opts.ttl}" (cannot parse; try 30m, 1h, 2d).`);
      return { exitCode: 2, written: [] };
    }
    ttlMs = parsedTtl;
  }
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : undefined;
  // Hermetic-home seam: keep the %APPDATA%-based claude-desktop path inside an
  // overridden home, and otherwise read the ambient %APPDATA% so try names the
  // same file install writes. Computed ONCE -- the step-2 probe and the step-3
  // resolve have to agree on it, and spelling the same expression at both sites
  // is how they drift; the shared helper is why it no longer drifts from
  // install-cmd and doctor either.
  const appData = resolveAppDataDir({ home: opts.home, env });

  // Step 1: fetch the canonical launch shape. The catalog override comes from
  // the SAME injectable env every other lookup here uses -- and an EMPTY value
  // counts as unset: `fetch("")` throws a bare TypeError that catalog.ts's
  // friendly wrapper cannot recognize as its own URL, so it is rethrown raw.
  const fetchExplore = opts.fetchExplore ?? defaultFetchExplore;
  const catalogUrl =
    env.YAW_MCP_CATALOG_URL !== undefined && env.YAW_MCP_CATALOG_URL.length > 0 ? env.YAW_MCP_CATALOG_URL : undefined;
  let server: ExploreServerResponse;
  try {
    server = await fetchExplore(slug, catalogUrl);
  } catch (e) {
    printErr((e as Error).message);
    return { exitCode: 1, written: [] };
  }

  // Step 2: pick a client (explicit > auto-detect).
  const clientId =
    opts.clientId ??
    (await autoDetectClient({
      home,
      os,
      cwd,
      claudeConfigDir,
      appData,
    }));

  // Step 3: resolve the config file path (user scope; project scope
  // requires extra flags we don't expose in `try` -- trials are
  // user-scoped by design).
  // VS Code has no user scope -- only workspace. Fall back to project
  // scope when targeting vscode; the user must be inside the workspace, and
  // a secret-bearing entry then needs --yes (step 5b), because that file is
  // commit-to-share config.
  const scope: InstallScope = clientId === "vscode" ? "project" : "user";
  const projectDir = scope === "project" ? resolve(cwd) : undefined;
  let resolved: ReturnType<typeof resolveInstallPath>;
  try {
    resolved = resolveInstallPath({
      clientId,
      scope,
      os,
      home,
      appData,
      projectDir,
      claudeConfigDir,
    });
  } catch (e) {
    printErr(`yaw-mcp try: ${(e as Error).message}`);
    return { exitCode: 1, written: [] };
  }

  // Step 4: required-env-var check. Anything in requiredEnvVars not
  // supplied via --env AND not in the current process env blocks the
  // trial — silent runtime failure inside the client is worse than a
  // clear "you need to set FOO" up front.
  //
  // A LOOKUP, not a merged object. Spreading `env` into a plain object drops
  // whatever lookup semantics the source had -- and on Windows process.env is
  // case-INSENSITIVE, so a var the user actually stores as `Github_Token`
  // answers to process.env.GITHUB_TOKEN but misses in the copy, and `try`
  // reports a required var missing that is sitting right there in the shell.
  // Reading THROUGH the original object preserves those semantics. Overrides
  // still win on exactly the old spread's terms: an explicit "" from --env
  // shadows the shell value, an absent key falls through to it.
  const lookup = (k: string): string | undefined => opts.envOverrides?.[k] ?? env[k];
  // Trim before the emptiness test so a whitespace-only value (FOO=" ")
  // counts as missing instead of slipping through and writing a blank-ish
  // secret into the trial entry.
  const missing = (server.requiredEnvVars ?? []).filter((k) => (lookup(k) ?? "").trim() === "");
  if (missing.length > 0) {
    printErr(`yaw-mcp try: ${server.name} needs the following env var(s) before it can run:`);
    for (const k of missing) printErr(`  - ${k}`);
    printErr("");
    printErr("Set them via --env KEY=value (repeatable) or your shell, then re-run:");
    const example = missing.map((k) => `--env ${k}=...`).join(" ");
    printErr(`  yaw-mcp try ${slug} ${example}`);
    if (server.docUrl) printErr(`Docs: ${server.docUrl}`);
    return { exitCode: 1, written: [] };
  }

  // Step 5: build the trial entry — upstream-shape, NOT through yaw-mcp.
  // Reuse buildLaunchEntry so the Windows `cmd /c` wrap stays in one
  // place. Only carry the env vars the upstream actually wants (from
  // requiredEnvVars + any --env overrides the user supplied); we don't
  // want to leak every var in the user's shell into the entry.
  //
  // INTENTIONAL DIVERGENCE from `yaw-mcp add` (local-add-cmd.ts:174-190):
  // `add` seeds required keys EMPTY and persists a value ONLY for explicit
  // --env, deliberately NOT copying ambient-shell secrets to disk (yaw-mcp
  // inherits the shell env at spawn time). `try` cannot do that -- the trial
  // entry is upstream-shape and launched DIRECTLY by the client, not through
  // yaw-mcp, so there is no env-inheriting launcher in the path; the resolved
  // value (including an ambient-shell secret) MUST be written inline or the
  // server has no way to see it. The ambientOnlyRequired note below warns the
  // user when a value was sourced from the shell rather than --env.
  const trialEnv: Record<string, string> = {};
  for (const k of server.requiredEnvVars ?? []) {
    // Use the trimmed value so a padded entry doesn't carry surrounding
    // whitespace into the secret (the missing-check above already trims).
    const v = (lookup(k) ?? "").trim();
    if (v) trialEnv[k] = v;
  }
  // Honor any --env overrides for keys NOT in requiredEnvVars too --
  // some servers have optional env knobs (LOG_LEVEL, DATABASE_URL).
  // Trimmed and emptiness-gated on the same terms as the required keys above:
  // `--env LOG_LEVEL=` (or a whitespace-only value) is the user clearing a
  // knob, not asking for a blank one, and persisting "" into the trial entry
  // makes the client launch the server with the var explicitly set to empty --
  // which several upstreams read as "configured" rather than "unset".
  for (const [k, v] of Object.entries(opts.envOverrides ?? {})) {
    if (k in trialEnv) continue;
    const trimmed = v.trim();
    if (trimmed) trialEnv[k] = trimmed;
  }
  // Required keys whose value came from the ambient shell, NOT --env. Unlike
  // `add`, `try` DOES persist these inline (see divergence note above); the
  // note at step 9 tells the user the secret was sourced from their shell so
  // they're aware it now lives in the client config on disk.
  // `!overrides[k]` alone covers both "key absent" and "key present but empty"
  // -- "" is falsy, so the old `|| overrides[k] === ""` disjunct could never
  // add a case the first one had not already caught.
  const overrides = opts.envOverrides ?? {};
  const ambientOnlyRequired = (server.requiredEnvVars ?? []).filter(
    (k) => !overrides[k] && (lookup(k) ?? "").trim() !== "",
  );
  const entry = buildLaunchEntry({
    os,
    upstream: {
      command: server.command,
      args: server.args,
      env: Object.keys(trialEnv).length > 0 ? trialEnv : undefined,
    },
  });
  // Whether the entry carries inline env: every value in it is a credential
  // or a knob the user chose to persist. Decides two things -- the
  // project-scope refusal right below, and the 0600 tightening in step 7.
  const entryHasSecrets = entry.env !== undefined && Object.keys(entry.env).length > 0;

  // Step 5b: refuse to write a secret into a commit-to-share file without an
  // explicit --yes. A project-scope target is per-project config the client
  // expects to be checked in (install-targets.ts labels VS Code's only scope
  // "Workspace -- commit to share"), and unlike `add` the trial entry carries
  // its values INLINE (see the divergence note above), so `git add -A` in
  // that repo publishes the credential. Auto-detect makes this easy to hit
  // by accident: a repo that ships .vscode/mcp.json is picked whenever no
  // personal client config exists. The warning prints on stderr either way;
  // --yes lifts only the refusal. It runs BEFORE the --dry-run return so a
  // preview never promises a write the real run declines.
  if (scope === "project" && entryHasSecrets) {
    const target = INSTALL_TARGETS.find((t) => t.clientId === clientId);
    const scopeSpec = target?.scopes.find((s) => s.scope === scope);
    const where = `${target?.label ?? clientId}'s ${scopeSpec?.label ?? scope} config`;
    const why = scopeSpec?.description ? ` (${scopeSpec.description})` : "";
    const keys = Object.keys(entry.env ?? {}).join(", ");
    printErr(
      `yaw-mcp try: warning -- ${resolved.absolute} is ${where}${why}, and the trial entry writes ${keys} into it in plaintext. Committing that file publishes the value.`,
    );
    if (!opts.yes) {
      const userScoped = INSTALL_TARGETS.filter(
        (t) => t.availableOn.includes(os) && t.scopes.some((s) => s.scope === "user"),
      ).map((t) => t.clientId);
      printErr(
        `yaw-mcp try: refusing to write it without --yes. Re-run with --yes to accept that (and keep the file out of version control), or target a user-scope client instead: --client ${userScoped.join("|")}`,
      );
      return { exitCode: 1, written: [] };
    }
  }

  const entryName = `${TRIAL_ENTRY_PREFIX}${slug}`;
  const expiresAt = now + ttlMs;
  const marker: TrialMarker = {
    schemaVersion: TRIAL_SCHEMA_VERSION,
    slug,
    name: server.name,
    expiresAt,
    clientPath: resolved.absolute,
    clientName: clientId,
    containerPath: resolved.containerPath,
    entryName,
    createdAt: now,
  };

  // Step 6: read existing client config (if any).
  // A missing or empty file reads as `null`, which selects the fresh-render
  // write route below. (Step 7's perms-tightening keys off entryHasSecrets -- see the
  // rationale where tightenPerms is computed: an inline secret must be
  // owner-only whether `try` created the file or merged into the user's
  // pre-existing config. rawClient decides only the write ROUTE:
  // comment-preserving splice vs fresh render.)
  // We also retain the RAW text so the write below can route through the
  // comment-preserving `editJsoncEntry` -- a read-modify-write through
  // JSON.parse + JSON.stringify drops every `//` and `/* */` the user has
  // in their config (~/.claude.json on Claude Code carries user comments
  // routinely; we must not silently strip them on every `try`).
  //
  // Broken out into a closure because step 6b's cross-client peel can rewrite
  // THIS file: when it does, the bytes read here are stale and both the read
  // and the splice have to be redone against the post-peel file.
  const readClientRaw = async (): Promise<{ ok: true; raw: string | null } | { ok: false }> => {
    if (!existsSync(resolved.absolute)) return { ok: true, raw: null };
    // Read and parse are reported SEPARATELY. Folding them into one catch
    // told a user whose ~/.claude.json is root-owned or 0600-another-user
    // that their JSON was invalid ("is not valid JSON (EACCES: permission
    // denied...)"), sending them to inspect a file they cannot even read
    // instead of to the permissions. Same shape for EISDIR.
    let raw: string;
    try {
      raw = await readFile(resolved.absolute, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      printErr(
        `yaw-mcp try: ${resolved.absolute} could not be read (${code ?? (e as Error).message}) -- check its permissions and ownership. Refusing to overwrite.`,
      );
      return { ok: false };
    }
    if (raw.trim().length === 0) return { ok: true, raw: null };
    let parsed: unknown;
    try {
      parsed = parseJsonc(raw);
    } catch (e) {
      printErr(`yaw-mcp try: ${resolved.absolute} is not valid JSON (${(e as Error).message}). Refusing to overwrite.`);
      return { ok: false };
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return { ok: true, raw };
    printErr(`yaw-mcp try: ${resolved.absolute} is not a JSON object — refusing to overwrite.`);
    return { ok: false };
  };

  const firstRead = await readClientRaw();
  if (!firstRead.ok) return { exitCode: 1, written: [] };

  // If a previous trial of the same slug is wired, overwrite it (the
  // user is re-running `try`, presumably with a different --ttl or env).
  // We never collide with the canonical "yaw-mcp" entry — trials
  // live under their own `yaw-mcp-try-<slug>` name.
  //
  // Two write paths:
  //   - File pre-exists with content -> route through `editJsoncEntry` to
  //     diff against the original bytes; the user's comments survive.
  //   - File missing / empty -> no comments to preserve, fall back to the
  //     historical mergeClientConfig + JSON.stringify path (which also
  //     handles the empty container-path materialization for us).
  const buildClientJson = (raw: string | null): { ok: true; json: string } | { ok: false } => {
    if (raw === null) {
      const merged = mergeClientConfig({}, resolved.containerPath, entry, entryName);
      return { ok: true, json: `${JSON.stringify(merged, null, 2)}\n` };
    }
    try {
      const next = editJsoncEntry(raw, resolved.containerPath, entryName, entry);
      // Preserve the file's existing trailing-newline convention if present;
      // editJsoncEntry returns the user's bytes verbatim outside the edit
      // region, so a file that ended without a newline still won't.
      return { ok: true, json: next.endsWith("\n") ? next : `${next}\n` };
    } catch (e) {
      printErr(
        `yaw-mcp try: failed to splice entry into ${resolved.absolute} (${(e as Error).message}). Refusing to overwrite.`,
      );
      return { ok: false };
    }
  };

  const firstSplice = buildClientJson(firstRead.raw);
  if (!firstSplice.ok) return { exitCode: 1, written: [] };
  let clientJson = firstSplice.json;
  const markerJson = `${JSON.stringify(marker, null, 2)}\n`;

  // Step 6b: the marker path is keyed on SLUG alone (trials/<slug>.json), so a
  // re-run of the same slug against a DIFFERENT --client is about to overwrite
  // the only record of the previous wiring. Left alone, that entry -- inline
  // secret and all -- stays in the old client config forever: `try-cleanup`
  // reads only the current marker and doctor's GC only walks markers, so
  // nothing would ever name it again. Peel it out first, best-effort.
  //
  // The marker is read BEFORE the dry-run return so the preview can name the
  // removal too: a --dry-run that omits a write the real run performs is
  // exactly the report a user consults --dry-run to avoid.
  const previousRead = await readTrialMarker(trialMarkerPath(slug, home));
  const previousMarker = previousRead?.marker ?? null;
  const peelsPrevious =
    previousMarker !== null &&
    (previousMarker.clientPath !== resolved.absolute || previousMarker.entryName !== entryName);
  // The real peel routes through peelTrialEntry, whose FIRST act is to refuse
  // an untrusted marker (a non-`yaw-mcp-try-*` entryName, or a schemaVersion
  // from a newer yaw-mcp). The preview has to consult the same gate or it
  // promises a removal the real run declines -- which is the one thing a
  // --dry-run must never do.
  const previousRefusal = previousMarker === null ? null : rejectUntrustedMarker(previousMarker);

  if (opts.dryRun) {
    print(`yaw-mcp try (dry-run): would write ${resolved.absolute}`);
    print(`  entry name: ${entryName}`);
    print(`  command:    ${entry.command} ${entry.args.join(" ")}`);
    if (entry.env) print(`  env keys:   ${Object.keys(entry.env).join(", ")}`);
    print(`  expires:    ${new Date(expiresAt).toISOString()}`);
    print(`  marker:     ${trialMarkerPath(slug, home)}`);
    if (previousMarker && peelsPrevious) {
      if (previousRefusal !== null) {
        print(
          `  would NOT remove: the previous ${slug} marker ${previousRefusal} -- remove that entry from ${previousMarker.clientPath} by hand`,
        );
      } else if ((await peelTrialEntry(previousMarker, true)) === "removed") {
        // Every check the real peel runs, minus the write. Naming the removal
        // on the STRENGTH of the clientPath/entryName comparison alone
        // over-promised: when that file (or that entry inside it) is already
        // gone, the real run's peel returns "absent" and prints nothing at
        // all. An "absent"/"failed" preview therefore stays quiet too, which
        // is the direction --dry-run is allowed to be wrong in.
        print(
          `  would remove: the previous ${slug} trial (${previousMarker.entryName}) from ${previousMarker.clientPath}`,
        );
      }
    }
    return { exitCode: 0, written: [], marker };
  }

  // Set when step 6b tried to peel a marker it TRUSTED and the peel failed
  // anyway (an unreadable / unparseable / unwritable old client file). The
  // previous entry is then STILL LIVE, so the rollback in step 7 has to put its
  // marker back rather than unlink it -- see the comment there. Deliberately
  // NOT set for an untrusted or newer-schema marker: peelTrialEntry reports
  // those as "failed" too, but it refused them before touching anything and
  // every other consumer refuses them as well, so restoring one would only
  // re-arm a marker nothing on disk will ever act on.
  let previousPeelFailedWhileTrusted = false;
  if (previousMarker && peelsPrevious) {
    const outcome = await peelTrialEntry(previousMarker);
    if (outcome === "removed") {
      print(`Removed the previous ${slug} trial (${previousMarker.entryName}) from ${previousMarker.clientPath}`);
      if (previousMarker.clientPath === resolved.absolute) {
        // Same file, different entry name (a hand-edited or renamed marker):
        // the peel just rewrote the bytes the splice above was built from, so
        // writing that stale render would re-insert the entry we just removed.
        // Re-read and re-splice against the post-peel file.
        const reread = await readClientRaw();
        if (!reread.ok) return { exitCode: 1, written: [] };
        const respliced = buildClientJson(reread.raw);
        if (!respliced.ok) return { exitCode: 1, written: [] };
        clientJson = respliced.json;
      }
    } else if (outcome === "failed") {
      previousPeelFailedWhileTrusted = previousRefusal === null;
      printErr(
        `yaw-mcp try: warning -- couldn't remove the previous ${slug} trial (${previousMarker.entryName}) from ${previousMarker.clientPath}. Remove that entry by hand; the marker below no longer points at it.`,
      );
    }
  }

  // Step 7: write everything atomically. Order: marker first, then client
  // config. Rationale: if the process CRASHES between the two writes (where
  // the catch-block rollback below cannot run), a sweepable marker is left
  // behind so doctor's GC can reclaim it. On a CAUGHT client-write failure we
  // do NOT rely on that -- the catch rolls the marker back (see below) so
  // doctor never sees a trial whose launch entry was never written. "Rolls
  // back" is not always "unlinks": on a same-target re-run the marker we are
  // about to overwrite still names a LIVE entry, so it is restored, not
  // deleted.
  const written: string[] = [];
  try {
    await mkdir(trialsDir(home), { recursive: true });
    await atomicWriteFile(trialMarkerPath(slug, home), markerJson);
    written.push(trialMarkerPath(slug, home));
  } catch (e) {
    printErr(`yaw-mcp try: failed to write trial marker: ${(e as Error).message}`);
    return { exitCode: 1, written: [] };
  }

  // When the launch entry carries inline env (secrets), the written config
  // must be owner-only (0600) -- whether `try` created the file or merged the
  // entry into the user's pre-existing config. We just wrote a plaintext
  // credential into it, and atomicWriteFile renames a fresh tmp over the
  // target (a new inode), so without an explicit mode the file would be born
  // at the umask default (~0644) with the secret world-readable. No-op on
  // Windows (POSIX perms don't apply).
  //
  // The false branch passes `undefined`, which is NOT "born 0644": that is
  // atomicWriteFile's preserve-the-target's-mode path. A no-secret trial (or a
  // try-cleanup / doctor GC pass) must never widen a config that is already
  // 0600 -- it may hold ANOTHER trial's inline secret, or the user may simply
  // have tightened it by hand. Only a genuinely new file lands at the umask
  // default.
  const tightenPerms = entryHasSecrets && (opts.platform ?? process.platform) !== "win32";
  try {
    // Born-0600 on the create path closes the TOCTOU window where a 0644
    // file with secrets exists between rename and the post-hoc chmod.
    await atomicWriteFile(resolved.absolute, clientJson, "utf8", tightenPerms ? 0o600 : undefined);
    written.push(resolved.absolute);
    // Belt-and-suspenders chmod normalizes any umask masking applied to the
    // born mode above (e.g. a umask that widened 0600 -> nothing extra, but
    // this pins it exactly to owner-only).
    if (tightenPerms) {
      try {
        await chmod(resolved.absolute, 0o600);
      } catch {
        // chmod best-effort -- the trial still works at default perms.
      }
    }
  } catch (e) {
    printErr(`yaw-mcp try: failed to write ${resolved.absolute}: ${(e as Error).message}`);
    // Best-effort marker rollback so doctor doesn't think a trial is
    // active when its launch entry was never written.
    //
    // On a re-run that targets the SAME client file and entry name, though,
    // unlinking is the wrong rollback: the marker we just overwrote named the
    // PREVIOUS run's entry, which is still live in the file this write failed
    // on -- inline secret and all -- and that marker was the only thing on
    // disk naming it. Deleting it strands the entry beyond the reach of both
    // `try-cleanup` ("no trial marker ... nothing to do") and doctor's GC.
    // Put the previous bytes back instead. When the previous marker named a
    // DIFFERENT file or entry, step 6b normally peeled it, so there is nothing
    // left for a restored marker to point at -- unlink stays right there, as
    // it does for a first run with no previous marker at all. But that peel is
    // best-effort: on a trusted marker whose old client file could not be read,
    // parsed, or written, it returned "failed" and the previous entry is STILL
    // wired, so its marker has to come back here too. (An untrusted or
    // newer-schema marker is excluded -- see previousPeelFailedWhileTrusted.)
    //
    // The restore writes to the same disk that just failed us, so it is
    // best-effort on the same terms as the unlink, and passes no explicit mode
    // -- atomicWriteFile's preserve-the-target path is what a marker wants.
    if (previousRead !== null && (!peelsPrevious || previousPeelFailedWhileTrusted)) {
      await atomicWriteFile(trialMarkerPath(slug, home), previousRead.raw).catch(() => undefined);
    } else {
      await unlink(trialMarkerPath(slug, home)).catch(() => undefined);
    }
    return { exitCode: 1, written: [] };
  }

  // Step 9: nudge. The keep-it path is local (`add` writes the server into
  // ~/.yaw-mcp/bundles.json) -- there is no account and no signup page.
  const ttlPretty = formatTtl(ttlMs);
  // `entryName`, not a rebuilt literal: the name printed here has to be the
  // name actually written, or a change to TRIAL_ENTRY_PREFIX makes this line
  // lie about what is in the file.
  print(`Trial wired: ${server.name} via ${entryName} -> ${resolved.absolute}`);
  // "Expires in Nh" alone read as a timer. Nothing sweeps on a schedule: the
  // TTL is only consumed by gcExpiredTrials, which runs from `yaw-mcp doctor`
  // and nowhere else. A user who never runs doctor keeps the entry -- and its
  // inline secret -- wired indefinitely, so say what actually reclaims it.
  print(
    `Expires in ${ttlPretty}, then swept by the next \`yaw-mcp doctor\` run; remove it now with: yaw-mcp try-cleanup ${slug}`,
  );
  print(`Liking it? Keep ${server.name} for good with: yaw-mcp add ${slug}`);

  // If a required key was satisfied by the ambient shell (not --env), its
  // value was copied INTO the trial entry on disk (unlike `add`, which seeds
  // it empty). Warn on stderr so the user knows a shell-resident secret was
  // persisted to the client config.
  if (ambientOnlyRequired.length > 0) {
    printErr(
      `Note: ${ambientOnlyRequired.join(", ")} ${
        ambientOnlyRequired.length === 1 ? "was" : "were"
      } read from your shell env and written into the trial entry at ${resolved.absolute}. Remove the trial with: yaw-mcp try-cleanup ${slug}`,
    );
  }
  return { exitCode: 0, written, marker };
}

export async function runTryCleanup(opts: TryCleanupOptions): Promise<TryCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  if (!opts.slug) {
    printErr(TRY_CLEANUP_USAGE);
    return { exitCode: 2, written: [] };
  }
  const slug = opts.slug;
  if (!CATALOG_SLUG_RE.test(slug)) {
    printErr(`yaw-mcp try-cleanup: invalid slug "${slug}".`);
    return { exitCode: 2, written: [] };
  }

  const home = opts.home ?? homedir();
  const markerPath = trialMarkerPath(slug, home);

  if (!existsSync(markerPath)) {
    print(`yaw-mcp try-cleanup: no trial marker for "${slug}" (nothing to do).`);
    return { exitCode: 0, written: [] };
  }

  let marker: TrialMarker;
  try {
    // The SAME field checks readTrialMarker applies, from the same helper --
    // spelled out separately here, the two drifted (this one checked entryName
    // alone for a while, which let a marker with no clientPath through).
    // assertTrialMarkerShape throws a message, which is what this catch needs
    // and readTrialMarker's own catch discards.
    const parsed: unknown = JSON.parse(await readFile(markerPath, "utf8"));
    assertTrialMarkerShape(parsed);
    marker = parsed;
  } catch (e) {
    printErr(`yaw-mcp try-cleanup: marker at ${markerPath} is unreadable (${(e as Error).message}).`);
    return { exitCode: 1, written: [] };
  }

  // Everything below deletes marker.entryName at marker.containerPath from
  // marker.clientPath -- three values read straight out of a file on disk. A
  // marker we did not write (hand-edited, corrupted, or produced by a newer
  // yaw-mcp) could therefore name ANY key in ANY JSON file. Refuse instead of
  // acting; the user deletes the marker by hand.
  const rejection = rejectUntrustedMarker(marker);
  if (rejection) {
    printErr(`yaw-mcp try-cleanup: marker at ${markerPath} ${rejection} -- refusing to edit ${marker.clientPath}.`);
    printErr(`  Delete it by hand if it is stale: ${markerPath}`);
    return { exitCode: 1, written: [] };
  }

  // Peel the entry out of the client config (no-op if already gone). Routed
  // through `removeJsoncEntry` so user comments in the client config survive
  // -- a JSON.parse + JSON.stringify pass would silently strip them.
  const written: string[] = [];
  try {
    const outcome = await peelEntryFromConfig(marker.clientPath, marker.containerPath, marker.entryName);
    if (outcome === "removed") {
      written.push(marker.clientPath);
      print(`Removed ${marker.entryName} from ${marker.clientPath}`);
    } else if (outcome === "not-object") {
      // Valid JSON that is not an object (an array, a string, a number): there
      // is no container for removeJsoncEntry to name the entry in, so no peel
      // is possible. SAY so. Skipping it silently and then printing "cleaned
      // up" is the same false all-clear over a plaintext credential that the
      // GC was fixed to refuse -- the user reads "cleaned up", and the entry
      // is still wired.
      printErr(
        `yaw-mcp try-cleanup: warning -- couldn't strip ${marker.entryName} from ${marker.clientPath} (${marker.clientPath} is not a JSON object).`,
      );
    }
  } catch (e) {
    printErr(
      `yaw-mcp try-cleanup: warning -- couldn't strip ${marker.entryName} from ${marker.clientPath} (${(e as Error).message}).`,
    );
    // Continue -- still drop the marker so doctor stops surfacing it.
  }

  // Drop the marker.
  try {
    await unlink(markerPath);
  } catch (e) {
    printErr(`yaw-mcp try-cleanup: couldn't delete marker ${markerPath} (${(e as Error).message}).`);
    return { exitCode: 1, written: [] };
  }

  print(`Trial for "${slug}" cleaned up.`);
  return { exitCode: 0, written };
}

/** Pretty-print a TTL in ms as `Nh`, `Nm`, or `Nd` for the nudge.
 *
 *  Floor, never round: both surfaces that render this ("Expires in Nh" in the
 *  try nudge, "expires in Nh" in doctor's TRIALS section) read as a precise
 *  expiry, and rounding UP overstates the time left -- 90m printed as "2h"
 *  told the user they had half an hour they did not have. Flooring can only
 *  understate, which is the safe direction for a deadline. */
export function formatTtl(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return `${Math.floor(clamped / 1000)}s`;
  if (clamped < 3_600_000) return `${Math.floor(clamped / 60_000)}m`;
  if (clamped < 86_400_000) return `${Math.floor(clamped / 3_600_000)}h`;
  return `${Math.floor(clamped / 86_400_000)}d`;
}

/** Doctor-side: list every trial marker on disk and classify expired vs live.
 *  Returns a structured summary so doctor can render it inline. Sweeping the
 *  expired ones is gcExpiredTrials' job, not this function's -- scanTrials
 *  takes no GC flag and has no side effects. */
export interface TrialScanEntry {
  marker: TrialMarker;
  /** Absolute path of the scanned marker file. GC must unlink THIS path --
   *  not trialMarkerPath(marker.slug) -- so a marker whose filename doesn't
   *  match its slug field is still reclaimed instead of re-failing forever. */
  path: string;
  /** ms until expiry; negative when already expired. */
  msUntilExpiry: number;
  expired: boolean;
}

export interface TrialScanResult {
  live: TrialScanEntry[];
  expired: TrialScanEntry[];
  /** Markers that exist on disk but failed to parse — surface so doctor
   *  can tell the user to delete them by hand. */
  malformed: string[];
}

export async function scanTrials(opts: { home?: string; now?: () => number } = {}): Promise<TrialScanResult> {
  const home = opts.home ?? homedir();
  const now = opts.now ? opts.now() : Date.now();
  const dir = trialsDir(home);
  const result: TrialScanResult = { live: [], expired: [], malformed: [] };
  if (!existsSync(dir)) return result;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result;
  }
  for (const filename of entries) {
    if (!filename.endsWith(".json")) continue;
    const path = join(dir, filename);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as TrialMarker;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.slug !== "string" ||
        typeof parsed.expiresAt !== "number" ||
        typeof parsed.clientPath !== "string" ||
        // Not consumed by the peel, but doctor PRINTS it verbatim ("demo ->
        // claude-code (expires in 42m)"), so a hand-rolled marker without it
        // renders as "demo -> undefined". Malformed is the honest reading of a
        // marker missing a field every writer of ours fills in.
        typeof parsed.clientName !== "string" ||
        !Array.isArray(parsed.containerPath) ||
        typeof parsed.entryName !== "string" ||
        // Same trust check runTryCleanup applies: the GC deletes these three
        // fields' worth of state from a file named by the marker itself, so a
        // marker naming a non-trial entry -- or written by a schema we don't
        // understand -- is surfaced as malformed for the user rather than
        // acted on.
        rejectUntrustedMarker(parsed) !== null
      ) {
        result.malformed.push(path);
        continue;
      }
      const msUntilExpiry = parsed.expiresAt - now;
      const expired = msUntilExpiry <= 0;
      const entry: TrialScanEntry = { marker: parsed, path, msUntilExpiry, expired };
      if (expired) result.expired.push(entry);
      else result.live.push(entry);
    } catch {
      result.malformed.push(path);
    }
  }
  return result;
}

/** Sweep expired trials: peel each one out of its client config and delete
 *  the marker. Best-effort — failures on individual entries don't abort the
 *  sweep. Returns the count cleared so doctor can report it. */
export async function gcExpiredTrials(opts: {
  home?: string;
  now?: () => number;
  /** Precomputed scan to sweep. When omitted, gcExpiredTrials scans itself.
   *  doctor passes the scan it already needs for readout so the trials dir
   *  is scanned once per invocation instead of once here + once for readout. */
  scan?: TrialScanResult;
}): Promise<{ cleared: number; failed: number; failures: TrialGcFailure[] }> {
  const home = opts.home ?? homedir();
  const scan = opts.scan ?? (await scanTrials({ home, now: opts.now }));
  if (scan.expired.length === 0) return { cleared: 0, failed: 0, failures: [] };

  let cleared = 0;
  const failures: TrialGcFailure[] = [];
  for (const { marker, path } of scan.expired) {
    // Which step blew up decides what the user is told: a failed PEEL means
    // the entry is still wired into the client config; a failed UNLINK means
    // the config is already clean and only the marker lingers.
    let stage: TrialGcFailure["stage"] = "peel";
    try {
      // Routed through removeJsoncEntry (inside the shared peel) so user
      // comments in the client config survive doctor's GC pass -- the previous
      // JSON.parse + JSON.stringify shape silently stripped them.
      const outcome = await peelEntryFromConfig(marker.clientPath, marker.containerPath, marker.entryName);
      if (outcome === "not-object") {
        // Valid JSON, but not an object (an array, a string, a number):
        // removeJsoncEntry has no container to name the entry in, so the
        // peel cannot happen. Fail LOUDLY rather than falling through to
        // the unlink -- dropping the marker here would leave the trial
        // entry wired with nothing on disk that could ever name it again.
        // Throwing keeps stage "peel", which is what the user needs told.
        throw new Error(`${marker.clientPath} is not a JSON object`);
      }
      // Unlink the file that was actually scanned -- deriving the path from
      // marker.slug would orphan a marker whose filename mismatches its slug.
      stage = "unlink";
      await unlink(path);
      cleared++;
    } catch (e) {
      const error = (e as Error).message;
      log("debug", "trial gc failed", { slug: marker.slug, stage, error });
      failures.push({ slug: marker.slug, clientPath: marker.clientPath, markerPath: path, stage, error });
    }
  }
  return { cleared, failed: failures.length, failures };
}

/** One expired trial the sweep could not finish. Surfaced by doctor (text,
 *  --json, and the warnings that drive exit 2) with enough detail to act
 *  on: which slug, which file, and which step failed. */
export interface TrialGcFailure {
  slug: string;
  clientPath: string;
  markerPath: string;
  /** "peel": the entry is STILL in the client config. "unlink": the config
   *  is clean; only the marker file could not be deleted. */
  stage: "peel" | "unlink";
  error: string;
}

/** The doctor-facing wording for one gc failure, shared by the text TRIALS
 *  section, the --json warnings, and the stderr warning stream so all three
 *  surfaces say the same thing and gate exit 2 identically. */
export function trialGcFailureWarning(f: TrialGcFailure): string {
  return f.stage === "unlink"
    ? `trial "${f.slug}": its entry was removed from ${f.clientPath}, but the marker ${f.markerPath} could not be deleted (${f.error}) -- delete that marker by hand`
    : `trial "${f.slug}": expired but could not be removed from ${f.clientPath} (${f.error}) -- still wired in; run \`yaw-mcp try-cleanup ${f.slug}\` or edit that file by hand`;
}
