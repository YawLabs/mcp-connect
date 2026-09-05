// `yaw-mcp secrets <action>` -- manage the encrypted secret vault at
// ~/.yaw-mcp/secrets.json.
//
// Actions: set / get / list / remove / lock / rotate / audit. The vault
// is local-only; spawn-time substitution of ${secret:NAME} references in
// bundles.json env values lives in upstream.ts.
//
// Passphrase resolution (highest precedence first):
//   1. YAW_MCP_VAULT_PASSPHRASE env var
//   2. Interactive prompt on stdin (TTY only, --no-echo via raw mode)
//   3. Error -- no passphrase available
//
// Destructive paths are gated the way install-cmd gates an existing-entry
// collision -- confirm on a TTY, and off a TTY either refuse naming the
// flag to re-run with (remove) or proceed with a message that says what
// really happened (set over an existing name). See the block in runSecrets
// for why the two differ. --force skips only the confirmation, never the
// passphrase.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { type AuditEvent, readAuditLog } from "./secrets-audit.js";
import {
  getSecret,
  listKeys,
  loadVault,
  lock,
  newVault,
  removeSecret,
  rotateVault,
  SECRET_NAME_RE,
  SECRETS_SCHEMA_VERSION,
  saveVault,
  setSecret,
  unlock,
  VAULT_CHECK_CORRUPT_ERROR,
  VaultEntryCorruptError,
  type VaultFile,
  vaultPath,
} from "./secrets-vault.js";

export const SECRETS_USAGE = `Usage: yaw-mcp secrets <action> [args]

  Manage your encrypted secret vault at ~/.yaw-mcp/secrets.json.

Actions:
  set <name>              Store a secret. Reads value from stdin (one
                          line, no echo). Override with --value <v> or
                          --stdin (raw, multi-line) for scripting. Setting
                          a name that already exists REPLACES it (confirmed
                          first on a TTY; scripted runs proceed and say
                          "Replaced" instead of "Stored").
  get <name>              Decrypt and print one secret value to stdout.
                          NOTE: this prints the secret in CLEARTEXT (with
                          or without --json). Redirect to a file or pipe
                          to a consumer; avoid running it interactively so
                          the value does not land in terminal scrollback.
  list                    Show vault entry names (values stay encrypted).
  remove <name>           Delete an entry. Unrecoverable, so it asks you
                          to confirm on a TTY (bare Enter = no) and refuses
                          without --force when there is no TTY to ask on.
  lock                    Effectively a NO-OP from the CLI. Forgets the
                          passphrase cached in THIS process's memory, and
                          every CLI run is its own short-lived process with
                          its own cache, so there is nothing left to forget
                          by the time it runs. It CANNOT reach a yaw-mcp
                          server that is already running (that one keeps its
                          own cached key until it exits), does NOT change the
                          vault on disk (which only ever holds ciphertext),
                          and does NOT revoke anything. To cut off a running
                          server, stop the server.
  rotate                  Re-encrypt every entry under a NEW passphrase
                          (fresh salt + derived key). Re-wraps the
                          ENCRYPTION, NOT the underlying token values -- a
                          leaked token is still leaked; rotate it at its
                          source. Reads the current passphrase, then the
                          new one (env YAW_MCP_VAULT_PASSPHRASE_NEW or a
                          confirm-twice TTY prompt). Also the only upgrade
                          path for a vault file written under an older
                          schema: the rewritten file carries the current
                          version and every ciphertext is bound to its
                          entry name. (Every other command leaves the
                          file's schema as it found it, and says so on
                          stderr when it is behind.)
  audit [--secret NAME] [--server NS]
                          Show the local secret-resolution audit trail
                          (~/.yaw-mcp/secrets-audit.log): which secret
                          NAMES were injected into (or missing for) which
                          server, and when. Never shows a value.

Flags:
  --json                  Machine-readable output (where applicable).
  --value <v>             Inline secret value (set only). The value sits in
                          this process's argv, so it is visible to every
                          other local user via ps / /proc/<pid>/cmdline for
                          the whole run (which includes the ~100ms key
                          derivation), and it lands in your shell history.
                          For scripting use --stdin; interactively use the
                          default no-echo prompt.
  --stdin                 Read the secret from raw stdin (set only). The
                          scripting-safe alternative to --value: the value
                          never appears in argv.
  --force                 Skip the destructive-action confirmation
                          (remove, and a set that overwrites an existing
                          name). Required for remove when stdin or stdout
                          is not a TTY (both ends are needed to ask). NEVER
                          skips the passphrase.
  --secret <name>         (audit only) Filter to one secret name.
  --server <ns>           (audit only) Filter to one server namespace.

Passphrase:
  Set YAW_MCP_VAULT_PASSPHRASE in the env, or you will be prompted on
  the controlling TTY. The passphrase derives the encryption key via
  scrypt and is cached in memory for the lifetime of this yaw-mcp
  process; the on-disk vault only ever holds ciphertext. For rotate, the
  NEW passphrase comes from YAW_MCP_VAULT_PASSPHRASE_NEW (or a TTY
  confirm-twice prompt).`;

export interface SecretsCommandOptions {
  action?: "set" | "get" | "list" | "remove" | "lock" | "rotate" | "audit";
  name?: string;
  value?: string;
  fromStdin?: boolean;
  json?: boolean;
  /** Skip the destructive-action confirmation (remove, and a set that
   *  overwrites an existing name). Never skips the passphrase. */
  force?: boolean;
  /** For `audit`: filter to one secret name. */
  secretFilter?: string;
  /** For `audit`: filter to one server namespace. */
  serverFilter?: string;
  /** Test hooks. */
  home?: string;
  passphrase?: string;
  /** For `rotate`: the NEW passphrase (overrides env + TTY prompt in tests). */
  newPassphrase?: string;
  /** The streams the INTERACTIVE PROMPTS use: the raw-mode reader takes its
   *  bytes from `stdin` and writes its prompt text to `stdout`. Nothing else
   *  goes through here. Every warning and error takes runSecrets's `io.err`
   *  callback instead -- there used to be a `stderr` stream in this object
   *  that the short-passphrase and cleartext warnings wrote to, which meant
   *  an embedder supplying only the callbacks got those two lines on
   *  process.stderr and everything else through `err`. One sink now. */
  io?: {
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
  };
}

/** The ONE output sink for everything that is not a prompt: results on
 *  `out`, and every error envelope, warning and nudge on `err`. Declared
 *  once and threaded through every helper, so an embedder that supplies
 *  the pair captures the whole command -- no helper reaches for
 *  process.stderr (or a stream in `opts.io`) on its own. */
export interface SecretsIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

