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
import { type RankableServer, rankServers, scoreRelevance } from "./relevance.js";
import { initRerank, rerank } from "./rerank.js";
import { initRuntimeDetect, reportRuntimes } from "./runtime-detect.js";
import { initTestRunner, startTestRunner, stopTestRunner } from "./test-runner.js";
import { initToolReport, reportTools } from "./tool-report.js";
import type { ConnectConfig, UpstreamConnection, UpstreamServerConfig } from "./types.js";
import { ActivationError, connectToUpstream, disconnectFromUpstream } from "./upstream.js";
import { ensureUv } from "./uv-bootstrap.js";

declare const __VERSION__: string;

// Poll interval for fetching config from mcp.hosting (milliseconds).
//
// Resolution order:
//   1. MCPH_POLL_INTERVAL env var (integer seconds). 0 disables polling
//      entirely — config is fetched once at startup and never again; users
//      must restart their MCP client to pick up dashboard changes.
//   2. Default: 60 seconds. Matches the server-side `Cache-Control:
//      private, max-age=60` on /api/connect/config, so each poll either
//      hits the ETag short-circuit (304) or returns a body once per
//      minute.
//
// Users who want a quieter client set e.g. MCPH_POLL_INTERVAL=300 (5min)
// or MCPH_POLL_INTERVAL=0 (one-shot at startup only).
const DEFAULT_POLL_INTERVAL_MS = 60_000;

function resolvePollIntervalMs(): number {
  const raw = process.env.MCPH_POLL_INTERVAL;
  if (raw === undefined || raw === "") return DEFAULT_POLL_INTERVAL_MS;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds < 0) {
    log("warn", "Invalid MCPH_POLL_INTERVAL; falling back to 60s default", { value: raw });
    return DEFAULT_POLL_INTERVAL_MS;
  }
  return seconds * 1000;
}

function resolveNamespaces(args: Record<string, unknown>): string[] {
  if (Array.isArray(args.servers) && args.servers.length > 0) {
    return args.servers as string[];
  }
  if (typeof args.server === "string" && args.server) {
    return [args.server];
  }
  return [];
}

function envEqual(a?: Record<string, string>, b?: Record<string, string>): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => a[k] === b[k]);
}

