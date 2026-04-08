import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { log } from "./logger.js";
import type { UpstreamConnection, UpstreamServerConfig, UpstreamToolDef } from "./types.js";

const CONNECT_TIMEOUT = 15_000;

export async function connectToUpstream(config: UpstreamServerConfig): Promise<UpstreamConnection> {
  const client = new Client({ name: "mcp-connect", version: "0.1.0" }, { capabilities: {} });

  let transport: StdioClientTransport | StreamableHTTPClientTransport;

  if (config.type === "local") {
    if (!config.command) {
      throw new Error("command is required for local servers");
    }

    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...config.env } as Record<string, string>,
      stderr: "pipe",
    });
  } else {
    if (!config.url) {
      throw new Error("url is required for remote servers");
    }

    transport = new StreamableHTTPClientTransport(new URL(config.url));
  }

  // Connect with timeout
  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Connection timeout after " + CONNECT_TIMEOUT + "ms")), CONNECT_TIMEOUT),
  );

  await Promise.race([connectPromise, timeoutPromise]);

  log("info", "Connected to upstream", { name: config.name, namespace: config.namespace, type: config.type });

  // Fetch tools
  const tools = await fetchToolsFromUpstream(client, config.namespace);

  return {
    config,
    client,
    transport,
    tools,
    status: "connected",
  };
}

export async function disconnectFromUpstream(connection: UpstreamConnection): Promise<void> {
  try {
    await connection.client.close();
  } catch (err: any) {
    log("warn", "Error disconnecting from upstream", {
      namespace: connection.config.namespace,
      error: err.message,
    });
  }
  connection.status = "disconnected";
  log("info", "Disconnected from upstream", { namespace: connection.config.namespace });
}

export async function fetchToolsFromUpstream(client: Client, namespace: string): Promise<UpstreamToolDef[]> {
  const result = await client.listTools();

  return (result.tools ?? []).map((tool) => ({
    name: tool.name,
    namespacedName: namespace + "_" + tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    annotations: tool.annotations as Record<string, unknown> | undefined,
  }));
}
