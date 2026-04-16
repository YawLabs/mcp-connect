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
import { resolveUvSpawn } from "./uv-bootstrap.js";

declare const __VERSION__: string;

const CONNECT_TIMEOUT = (() => {
  const env = process.env.MCP_CONNECT_TIMEOUT;
  if (!env) return 15_000;
  const n = Number.parseInt(env, 10);
  return Number.isFinite(n) && n > 0 ? n : 15_000;
})();

// Cap captured stderr so a chatty server can't balloon mcph's memory.
// 8KB tail is plenty to see the last error message — servers that emit
// multi-megabyte output to stderr before crashing are doing something
// pathological anyway.
const STDERR_RING_CAP = 8 * 1024;

// Error categories surfaced to the caller. The dispatch/activate handlers
// use these to compose actionable messages rather than leaking raw SDK
// error strings.
export type ActivationFailureCategory =
  | "spawn_failure" // command not found / ENOENT
  | "install_failure" // process spawned but exited non-zero before handshake
  | "init_timeout" // process running but didn't complete init within CONNECT_TIMEOUT
  | "protocol_error" // handshake completed but something downstream failed
  | "unknown";

export class ActivationError extends Error {
  constructor(
    message: string,
    public readonly category: ActivationFailureCategory,
    public readonly stderrTail?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ActivationError";
  }
}

function categorizeSpawnError(err: unknown): ActivationFailureCategory {
  const msg = err instanceof Error ? err.message : String(err);
  // Node's child_process surfaces ENOENT as the most common spawn failure —
  // binary isn't on PATH. Other codes (EACCES, EPERM) are rare enough to
  // bucket under spawn_failure too.
  if (/ENOENT|not found|cannot find|command failed to start/i.test(msg)) return "spawn_failure";
  if (/EACCES|permission denied/i.test(msg)) return "spawn_failure";
  return "unknown";
}

export async function connectToUpstream(
  config: UpstreamServerConfig,
  onDisconnect?: (namespace: string) => void,
  onListChanged?: (namespace: string) => void,
): Promise<UpstreamConnection> {
  const client = new Client(
    { name: "mcph", version: typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0" },
    { capabilities: {} },
  );

  let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  // Rolling 8KB tail of the child's stderr — captured so activation
  // errors can surface the actual failure reason ("GITHUB_TOKEN is
  // required", "npm ERR! 404") instead of a generic "handshake timed
  // out". Only populated for local/stdio transports.
  let stderrRing = "";

  if (config.type === "local") {
    if (!config.command) {
      throw new Error("command is required for local servers");
    }

    const { MCPH_TOKEN: _excluded, ...parentEnv } = process.env;
    // Rewrite `uv`/`uvx` to our managed binary when the user doesn't
    // have one on PATH. No-op for every other command. Any failure
    // here (unsupported platform, download/checksum failure) bubbles
    // out and is caught by the ActivationError handler below — the
    // stderr tail will be empty, so we fall through to the
    // categorizeSpawnError path with the actual error message.
    const resolved = await resolveUvSpawn(config.command, config.args ?? []);
    const stdioTransport = new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: { ...parentEnv, ...config.env } as Record<string, string>,
      stderr: "pipe",
    });
    // Attach the stderr listener *before* the transport is started so we
    // never lose the earliest output (install errors, missing-env errors,
    // etc. that get written before the server crashes on init).
    stdioTransport.stderr?.on("data", (chunk: Buffer) => {
      stderrRing = (stderrRing + chunk.toString("utf8")).slice(-STDERR_RING_CAP);
    });
    transport = stdioTransport;
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

  // Connect with timeout — clear timer on success, close client on timeout.
  // Errors are categorized (spawn/install/timeout/protocol) so the caller
  // can produce an actionable message for the LLM. stderr tail is included
  // when available — it's the part that usually explains the real failure.
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Connection timeout after ${CONNECT_TIMEOUT}ms`));
    }, CONNECT_TIMEOUT);
  });
  try {
    await Promise.race([client.connect(transport), timeoutPromise]);
    clearTimeout(timer);
  } catch (err) {
    clearTimeout(timer);
    try {
      await client.close();
    } catch {}

    // Classify the failure. If the child wrote anything to stderr, we
    // almost certainly have the real reason — install failures from
    // npx/uvx, missing env vars, typo'd package names all surface there.
    const trimmedStderr = stderrRing.trim();
    let category: ActivationFailureCategory;
    let message: string;

    if (config.type !== "local") {
      category = timedOut ? "init_timeout" : "protocol_error";
      message = timedOut
        ? `Remote server at ${config.url} did not respond within ${CONNECT_TIMEOUT / 1000}s. Verify the URL is reachable.`
        : `Remote server at ${config.url} refused the connection.`;
    } else if (timedOut) {
      category = "init_timeout";
      message = `Server "${config.namespace}" started but didn't complete the MCP handshake within ${CONNECT_TIMEOUT / 1000}s.${
        trimmedStderr ? ` stderr tail: ${trimmedStderr.slice(-500)}` : ""
      }`;
    } else if (trimmedStderr.length > 0) {
      // Non-timeout error with stderr → the child likely exited before
      // the handshake (install failure, missing env var, bad args).
      category = "install_failure";
      message = `Server "${config.namespace}" failed to start. stderr: ${trimmedStderr.slice(-500)}`;
    } else {
      category = categorizeSpawnError(err);
      if (category === "spawn_failure") {
        message = `Command '${config.command}' is not on PATH or is not executable. Verify the runtime is installed (e.g. Node.js for npx, Python for uvx).`;
      } else {
        message = err instanceof Error ? err.message : String(err);
      }
    }

    // Append a deep-link to the dashboard so the LLM can render a
    // clickable "fix this here" pointer rather than a generic "edit
    // your server config." The dashboard reads the #server-<id> hash
    // on mount and scrolls to + highlights the matching card.
    if (config.id) {
      message = `${message} → Edit at https://mcp.hosting/dashboard/connect#server-${config.id}`;
    }

    throw new ActivationError(message, category, trimmedStderr || undefined, err);
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