export function parseSecretsArgs(
  argv: string[],
): { ok: true; options: SecretsCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: SecretsCommandOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { ok: false, error: SECRETS_USAGE, help: true };
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    if (a === "--stdin") {
      opts.fromStdin = true;
      continue;
    }
    if (a === "--force") {
      opts.force = true;
      continue;
    }
    if (a === "--value") {
      const v = argv[++i];
      // Reject a following flag (e.g. `secrets set NAME --value --json`)
      // instead of storing "--json" as the secret. For a value that really
      // begins with a dash, use `--stdin` (which reads the raw value).
      if (v === undefined || v.startsWith("-")) {
        return {
          ok: false,
          error: `yaw-mcp secrets: --value requires a value (for a dash-leading value use --stdin)\n\n${SECRETS_USAGE}`,
        };
      }
      opts.value = v;
      continue;
    }
    if (a === "--secret" || a === "--server") {
      const v = argv[++i];
      // Same rule as --value: a following flag is a MISSING value, not a
      // filter literally named "--json" -- `audit --secret --json` used to
      // store "--json" as the secret filter and print an empty trail. A
      // dash-leading value is never a real filter here: a namespace cannot
      // start with one, and the CLI cannot even `set` a dash-leading name
      // (the positional would parse as an unknown flag).
      if (v === undefined || v.startsWith("-")) {
        return { ok: false, error: `yaw-mcp secrets: ${a} requires a value\n\n${SECRETS_USAGE}` };
      }
      if (a === "--secret") opts.secretFilter = v;
      else opts.serverFilter = v;
      continue;
    }
    if (a.startsWith("-")) {
      return { ok: false, error: `yaw-mcp secrets: unknown flag "${a}"\n\n${SECRETS_USAGE}` };
    }
    if (!opts.action) {
      if (
        a !== "set" &&
        a !== "get" &&
        a !== "list" &&
        a !== "remove" &&
        a !== "lock" &&
        a !== "rotate" &&
        a !== "audit"
      ) {
        return { ok: false, error: `yaw-mcp secrets: unknown action "${a}"\n\n${SECRETS_USAGE}` };
      }
      opts.action = a;
      continue;
    }
    if (!opts.name) {
      opts.name = a;
      continue;
    }
    return { ok: false, error: `yaw-mcp secrets: unexpected positional argument "${a}"\n\n${SECRETS_USAGE}` };
  }
  if (!opts.action) return { ok: false, error: `yaw-mcp secrets: missing action\n\n${SECRETS_USAGE}` };
  // Reject a positional for the actions that take no <name>. Swallowing it
  // was SILENT and actively misleading: `secrets audit GH_TOKEN` parsed,
  // dropped the name, and printed the ENTIRE trail -- so an operator asking
  // "where did GH_TOKEN go" read other secrets' events as if they were
  // GH_TOKEN's. The mistake is a natural one (set/get/remove all take
  // <name> positionally), so the audit message names the flag that really
  // filters.
  if (opts.name !== undefined && opts.action !== "set" && opts.action !== "get" && opts.action !== "remove") {
    const hint =
      opts.action === "audit"
        ? ` -- audit takes no <name>; filter with \`--secret ${opts.name}\` or \`--server ${opts.name}\``
        : ` -- ${opts.action} takes no <name>`;
    return {
      ok: false,
      error: `yaw-mcp secrets ${opts.action}: unexpected argument "${opts.name}"${hint}\n\n${SECRETS_USAGE}`,
    };
  }
  // The usage text marks these flags "(set only)" / "(audit only)", but the
  // parser used to accept and then silently drop them on every other action:
  // `secrets get NAME --stdin` and `secrets list --secret GH` both looked
  // like they did something. Refuse instead of ignoring.
  if (opts.action !== "set" && (opts.value !== undefined || opts.fromStdin)) {
    const flag = opts.value !== undefined ? "--value" : "--stdin";
    return { ok: false, error: `yaw-mcp secrets ${opts.action}: ${flag} applies to \`set\` only\n\n${SECRETS_USAGE}` };
  }
  // An empty --value is refused HERE for the same reason the name check
  // below is: runSecrets's own "cannot be empty" check sits after the
  // passphrase prompt and the scrypt derivation, so `--value ""` cost the
  // user a passphrase entry before hearing the value was never acceptable.
  // runSecrets keeps its check as the backstop for programmatic callers.
  if (opts.value !== undefined && opts.value.length === 0) {
    return { ok: false, error: `yaw-mcp secrets set: Secret value cannot be empty.\n\n${SECRETS_USAGE}` };
  }
  if (opts.action !== "audit" && (opts.secretFilter !== undefined || opts.serverFilter !== undefined)) {
    const flag = opts.secretFilter !== undefined ? "--secret" : "--server";
    return {
      ok: false,
      error: `yaw-mcp secrets ${opts.action}: ${flag} applies to \`audit\` only\n\n${SECRETS_USAGE}`,
    };
  }
  if ((opts.action === "set" || opts.action === "get" || opts.action === "remove") && !opts.name) {
    return { ok: false, error: `yaw-mcp secrets ${opts.action}: <name> is required\n\n${SECRETS_USAGE}` };
  }
  // Reject a name no ${secret:NAME} reference could ever address BEFORE any
  // prompt or key derivation. setSecret enforces the same rule, but only
  // after resolvePassphrase, the ~100ms scrypt derivation and the no-echo
  // value prompt -- so `yaw-mcp secrets set "my token"` used to make the
  // user type two secrets before hearing the name was never valid. The
  // regex is IMPORTED from secrets-vault.js, never re-spelled here: a
  // duplicated copy of this pattern was itself a finding in this repo.
  // Only `set` is checked. get/remove already short-circuit to `No secret
  // named "..."` without a prompt, and a vault written before the rule
  // existed must stay readable/removable by its legacy name.
  if (opts.action === "set" && opts.name !== undefined && !SECRET_NAME_RE.test(opts.name)) {
    return {
      ok: false,
      error: `yaw-mcp secrets set: invalid secret name "${opts.name}" -- use letters, digits, "_", "." or "-" only; other characters can never be referenced as \${secret:NAME}\n\n${SECRETS_USAGE}`,
    };
  }
  return { ok: true, options: opts };
}

export interface SecretsCommandResult {
  exitCode: number;
}

/** Wrap loadVault so a corrupt or unreadable on-disk vault surfaces a
 *  named, actionable message to the user rather than crashing the
 *  process. ENOENT still resolves to null (vault absent) -- only real
 *  errors throw out of loadVault. We catch them here and translate to
 *  a structured result the caller can return as exitCode:1. */
async function safeLoadVault(
  path: string,
  io: SecretsIo,
  json: boolean | undefined,
  action: string,
): Promise<{ ok: true; vault: VaultFile | null } | { ok: false; result: SecretsCommandResult }> {
  try {
    return { ok: true, vault: await loadVault(path) };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Branch on the ERROR TYPE, not on the message text. The old
    // /vault corrupt at entry (.+)$/ sniff is the discipline
    // unlockErrorMessage was fixed to avoid, and it failed for exactly the
    // input it most needed to handle: a legacy entry name containing a
    // newline defeats `.+$` (which cannot cross one), so the actionable hint
    // silently degraded to the raw message. NOTE: loadVault validates EVERY
    // entry, so `secrets remove <name>` cannot clear it either -- the fix has
    // to happen in the file itself.
    const name = err instanceof VaultEntryCorruptError ? err.entryName : undefined;
    const msg = name
      ? `secret entry ${name} is corrupt, and every secrets command fails until it is gone. Delete the "${name}" key from ${path} by hand (or delete that file to start the vault over), then re-add it with \`yaw-mcp secrets set ${name}\`.`
      : raw;
    if (json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets${action ? ` ${action}` : ""}: ${msg}\n`);
    return { ok: false, result: { exitCode: 1 } };
  }
}

/** "The vault file exists but could not be read", for the fingerprint
 *  guard below. A branded object (never a hex digest, never the null that
 *  means "file absent") carrying the read error so the refusal can name
 *  the real errno the way get/list do via loadVault. An unreadable file at
 *  either end of the comparison must read as CHANGED (refuse to save),
 *  never as a match. */
interface VaultUnreadable {
  readonly unreadable: true;
  readonly error: NodeJS.ErrnoException;
}
type VaultFingerprint = string | null | VaultUnreadable;

function isVaultUnreadable(fp: VaultFingerprint): fp is VaultUnreadable {
  return typeof fp === "object" && fp !== null && fp.unreadable === true;
}

/** sha256 of the vault file's current bytes; null when the file does not
 *  exist. Same role as trust-cmd's re-read-before-grant hash. */
async function vaultFingerprint(path: string): Promise<VaultFingerprint> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code === "ENOENT" ? null : { unreadable: true, error: e };
  }
}

/** True when the vault on disk no longer matches the bytes the command
 *  loaded. Every mutating secrets action blocks on unbounded interactive
 *  pauses (confirmations, passphrase and value prompts) between its load
 *  and its save; without this check, a concurrent `secrets set` in
 *  another terminal -- or a `rotate` the user was just told succeeded --
 *  was silently reverted by the stale in-memory snapshot. Mirrors
 *  trust-cmd's "a prompt is an unbounded pause" re-read-and-refuse.
 *
 *  This is a re-check, NOT a lock: the window between it and the rename in
 *  saveVault stays open, so two scripted non-interactive writes started in
 *  the same instant can both pass it and the second rename wins. That is
 *  the accepted shape today -- the guard exists for the interactive pauses,
 *  which are seconds to minutes wide. If scripted parallel writes ever
 *  become a use case, the fix is an advisory lock file around the whole
 *  read-modify-write, not a tighter re-check. */
async function vaultChangedSinceLoad(path: string, baseline: VaultFingerprint): Promise<boolean> {
  const now = await vaultFingerprint(path);
  if (isVaultUnreadable(now) || isVaultUnreadable(baseline)) return true;
  return now !== baseline;
}

/** Refusal for a vault file that exists but could not be read for the
 *  baseline fingerprint. Emitted BEFORE any prompt: the pre-save re-check
 *  treats an unreadable baseline as "changed", so continuing would only
 *  collect the user's input and then refuse with the wrong reason. Names
 *  the errno so set/remove/rotate report the same cause get/list surface
 *  through loadVault for the identical on-disk state. */
function vaultUnreadableResult(
  io: SecretsIo,
  json: boolean | undefined,
  action: string,
  path: string,
  fp: VaultUnreadable,
): SecretsCommandResult {
  const cause = fp.error.code ?? fp.error.message;
  const msg = `could not read the vault file at ${path} (${cause}) -- fix that and re-run. Nothing was written.`;
  if (json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
  else io.err(`yaw-mcp secrets${action ? ` ${action}` : ""}: ${msg}\n`);
  return { exitCode: 1 };
}

/** Persist the vault, turning a write failure into this command's normal
 *  error envelope instead of an escaping rejection.
 *
 *  saveVault can reject for reasons that have nothing to do with the vault's
 *  contents -- EACCES on the config dir, ENOSPC, EXDEV on the atomic rename
 *  across a mount boundary. Awaited bare, that rejection unwound all the way
 *  to the CLI entry point, which prints prose (`yaw-mcp secrets: <msg>`) --
 *  so a `--json` caller that had received clean JSON envelopes for every
 *  other failure got a bare prose line on stderr for this one and its parse
 *  broke. Returns null on success, or the result the caller must return. */
async function saveVaultOrReport(
  path: string,
  vault: VaultFile,
  io: SecretsIo,
  json: boolean | undefined,
  action: string,
): Promise<SecretsCommandResult | null> {
  try {
    await saveVault(path, vault);
    return null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const cause = e.code ?? (err instanceof Error ? err.message : String(err));
    const msg = `could not write the vault file at ${path} (${cause}) -- nothing was saved.`;
    if (json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets${action ? ` ${action}` : ""}: ${msg}\n`);
    return { exitCode: 1 };
  }
}

