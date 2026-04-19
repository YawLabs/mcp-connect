import { parseBundlesArgs, runBundlesCommand } from "./bundles-cmd.js";
import { parseCompletionArgs, runCompletion } from "./completion-cmd.js";
import { runComplianceCommand } from "./compliance-cmd.js";
import { loadMcphConfig, tokenFingerprint } from "./config-loader.js";
import { ConfigError } from "./config.js";
import { runDoctor } from "./doctor-cmd.js";
import { closestNames } from "./fuzzy.js";
import { parseInstallArgs, runInstall } from "./install-cmd.js";
import { log } from "./logger.js";
import { runResetLearning } from "./reset-learning-cmd.js";
import { ConnectServer } from "./server.js";
import { parseServersArgs, runServersCommand } from "./servers-cmd.js";
import { parseUpgradeArgs, runUpgrade } from "./upgrade-cmd.js";

// Known subcommands for fuzzy-match feedback on typos. Anything not in
// this list and not a flag (leading `-`) falls through to "unknown
// subcommand" before runServer, so `mcph instal` fails loud instead of
// starting as an MCP server and opaquely erroring on the missing token.
const KNOWN_SUBCOMMANDS = [
  "compliance",
  "install",
  "doctor",
  "reset-learning",
  "servers",
  "bundles",
  "completion",
  "upgrade",
  "help",
  "--help",
  "-h",
  "--version",
  "-V",
] as const;

declare const __VERSION__: string;

