import { parseAuditArgs, runAudit } from "./audit-cmd.js";
import { parseBundlesArgs, runBundlesCommand } from "./bundles-cmd.js";
import { parseCompletionArgs, runCompletion } from "./completion-cmd.js";
import { runComplianceCommand } from "./compliance-cmd.js";
import { loadYawMcpConfig } from "./config-loader.js";
import { parseDoctorArgs, runDoctor } from "./doctor-cmd.js";
import { parseFoundryArgs, runFoundryExport } from "./foundry-cmd.js";
import { INSTALL_USAGE, parseInstallArgs, runInstall } from "./install-cmd.js";
import { parseAddArgs, parseListArgs, parseRemoveArgs, runAdd, runList, runRemove } from "./local-add-cmd.js";
import { log } from "./logger.js";
import { parseResetLearningArgs, RESET_LEARNING_USAGE, runResetLearning } from "./reset-learning-cmd.js";
import { parseSecretsArgs, runSecrets } from "./secrets-cmd.js";
import { ConnectServer } from "./server.js";
import { parseServersArgs, runServersCommand } from "./servers-cmd.js";
import { parseSidecarsArgs, runSidecarsInstall } from "./sidecars-cmd.js";
import { suggestFlag, suggestSubcommand } from "./subcommands.js";
import { parseTrustArgs, runTrust } from "./trust-cmd.js";
import { parseTryArgs, parseTryCleanupArgs, runTry, runTryCleanup } from "./try-cmd.js";
import { parseUpgradeArgs, runUpgrade } from "./upgrade-cmd.js";

// The known-subcommand / flag-alias dispatch table and the did-you-mean
// helpers (suggestSubcommand / suggestFlag) live in ./subcommands.js (a
// side-effect-free module) so the completion test can import the
// ground-truth dispatch table, and the suggestion logic can be unit
// tested, without booting this dispatcher.

declare const __VERSION__: string;

// Shared dispatch tail for the subcommand runners. Every `runX(...)`
// returns either a `{ exitCode }` result or a bare number; this funnels
// the promise through a single `.catch()` so a rejection (e.g.
// `runSecrets` on a corrupt vault) prints a clean
// `yaw-mcp <cmd>: <message>` to stderr and exits 1, instead of dumping a
// raw Node stack and bypassing the 2-for-usage / 1-for-error convention.
function dispatch(cmd: string, p: Promise<{ exitCode: number } | number>): void {
  // IMPORTANT: do NOT call process.exit() synchronously here. A bare
  // process.exit() force-flushes the event loop and can TRUNCATE buffered
  // stdout when the consumer is a slow pipe (e.g. `yaw-mcp doctor --json
  // | jq ...` on a large bundle, or `yaw-mcp audit --json | tee
  // ...`). Setting process.exitCode and returning lets Node drain
  // pending writes on its own; once the runner promise settles AND
  // stdout/stderr finish flushing, the process exits naturally with the
  // requested code. The runner has already awaited every print/write it
  // owns by the time the promise resolves, so no further awaits are
  // needed here.
  p.then((r) => {
    process.exitCode = typeof r === "number" ? r : r.exitCode;
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`yaw-mcp ${cmd}: ${msg}\n`);
    process.exitCode = 1;
  });
}

/** Parse result shape shared by every subcommand parser below. `help` is
 *  absent on the parsers that have no --help of their own. */
type ParseResult<T> = { ok: true; options: T } | { ok: false; error: string; help?: boolean };

/**
 * The parse-then-dispatch tail every `{ok}`-shaped subcommand shares: a
 * --help parse prints usage to stdout and exits 0, a real argv error goes to
 * stderr and exits 2, and anything else hands the options to the runner.
 *
 * Sets process.exitCode instead of calling process.exit(), for the SAME
 * reason dispatch() above and the top-level --help branch below do: a
 * synchronous exit force-flushes the event loop and can TRUNCATE a buffered
 * usage body when stdout is a slow pipe (`yaw-mcp install --help | less`).
 * This was open-coded in 13 branches, every one of which called
 * process.exit() right after the write -- the hazard the rest of the file
 * takes care to avoid. Returning lets Node drain the write and exit on its
 * own with the requested code.
 */
