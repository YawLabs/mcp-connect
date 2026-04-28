// `mcph reset-learning` — delete ~/.mcph/state.json so cross-session
// learning starts fresh. Pairs with the doctor RELIABILITY section (see
// doctor-cmd.ts) and the dispatch penalty branch (learning.ts):
// once doctor has flagged a namespace as flaky, its penalty keeps
// suppressing routing to it until enough new successes pile up.
// If the user fixed the underlying issue (rotated the token, swapped
// the upstream, re-authed the account) the history is now stale and
// that penalty has overstayed its welcome — this command wipes it.
//
// Scope is intentionally "all or nothing." A per-namespace flag feels
// nice but the failure mode is a footgun (user clears one namespace,
// forgets about three others, keeps getting silently mis-ranked).
// If finer granularity is ever needed we can add `--namespace <ns>`
// as an additive flag without breaking the current contract.
//
// Exit codes:
//   0  normal: file removed, nothing to remove, or persistence disabled
//   1  I/O error: file existed but couldn't be removed (permissions, etc.)

import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { userConfigDir } from "./paths.js";
import { STATE_FILENAME, loadState } from "./persistence.js";

export const RESET_LEARNING_USAGE = `Usage: mcph reset-learning

  Delete ~/.mcph/state.json so cross-session learning starts fresh.
  Use this after fixing the root cause of a flaky upstream (token
  rotated, account swapped, server replaced) so the routing penalty
  doesn't keep suppressing it.

  -h, --help  Show this help.`;

export type ParsedResetLearning =
  | { kind: "help" }
  | { kind: "error"; error: string }
  | { kind: "ok"; options: Record<string, never> };

// Argv parser. Crucially, this exists so `mcph reset-learning --help`
// doesn't fall through to runResetLearning() and silently delete state.
export function parseResetLearningArgs(argv: string[]): ParsedResetLearning {
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    return {
      kind: "error",
      error: `mcph reset-learning: unknown argument "${arg}"\n\n${RESET_LEARNING_USAGE}`,
    };
  }
  return { kind: "ok", options: {} };
}

export interface ResetLearningOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to process.stdout.write. */
  out?: (s: string) => void;
  /** Override for tests; defaults to process.stderr.write. */
  err?: (s: string) => void;
}

export interface ResetLearningResult {
  exitCode: number;
  /** Lines printed to stdout/stderr, in order — exposed for tests. */
  lines: string[];
  /** True when the state file was actually deleted. */
  removed: boolean;
  /** Absolute path we targeted — useful for the "nothing to reset" message. */
  path: string;
}

export async function runResetLearning(opts: ResetLearningOptions = {}): Promise<ResetLearningResult> {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  const lines: string[] = [];
  const print = (s = ""): void => {
    lines.push(s);
    write(`${s}\n`);
  };
  const printErr = (s: string): void => {
    lines.push(s);
    writeErr(`${s}\n`);
  };

  const filePath = join(userConfigDir(home), STATE_FILENAME);

  // When persistence is disabled, the running mcph session isn't
  // reading or writing state.json anyway. A stale file on disk could
  // still exist from a prior session when the env wasn't set — we
  // leave it alone. Rationale: the env flag is usually a temporary
  // opt-out (CI, sandbox, debug); wiping real history every time
  // someone runs this command under the flag would surprise users who
  // expected their opt-out to be non-destructive. If they really want
  // the file gone they can unset the flag and re-run.
  const raw = env.MCPH_DISABLE_PERSISTENCE;
  const disabled = raw !== undefined && raw !== "" && (raw === "1" || raw.toLowerCase() === "true");
  if (disabled) {
    print("mcph reset-learning: persistence is disabled (MCPH_DISABLE_PERSISTENCE) — nothing to clear.");
    return { exitCode: 0, lines, removed: false, path: filePath };
  }

  // Peek before deleting so we can report what was cleared. loadState
  // is tolerant — missing file, malformed JSON, and version mismatch
  // all return emptyState, so we can't distinguish those cases here.
  // That's fine: in all three we'll report 0/0 below and then the
  // unlink either succeeds (malformed / version mismatch) or hits
  // ENOENT (missing) which we handle.
  const persisted = await loadState(filePath);
  const learningCount = Object.keys(persisted.learning).length;
  const packCount = persisted.packHistory.length;

  try {
    await unlink(filePath);
  } catch (err) {
    if (isFileNotFound(err)) {
      print("mcph reset-learning: no persisted state to reset.");
      print(`  path: ${filePath}`);
      return { exitCode: 0, lines, removed: false, path: filePath };
    }
    const msg = err instanceof Error ? err.message : String(err);
    printErr(`mcph reset-learning: failed to remove ${filePath}: ${msg}`);
    return { exitCode: 1, lines, removed: false, path: filePath };
  }

  print("mcph reset-learning: cleared persisted state.");
  print(`  path: ${filePath}`);
  print(`  learning entries removed:     ${learningCount}`);
  print(`  pack history entries removed: ${packCount}`);
  return { exitCode: 0, lines, removed: true, path: filePath };
}

function isFileNotFound(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}