/** Standard refusal for a vault that changed under a prompt. */
function vaultChangedResult(io: SecretsIo, json: boolean | undefined, action: string): SecretsCommandResult {
  const msg =
    "the vault changed on disk while this command was waiting for input -- nothing was written. Re-run to work from the current vault.";
  if (json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
  else io.err(`yaw-mcp secrets${action ? ` ${action}` : ""}: ${msg}\n`);
  return { exitCode: 1 };
}

/** Render an unlock() failure for the user.
 *
 *  unlock() reports the corrupt-verification-token case distinctly from a
 *  wrong passphrase, but it cannot name the file the vault came from, so
 *  the actionable fix hint is attached here. Compared against the exported
 *  constant rather than sniffed out of the message text -- the same
 *  discipline safeLoadVault's corrupt-entry hint should have had. Every
 *  other unlock error (including the real wrong-passphrase one) passes
 *  through verbatim. */
function unlockErrorMessage(err: unknown, path: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg !== VAULT_CHECK_CORRUPT_ERROR) return msg;
  return `${msg}. Your entries are intact: delete the "check" key from ${path} by hand and re-run -- the next \`yaw-mcp secrets set\` re-stamps it.`;
}

/** Returned by the passphrase readers when the user hits ^C at a prompt.
 *  Distinct from "" (empty submission -> re-prompt) and from null (no
 *  passphrase obtainable). The reader NEVER calls process.exit(): the io
 *  streams are injectable, so a test or an embedder must not be able to
 *  kill the host process by feeding it a 0x03 byte. runSecrets turns this
 *  into exitCode 130 (128 + SIGINT) and the CLI entry point owns the exit. */
const CANCELLED: unique symbol = Symbol("yaw-mcp:passphrase-cancelled");
type Cancelled = typeof CANCELLED;

/** Standard result for a ^C at any passphrase prompt. */
function cancelledResult(io: SecretsIo, json: boolean | undefined): SecretsCommandResult {
  const msg = "Cancelled.";
  if (json) io.err(`${JSON.stringify({ ok: false, error: msg, cancelled: true })}\n`);
  else io.err(`yaw-mcp secrets: ${msg}\n`);
  return { exitCode: 130 };
}

/** Standard result for a confirmation the user declined (or let default
 *  to no). Exit 1, matching install-cmd's "Aborted." abort path -- the
 *  command did not do what was asked, so it must not report success. */
function abortedResult(io: SecretsIo, json: boolean | undefined, action: string): SecretsCommandResult {
  const msg = "Aborted.";
  if (json) io.err(`${JSON.stringify({ ok: false, error: msg, aborted: true })}\n`);
  else io.err(`yaw-mcp secrets ${action}: ${msg}\n`);
  return { exitCode: 1 };
}

/** Which ends are a TTY. Reads the INJECTED streams (never process.stdin
 *  directly) so tests drive it the same way they drive the passphrase
 *  prompts. Split out from isInteractiveTTY because the refusal message
 *  has to name the end that ACTUALLY failed. */
function ttyEnds(opts: SecretsCommandOptions): { stdin: boolean; stdout: boolean } {
  const stdin = opts.io?.stdin ?? process.stdin;
  const stdout = opts.io?.stdout ?? process.stdout;
  return {
    stdin: (stdin as { isTTY?: boolean }).isTTY === true,
    stdout: (stdout as { isTTY?: boolean }).isTTY === true,
  };
}

/** Can we prompt? Both ends must be a TTY: stdin to read the answer,
 *  stdout to show the question. */
function isInteractiveTTY(opts: SecretsCommandOptions): boolean {
  const ends = ttyEnds(opts);
  return ends.stdin && ends.stdout;
}

/** Name the end(s) that are not a TTY, for the non-interactive refusal.
 *  Naming stdin unconditionally was wrong for the common
 *  `yaw-mcp secrets remove NAME --json | jq` shape: run from an interactive
 *  shell that has a perfectly good TTY stdin and only a piped STDOUT, so the
 *  message sent the user to inspect the wrong half of their pipeline. */
function nonTTYEnds(opts: SecretsCommandOptions): string {
  const ends = ttyEnds(opts);
  if (!ends.stdin && !ends.stdout) return "neither stdin nor stdout is a TTY";
  return ends.stdin ? "stdout is not a TTY" : "stdin is not a TTY";
}

/** The "cannot obtain a passphrase" refusal. The default wording sends the
 *  user to "a TTY" -- which is actively WRONG on Git Bash / MSYS, where the
 *  user IS sitting at a terminal but MSYS emulates it with named pipes, so
 *  Node reports isTTY false and the prompt can never fire. When the env says
 *  MSYS and prompting really was impossible (a std end is not a TTY, as
 *  opposed to a TTY user exhausting the re-prompt budget), name the real
 *  cause and the remedies instead of telling the user their terminal does
 *  not exist. MSYSTEM is set by every Git Bash flavour (MINGW64 / MINGW32 /
 *  UCRT64 / MSYS). */
function promptUnavailableMessage(opts: SecretsCommandOptions, required: string, envVar: string): string {
  if (!isInteractiveTTY(opts) && (process.env.MSYSTEM ?? "") !== "") {
    return `${required} Node cannot prompt under Git Bash/MSYS -- the terminal is emulated with pipes, not a TTY. Set ${envVar}, run under winpty (winpty yaw-mcp ...), or use PowerShell/cmd.`;
  }
  return `${required} Set ${envVar} or run from a TTY so we can prompt.`;
}

/** Ask a destructive-action question on the TTY. Defaults to NO: only an
 *  explicit y/yes proceeds, so a bare Enter (or ^D, or anything else)
 *  leaves the vault alone. Echoes what is typed -- a confirmation is not
 *  a secret -- but otherwise shares the passphrase reader, so ^C still
 *  cancels the whole command instead of counting as "no". */
