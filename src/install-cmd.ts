// `yaw-mcp install <client> [flags]` — auto-edits the chosen MCP client's
// config file so the user doesn't have to hand-write JSON or hunt for
// per-OS file paths.
//
// The client's config file (e.g., ~/.claude.json for Claude Code user
// scope) is the only file this touches: the yaw-mcp launch entry (written
// under the key `mcp` -- ENTRY_NAME) is merged in, preserving any other
// `mcpServers` / `servers` keys the user already has, plus every sibling
// along the container key path (Claude Code local scope nests under
// projects[<absDir>].mcpServers). Claude Code additionally gets a
// `permissions.allow` patch in its settings.json.
//
// The key is `mcp`, NOT `yaw-mcp`: that spelling is a LEGACY_ENTRY_NAME now,
// detected only to nudge the user into deleting it. Anything keying off this
// file's behaviour (a migration, an external doctor check) must read `mcp`.
//
// ~/.yaw-mcp/config.json is NO LONGER written by install. It existed to carry
// the account token across clients, and yaw-mcp is local-only now — servers
// come from ~/.yaw-mcp/bundles.json. `--token` and `--no-yaw-mcp-config`
// are still ACCEPTED so scripted installs keep exiting 0, but they are
// inert and print a deprecation warning to stderr.
//
// WRITING is what stopped, not reading: config-loader.ts still READS that file
// (servers / blocked / installNudge), and migrate.ts still hoists a 0.11.x
// legacy dotfile into it on upgrade. A file present there is live config, not
// a leftover -- deleting it changes behaviour.
//
// Failure semantics:
//   - Existing client file with malformed JSON  → refuse, point at the file.
//   - Existing `mcp` entry                      → prompt (TTY) or refuse
//                                                  with --force/--skip flag.
//   - Client file changed between read + write  → refuse, ask for a re-run
//                                                  (see the fingerprint check
//                                                  ahead of atomicWriteFile).
//   - settings.json changed between read + write → warn and skip the
//                                                  best-effort permissions
//                                                  patch, exit 0 (same
//                                                  fingerprint check; the
//                                                  launch entry is already
//                                                  written, so nothing is
//                                                  refused).
//   - --dry-run                                  → print ONLY what would be
//                                                  added (the entry at its
//                                                  container path, the
//                                                  permissions.allow delta)
//                                                  and exit 0 without writing.
//                                                  Never the merged file: its
//                                                  siblings carry secrets, and
//                                                  the entry's own carried-over
//                                                  env prints keys only.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { atomicWriteFile } from "./atomic-write.js";
import { type ClientProbeResult, probeClientsAsync } from "./doctor-cmd.js";
import {
  buildLaunchEntry,
  CLAUDE_CODE_ALLOW_PATTERN,
  CURRENT_OS,
  ENTRY_NAME,
  findLegacyEntry,
  INSTALL_TARGETS,
  type InstallClientId,
  type InstallOS,
  type InstallScope,
  isProjectLocalEntry,
  resolveAppDataDir,
  resolveClaudeCodeSettingsPath,
  resolveInstallPath,
} from "./install-targets.js";
import { editJsoncEntry, parseJsonc } from "./jsonc.js";
import {
  MIN_OAM_VERSION,
  type OamProbe,
  oamFailureLabel,
  oamInstallCommand,
  oamNoBinaryReason,
  oamPublishesBinaryForThisMachine,
  probeOam,
  resolveStableNpmEntry,
} from "./oam-spawn.js";
import { QUESTION_CANCELLED, questionOrEmpty } from "./readline-question.js";

export interface InstallCommandOptions {
  /** Target client. Omitted when --list or --all drives the run. */
  clientId?: InstallClientId;
  scope?: InstallScope;
  os?: InstallOS;
  projectDir?: string;
  /** DEPRECATED and ignored. Used to be written to ~/.yaw-mcp/config.json.
   *  Still accepted (with a stderr warning) so scripted installs that pass
   *  `--token mcp_pat_...` keep working and keep exiting 0. */
  token?: string;
  /** Overwrite an existing yaw-mcp entry without prompting. */
  force?: boolean;
  /** Leave an existing yaw-mcp entry untouched (exit 0). */
  skip?: boolean;
  /** Print the changes that would be made and exit without writing. */
  dryRun?: boolean;
  /** Test seams for the oam launch-entry decision, mirroring runDoctor's
   *  `oamProbe`. Without these the entry written depends on whether the
   *  MACHINE running the tests happens to have oam plus a durable
   *  @yawlabs/mcp install -- so the npx-entry assertions would pass on CI and
   *  fail on a maintainer's box, which is the worst way for a test to fail. */
  oamProbe?: () => OamProbe | Promise<OamProbe>;
  resolveOamEntry?: (pkg: string) => string | null;
  /** Test seam for the third machine fact the oam-absent note reads: whether
   *  oam publishes a binary for THIS platform+arch. Defaults to
   *  oamPublishesBinaryForThisMachine(). Without it the withhold-the-installer
   *  branch of `oamAbsentNote` is reachable only from a linux-arm64 (or
   *  freebsd, or...) runner -- i.e. never on CI and never on a maintainer's
   *  box, so the one wording that has to be right for the users who cannot
   *  install oam at all was the one wording no test could see. */
  oamPublishesBinary?: () => boolean;
  /** DEPRECATED and ignored. Existed only to suppress the (now removed)
   *  ~/.yaw-mcp/config.json token write; install no longer touches that
   *  file at all. Still accepted, with a stderr warning. */
  skipYawMcpConfig?: boolean;
  /** Read-only: enumerate clients and show which scopes already host a yaw-mcp entry. */
  listOnly?: boolean;
  /** Install into every client available on this OS in one shot. */
  all?: boolean;
  /** Override for tests; defaults to homedir(). */
  home?: string;
  /** Windows %APPDATA% override for tests. When home is overridden and this
   *  is not, it is derived as <home>/AppData/Roaming so the claude-desktop
   *  path cannot escape a synthetic home (a write test with os=windows used
   *  to resolve through the REAL process.env.APPDATA). */
  appData?: string;
  /** Override for tests; defaults to process.cwd(). */
  cwd?: string;
  /** Claude Code's `CLAUDE_CONFIG_DIR`. When set, claude-code writes go
   *  to `<DIR>/.claude.json` and `<DIR>/settings.json` instead of the
   *  HOME-based defaults. Wrappers like Yaw Mode set this to point Claude
   *  Code at a per-session config; install must follow the redirect or
   *  the entry lands where Claude Code never reads it. The CLI dispatcher
   *  in index.ts populates this from `process.env.CLAUDE_CONFIG_DIR`;
   *  tests leave it undefined to stay hermetic against an env-set value. */
  claudeConfigDir?: string;
  /** Override for tests; defaults to process.stdin/stdout. */
  io?: {
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
    isTTY: boolean;
    /** Forces readline's keypress mode (what a real TTY gets), so a test can
     *  deliver Ctrl+C the way a terminal does. Defaults to readline's own
     *  verdict (output.isTTY). */
    terminal?: boolean;
  };
  /** Override for tests; replaces an interactive prompt with a fixed answer. */
  promptAnswer?: "overwrite" | "skip" | "abort";
  /** Set by the parser when `--help` / `-h` was passed. Dispatcher prints
   *  USAGE to stdout and exits 0 -- treated as a successful run, not an
   *  argv error. Keeps `-h` distinguishable from unknown-flag rejections. */
  helpRequested?: boolean;
  /** Internal, set by `--all`: suppress the oam-is-absent Runtime note so it
   *  prints once for the run instead of once per client. Same reasoning as the
   *  `token` / `skipYawMcpConfig` stripping at the --all call site -- a
   *  machine-level fact restated per client is noise, not diagnosis. */
  suppressOamAbsentNote?: boolean;
}

/** The oam-absent Runtime line. Shared so `--all`'s single copy and the
 *  per-client one cannot drift into two wordings of the same fact.
 *
 *  Deliberately NOT "node runs everything": uv/uvx and docker sidecars do not
 *  run on node either (see uv-bootstrap.ts), so the reassurance has to be about
 *  the runtime yaw-mcp is choosing between, not about server coverage. */
function oamAbsentNote(os: InstallOS, publishesBinary: () => boolean = oamPublishesBinaryForThisMachine): string {
  const head = "Runtime: node (oam is not installed, which is fine -- node is the supported default. ";
  // Withhold the installer where it cannot succeed: oam ships no linux-arm64
  // binary and install.sh refuses outright, so naming the one-liner here sends
  // the user to a command that exits non-zero for a runtime they never needed.
  if (os === CURRENT_OS && !publishesBinary()) {
    return `${head}oam is not an option on this machine: ${oamNoBinaryReason()}.)`;
  }
  return `${head}To host yaw-mcp on oam instead: \`${oamInstallCommand(os)}\`, then re-run install.)`;
}

/** True when the probe means oam is simply NOT INSTALLED -- both handles null,
 *  not below-min, no failure. The one Runtime reason that is not a
 *  misconfiguration, and so the one `--all` consolidates. Mirrors the tail of
 *  runInstall's reason-chain, which reaches its `else` under exactly these
 *  conditions. */
function oamIsAbsent(probe: OamProbe): boolean {
  return probe.bin === null && probe.binPath === null && !probe.belowMin && probe.failure === null;
}

/** %APPDATA% for this run, resolved in ONE place and threaded to
 *  resolveInstallPath (which reads no environment of its own).
 *
 *  Precedence: the explicit override; else a `home` override owns it, so a
 *  synthetic home cannot escape into the real process.env.APPDATA (see
 *  InstallCommandOptions.appData); else the machine's, which means the ambient
 *  %APPDATA% ahead of `<homedir()>/AppData/Roaming`. That last step is the
 *  load-bearing one: Windows lets %APPDATA% be redirected (roaming profiles,
 *  folder redirection) away from `<home>\AppData\Roaming`, and Claude Desktop
 *  reads the redirected location. Deriving it from HOME instead named a file
 *  the app never reads.
 *
 *  Shared by the write path and `--list` deliberately: spelled out separately,
 *  the two surfaces drifted into disagreeing about where claude-desktop's
 *  config lives on Windows -- install wrote the real one while --list reported
 *  the HOME-derived one. */
