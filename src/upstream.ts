import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "./logger.js";
import type {
  UpstreamConnection,
  UpstreamPromptDef,
  UpstreamResourceDef,
  UpstreamServerConfig,
  UpstreamToolDef,
} from "./types.js";

declare const __VERSION__: string;

const CONNECT_TIMEOUT = (() => {
  const env = process.env.MCP_CONNECT_TIMEOUT;
  if (!env) return 15_000;
  const n = Number.parseInt(env, 10);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
})();

export async function connectToUpstream(
  config: UpstreamServerConfig,
  onDisconnect?: (namespace: string) => void,
  onListChanged?: (namespace: string) => void,
): Promise<UpstreamConnection> {
  const client = new Client(
    { name: "mcp-connect", version: typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0" },
    { capabilities: {} },
  );

  let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

  if (config.type === "local") {
    if (!config.command) {
      throw new Error("command is required for local servers");
    }

    const { MCP_HOSTING_TOKEN: _excluded, ...parentEnv } = process.env;
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...parentEnv, ...config.env } as Record<string, string>,
      stderr: "ignore",
    });
  } else {
    if (!config.url) {
      throw new Error("url is required for remote servers");
    }

    const url = new URL(config.url);
    if (config.transport === "sse") {
      transport = new SSEClientTransport(url);
    } else {
      transport = new StreamableHTTPClientTransport(url);
    }
  }

  // Connect with timeout — clear timer on success, close client on timeout
  const hint =
    config.type === "local"
      ? ` Verify that '${config.command}' is installed and the server starts within ${CONNECT_TIMEOUT / 1000} seconds.`
      : ` Verify that ${config.url} is reachable.`;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Connection timeout after ${CONNECT_TIMEOUT}ms.${hint}`)),
      CONNECT_TIMEOUT,
    );
  });
  try {
    await Promise.race([client.connect(transport), timeoutPromise]);
    clearTimeout(timer);
  } catch (err) {
    clearTimeout(timer);
    try {
      await client.close();
    } catch {}
    throw err;
  }

  log("info", "Connected to upstream", { name: config.name, namespace: config.namespace, type: config.type });

  // Fetch tools, resources, prompts — clean up client on failure
  try {
    const connection: UpstreamConnection = { status: "disconnected" } as UpstreamConnection;

    // Detect unexpected disconnects
    client.onclose = () => {
      if (connection.status === "connected") {
        connection.status = "error";
        connection.error = "Upstream disconnected unexpectedly";
        log("warn", "Upstream disconnected unexpectedly", { namespace: config.namespace });
        if (onDisconnect) onDisconnect(config.namespace);
      }
    };

    const tools = await fetchToolsFromUpstream(client, config.namespace);
    const resources = await fetchResourcesFromUpstream(client, config.namespace);
    const prompts = await fetchPromptsFromUpstream(client, config.namespace);

    // Populate the connection object (referenced by onclose handler above)
    Object.assign(connection, {
      config,
      client,
      transport,
      tools,
      resources,
      prompts,
      health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0 },
      status: "connected" as const,
    });

    // Subscribe to upstream list changes so we pick up dynamic tools/resources/prompts
    if (onListChanged) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        try {
          connection.tools = await fetchToolsFromUpstream(client, config.namespace);
          onListChanged(config.namespace);
        } catch (err: any) {
          log("warn", "Failed to refresh tools from upstream", { namespace: config.namespace, error: err.message });
        }
      });
      client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        try {
          connection.resources = await fetchResourcesFromUpstream(client, config.namespace);
          onListChanged(config.namespace);
        } catch (err: any) {
          log("warn", "Failed to refresh resources from upstream", { namespace: config.namespace, error: err.message });
        }
      });
      client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
        try {
          connection.prompts = await fetchPromptsFromUpstream(client, config.namespace);
          onListChanged(config.namespace);
        } catch (err: any) {
          log("warn", "Failed to refresh prompts from upstream", { namespace: config.namespace, error: err.message });
        }
      });
    }

    return connection;
  } catch (err) {
    try {
      await client.close();
    } catch {}
    throw err;
  }
}

export async function disconnectFromUpstream(connection: UpstreamConnection): Promise<void> {
  connection.status = "disconnected";
  try {
    await connection.client.close();
  } catch (err: any) {
    log("warn", "Error disconnecting from upstream", {
      namespace: connection.config.namespace,
      error: err.message,
    });
  }
  log("info", "Disconnected from upstream", { namespace: connection.config.namespace });
}

export async function fetchResourcesFromUpstream(client: Client, namespace: string): Promise<UpstreamResourceDef[]> {
  try {
    const result = await client.listResources();
    return (result.resources ?? []).map((r) => ({
      uri: r.uri,
      namespacedUri: `connect://${namespace}/${r.uri}`,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  } catch {
    // Server may not support resources — that's fine
    return [];
  }
}

export async function fetchPromptsFromUpstream(client: Client, namespace: string): Promise<UpstreamPromptDef[]> {
  try {
    const result = await client.listPrompts();
    return (result.prompts ?? []).map((p) => ({
      name: p.name,
      namespacedName: `${namespace}_${p.name}`,
      description: p.description,
      arguments: p.arguments as UpstreamPromptDef["arguments"],
    }));
  } catch {
    // Server may not support prompts — that's fine
    return [];
  }
}

export async function fetchToolsFromUpstream(client: Client, namespace: string): Promise<UpstreamToolDef[]> {
  const result = await client.listTools();

  return (result.tools ?? []).map((tool) => ({
    name: tool.name,
    namespacedName: `${namespace}_${tool.name}`,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    annotations: tool.annotations as Record<string, unknown> | undefined,
  }));
}