async function promptYesNo(opts: SecretsCommandOptions, question: string): Promise<boolean | Cancelled> {
  const stdin = opts.io?.stdin ?? process.stdin;
  const stdout = opts.io?.stdout ?? process.stdout;
  const answer = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout, `${question} [y/N] `, true);
  if (answer === CANCELLED) return CANCELLED;
  const a = answer.trim().toLowerCase();
  return a === "y" || a === "yes";
}

/** Warn (never block) when an ACCEPTED passphrase is under the soft floor.
 *
 *  Applies to every path a passphrase can arrive on, not just the env var.
 *  Warning only on the env path was backwards: the interactive prompt is
 *  the one place a human actually CHOOSES a passphrase, so `secrets set` on
 *  a fresh vault could create it under "abc" with no feedback while the
 *  equivalent YAW_MCP_VAULT_PASSPHRASE=abc run warned. Against the exfil
 *  threat model the vault is built for (offline attack on the stolen file),
 *  a 3-character passphrase is trivially brute-forced regardless of which
 *  path it came in on.
 *
 *  Always the `err` channel (stderr by default), never `out`: stdout
 *  carries `get`'s cleartext value and the --json envelopes, and a warning
 *  must never pollute either. The same `io.err` every error envelope takes,
 *  not a separate stream -- this used to write to `opts.io.stderr`, so an
 *  embedder supplying only the callbacks got this one line on
 *  process.stderr and everything else through `err`. */
function warnIfShortPassphrase(io: SecretsIo, passphrase: string, subject: string, hint?: string): void {
  if (passphrase.length >= MIN_PASSPHRASE_WARN_LEN) return;
  io.err(
    `yaw-mcp secrets: warning -- ${subject} is shorter than ${MIN_PASSPHRASE_WARN_LEN} characters; consider a longer passphrase.${
      hint ? ` ${hint}` : ""
    }\n`,
  );
}

/** One-time guidance printed when `set` CREATES the vault.
 *
 *  The gap this closes: STORING a secret and USING one happen in two
 *  different processes. `secrets set` runs in the user's own shell, where
 *  the passphrase was just supplied. The "${secret:NAME}" substitution runs
 *  inside the yaw-mcp that the MCP CLIENT spawns (upstream.ts's
 *  resolveServerEnv), which has its own environment and cannot prompt for
 *  anything. Set the passphrase only in the shell you typed this command
 *  in and you get a vault that works perfectly from the CLI and a server
 *  that refuses to start, with nothing on either surface connecting the
 *  two. No SUCCESS path in the CLI mentioned the env var at all before
 *  this -- it was discoverable by reading the README, or by hitting the
 *  failure and reading the error.
 *
 *  Fires on vault CREATION only: once per vault, at the one moment the
 *  user has just proven they intend to use secrets, and never again on the
 *  second or the hundredth `set`. doctor carries the standing check from
 *  there on, including for vaults created before this nudge existed.
 *
 *  Always stderr, even under --json: stdout carries the JSON envelope and
 *  `get`'s cleartext, and neither may be polluted. Same rule as
 *  warnIfShortPassphrase. Reports only WHETHER the env var is set, never
 *  its value -- CLI output gets pasted into bug reports. */
function freshVaultNudge(io: SecretsIo, path: string): void {
  const envSet = (process.env.YAW_MCP_VAULT_PASSPHRASE ?? "").length > 0;
  // Plain quoted strings, not template literals: every line below carries a
  // literal "${secret:...}" that a template literal would try to interpolate.
  const lines = envSet
    ? [
        "  YAW_MCP_VAULT_PASSPHRASE is set in THIS shell, but ${secret:NAME} refs are resolved",
        "  by the yaw-mcp your MCP client launches, which has its own environment -- set it",
        "  there too, or that process starts locked. `yaw-mcp doctor` reports whether it is set.",
      ]
    : [
        "  yaw-mcp resolves ${secret:NAME} refs at server-spawn time and needs this passphrase",
        "  to do it. Set YAW_MCP_VAULT_PASSPHRASE in the environment your MCP client launches",
        "  yaw-mcp from. Without it, a server whose env references ${secret:...} asks for the",
        "  passphrase in-session (on clients that support elicitation) or fails to start.",
        "  `yaw-mcp doctor` reports whether it is set.",
      ];
  io.err(`yaw-mcp secrets: created the vault at ${path}.\n${lines.join("\n")}\n`);
}

/** One `err` line when a loaded vault is behind this build's schema.
 *
 *  The v2 name binding (secrets-vault.ts's AAD) only engages for a file
 *  that SAYS v2, and nothing but `rotate` ever rewrites the version:
 *  setSecret spreads the vault it was given, so a v1 file stays v1 through
 *  years of `set`s -- every entry position-independent (a blob swapped
 *  between PROD and DEV still decrypts) while the vault header and the
 *  CHANGELOG describe the binding as shipped. No surface told the user:
 *  not `list`, not `set`, not doctor. This is that surface -- once per
 *  command that loads such a vault, on `err` (never `out`, which carries
 *  `get`'s cleartext and the --json envelopes; same rule as
 *  warnIfShortPassphrase, and like it, it fires under --json too). rotate
 *  is the one command that does not call it: it IS the upgrade.
 *
 *  Under --json the notice is its own JSON LINE, not prose: every error
 *  envelope this command emits goes to `err` too, so a --json wrapper parses
 *  stderr line by line -- and a prose warning ahead of an `{"ok":false,...}`
 *  envelope made every failing list/get/set/remove on a pre-v2 vault
 *  unparseable to it. `ok: true` because the warning is about the FILE, not
 *  a failure of the command that loaded it; `warning` is the discriminator
 *  a consumer keys on. */
function schemaBehindNotice(io: SecretsIo, vault: VaultFile, path: string, json: boolean | undefined): void {
  if (vault.version >= SECRETS_SCHEMA_VERSION) return;
  if (json) {
    io.err(
      `${JSON.stringify({
        ok: true,
        warning: "schema-behind",
        schema: vault.version,
        current: SECRETS_SCHEMA_VERSION,
        upgrade: "yaw-mcp secrets rotate",
        path,
      })}\n`,
    );
    return;
  }
  io.err(
    `yaw-mcp secrets: warning -- the vault at ${path} is schema v${vault.version} (this build writes v${SECRETS_SCHEMA_VERSION}); its ciphertexts are not bound to their entry names until \`yaw-mcp secrets rotate\` rewrites it. No other command upgrades the file.\n`,
  );
}

/** Read the passphrase. Env var wins; falls back to a stdin prompt
 *  that disables terminal echo via raw mode. Returns null when no
 *  passphrase can be obtained (non-TTY + no env), or CANCELLED when the
 *  user hit ^C at the prompt. */
