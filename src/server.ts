import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { request } from "undici";
import { initAnalytics, recordConnectEvent, shutdownAnalytics } from "./analytics.js";
import { ConfigError, fetchConfig } from "./config.js";
import { log } from "./logger.js";
import { META_TOOLS, META_TOOL_NAMES } from "./meta-tools.js";
import {
  type PromptRoute,
  type ResourceRoute,
  type ToolRoute,
  buildPromptList,
  buildPromptRoutes,
  buildResourceList,
  buildResourceRoutes,
  buildToolList,
  buildToolRoutes,
  routePromptGet,
  routeResourceRead,
  routeToolCall,
} from "./proxy.js";
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
  private resourceRoutes = new Map<string, ResourceRoute>();
  private promptRoutes = new Map<string, PromptRoute>();
  private idleCallCounts = new Map<string, number>();

  private static readonly IDLE_CALL_THRESHOLD = 10;

  constructor(
    private apiUrl: string,
    private token: string,
  ) {
    this.server = new Server(
      { name: "mcp-connect", version: "0.2.0" },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: { listChanged: true },
        },
      },
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

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: buildResourceList(this.connections),
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return routeResourceRead(request.params.uri, this.resourceRoutes, this.connections);
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: buildPromptList(this.connections),
    }));

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return routePromptGet(
        request.params.name,
        request.params.arguments as Record<string, string> | undefined,
        this.promptRoutes,
        this.connections,
      );
    });
  }

  private handleUpstreamDisconnect(namespace: string): void {
    log("warn", "Upstream disconnect detected, will auto-reconnect on next use", { namespace });
  }

  private rebuildRoutes(): void {
    this.toolRoutes = buildToolRoutes(this.connections);
    this.resourceRoutes = buildResourceRoutes(this.connections);
    this.promptRoutes = buildPromptRoutes(this.connections);
  }

  private async notifyAllListsChanged(): Promise<void> {
    await this.server.sendToolListChanged();
    await this.server.sendResourceListChanged().catch(() => {});
    await this.server.sendPromptListChanged().catch(() => {});
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

    initAnalytics(this.apiUrl, this.token);

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
      recordConnectEvent({ namespace: null, toolName: null, action: "discover", latencyMs: null, success: true });
      return this.handleDiscover();
    }
    if (name === META_TOOLS.activate.name) {
      const result = await this.handleActivate(args.server as string);
      recordConnectEvent({
        namespace: (args.server as string) || null,
        toolName: null,
        action: "activate",
        latencyMs: null,
        success: !result.isError,
      });
      return result;
    }
    if (name === META_TOOLS.deactivate.name) {
      const result = await this.handleDeactivate(args.server as string);
      recordConnectEvent({
        namespace: (args.server as string) || null,
        toolName: null,
        action: "deactivate",
        latencyMs: null,
        success: !result.isError,
      });
      return result;
    }
    if (name === META_TOOLS.import_config.name) {
      return this.handleImport(args.filepath as string);
    }
    if (name === META_TOOLS.health.name) {
      return this.handleHealth();
    }

    // Route to upstream — auto-reconnect if disconnected
    const route = this.toolRoutes.get(name);
    if (route) {
      const conn = this.connections.get(route.namespace);
      if (conn && conn.status === "error") {
        const serverConfig = this.config?.servers.find((s) => s.namespace === route.namespace);
        if (serverConfig) {
          try {
            await disconnectFromUpstream(conn);
            const newConn = await connectToUpstream(serverConfig, (ns) => this.handleUpstreamDisconnect(ns));
            this.connections.set(route.namespace, newConn);
            this.rebuildRoutes();
            log("info", "Auto-reconnected to upstream", { namespace: route.namespace });
          } catch (err: any) {
            log("error", "Auto-reconnect failed", { namespace: route.namespace, error: err.message });
            return {
              content: [
                {
                  type: "text",
                  text:
                    'Server "' +
                    route.namespace +
                    '" disconnected and auto-reconnect failed: ' +
                    err.message +
                    '. Try mcp_connect_activate("' +
                    route.namespace +
                    '") to manually reconnect.',
                },
              ],
              isError: true,
            };
          }
        }
      }
    }

    const startMs = Date.now();
    const result = await routeToolCall(name, args, this.toolRoutes, this.connections);
    const latencyMs = Date.now() - startMs;

    if (route) {
      // Track health stats
      const conn = this.connections.get(route.namespace);
      if (conn) {
        conn.health.totalCalls++;
        conn.health.totalLatencyMs += latencyMs;
        if (result.isError) {
          conn.health.errorCount++;
          conn.health.lastErrorMessage = result.content[0]?.text;
          conn.health.lastErrorAt = new Date().toISOString();
        }
      }

      recordConnectEvent({
        namespace: route.namespace,
        toolName: route.originalName,
        action: "tool_call",
        latencyMs,
        success: !result.isError,
        error: result.isError ? result.content[0]?.text : undefined,
      });
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
      const status = connection
        ? connection.status === "error"
          ? "ERROR (disconnected, will auto-reconnect on use)"
          : "ACTIVE (" + connection.tools.length + " tools)"
        : "available";

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
      const connection = await connectToUpstream(serverConfig, (ns) => this.handleUpstreamDisconnect(ns));
      this.connections.set(namespace, connection);
      this.idleCallCounts.set(namespace, 0);
      this.rebuildRoutes();
      await this.notifyAllListsChanged();

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
    this.rebuildRoutes();
    await this.notifyAllListsChanged();

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
      this.rebuildRoutes();
      await this.notifyAllListsChanged();
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
      this.rebuildRoutes();
      await this.notifyAllListsChanged();
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

  private async handleImport(
    filepath: string,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    if (!filepath) {
      return { content: [{ type: "text", text: "filepath is required." }], isError: true };
    }

    try {
      const resolved = filepath.startsWith("~") ? resolve(homedir(), filepath.slice(2)) : resolve(filepath);
      const raw = await readFile(resolved, "utf-8");
      const parsed = JSON.parse(raw);

      // Support multiple config formats
      const mcpServers: Record<string, any> = parsed.mcpServers || parsed;

      if (typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
        return { content: [{ type: "text", text: "No mcpServers object found in " + resolved }], isError: true };
      }

      const servers: Array<{
        name: string;
        namespace: string;
        type: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
      }> = [];

      for (const [key, value] of Object.entries(mcpServers)) {
        if (!value || typeof value !== "object") continue;
        // Skip ourselves
        if (key === "mcp-connect") continue;

        const namespace = key
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "_")
          .replace(/^_+|_+$/g, "")
          .slice(0, 30);
        if (!namespace) continue;

        const entry: (typeof servers)[0] = {
          name: key,
          namespace,
          type: (value as any).url ? "remote" : "local",
        };

        if ((value as any).command) entry.command = (value as any).command;
        if ((value as any).args) entry.args = (value as any).args;
        if ((value as any).env) entry.env = (value as any).env;
        if ((value as any).url) entry.url = (value as any).url;

        servers.push(entry);
      }

      if (servers.length === 0) {
        return { content: [{ type: "text", text: "No servers found in " + resolved }], isError: true };
      }

      // POST to the bulk import endpoint
      const res = await request(this.apiUrl.replace(/\/$/, "") + "/api/connect/import", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ servers }),
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
      });

      const body = (await res.body.json()) as any;

      if (res.statusCode >= 400) {
        return {
          content: [{ type: "text", text: "Import failed: " + (body.error || "HTTP " + res.statusCode) }],
          isError: true,
        };
      }

      // Refresh config to pick up imported servers
      await this.fetchAndApplyConfig().catch(() => {});

      return {
        content: [
          {
            type: "text",
            text:
              "Imported " +
              (body.imported || 0) +
              " servers" +
              (body.skipped ? ", " + body.skipped + " skipped (already exist)" : "") +
              " from " +
              resolved +
              ". Use mcp_connect_discover to see them.",
          },
        ],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: "Import error: " + err.message }], isError: true };
    }
  }

  private handleHealth(): { content: Array<{ type: string; text: string }> } {
    if (this.connections.size === 0) {
      return { content: [{ type: "text", text: "No active connections." }] };
    }

    const lines: string[] = ["Connection health:\n"];

    for (const [namespace, conn] of this.connections) {
      const h = conn.health;
      const avgLatency = h.totalCalls > 0 ? Math.round(h.totalLatencyMs / h.totalCalls) : 0;
      const errorRate = h.totalCalls > 0 ? Math.round((h.errorCount / h.totalCalls) * 100) : 0;

      lines.push("  " + namespace + " [" + conn.status + "]");
      lines.push("    calls: " + h.totalCalls + ", errors: " + h.errorCount + " (" + errorRate + "%)");
      lines.push("    avg latency: " + avgLatency + "ms");
      if (h.lastErrorMessage) {
        lines.push("    last error: " + h.lastErrorMessage + " at " + h.lastErrorAt);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  async shutdown(): Promise<void> {
    log("info", "Shutting down mcp-connect");

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    await shutdownAnalytics();

    // Disconnect all upstreams
    const disconnects = Array.from(this.connections.values()).map((conn) => disconnectFromUpstream(conn));
    await Promise.allSettled(disconnects);
    this.connections.clear();

    await this.server.close();

    log("info", "mcp-connect shutdown complete");
  }
}
