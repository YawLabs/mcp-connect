import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ConfigError, fetchConfig } from "./config.js";
import { log } from "./logger.js";
import { META_TOOLS, META_TOOL_NAMES } from "./meta-tools.js";
import { type ToolRoute, buildToolList, buildToolRoutes, routeToolCall } from "./proxy.js";
import type { ConnectConfig, UpstreamConnection, UpstreamServerConfig } from "./types.js";
import { connectToUpstream, disconnectFromUpstream } from "./upstream.js";

const POLL_INTERVAL = 60_000;

export class ConnectServer {
  private server: Server;
  private connections = new Map<string, UpstreamConnection>();
  private config: ConnectConfig | null = null;
  private configVersion: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private toolRoutes = new Map<string, ToolRoute>();
  private idleCallCounts = new Map<string, number>();

  private static readonly IDLE_CALL_THRESHOLD = 10;

  constructor(
    private apiUrl: string,
    private token: string,
  ) {
    this.server = new Server(
      { name: "mcp-connect", version: "0.1.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: buildToolList(this.connections),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return this.handleToolCall(name, args ?? {});
    });
  }

  async start(): Promise<void> {
    // Fetch config — non-fatal errors allow startup with empty config
    try {
      await this.fetchAndApplyConfig();
    } catch (err: any) {
      if (err instanceof ConfigError && err.fatal) {
        throw err;
      }
      log("warn", "Initial config fetch failed, starting with empty config", { error: err.message });
      this.config = { servers: [], configVersion: "" };
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    this.startPolling();

    log("info", "mcp-connect started", {
      apiUrl: this.apiUrl,
      servers: this.config?.servers.length ?? 0,
    });
  }

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    if (name === META_TOOLS.discover.name) {
      return this.handleDiscover();
    }
    if (name === META_TOOLS.activate.name) {
      return this.handleActivate(args.server as string);
    }
    if (name === META_TOOLS.deactivate.name) {
      return this.handleDeactivate(args.server as string);
    }

    // Route to upstream and track usage for auto-deactivate
    const route = this.toolRoutes.get(name);
    const result = await routeToolCall(name, args, this.toolRoutes, this.connections);

    if (route) {
      await this.trackUsageAndAutoDeactivate(route.namespace);
    }

    return result;
  }

