// Append-only audit trail for secret-vault resolution at spawn time.
//
// One global log at ~/.yaw-mcp/secrets-audit.log, NDJSON (one JSON object
// per line), mode 0o600. Each line records that a named secret was
// injected into (or was missing for) a given server's spawn env -- the
// secret NAME and the server namespace ONLY, never the value. The log
// lets a user answer "which secrets did this server actually consume, and
// when" without ever persisting plaintext.
//
// Discipline:
//   - NEVER write a secret value. The event shape has no value field.
//   - Writes are FAIL-OPEN: appendAuditEvent swallows every error so a
//     broken/unwritable log can never block or crash a server spawn. The
//     audit trail is a convenience, not a correctness dependency.
//   - Reads are NOT: readAuditLog returns [] only for an ABSENT log and
//     throws for one that exists but cannot be read, so `secrets audit`
//     never reports an unreadable trail as an empty one.
//   - Tail-capped at 5000 lines on append so the file can't grow without
//     bound on a long-lived process.

import { existsSync } from "node:fs";
import { appendFile, chmod, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.js";
import { CONFIG_DIRNAME } from "./paths.js";

export const SECRETS_AUDIT_FILENAME = "secrets-audit.log";

/** Max lines retained in the audit log. On append, if the file exceeds
 *  this, the oldest lines are trimmed so the tail of recent activity is
 *  kept. Chosen high enough that a normal session never trims, low enough
 *  the file stays small (~hundreds of KB at the cap). */
export const AUDIT_TAIL_CAP = 5000;

/** How far below the cap a trim cuts. The gap is HYSTERESIS, and it is the
 *  whole point: trimming back to exactly AUDIT_TAIL_CAP leaves the file at
 *  the trigger threshold, so the very next append is over the cap again and
 *  re-reads plus atomically rewrites the whole ~400-500 KB log -- forever,
 *  once per spawned secret. Cutting 500 lines deeper amortizes that rewrite
 *  over ~500 appends. The READ cap is unchanged (a trim still triggers only
 *  above AUDIT_TAIL_CAP); this only decides how much is kept once one runs. */
const AUDIT_TRIM_TO = AUDIT_TAIL_CAP - 500;

export type AuditEventKind = "injected" | "missing";

export interface AuditEvent {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Server namespace the secret was resolved for. */
  server: string;
  /** Secret NAME (never a value). */
  secret: string;
  /** Whether the secret was injected or was referenced-but-absent. */
  event: AuditEventKind;
}

/** Input to appendAuditEvent: the caller supplies server/secret/event;
 *  `ts` is stamped here so every line is consistently formatted. */
export interface AuditEventInput {
  server: string;
  secret: string;
  event: AuditEventKind;
}

export function auditLogPath(home: string = homedir()): string {
  return join(home, CONFIG_DIRNAME, SECRETS_AUDIT_FILENAME);
}

/**
 * Append one audit event as an NDJSON line. FAIL-OPEN: any error (dir
 * missing, permission denied, disk full) is swallowed so a broken log
 * never blocks a server spawn. The 0o600 chmod + tail-cap are best-effort
 * for the same reason.
 */
export async function appendAuditEvent(input: AuditEventInput, home: string = homedir()): Promise<void> {
  try {
    const event: AuditEvent = {
      ts: new Date().toISOString(),
      server: input.server,
      secret: input.secret,
      event: input.event,
    };
    const path = auditLogPath(home);
    const line = `${JSON.stringify(event)}\n`;

    if (!existsSync(path)) {
      // First write: atomicWriteFile mkdirs ~/.yaw-mcp/ (born 0o700) and
      // writes the log born 0o600, so the file and any parent dir it creates
      // are locked down from birth -- matching saveVault. The chmod below
      // just normalizes the umask masking.
      await atomicWriteFile(path, line, "utf8", 0o600, 0o700);
    } else {
      await appendFile(path, line, "utf8");
    }
    if (process.platform !== "win32") {
      await chmod(path, 0o600).catch(() => undefined);
    }
    await trimToTailCap(path);
  } catch {
    // Fail open -- the audit trail must never break a spawn.
  }
}

/** Conservative lower bound on the byte length of one line appendAuditEvent
 *  writes. The shortest possible event line -- 24-char ISO timestamp, empty
 *  server, empty secret, `"missing"` -- is 76 bytes including the newline,
 *  so 64 leaves headroom while staying a valid lower bound. */
const MIN_AUDIT_LINE_BYTES = 64;

/** Trim the log to the last AUDIT_TRIM_TO lines once it has grown past
 *  AUDIT_TAIL_CAP. Best-effort and swallowed by the caller's try/catch. */
async function trimToTailCap(path: string): Promise<void> {
  // Cheap size gate first: a file smaller than cap * MIN_AUDIT_LINE_BYTES
  // cannot hold more than AUDIT_TAIL_CAP of our lines, so skip the read
  // entirely. Without it every single append re-read the whole log (a few
  // hundred KB once the file is near the cap) just to discover it was
  // under. Caveat: hand-appended lines shorter than the bound could push
  // the LINE count over the cap while the file stays under the byte gate.
  // The cap is a best-effort size guard, not an invariant.
  const { size } = await stat(path);
  if (size < AUDIT_TAIL_CAP * MIN_AUDIT_LINE_BYTES) return;
  const raw = await readFile(path, "utf8");
  // Split on newlines; the trailing "" after the final newline is dropped.
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length <= AUDIT_TAIL_CAP) return;
  // Cut to AUDIT_TRIM_TO, not to the cap: landing exactly ON the trigger
  // makes every later append rewrite the whole file. See AUDIT_TRIM_TO.
  const kept = lines.slice(lines.length - AUDIT_TRIM_TO);
  // Rewrite via atomicWriteFile (temp + rename, born 0o600): the swap is
  // atomic, so a concurrent appendFile from another yaw-mcp process can no
  // longer interleave at the byte level to leave a garbled half-line. The
  // residual race is benign -- an append landing between the readFile above
  // and the rename is cleanly LOST, but the file is always a complete, valid
  // NDJSON snapshot, never torn. The cost is at most a few dropped audit
  // lines, never a secret (the file holds names only), and readAuditLog
  // skips any malformed line regardless. The size gate above keeps even that
  // window rare: it opens only when the log is genuinely over the cap.
  await atomicWriteFile(path, `${kept.join("\n")}\n`, "utf8", 0o600);
}