async function resolvePassphrase(
  opts: SecretsCommandOptions,
  io: SecretsIo,
  confirm = false,
): Promise<string | null | Cancelled> {
  if (opts.passphrase !== undefined) return opts.passphrase.length > 0 ? opts.passphrase : null;
  const fromEnv = process.env.YAW_MCP_VAULT_PASSPHRASE;
  // An empty env var ("") is treated the same as absent -- deriving a key
  // from "" would otherwise silently unlock any vault. The env path is
  // single-shot even when `confirm` is set: a scripted value has no second
  // entry to compare against, and a CI passphrase is not a typo to catch.
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    warnIfShortPassphrase(io, fromEnv, "YAW_MCP_VAULT_PASSPHRASE");
    return fromEnv;
  }
  const stdin = opts.io?.stdin ?? process.stdin;
  const stdout = opts.io?.stdout ?? process.stdout;
  if (!isInteractiveTTY(opts)) return null;
  // Creating a vault: it has no check marker yet, so unlock() accepts ANY
  // passphrase -- a first-set typo would silently BECOME the vault's
  // (unrecoverable) passphrase. Confirm it twice, like rotate's
  // resolveNewPassphrase, so the two entries must agree before we commit.
  if (confirm) {
    for (let attempt = 0; attempt < MAX_PASSPHRASE_PROMPTS; attempt++) {
      const first = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout, "Vault passphrase: ");
      if (first === CANCELLED) return CANCELLED;
      if (first.length === 0) {
        stdout.write("Passphrase cannot be empty.\n");
        continue;
      }
      const second = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout, "Confirm passphrase: ");
      if (second === CANCELLED) return CANCELLED;
      if (first === second) {
        // This is the ONE prompt where a human picks the vault's passphrase
        // for good -- warn here or the weak choice is never mentioned.
        warnIfShortPassphrase(io, first, "the passphrase you chose");
        return first;
      }
      stdout.write("Passphrases did not match. Try again.\n");
    }
    return null;
  }
  // Reject an empty passphrase (bare Enter / EOF with nothing typed):
  // deriving a key from "" would otherwise unlock any vault. Re-prompt up
  // to a few times, then give up so we never spin forever on a closed pipe.
  for (let attempt = 0; attempt < MAX_PASSPHRASE_PROMPTS; attempt++) {
    const entered = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout);
    if (entered === CANCELLED) return CANCELLED;
    if (entered.length > 0) {
      // Unlocking an EXISTING vault. unlock() has NOT run yet, so this string
      // is just what was typed -- it may be a typo that is about to be rejected.
      // Describe it as "the passphrase you entered" (never as the vault's) and
      // make the rotate pointer conditional: a fat-fingered short entry must
      // not be told to re-key a passphrase that was never wrong. When the entry
      // IS the vault's, `secrets rotate` remains the fix -- a retype cannot
      // lengthen a passphrase already committed to the vault.
      warnIfShortPassphrase(
        io,
        entered,
        "the passphrase you entered",
        "If it unlocks this vault, re-key it with `yaw-mcp secrets rotate`.",
      );
      return entered;
    }
    stdout.write("Passphrase cannot be empty.\n");
  }
  return null;
}

/** Resolve the NEW passphrase for `rotate`. Precedence:
 *    1. opts.newPassphrase (test hook)
 *    2. YAW_MCP_VAULT_PASSPHRASE_NEW env var
 *    3. TTY confirm-twice prompt (must match; non-empty)
 *  Returns null when none can be obtained (non-TTY + no env) or the two
 *  TTY entries disagree after the allowed prompts, and CANCELLED when the
 *  user hit ^C at either prompt. */
async function resolveNewPassphrase(opts: SecretsCommandOptions, io: SecretsIo): Promise<string | null | Cancelled> {
  if (opts.newPassphrase !== undefined) return opts.newPassphrase.length > 0 ? opts.newPassphrase : null;
  const fromEnv = process.env.YAW_MCP_VAULT_PASSPHRASE_NEW;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    warnIfShortPassphrase(io, fromEnv, "the new passphrase");
    return fromEnv;
  }
  const stdin = opts.io?.stdin ?? process.stdin;
  const stdout = opts.io?.stdout ?? process.stdout;
  if (!isInteractiveTTY(opts)) return null;
  for (let attempt = 0; attempt < MAX_PASSPHRASE_PROMPTS; attempt++) {
    const first = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout, "New vault passphrase: ");
    if (first === CANCELLED) return CANCELLED;
    if (first.length === 0) {
      stdout.write("Passphrase cannot be empty.\n");
      continue;
    }
    const second = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout, "Confirm new passphrase: ");
    if (second === CANCELLED) return CANCELLED;
    if (first === second) {
      warnIfShortPassphrase(io, first, "the new passphrase");
      return first;
    }
    stdout.write("Passphrases did not match. Try again.\n");
  }
  return null;
}

/** Cap re-prompts for an empty passphrase so a closed/EOF stdin can't
 *  loop forever. */
const MAX_PASSPHRASE_PROMPTS = 3;

/** Soft floor for a passphrase: shorter than this triggers a stderr
 *  warning (never a hard block) on EVERY path a passphrase arrives on --
 *  env var, TTY creation prompt, TTY unlock prompt, and rotate's new
 *  passphrase. See warnIfShortPassphrase. */
const MIN_PASSPHRASE_WARN_LEN = 12;

/** Control bytes the raw-mode reader reacts to. Spelled as escapes: the
 *  literal bytes are invisible in an editor and get mangled by tooling. */
const CTRL_C = "\x03"; // ETX -- cancel the whole command
const CTRL_D = "\x04"; // EOT -- cancel this entry (caller re-prompts)
const DEL = "\x7f"; // what most terminals send for Backspace
const ESC = "\x1b"; // opens a key sequence (arrow, Alt chord) -- never input

/** Raw-mode line reader for the controlling TTY. Shared by the passphrase
 *  prompts (echo OFF -- the default), the destructive-action confirmation
 *  (echo ON, so the user can see the y/n they typed), and -- via
 *  readAnswerFromTTY below -- `yaw-mcp trust`'s approval prompt. One reader
 *  means ^C / ^D / Backspace / a stray ESC behave identically at every
 *  prompt in the product. */
function readLineFromTTY(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WritableStream,
  prompt = "Vault passphrase: ",
  echo = false,
): Promise<string | Cancelled> {
  stdout.write(prompt);
  return new Promise<string | Cancelled>((resolve) => {
    const chunks: string[] = [];
    const wasRaw = stdin.isRaw === true;
    try {
      stdin.setRawMode?.(true);
    } catch {
      // not a TTY, fall through to line-buffered read
    }
    stdin.resume();
    stdin.setEncoding("utf8");
    // Single teardown path: detach the listener, restore the previous raw
    // mode, pause stdin, then settle. Every exit from onData goes through it.
    const finish = (value: string | Cancelled): void => {
      stdout.write("\n");
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode?.(wasRaw);
      } catch {
        // ignore
      }
      stdin.pause();
      resolve(value);
    };
    // Escape-sequence parser state, carried ACROSS chunks: a terminal can
    // split an arrow key's bytes over two reads, and the tail of one must
    // not be taken for typed text.
    let esc: "none" | "esc" | "seq" = "none";
    // Hoisted declaration so `finish` above can name it.
    function onData(chunk: string): void {
      let consumed = 0;
      // Settle, then RE-BUFFER whatever follows the byte that ended this
      // read. A terminal paste arrives as one chunk, so without this,
      // pasting "passphrase\nvalue\n" consumed the passphrase and silently
      // dropped the value line -- the next prompt then hung waiting for
      // input the user believes they already gave. unshift() puts the
      // residual at the head of the stream (finish() has already paused
      // it), so the NEXT reader's resume() picks it up. Optional call: the
      // injectable io contract only promises a ReadableStream shape.
      const finishAndRebuffer = (value: string | Cancelled): void => {
        finish(value);
        const rest = chunk.slice(consumed);
        if (rest.length > 0) (stdin as { unshift?: (c: string) => void }).unshift?.(rest);
      };
      for (const ch of chunk) {
        consumed += ch.length;
        // ESC "[" (CSI) and ESC "O" (SS3) open a key sequence the terminal
        // sent on the user's behalf -- an arrow, Home/End, a function key --
        // and NONE of its bytes is input: it runs through a final byte in
        // 0x40-0x7e. Dropping only the 0x1b byte and buffering the rest
        // inserted "[D" / "[A" into the NO-ECHO value and passphrase prompts,
        // where the user could not see the corruption: a Left arrow to fix a
        // typo in a pasted token stored `ghp_abc[D`, and the server later
        // failed auth with nothing pointing at the vault. Any OTHER byte
        // after an ESC is handled as typed: the ESC was a lone Escape key,
        // or the meta prefix of an Alt chord, and neither is a reason to
        // lose the keystroke that follows -- so Escape-then-Enter still
        // submits, and Escape-then-y at a [y/N] prompt is still a y. A
        // control byte never continues a sequence either.
        if (esc === "esc") {
          esc = "none";
          if (ch === "[" || ch === "O") {
            esc = "seq";
            continue;
          }
        } else if (esc === "seq") {
          if (ch >= " ") {
            if (ch >= "@" && ch <= "~") esc = "none";
            continue;
          }
          esc = "none";
        }
        if (ch === ESC) {
          esc = "esc";
          continue;
        }
        if (ch === "\n" || ch === "\r") {
          // A pasted CRLF is ONE Enter: swallow the \n so it cannot be
          // re-buffered and submit the next prompt as empty.
          if (ch === "\r" && chunk[consumed] === "\n") consumed += 1;
          finishAndRebuffer(chunks.join(""));
          return;
        }
        if (ch === CTRL_D) {
          // Cancel this entry. Resolve to "" so the caller treats it as an
          // empty submission and re-prompts -- never a line terminator that
          // would submit a partial passphrase.
          finishAndRebuffer("");
          return;
        }
        if (ch === CTRL_C) {
          // Cancel the command. We deliberately do NOT process.exit() here:
          // the io streams are injectable, so a fed 0x03 must not be able to
          // kill the host process. The caller maps CANCELLED to exit 130.
          finishAndRebuffer(CANCELLED);
          return;
        }
        if (ch === "\b" || ch === DEL) {
          if (chunks.length > 0) {
            chunks.pop();
            if (echo) stdout.write("\b \b");
          }
          continue;
        }
        // Drop every remaining control byte instead of buffering + echoing
        // it. On the echo path (the y/n confirmation) a raw control byte
        // written back is EXECUTED by the terminal rather than displayed.
        // Everything meaningful (\n \r ^C ^D \b ESC) is handled above, so
        // nothing reachable here is input the user can see or intended to
        // type.
        if (ch < " ") continue;
        chunks.push(ch);
        if (echo) stdout.write(ch);
      }
    }
    stdin.on("data", onData);
  });
}