function run<T>(
  cmd: string,
  parsed: ParseResult<T>,
  runner: (options: T) => Promise<{ exitCode: number } | number>,
): void {
  if (!parsed.ok) {
    (parsed.help ? process.stdout : process.stderr).write(`${parsed.error}\n`);
    process.exitCode = parsed.help ? 0 : 2;
    return;
  }
  dispatch(cmd, runner(parsed.options));
}

// Subcommand dispatcher. `yaw-mcp` with no args (or with flags only) runs as
// the MCP server. Known subcommands branch off before the server is ever
// constructed, so `compliance`, `install`, and `doctor` never open a stdio
// transport. There is no auth gate to branch around: the hosted backend is
// retired, YAW_MCP_TOKEN is a dead legacy key (see upstream.ts), and every
// subcommand here is local-only.
const subcommand = process.argv[2];

if (subcommand === "compliance") {
  dispatch("compliance", runComplianceCommand(process.argv.slice(3)));
} else if (subcommand === "audit") {
  run("audit", parseAuditArgs(process.argv.slice(3)), runAudit);
} else if (subcommand === "foundry") {
  // Plain shared tail: parseFoundryArgs sets `help: true` on --help like every
  // other parser here. This branch used to re-derive help by comparing the
  // error against FOUNDRY_USAGE and spread that verdict OVER the parser's
  // flag, so the flag was dead and any byte of drift between the two strings
  // sent `foundry --help` to stderr with exit 2.
  run("foundry", parseFoundryArgs(process.argv.slice(3)), runFoundryExport);
} else if (subcommand === "install") {
  const parsed = parseInstallArgs(process.argv.slice(3));
  // --help is now a successful parse with helpRequested=true (parser
  // returns { ok: true, options: { helpRequested: true } }); print USAGE
  // and exit 0. Real argv errors still come back as ok:false -> stderr + 2.
  if (parsed.ok && parsed.options.helpRequested) {
    // Help is a SUCCESSFUL parse here, so it cannot ride the shared tail --
    // but INSTALL_USAGE is multi-KB, so it still must not process.exit().
    process.stdout.write(`${INSTALL_USAGE}\n`);
    process.exitCode = 0;
  } else {
    // Read CLAUDE_CONFIG_DIR here (not inside runInstall) so tests stay
    // hermetic — they call runInstall directly and never inherit env state.
    const claudeConfigDir =
      process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.length > 0
        ? process.env.CLAUDE_CONFIG_DIR
        : undefined;
    run("install", parsed, (options) => runInstall({ ...options, claudeConfigDir }));
  }
} else if (subcommand === "doctor") {
  // Argv parsing lives in doctor-cmd.ts (parseDoctorArgs) like every sibling
  // subcommand's, so the completion / help tests can import it -- importing
  // THIS file to test the branch is impossible, since the dispatcher runs at
  // import time. The branch is now just the shared parse-then-dispatch tail.
  run("doctor", parseDoctorArgs(process.argv.slice(3)), runDoctor);
} else if (subcommand === "reset-learning") {
  const parsed = parseResetLearningArgs(process.argv.slice(3));
  if (parsed.kind === "help") {
    process.stdout.write(`${RESET_LEARNING_USAGE}\n`);
    process.exitCode = 0;
  } else if (parsed.kind === "error") {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 2;
  } else {
    dispatch("reset-learning", runResetLearning());
  }
} else if (subcommand === "servers") {
  run("servers", parseServersArgs(process.argv.slice(3)), runServersCommand);
} else if (subcommand === "sidecars") {
  run("sidecars", parseSidecarsArgs(process.argv.slice(3)), runSidecarsInstall);
} else if (subcommand === "bundles") {
  run("bundles", parseBundlesArgs(process.argv.slice(3)), runBundlesCommand);
} else if (subcommand === "completion") {
  run("completion", parseCompletionArgs(process.argv.slice(3)), runCompletion);
} else if (subcommand === "upgrade") {
  run("upgrade", parseUpgradeArgs(process.argv.slice(3)), runUpgrade);
} else if (subcommand === "try") {
  run("try", parseTryArgs(process.argv.slice(3)), runTry);
} else if (subcommand === "try-cleanup") {
  run("try-cleanup", parseTryCleanupArgs(process.argv.slice(3)), runTryCleanup);
} else if (subcommand === "add") {
  run("add", parseAddArgs(process.argv.slice(3)), runAdd);
} else if (subcommand === "remove") {
  run("remove", parseRemoveArgs(process.argv.slice(3)), runRemove);
} else if (subcommand === "list") {
  run("list", parseListArgs(process.argv.slice(3)), runList);
} else if (subcommand === "secrets") {
  run("secrets", parseSecretsArgs(process.argv.slice(3)), runSecrets);
} else if (subcommand === "trust") {
  run("trust", parseTrustArgs(process.argv.slice(3)), runTrust);
} else if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
  process.stdout.write(`
  yaw-mcp -- one install, every MCP server, managed from one place.

  Quickstart:
    1. Install yaw-mcp      yaw-mcp install claude-code
    2. Verify setup         yaw-mcp doctor
    3. Add a server         yaw-mcp add <slug>   (browse https://yaw.sh/mcp/catalog/)

  Setup (connect a client to yaw-mcp):
    install <client>         Connect one MCP client to yaw-mcp. This wires the
                             aggregator into the client; it does NOT add a
                             server (for that, see \`add\` below). <client> is
                             one of: claude-code, claude-desktop, cursor, vscode.
    install --list           List which MCP clients are installed on this
                             machine (read-only; no writes).
    install --all            Configure every installed MCP client in one go.

  Local servers (no account):
    add <slug>               Add an MCP server from the yaw.sh/mcp catalog to
                             your local ~/.yaw-mcp/bundles.json so yaw-mcp loads
                             it. Pass required env with --env KEY=value.
    remove <slug>            Remove a server (by slug or namespace) from
                             bundles.json. Shows the server and the command it
                             launches, then confirms; --force skips the prompt
                             (and is required when there is no TTY to ask on).
    list                     List the servers yaw-mcp loads locally.
    trust                    Approve this project's .yaw-mcp/bundles.json so
                             yaw-mcp loads it. A project file is usually
                             committed to the repo and every server in it is
                             a command yaw-mcp spawns AS YOU, so an unapproved
                             one is ignored (your user-global bundles.json
                             still loads). Shows the exact commands before
                             asking. \`--list\` / \`--revoke\` manage approvals.
    try <slug>               Wire a one-off trial of a catalog MCP server
                             directly into your AI client (bypassing yaw-mcp).
                             No account needed; expires after --ttl (default
                             1h). Doctor GCs it after.
    try-cleanup <slug>       Remove a wired trial early.

  Inspection:
    doctor                   Diagnose setup: config, token, clients, learning,
                             upgrade, flaky-namespace reliability rollup.
    servers [<filter>]       DEPRECATED -- account mode is gone; this always
                             fails. Use \`list\` instead.
    bundles [list|match]     Browse curated multi-server bundles. \`list\` shows
                             all; \`match\` partitions against your enabled
                             local servers (ready vs. partially installed).

  Maintenance:
    upgrade                  Show (or --run) the command that bumps
                             @yawlabs/mcp to the latest version.
    sidecars install         Install your servers into ~/.yaw-mcp/sidecars so
                             they run from one known version. Worth doing when
                             servers run on oam: it runs the copy already on
                             disk and cannot re-resolve \`@latest\` the way npx
                             did. Re-run to move them forward; \`doctor\` shows
                             the version each one is on.
    reset-learning           Clear cross-session learning history
                             (~/.yaw-mcp/state.json).
    completion <shell>       Print a shell completion script for bash, zsh,
                             fish, or powershell. Redirect to your
                             completions directory to install.

  Secrets:
    secrets <action>         Manage the local encrypted secret vault: set,
                             get, list, remove, lock, rotate, audit.
                             Reference a stored value from any server's env
                             as \${secret:NAME}.

  Other:
    compliance <target>      Run the 88-test compliance suite against an MCP
                             server and print the grade.
    audit <namespace>        Run the compliance suite against a stdio server
                             from your bundles.json and cache its A-F grade in
                             ~/.yaw-mcp/grades.json (shown in \`list\` + the
                             Yaw Terminal MCP panel).
    foundry export           MAINTAINER. Fold the opt-in dispatch harvest
                             (~/.yaw-mcp/foundry.jsonl, written only while
                             YAW_MCP_FOUNDRY is on) into the routing-regression
                             corpus the test gate replays. Needs a local
                             bundles.json for the server-catalog snapshot.
    help, --help, -h         Show this help.
    --version, -V            Print yaw-mcp version.

  Running \`yaw-mcp\` with no subcommand starts the MCP server, loading your
  servers from ~/.yaw-mcp/bundles.json. It runs entirely on your machine --
  there is no account and no sign-in. Most read-only subcommands accept
  \`--json\` for machine-readable output. Run \`yaw-mcp <subcommand> --help\`
  for per-subcommand flag details.

  Environment variables:
    YAW_MCP_SERVER_CAP            Max concurrently active servers (default 6).
    YAW_MCP_MIN_COMPLIANCE        Minimum grade to auto-activate (A|B|C|D|F).
    YAW_MCP_AUTO_LOAD             Auto-activate the namespaces of the highest-
                               ranked recurring pack at startup, subject to
                               SERVER_CAP (default: off).
    YAW_MCP_AUTO_ACTIVATE         Set to \`0\` to disable discover's auto-activate
                               gate (default: a clearly-winning server is
                               activated in the same call).
    YAW_MCP_AUTO_UPGRADE          Set to \`0\` to disable the background
                               self-upgrade check at server startup (default:
                               stale global installs are upgraded in the
                               background -- npm, pnpm, and bun globals alike).
    YAW_MCP_SIDECAR_REFRESH       Set to \`0\` to disable the background check
                               that keeps managed sidecars (\`yaw-mcp sidecars
                               install\`) current. When a managed tree exists,
                               each serve start may probe the npm registry for
                               the packages configured to float (\`@latest\` or
                               no version) and, at most once a day, run an
                               \`npm install\`/\`npm update\` in the sidecars
                               root in the background. Never runs without a
                               managed tree; explicit pins and ranges are
                               never moved (default: on).
    YAW_MCP_PRUNE_RESPONSES       Set to \`0\` to disable response pruning.
    YAW_MCP_TOOL_EXPOSURE         How much of the catalog tools/list advertises.
                               \`gateway\` (default) exposes the meta-tools
                               plus loaded servers only; \`full\` restores the
                               pre-gateway behavior and inlines the whole
                               catalog. Re-read per call -- a change lands on
                               the next tools/list without a restart.
    YAW_MCP_ROUTE_EFFORT          How hard dispatch tries to break ranking ties
                               with the client LLM: \`off\` | \`auto\` |
                               \`aggressive\` (default auto). The dispatch
                               tool's \`routeEffort\` argument overrides this
                               per call.
    YAW_MCP_REWARD_GRADER         Set to \`1\` to OPT IN to the LLM reward
                               grader: uncertain dispatch outcomes get a
                               second opinion via client sampling. It spends
                               the client's LLM budget and adds a round-trip,
                               so it is off by default.
    YAW_MCP_IDLE_THRESHOLD        Non-matching tool calls a loaded server
                               tolerates before it is unloaded (default 10).
                               Bursty servers earn more patience on top of
                               this. The older name
                               MCP_CONNECT_IDLE_THRESHOLD is still read as a
                               fallback.
    YAW_MCP_DEFAULT_RUNTIME       Default runtime for local node/npx servers
                               (\`oam\` or \`node\`). Servers without a per-
                               server \`runtime\` use this; per-server
                               \`"runtime": "node"\` opts out. Same knob as
                               bundles.json top-level \`defaultRuntime\`
                               (env wins). Unset = oam when it is installed
                               and meets the minimum version, else node.
    YAW_MCP_INSTALL_NUDGE         Set to \`1\` to let discover suggest installing
                               a first-party server for a CLI you use heavily
                               (default: off; config \`installNudge: true\` is
                               the other switch -- either one enables it).
    YAW_MCP_VAULT_PASSPHRASE      Unlocks the local secret vault
                               (~/.yaw-mcp/secrets.json). REQUIRED for
                               spawn-time \${secret:NAME} substitution: a
                               server whose env references a secret fails to
                               start without it, rather than passing the
                               literal placeholder through. Set it in
                               yaw-mcp's OWN env (the \`env\` block of the
                               yaw-mcp entry in your MCP client config), not
                               in the upstream server's -- it is stripped
                               from every child env. A client that supports
                               MCP elicitation prompts for it instead, for
                               that session only. Manage entries with
                               \`yaw-mcp secrets\`.
    YAW_MCP_VAULT_PASSPHRASE_NEW  The NEW passphrase for \`yaw-mcp secrets
                               rotate\`, so a re-wrap can run without a TTY.
                               Read only by \`rotate\`; without it (and
                               without a TTY to confirm on) rotate fails
                               rather than picking one for you.
    YAW_MCP_TRUST_PROJECT         Set to \`1\` to skip the consent check on a
                               project-local .yaw-mcp/bundles.json and load
                               it unconditionally. FOR CI/AUTOMATION ONLY --
                               it lets any repo you run yaw-mcp inside spawn
                               arbitrary commands as you. Default: the file
                               must be approved with \`yaw-mcp trust\`.
    YAW_MCP_ALLOW_UNOWNED_PROJECT_DIRS
                               Set to \`1\` to accept a .yaw-mcp/ directory
                               found outside $HOME whose owner cannot be
                               verified (every win32 checkout, since there
                               is no cheap ownership probe there). FOR
                               CI/AUTOMATION ONLY -- an unowned directory
                               on a writable volume lets a third party
                               inject YAW-MCP.md guidance into your model
                               context and apply config.json allow/block
                               lists. Default: such candidates are skipped
                               with a warning.
    YAW_MCP_DISABLE_PERSISTENCE   Disable cross-session learning state.
    YAW_MCP_FOUNDRY               Set to \`1\` to OPT IN to harvesting dispatch
                               traces to ~/.yaw-mcp/foundry.jsonl for routing
                               evals (default: off). Only a redacted, SORTED
                               token bag plus the candidate/chosen namespaces
                               are written -- never the raw intent -- but
                               ordinary words survive, so do not enable it on
                               intents that carry names or other PII.
    YAW_MCP_CATALOG_URL          Override the catalog \`add\`/\`try\` resolve slugs
                               against (default https://yaw.sh/data/mcp-catalog.json).

  Environment variables without the YAW_MCP_ prefix (they name things yaw-mcp
  does not own):
    OAM_BIN                       The oam binary to run when a server is hosted
                               on the oam runtime. A name resolved against PATH
                               or an absolute path; set it when oam is installed
                               somewhere PATH does not reach. Default: \`oam\`
                               (\`oam.exe\` on Windows).
    OAM_MAX_HEAP_MB               Read by oam, not by yaw-mcp: raises the V8
                               heap cap oam applies to a hosted server (4 GiB
                               by default since oam 0.9.2). Set it in that
                               server's \`env\` in bundles.json when a hosted
                               sidecar dies with a heap out-of-memory error,
                               or give that server \`"runtime": "node"\`.
    MCP_CONNECT_TIMEOUT           Milliseconds to wait for a server's MCP
                               handshake (default 15000). This is the FALLBACK
                               only -- a server's own \`connectTimeoutMs\` in
                               bundles.json always wins, so one slow server does
                               not need the global ceiling raised.
    MCP_LIST_TIMEOUT              Milliseconds to wait for a server's tool/
                               resource/prompt inventory calls after the
                               handshake (default 15000).
    MCP_CALL_TIMEOUT              Milliseconds to wait for a single proxied
                               tools/call (default 60000, the SDK's own
                               bound) -- the last leg of a request that had
                               no override. Raise it for a server that is
                               legitimately slow (browser automation, a
                               large query, a cold first call): a timeout is
                               booked as an upstream error, so a healthy but
                               slow server is otherwise down-ranked in the
                               reliability lines \`discover\` renders.
    CLAUDE_CONFIG_DIR             Claude Code's config directory, honored by
                               \`install\`, \`try\` and \`doctor\` whenever they
                               locate Claude Code's config, so a non-default
                               location is read and written instead of
                               ~/.claude. It is Claude Code's knob, not
                               yaw-mcp's; the server itself never reads it.
    LOG_LEVEL                     Verbosity of yaw-mcp's own JSON log lines on
                               stderr: \`debug\` | \`info\` | \`warn\` | \`error\`
                               (default info). \`debug\` is what to set when
                               asking why a server did not load.

  Config resolution (highest precedence first) -- for the \`servers\` allow-list
  and \`blocked\` deny-list:
    1. <project>/.yaw-mcp/config.local.json   machine-local overrides (gitignore)
    2. <project>/.yaw-mcp/config.json         project-shared (checked in)
    3. ~/.yaw-mcp/config.json                 user-global default

  yaw-mcp reads config at startup. Restart the MCP client (or kill yaw-mcp;
  the client will respawn it) after editing any config.

  The \`token\` and \`apiBase\` config keys, and the \`--token\` /
  \`--no-yaw-mcp-config\` install flags, are deprecated and ignored -- yaw-mcp
  no longer contacts a hosted API. They are still accepted for one release.
  If you have a token on disk, delete it and revoke it at its source.

  Docs:   https://yaw.sh/mcp
  Source: https://github.com/YawLabs/mcp

`);
  // Set exitCode instead of process.exit(0): this help body is several KB
  // and a synchronous exit can TRUNCATE it when stdout is a slow pipe
  // (`yaw-mcp --help | less`, or a terminal capturing to a file). Same
  // reasoning as dispatch() above -- nothing follows this branch, so
  // returning lets Node drain the write and exit 0 on its own.
  process.exitCode = 0;
} else if (subcommand === "--version" || subcommand === "-V") {
  // __VERSION__ is substituted at build time by tsup (see tsup.config.ts);
  // when running unbundled from source the declare leaves it as undefined,
  // so guard with typeof and fall back to "dev".
  process.stdout.write(`yaw-mcp ${typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev"}\n`);
  process.exitCode = 0;
} else if (subcommand !== undefined && !subcommand.startsWith("-")) {
  // Bare positional first arg that isn't a known subcommand — almost
  // always a typo. Surface a "did you mean?" instead of falling through
  // to runServer, which would silently boot a stdio MCP server on a dead
  // prompt (there is no token to fail on -- yaw-mcp is local-only).
  //
  // The test is `!== undefined`, NOT truthiness: `yaw-mcp ""` passes an
  // empty first argument, which is a bare positional with no leading dash
  // and belongs here. Under the old truthy guard it fell through to the
  // else branch and was reported as `unknown flag ""` -- naming the wrong
  // category for an argument that has no dash in it at all.
  const suggestions = suggestSubcommand(subcommand);
  const hint =
    suggestions.length > 0
      ? ` Did you mean: ${suggestions.join(", ")}?`
      : " Run `yaw-mcp --help` for the list of subcommands.";
  process.stderr.write(`yaw-mcp: unknown subcommand "${subcommand}".${hint}\n`);
  process.exitCode = 2;
} else {
  // ANY leading-dash argument is an unknown flag: reject with exit 2 (plus
  // a did-you-mean when suggestFlag has a close match) instead of booting
  // the stdio server. The old pass-through defended "genuine long server
  // flags" -- but runServer reads no argv and the installers write none, so
  // the protected surface never existed, and `yaw-mcp --verbose` / `-x`
  // silently hung as an MCP server on a dead prompt (the exact
  // ship-blocker the --HELP test calls out). A bare `yaw-mcp` (subcommand
  // undefined) still starts the server -- that IS the server launch.
  if (subcommand !== undefined) {
    const flagSuggestions = suggestFlag(subcommand);
    const hint =
      flagSuggestions.length > 0
        ? ` Did you mean: ${flagSuggestions.join(", ")}?`
        : " Run `yaw-mcp --help` for the list of subcommands and flags.";
    process.stderr.write(`yaw-mcp: unknown flag "${subcommand}".${hint}\n`);
    process.exitCode = 2;
  } else {
    // Startup failure path. runServer() registers a last-resort
    // unhandledRejection handler (see below) BEFORE its first await, so a
    // fatal startup rejection would otherwise be swallowed by that
    // handler: logged as a JSON line, no server started, and the process
    // exiting 0 as if all was well. Attaching a real catch here
    // restores the "print the error and exit 1" contract. It only covers
    // the startup promise; a genuine POST-startup rejection (an orphaned
    // upstream connect that rejects late) still lands on the handler
    // inside runServer, which logs and keeps the server running.
    //
    // Be honest about how narrow that is. The two failure modes this
    // comment used to name cannot reach here:
    //   * an unreadable config dir -- loadYawMcpConfig is fail-open by
    //     construction. readConfigAt turns EVERY read/parse error into a
    //     warning and returns null, and both the legacy-path migration and
    //     the project-dir walk-up carry their own .catch().
    //   * a transport that fails to connect -- server.start() is
    //     fire-and-forget below with its OWN .catch(), which logs "Fatal
    //     startup error" and calls process.exit(1) directly. It never
    //     rejects the promise this catch is attached to.
    // What DOES land here is a throw in runServer's own body before that
    // hand-off: process.cwd() raising ENOENT on a deleted working dir
    // inside loadYawMcpConfig, or the ConnectServer constructor throwing.
    // The branch is a cheap net for those, not the config/transport guard
    // it was once described as. Startup-failure behavior is otherwise
    // owned by the server.start() catch.
    //
    // Same buffered-write reasoning as dispatch(): set process.exitCode
    // instead of calling process.exit(), so the stderr write is drained
    // before Node exits on its own.
    runServer().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`yaw-mcp: ${msg}\n`);
      process.exitCode = 1;
    });
  }
}