function resolveAppData(opts: InstallCommandOptions): string | undefined {
  return resolveAppDataDir({ appData: opts.appData, home: opts.home });
}

export interface InstallResult {
  /** Files that were written (empty in --dry-run). */
  written: string[];
  /** Files that would have been written (only populated in --dry-run). */
  wouldWrite: string[];
  /** Diagnostic messages already printed to the chosen stdout. */
  messages: string[];
  /** Process exit code. 0 = success, non-zero = refused/error. */
  exitCode: number;
}

const USAGE =
  "Usage: yaw-mcp install <claude-code|claude-desktop|cursor|vscode> [--scope user|project|local]\n" +
  "                       [--project-dir <path>] [--os macos|linux|windows]\n" +
  "                       [--force | --skip] [--dry-run]\n" +
  "       yaw-mcp install --list  (detect clients; no writes)\n" +
  // "every client available on this OS", NOT "every detected client":
  // runInstallAll plans from `availableOn` (the OSes a client ships on), not
  // from a probe of what is actually installed here, so `--all` creates a
  // config for clients the user may not have. That is deliberate (it
  // pre-provisions), and --list is the detecting one -- the help text just
  // has to stop promising detection.
  "       yaw-mcp install --all   (install into every client available on this OS)\n" +
  "\n" +
  "  Deprecated (accepted, ignored, warns): --token <mcp_pat_...>, --no-yaw-mcp-config.\n" +
  "  yaw-mcp is local-only -- it stores no token and never writes ~/.yaw-mcp/config.json.\n" +
  "  Configure servers in ~/.yaw-mcp/bundles.json (see `yaw-mcp add <slug>`).";

/** Warning printed when the retired `--token` flag is passed. Exported so
 *  tests pin the exact wording -- this is the user's only signal that a
 *  scripted `install --all --token mcp_pat_...` is now a no-op. */
export const TOKEN_FLAG_DEPRECATION =
  "yaw-mcp install: --token is deprecated and ignored -- yaw-mcp is local-only and no longer stores a token. " +
  "Drop the flag, and revoke that PAT at its source -- dropping it here does not deactivate it.";

/** Warning printed when the retired `--no-yaw-mcp-config` flag is passed. */
export const NO_CONFIG_FLAG_DEPRECATION =
  "yaw-mcp install: --no-yaw-mcp-config is deprecated and ignored -- install no longer writes " +
  "~/.yaw-mcp/config.json at all, so there is nothing to suppress.";

/** What `--dry-run` prints in place of each value of the env it carries over
 *  from the existing entry (see the preview in runInstall). Exported so tests
 *  pin that the preview shows the key and this, never the value. */
export const DRY_RUN_ENV_PLACEHOLDER = "<kept from existing entry>";