/**
 * Ask a one-line question on the terminal and hand back what was typed
 * (trimmed, lowercased by the caller). Returns null when the user hit ^C.
 *
 * Exists so `yaw-mcp trust` and `yaw-mcp secrets` share ONE prompt reader
 * instead of two. trust-cmd used node:readline, this file uses the raw-mode
 * reader above, and the fix for an ESC/arrow key at a [y/N] prompt (a raw ESC
 * echoed back is EXECUTED by the terminal, and "\x1by" is not "y", so the
 * answer silently flipped) landed in only one of them. Two implementations of
 * "read one confirmation" drift; this is the one.
 *
 * Echo is ON: a y/n answer is not a secret, and the user has to see it.
 */
export async function readAnswerFromTTY(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  question: string,
): Promise<string | null> {
  const answer = await readLineFromTTY(stdin as NodeJS.ReadStream, stdout, question, true);
  return answer === CANCELLED ? null : answer;
}

/** Returned by readStdinValue when stdin is a TTY (so there is nothing piped
 *  to read) but stdout is not (so the prompt cannot be shown). Distinct from
 *  CANCELLED: the user did not decline anything, the command simply has no
 *  way to ask. */
const PROMPT_IMPOSSIBLE: unique symbol = Symbol("yaw-mcp:value-prompt-impossible");
type PromptImpossible = typeof PROMPT_IMPOSSIBLE;

/** Read the secret VALUE: the interactive no-echo prompt, or raw stdin when
 *  it is piped (or --stdin forces it).
 *
 *  The interactive branch needs BOTH ends of the terminal, the same rule
 *  isInteractiveTTY applies to every other prompt in this file. Gating on
 *  stdin.isTTY alone meant `yaw-mcp secrets set GH > out.json` -- TTY stdin,
 *  redirected stdout -- wrote "Secret value: " INTO the redirect target,
 *  switched the terminal to raw no-echo mode, and then sat there waiting on
 *  a prompt the user could not see. Refusing is the honest answer; --value
 *  and --stdin are the scripted paths. */
async function readStdinValue(
  io?: SecretsCommandOptions["io"],
  forceRaw?: boolean,
): Promise<string | Cancelled | PromptImpossible> {
  const stdin = io?.stdin ?? process.stdin;
  const stdout = io?.stdout ?? process.stdout;
  const stdinIsTTY = (stdin as { isTTY?: boolean }).isTTY === true;
  const stdoutIsTTY = (stdout as { isTTY?: boolean }).isTTY === true;
  if (stdinIsTTY && !forceRaw) {
    if (!stdoutIsTTY) return PROMPT_IMPOSSIBLE;
    // Pass the label as the reader's PROMPT rather than writing it first:
    // the reader writes its own prompt, so pre-writing one printed
    // "Secret value: Vault passphrase: " and asked the user for the wrong
    // thing at the value prompt.
    return readLineFromTTY(stdin as NodeJS.ReadStream, stdout, "Secret value: ");
  }
  // Piped stdin -- read all and trim trailing newline.
  const chunks: string[] = [];
  stdin.setEncoding("utf8");
  for await (const chunk of stdin as unknown as AsyncIterable<string>) chunks.push(chunk);
  return chunks.join("").replace(/\r?\n$/, "");
}

