import { runComplianceCommand } from "./compliance-cmd.js";
import { loadMcphConfig, tokenFingerprint } from "./config-loader.js";
import { ConfigError } from "./config.js";
import { runDoctor } from "./doctor-cmd.js";
import { INSTALL_USAGE, parseInstallArgs, runInstall } from "./install-cmd.js";
import { log } from "./logger.js";
import { ConnectServer } from "./server.js";

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
  runDoctor().then((r) => process.exit(r.exitCode));
} else if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
  const installBlock = `    ${INSTALL_USAGE.replace(/^Usage: /, "").replace(/\n/g, "\n    ")}`;
  process.stdout.write(
    `\n  mcph — MCP server orchestrator for mcp.hosting\n\n  Usage:\n    mcph                              Run as MCP server (requires a token)\n    mcph install <client> [flags]     Auto-edit an MCP client's config to launch mcph\n    mcph doctor                       Print loaded config + detected clients (support diagnostic)\n    mcph compliance <target> [flags]  Run the compliance suite against an MCP server\n    mcph --version                    Print version\n\n  Install:\n${installBlock}\n\n  Compliance flags:\n    --publish   Publish the report to mcp.hosting and print the URL\n\n  Token resolution (highest first):\n    1. MCPH_TOKEN env var\n    2. <project>/.mcph/config.local.json  (machine-local override; gitignore)\n    3. ~/.mcph/config.json                (user-global default)\n\n  Token rotation: mcph reads its config at startup. Restart the MCP\n  client (or kill mcph; the client will respawn it) after editing.\n\n`,
  );
  process.exit(0);
} else if (subcommand === "--version" || subcommand === "-V") {
  // Version string is replaced at build time by tsup's define; falls back
  // to "dev" when running from source.
  process.stdout.write(`mcph ${process.env.npm_package_version ?? "dev"}\n`);
  process.exit(0);
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