export interface AuditFilter {
  /** Only events for this secret NAME. */
  secret?: string;
  /** Only events for this server namespace. */
  server?: string;
}

/**
 * Read the audit log, newest line last (file order). Malformed lines are
 * skipped rather than throwing -- a partially-written tail line shouldn't
 * sink the whole read. Returns [] when the file does not exist.
 *
 * Reads are NOT fail-open the way writes are. A write that fails must never
 * block a spawn; a read that fails has nothing to block, and reporting [] for
 * a log that EXISTS but cannot be read told the operator "no events recorded
 * yet" about a trail sitting right there (EACCES, EISDIR, EIO) -- the same
 * absent-vs-unreadable collapse loadVault refuses to make. ENOENT is the only
 * "no trail yet" signal; every other read error throws, naming the path and
 * the errno, for `secrets audit` to render.
 */
export async function readAuditLog(filter: AuditFilter = {}, home: string = homedir()): Promise<AuditEvent[]> {
  const path = auditLogPath(home);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return [];
    throw new Error(`could not read the audit log at ${path} (${e.code ?? e.message})`);
  }
  const out: AuditEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip a malformed / torn line
    }
    if (!isAuditEvent(parsed)) continue;
    if (filter.secret !== undefined && parsed.secret !== filter.secret) continue;
    if (filter.server !== undefined && parsed.server !== filter.server) continue;
    out.push(parsed);
  }
  return out;
}

function isAuditEvent(v: unknown): v is AuditEvent {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.ts === "string" &&
    typeof e.server === "string" &&
    typeof e.secret === "string" &&
    (e.event === "injected" || e.event === "missing")
  );
}