export async function runSecrets(
  opts: SecretsCommandOptions,
  io: SecretsIo = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
): Promise<SecretsCommandResult> {
  const home = opts.home ?? homedir();
  const path = vaultPath(home);

  // Lock is the only action that does not need a passphrase. From the CLI it
  // is effectively a no-op (see SECRETS_USAGE): this process's cache is the
  // only thing it can clear, and the process is about to exit anyway. The
  // output says exactly that -- "Vault locked." read as a revocation, and
  // the bare {locked:true} envelope let a script believe one had happened.
  if (opts.action === "lock") {
    lock();
    if (opts.json) {
      io.out(
        `${JSON.stringify({ ok: true, locked: true, scope: "this-process", running_servers_affected: false, vault_changed: false })}\n`,
      );
    } else {
      io.out(
        "Passphrase cache cleared for this process only. A running yaw-mcp server keeps its own cached key until it exits, and the vault on disk is unchanged.\n",
      );
    }
    return { exitCode: 0 };
  }

  // rotate resolves BOTH passphrases itself (current + new), so it runs
  // ahead of the shared single-passphrase path below.
  if (opts.action === "rotate") {
    return await runSecretsRotate(opts, io);
  }

  // audit is a read-only command -- no passphrase needed (it never
  // touches ciphertext, only the names/timestamps in the audit log).
  if (opts.action === "audit") {
    return await runSecretsAudit(opts, io);
  }

  if (opts.action === "list") {
    const loaded = await safeLoadVault(path, io, opts.json, "list");
    if (!loaded.ok) return loaded.result;
    const vault = loaded.vault;
    if (vault) schemaBehindNotice(io, vault, path, opts.json);
    const keys = vault ? listKeys(vault) : [];
    // `vault` here is the load result, not a second existsSync probe: two
    // reads of the same fact can disagree under a concurrent create, and
    // loadVault already distinguished absent (null) from unreadable (threw).
    if (opts.json) io.out(`${JSON.stringify({ ok: true, vault: vault !== null, keys }, null, 2)}\n`);
    else if (!vault) io.out(`No vault at ${path}. Run \`yaw-mcp secrets set <name>\` to create one.\n`);
    else if (keys.length === 0) io.out(`Vault at ${path} is empty.\n`);
    else {
      io.out(`Vault at ${path}\n`);
      for (const k of keys) io.out(`  ${k}\n`);
    }
    return { exitCode: 0 };
  }

  // One load for every remaining action -- the get/remove existence check
  // below and the mutate path share it (reading the file twice raced with
  // itself and doubled the I/O for no benefit).
  // Fingerprint the on-disk bytes BEFORE the load, not after: the mutating
  // actions re-check it immediately before their save and refuse if the
  // file moved (vaultChangedSinceLoad), and taking the baseline second
  // would open a load-to-baseline gap where a concurrent writer's bytes
  // become the baseline while the in-memory vault is the older parse --
  // the re-check would then pass and silently revert that write. In the
  // baseline-first order a write landing between the two reads makes the
  // re-check FAIL (refusal), the safe direction. get never saves, so it
  // skips the extra read.
  const baseline = opts.action === "get" ? null : await vaultFingerprint(path);
  // An unreadable baseline dooms every save (the re-check can never match),
  // so fail NOW with the real cause rather than after the confirmation,
  // scrypt derivation and value prompt with a misleading "changed on disk".
  if (isVaultUnreadable(baseline)) return vaultUnreadableResult(io, opts.json, opts.action ?? "", path, baseline);
  const loaded = await safeLoadVault(path, io, opts.json, opts.action ?? "");
  if (!loaded.ok) return loaded.result;
  if (loaded.vault) schemaBehindNotice(io, loaded.vault, path, opts.json);

  // Short-circuit get/remove when the vault is missing or the entry
  // doesn't exist -- avoids prompting for a passphrase and paying the
  // scrypt derivation just to say "not found".
  //
  // This is the ONLY place the not-found message and its exit code live.
  // The get and remove bodies below used to repeat the same check against
  // the same (already-proven) vault; both copies were unreachable, and a
  // future edit to the wording or exit code here would have silently
  // diverged from them.
  if (opts.action === "get" || opts.action === "remove") {
    const name = opts.name as string;
    // Object.hasOwn, not `in`: entries comes from JSON.parse and inherits
    // Object.prototype, so `secrets get toString` would otherwise pass.
    if (!loaded.vault || !Object.hasOwn(loaded.vault.entries, name)) {
      const msg = `No secret named "${name}" in the vault.`;
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
      else io.err(`yaw-mcp secrets: ${msg}\n`);
      return { exitCode: 1 };
    }
  }

  // ----- destructive-action confirmation --------------------------------
  // Same shape as install-cmd's existing-entry collision gate: prompt when
  // stdin+stdout are a TTY, and when they are not, either refuse naming the
  // flag to re-run with, or proceed -- per action.
  //
  // The asymmetry between remove and set is deliberate:
  //   remove -- UNRECOVERABLE. The ciphertext is gone and nothing in this
  //             tool can bring it back, so a non-interactive run has to opt
  //             in explicitly with --force.
  //   set    -- an overwrite is a SWAP the user is performing with the new
  //             value already in hand, and re-setting a name is the normal
  //             credential-rotation path. Requiring --force there would
  //             break every rotation script, so a non-TTY run proceeds --
  //             the success message just has to say it REPLACED a value
  //             rather than claiming a fresh write.
  //
  // Both gates run BEFORE the passphrase prompt so a declined confirmation
  // never costs the user a passphrase entry. --force skips only the
  // confirmation: the passphrase and its scrypt derivation still happen.
  const replacing =
    opts.action === "set" && loaded.vault !== null && Object.hasOwn(loaded.vault.entries, opts.name as string);

  if (opts.action === "remove" && !opts.force) {
    if (isInteractiveTTY(opts)) {
      const confirmed = await promptYesNo(opts, `Permanently delete secret "${opts.name}"? This cannot be undone.`);
      if (confirmed === CANCELLED) return cancelledResult(io, opts.json);
      if (!confirmed) return abortedResult(io, opts.json, "remove");
    } else {
      const msg = `refusing to delete "${opts.name}" without confirmation and ${nonTTYEnds(opts)}.`;
      const hint = "Re-run with --force to delete it. This cannot be undone.";
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: `${msg} ${hint}` })}\n`);
      else io.err(`yaw-mcp secrets remove: ${msg}\n  ${hint}\n`);
      return { exitCode: 2 };
    }
  }

  if (replacing && !opts.force && isInteractiveTTY(opts)) {
    const confirmed = await promptYesNo(
      opts,
      `Secret "${opts.name}" already exists. Replace it? The stored value is overwritten.`,
    );
    if (confirmed === CANCELLED) return cancelledResult(io, opts.json);
    if (!confirmed) return abortedResult(io, opts.json, "set");
  }

  // Remaining actions all need the vault + passphrase. "Fresh" is the load
  // result itself, not a second existsSync probe: the probe re-asked the
  // filesystem a fact the load already settled, and the two could disagree
  // under a concurrent create (file appears between load and probe -> the
  // in-memory vault is empty but the run says it is not creating one).
  let vault = loaded.vault ?? newVault();
  const isFresh = loaded.vault === null;

  // A vault with no check marker AND no entries has nothing for unlock() to
  // verify a passphrase against, so it accepts ANY passphrase -- the first
  // interactive `set` silently ESTABLISHES the vault passphrase, and a typo
  // there creates a vault the user can never unlock again. Confirm it twice
  // on the TTY (like rotate's new passphrase). Only `set` reaches here on a
  // fresh vault -- get/remove short-circuit above -- and the env-var path
  // stays single-shot inside resolvePassphrase.
  const creatingVault = opts.action === "set" && !vault.check && Object.keys(vault.entries).length === 0;

  const passphrase = await resolvePassphrase(opts, io, creatingVault);
  if (passphrase === CANCELLED) return cancelledResult(io, opts.json);
  if (passphrase === null) {
    const msg = promptUnavailableMessage(opts, "Passphrase required.", "YAW_MCP_VAULT_PASSPHRASE");
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets: ${msg}\n`);
    return { exitCode: 1 };
  }

  let key: Buffer;
  try {
    key = await unlock(vault, passphrase);
  } catch (err) {
    const msg = unlockErrorMessage(err, path);
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets: ${msg}\n`);
    return { exitCode: 1 };
  }

  // ----- set ------------------------------------------------------------
  if (opts.action === "set") {
    const name = opts.name as string;
    let value: string;
    if (opts.value !== undefined) value = opts.value;
    else {
      const entered = await readStdinValue(opts.io, opts.fromStdin);
      if (entered === CANCELLED) return cancelledResult(io, opts.json);
      if (entered === PROMPT_IMPOSSIBLE) {
        const msg =
          "cannot prompt for the value: stdin is a TTY but stdout is not, so the prompt would be written into the redirect instead of shown. Pass --value <v>, or pipe the value in with --stdin.";
        if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
        else io.err(`yaw-mcp secrets set: ${msg}\n`);
        return { exitCode: 1 };
      }
      value = entered;
    }
    if (!value) {
      const msg = "Secret value cannot be empty.";
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
      else io.err(`yaw-mcp secrets: ${msg}\n`);
      return { exitCode: 1 };
    }
    try {
      // setSecret rejects a name no ${secret:NAME} reference could ever
      // address (spaces, colons, braces) -- surface that as a normal CLI
      // error instead of an unhandled rejection. For the CLI path
      // parseSecretsArgs already rejected it before any prompt; this is
      // the backstop for programmatic callers of runSecrets.
      vault = setSecret(vault, key, name, value);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
      else io.err(`yaw-mcp secrets set: ${msg}\n`);
      return { exitCode: 1 };
    }
    if (await vaultChangedSinceLoad(path, baseline)) return vaultChangedResult(io, opts.json, "set");
    // atomicWriteFile mkdirs the target dir, so no ensureVaultDir needed.
    const failed = await saveVaultOrReport(path, vault, io, opts.json, "set");
    if (failed) return failed;
    // "Replaced" vs "Stored" is the only signal a scripted run gets that it
    // just destroyed a previous value (the non-TTY path proceeds without a
    // confirmation), so the two cases must never print the same line.
    if (opts.json) io.out(`${JSON.stringify({ ok: true, name, fresh_vault: isFresh, replaced: replacing })}\n`);
    else if (replacing) io.out(`Replaced secret "${name}".\n`);
    else io.out(`${isFresh ? "Created vault and " : ""}Stored secret "${name}".\n`);
    // Creating the vault is the one moment the CLI can tell the user that
    // the passphrase has to reach the yaw-mcp their CLIENT spawns, not just
    // the shell they typed this in. See freshVaultNudge.
    if (isFresh) freshVaultNudge(io, path);
    return { exitCode: 0 };
  }

  // ----- get ------------------------------------------------------------
  if (opts.action === "get") {
    const name = opts.name as string;
    try {
      // Non-null by construction: the short-circuit above returned exit 1
      // for a missing name (and for a missing vault) before the passphrase
      // prompt, so `vault` is `loaded.vault` with `name` present and
      // getSecret's own hasOwn check cannot fail. The not-found message
      // lives there, once.
      const value = getSecret(vault, key, name) as string;
      // Warn (on `err`, never `out` -- keeps the value pipeable) when the
      // caller is interactive: `get` prints cleartext, so an interactive run
      // scrolls a secret into terminal scrollback. Skipped for piped/redirected
      // stdout, which is the intended consumption path.
      const outStream = opts.io?.stdout ?? process.stdout;
      if ((outStream as { isTTY?: boolean }).isTTY === true) {
        io.err(
          `yaw-mcp secrets: warning -- printing "${name}" in cleartext to your terminal; it will remain in scrollback.\n`,
        );
      }
      if (opts.json) io.out(`${JSON.stringify({ ok: true, name, value })}\n`);
      else io.out(`${value}\n`);
      return { exitCode: 0 };
    } catch (err) {
      // The passphrase itself was already verified by unlock() above (via
      // the vault check stamp, or the first-entry canary on a legacy
      // vault), so "wrong passphrase" is NOT reachable here. What is: this
      // one entry is damaged, or it was written under a different key than
      // the rest of the vault by an older build.
      const msg = err instanceof Error ? err.message : String(err);
      const hint = `Entry "${name}" failed to decrypt: it is corrupt, or it was written under a different passphrase than the rest of the vault. Remove it and set it again.`;
      if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg, hint })}\n`);
      else io.err(`yaw-mcp secrets: ${msg}\n  ${hint}\n`);
      return { exitCode: 1 };
    }
  }

  // ----- remove ---------------------------------------------------------
  if (opts.action === "remove") {
    const name = opts.name as string;
    // Existence was proven by the short-circuit above (the single owner of
    // the not-found message), so removeSecret always has something to drop.
    if (await vaultChangedSinceLoad(path, baseline)) return vaultChangedResult(io, opts.json, "remove");
    vault = removeSecret(vault, name);
    const failed = await saveVaultOrReport(path, vault, io, opts.json, "remove");
    if (failed) return failed;
    if (opts.json) io.out(`${JSON.stringify({ ok: true, removed: name })}\n`);
    else io.out(`Removed "${name}".\n`);
    return { exitCode: 0 };
  }

  // Should not reach here -- parseSecretsArgs guards the action set.
  io.err(`yaw-mcp secrets: unknown action ${opts.action}\n`);
  return { exitCode: 2 };
}