async function runServer(): Promise<void> {
  // Last-resort net for stray async failures. Without this a single
  // unhandled rejection (e.g. an orphaned upstream connect that rejects
  // late) can tear down the stdio transport with no trace. Log and keep
  // running rather than dying silently.
  //
  // Registered BEFORE the first await below: loadYawMcpConfig() reads and
  // parses config files, so a malformed config or a permissions error can
  // reject during startup -- with the handlers installed afterwards that
  // rejection had no net at all.
  process.on("unhandledRejection", (e) => log("error", "unhandledRejection", { error: String(e) }));
  process.on("uncaughtException", (e) => log("error", "uncaughtException", { error: String(e) }));

  // Load config for its warnings (schema-version drift, malformed files,
  // retired `token` / `apiBase` keys still on disk) and for the allow/deny
  // lists. Server definitions come from ~/.yaw-mcp/bundles.json; an empty
  // (or absent) bundles.json is fine, yaw-mcp starts with an empty list.
  const config = await loadYawMcpConfig();

  // Surface non-fatal config warnings on startup so the user sees them
  // (e.g., loose file perms, schema-version mismatch). Doctor shows the
  // full picture; this is just a heads-up. The resolved config is handed to
  // server.start() below so the files are read ONCE and each warning is
  // logged once -- start() used to re-load them and drop its copy of the
  // warnings on the floor.
  for (const w of config.warnings) {
    log("warn", "Config warning", { warning: w });
  }

  log("info", "yaw-mcp startup", {
    hint: "loading servers from ~/.yaw-mcp/bundles.json (if present)",
  });

  const server = new ConnectServer();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Deliberately REF'd. This watchdog exists for exactly one case -- a
    // server.shutdown() that never settles -- and an unref'd timer stops
    // holding the event loop open, so in that case Node would either exit
    // on its own (whatever else is pending decides) or hang forever, and
    // the force-exit would never fire: the guard was disarmed precisely
    // when it was needed. It costs nothing on the healthy path, because
    // the process.exit(0) below runs the moment shutdown resolves and
    // takes the pending timer with it.
    setTimeout(() => process.exit(1), 10_000);
    await server.shutdown();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.start({ config }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "Fatal startup error", { error: msg });
    process.exit(1);
  });
}