// Subcommand dispatcher. `mcph` with no args (or with flags only) runs as
// the MCP server that talks to mcp.hosting. Known subcommands branch off
// before the MCPH_TOKEN check so local-only commands like `compliance`,
// `install`, and `doctor` don't require an account.
const subcommand = process.argv[2];
if (subcommand === "compliance") {
  runComplianceCommand(process.argv.slice(3)).then((code) => process.exit(code));
} else if (subcommand === "install") {
  const parsed = parseInstallArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runInstall(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "doctor") {
  const doctorArgs = process.argv.slice(3);
  const doctorJson = doctorArgs.includes("--json");
  const doctorUnknown = doctorArgs.find((a) => a !== "--json" && a !== "--help" && a !== "-h");
  if (doctorArgs.includes("--help") || doctorArgs.includes("-h")) {
    process.stdout.write(
      "Usage: mcph doctor [--json]\n\n  Print a diagnostic of your mcph setup.\n\n  --json  Emit machine-readable JSON instead of text.\n",
    );
    process.exit(0);
  }
  if (doctorUnknown) {
    process.stderr.write(`mcph doctor: unknown argument "${doctorUnknown}"\n`);
    process.exit(2);
  }
  runDoctor({ json: doctorJson }).then((r) => process.exit(r.exitCode));
} else if (subcommand === "reset-learning") {
  runResetLearning().then((r) => process.exit(r.exitCode));
} else if (subcommand === "servers") {
  const parsed = parseServersArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runServersCommand(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "bundles") {
  const parsed = parseBundlesArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runBundlesCommand(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "completion") {
  const parsed = parseCompletionArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runCompletion(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "upgrade") {
  const parsed = parseUpgradeArgs(process.argv.slice(3));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    process.exit(2);
  }
  runUpgrade(parsed.options).then((r) => process.exit(r.exitCode));
} else if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
  process.stdout.write(`
  mcph — one install, every MCP server, managed from the cloud.

  Quickstart:
    1. Get a token      https://mcp.hosting/dashboard/settings/tokens
    2. Install mcph     mcph install claude-code --token mcp_pat_...
    3. Verify setup     mcph doctor

  Setup:
    install <client>         Auto-edit an MCP client's config to launch mcph.
                             Clients: claude-code | claude-desktop | cursor | vscode.
    install --list           Detect MCP clients on this machine (read-only).
    install --all            Install into every detected client in one shot.

  Inspection:
    doctor                   Diagnose setup: config, token, clients, learning,
                             upgrade, flaky-namespace reliability rollup.
    servers [<filter>]       List servers in your mcp.hosting dashboard; the
                             positional arg substring-filters by namespace.
    bundles [list|match]     Browse curated multi-server bundles. \`list\` shows
                             all; \`match\` partitions against your enabled
                             servers (ready vs. partially installed).

  Maintenance:
    upgrade                  Show (or --run) the command that bumps
                             @yawlabs/mcph to the latest version.
    reset-learning           Clear cross-session learning history
                             (~/.mcph/state.json).
    completion <shell>       Print a shell completion script for bash, zsh,
                             fish, or powershell. Redirect to your
                             completions directory to install.

  Other:
    compliance <target>      Run the 88-test compliance suite against an MCP
                             server. --publish posts the report to
                             mcp.hosting and prints the public URL.
    help, --help, -h         Show this help.
    --version, -V            Print mcph version.

  Running \`mcph\` with no subcommand starts the MCP server (requires a
  resolved token). Most read-only subcommands accept \`--json\` for
  machine-readable output. Run \`mcph <subcommand> --help\` for per-
  subcommand flag details.

  Environment variables:
    MCPH_TOKEN                 API token (overrides every config file).
    MCPH_URL                   API base URL (default https://mcp.hosting).
    MCPH_POLL_INTERVAL         Dashboard polling interval, seconds (default 60).
    MCPH_SERVER_CAP            Max concurrently active servers (default 6).
    MCPH_MIN_COMPLIANCE        Minimum grade to auto-activate (A|B|C|D|F).
    MCPH_AUTO_LOAD             Load all servers at startup, ignoring SERVER_CAP.
    MCPH_PRUNE_RESPONSES       Set to \`0\` to disable response pruning.
    MCPH_DISABLE_PERSISTENCE   Disable cross-session learning state.

  Config resolution (highest precedence first):
    1. MCPH_TOKEN / MCPH_URL env vars
    2. <project>/.mcph/config.local.json   machine-local overrides (gitignore)
    3. <project>/.mcph/config.json         project-shared (checked in)
    4. ~/.mcph/config.json                 user-global default

  Token rotation: mcph reads config at startup. Restart the MCP client
  (or kill mcph; the client will respawn it) after editing any config.

  Docs:   https://mcp.hosting
  Source: https://github.com/YawLabs/mcph

`);
  process.exit(0);
} else if (subcommand === "--version" || subcommand === "-V") {
  // __VERSION__ is substituted at build time by tsup (see tsup.config.ts);
  // when running unbundled from source the declare leaves it as undefined,
  // so guard with typeof and fall back to "dev".
  process.stdout.write(`mcph ${typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev"}\n`);
  process.exit(0);
} else if (subcommand && !subcommand.startsWith("-")) {
  // Bare positional first arg that isn't a known subcommand — almost
  // always a typo. Surface a "did you mean?" instead of falling through
  // to runServer, which would then fail opaquely on the missing token.
  // Flags (anything with a leading `-`) still fall through so server
  // startup can parse them (or ignore unknown ones) as it did before.
  const visible = KNOWN_SUBCOMMANDS.filter((s) => !s.startsWith("-") && s !== "help");
  const suggestions = closestNames(subcommand, visible, 3);
  const hint =
    suggestions.length > 0
      ? ` Did you mean: ${suggestions.join(", ")}?`
      : " Run `mcph --help` for the list of subcommands.";
  process.stderr.write(`mcph: unknown subcommand "${subcommand}".${hint}\n`);
  process.exit(2);
} else {
  runServer();
}

async function runServer(): Promise<void> {
  // Resolve token + apiBase via the unified loader: env > local > global
  // for token, env > local > project > global > default for apiBase.
  // Falls back to defaults silently when nothing is set; missing token
  // is the only fatal so we surface it explicitly below.
  const config = await loadMcphConfig();

  if (!config.token) {
    process.stderr.write(
      "\n  mcph: no token resolved.\n\n" +
        "  Quick start (recommended):\n" +
        "    mcph install <claude-code|claude-desktop|cursor|vscode> --token mcp_pat_…\n" +
        "    Creates ~/.mcph/config.json so every MCP client picks up the token automatically.\n\n" +
        "  Or set MCPH_TOKEN in your MCP client config:\n\n" +
        "     {\n" +
        '       "mcpServers": {\n' +
        '         "mcp.hosting": {\n' +
        '           "command": "npx",\n' +
        '           "args": ["-y", "@yawlabs/mcph"],\n' +
        '           "env": {\n' +
        '             "MCPH_TOKEN": "mcp_pat_your_token_here"\n' +
        "           }\n" +
        "         }\n" +
        "       }\n" +
        "     }\n\n" +
        "  Get a token at https://mcp.hosting → Settings → API Tokens, or run\n" +
        "  `mcph doctor` to see exactly where mcph looked.\n\n",
    );
    process.exit(1);
  }

  // Surface non-fatal config warnings on startup so the user sees them
  // (e.g., loose file perms, schema-version mismatch). Doctor shows the
  // full picture; this is just a heads-up.
  for (const w of config.warnings) {
    log("warn", "Config warning", { warning: w });
  }

  log("info", "mcph startup", {
    apiBase: config.apiBase,
    apiBaseSource: config.apiBaseSource,
    tokenSource: config.tokenSource,
    tokenFingerprint: tokenFingerprint(config.token),
  });

  const server = new ConnectServer(config.apiBase, config.token);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    if (forceExit.unref) forceExit.unref();
    await server.shutdown();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.start().catch((err: unknown) => {
    if (err instanceof ConfigError && err.fatal) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\n  mcph: ${msg}\n\n`);
      process.exit(1);
    }
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "Fatal startup error", { error: msg });
    process.exit(1);
  });
}