/**
 * Re-encrypt the whole vault under a new passphrase.
 *
 * Flow:
 *   1. Load the local vault; error if none.
 *   2. Resolve + verify the CURRENT passphrase (unlock validates the key
 *      against vault.check, so a wrong current passphrase is rejected
 *      before any rotation).
 *   3. Resolve the NEW passphrase (env / TTY confirm-twice).
 *   4. rotateVault decrypts every entry under the old key FIRST (aborting
 *      on any failure with the on-disk vault untouched), then re-encrypts
 *      under a fresh salt + the new key.
 *   5. Save atomically, lock() to drop the stale in-memory key.
 */
async function runSecretsRotate(opts: SecretsCommandOptions, io: SecretsIo): Promise<SecretsCommandResult> {
  const home = opts.home ?? homedir();
  const path = vaultPath(home);

  // safeLoadVault, not raw loadVault: a corrupt vault must come back as the
  // same {ok:false} envelope the sibling actions emit (and stay JSON under
  // --json) instead of escaping as a rejection the dispatcher formats.
  // Same pre-load fingerprint as runSecrets (baseline BEFORE the load so a
  // write straddling the two reads fails the re-check instead of slipping
  // under it): both passphrase prompts below are unbounded pauses, and
  // saving a rotation derived from a stale snapshot would revert whatever
  // landed in the meantime (or, the mirror image, a concurrent `set`
  // would revert this rotation).
  const baseline = await vaultFingerprint(path);
  // Same fail-fast as runSecrets: an unreadable baseline can never pass the
  // pre-save re-check, so refuse before either passphrase prompt.
  if (isVaultUnreadable(baseline)) return vaultUnreadableResult(io, opts.json, "rotate", path, baseline);
  const loaded = await safeLoadVault(path, io, opts.json, "rotate");
  if (!loaded.ok) return loaded.result;
  const vault = loaded.vault;
  if (!vault) {
    const msg = `No vault at ${path} to rotate. Run \`yaw-mcp secrets set <name>\` first.`;
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets rotate: ${msg}\n`);
    return { exitCode: 1 };
  }

  const currentPassphrase = await resolvePassphrase(opts, io);
  if (currentPassphrase === CANCELLED) return cancelledResult(io, opts.json);
  if (currentPassphrase === null) {
    const msg = promptUnavailableMessage(opts, "Current passphrase required.", "YAW_MCP_VAULT_PASSPHRASE");
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets rotate: ${msg}\n`);
    return { exitCode: 1 };
  }

  let oldKey: Buffer;
  try {
    oldKey = await unlock(vault, currentPassphrase);
  } catch (err) {
    const msg = unlockErrorMessage(err, path);
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets rotate: ${msg}\n`);
    return { exitCode: 1 };
  }

  const newPassphrase = await resolveNewPassphrase(opts, io);
  if (newPassphrase === CANCELLED) return cancelledResult(io, opts.json);
  if (newPassphrase === null) {
    const msg = promptUnavailableMessage(
      opts,
      "New passphrase required (and must be confirmed).",
      "YAW_MCP_VAULT_PASSPHRASE_NEW",
    );
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets rotate: ${msg}\n`);
    return { exitCode: 1 };
  }

  let rotated: VaultFile;
  try {
    // rotateVault decrypts EVERY entry first; if any fails it throws
    // before re-encrypting, so the on-disk vault stays untouched.
    rotated = await rotateVault(vault, oldKey, newPassphrase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets rotate: ${msg}\n`);
    // On-disk vault is untouched by definition (we never reached save).
    lock();
    return { exitCode: 1 };
  }

  if (await vaultChangedSinceLoad(path, baseline)) {
    // Belt-and-braces, NOT load-bearing: unlock() keys its cache on the
    // vault's salt (cachedSalt in secrets-vault.ts), so a key derived against
    // the snapshot we just refused to overwrite can never be handed to
    // whatever replaced it -- which is why `set` and `remove` take these same
    // two exits without a lock() and still cannot leak a stale key. rotate
    // drops it anyway: holding a derived key for a vault this command was
    // just told it does not have is state with no use left.
    lock();
    return vaultChangedResult(io, opts.json, "rotate");
  }
  const failed = await saveVaultOrReport(path, rotated, io, opts.json, "rotate");
  if (failed) {
    // Same belt-and-braces drop as the refusal above: the on-disk vault is
    // still the pre-rotation one (so the cached key remains valid for it),
    // but the caller was just told nothing was saved. Only the lock() on the
    // success path below is load-bearing -- there the salt really changed.
    lock();
    return failed;
  }
  // Drop the stale key derived from the OLD passphrase. The salt changed,
  // so the next secrets command must re-derive against the new passphrase.
  lock();

  const count = Object.keys(rotated.entries).length;

  if (opts.json) {
    io.out(`${JSON.stringify({ ok: true, rotated: true, secret_count: count })}\n`);
  } else {
    io.out(
      `Rotated ${count} secret${count === 1 ? "" : "s"} under a new passphrase (encryption re-wrapped, token values unchanged).\n`,
    );
    io.out("Vault locked -- the next secrets command will prompt for the new passphrase.\n");
  }
  return { exitCode: 0 };
}

/** Render + filter the local secret-resolution audit log. Read-only; never
 *  decrypts anything (the log holds only names/timestamps). */
async function runSecretsAudit(opts: SecretsCommandOptions, io: SecretsIo): Promise<SecretsCommandResult> {
  const home = opts.home ?? homedir();
  let events: AuditEvent[];
  try {
    events = await readAuditLog(
      {
        ...(opts.secretFilter !== undefined ? { secret: opts.secretFilter } : {}),
        ...(opts.serverFilter !== undefined ? { server: opts.serverFilter } : {}),
      },
      home,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) io.err(`${JSON.stringify({ ok: false, error: msg })}\n`);
    else io.err(`yaw-mcp secrets audit: ${msg}\n`);
    return { exitCode: 1 };
  }

  if (opts.json) {
    io.out(`${JSON.stringify({ ok: true, count: events.length, events }, null, 2)}\n`);
    return { exitCode: 0 };
  }

  if (events.length === 0) {
    io.out("No secret-resolution audit events recorded yet.\n");
    return { exitCode: 0 };
  }
  for (const e of events) {
    io.out(`${e.ts}  ${e.event === "injected" ? "injected" : "missing "}  ${e.server}  ${e.secret}\n`);
  }
  return { exitCode: 0 };
}

// Re-export for tests + sibling modules
export type { VaultFile } from "./secrets-vault.js";