function argsEqual(a?: string[], b?: string[]): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export class ConnectServer {
  private server: Server;
  private connections = new Map<string, UpstreamConnection>();
  private config: ConnectConfig | null = null;
  private configVersion: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private toolRoutes = new Map<string, ToolRoute>();
  private resourceRoutes = new Map<string, ResourceRoute>();
  private promptRoutes = new Map<string, PromptRoute>();
  private idleCallCounts = new Map<string, number>();
  private toolCache = new Map<string, Array<{ name: string; description?: string }>>();

  private static readonly IDLE_CALL_THRESHOLD = (() => {
    const env = process.env.MCP_CONNECT_IDLE_THRESHOLD;
    if (!env) return 10;
    const n = Number.parseInt(env, 10);
    return Number.isFinite(n) && n >= 1 ? n : 10;
  })();

  constructor(
    private apiUrl: string,
    private token: string,
  ) {
    this.server = new Server(
      { name: "mcph", version: typeof __VERSION__ !== "undefined" ? __VERSION__ : "0.0.0" },
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

  private readonly onUpstreamDisconnect = (ns: string) => {
    log("warn", "Upstream disconnected, will auto-reconnect on next use", { namespace: ns });
  };

  private readonly onUpstreamListChanged = (ns: string) => {
    log("info", "Upstream list changed, rebuilding routes", { namespace: ns });
    this.rebuildRoutes();
    this.notifyAllListsChanged().catch(() => {});
  };

  private rebuildRoutes(): void {
    this.toolRoutes = buildToolRoutes(this.connections);
    this.resourceRoutes = buildResourceRoutes(this.connections);
    this.promptRoutes = buildPromptRoutes(this.connections);
  }

  private async notifyAllListsChanged(): Promise<void> {
    await this.server.sendToolListChanged().catch(() => {});
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
    initToolReport(this.apiUrl, this.token);
    initRerank(this.apiUrl, this.token);
    initRuntimeDetect(this.apiUrl, this.token);
    initTestRunner(this.apiUrl, this.token, () => this.config);
    // Background runtime probe — fire-and-forget, the dashboard just
    // ignores stale snapshots. Subsequent reports happen on each new
    // mcph startup, which is sufficient for "what runtimes are
    // installed" since it changes rarely.
    reportRuntimes().catch(() => {});
    // Prewarm the uv bootstrap if any configured server needs it. Fire
    // and forget — ensureUv() is memoized, so the first activation
    // awaits the same in-flight promise rather than triggering a
    // second download. This moves the 2–10s first-run cost off the
    // activation path (where it could collide with CONNECT_TIMEOUT)
    // and onto startup, where it's expected.
    if (this.config?.servers.some((s) => s.command === "uv" || s.command === "uvx")) {
      ensureUv().catch((err: Error) => log("warn", "uv prewarm failed", { error: err?.message }));
    }
    startTestRunner();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    this.startPolling();

    log("info", "mcph started", {
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
      // When the LLM supplies task context, automatically warm the top
      // confident candidate so a one-shot discover() is enough to start
      // calling tools. Ambiguous queries fall through to the manual list.
      return this.handleDiscoverWithAutoWarm(args.context as string | undefined);
    }
    if (name === META_TOOLS.dispatch.name) {
      const intent = typeof args.intent === "string" ? args.intent : "";
      const budget = typeof args.budget === "number" && Number.isFinite(args.budget) ? args.budget : 1;
      recordConnectEvent({ namespace: null, toolName: null, action: "activate", latencyMs: null, success: true });
      return this.handleDispatch(intent, budget);
    }
    if (name === META_TOOLS.activate.name) {
      const namespaces = resolveNamespaces(args);
      const result = await this.handleActivate(namespaces);
      for (const ns of namespaces) {
        recordConnectEvent({
          namespace: ns,
          toolName: null,
          action: "activate",
          latencyMs: null,
          success: !result.isError,
        });
      }
      return result;
    }
    if (name === META_TOOLS.deactivate.name) {
      const namespaces = resolveNamespaces(args);
      const result = await this.handleDeactivate(namespaces);
      for (const ns of namespaces) {
        recordConnectEvent({
          namespace: ns,
          toolName: null,
          action: "deactivate",
          latencyMs: null,
          success: !result.isError,
        });
      }
      return result;
    }
    if (name === META_TOOLS.import_config.name) {
      const result = await this.handleImport(args.filepath as string);
      recordConnectEvent({
        namespace: null,
        toolName: null,
        action: "import",
        latencyMs: null,
        success: !result.isError,
      });
      return result;
    }
    if (name === META_TOOLS.health.name) {
      recordConnectEvent({ namespace: null, toolName: null, action: "health", latencyMs: null, success: true });
      return this.handleHealth();
    }

    // Route to upstream — auto-reconnect if disconnected
    const route = this.toolRoutes.get(name);
    if (route) {
      const conn = this.connections.get(route.namespace);
      if (conn && conn.status === "error") {
        const serverConfig = this.config?.servers.find((s) => s.namespace === route.namespace);
        if (serverConfig) {
          let reconnected = false;
          let lastErr: any;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await disconnectFromUpstream(conn);
              const newConn = await connectToUpstream(
                serverConfig,
                this.onUpstreamDisconnect,
                this.onUpstreamListChanged,
              );
              this.connections.set(route.namespace, newConn);
              this.rebuildRoutes();
              await this.notifyAllListsChanged();
              log("info", "Auto-reconnected to upstream", { namespace: route.namespace });
              reconnected = true;
              break;
            } catch (err: any) {
              lastErr = err;
              if (attempt === 0) {
                log("warn", "Auto-reconnect attempt failed, retrying", {
                  namespace: route.namespace,
                  error: err.message,
                });
                await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
              }
            }
          }
          if (!reconnected) {
            conn.status = "error";
            log("error", "Auto-reconnect failed", { namespace: route.namespace, error: lastErr.message });
            return {
              content: [
                {
                  type: "text",
                  text: `Server "${route.namespace}" disconnected and auto-reconnect failed: ${lastErr.message}. Use mcp_connect_activate with server "${route.namespace}" to manually reconnect.`,
                },
              ],
              isError: true,
            };
          }
        }
      }
    }

    // Capture connection ref before the await to avoid race with config reconciliation
    const connForHealth = route ? this.connections.get(route.namespace) : undefined;

    const startMs = Date.now();
    const result = await routeToolCall(name, args, this.toolRoutes, this.connections);
    const latencyMs = Date.now() - startMs;

    if (route) {
      if (connForHealth) {
        connForHealth.health.totalCalls++;
        connForHealth.health.totalLatencyMs += latencyMs;
        if (result.isError) {
          connForHealth.health.errorCount++;
          connForHealth.health.lastErrorMessage = result.content[0]?.text;
          connForHealth.health.lastErrorAt = new Date().toISOString();
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

  // Build RankableServer inputs for BM25 — uses live tool metadata when
  // the server is connected in this session, otherwise falls back to the
  // in-memory toolCache (populated from prior activations this session)
  // and finally the persistent toolCache shipped in the config payload.
  private rankableFor(server: UpstreamServerConfig): RankableServer {
    const connection = this.connections.get(server.namespace);
    const liveTools = connection?.tools.map((t) => ({ name: t.name, description: t.description }));
    const sessionCache = this.toolCache.get(server.namespace);
    const persistedCache = server.toolCache;
    return {
      namespace: server.namespace,
      name: server.name,
      description: server.description,
      tools: liveTools ?? sessionCache ?? persistedCache ?? [],
    };
  }

  // BM25 first-stage cap — wider than the budget so the semantic rerank
  // has room to promote a server that BM25 missed on lexical grounds.
  // 25 is comfortably under the /api/connect/rerank candidate cap (50)
  // while leaving real reordering room.
  private static readonly BM25_TOP_K = 25;

  // Two-stage ranking: local BM25 to shortlist candidates, then a call
  // to /api/connect/rerank for semantic reordering. When rerank is
  // unavailable (no Voyage key on the backend, network hiccup, timeout,
  // empty response), fall back silently to the BM25 order — rerank is
  // an optimization, not a requirement.
  private async twoStageRank(
    context: string,
    servers: UpstreamServerConfig[],
  ): Promise<Array<{ namespace: string; score: number }>> {
    const bm25Input = servers.map((s) => this.rankableFor(s));
    const bm25 = rankServers(context, bm25Input);
    if (bm25.length === 0) return [];

    const shortlist = bm25.slice(0, ConnectServer.BM25_TOP_K);
    const idByNamespace = new Map(servers.map((s) => [s.namespace, s.id]));
    const candidateIds = shortlist
      .map((r) => idByNamespace.get(r.namespace))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (candidateIds.length === 0) return shortlist;

    const rerankResults = await rerank(context, candidateIds);
    if (!rerankResults) return shortlist;

    // Map id → namespace so we can reorder the BM25 shortlist by the
    // rerank scores. Any BM25 candidate missing from rerank output
    // (e.g., not yet embedded) falls back to its BM25 score but sorts
    // after reranked winners.
    const namespaceById = new Map(servers.map((s) => [s.id, s.namespace]));
    const rerankScoreByNamespace = new Map<string, number>();
    for (const r of rerankResults) {
      const ns = namespaceById.get(r.id);
      if (ns) rerankScoreByNamespace.set(ns, r.score);
    }

    const reordered: Array<{ namespace: string; score: number; hasRerank: boolean }> = [];
    for (const item of shortlist) {
      const s = rerankScoreByNamespace.get(item.namespace);
      reordered.push({
        namespace: item.namespace,
        score: s ?? item.score,
        hasRerank: s !== undefined,
      });
    }
    reordered.sort((a, b) => {
      // Reranked entries always sort above non-reranked (no mixing
      // comparison between a cosine similarity and a BM25 score).
      if (a.hasRerank !== b.hasRerank) return a.hasRerank ? -1 : 1;
      return b.score - a.score;
    });
    return reordered.map((r) => ({ namespace: r.namespace, score: r.score }));
  }

  // Auto-warm confidence gate — applied to discover(context) so a single
  // clearly-winning server gets activated without the LLM needing to
  // follow up with a separate activate call. Default ON; flip off with
  // MCPH_AUTO_ACTIVATE=0 if it causes surprise.
  private static readonly AUTO_ACTIVATE_ENABLED = (() => {
    const raw = process.env.MCPH_AUTO_ACTIVATE;
    return raw === undefined || raw === "" || raw === "1" || raw.toLowerCase() === "true";
  })();
  // Top score must clear this floor AND the gap over the runner-up must
  // be convincing before we auto-activate. Values tuned by intuition;
  // when we have real usage data we can re-pick them.
  private static readonly AUTO_ACTIVATE_MIN_SCORE = 1.0;
  private static readonly AUTO_ACTIVATE_MARGIN = 1.3;

  private handleDiscover(context?: string): { content: Array<{ type: string; text: string }> } {
    return this.buildDiscoverOutput(context, /* alreadyWarmed */ false);
  }

  private async handleDiscoverWithAutoWarm(
    context?: string,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!context || !ConnectServer.AUTO_ACTIVATE_ENABLED) return this.handleDiscover(context);

    const activeServers = (this.config?.servers ?? []).filter((s) => s.isActive);
    if (activeServers.length === 0) return this.handleDiscover(context);

    const ranked = rankServers(
      context,
      activeServers.map((s) => this.rankableFor(s)),
    );

    // Only auto-warm if one candidate dominates: top score clears the
    // floor and either stands alone or beats the runner-up by the
    // margin. Ambiguous queries fall through to the manual-pick list.
    const top = ranked[0];
    const second = ranked[1];
    const topWinsDecisively =
      top !== undefined &&
      top.score >= ConnectServer.AUTO_ACTIVATE_MIN_SCORE &&
      (second === undefined || top.score / (second.score || 1e-6) >= ConnectServer.AUTO_ACTIVATE_MARGIN);

    if (!topWinsDecisively || !top) return this.handleDiscover(context);

    // Already active — nothing to warm. Surface that fact in the output.
    const existing = this.connections.get(top.namespace);
    if (existing && existing.status === "connected") return this.handleDiscover(context);

    const result = await this.activateOne(top.namespace);
    if (result.ok) {
      log("info", "Auto-warmed top-ranked server on discover", { namespace: top.namespace, score: top.score });
    }

    return this.buildDiscoverOutput(context, result.ok);
  }

  private buildDiscoverOutput(
    context: string | undefined,
    autoWarmed: boolean,
  ): { content: Array<{ type: string; text: string }> } {
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

    const activeServers = this.config.servers.filter((s) => s.isActive);

    // Score and sort using corpus-wide BM25 when context is provided.
    // Servers that don't match any query term simply fall out of the
    // ranked list; we append them at the end so the LLM still sees what's
    // available without them cluttering the top of the list.
    const scores = new Map<string, number>();
    let sorted: typeof activeServers;
    if (context) {
      const ranked = rankServers(
        context,
        activeServers.map((s) => this.rankableFor(s)),
      );
      for (const r of ranked) scores.set(r.namespace, r.score);
      const rankedSet = new Set(ranked.map((r) => r.namespace));
      const rest = activeServers.filter((s) => !rankedSet.has(s.namespace));
      const matched = ranked
        .map((r) => activeServers.find((s) => s.namespace === r.namespace))
        .filter((s): s is UpstreamServerConfig => s !== undefined);
      sorted = [...matched, ...rest];
    } else {
      sorted = activeServers;
    }

    const lines: string[] = [context ? "Servers ranked by relevance:\n" : "Available MCP servers:\n"];
    if (autoWarmed && sorted.length > 0) {
      lines.push(`Auto-activated "${sorted[0].namespace}" — top match for your query.\n`);
    }

    for (const server of sorted) {
      const connection = this.connections.get(server.namespace);
      const status = connection
        ? connection.status === "error"
          ? "ERROR (disconnected, will auto-reconnect on use)"
          : `ACTIVE (${connection.tools.length} tools)`
        : "available";

      const score = scores.get(server.namespace);
      const relevance = score && score > 0 ? ` (relevance: ${score.toFixed(2)})` : "";

      lines.push(`  ${server.namespace} — ${server.name} [${status}] (${server.type})${relevance}`);

      // Show cached tool names for servers that aren't currently connected
      if (!connection) {
        const cached = this.toolCache.get(server.namespace) ?? server.toolCache;
        if (cached && cached.length > 0) {
          const toolNames = cached.map((t) => t.name).join(", ");
          lines.push(`    known tools: ${toolNames}`);
        }
      }
    }

    const inactive = this.config.servers.filter((s) => !s.isActive);
    if (inactive.length > 0) {
      lines.push("\nDisabled servers:");
      for (const server of inactive) {
        lines.push(`  ${server.namespace} — ${server.name} (disabled in dashboard)`);
      }
    }

    const activeCount = this.connections.size;
    const totalTools = Array.from(this.connections.values()).reduce((sum, c) => sum + c.tools.length, 0);
    lines.push(`\n${activeCount} active, ${totalTools} tools loaded.`);
    lines.push(
      context
        ? "Use mcp_connect_dispatch(intent) to activate the best server in one step, or mcp_connect_activate to pick explicitly."
        : "Use mcp_connect_activate to activate a server by its namespace.",
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Activate a single server by namespace. Shared by handleActivate,
  // handleDispatch, and handleDiscoverWithAutoWarm so error handling,
  // retries, caching, and tool-report round-trips live in one place.
  //
  // Returns:
  //   { ok: true, message } — already connected or newly connected
  //   { ok: false, message, isChanged: false } — failed or not in config
  private async activateOne(
    namespace: string,
  ): Promise<{ ok: boolean; message: string; isChanged: boolean; serverId?: string }> {
    const existing = this.connections.get(namespace);
    if (existing && existing.status === "connected") {
      return {
        ok: true,
        isChanged: false,
        message: `"${namespace}" is already active with ${existing.tools.length} tools.`,
        serverId: existing.config.id,
      };
    }

    const serverConfig = this.config?.servers.find((s) => s.namespace === namespace && s.isActive);
    if (!serverConfig) {
      return { ok: false, isChanged: false, message: `"${namespace}" not found or disabled.` };
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const connection = await connectToUpstream(serverConfig, this.onUpstreamDisconnect, this.onUpstreamListChanged);
        this.connections.set(namespace, connection);
        this.idleCallCounts.set(namespace, 0);
        const toolMeta = connection.tools.map((t) => ({ name: t.name, description: t.description }));
        this.toolCache.set(namespace, toolMeta);

        // Persist the tool list so inactive servers can still be ranked
        // on cold starts. Fire-and-forget — failure is non-fatal.
        if (toolMeta.length > 0) {
          reportTools(serverConfig.id, toolMeta).catch(() => {});
        }

        const toolNames = connection.tools.map((t) => t.namespacedName).join(", ");
        return {
          ok: true,
          isChanged: true,
          serverId: serverConfig.id,
          message: `Activated "${namespace}" — ${connection.tools.length} tools: ${toolNames}`,
        };
      } catch (err) {
        lastError = err;
        if (attempt === 0) {
          const msg = err instanceof Error ? err.message : String(err);
          log("warn", "Activation attempt failed, retrying", { namespace, error: msg });
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
    }

    log("error", "Failed to activate upstream", {
      namespace,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });

    // Prefer the ActivationError's message (includes stderr tail + category
    // hint) over the raw SDK error. Falls back cleanly for transport errors.
    const message =
      lastError instanceof ActivationError
        ? `Failed to activate "${namespace}": ${lastError.message}`
        : `Failed to activate "${namespace}": ${lastError instanceof Error ? lastError.message : String(lastError)}`;
    return { ok: false, isChanged: false, message };
  }

  private async handleActivate(
    namespaces: string[],
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    if (namespaces.length === 0) {
      return {
        content: [
          { type: "text", text: "server namespace is required. Use mcp_connect_discover to see available servers." },
        ],
        isError: true,
      };
    }

    const results: string[] = [];
    let anyChanged = false;
    let anyError = false;

    for (const namespace of namespaces) {
      const r = await this.activateOne(namespace);
      results.push(r.message);
      if (r.isChanged) anyChanged = true;
      if (!r.ok) anyError = true;
    }

    if (anyChanged) {
      this.rebuildRoutes();
      await this.notifyAllListsChanged();
    }

    return {
      content: [{ type: "text", text: results.join("\n") }],
      isError: anyError && !anyChanged ? true : undefined,
    };
  }

  // Smart-routing meta-tool. The LLM describes the task in plain English
  // ("create a github issue for this bug"); mcph ranks configured servers
  // with BM25 and activates the top N, then lets the LLM call the now-
  // exposed tools normally. Default budget is 1 because over-activating
  // pollutes the tool list in the LLM's context with noise.
  private async handleDispatch(
    intent: string,
    budget: number,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const trimmed = intent?.trim?.() ?? "";
    if (trimmed.length === 0) {
      return {
        content: [{ type: "text", text: "intent is required. Describe the task you want to accomplish." }],
        isError: true,
      };
    }
    if (!this.config || this.config.servers.length === 0) {
      return {
        content: [{ type: "text", text: "No servers configured. Add servers at mcp.hosting to get started." }],
        isError: true,
      };
    }

    const activeServers = this.config.servers.filter((s) => s.isActive);
    if (activeServers.length === 0) {
      return {
        content: [
          { type: "text", text: "No servers enabled. Enable servers at mcp.hosting or re-run mcp_connect_discover." },
        ],
        isError: true,
      };
    }

    // Two-stage: local BM25 filters to a shortlist, /api/connect/rerank
    // semantically reorders it via Voyage. Falls back to BM25 alone when
    // rerank is off or times out, so dispatch is robust in every mode.
    const ranked = await this.twoStageRank(trimmed, activeServers);

    if (ranked.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No configured server matches "${trimmed}". Use mcp_connect_discover to see what's available, or add a relevant server at mcp.hosting.`,
          },
        ],
        isError: true,
      };
    }

    const safeBudget = Math.max(1, Math.min(10, Math.floor(budget)));
    const winners = ranked.slice(0, safeBudget);

    const results: string[] = [];
    let anyChanged = false;
    let anyError = false;

    for (const winner of winners) {
      const r = await this.activateOne(winner.namespace);
      results.push(`${winner.namespace} (score ${winner.score.toFixed(2)}): ${r.message}`);
      if (r.isChanged) anyChanged = true;
      if (!r.ok) anyError = true;
    }

    if (anyChanged) {
      this.rebuildRoutes();
      await this.notifyAllListsChanged();
    }

    const header = `Dispatched "${trimmed}" — activated top ${winners.length} of ${ranked.length} matching server${ranked.length === 1 ? "" : "s"}.\n`;
    return {
      content: [{ type: "text", text: header + results.join("\n") }],
      isError: anyError && !anyChanged ? true : undefined,
    };
  }

  private async handleDeactivate(
    namespaces: string[],
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    if (namespaces.length === 0) {
      return {
        content: [{ type: "text", text: "server namespace is required." }],
        isError: true,
      };
    }

    const results: string[] = [];
    let anyChanged = false;

    for (const namespace of namespaces) {
      const connection = this.connections.get(namespace);
      if (!connection) {
        results.push(`"${namespace}" is not active.`);
        continue;
      }

      await disconnectFromUpstream(connection);
      this.connections.delete(namespace);
      this.idleCallCounts.delete(namespace);
      anyChanged = true;
      results.push(`Deactivated "${namespace}". Tools removed.`);
    }

    if (anyChanged) {
      this.rebuildRoutes();
      await this.notifyAllListsChanged();
    }

    return {
      content: [{ type: "text", text: results.join("\n") }],
      isError: !anyChanged ? true : undefined,
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
    // Pass the known configVersion so the server can short-circuit with
    // 304 Not Modified when nothing changed — saves DB query, JSON
    // serialization, and response body on the hot 60s poll path.
    const newConfig = await fetchConfig(this.apiUrl, this.token, this.configVersion ?? undefined);

    if (newConfig === null) {
      return; // 304 Not Modified — keep current config
    }

    if (newConfig.configVersion && newConfig.configVersion === this.configVersion) {
      return; // No changes (server didn't return 304 but hash matches)
    }

    // Deduplicate by namespace — keep first occurrence
    const seen = new Set<string>();
    newConfig.servers = newConfig.servers.filter((s) => {
      if (seen.has(s.namespace)) {
        log("warn", "Duplicate namespace in config, skipping", { namespace: s.namespace });
        return false;
      }
      seen.add(s.namespace);
      return true;
    });

    await this.reconcileConfig(newConfig);
    this.config = newConfig;
    this.configVersion = newConfig.configVersion;
  }

  private async reconcileConfig(newConfig: ConnectConfig): Promise<void> {
    const newServersByNs = new Map(newConfig.servers.map((s) => [s.namespace, s]));
    let changed = false;

    // Deactivate servers that were removed from config or disabled
    for (const [namespace, connection] of this.connections) {
      const newServerConfig = newServersByNs.get(namespace);

      if (!newServerConfig || !newServerConfig.isActive) {
        log("info", "Server removed or disabled in config, deactivating", { namespace });
        await disconnectFromUpstream(connection);
        this.connections.delete(namespace);
        this.idleCallCounts.delete(namespace);
        changed = true;
        continue;
      }

      // Check if config changed (different command, args, url, etc.)
      const oldConfig = connection.config;
      if (
        oldConfig.command !== newServerConfig.command ||
        !argsEqual(oldConfig.args, newServerConfig.args) ||
        oldConfig.url !== newServerConfig.url ||
        !envEqual(oldConfig.env, newServerConfig.env)
      ) {
        log("info", "Server config changed, deactivating stale connection", { namespace });
        await disconnectFromUpstream(connection);
        this.connections.delete(namespace);
        this.idleCallCounts.delete(namespace);
        changed = true;
      }
    }

    if (changed) {
      this.rebuildRoutes();
      await this.notifyAllListsChanged();
    }
  }

  private startPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    const intervalMs = resolvePollIntervalMs();
    if (intervalMs === 0) {
      log("info", "Config polling disabled (MCPH_POLL_INTERVAL=0). Restart mcph to pick up dashboard changes.");
      return;
    }
    const poll = async () => {
      try {
        await this.fetchAndApplyConfig();
      } catch (err: any) {
        log("warn", "Config poll failed", { error: err.message });
      }
      this.pollTimer = setTimeout(poll, intervalMs);
      if (this.pollTimer.unref) this.pollTimer.unref();
    };
    this.pollTimer = setTimeout(poll, intervalMs);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  private async handleImport(
    filepath: string,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    if (!filepath) {
      return { content: [{ type: "text", text: "filepath is required." }], isError: true };
    }

    // Security: only allow known MCP config filenames
    const ALLOWED_FILENAMES = ["claude_desktop_config.json", "mcp.json", "settings.json", "mcp_config.json"];
    const basename = filepath.split(/[/\\]/).pop() || "";
    if (!ALLOWED_FILENAMES.includes(basename)) {
      return {
        content: [
          {
            type: "text",
            text: `Only MCP config files are allowed: ${ALLOWED_FILENAMES.join(", ")}. Got: ${basename}`,
          },
        ],
        isError: true,
      };
    }

    try {
      const resolved =
        filepath.startsWith("~/") || filepath.startsWith("~\\")
          ? resolve(homedir(), filepath.slice(2))
          : resolve(filepath);
      const raw = await readFile(resolved, "utf-8");
      const parsed = JSON.parse(raw);

      // Only parse if file has mcpServers key
      if (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)) {
        return {
          content: [{ type: "text", text: `No mcpServers object found in ${resolved}` }],
          isError: true,
        };
      }
      const mcpServers: Record<string, any> = parsed.mcpServers;

      // Note: env vars are NOT sent to the cloud for security — users must set them in the dashboard
      const servers: Array<{
        name: string;
        namespace: string;
        type: string;
        command?: string;
        args?: string[];
        url?: string;
      }> = [];

      for (const [key, value] of Object.entries(mcpServers)) {
        if (!value || typeof value !== "object") continue;
        // Skip ourselves
        if (key === "mcph" || key === "mcp.hosting" || key === "mcp-connect") continue;

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

        if ((value as any).command && typeof (value as any).command === "string")
          entry.command = (value as any).command;
        if (Array.isArray((value as any).args)) entry.args = (value as any).args;
        // env vars deliberately NOT sent — set them in the mcp.hosting dashboard
        if ((value as any).url && typeof (value as any).url === "string") entry.url = (value as any).url;

        servers.push(entry);
      }

      if (servers.length === 0) {
        return { content: [{ type: "text", text: `No servers found in ${resolved}` }], isError: true };
      }

      // Detect namespace collisions from sanitization
      const nsToKeys = new Map<string, string[]>();
      for (const s of servers) {
        const existing = nsToKeys.get(s.namespace) ?? [];
        existing.push(s.name);
        nsToKeys.set(s.namespace, existing);
      }
      const collisions = [...nsToKeys.entries()].filter(([, keys]) => keys.length > 1);

      // POST to the bulk import endpoint
      const res = await request(`${this.apiUrl.replace(/\/$/, "")}/api/connect/import`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ servers }),
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
      });

      let body: any;
      try {
        body = await res.body.json();
      } catch {
        body = {};
      }

      if (res.statusCode >= 400) {
        return {
          content: [{ type: "text", text: `Import failed: ${body.error || `HTTP ${res.statusCode}`}` }],
          isError: true,
        };
      }

      // Refresh config to pick up imported servers
      await this.fetchAndApplyConfig().catch(() => {});

      const namespaceList = servers.map((s) => s.namespace).join(", ");
      const collisionWarning =
        collisions.length > 0
          ? `\n\nWarning: namespace collisions detected — these names mapped to the same namespace:\n${collisions.map(([ns, keys]) => `  ${ns} ← ${keys.join(", ")}`).join("\n")}\nOnly one will be kept.`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `Imported ${body.imported || 0} servers (${namespaceList})${body.skipped ? `, ${body.skipped} skipped (already exist)` : ""} from ${resolved}.${collisionWarning}\n\nNote: environment variables (API keys, tokens) were NOT imported for security — set them at mcp.hosting.\nUse mcp_connect_discover to see imported servers.`,
          },
        ],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Import error: ${err.message}` }], isError: true };
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
      const idleCount = this.idleCallCounts.get(namespace) ?? 0;
      const toolNames = conn.tools.map((t) => t.name).join(", ");

      lines.push(`  ${namespace} [${conn.status}] (${conn.config.type})`);
      lines.push(`    tools: ${conn.tools.length} — ${toolNames}`);
      lines.push(`    calls: ${h.totalCalls}, errors: ${h.errorCount} (${errorRate}%)`);
      lines.push(`    avg latency: ${avgLatency}ms`);
      lines.push(`    idle: ${idleCount}/${ConnectServer.IDLE_CALL_THRESHOLD} until auto-deactivate`);
      if (h.lastErrorMessage) {
        lines.push(`    last error: ${h.lastErrorMessage} at ${h.lastErrorAt}`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  async shutdown(): Promise<void> {
    log("info", "Shutting down mcph");

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    stopTestRunner();
    await shutdownAnalytics();

    // Disconnect all upstreams
    const disconnects = Array.from(this.connections.values()).map((conn) => disconnectFromUpstream(conn));
    await Promise.allSettled(disconnects);
    this.connections.clear();

    await this.server.close();

    log("info", "mcph shutdown complete");
  }
}