export async function runInstall(opts: InstallCommandOptions): Promise<InstallResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const messages: string[] = [];
  const log = (s: string): void => {
    messages.push(s);
    stdout.write(`${s}\n`);
  };
  const err = (s: string): void => {
    messages.push(s);
    stderr.write(`${s}\n`);
  };

  // Soft-deprecation notices. Emitted BEFORE the --list / --all dispatch so
  // they fire exactly once per top-level invocation; runInstallAll strips
  // both flags from its per-client recursion so they don't repeat N times.
  // Warn-and-continue by design: rejecting them would break every scripted
  // `yaw-mcp install --all --token mcp_pat_...` in the wild.
  if (opts.token !== undefined) err(TOKEN_FLAG_DEPRECATION);
  if (opts.skipYawMcpConfig) err(NO_CONFIG_FLAG_DEPRECATION);

  if (opts.listOnly && opts.all) {
    err("yaw-mcp install: --list and --all are mutually exclusive");
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  // ABOVE the --list/--all dispatch, like the pair check right above it: this
  // is an argv-level usage error, not a per-client one. Below the dispatch it
  // fired inside every sub-install `--all` planned, so the user got
  // "Installing into N clients", one identical refusal per planned client, and
  // exit 1 reported as "N/N client installs failed" -- a runtime-failure code
  // for what is a usage error.
  if (opts.force && opts.skip) {
    err("yaw-mcp install: --force and --skip are mutually exclusive");
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  // Both sub-commands write into the SAME `messages` array this call already
  // accumulates (log/err push into it), so the returned InstallResult carries
  // the full printed trail -- including the deprecation notices emitted above
  // the dispatch, which a second, locally-built array silently dropped.
  if (opts.listOnly) return runInstallList(opts, log, messages);
  if (opts.all) return runInstallAll(opts, log, err, messages);

  if (!opts.clientId) {
    err(`yaw-mcp install: client argument required\n${USAGE}`);
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  const target = INSTALL_TARGETS.find((t) => t.clientId === opts.clientId);
  if (!target) {
    err(`yaw-mcp install: unknown client ${opts.clientId}\n${USAGE}`);
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  const os = opts.os ?? CURRENT_OS;
  if (!target.availableOn.includes(os)) {
    const fix =
      target.clientId === "claude-desktop" && os === "linux"
        ? "Anthropic ships Claude Desktop on macOS and Windows only. Install Claude Code or Cursor instead."
        : // NOT "pass --os to override": install resolves paths against THIS
          // machine, so a cross-OS --os write is refused at the flag boundary
          // (see parseInstallArgs) — only the --dry-run preview is offered.
          "Pick a different client, or preview another OS's config with --os <os> --dry-run.";
    err(`yaw-mcp install: ${target.label} is not available on ${os}.\n  ${fix}`);
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  // Pick a default scope sensibly: prefer user-global where supported,
  // else fall back to the first scope the client supports (vscode → project).
  const scope: InstallScope =
    opts.scope ?? (target.scopes.find((s) => s.scope === "user") ? "user" : target.scopes[0].scope);
  const scopeSpec = target.scopes.find((s) => s.scope === scope);
  if (!scopeSpec) {
    err(
      `yaw-mcp install: ${target.label} does not support scope "${scope}". Available: ${target.scopes.map((s) => s.scope).join(", ")}`,
    );
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  // `--project-dir` is read ONLY by a scope that resolves a path out of it
  // (claude-code project/local, vscode project). Accepting it for a user-scope
  // install and dropping it is the same class the parser refuses for `--all
  // --scope` and `--list --force`: a flag that is accepted and dropped reads as
  // honored, and here it reads as "I told install where my project is" while
  // the entry lands in the machine-global file instead. Refused here rather
  // than in the parser because the scope is only known once the client's
  // default has been resolved; `--all` hands the flag only to the plans whose
  // scope reads it, so a mixed `--all --project-dir` run still reaches vscode.
  if (opts.projectDir !== undefined && !scopeSpec.requiresProjectDir) {
    const projectScopes = target.scopes.filter((s) => s.requiresProjectDir).map((s) => s.scope);
    const fix =
      projectScopes.length > 0
        ? `Drop it, or install at a scope that reads it: --scope ${projectScopes.join(" | ")}.`
        : `Drop it -- ${target.label} has no project-directory scope.`;
    err(
      `yaw-mcp install: ${target.label} (${scope}) resolves no project directory, so it cannot honor --project-dir.\n  ${fix}`,
    );
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  // `opts.cwd` is the documented cwd override and runInstallList honors it, so
  // the write path must too: without it a caller that redirects cwd (a test,
  // an embedder) still resolves project scope against the REAL process.cwd()
  // and writes .vscode/mcp.json into whatever directory the runner happens to
  // be in. It also kept `--list` and `install --scope project` reporting two
  // different directories.
  // `opts.cwd` is the BASE, not just the fallback: a RELATIVE --project-dir
  // used to be resolved against the real process.cwd() even when the caller
  // had overridden cwd, making this the one place project resolution ignored
  // the override.
  const projectDir = scopeSpec.requiresProjectDir
    ? resolve(opts.cwd ?? process.cwd(), opts.projectDir ?? ".")
    : undefined;
  let resolved: ReturnType<typeof resolveInstallPath>;
  try {
    resolved = resolveInstallPath({
      clientId: opts.clientId,
      scope,
      os,
      home: opts.home,
      appData: resolveAppData(opts),
      projectDir,
      claudeConfigDir: opts.claudeConfigDir,
    });
  } catch (e) {
    // Defensive; unreachable via runInstall's own checks. Everything the
    // resolver throws on -- unknown client, unsupported scope, unavailable OS,
    // a project scope with no directory -- was refused above, and projectDir
    // is set whenever requiresProjectDir holds. Kept so a new resolver throw
    // surfaces as a named refusal rather than an unhandled rejection.
    err(`yaw-mcp install: ${(e as Error).message}`);
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  log(`Target: ${target.label} (${scope})`);
  log(`File:   ${resolved.absolute}`);

  // Read + merge existing client config.
  const containerPath = resolved.containerPath;
  let existing: Record<string, unknown> = {};
  // RAW bytes of a pre-existing, non-empty, object-shaped client config. Kept
  // so the write below can go through the comment-preserving `editJsoncEntry`
  // instead of JSON.parse + JSON.stringify, which silently deletes every `//`
  // and `/* */` in the user's file. `.vscode/mcp.json` is documented JSONC and
  // its `inputs` array is routinely commented; ~/.claude.json carries user
  // comments too. `yaw-mcp try` already writes these same files this way --
  // install was the one path that still flattened them.
  let rawClient: string | null = null;
  let existingHasEntry = false;
  let legacyEntry: string | null = null;
  // Fingerprinted BEFORE the read (never after: a write landing between a
  // read and a later stat would be carried forward under a fresh fingerprint)
  // and compared again right before atomicWriteFile -- see there for why. A
  // null fingerprint is "absent", which also stands in for the existsSync
  // this replaced: an unreadable file still reaches the readFile below and
  // fails there with its real error.
  const fingerprintBefore = await fileFingerprint(resolved.absolute);
  if (fingerprintBefore !== null) {
    let raw: string;
    try {
      raw = await readFile(resolved.absolute, "utf8");
    } catch (e) {
      err(`yaw-mcp install: cannot read ${resolved.absolute}: ${(e as Error).message}`);
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
    if (raw.trim().length > 0) {
      try {
        const parsed = parseJsonc(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          err(
            `yaw-mcp install: ${resolved.absolute} is not a JSON object -- refusing to overwrite. Edit by hand or rename the file and re-run.`,
          );
          return { written: [], wouldWrite: [], messages, exitCode: 1 };
        }
        existing = parsed as Record<string, unknown>;
        rawClient = raw;
      } catch (e) {
        err(
          `yaw-mcp install: ${resolved.absolute} is not valid JSON (${(e as Error).message}). Refusing to overwrite. Fix the file or rename it and re-run.`,
        );
        return { written: [], wouldWrite: [], messages, exitCode: 1 };
      }
    }
    const container = readNested(existing, containerPath);
    if (typeof container === "object" && container !== null && !Array.isArray(container)) {
      const c = container as Record<string, unknown>;
      existingHasEntry = ENTRY_NAME in c;
      legacyEntry = findLegacyEntry(c);
    }
  }

  if (existingHasEntry) {
    let decision: "overwrite" | "skip" | "abort" | "cancelled";
    // --skip WINS over --dry-run: the preview must describe the run it
    // previews, and the real `--skip` run leaves the entry untouched --
    // dryRun-first made `--skip --dry-run` preview an OVERWRITE.
    if (opts.skip) decision = "skip";
    else if (opts.force || opts.dryRun) decision = "overwrite";
    else if (opts.promptAnswer) decision = opts.promptAnswer;
    else if (opts.io?.isTTY ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY))) {
      decision = await promptCollision(resolved.absolute, opts.io);
    } else {
      err(
        `yaw-mcp install: ${resolved.absolute} already has a "${ENTRY_NAME}" entry and stdin is not a TTY.\n  Re-run with --force to overwrite, --skip to leave it, or --dry-run to preview.`,
      );
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
    if (decision === "skip") {
      log(
        opts.dryRun
          ? `Would leave existing "${ENTRY_NAME}" entry untouched (--skip). Nothing to do.`
          : `Existing "${ENTRY_NAME}" entry left untouched. Nothing to do.`,
      );
      return { written: [], wouldWrite: [], messages, exitCode: 0 };
    }
    if (decision === "abort") {
      err("Aborted.");
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
    if (decision === "cancelled") {
      // Ctrl+C at the prompt. Exit 130, the convention every other prompt in
      // the product (the vault passphrase, trust's [y/N]) already follows.
      err("Cancelled.");
      return { written: [], wouldWrite: [], messages, exitCode: 130 };
    }
    // Conditional tense under --dry-run: the decision above maps dryRun onto
    // "overwrite" so this collision path is exercised, but the run returns
    // before any write. Present tense here told a user scanning the transcript
    // that their preview had already mutated the file.
    log(
      opts.dryRun ? `Would overwrite existing "${ENTRY_NAME}" entry.` : `Overwriting existing "${ENTRY_NAME}" entry.`,
    );
  }

  // Probed AFTER every refusal above -- the file read AND the collision
  // decision -- never before them: every line below claims a runtime for an
  // entry this run is about to write, and each of those paths returns without
  // writing anything. Ordered the other way, a malformed ~/.claude.json printed
  // `Runtime: will run on oam ...` and then `not valid JSON ... Refusing`, and a
  // non-TTY re-run over an existing entry printed the same claim above `already
  // has a "mcp" entry and stdin is not a TTY` -- a runtime claim for a write
  // that never happened, in that order, in the transcript the user pastes into
  // a bug report. `--skip` is the same class at exit 0: it leaves the entry it
  // found in place, so a Runtime line there describes the entry that would
  // have been written rather than the one still on disk.
  //
  // Host the broker itself on oam when this machine can do it durably: a
  // version-gated oam, resolvable to an ABSOLUTE path, AND a non-npx-cache
  // install to point at. Any one missing keeps the npx entry unchanged -- the
  // normal case, not an error.
  const oamProbeResult = await (opts.oamProbe ?? probeOam)();
  const resolveEntry = opts.resolveOamEntry ?? resolveStableNpmEntry;
  // `binPath`, not `bin`. `bin` is what THIS process spawns, and without
  // OAM_BIN it is a bare "oam" that only resolves because a shell PATH made it
  // work here; the entry below is read by a GUI-launched client that inherits
  // no such PATH. `binPath` is the same binary as an absolute path, or null
  // when it could not be located -- "oam works here but there is no portable
  // path to write", which stays on npx exactly like oam-absent does.
  const oamBinPath = oamProbeResult.binPath;
  const oamEntry = oamBinPath ? resolveEntry("@yawlabs/mcp") : null;
  const newEntry = buildLaunchEntry({ os, oamBinPath, oamEntry });
  // Every fallback gets a reason. The npx entry is the right outcome in all of
  // them, but "I installed oam and it still runs on node" is unexplainable from
  // the outside, and a silent below-min / broken / unresolvable oam is
  // indistinguishable from a machine that has none.
  //
  // "will run on", not "runs on": nothing has been written yet, and the write
  // can still fail below. Reporting a runtime the user does not have would be
  // worse than saying nothing.
  const oamVersion = oamProbeResult.version ? ` ${oamProbeResult.version}` : "";
  // Read off the entry that was actually BUILT, never re-derived from the same
  // inputs: buildLaunchEntry applies one more gate than the pair below
  // (isAbsolute(oamBinPath) -- a bare/relative name a GUI-launched client could
  // not resolve), so re-testing `oamBinPath && oamEntry` here printed "will run
  // on oam" over an npx entry, with no line saying why.
  // Tested inline rather than hoisted into a boolean: a `const` collapses to
  // `boolean` and narrows nothing, so the oamEntry read below would still be
  // `string | null`. buildLaunchEntry only ever emits the oam command when BOTH
  // halves were present, so this conjunction is the same condition, typed.
  if (oamBinPath && oamEntry && newEntry.command === oamBinPath) {
    log(`Runtime: will run on oam${oamVersion}`);
    // The resolved entry is durable but not necessarily GLOBAL: a project
    // node_modules qualifies, and this config is machine-global, so an
    // `rm -rf node_modules` weeks from now kills the broker in every project
    // with nothing pointing back at the cause.
    if (isProjectLocalEntry(oamEntry, opts.cwd ?? process.cwd())) {
      log(
        `Note: that path is a project-local install (${oamEntry}). Removing this checkout's node_modules ` +
          `(\`rm -rf node_modules\`, \`npm prune\`, a rename) breaks the entry in ${resolved.absolute}. ` +
          "`npm i -g @yawlabs/mcp` and re-run install for a machine-durable path.",
      );
    }
  } else if (oamBinPath && oamEntry) {
    // Both halves resolved and buildLaunchEntry still declined, which leaves
    // exactly one cause: the path is not absolute. PATH can legitimately carry a
    // relative dir (`.`, `node_modules/.bin`), and resolveBinAbsolute joins the
    // bin onto whatever it finds there, so the "absolute" probe result is only
    // as absolute as the PATH entry it came from.
    log(
      `Runtime: node (oam${oamVersion} resolved only to the relative path \`${oamBinPath}\` -- a client config must ` +
        "carry an absolute one, since a GUI-launched client resolves a relative path against its own working " +
        "directory, not yours. Set OAM_BIN to oam's full path and re-run install to host yaw-mcp on it.)",
    );
  } else if (oamBinPath) {
    // oam is present and usable, but yaw-mcp itself resolves only to the npx
    // cache -- a path a config file must not persist.
    log("Runtime: node (oam found, but yaw-mcp is not durably installed -- `npm i -g @yawlabs/mcp` to host it on oam)");
  } else if (oamProbeResult.bin) {
    // Usable here, not persistable: `oam` runs in this shell but was not found
    // on PATH as a file, so the only value available to write is a bare name
    // the client would resolve against its own PATH.
    log(
      `Runtime: node (oam${oamVersion} runs here, but its absolute path could not be resolved -- a client config ` +
        `must not carry a bare \`${oamProbeResult.bin}\`, which a GUI-launched client cannot find. Set OAM_BIN to ` +
        "oam's full path and re-run install to host yaw-mcp on it.)",
    );
  } else if (oamProbeResult.belowMin) {
    log(
      `Runtime: node (oam${oamVersion} is below the ${MIN_OAM_VERSION} minimum -- upgrade oam and re-run install ` +
        "to host yaw-mcp on it)",
    );
  } else if (oamProbeResult.failure) {
    // oamFailureLabel, not a phrase table of our own: the probe distinguishes
    // broken from absent precisely so the user is not sent looking for an
    // install they already have, and doctor's OAM RUNTIME section plus
    // default-runtime's per-server reason report the same failure. Two wordings
    // is how one report says "unusable" and the next says "not installed".
    log(
      `Runtime: node (oam is installed but unusable: ${oamFailureLabel(oamProbeResult.failure)}` +
        `${oamProbeResult.failureDetail ? ` -- ${oamProbeResult.failureDetail}` : ""}. Fix or reinstall oam and ` +
        "re-run install to host yaw-mcp on it.)",
    );
  } else if (!opts.suppressOamAbsentNote) {
    // Plain absence -- binPath and bin both null, not below-min, no failure --
    // and the ONE branch of this chain that said nothing at all. "Every fallback
    // gets a reason" above was true of the misconfigurations and false of the
    // common case, so a user on a fresh machine got an npx entry with no line
    // saying an alternative existed.
    //
    // Suppressed under --all, which prints it once for the run: unlike the
    // branches above -- rare misconfigurations worth restating per client --
    // absence is a MACHINE-level fact and the common case, so repeating it
    // across every client is the same noise the collision refusal consolidates.
    log(oamAbsentNote(os, opts.oamPublishesBinary));
  }

  // Carry over an existing entry's `env`. The merge replaces our entry
  // wholesale, and the default entry sets no env at all -- so re-running
  // install silently dropped anything the user had put there. OAM_BIN is the
  // live example: it pins which oam hosts the sidecars, and losing it moves
  // them to a different runtime with no diagnostic. Only fills a gap; an
  // entry that brings its own env (the upstream/try shape) is untouched.
  const previousEntry = readEntryAt(existing, containerPath, ENTRY_NAME);
  const previousEnv = previousEntry?.env;
  const entryToWrite =
    newEntry.env === undefined && previousEnv && Object.keys(previousEnv).length > 0
      ? { ...newEntry, env: previousEnv }
      : newEntry;
  if (entryToWrite !== newEntry) {
    log(`Kept existing env on the ${ENTRY_NAME} entry: ${Object.keys(previousEnv ?? {}).join(", ")}`);
  }

  // Two write paths, mirroring try-cmd:
  //   - file pre-exists with object content -> splice the entry into the
  //     ORIGINAL bytes via jsonc-parser, so comments, key order and the
  //     user's indentation all survive;
  //   - file missing or empty -> nothing to preserve, so build the object and
  //     render it (this path also materializes a missing container chain).
  let clientJson: string;
  if (rawClient !== null) {
    // The splice cannot create a container over a key that already holds a
    // non-object -- jsonc-parser throws, and its message names neither the file
    // nor the key. Settle that here so the entry write below is left with only
    // genuine surprises to report.
    let spliceSource = rawClient;
    const blocked = findBlockedContainerSegment(existing, containerPath);
    if (blocked) {
      const keyPath = blocked.path.join(".");
      if (!blocked.reparable) {
        err(
          `yaw-mcp install: "${keyPath}" in ${resolved.absolute} is ${describeJsonShape(blocked.value)}, not a JSON object -- refusing to overwrite. Make it an object (or remove the key) and re-run.`,
        );
        return { written: [], wouldWrite: [], messages, exitCode: 1 };
      }
      // Reparable: replace the key with an empty object in the SAME
      // comment-preserving pass, so the rest of the file keeps its bytes. Every
      // deeper segment is necessarily absent afterwards, which the splice below
      // materializes -- so one repair is always enough.
      try {
        spliceSource = editJsoncEntry(
          spliceSource,
          blocked.path.slice(0, -1),
          blocked.path[blocked.path.length - 1],
          {},
        );
      } catch (e) {
        err(
          `yaw-mcp install: failed to replace the non-object "${keyPath}" key in ${resolved.absolute} (${(e as Error).message}). Refusing to overwrite.`,
        );
        return { written: [], wouldWrite: [], messages, exitCode: 1 };
      }
      // Conditional tense under --dry-run, matching the collision message: this
      // runs before the preview, and nothing has touched the file yet.
      log(
        `Note: "${keyPath}" in ${resolved.absolute} is ${describeJsonShape(blocked.value)}, not an object -- ` +
          `${opts.dryRun ? "would replace" : "replaced"} it with an empty object so the "${ENTRY_NAME}" entry has somewhere to live.`,
      );
    }
    try {
      const next = editJsoncEntry(spliceSource, containerPath, ENTRY_NAME, entryToWrite);
      // editJsoncEntry returns the user's bytes verbatim outside the edited
      // span, so a file that already ends in a newline keeps exactly the one it
      // had (never doubled). A file that does NOT is terminated here rather
      // than left unterminated -- POSIX tools and diffs both want the newline,
      // and install is rewriting the file anyway.
      clientJson = next.endsWith("\n") ? next : `${next}\n`;
    } catch (e) {
      err(
        `yaw-mcp install: failed to splice the "${ENTRY_NAME}" entry into ${resolved.absolute} (${(e as Error).message}). Refusing to overwrite.`,
      );
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
  } else {
    const merged = mergeClientConfig(existing, containerPath, entryToWrite);
    clientJson = `${JSON.stringify(merged, null, 2)}\n`;
  }

  const home = opts.home ?? homedir();

  // Claude Code: also ensure `permissions.allow` carries our pattern so
  // the user isn't re-prompted for every yaw-mcp tool call. No-op for other
  // clients (Claude Desktop / Cursor / VS Code have their own permission
  // models). Preserves all existing settings — we only union the pattern
  // into `permissions.allow` and write the file back verbatim otherwise.
  const settingsPatch =
    opts.clientId === "claude-code"
      ? await prepareClaudeCodeSettingsPatch({
          scope,
          home,
          projectDir,
          claudeConfigDir: opts.claudeConfigDir,
        })
      : null;

  // Surface a malformed/non-object settings.json rather than silently
  // skipping the permissions patch (the patch itself is best-effort, so
  // this never fails the install -- but the user needs to know the file
  // was left unpatched, distinct from the "already present" no-op which
  // stays silent).
  if (settingsPatch?.malformed) {
    err(
      `yaw-mcp install: warning -- could not patch ${settingsPatch.path} (${settingsPatch.malformedReason}); left unchanged. Add "${CLAUDE_CODE_ALLOW_PATTERN}" to permissions.allow by hand, or you may be re-prompted for each yaw-mcp tool call.`,
    );
  }

  if (opts.dryRun) {
    // ONLY what this run adds, never the merged file. `clientJson` is the
    // whole post-merge config, and for ~/.claude.json that is every sibling
    // server's `env` -- a third-party API key, a `yaw-mcp try` entry's inline
    // secret -- printed into the transcript the user pastes into a bug report,
    // the exact leak the Runtime-line ordering above takes care to avoid. The
    // entry rendered at its container path is the one-sided diff a fresh
    // entry amounts to, and it still shows WHERE the entry lands (the
    // projects[<dir>] nesting at local scope). Same for settings.json, which
    // carries `env` and hooks of its own: the permissions.allow delta is the
    // whole change, so it is all that prints.
    //
    // The entry's own `env` is the one part of that diff that is NOT ours: it
    // is the existing entry's, carried over verbatim above, and README tells
    // users to put YAW_MCP_VAULT_PASSPHRASE in exactly that block. So the
    // preview keeps its KEYS (the "Kept existing env" line already names
    // them, and the user needs to see the block survives the overwrite) and
    // masks every VALUE. A live run writes the real values to the file; the
    // preview is the one output that exists to be pasted somewhere. Gated on
    // the carry-over rather than on `env` being present so the placeholder
    // stays truthful: buildLaunchEntry emits no env of its own here, so an
    // env on the entry can only have come from the user's file.
    log("\n--- dry run: would add the following (the rest of each file is left as-is) ---");
    const previewEntry =
      entryToWrite !== newEntry && entryToWrite.env
        ? {
            ...entryToWrite,
            env: Object.fromEntries(Object.keys(entryToWrite.env).map((k) => [k, DRY_RUN_ENV_PLACEHOLDER])),
          }
        : entryToWrite;
    const preview = mergeClientConfig({}, containerPath, previewEntry);
    log(`\n# ${resolved.absolute}\n${JSON.stringify(preview, null, 2)}`);
    if (settingsPatch?.changed) {
      log(`# ${settingsPatch.path}\npermissions.allow += ${JSON.stringify(settingsPatch.added)}`);
    }
    if (legacyEntry) {
      log(
        `Note: legacy "${legacyEntry}" entry at ${resolved.absolute} would remain -- remove it to avoid running yaw-mcp twice.`,
      );
    }
    const wouldWrite: string[] = [resolved.absolute];
    if (settingsPatch?.changed) wouldWrite.push(settingsPatch.path);
    return { written: [], wouldWrite, messages, exitCode: 0 };
  }

  const written: string[] = [];

  // Re-fingerprint immediately before publishing. The read above and this
  // write bracket an awaited `oam --version` probe (up to 3s) and, on a
  // collision, a prompt that waits on the user -- and ~/.claude.json is a file
  // Claude Code itself writes during a session (MCP approvals, project
  // metadata). atomicWriteFile only guarantees the bytes land whole; it leaves
  // serializing the logical read-modify-write to the caller (atomic-write.ts,
  // header), so a save that landed in that window used to be replaced by the
  // pre-probe snapshot plus our entry with no diagnostic. `yaw-mcp install
  // claude-code --force` run from a shell inside a live Claude Code session
  // is exactly that shape. Refuse rather than merge: the file just changed
  // under us, and re-reading it from the top is what a re-run does. Best
  // effort by nature -- a same-size rewrite inside one mtime tick (coarse on
  // some filesystems) is invisible to this check.
  if (!sameFingerprint(fingerprintBefore, await fileFingerprint(resolved.absolute))) {
    err(
      `yaw-mcp install: ${resolved.absolute} changed while install was running (another process wrote it) -- nothing was written. Re-run install.`,
    );
    return { written, wouldWrite: [], messages, exitCode: 1 };
  }

  // Write client config atomically. ~/.claude.json carries every
  // project's mcpServers + permissions + history; a non-atomic write
  // killed mid-flight could blow away the lot.
  try {
    await atomicWriteFile(resolved.absolute, clientJson);
  } catch (e) {
    err(`yaw-mcp install: failed to write ${resolved.absolute}: ${(e as Error).message}`);
    return { written, wouldWrite: [], messages, exitCode: 1 };
  }
  log(`Wrote ${resolved.absolute}`);
  written.push(resolved.absolute);

  // Claude Code: merge permissions.allow into settings.json so tool
  // calls don't prompt. Best-effort: any failure here is logged but does
  // NOT fail the overall install — the launch entry is already written.
  if (settingsPatch?.changed) {
    // The same read-modify-write race the client config is guarded against
    // above, on the file Claude Code rewrites MOST during a session: every
    // permission approval lands in settings.json. The window is narrower --
    // prepareClaudeCodeSettingsPatch reads after the probe and the prompt --
    // but the client-config publish just above is an awaited write+rename
    // inside it, and a patch computed on the pre-publish bytes would replace
    // an approval that landed meanwhile. Skip rather than refuse: the launch
    // entry is already in place, the patch is best-effort, and the by-hand
    // fallback is the one every other unpatched path names. Same coarse-mtime
    // caveat as the client check.
    if (!sameFingerprint(settingsPatch.fingerprint, await fileFingerprint(settingsPatch.path))) {
      err(
        `yaw-mcp install: warning -- ${settingsPatch.path} changed while install was running (another process wrote it); left unchanged. Add "${CLAUDE_CODE_ALLOW_PATTERN}" to permissions.allow by hand, or you may be re-prompted for each yaw-mcp tool call.`,
      );
    } else {
      try {
        await atomicWriteFile(settingsPatch.path, settingsPatch.nextJson);
        log(`Wrote ${settingsPatch.path} (added ${CLAUDE_CODE_ALLOW_PATTERN} to permissions.allow)`);
        written.push(settingsPatch.path);
      } catch (e) {
        err(
          `yaw-mcp install: warning -- failed to patch ${settingsPatch.path}: ${(e as Error).message}. You may be re-prompted for each yaw-mcp tool call; add "${CLAUDE_CODE_ALLOW_PATTERN}" to permissions.allow to silence.`,
        );
      }
    }
  }

  if (target.notes) log(`Note: ${target.notes}`);
  if (legacyEntry) {
    log(
      `Note: legacy "${legacyEntry}" entry remains at ${resolved.absolute}. Remove it to avoid running yaw-mcp twice.`,
    );
  }
  // Claude Code gates project-scope (.mcp.json) servers behind a one-time
  // per-project approval prompt (tracked as enabledMcpjsonServers /
  // disabledMcpjsonServers under projects[<dir>] in ~/.claude.json), so
  // "restart it" alone strands the user: the freshly-written entry stays
  // inert until the prompt is answered, and nothing else names that gate.
  log(
    target.clientId === "claude-code" && scope === "project"
      ? `\nDone: ${target.label} is configured. Restart it in this project and approve the .mcp.json server when ` +
          "prompted -- Claude Code keeps project-scope (.mcp.json) servers disabled until you approve them."
      : `\nDone: ${target.label} is configured. Restart it to pick up the new MCP server.`,
  );
  return { written, wouldWrite: [], messages, exitCode: 0 };
}

/** Read `settings.json` (or settings.local.json) for the given scope,
 *  compute the next version with the yaw-mcp allow-pattern unioned into
 *  `permissions.allow`, and return both the path and the rendered JSON.
 *  Returns `changed: false` when the pattern is already present — caller
 *  can skip the write entirely. Returns null for scopes that have no
 *  corresponding settings file. Malformed or non-object existing files are
 *  left untouched (changed: false, malformed: true, malformedReason set);
 *  the caller emits a warning so the skip isn't silent. Every non-null result
 *  carries the file's `fingerprint` from BEFORE the read, for the caller to
 *  compare again ahead of its write (see the settings patch in runInstall). */
async function prepareClaudeCodeSettingsPatch(opts: {
  scope: InstallScope;
  home: string;
  projectDir: string | undefined;
  claudeConfigDir: string | undefined;
}): Promise<{
  path: string;
  nextJson: string;
  changed: boolean;
  /** The patterns this patch appends to `permissions.allow` -- the whole
   *  delta, since the merge only ever adds. What `--dry-run` prints instead of
   *  `nextJson`, which is the entire settings.json (hooks, `env`, ...). Empty
   *  when nothing changed. */
  added: string[];
  /** stat of the file taken ahead of the read; null when it was absent. */
  fingerprint: FileFingerprint;
  malformed?: boolean;
  malformedReason?: string;
} | null> {
  const path = resolveClaudeCodeSettingsPath(opts.scope, {
    home: opts.home,
    projectDir: opts.projectDir,
    claudeConfigDir: opts.claudeConfigDir,
  });
  if (!path) return null;

  let existing: Record<string, unknown> = {};
  // Raw bytes of the pre-existing settings.json, for the same reason install
  // keeps the client config's: settings.json is JSONC and hand-maintained,
  // and a JSON.stringify rewrite drops every comment in it.
  let rawSettings: string | null = null;
  // Fingerprinted BEFORE the read, for the same reason the client config is
  // (runInstall, ahead of its readFile): taken after, a write landing between
  // the read and the stat would be carried forward under a fresh fingerprint.
  // null is "absent", which is the existence test this used to be an
  // existsSync for; an unreadable file still reaches the readFile below and
  // is reported from there.
  const fingerprint = await fileFingerprint(path);
  if (fingerprint !== null) {
    try {
      const raw = await readFile(path, "utf8");
      if (raw.trim().length > 0) {
        const parsed = parseJsonc(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          existing = parsed as Record<string, unknown>;
          rawSettings = raw;
        } else {
          // Not an object — leave alone, but flag it so the caller can warn
          // (otherwise the settings.json is silently never patched).
          return {
            path,
            nextJson: "",
            changed: false,
            added: [],
            malformed: true,
            malformedReason: "not a JSON object",
            fingerprint,
          };
        }
      }
    } catch (e) {
      // Malformed settings.json — don't try to rewrite; flag it so the
      // caller can warn (let the user fix it by hand).
      return {
        path,
        nextJson: "",
        changed: false,
        added: [],
        malformed: true,
        malformedReason: (e as Error).message,
        fingerprint,
      };
    }
  }

  const merged = mergePermissionsAllow(existing, [CLAUDE_CODE_ALLOW_PATTERN]);
  // If nothing changed, signal no-op to the caller.
  const before = JSON.stringify(existing);
  const after = JSON.stringify(merged);
  if (before === after) return { path, nextJson: "", changed: false, added: [], fingerprint };
  // The delta is "our patterns that were not already there": mergePermissionsAllow
  // preserves every existing element and appends only the missing ones.
  const prevAllow = (existing.permissions as { allow?: unknown } | undefined)?.allow;
  const prevAllowList: unknown[] = Array.isArray(prevAllow) ? prevAllow : [];
  const added = [CLAUDE_CODE_ALLOW_PATTERN].filter((p) => !prevAllowList.includes(p));
  if (rawSettings !== null) {
    // Pre-empt the one shape that makes the splice below throw: a `permissions`
    // key holding a non-object (null, a scalar, an array) has no `allow` node
    // to hang the pattern off, and jsonc-parser's message for it ("Can not add
    // index to parent of type array") names neither the file nor the key --
    // exactly the internal text the client-config path takes care never to
    // print. Named here instead, in the same shape vocabulary that path uses.
    //
    // Reported, NOT repaired -- deliberately asymmetric with the client config.
    // There, replacing an empty container is the difference between installing
    // and not; here the patch is best-effort (the launch entry is already
    // written), settings.json is hand-maintained, and rewriting a key the user
    // put there is a bigger liberty than naming it and letting them fix it.
    const blockedPermissions = findBlockedContainerSegment(existing, ["permissions"]);
    if (blockedPermissions) {
      return {
        path,
        nextJson: "",
        changed: false,
        added: [],
        malformed: true,
        malformedReason: `"permissions" is ${describeJsonShape(blockedPermissions.value)}, not a JSON object`,
        fingerprint,
      };
    }
    // Only `permissions.allow` changes, so edit exactly that node in the
    // original bytes. Everything else -- hooks, model, comments, formatting --
    // is left untouched rather than re-serialized.
    const nextAllow = (merged.permissions as { allow: string[] }).allow;
    try {
      const next = editJsoncEntry(rawSettings, ["permissions"], "allow", nextAllow);
      return { path, nextJson: next.endsWith("\n") ? next : `${next}\n`, changed: true, added, fingerprint };
    } catch (e) {
      // Backstop for whatever the shape check above cannot foresee. Named the
      // same way, so even here the user gets the key alongside the parser's
      // text rather than the text alone.
      return {
        path,
        nextJson: "",
        changed: false,
        added: [],
        malformed: true,
        malformedReason: `could not splice permissions.allow (${(e as Error).message})`,
        fingerprint,
      };
    }
  }
  return { path, nextJson: `${JSON.stringify(merged, null, 2)}\n`, changed: true, added, fingerprint };
}

/** Union `patterns` into `existing.permissions.allow`, preserving every
 *  other key and every element already there. Deduplicates by string equality
 *  so repeated installs don't grow the list.
 *
 *  Deliberately NOT a place that strips the pre-rename legacy wildcards
 *  (`mcp__yaw_mcp__*`, `mcp__mcph__*`, `mcp__mcp_hosting__*`). An earlier
 *  version dropped them unless the legacy mcpServers entry was still present
 *  in the ONE container install was writing -- but ~/.claude/settings.json is
 *  global, so a user-scope install could not see the legacy `yaw-mcp` entry a
 *  repo's .mcp.json (or another project's local scope) still runs, stripped
 *  its grant, and Claude Code re-prompted on every tool call of that live
 *  server. No cheap read sees every container a global allow-list covers.
 *  Three dead wildcards are harmless; a revoked live grant is not. The legacy
 *  ENTRY still gets its "remove it" note in runInstall -- the pattern goes
 *  when the user deletes the entry it serves, by hand.
 *  Exported for tests. */
export function mergePermissionsAllow(existing: Record<string, unknown>, patterns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  const prev = out.permissions;
  const perms: Record<string, unknown> =
    typeof prev === "object" && prev !== null && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  const prevAllow = perms.allow;
  // Every existing element is carried through VERBATIM, non-strings included.
  // The dedupe below is a string-only concept, so a pass that narrowed to
  // string silently DELETED anything else the user (or a future Claude Code
  // schema) had put in `permissions.allow` -- an object rule, a nested array --
  // on the next install, contradicting this function's own promise to preserve
  // everything it does not manage.
  const allow: unknown[] = Array.isArray(prevAllow) ? [...(prevAllow as unknown[])] : [];
  for (const p of patterns) {
    if (!allow.includes(p)) allow.push(p);
  }
  perms.allow = allow;
  out.permissions = perms;
  return out;
}

/** The fields a concurrent writer moves; null when the file is absent. Used
 *  to detect a write that lands between install's read of a file and its
 *  publishing rename: the client config (refused, see the check ahead of its
 *  atomicWriteFile) and Claude Code's settings.json (the best-effort patch is
 *  skipped with a warning, see the settings write below it). */
type FileFingerprint = { mtimeMs: number; size: number } | null;

async function fileFingerprint(path: string): Promise<FileFingerprint> {
  try {
    const st = await stat(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

async function promptCollision(
  path: string,
  io: InstallCommandOptions["io"],
): Promise<"overwrite" | "skip" | "abort" | "cancelled"> {
  const stdin = io?.stdin ?? process.stdin;
  const stdout = io?.stdout ?? process.stdout;
  const rl = createInterface({ input: stdin, output: stdout, terminal: io?.terminal });
  try {
    // questionOrEmpty, not a bare rl.question(): that promise never settles
    // once stdin closes (Ctrl+D, a pipe running dry), so the install hung at
    // this prompt instead of taking its default. EOF comes back as "", which
    // is what a bare Enter produces -- the `(default: skip)` branch below.
    // Ctrl+C is a distinct answer: readline closes the interface on it with
    // no process signal, and treating that as "" answered the prompt with
    // "skip" and printed a success line at exit 0 on a cancel.
    const raw = await questionOrEmpty(
      rl,
      `${path} already has an "${ENTRY_NAME}" entry.\n  [o]verwrite, [s]kip, or [a]bort? (default: skip) `,
    );
    if (raw === QUESTION_CANCELLED) return "cancelled";
    const answer = raw.trim().toLowerCase();
    if (answer.startsWith("o")) return "overwrite";
    if (answer.startsWith("a")) return "abort";
    return "skip";
  } finally {
    rl.close();
  }
}

/** Walk `containerPath` to find the existing mcpServers/servers container.
 *  Returns the value at the path, or undefined if any segment is missing
 *  or non-object. Does not mutate. */
export function readNested(root: Record<string, unknown>, containerPath: string[]): unknown {
  let cur: unknown = root;
  for (const key of containerPath) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** A key along the container path whose existing value is not an object, and so
 *  cannot have the launch entry spliced into it. */
export interface BlockedContainerSegment {
  /** Full key path to the offending key, for naming it in a message. */
  path: string[];
  /** What is there instead of an object. */
  value: unknown;
  /** Whether replacing it with `{}` throws nothing away -- see
   *  `findBlockedContainerSegment`. */
  reparable: boolean;
}

/**
 * First key along `containerPath` that holds a non-object, or null when the
 * chain is spliceable as-is.
 *
 * jsonc-parser's `modify` materializes MISSING intermediate keys but throws
 * "Can not add index to parent of type null" on one that exists and holds a
 * non-object -- an internal message naming neither the file nor the key. The
 * pre-existing top-level check catches only a non-object ROOT, so `"mcpServers":
 * null` (hand-edited, or written by a tool that emptied it) reached the splice
 * and failed the whole install. Walking the chain here is what lets the caller
 * either repair the key or refuse while naming it.
 *
 * `reparable` splits the two shapes deliberately. null, a scalar, and an empty
 * array hold no server definitions, so replacing them with `{}` loses nothing
 * and restores the behaviour of the pre-splice merge path (which overwrote any
 * non-object container). A NON-EMPTY array can hold real entries in the wrong
 * shape, and silently dropping those to write ours is not a repair -- that case
 * is the caller's refusal.
 */
export function findBlockedContainerSegment(
  root: Record<string, unknown>,
  containerPath: string[],
): BlockedContainerSegment | null {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < containerPath.length; i++) {
    const value = node[containerPath[i]];
    // Absent from here down: jsonc-parser builds the rest of the chain itself.
    if (value === undefined) return null;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      node = value as Record<string, unknown>;
      continue;
    }
    return {
      path: containerPath.slice(0, i + 1),
      value,
      reparable: value === null || !Array.isArray(value) || value.length === 0,
    };
  }
  return null;
}

/** How to name a non-object container value in a message. Shape, not contents:
 *  a `~/.claude.json` value can be arbitrarily large and the user needs to know
 *  WHICH key is wrong, not to have it echoed back. */
function describeJsonShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? "an empty array" : `an array of ${value.length}`;
  return `a ${typeof value}`;
}

/** Read the existing launch entry at `containerPath`, or null when the path or
 *  the entry is absent. Walks with readNested, the same walk mergeClientConfig
 *  and the collision check use, so all three agree on where the entry lives. */
export function readEntryAt(
  existing: Record<string, unknown>,
  containerPath: string[],
  entryName: string = ENTRY_NAME,
): { command?: string; args?: string[]; env?: Record<string, string> } | null {
  const node = readNested(existing, containerPath);
  if (typeof node !== "object" || node === null || Array.isArray(node)) return null;
  const entry = (node as Record<string, unknown>)[entryName];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  // Validate `env` before anyone carries it forward: the user chose
  // overwrite (or --force) precisely to replace a broken entry, and a
  // malformed env (a string -- whose Object.keys are "0","1","2" -- or an
  // array) would otherwise ride into the fresh entry and get the whole
  // file rejected by the client. Filter PER KEY, not all-or-nothing: one
  // hand-added numeric value ("DEBUG": 1) must not silently drop the
  // valid string keys beside it -- OAM_BIN is the load-bearing example
  // (losing it moves the sidecars to a different runtime with no
  // diagnostic, the exact failure the carry-over exists to prevent).
  const result = { ...entry } as { command?: string; args?: string[]; env?: Record<string, string> };
  const env = (entry as Record<string, unknown>).env;
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    const kept = Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) as Record<
      string,
      string
    >;
    result.env = Object.keys(kept).length > 0 ? kept : undefined;
  } else {
    result.env = undefined;
  }
  return result;
}

/** Merge `entry` into the container at `existing[...containerPath][entryName]`,
 *  preserving every sibling at every level of the path. Returns a new object;
 *  does not mutate. For Claude Code local scope, containerPath is
 *  ["projects", <absDir>, "mcpServers"] and this preserves every other
 *  project's settings + every other top-level key in ~/.claude.json.
 *  `entryName` defaults to ENTRY_NAME (the canonical yaw-mcp entry);
 *  `yaw-mcp try` overrides it with `yaw-mcp-try-<slug>` so the trial entry sits
 *  next to a real yaw-mcp install without colliding. */
export function mergeClientConfig(
  existing: Record<string, unknown>,
  containerPath: string[],
  entry: Record<string, unknown> | { command: string; args: string[]; env?: Record<string, string> },
  entryName: string = ENTRY_NAME,
): Record<string, unknown> {
  if (containerPath.length === 0) throw new Error("mergeClientConfig: containerPath cannot be empty");
  const out: Record<string, unknown> = { ...existing };
  let parent: Record<string, unknown> = out;
  for (let i = 0; i < containerPath.length - 1; i++) {
    const key = containerPath[i];
    const child = parent[key];
    const cloned: Record<string, unknown> =
      typeof child === "object" && child !== null && !Array.isArray(child)
        ? { ...(child as Record<string, unknown>) }
        : {};
    parent[key] = cloned;
    parent = cloned;
  }
  const leafKey = containerPath[containerPath.length - 1];
  const prev = parent[leafKey];
  const container: Record<string, unknown> =
    typeof prev === "object" && prev !== null && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  container[entryName] = entry;
  parent[leafKey] = container;
  return out;
}

// `removeFromClientConfig` used to live here: an object-level "delete this
// entry, preserve every sibling" mirror of mergeClientConfig, documented as the
// helper behind `try-cleanup` and doctor's trial-GC. It was neither -- both of
// those peel a trial entry out of the RAW bytes via `removeJsoncEntry`
// (jsonc.ts), which is the only way to keep the user's comments, so this export
// had zero callers and zero tests while its doc comment claimed two. Removed
// rather than left as a second, comment-destroying way to do the same job.

/** True when a value-flag's argument reads as the NEXT flag rather than as the
 *  value. `--token --force` was already refused, but the guard tested only for
 *  a DOUBLE dash -- so `install --token -h` swallowed `-h` as the token and
 *  printed a deprecation warning instead of the help the user asked for, and
 *  `--project-dir -h` resolved a directory literally named `-h`. Every flag
 *  this parser accepts is `-h` or `--<name>`, so a leading dash of either
 *  length is the mistake; a path or token that genuinely starts with one can
 *  still be spelled `./-weird`. */
function looksLikeFlag(value: string): boolean {
  return value.startsWith("-");
}

/** CLI argv parser used by index.ts dispatcher. Exported so tests can
 *  exercise flag parsing without spawning a subprocess.
 *
 *  The failure shape carries no `help` field: `--help` / `-h` is a SUCCESSFUL
 *  parse carrying `helpRequested` in the options, so nothing was left to set
 *  the old `ok: false, help: true` spelling -- and the install branch in
 *  index.ts reads `options.helpRequested`, never `.help`. */
export function parseInstallArgs(argv: string[]):
  | {
      ok: true;
      options: InstallCommandOptions;
    }
  | { ok: false; error: string } {
  if (argv.length === 0) return { ok: false, error: USAGE };
  const positional: string[] = [];
  const opts: Partial<InstallCommandOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--scope": {
        const v = next();
        if (!v || !["user", "project", "local"].includes(v))
          return { ok: false, error: "--scope requires user|project|local" };
        opts.scope = v as InstallScope;
        break;
      }
      case "--os": {
        const v = next();
        if (!v || !["macos", "linux", "windows"].includes(v))
          return { ok: false, error: "--os requires macos|linux|windows" };
        opts.os = v as InstallOS;
        break;
      }
      // DEPRECATED, still parsed. The flag is inert (runInstall warns and
      // ignores it), but it must keep CONSUMING its value or a scripted
      // `install --all --token mcp_pat_x` would treat the PAT as a stray
      // positional and fail the argv check below with exit 2.
      case "--token": {
        const v = next();
        // Reject a following flag swallowed as the value (`--token --force`
        // must not set token="--force"), mirroring the enum-flag guards.
        if (!v || looksLikeFlag(v)) return { ok: false, error: "--token requires a value" };
        opts.token = v;
        break;
      }
      case "--project-dir": {
        const v = next();
        if (!v || looksLikeFlag(v)) return { ok: false, error: "--project-dir requires a value" };
        opts.projectDir = v;
        break;
      }
      case "--force":
        opts.force = true;
        break;
      case "--skip":
        opts.skip = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      // DEPRECATED, still parsed (see --token above).
      case "--no-yaw-mcp-config":
        opts.skipYawMcpConfig = true;
        break;
      case "--list":
        opts.listOnly = true;
        break;
      case "--all":
        opts.all = true;
        break;
      case "-h":
      case "--help":
        return { ok: true, options: { helpRequested: true } as InstallCommandOptions };
      default:
        if (a.startsWith("--")) return { ok: false, error: `Unknown flag: ${a}\n${USAGE}` };
        positional.push(a);
    }
  }

  // `--os` is a preview knob, not a cross-OS writer: resolveInstallPath
  // builds `absolute` from THIS machine's home dir / APPDATA / separators
  // and only the `display` string is target-OS-shaped, so a real cross-OS
  // run would mkdir a junk host-shaped tree (e.g. `C:\Users\me\Library\
  // Application Support\Claude\...` for `--os macos` on Windows) and then
  // report Done. Refuse at the flag boundary; `--dry-run` and `--list`
  // stay available for previewing another OS. runInstall itself keeps
  // accepting any os/home combination — that pairing is the hermetic test
  // seam, and index.ts always routes users through this parser.
  if (opts.os && opts.os !== CURRENT_OS && !opts.dryRun && !opts.listOnly) {
    return {
      ok: false,
      error:
        `yaw-mcp install: --os ${opts.os} does not match this machine (${CURRENT_OS}), and install can only ` +
        `resolve config paths for the machine it runs on -- a cross-OS write would create a ${CURRENT_OS}-shaped ` +
        `junk tree. Add --dry-run to preview, or run install on the ${opts.os} machine itself.`,
    };
  }

  // --list and --all skip the positional-client requirement. They apply
  // across every configured client on the current OS. Passing both +
  // a positional client is ambiguous — refuse early.
  if (opts.listOnly || opts.all) {
    if (positional.length > 0) {
      return {
        ok: false,
        error: `yaw-mcp install: ${opts.listOnly ? "--list" : "--all"} does not take a client argument.\n${USAGE}`,
      };
    }
    // --list never writes, so a write-decision flag passed with it is an
    // intent that gets silently dropped -- the same class as --all --scope
    // below. --dry-run is deliberately still ACCEPTED: --list is already
    // read-only, and the cross-OS guard above documents `--os <other>
    // --dry-run` as the preview spelling, so refusing it would break a
    // combination this parser advertises.
    if (opts.listOnly && (opts.force || opts.skip)) {
      const flag = opts.force ? "--force" : "--skip";
      return {
        ok: false,
        error: `yaw-mcp install: --list never writes a file, so it cannot honor ${flag}. Drop ${flag}, or install the client you want.\n${USAGE}`,
      };
    }
    // Same class again: --list enumerates EVERY scope of every client (that is
    // the report), so a --scope narrows nothing and is dropped on the floor.
    // Refuse it rather than print a full table under a flag the user passed to
    // filter it.
    if (opts.listOnly && opts.scope) {
      return {
        ok: false,
        error: `yaw-mcp install: --list reports every scope, so it cannot honor --scope. Drop --scope, or install a client at that scope.\n${USAGE}`,
      };
    }
    // --all plans its own scope per client (user where available), so an
    // explicit --scope would be silently discarded for every client but
    // the project-only ones. Refuse instead of ignoring: a flag that is
    // accepted and dropped reads as honored.
    if (opts.all && opts.scope) {
      return {
        ok: false,
        error: `yaw-mcp install: --all chooses each client's scope itself and cannot honor --scope. Install the client you want at a specific scope individually.\n${USAGE}`,
      };
    }
    return { ok: true, options: opts as InstallCommandOptions };
  }

  if (positional.length !== 1)
    return { ok: false, error: `Expected exactly one client argument, got ${positional.length}.\n${USAGE}` };
  const clientId = positional[0] as InstallClientId;
  if (!INSTALL_TARGETS.some((t) => t.clientId === clientId)) {
    return {
      ok: false,
      error: `Unknown client: ${clientId}. Choose: ${INSTALL_TARGETS.map((t) => t.clientId).join(", ")}`,
    };
  }
  opts.clientId = clientId;
  return { ok: true, options: opts as InstallCommandOptions };
}

/** `yaw-mcp install --list` — print every client/scope combo for the current
 *  OS and whether yaw-mcp is already wired up. Read-only: never
 *  touches a file, never hits the network, works without a token. The
 *  exit code is always 0; this is diagnostic, not gating. */
async function runInstallList(
  opts: InstallCommandOptions,
  log: (s: string) => void,
  messages: string[],
): Promise<InstallResult> {
  // `log` already appends to `messages` (it is runInstall's closure), so the
  // returned trail is exactly what was printed -- deprecation warnings from
  // before the dispatch included. An earlier local array here captured only
  // the rows below and dropped everything else.
  const home = opts.home ?? homedir();
  // Honor --project-dir like the single-client install path does
  // (install-cmd resolves projectDir ?? cwd for the write), so `install
  // --list --project-dir /repo` reports the same files `install vscode
  // --project-dir /repo` would write -- accepting the flag and probing
  // process.cwd() instead made the two surfaces disagree.
  // Resolved exactly like the write path above: a relative --project-dir is
  // taken against the cwd override, not the real process.cwd(), so `--list`
  // and `install <client> --project-dir <rel>` name the same directory.
  const cwd = resolve(opts.cwd ?? process.cwd(), opts.projectDir ?? ".");
  const os = opts.os ?? CURRENT_OS;
  const probes = await probeClientsAsync({
    home,
    os,
    cwd,
    claudeConfigDir: opts.claudeConfigDir,
    appData: resolveAppData(opts),
  });

  const rows = probes.map((p) => ({
    client: INSTALL_TARGETS.find((t) => t.clientId === p.clientId)?.label ?? p.clientId,
    scope: p.scope,
    path: displayPath(p.path, home, os),
    status: statusFor(p),
  }));

  const installed = probes.filter((p) => p.hasMcpEntry).length;
  const available = probes.filter((p) => !p.unavailable).length;
  log(`${installed}/${available} client scopes have yaw-mcp configured on ${os}.`);
  log("");

  const widths = {
    client: Math.max("CLIENT".length, ...rows.map((r) => r.client.length)),
    scope: Math.max("SCOPE".length, ...rows.map((r) => r.scope.length)),
    path: Math.max("PATH".length, ...rows.map((r) => r.path.length)),
    status: Math.max("STATUS".length, ...rows.map((r) => r.status.length)),
  };
  const header =
    `  ${"CLIENT".padEnd(widths.client)}  ` +
    `${"SCOPE".padEnd(widths.scope)}  ` +
    `${"PATH".padEnd(widths.path)}  ` +
    `${"STATUS".padEnd(widths.status)}`;
  log(header);
  for (const r of rows) {
    log(
      `  ${r.client.padEnd(widths.client)}  ` +
        `${r.scope.padEnd(widths.scope)}  ` +
        `${r.path.padEnd(widths.path)}  ` +
        `${r.status.padEnd(widths.status)}`,
    );
  }
  log("");
  log("Install into a specific client: `yaw-mcp install <client> [--scope user|project|local]`");
  log("Install into every available client (user scope where supported): `yaw-mcp install --all`");
  return { written: [], wouldWrite: [], messages, exitCode: 0 };
}

function statusFor(p: ClientProbeResult): string {
  if (p.unavailable) return "unavailable";
  if (p.malformed) return "malformed";
  // A READ failure (a directory at the path, EACCES, a win32 EBUSY from an
  // indexer) is not a syntax error: the probe reports it separately so the
  // row does not send the user to fix JSON that may be perfectly fine, and so
  // it does not fall through to "other-entries" as if the file had been read.
  if (p.unreadable) return `unreadable: ${p.unreadable}`;
  if (p.hasMcpEntry) return "installed";
  // A file whose only yaw-mcp wiring is a PRE-RENAME entry is an upgrade
  // pending, not somebody else's config: `install <client>` has something
  // specific to do there (write `mcp`, then tell the user to trim the old key).
  // Folding it into "other-entries" threw away the probe's own
  // hasLegacyEntry/legacyEntryName and left the row indistinguishable from a
  // config that has nothing to do with yaw-mcp.
  if (p.hasLegacyEntry) return `legacy: ${p.legacyEntryName ?? "unknown"}`;
  if (p.exists) return "other-entries";
  return "not installed";
}

// `os` is the os being LISTED, not process.platform: --list is the one install
// surface that reports another machine's layout (the cross-OS refusal in
// parseInstallArgs exempts it), and keying the separator on the host made
// `--list --os linux` on Windows print a backslash-joined `~` path -- a shape
// the listed os never uses.
//
// EVERY separator is rewritten, not just the leading one. resolveInstallPath
// builds `absolute` with node:path on the HOST (only its sibling `display`
// string is target-shaped), so fixing the head alone printed `~/.cursor\mcp.json`
// -- mixed, and still a shape neither OS uses. Presentation only: the row is
// rooted in THIS machine's home dir either way, which is why a cross-OS write
// is refused and only --list / --dry-run ever reach here.
function displayPath(abs: string, home: string, os: InstallOS): string {
  if (abs === "(n/a)") return abs;
  // The prefix has to END AT A SEPARATOR (or at the end of the string) to mean
  // "under home". A bare startsWith also matched a SIBLING that merely shares
  // the prefix -- `C:\Users\jeff-old\.cursor\mcp.json` against a home of
  // `C:\Users\jeff` -- and rendered it as `~\-old\.cursor\mcp.json`, a path the
  // user does not have, in the column whose whole job is to be pasteable. A
  // home that already ends in a separator (a drive root, `/`) carries its own
  // boundary, so the next character is part of the tail.
  const afterHome = abs.slice(home.length, home.length + 1);
  const endsAtBoundary = afterHome === "" || afterHome === "/" || afterHome === "\\" || /[\\/]$/.test(home);
  if (home && abs.startsWith(home) && endsAtBoundary) {
    const sep = os === "windows" ? "\\" : "/";
    // Only characters that are separators on the HOST that built `absolute`
    // are rewritten. A blanket class would treat a backslash as a separator
    // on a POSIX host, where it is a legal filename character, and would
    // mangle the component containing it.
    const hostSep = process.platform === "win32" ? /[\\/]/g : /\//g;
    const tail = abs
      .slice(home.length)
      .replace(/^[\\/]/, "")
      .replace(hostSep, sep);
    return `~${sep}${tail}`;
  }
  return abs;
}

/** `yaw-mcp install --all` — install into every available client (user
 *  scope where supported). For clients without a user scope, falls back to
 *  the first non-project scope; clients that ONLY have project scopes
 *  (vscode) are included just when --project-dir is passed, otherwise
 *  skipped. Aggregates results; exit code 0 only if every attempted
 *  install succeeded. Mirrors the per-client run behavior: prompts/--force/
 *  --skip flags propagate. */
async function runInstallAll(
  opts: InstallCommandOptions,
  log: (s: string) => void,
  err: (s: string) => void,
  messages: string[],
): Promise<InstallResult> {
  const os = opts.os ?? CURRENT_OS;
  const targets = INSTALL_TARGETS.filter((t) => t.availableOn.includes(os));
  if (targets.length === 0) {
    err(`yaw-mcp install --all: no installable clients on ${os}.`);
    // `messages`, not [] -- the err() above (and any deprecation warning
    // before the dispatch) belongs in the returned trail.
    return { written: [], wouldWrite: [], messages, exitCode: 1 };
  }

  // Pick one scope per client: user where supported, else the first
  // non-project-dir scope. Clients that ONLY have project-dir scopes
  // (vscode) are included only when --project-dir was passed.
  // `usesProjectDir` rides along per plan because runInstall now REFUSES a
  // --project-dir the resolved scope would silently drop. Under `--all
  // --project-dir` most plans are user-scoped and only the project-only client
  // reads the flag, so each sub-install is handed just the flags its own scope
  // consults (see the recursion below).
  type Plan = { clientId: InstallClientId; scope: InstallScope; usesProjectDir: boolean };
  const plans: Plan[] = [];
  const skipped: Array<{ clientId: InstallClientId; reason: string }> = [];
  for (const t of targets) {
    const userScope = t.scopes.find((s) => s.scope === "user");
    if (userScope) {
      plans.push({ clientId: t.clientId, scope: "user", usesProjectDir: userScope.requiresProjectDir });
      continue;
    }
    const firstNoProj = t.scopes.find((s) => !s.requiresProjectDir);
    if (firstNoProj) {
      plans.push({ clientId: t.clientId, scope: firstNoProj.scope, usesProjectDir: false });
      continue;
    }
    if (opts.projectDir) {
      plans.push({ clientId: t.clientId, scope: t.scopes[0].scope, usesProjectDir: t.scopes[0].requiresProjectDir });
      continue;
    }
    skipped.push({
      clientId: t.clientId,
      reason: `requires --project-dir (scopes: ${t.scopes.map((s) => s.scope).join(", ")})`,
    });
  }

  log(`Installing into ${plans.length} client${plans.length === 1 ? "" : "s"}...`);
  if (skipped.length > 0) {
    for (const s of skipped) log(`  skip ${s.clientId}: ${s.reason}`);
  }
  log("");

  const aggregateWritten: string[] = [];
  const aggregateWouldWrite: string[] = [];
  let failed = 0;
  let succeeded = 0;
  // Collision-without-flag refusals (non-TTY, no --force/--skip) all carry
  // the same fix -- re-run --all with --force or --skip. Under --all they'd
  // otherwise stack up as N identical per-client "already has entry and
  // stdin is not a TTY" stderr lines. Capture each sub-install's stderr,
  // suppress that specific refusal, and emit ONE consolidated hint below.
  const collisionClients: string[] = [];
  const realStderr = opts.io?.stderr ?? process.stderr;
  const isCollisionRefusal = (s: string): boolean =>
    s.includes(`already has a "${ENTRY_NAME}" entry and stdin is not a TTY`);
  for (const plan of plans) {
    log(`-- ${plan.clientId} (${plan.scope}) --`);
    let sawCollision = false;
    // Per-call stderr: replay every line to the real stderr EXCEPT the
    // collision-without-flag refusal, which we consolidate.
    const subStderr = new Writable({
      write(chunk: Buffer | string, _enc, cb): void {
        const text = chunk.toString();
        if (isCollisionRefusal(text)) sawCollision = true;
        else realStderr.write(text);
        cb();
      },
    }) as unknown as NodeJS.WritableStream;
    const baseIo = opts.io ?? {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      isTTY: Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
    };
    const result = await runInstall({
      ...opts,
      listOnly: false,
      all: false,
      // Strip the deprecated flags: runInstall warns about them at the top
      // of every call, and the --all entry point has already warned once.
      // Without this the user gets one notice per client.
      token: undefined,
      skipYawMcpConfig: undefined,
      // Same consolidation, one line down: printed once after the loop.
      suppressOamAbsentNote: true,
      clientId: plan.clientId,
      scope: plan.scope,
      // Only the plans whose scope actually resolves a path from --project-dir
      // get it. runInstall refuses the flag for a scope that would drop it, so
      // passing the parent's copy to every client would fail each user-scope
      // one the moment --project-dir was passed to pull the project-only
      // client (vscode) into the run.
      projectDir: plan.usesProjectDir ? opts.projectDir : undefined,
      io: { ...baseIo, stderr: subStderr },
    });
    if (sawCollision) collisionClients.push(plan.clientId);
    aggregateWritten.push(...result.written);
    aggregateWouldWrite.push(...result.wouldWrite);
    // Splice each sub-install's trail in right where it printed, between this
    // client's header and the blank line that closes it -- MINUS the collision
    // refusals the shim above swallowed. `messages` is documented as exactly
    // what was printed, so splicing an unprinted refusal in (once per colliding
    // client, on top of the consolidated line below) made the returned trail
    // disagree with the transcript the user saw.
    messages.push(...result.messages.filter((m) => !isCollisionRefusal(m)));
    if (result.exitCode === 0) succeeded += 1;
    else failed += 1;
    log("");
  }

  // The single copy the per-client suppression above defers to. Probed here
  // rather than threaded out of the loop because probeOam is cached for the
  // process lifetime, so this is a cache hit, and the test hook has to be
  // honoured on this path too or a fixture-driven --all run would consult the
  // real machine. Only the ABSENT case: every other Runtime reason still prints
  // per client, where it belongs.
  // Gated on the run leaving at least one entry in place: the note is a
  // runtime tip ABOUT the entries yaw-mcp is wired into, so on an
  // all-refused / all-failed run it printed advice for entries that do not
  // exist -- immediately above the collision hint and the failure summary.
  //
  // `succeeded > 0` is part of the test, not just the written/would-write
  // lists. Under `--all --skip` a client that ALREADY has an entry is a
  // success that writes nothing, so a fully-successful all-skip run has both
  // lists empty -- and gating on those alone made the tip vanish from exactly
  // the run where every entry it describes is present and about to be used.
  const runLeftAnEntry = aggregateWritten.length > 0 || aggregateWouldWrite.length > 0 || succeeded > 0;
  if (runLeftAnEntry && oamIsAbsent(await (opts.oamProbe ?? probeOam)())) {
    log(oamAbsentNote(os, opts.oamPublishesBinary));
  }

  if (collisionClients.length > 0) {
    err(
      `yaw-mcp install --all: ${collisionClients.length} client${collisionClients.length === 1 ? "" : "s"} already have a "${ENTRY_NAME}" entry (${collisionClients.join(", ")}) and stdin is not a TTY.\n  Re-run \`yaw-mcp install --all --force\` to overwrite them, or \`--skip\` to leave them untouched.`,
    );
  }

  const totalPlanned = plans.length;
  if (failed === 0) {
    log(`Done: ${succeeded}/${totalPlanned} clients installed successfully.`);
    return {
      written: aggregateWritten,
      wouldWrite: aggregateWouldWrite,
      messages,
      exitCode: 0,
    };
  }
  err(`${failed}/${totalPlanned} client install${failed === 1 ? "" : "s"} failed. ${succeeded} succeeded.`);
  return {
    written: aggregateWritten,
    wouldWrite: aggregateWouldWrite,
    messages,
    exitCode: 1,
  };
}

export const INSTALL_USAGE = USAGE;
