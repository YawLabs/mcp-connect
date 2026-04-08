import { ConfigError } from "./config.js";
import { log } from "./logger.js";
import { ConnectServer } from "./server.js";

const token = process.env.MCP_HOSTING_TOKEN;
const apiUrl = process.env.MCP_HOSTING_URL ?? "https://mcp.hosting";

if (!token) {
  process.stderr.write(
    "\n  mcp-connect: MCP_HOSTING_TOKEN is required.\n\n" +
      "  1. Create a token at https://mcp.hosting → Settings → API Tokens\n" +
      "  2. Add it to your MCP client config:\n\n" +
      "     {\n" +
      '       "mcpServers": {\n' +
      '         "mcp-connect": {\n' +
      '           "command": "npx",\n' +
      '           "args": ["@yawlabs/mcp-connect"],\n' +
      '           "env": {\n' +
      '             "MCP_HOSTING_TOKEN": "mcp_pat_your_token_here"\n' +
      "           }\n" +
      "         }\n" +
      "       }\n" +
      "     }\n\n",
  );
  process.exit(1);
}

const server = new ConnectServer(apiUrl, token);

// Graceful shutdown
const shutdown = async () => {
  await server.shutdown();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.start().catch((err) => {
  if (err instanceof ConfigError && err.fatal) {
    process.stderr.write("\n  mcp-connect: " + err.message + "\n\n");
    process.exit(1);
  }

  log("error", "Fatal startup error", { error: err.message });
  process.exit(1);
});