  private handleDiscover(): { content: Array<{ type: string; text: string }> } {
    if (!this.config || this.config.servers.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No servers configured. Add servers at mcp.hosting to get started.",
          },
        ],
      };
    }

    const lines: string[] = ["Available MCP servers:\n"];

    for (const server of this.config.servers) {
      if (!server.isActive) continue;

      const connection = this.connections.get(server.namespace);
      const status = connection ? "ACTIVE (" + connection.tools.length + " tools)" : "available";

      lines.push("  " + server.namespace + " — " + server.name + " [" + status + "] (" + server.type + ")");
    }

    const inactive = this.config.servers.filter((s) => !s.isActive);
    if (inactive.length > 0) {
      lines.push("\nDisabled servers:");
      for (const server of inactive) {
        lines.push("  " + server.namespace + " — " + server.name + " (disabled in dashboard)");
      }
    }

    const activeCount = this.connections.size;
    const totalTools = Array.from(this.connections.values()).reduce((sum, c) => sum + c.tools.length, 0);
    lines.push("\n" + activeCount + " active, " + totalTools + " tools loaded.");
    lines.push('Use mcp_connect_activate({ server: "namespace" }) to activate a server.');

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  private async handleActivate(
    namespace: string,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    if (!namespace) {
      return {
        content: [
          { type: "text", text: "server namespace is required. Use mcp_connect_discover to see available servers." },
        ],
        isError: true,
      };
    }

    // Already active?
    const existing = this.connections.get(namespace);
    if (existing && existing.status === "connected") {
      const toolNames = existing.tools.map((t) => t.namespacedName).join(", ");
      return {
        content: [
          {
            type: "text",
            text: 'Server "' + namespace + '" is already active with ' + existing.tools.length + " tools: " + toolNames,
          },
        ],
      };
    }

    // Find in config
    const serverConfig = this.config?.servers.find((s) => s.namespace === namespace && s.isActive);
    if (!serverConfig) {
      return {
        content: [
          {
            type: "text",
            text:
              'Server "' + namespace + '" not found or disabled. Use mcp_connect_discover to see available servers.',
          },
        ],
        isError: true,
      };
    }

    try {
      const connection = await connectToUpstream(serverConfig);
      this.connections.set(namespace, connection);
      this.idleCallCounts.set(namespace, 0);
      this.toolRoutes = buildToolRoutes(this.connections);

      // Notify client that tool list changed
      await this.server.sendToolListChanged();

      const toolNames = connection.tools.map((t) => t.namespacedName).join(", ");
      return {
        content: [
          {
            type: "text",
            text: 'Activated "' + namespace + '" — ' + connection.tools.length + " tools available: " + toolNames,
          },
        ],
      };
    } catch (err: any) {
      log("error", "Failed to activate upstream", { namespace, error: err.message });
      return {
        content: [{ type: "text", text: 'Failed to activate "' + namespace + '": ' + err.message }],
        isError: true,
      };
    }
  }

  private async handleDeactivate(
    namespace: string,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    if (!namespace) {
      return {
        content: [{ type: "text", text: "server namespace is required." }],
        isError: true,
      };
    }

    const connection = this.connections.get(namespace);
    if (!connection) {
      return {
        content: [{ type: "text", text: 'Server "' + namespace + '" is not active.' }],
        isError: true,
      };
    }

    await disconnectFromUpstream(connection);
    this.connections.delete(namespace);
    this.idleCallCounts.delete(namespace);
    this.toolRoutes = buildToolRoutes(this.connections);

    // Notify client that tool list changed
    await this.server.sendToolListChanged();

    return {
      content: [{ type: "text", text: 'Deactivated "' + namespace + '". Tools removed.' }],
    };
  }

  private async trackUsageAndAutoDeactivate(calledNamespace: string): Promise<void> {
    // Reset idle count for the server that was just called
    this.idleCallCounts.set(calledNamespace, 0);

    // Increment idle count for all OTHER active servers
    for (const ns of this.connections.keys()) {
      if (ns !== calledNamespace) {
        this.idleCallCounts.set(ns, (this.idleCallCounts.get(ns) ?? 0) + 1);
      }
    }

    // Auto-deactivate servers that have been idle too long
    const toDeactivate: string[] = [];
    for (const [ns, idleCount] of this.idleCallCounts) {
      if (idleCount >= ConnectServer.IDLE_CALL_THRESHOLD && this.connections.has(ns)) {
        toDeactivate.push(ns);
      }
    }

    for (const ns of toDeactivate) {
      log("info", "Auto-deactivating idle server", { namespace: ns, idleCalls: this.idleCallCounts.get(ns) });
      const connection = this.connections.get(ns);
      if (connection) {
        await disconnectFromUpstream(connection);
        this.connections.delete(ns);
        this.idleCallCounts.delete(ns);
      }
    }

    if (toDeactivate.length > 0) {
      this.toolRoutes = buildToolRoutes(this.connections);
      await this.server.sendToolListChanged();
    }
  }

  private async fetchAndApplyConfig(): Promise<void> {
    const newConfig = await fetchConfig(this.apiUrl, this.token);

    if (newConfig.configVersion === this.configVersion) {
      return; // No changes
    }

    await this.reconcileConfig(newConfig);
    this.config = newConfig;
    this.configVersion = newConfig.configVersion;
  }

  private async reconcileConfig(newConfig: ConnectConfig): Promise<void> {
    const newNamespaces = new Set(newConfig.servers.map((s) => s.namespace));
    let changed = false;

    // Deactivate servers that were removed from config or disabled
    for (const [namespace, connection] of this.connections) {
      const newServerConfig = newConfig.servers.find((s) => s.namespace === namespace);

      if (!newServerConfig || !newServerConfig.isActive) {
        log("info", "Server removed or disabled in config, deactivating", { namespace });
        await disconnectFromUpstream(connection);
        this.connections.delete(namespace);
        changed = true;
        continue;
      }

      // Check if config changed (different command, args, url, etc.)
      const oldConfig = connection.config;
      if (
        oldConfig.command !== newServerConfig.command ||
        JSON.stringify(oldConfig.args) !== JSON.stringify(newServerConfig.args) ||
        oldConfig.url !== newServerConfig.url ||
        JSON.stringify(oldConfig.env) !== JSON.stringify(newServerConfig.env)
      ) {
        log("info", "Server config changed, deactivating stale connection", { namespace });
        await disconnectFromUpstream(connection);
        this.connections.delete(namespace);
        changed = true;
      }
    }

    if (changed) {
      this.toolRoutes = buildToolRoutes(this.connections);
      await this.server.sendToolListChanged();
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      try {
        await this.fetchAndApplyConfig();
      } catch (err: any) {
        log("warn", "Config poll failed", { error: err.message });
      }
    }, POLL_INTERVAL);

    // Don't keep the process alive just for polling
    if (this.pollTimer.unref) {
      this.pollTimer.unref();
    }
  }

  async shutdown(): Promise<void> {
    log("info", "Shutting down mcp-connect");

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Disconnect all upstreams
    const disconnects = Array.from(this.connections.values()).map((conn) => disconnectFromUpstream(conn));
    await Promise.allSettled(disconnects);
    this.connections.clear();

    await this.server.close();

    log("info", "mcp-connect shutdown complete");
  }
}
