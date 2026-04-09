import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { log } from "./logger.js";
import type {
  UpstreamConnection,
  UpstreamPromptDef,
  UpstreamResourceDef,
  UpstreamServerConfig,
  UpstreamToolDef,
} from "./types.js";

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

  // Fetch tools, resources, prompts
  const tools = await fetchToolsFromUpstream(client, config.namespace);
  const resources = await fetchResourcesFromUpstream(client, config.namespace);
  const prompts = await fetchPromptsFromUpstream(client, config.namespace);

  return {
    config,
    client,
    transport,
    tools,
    resources,
    prompts,
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0 },
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

export async function fetchResourcesFromUpstream(client: Client, namespace: string): Promise<UpstreamResourceDef[]> {
  try {
    const result = await client.listResources();
    return (result.resources ?? []).map((r) => ({
      uri: r.uri,
      namespacedUri: "connect://" + namespace + "/" + r.uri,
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
      namespacedName: namespace + "_" + p.name,
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
    namespacedName: namespace + "_" + tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
    annotations: tool.annotations as Record<string, unknown> | undefined,
  }));
}
