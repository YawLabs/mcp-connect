import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
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
import { initAnalytics, recordConnectEvent, recordDispatchEvent, shutdownAnalytics } from "./analytics.js";
import { CURATED_BUNDLES, bundleActivateHint, matchBundles } from "./bundles.js";
import { formatShadowLine } from "./cli-shadows.js";
import { type ComplianceGrade, parseMinCompliance, passesMinCompliance } from "./compliance.js";
import { type Profile, loadEffectiveProfile, profileAllows } from "./config-loader.js";
import { ConfigError, fetchConfig } from "./config.js";
import { estimateFromConnectedTools, estimateFromToolCache, formatCostLabel } from "./cost-estimate.js";
import { detectMissingCredentials } from "./credentials.js";
import { type ExecStepInput, RefError, resolveArgs, stepBindingKey, validateExecRequest } from "./exec-engine.js";
import { type LoadedGuides, loadGuides, renderGuide } from "./guide.js";
import {
  ACTIVATION_FAILURE_TTL_MS,
  type ActivationFailure,
  formatHealthWarning,
  healthFactor,
} from "./health-score.js";
import { HISTORY_LIMIT, type ToolCallRecord, adaptiveThreshold, pushToolCall } from "./idle-ttl.js";
import { LearningStore } from "./learning.js";
import { log } from "./logger.js";
import { META_TOOLS, META_TOOL_NAMES, buildInstallPayload } from "./meta-tools.js";
import { PackDetector } from "./pack-detect.js";
import { loadState, saveState } from "./persistence.js";
import { type ProgressReporter, createProgressReporter } from "./progress.js";
import {
  type BuiltinResource,
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
import { type Content, pruneContent } from "./prune.js";
import { findTool, formatReadToolOutput, formatToolNotFound, normalizeToolName } from "./read-tool.js";
import { type RankableServer, rankServers, scoreRelevance } from "./relevance.js";
import { initRerank, rerank } from "./rerank.js";
import { initRuntimeDetect, reportRuntimes } from "./runtime-detect.js";
import { buildCandidates, shouldTiebreak, tiebreakViaSampling } from "./sampling-rank.js";
import { type LoadedSlot, evaluateServerCap, resolveServerCap } from "./server-cap.js";
import { initTestRunner, startTestRunner, stopTestRunner } from "./test-runner.js";
import { initToolReport, reportTools } from "./tool-report.js";
import type { ConnectConfig, UpstreamConnection, UpstreamServerConfig } from "./types.js";
import { ActivationError, connectToUpstream, disconnectFromUpstream } from "./upstream.js";
import { buildCoUsageMap, formatUsageHint } from "./usage-hints.js";
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

// Opt-out for cross-session persistence. Set MCPH_DISABLE_PERSISTENCE=1
// (or "true") to keep learning + pack-history scoped to the current
// process — nothing is loaded at start, nothing is written on shutdown.
// Intended for users running mcph in ephemeral/shared environments
// (CI runners, containers, on-call relief boxes) where a stale state
// file would lie about recent usage patterns.
export function isPersistenceDisabled(): boolean {
  const raw = process.env.MCPH_DISABLE_PERSISTENCE;
  if (raw === undefined || raw === "") return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

// Current minimum compliance filter, parsed from MCPH_MIN_COMPLIANCE.
// Re-read on every call so tests can stub the env between cases. Null
// means "filter disabled" — every server passes regardless of grade.
// Invalid values log a one-shot warning (see parseMinCompliance) and
// fall back to disabled so a typo never hides the user's whole catalog.
export function resolveMinCompliance(): ComplianceGrade | null {
  return parseMinCompliance(process.env.MCPH_MIN_COMPLIANCE);
}

// Opt-in auto-load. Set MCPH_AUTO_LOAD=1 (or "true") to pre-activate the
// top recurring pack from persisted history on startup — no LLM round
// trip required. Default off: auto-activation normally rides on an
// explicit discover() call (see MCPH_AUTO_ACTIVATE). This is for users
// who know their workflow starts the same way every session and want
// to skip the discover step entirely.
export function isAutoLoadEnabled(): boolean {
  const raw = process.env.MCPH_AUTO_LOAD;
  if (raw === undefined || raw === "") return false;
  return raw === "1" || raw.toLowerCase() === "true";
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

// Tokenizer for the discover "matches" summary. Mirrors relevance.ts's
// split-on-non-alphanumeric behavior so the summary's per-tool match
// logic lines up with BM25's ranking logic. Kept local rather than
// exported from relevance.ts because the MIN_TOKEN_LEN of 3 used
// there would drop short but meaningful query words like "pr" / "ci"
// here — the summary is cosmetic, so a looser threshold is fine.
function tokenizeForSummary(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2),
  );
}

// Detect tools with the same BARE name across multiple currently-connected
// servers. Dormant or disconnected namespaces don't count — we don't have
// their live tool schemas and can't be certain they'd collide. Returns
// entries sorted by namespace count desc, tie-break by bare-name asc;
// each entry's `namespaces` array is alphabetically sorted for stable output.
// Exported for unit tests.
export function computeToolOverlaps(
  connections: Iterable<UpstreamConnection>,
): Array<{ bareName: string; namespaces: string[] }> {
  const byName = new Map<string, Set<string>>();
  for (const conn of connections) {
    if (conn.status !== "connected") continue;
    const ns = conn.config.namespace;
    for (const tool of conn.tools) {
      let set = byName.get(tool.name);
      if (!set) {
        set = new Set<string>();
        byName.set(tool.name, set);
      }
      set.add(ns);
    }
  }
  const overlaps: Array<{ bareName: string; namespaces: string[] }> = [];
  for (const [bareName, nsSet] of byName) {
    if (nsSet.size < 2) continue;
    overlaps.push({ bareName, namespaces: [...nsSet].sort() });
  }
  overlaps.sort((a, b) => {
    if (b.namespaces.length !== a.namespaces.length) return b.namespaces.length - a.namespaces.length;
    return a.bareName.localeCompare(b.bareName);
  });
  return overlaps;
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
  // Rolling history of recent tool calls (namespace + timestamp) used to
  // compute the adaptive idle threshold per-namespace. Bounded to
  // HISTORY_LIMIT entries so long sessions don't grow memory unbounded.
  private recentToolCalls: ToolCallRecord[] = [];
  // Track which namespaces have already had their adaptive-patience
  // skip logged this session — we only want the "see the mechanism in
  // action" log once per namespace, not every single idle tick.
  private adaptiveSkipLogged = new Set<string>();
  private toolCache = new Map<string, Array<{ name: string; description?: string }>>();
  // Per-namespace tool filters set by mcp_connect_activate({ tools: [...] }).
  // When a namespace has an entry, only those BARE tool names surface in
  // tools/list; routing tables stay complete so mcp_connect_dispatch can
  // still reach unlisted tools. Cleared on activate-without-tools of the
  // same namespace, on deactivate, and on config reconcile.
  private toolFilters = new Map<string, Set<string>>();
  private profile: Profile | null = null;
  // Loaded MCPH.md guides (user-global + project-local). Null until
  // start() has run the loader; fail-open if either file is missing,
  // unreadable, or empty.
  private guides: LoadedGuides = { user: null, project: null };
  // Tracks whether the client has actually READ `mcph://guide` this
  // session. meta-tools.ts uses this to fire a one-shot nudge in the
  // next tool response reminding the client to read the guide — but
  // only if (a) at least one guide is present and (b) the client
  // hasn't read it yet. Cleared on startup; no persistence.
  private guideRead = false;
  // One-shot latch for the guide nudge. Flips true the first time a
  // meta-tool response includes the nudge, so we don't spam the same
  // hint on every subsequent call — the client had its chance.
  private guideNudgeFired = false;
  // Short-term memory of activation failures; used by dispatch to
  // down-rank recently-flaky servers. Cleared on successful activation.
  private activationFailures = new Map<string, ActivationFailure>();
  // Session-scoped credential overrides supplied by the user via MCP
  // elicitation when a server's stderr indicated a missing env var.
  // Cleared on shutdown — persistence belongs in the mcp.hosting
  // dashboard, these are a "get me running now" shortcut.
  private elicitedEnv = new Map<string, Record<string, string>>();
  // In-flight activation promises, keyed by namespace. Dedupes
  // concurrent activation attempts for the same namespace so that two
  // tool calls landing on a disconnected upstream don't each spawn
  // their own child process. Second and subsequent callers await the
  // same promise as the first; the entry is cleared when the promise
  // settles (success or failure).
  private activationInflight = new Map<
    string,
    Promise<{ ok: boolean; message: string; isChanged: boolean; serverId?: string }>
  >();
  // Usage learning — nudges dispatch toward namespaces that have been
  // genuinely useful. Counts persist across mcph restarts via state.json
  // (see persistence.ts). MCPH_DISABLE_PERSISTENCE=1 makes it session
  // -scoped only. See learning.ts.
  private readonly learning = new LearningStore();
  // Session-scoped chain detection — watches proxied tool calls across
  // namespaces and surfaces recurring multi-server patterns as suggested
  // "packs". Observation-only; never activates anything. Meta-tool calls
  // are deliberately excluded because they aren't user workflow.
  private readonly packDetector = new PackDetector();

  // Short-TTL dedup cache for discover output. Agents often call
  // discover twice in quick succession (e.g. once to list, again after
  // a failed activate) — the second call returns the same text if
  // nothing has changed. Keyed on (configVersion, context, autoWarmed,
  // active-namespace-set) so activate/deactivate naturally invalidates.
  private discoverCache: {
    key: string;
    result: { content: Array<{ type: string; text: string }> };
    expires: number;
  } | null = null;
  private static readonly DISCOVER_CACHE_TTL_MS = 3000;

  // Baseline idle-call threshold. A namespace with NO recent activity
  // gets deactivated after this many non-matching tool calls; bursty
  // namespaces get proportionally more patience via adaptiveThreshold()
  // (see idle-ttl.ts). The env var MCP_CONNECT_IDLE_THRESHOLD overrides
  // the baseline — it does NOT disable the adaptive cap, which is a
  // safety valve clamping the final threshold to [5, 50].
  private static readonly IDLE_CALL_THRESHOLD = (() => {
    const env = process.env.MCP_CONNECT_IDLE_THRESHOLD;
    if (!env) return 10;
    const n = Number.parseInt(env, 10);
    return Number.isFinite(n) && n >= 1 ? n : 10;
  })();

  // Concurrent-load ceiling. See server-cap.ts — checked in
  // runActivateOne before a new upstream is spawned so we refuse at
  // the door instead of over-inflating the LLM's context. Instance
  // field (not static) so tests can override per-instance without
  // poisoning other instances or re-importing the module.
  private serverCap = resolveServerCap();

  // Cross-session persistence state (learning + pack history).
  // `persistenceReady` gates the save path so unit tests — which
  // never call start() — don't write to ~/.mcph/state.json. The
  // debounced timer collapses bursts of record*/recordCall into a
  // single write; flushed synchronously on shutdown.
  private persistenceReady = false;
  private stateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STATE_SAVE_DEBOUNCE_MS = 1000;

  constructor(
    private apiUrl: string,
    private token: string,
  ) {
    this.server = new Server(
      { name: "mcph", version: typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev" },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: { listChanged: true },
        },
      },
    );
    // mcph itself does not handle elicitation or sampling requests; it
    // originates them. The capability declaration for originated features
    // is implicit — the client advertises whether IT supports receiving
    // them, which we check via getClientCapabilities() before prompting.
    this.setupHandlers();
  }

  // Builtin resources served directly by mcph (not proxied from an
  // upstream). Today: just `mcph://guide`. Rebuilt each request so the
  // list reflects the latest loaded guides — start() populates
  // `this.guides` once, but tests and future hot-reload code paths may
  // mutate it, and the cost of rebuilding is negligible.
  private getBuiltinResources(): BuiltinResource[] {
    const body = renderGuide(this.guides, this.getProfiledActiveServers());
    if (!body) return [];
    return [
      {
        uri: "mcph://guide",
        name: "mcph guide",
        description:
          "Project + user guidance from MCPH.md. Read this to learn how THIS user/project routes MCP work (which servers to prefer, where credentials live, gotchas).",
        mimeType: "text/markdown",
        read: () => {
          // Flip the session flag — the meta-tools one-shot nudge keys
          // off this so we only remind the client to read the guide if
          // they haven't yet. Re-render at read time so the auto
          // "Active servers" section reflects the current connection
          // set, not the one at list time.
          this.guideRead = true;
          const text = renderGuide(this.guides, this.getProfiledActiveServers()) ?? "";
          return { contents: [{ uri: "mcph://guide", text, mimeType: "text/markdown" }] };
        },
      },
    ];
  }

  private getBuiltinResourceMap(): Map<string, BuiltinResource> {
    const map = new Map<string, BuiltinResource>();
    for (const b of this.getBuiltinResources()) map.set(b.uri, b);
    return map;
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: buildToolList(this.connections, this.getDeferredServers(), this.toolFilters),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      return this.handleToolCall(name, args ?? {}, extra);
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: buildResourceList(this.connections, this.getBuiltinResources()),
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return routeResourceRead(request.params.uri, this.resourceRoutes, this.connections, this.getBuiltinResourceMap());
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
    this.notifyAllListsChanged().catch((err: Error) => {
      // Logged rather than silenced — a failure here means the client
      // won't know tools/resources/prompts just changed, which cascades
      // into confusing "unknown tool" errors on the next call. Worth
      // surfacing so the failure isn't invisible.
      log("warn", "Failed to notify client of upstream list change", {
        namespace: ns,
        error: err?.message ?? String(err),
      });
    });
  };

  private rebuildRoutes(): void {
    this.toolRoutes = buildToolRoutes(this.connections, this.getDeferredServers());
    this.resourceRoutes = buildResourceRoutes(this.connections);
    this.promptRoutes = buildPromptRoutes(this.connections);
  }

  // Active servers, narrowed by the project profile if one is loaded.
  // Centralizing this here means discover/dispatch/auto-warm all see the
  // same set — no accidental bypass of the profile via a second code path.
  private getProfiledActiveServers(): UpstreamServerConfig[] {
    const all = (this.config?.servers ?? []).filter((s) => s.isActive);
    if (!this.profile) return all;
    return all.filter((s) => profileAllows(this.profile, s.namespace));
  }

  // Configured-but-not-currently-connected servers that have a persisted
  // toolCache. Fed into buildToolList/buildToolRoutes so the LLM can see
  // their tools in tools/list before activation; first tools/call on any
  // of those tools triggers lazy activation via activateOne in
  // handleToolCall. Merges in any in-session toolCache (this.toolCache)
  // that hasn't yet been persisted to the dashboard, so recently-used
  // servers that got idle-evicted still appear as deferred.
  private getDeferredServers(): UpstreamServerConfig[] {
    const out: UpstreamServerConfig[] = [];
    for (const server of this.getProfiledActiveServers()) {
      if (this.connections.has(server.namespace)) continue;
      const sessionCache = this.toolCache.get(server.namespace);
      const cache = sessionCache && sessionCache.length > 0 ? sessionCache : server.toolCache;
      if (!cache || cache.length === 0) continue;
      out.push(cache === server.toolCache ? server : { ...server, toolCache: cache });
    }
    return out;
  }

  private async notifyAllListsChanged(): Promise<void> {
    // Each send is independent — one failure shouldn't cancel the
    // others. Log so the failure is visible without throwing, since
    // callers treat this as a fire-and-forget notification.
    await this.server.sendToolListChanged().catch((err: Error) => {
      log("warn", "sendToolListChanged failed", { error: err?.message ?? String(err) });
    });
    await this.server.sendResourceListChanged().catch((err: Error) => {
      log("warn", "sendResourceListChanged failed", { error: err?.message ?? String(err) });
    });
    await this.server.sendPromptListChanged().catch((err: Error) => {
      log("warn", "sendPromptListChanged failed", { error: err?.message ?? String(err) });
    });
  }

  async start(): Promise<void> {
    // Hydrate learning + pack-history state from ~/.mcph/state.json
    // before anything else so subsequent record* writes land on top of
    // the restored signal rather than replacing it. loadState() never
    // throws — missing/corrupt files yield an empty snapshot.
    //
    // MCPH_DISABLE_PERSISTENCE=1 keeps `persistenceReady` false, which
    // silently no-ops both the debounced scheduleStateSave() and the
    // shutdown flush — the whole pathway disappears in one toggle.
    if (isPersistenceDisabled()) {
      log("info", "Cross-session persistence disabled via MCPH_DISABLE_PERSISTENCE");
    } else {
      const persisted = await loadState();
      if (Object.keys(persisted.learning).length > 0 || persisted.packHistory.length > 0) {
        this.learning.loadSnapshot(persisted.learning);
        this.packDetector.loadSnapshot(persisted.packHistory);
        log("info", "Restored mcph state", {
          learningEntries: Object.keys(persisted.learning).length,
          packHistoryEntries: persisted.packHistory.length,
        });
      }
      this.persistenceReady = true;
    }

    // Load the effective profile (allow/deny lists from .mcph/config.*
    // files). Walks up from cwd for a project-local .mcph/ dir and also
    // consults ~/.mcph/config.json (user-global). Local beats project
    // beats global for the allow-list; denies union. Failure is silent
    // — fail-open so a bad config doesn't brick the session.
    this.profile = await loadEffectiveProfile(process.cwd()).catch(() => null);
    if (this.profile) {
      log("info", "Loaded profile", {
        path: this.profile.path,
        userPath: this.profile.userPath,
        allow: this.profile.servers,
        block: this.profile.blocked,
      });
    }

    // Load MCPH.md guides (user-global + project-local). Fail-open:
    // loadGuides() swallows I/O errors internally, so the worst case
    // is `this.guides` stays { user: null, project: null } and the
    // `mcph://guide` builtin simply isn't listed.
    this.guides = await loadGuides(process.cwd()).catch(() => ({ user: null, project: null }));
    if (this.guides.user || this.guides.project) {
      log("info", "Loaded MCPH.md guide", {
        user: this.guides.user?.path ?? null,
        project: this.guides.project?.path ?? null,
      });
    }

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
    reportRuntimes().catch((err: Error) => log("warn", "reportRuntimes failed", { error: err?.message }));
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

    // Dormant servers (isActive but no persisted toolCache yet) are
    // invisible in tools/list because getDeferredServers() filters on
    // toolCache presence. That breaks the "I toggled it on in the
    // dashboard and it disappeared" user experience. Pre-warm each one
    // in the background: activate → reportTools persists the tool set
    // → disconnect so we're not holding 9 upstream processes idle.
    // Fire-and-forget so this doesn't gate transport readiness.
    this.prewarmDormantServers().catch((err: Error) => log("warn", "Pre-warm failed", { error: err?.message }));

    // Opt-in auto-load of the top recurring pack. Requires persistence
    // (so there IS a history to learn from) AND MCPH_AUTO_LOAD=1. Runs
    // after prewarm so both paths see the same config snapshot; they're
    // independent (prewarm populates toolCache for dashboard-toggled
    // servers, this one spins up the recurring workflow's servers for
    // real). Fire-and-forget — startup shouldn't block on it.
    if (isAutoLoadEnabled() && this.persistenceReady) {
      this.autoLoadRecurringPack().catch((err: Error) => log("warn", "Auto-load failed", { error: err?.message }));
    }

    log("info", "mcph started", {
      apiUrl: this.apiUrl,
      servers: this.config?.servers.length ?? 0,
    });
  }

  // Auto-activate the single highest-ranked pack whose every namespace
  // is installed. Opt-in via MCPH_AUTO_LOAD. Silent no-op when there's
  // no history or no matching pack — the value is "skip discover when
  // my workflow starts the same way every time," not "noisy on every
  // startup." Sequential activateOne (not parallel) so the cap logic
  // and dedup map see consistent state between loads.
  private async autoLoadRecurringPack(): Promise<void> {
    const installedNamespaces = new Set(this.getProfiledActiveServers().map((s) => s.namespace));
    if (installedNamespaces.size === 0) return;

    const chains = this.packDetector.detectChains();
    if (chains.length === 0) return;

    const candidates = chains
      .filter((pack) => pack.namespaces.every((ns) => installedNamespaces.has(ns)))
      .sort((a, b) => {
        if (b.frequency !== a.frequency) return b.frequency - a.frequency;
        return b.lastSeenAt - a.lastSeenAt;
      });
    if (candidates.length === 0) return;

    const top = candidates[0];
    for (const namespace of top.namespaces) {
      await this.activateOne(namespace).catch((err: Error) =>
        log("warn", "Auto-load activateOne failed", { namespace, error: err?.message }),
      );
    }

    log("info", "Auto-loaded recurring pack", {
      namespaces: top.namespaces,
      frequency: top.frequency,
    });
  }

  // Populate toolCache for any isActive-but-never-activated server so
  // Claude's tools/list shows the full toggled set on first run.
  // Subsequent sessions read the persisted toolCache from config and
  // skip this path entirely, so it's a one-time cost per server.
  private async prewarmDormantServers(): Promise<void> {
    const dormant = this.getProfiledActiveServers().filter((s) => !s.toolCache || s.toolCache.length === 0);
    if (dormant.length === 0) return;

    log("info", "Pre-warming dormant servers", {
      count: dormant.length,
      namespaces: dormant.map((s) => s.namespace),
    });

    const CONCURRENCY = 3;
    let anyPopulated = false;
    for (let i = 0; i < dormant.length; i += CONCURRENCY) {
      const batch = dormant.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (server) => {
          try {
            const result = await this.activateOne(server.namespace);
            if (!result.ok) return;
            // Immediately disconnect — toolCache is already in
            // this.toolCache and reportTools persisted it upstream,
            // so getDeferredServers() surfaces the server without
            // us holding the upstream process alive.
            const conn = this.connections.get(server.namespace);
            if (conn) {
              await disconnectFromUpstream(conn).catch(() => {});
              this.connections.delete(server.namespace);
              this.idleCallCounts.delete(server.namespace);
            }
            anyPopulated = true;
          } catch (err) {
            log("warn", "Pre-warm of server failed", {
              namespace: server.namespace,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
    }

    if (anyPopulated) {
      this.rebuildRoutes();
      await this.notifyAllListsChanged();
    }
  }

  // One-shot nudge: if an MCPH.md guide was loaded at startup but the
  // client hasn't read `mcph://guide` yet, append a short reminder to
  // the next meta-tool response. We only fire once per session — after
  // that the flag latches and we shut up. This is deliberately gentle
  // (a hint, not an error) because the guide is advisory; clients that
  // ignore it still work fine.
  private attachGuideNudge<T extends { content: Array<{ type: string; text: string }> }>(result: T): T {
    if (this.guideNudgeFired) return result;
    if (this.guideRead) return result;
    if (!this.guides.user && !this.guides.project) return result;
    this.guideNudgeFired = true;
    const sources = [this.guides.user?.path, this.guides.project?.path].filter(Boolean).join(", ");
    const text = `\n\n[mcph] Tip: read the \`mcph://guide\` resource for project-specific routing & credential guidance (from ${sources}). This hint appears once per session.`;
    const last = result.content[result.content.length - 1];
    if (last && last.type === "text") {
      last.text = `${last.text}${text}`;
    } else {
      result.content.push({ type: "text", text: text.trimStart() });
    }
    return result;
  }

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
    extra?: { sendNotification?: any; _meta?: Record<string, unknown> },
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const progress = createProgressReporter(extra);
    if (name === META_TOOLS.discover.name) {
      recordConnectEvent({ namespace: null, toolName: null, action: "discover", latencyMs: null, success: true });
      // When the LLM supplies task context, automatically warm the top
      // confident candidate so a one-shot discover() is enough to start
      // calling tools. Ambiguous queries fall through to the manual list.
      return this.attachGuideNudge(await this.handleDiscoverWithAutoWarm(args.context as string | undefined, progress));
    }
    if (name === META_TOOLS.dispatch.name) {
      const intent = typeof args.intent === "string" ? args.intent : "";
      const budget = typeof args.budget === "number" && Number.isFinite(args.budget) ? args.budget : 1;
      recordConnectEvent({ namespace: null, toolName: null, action: "activate", latencyMs: null, success: true });
      return this.attachGuideNudge(await this.handleDispatch(intent, budget, progress));
    }
    if (name === META_TOOLS.activate.name) {
      const namespaces = resolveNamespaces(args);
      // `tools` is only meaningful when activating a single server —
      // a flat list of bare names has no unambiguous mapping to a
      // multi-server call. For any other shape the filter is reset
      // (see handleActivate), matching the "activate without tools
      // clears the filter" rule.
      const toolsFilter =
        namespaces.length === 1 && Array.isArray(args.tools) && args.tools.every((t) => typeof t === "string")
          ? (args.tools as string[])
          : undefined;
      const result = await this.handleActivate(namespaces, progress, toolsFilter);
      for (const ns of namespaces) {
        recordConnectEvent({
          namespace: ns,
          toolName: null,
          action: "activate",
          latencyMs: null,
          success: !result.isError,
        });
      }
      return this.attachGuideNudge(result);
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
      return this.attachGuideNudge(result);
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
      return this.attachGuideNudge(result);
    }
    if (name === META_TOOLS.install.name) {
      const result = await this.handleInstall(args);
      recordConnectEvent({
        namespace: typeof args.namespace === "string" ? args.namespace : null,
        toolName: null,
        action: "install",
        latencyMs: null,
        success: !result.isError,
      });
      return this.attachGuideNudge(result);
    }
    if (name === META_TOOLS.health.name) {
      recordConnectEvent({ namespace: null, toolName: null, action: "health", latencyMs: null, success: true });
      return this.attachGuideNudge(this.handleHealth());
    }
    if (name === META_TOOLS.read_tool.name) {
      const serverArg = typeof args.server === "string" ? args.server : "";
      const toolArg = typeof args.tool === "string" ? args.tool : "";
      const result = await this.handleReadTool(serverArg, toolArg, progress);
      recordConnectEvent({
        namespace: serverArg || null,
        toolName: toolArg || null,
        action: "read_tool",
        latencyMs: null,
        success: !result.isError,
      });
      return this.attachGuideNudge(result);
    }
    if (name === META_TOOLS.suggest.name) {
      recordConnectEvent({ namespace: null, toolName: null, action: "suggest", latencyMs: null, success: true });
      return this.attachGuideNudge(this.handleSuggest());
    }
    if (name === META_TOOLS.exec.name) {
      const result = await this.handleExec(args);
      recordConnectEvent({
        namespace: null,
        toolName: null,
        action: "exec",
        latencyMs: null,
        success: !result.isError,
      });
      return this.attachGuideNudge(result);
    }
    if (name === META_TOOLS.bundles.name) {
      const action = args.action === "match" ? "match" : "list";
      recordConnectEvent({ namespace: null, toolName: null, action: "bundles", latencyMs: null, success: true });
      return this.attachGuideNudge(this.handleBundles(action));
    }

    // Snapshot routes at method entry. rebuildRoutes() may fire during
    // the auto-reconnect awaits below (via onUpstreamListChanged from
    // any other connection, or via trackUsageAndAutoDeactivate on a
    // concurrent tool call) and replace this.toolRoutes with a fresh
    // Map. Re-reading this.toolRoutes later would dispatch against a
    // map whose contents don't match the route we already captured —
    // so use the snapshot consistently from lookup through call.
    let routes = this.toolRoutes;
    let route = routes.get(name);

    // Deferred route: the server was advertised in tools/list from its
    // cached tool set but isn't connected yet. Activate now, rebuild
    // routes, notify the client that the list changed (so the real
    // inputSchema supersedes the placeholder), then re-dispatch through
    // the fresh routes. activateOne dedupes concurrent activations and
    // handles elicitation + retries.
    if (route?.deferred) {
      progress?.(`Loading "${route.namespace}" on first tools/call…`);
      const activation = await this.activateOne(route.namespace, progress);
      if (!activation.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Server "${route.namespace}" could not be loaded on first call: ${activation.message}`,
            },
          ],
          isError: true,
        };
      }
      if (activation.isChanged) {
        this.rebuildRoutes();
        await this.notifyAllListsChanged();
      }
      // Re-snapshot against fresh routes. If the upstream no longer
      // exposes a tool by this name (cache was stale), fall through to
      // the routes.get(name) miss path below with a clear message.
      routes = this.toolRoutes;
      route = routes.get(name);
      if (!route || route.deferred) {
        return {
          content: [
            {
              type: "text",
              text: `Tool "${name}" is no longer available after loading "${activation.serverId ? activation.serverId : name}" — the upstream's tool set changed. Call mcp_connect_discover to see current tools.`,
            },
          ],
          isError: true,
        };
      }
    }

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
                  text: `Server "${route.namespace}" disconnected and auto-reconnect failed: ${lastErr.message}. Use mcp_connect_activate with server "${route.namespace}" to reload it manually.`,
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
    // Route against the snapshot, not this.toolRoutes, so a rebuild
    // between the initial lookup and this call can't misdirect us.
    const result = await routeToolCall(name, args, routes, this.connections);
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

      // Prune the response before it hits the LLM. Rules are
      // conservative (drop null / undefined / empty collections,
      // collapse runs of blank lines) so we trim obvious dead weight
      // without changing meaning. Disable with MCPH_PRUNE_RESPONSES=0
      // if a caller needs the exact upstream bytes through.
      if (!result.isError && Array.isArray(result.content)) {
        try {
          const pr = pruneContent(result.content as Content[]);
          // Only swap in the pruned body when it's actually smaller,
          // per the MIN_SAVINGS_RATIO check inside pruneContent.
          if (pr.bytesPruned < pr.bytesRaw) result.content = pr.content;
          try {
            const argsBytes = Buffer.byteLength(JSON.stringify(args ?? {}), "utf8");
            recordDispatchEvent({
              scope: "connect",
              serverId: null,
              toolName: route.originalName,
              requestBytes: argsBytes,
              responseBytesRaw: pr.bytesRaw,
              responseBytesPruned: pr.bytesPruned,
            });
          } catch {
            // JSON.stringify can throw on cyclic structures — telemetry
            // is strictly best-effort, never fail the tool call for it.
          }
        } catch (err: any) {
          // Pruner should never throw, but if it does, fall back to the
          // pre-F1 telemetry path so the dispatch event still lands.
          log("warn", "pruneContent failed", { error: err?.message });
          try {
            const argsBytes = Buffer.byteLength(JSON.stringify(args ?? {}), "utf8");
            const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
            recordDispatchEvent({
              scope: "connect",
              serverId: null,
              toolName: route.originalName,
              requestBytes: argsBytes,
              responseBytesRaw: resultBytes,
            });
          } catch {}
        }
      } else {
        // Error responses skip pruning — the text IS the error message,
        // stripping nulls or collapsing whitespace could obscure it.
        try {
          const argsBytes = Buffer.byteLength(JSON.stringify(args ?? {}), "utf8");
          const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
          recordDispatchEvent({
            scope: "connect",
            serverId: null,
            toolName: route.originalName,
            requestBytes: argsBytes,
            responseBytesRaw: resultBytes,
          });
        } catch {
          // JSON.stringify can throw on cyclic structures — telemetry
          // is strictly best-effort, never fail the tool call for it.
        }
      }
      // Only count successful calls toward chain detection. An errored
      // call isn't a real usage signal — the user likely abandons or
      // retries on a different server. Meta-tools were short-circuited
      // above so they never reach this point.
      if (!result.isError) {
        this.packDetector.recordCall(route.namespace, route.originalName, Date.now());
        this.scheduleStateSave();
      }
      await this.trackUsageAndAutoDeactivate(route.namespace);
    }

    return result;
  }

  // Build RankableServer inputs for BM25 — uses live tool metadata when
  // the server is connected in this session, otherwise falls back to the
  // in-memory toolCache (populated from prior activations this session)
  // and finally the persistent toolCache shipped in the config payload.
  // Pick up to five tool names from the server whose own tokens overlap
  // with the query tokens. Falls back to the first three cached tool
  // names when nothing overlaps (the server scored on name/description,
  // not tools — still useful to surface the shape of what's available).
  // Used by the discover "Matches your query" summary only.
  private matchedToolNames(server: UpstreamServerConfig, queryTokens: Set<string>): string[] {
    const tools = this.rankableFor(server).tools;
    if (tools.length === 0) return [];
    const hits: string[] = [];
    for (const tool of tools) {
      const nameTokens = tool.name.toLowerCase().split(/[^a-z0-9]+/);
      const descTokens = (tool.description ?? "").toLowerCase().split(/[^a-z0-9]+/);
      if (nameTokens.some((t) => queryTokens.has(t)) || descTokens.some((t) => queryTokens.has(t))) {
        hits.push(tool.name);
        if (hits.length >= 5) break;
      }
    }
    if (hits.length > 0) return hits;
    return tools.slice(0, 3).map((t) => t.name);
  }

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

  // Below this installed-server count, discover() appends a one-line
  // marketplace pointer so sparse-config users see where to add more.
  // At or above the threshold we stay silent — power users already know
  // the score, and the line would just be chat noise.
  private static readonly MARKETPLACE_HINT_THRESHOLD = 5;

  private handleDiscover(context?: string): { content: Array<{ type: string; text: string }> } {
    return this.buildDiscoverOutput(context, /* alreadyWarmed */ false);
  }

  private async handleDiscoverWithAutoWarm(
    context?: string,
    progress?: ProgressReporter,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!context || !ConnectServer.AUTO_ACTIVATE_ENABLED) return this.handleDiscover(context);

    const activeServers = this.getProfiledActiveServers();
    if (activeServers.length === 0) return this.handleDiscover(context);

    // Use the same two-stage ranker dispatch uses so discover + dispatch
    // pick the same winner for the same intent. BM25 shortlists locally;
    // the backend cosines the shortlist against stored embeddings. When
    // rerank is unavailable this silently falls back to BM25-only.
    const ranked = await this.twoStageRank(context, activeServers);
    if (ranked.length === 0) return this.handleDiscover(context);

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

    progress?.(`Auto-warming top candidate "${top.namespace}"`);
    const result = await this.activateOne(top.namespace, progress);
    if (result.ok) {
      log("info", "Auto-warmed top-ranked server on discover", { namespace: top.namespace, score: top.score });
    }

    return this.buildDiscoverOutput(context, result.ok);
  }

  private discoverCacheKey(context: string | undefined, autoWarmed: boolean): string {
    const activeNamespaces = [...this.connections.entries()]
      .filter(([, c]) => c.status === "connected")
      .map(([ns]) => ns)
      .sort()
      .join(",");
    return `${this.configVersion ?? ""}|${context ?? ""}|${autoWarmed ? "1" : "0"}|${activeNamespaces}`;
  }

  private buildDiscoverOutput(
    context: string | undefined,
    autoWarmed: boolean,
  ): { content: Array<{ type: string; text: string }> } {
    const key = this.discoverCacheKey(context, autoWarmed);
    const now = Date.now();
    const cached = this.discoverCache;
    if (cached && cached.key === key && cached.expires > now) {
      return cached.result;
    }
    const result = this.buildDiscoverOutputImpl(context, autoWarmed);
    this.discoverCache = { key, result, expires: now + ConnectServer.DISCOVER_CACHE_TTL_MS };
    return result;
  }

  private buildDiscoverOutputImpl(
    context: string | undefined,
    autoWarmed: boolean,
  ): { content: Array<{ type: string; text: string }> } {
    if (!this.config || this.config.servers.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No servers installed. Browse the mcph catalog at https://mcp.hosting/explore — add any server from there to your mcph account and it will appear here within 60s.",
          },
        ],
      };
    }

    const activeServers = this.getProfiledActiveServers();

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

    const lines: string[] = [context ? "Servers ranked by relevance:\n" : "Installed MCP servers:\n"];
    if (autoWarmed && sorted.length > 0) {
      lines.push(`Auto-loaded "${sorted[0].namespace}" — top match for your query.\n`);
    }

    // Compliance filter banner. When MCPH_MIN_COMPLIANCE is active, the
    // per-server lines below will annotate any below-grade server with a
    // "won't auto-activate" marker; this header tells the model WHY
    // those markers are there so it doesn't try to activate them and
    // get a refusal surprise.
    const minCompliance = resolveMinCompliance();
    if (minCompliance !== null) {
      lines.push(`Compliance filter active: MCPH_MIN_COMPLIANCE=${minCompliance}\n`);
    }

    // Compact "Matches your query" summary. Prepended when context is
    // given AND at least one server scored above zero, so the model
    // sees the short answer before the long list. Without this block
    // the relevance signal is easy to skim past — the per-server lines
    // carry a numeric score but no summary of WHY each matched.
    if (context) {
      const matchedServers = sorted.filter((s) => {
        const score = scores.get(s.namespace);
        return score !== undefined && score > 0;
      });
      if (matchedServers.length > 0) {
        lines.push("Matches for your query:");
        const queryTokens = tokenizeForSummary(context);
        for (const server of matchedServers.slice(0, 5)) {
          const tools = this.matchedToolNames(server, queryTokens);
          const toolStr = tools.length > 0 ? ` → ${tools.join(", ")}` : "";
          lines.push(`  • ${server.namespace}${toolStr}`);
        }
        lines.push("");
      }
    }

    // Precompute the co-usage map once per discover call. Derived from
    // the PackDetector's current history — same signal `suggest` surfaces,
    // but delivered inline so the LLM doesn't need a second meta-tool
    // roundtrip to see "often used with X."
    const chains = this.packDetector.detectChains();
    const coUsageMap = buildCoUsageMap(chains);

    // Inline "Suggested packs" block. Surfaces recurring co-activation
    // history from chains at the top of the output so the LLM can take
    // action in this call rather than needing a separate mcp_connect_suggest
    // round-trip. Filter: every namespace in the pack must be installed
    // (so `activate` can actually load them) AND at least one must not
    // be connected yet (otherwise the pack is already loaded — no action
    // to take). Ranked by frequency desc, tie-break by recency.
    const installedNamespaces = new Set(activeServers.map((s) => s.namespace));
    const connectedNamespaces = new Set(
      [...this.connections.entries()].filter(([, c]) => c.status === "connected").map(([ns]) => ns),
    );
    const actionablePacks = chains
      .filter((pack) => pack.namespaces.every((ns) => installedNamespaces.has(ns)))
      .filter((pack) => pack.namespaces.some((ns) => !connectedNamespaces.has(ns)))
      .sort((a, b) => {
        if (b.frequency !== a.frequency) return b.frequency - a.frequency;
        return b.lastSeenAt - a.lastSeenAt;
      });
    if (actionablePacks.length > 0) {
      lines.push("Recurring packs (activate together — seen before):");
      for (const pack of actionablePacks.slice(0, 3)) {
        const nsJson = JSON.stringify(pack.namespaces);
        lines.push(`  {${pack.namespaces.join(", ")}} — seen ${pack.frequency}x; activate with namespaces=${nsJson}`);
      }
      lines.push("");
    }

    let totalContextTokens = 0;
    for (const server of sorted) {
      const connection = this.connections.get(server.namespace);
      // Apply per-tool filter to the advertised count so discover matches
      // what tools/list actually surfaces. Raw upstream tool count is
      // still shown as the denominator so the model sees what's hidden.
      const filter = this.toolFilters.get(server.namespace);
      const total = connection?.tools.length ?? 0;
      const exposed = connection ? (filter ? connection.tools.filter((t) => filter.has(t.name)).length : total) : 0;
      const filterSuffix = connection && filter ? ` (filtered: ${exposed} of ${total})` : "";
      const status = connection
        ? connection.status === "error"
          ? "ERROR (disconnected, will auto-reconnect on use)"
          : `loaded (${exposed} tools)${filterSuffix}`
        : "ready";

      const score = scores.get(server.namespace);
      const relevance = score && score > 0 ? ` (relevance: ${score.toFixed(2)})` : "";

      // Token-cost estimate — live for connected servers, tool-cache-
      // padded for dormant ones. Guides the LLM's activate/skip choice
      // when context budget is tight. Suppressed when we have nothing
      // to measure (no cache, no connection yet). When a filter is
      // active the cost reflects the EXPOSED tools only — hidden tools
      // don't surface in tools/list and therefore don't spend context.
      let costLabel = "";
      if (connection && connection.tools.length > 0) {
        const visible = filter ? connection.tools.filter((t) => filter.has(t.name)) : connection.tools;
        if (visible.length > 0) {
          const sample = estimateFromConnectedTools(visible);
          totalContextTokens += sample.tokens;
          costLabel = ` — ${formatCostLabel(sample)}`;
        }
      } else {
        const cached = this.toolCache.get(server.namespace) ?? server.toolCache;
        if (cached && cached.length > 0) {
          costLabel = ` — ${formatCostLabel(estimateFromToolCache(cached))}`;
        }
      }

      // Compliance annotation — only surfaces when the filter is active,
      // since the grade is only interesting RELATIVE to a configured
      // minimum. Passing graded server → show `[A]` as a reassurance tag;
      // below-min → spell out the reason inline so the model knows why
      // it's surfaced but won't be activated. Ungraded servers stay
      // unannotated (don't clutter lines for servers the backend hasn't
      // scored yet — most of the current catalog).
      let complianceLabel = "";
      if (minCompliance !== null && server.complianceGrade) {
        if (passesMinCompliance(server.complianceGrade, minCompliance)) {
          complianceLabel = ` [${server.complianceGrade}]`;
        } else {
          complianceLabel = ` (grade ${server.complianceGrade} — below MCPH_MIN_COMPLIANCE=${minCompliance}, won't auto-activate)`;
        }
      }

      lines.push(
        `  ${server.namespace} — ${server.name} [${status}] (${server.type})${relevance}${costLabel}${complianceLabel}`,
      );

      const shadow = formatShadowLine(server);
      if (shadow) lines.push(`    ${shadow}`);

      // Surface recent unreliability so the LLM can prefer a healthier
      // alternative. Session-local; activation failures take precedence
      // over per-call error rate (see formatHealthWarning).
      const warning = formatHealthWarning(connection?.health, this.activationFailures.get(server.namespace));
      if (warning) lines.push(`    ${warning}`);

      // Inline usage hint — cumulative success count + who tends to
      // get loaded alongside this server. Counts come from state.json
      // (persistence.ts) so they carry across mcph restarts. Silent
      // when neither signal has evidence yet. See usage-hints.ts.
      const usageHint = formatUsageHint(this.learning.get(server.namespace), coUsageMap.get(server.namespace) ?? []);
      if (usageHint) lines.push(`    ${usageHint}`);

      // Show cached tool names for servers that aren't currently connected
      if (!connection) {
        const cached = this.toolCache.get(server.namespace) ?? server.toolCache;
        if (cached && cached.length > 0) {
          const toolNames = cached.map((t) => t.name).join(", ");
          lines.push(`    known tools: ${toolNames}`);
        }
      }
    }

    // Overlapping tools block — detect bare tool names that appear in
    // ≥2 currently-connected servers. Dormant/installed-but-not-connected
    // servers are excluded; we only have live schemas for connected ones.
    // Capped at the top 5 overlaps (by namespace count desc, bare-name
    // alphabetical tie-break) to keep output bounded. Suppressed entirely
    // when no overlaps exist.
    const overlaps = computeToolOverlaps(this.connections.values());
    if (overlaps.length > 0) {
      lines.push("\nOverlapping tools (same bare name in multiple servers):");
      const top = overlaps.slice(0, 5);
      for (let i = 0; i < top.length; i++) {
        const o = top[i];
        const suffix = i === 0 ? " (use mcp_connect_dispatch to disambiguate)" : "";
        lines.push(`  ${o.bareName} — available in: ${o.namespaces.join(", ")}${suffix}`);
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
    // Count EXPOSED tools (post-filter) so the summary matches what
    // tools/list actually hands the client — hidden tools don't spend
    // context even though the upstream exposes them.
    const totalTools = Array.from(this.connections.values()).reduce((sum, c) => {
      const f = this.toolFilters.get(c.config.namespace);
      return sum + (f ? c.tools.filter((t) => f.has(t.name)).length : c.tools.length);
    }, 0);
    const tokenSummary = totalContextTokens > 0 ? ` (~${totalContextTokens.toLocaleString()} tokens)` : "";
    lines.push(`\n${activeCount} loaded in this session, ${totalTools} tools in context${tokenSummary}.`);
    lines.push(
      context
        ? "Use mcp_connect_dispatch(intent) to load the best server in one step, or mcp_connect_activate to pick explicitly."
        : "Use mcp_connect_activate to load a server's tools by namespace.",
    );

    // Marketplace hint — steer sparse-config users to the catalog without
    // nagging power users. Threshold counts installed servers (active +
    // inactive) in the user's config; anyone under the cutoff gets a
    // one-line pointer at https://mcp.hosting/explore. No backend API is
    // hit — the catalog is a human-browsable SPA, so this is a URL hint,
    // not a full meta-tool.
    if (this.config.servers.length < ConnectServer.MARKETPLACE_HINT_THRESHOLD) {
      lines.push(
        "Browse the mcph catalog at https://mcp.hosting/explore — add any server from there to your mcph account and it will appear here within 60s.",
      );
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Activate a single server by namespace. Shared by handleActivate,
  // handleDispatch, and handleDiscoverWithAutoWarm so error handling,
  // retries, caching, and tool-report round-trips live in one place.
  //
  // Dedup guarantee: two concurrent callers for the same namespace
  // share one in-flight activation. Without this, a tool call landing
  // on a disconnected upstream while another tool call was already
  // trying to reactivate the same namespace would spawn a duplicate
  // child process; the second set() would win and the first would leak
  // until its transport noticed. See activationInflight.
  //
  // Returns:
  //   { ok: true, message } — already connected or newly connected
  //   { ok: false, message, isChanged: false } — failed or not in config
  private activateOne(
    namespace: string,
    progress?: ProgressReporter,
  ): Promise<{ ok: boolean; message: string; isChanged: boolean; serverId?: string }> {
    const inflight = this.activationInflight.get(namespace);
    if (inflight) {
      progress?.(`"${namespace}" load already in flight — awaiting existing attempt`);
      return inflight;
    }
    const promise = this.runActivateOne(namespace, progress).finally(() => {
      // Clear only if this promise is still the registered one. If a
      // retry path (maybeElicitAndRetry → activateOne) has already
      // registered a follow-up, leave that one in place.
      if (this.activationInflight.get(namespace) === promise) {
        this.activationInflight.delete(namespace);
      }
    });
    this.activationInflight.set(namespace, promise);
    return promise;
  }

  private async runActivateOne(
    namespace: string,
    progress?: ProgressReporter,
  ): Promise<{ ok: boolean; message: string; isChanged: boolean; serverId?: string }> {
    const existing = this.connections.get(namespace);
    if (existing && existing.status === "connected") {
      progress?.(`"${namespace}" already loaded`);
      return {
        ok: true,
        isChanged: false,
        message: `"${namespace}" is already loaded with ${existing.tools.length} tools.`,
        serverId: existing.config.id,
      };
    }

    const serverConfig = this.config?.servers.find((s) => s.namespace === namespace && s.isActive);
    if (!serverConfig) {
      return { ok: false, isChanged: false, message: `"${namespace}" not found or disabled.` };
    }

    if (!profileAllows(this.profile, namespace)) {
      return {
        ok: false,
        isChanged: false,
        message: `"${namespace}" is not allowed by the project profile at ${this.profile?.path}.`,
      };
    }

    // Concurrent-load cap. Connected servers count; error-state
    // connections don't, because they aren't contributing tools to
    // the LLM's context. We compute the slot list fresh here — it's
    // cheap (Map iteration) and guaranteed to reflect state after
    // any auto-unloads that fired between the check and this call.
    const loadedSlots: LoadedSlot[] = [];
    for (const [ns, conn] of this.connections) {
      if (conn.status === "connected") {
        loadedSlots.push({ namespace: ns, idleCount: this.idleCallCounts.get(ns) ?? 0 });
      }
    }
    const capDecision = evaluateServerCap(namespace, loadedSlots, this.serverCap);
    if (!capDecision.allow) {
      return { ok: false, isChanged: false, message: capDecision.message ?? "Concurrent server cap reached." };
    }

    // Merge any session-elicited env over the server's configured env.
    // Elicited values only apply inside this mcph process lifetime.
    const elicited = this.elicitedEnv.get(namespace);
    const effectiveConfig = elicited ? { ...serverConfig, env: { ...serverConfig.env, ...elicited } } : serverConfig;

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        progress?.(
          attempt === 0 ? `Spawning "${namespace}" upstream…` : `Retrying "${namespace}" (attempt ${attempt + 1})…`,
        );
        const connection = await connectToUpstream(
          effectiveConfig,
          this.onUpstreamDisconnect,
          this.onUpstreamListChanged,
        );
        progress?.(`"${namespace}" loaded ${connection.tools.length} tools`);
        this.connections.set(namespace, connection);
        this.idleCallCounts.set(namespace, 0);
        const toolMeta = connection.tools.map((t) => ({ name: t.name, description: t.description }));
        this.toolCache.set(namespace, toolMeta);

        // Persist the tool list so inactive servers can still be ranked
        // on cold starts. Fire-and-forget — failure is non-fatal.
        if (toolMeta.length > 0) {
          reportTools(serverConfig.id, toolMeta).catch((err: Error) =>
            log("warn", "reportTools failed", { namespace, error: err?.message }),
          );
        }

        const toolNames = connection.tools.map((t) => t.namespacedName).join(", ");
        // Activation succeeded — clear any stale penalty so a recovered
        // server isn't permanently demoted for a transient past failure.
        this.activationFailures.delete(namespace);
        return {
          ok: true,
          isChanged: true,
          serverId: serverConfig.id,
          message: `Loaded "${namespace}" — ${connection.tools.length} tools: ${toolNames}`,
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

    // Before giving up, see if the failure looks like a missing credential
    // and the client supports elicitation. If both hold, ask the user for
    // the missing values and retry exactly once — one round-trip max.
    //
    // Guarded by the haven't-just-tried-this-credential check: if elicited
    // values are already present for every detected name, don't ask twice.
    const elicitedRetry = await this.maybeElicitAndRetry(namespace, lastError, progress);
    if (elicitedRetry) return elicitedRetry;

    log("error", "Failed to activate upstream", {
      namespace,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });

    // Record the failure so dispatch down-ranks this namespace for a
    // few minutes. The TTL is short enough that a fixed server (user
    // edited dashboard env, for example) recovers quickly on next poll.
    this.activationFailures.set(namespace, {
      at: Date.now(),
      message: lastError instanceof Error ? lastError.message : String(lastError),
    });

    // Prefer the ActivationError's message (includes stderr tail + category
    // hint) over the raw SDK error. Falls back cleanly for transport errors.
    const message =
      lastError instanceof ActivationError
        ? `Failed to load "${namespace}": ${lastError.message}`
        : `Failed to load "${namespace}": ${lastError instanceof Error ? lastError.message : String(lastError)}`;
    return { ok: false, isChanged: false, message };
  }

  // If the activation error names a missing credential (e.g. "GITHUB_TOKEN
  // is required") AND the client supports elicitation, ask the user for
  // the values inline and retry activation once. Returns the retry result
  // on success, or null when we can't/shouldn't elicit. Single-round only —
  // we don't want to pester the user with a loop on every retry failure.
  private async maybeElicitAndRetry(
    namespace: string,
    lastError: unknown,
    progress?: ProgressReporter,
  ): Promise<{ ok: boolean; message: string; isChanged: boolean; serverId?: string } | null> {
    const stderr = lastError instanceof ActivationError ? lastError.stderrTail : undefined;
    const errMessage = lastError instanceof Error ? lastError.message : String(lastError);
    const haystack = [stderr, errMessage].filter(Boolean).join("\n");
    const missing = detectMissingCredentials(haystack);
    if (missing.length === 0) return null;

    // Skip if we've already elicited these exact values — that means we
    // already tried with the user's input and it still failed, so more
    // prompting won't help.
    const alreadyElicited = this.elicitedEnv.get(namespace);
    if (alreadyElicited && missing.every((k) => k in alreadyElicited)) return null;

    const caps = this.server.getClientCapabilities();
    if (!caps?.elicitation) {
      log("info", "Detected missing credentials but client does not support elicitation", {
        namespace,
        missing,
      });
      return null;
    }

    // Build an object-schema elicitation with one string field per missing
    // credential. Descriptions are minimal on purpose — we don't know the
    // semantic purpose of each env var.
    const properties: Record<string, { type: "string"; title: string; description: string }> = {};
    for (const key of missing) {
      properties[key] = {
        type: "string",
        title: key,
        description: `The value for ${key} required by "${namespace}". Stored only for this mcph session.`,
      };
    }

    progress?.(`Asking for ${missing.length === 1 ? "credential" : "credentials"}: ${missing.join(", ")}`);

    let result: Awaited<ReturnType<Server["elicitInput"]>>;
    try {
      result = await this.server.elicitInput({
        message: `"${namespace}" can't start without ${missing.join(", ")}. Provide ${missing.length === 1 ? "it" : "them"} to retry, or decline to cancel.`,
        requestedSchema: {
          type: "object",
          properties,
          required: missing,
        },
      });
    } catch (err) {
      log("warn", "Elicitation request failed", {
        namespace,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    if (result.action !== "accept" || !result.content) {
      log("info", "User declined credential elicitation", { namespace, action: result.action });
      return null;
    }

    const values: Record<string, string> = {};
    for (const key of missing) {
      const v = result.content[key];
      if (typeof v === "string" && v.length > 0) values[key] = v;
    }
    if (Object.keys(values).length === 0) return null;

    this.elicitedEnv.set(namespace, { ...alreadyElicited, ...values });
    progress?.("Got credentials — retrying load");
    // Recurse — runActivateOne merges elicitedEnv on this attempt.
    // Call runActivateOne directly (not activateOne) because we're
    // already inside the in-flight activation promise registered by
    // activateOne; going through the wrapper again would deadlock on
    // our own entry in activationInflight.
    return this.runActivateOne(namespace, progress);
  }

  private async handleActivate(
    namespaces: string[],
    progress?: ProgressReporter,
    toolsFilter?: string[],
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    if (namespaces.length === 0) {
      return {
        content: [
          { type: "text", text: "server namespace is required. Use mcp_connect_discover to see installed servers." },
        ],
        isError: true,
      };
    }

    // Apply per-tool filter rules BEFORE activation so the first
    // list-changed notification reflects the intended filtered surface.
    //   - tools provided + exactly 1 namespace → replace filter for it.
    //   - tools not provided (or multi-server activate) → clear the
    //     filter for each touched namespace so re-activating without
    //     `tools` always exposes the full set.
    let filtersChanged = false;
    if (toolsFilter && namespaces.length === 1) {
      const ns = namespaces[0];
      // Dedup + drop empty strings. If the resulting set is empty we
      // clear the filter rather than hide EVERYTHING — an empty array
      // is almost certainly the model meaning "no filter".
      const names = new Set(toolsFilter.map((t) => t.trim()).filter((t) => t.length > 0));
      const prev = this.toolFilters.get(ns);
      if (names.size === 0) {
        if (prev) {
          this.toolFilters.delete(ns);
          filtersChanged = true;
        }
      } else {
        // Compare sets by size + membership to decide whether the
        // tools/list surface actually moved. Prevents a spurious
        // list_changed notification when the same filter is re-sent.
        const same = prev && prev.size === names.size && [...names].every((n) => prev.has(n));
        if (!same) {
          this.toolFilters.set(ns, names);
          filtersChanged = true;
        }
      }
    } else {
      for (const ns of namespaces) {
        if (this.toolFilters.delete(ns)) filtersChanged = true;
      }
    }

    const results: string[] = [];
    let anyChanged = false;
    let anyError = false;

    // Compliance gate. When MCPH_MIN_COMPLIANCE is set, refuse to
    // activate any server whose reported grade is below the floor.
    // Ungraded servers always pass — see passesMinCompliance. Parsed
    // once per handleActivate call so a mid-session env change takes
    // effect on the next activation, not after a restart.
    const minCompliance = resolveMinCompliance();

    const total = namespaces.length;
    let i = 0;
    for (const namespace of namespaces) {
      i += 1;
      if (minCompliance !== null) {
        const cfg = this.config?.servers.find((s) => s.namespace === namespace);
        if (cfg && !passesMinCompliance(cfg.complianceGrade, minCompliance)) {
          const grade = cfg.complianceGrade ?? "unknown";
          const message = `Refused to load "${namespace}": compliance grade ${grade} is below MCPH_MIN_COMPLIANCE=${minCompliance}. Unset MCPH_MIN_COMPLIANCE (or lower it) to override.`;
          results.push(message);
          anyError = true;
          continue;
        }
      }
      progress?.(`Loading ${namespace} (${i}/${total})`, i - 1, total);
      const r = await this.activateOne(namespace, progress);
      results.push(r.message);
      if (r.isChanged) anyChanged = true;
      if (!r.ok) anyError = true;
    }
    // NB: no trailing "Done" progress notification here. MCP clients
    // delete the progress token synchronously when the response arrives,
    // but notification handlers run as microtasks — so a progress sent
    // right before the response loses a race with _onresponse cleanup
    // and arrives at a token the client has already freed. That looks
    // like a fatal "unknown token" error to Claude Code and drops the
    // whole transport. The response itself IS the completion signal;
    // the tail-end progress would be redundant anyway.

    if (anyChanged) {
      this.rebuildRoutes();
      await this.notifyAllListsChanged();
    } else if (filtersChanged) {
      // Filter changed on an already-connected server — routes are
      // unchanged (dispatch still reaches hidden tools) but the
      // tools/list surface moved, so notify the client to re-list.
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
    progress?: ProgressReporter,
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
        content: [{ type: "text", text: "No servers installed. Add servers at mcp.hosting to get started." }],
        isError: true,
      };
    }

    const activeServers = this.getProfiledActiveServers();
    if (activeServers.length === 0) {
      const note = this.profile
        ? ` (project profile at ${this.profile.path} restricts which servers are available)`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `No servers enabled${note}. Enable servers at mcp.hosting or re-run mcp_connect_discover.`,
          },
        ],
        isError: true,
      };
    }

    progress?.(`Ranking ${activeServers.length} servers…`);
    // Two-stage: local BM25 filters to a shortlist, /api/connect/rerank
    // semantically reorders it via Voyage. Falls back to BM25 alone when
    // rerank is off or times out, so dispatch is robust in every mode.
    const rankedRaw = await this.twoStageRank(trimmed, activeServers);
    // Apply health-aware penalty: recent activation failures and high
    // error rates shrink the score so dispatch prefers working servers
    // when multiple match. Never boosts above raw score — all else
    // equal, prefer the one that works.
    const ranked = rankedRaw
      .map((r) => ({
        namespace: r.namespace,
        score:
          r.score *
          healthFactor(this.connections.get(r.namespace)?.health, this.activationFailures.get(r.namespace)) *
          this.learning.boostFactor(r.namespace),
      }))
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No installed server matches "${trimmed}". Use mcp_connect_discover to see what's installed, or add a relevant server at mcp.hosting.`,
          },
        ],
        isError: true,
      };
    }

    // Sampling tiebreak: when BM25+rerank+health rank the top-2
    // candidates within a close margin, ask the client LLM to choose.
    // Uses the same model the user is already running — no extra
    // provider key, no extra cost from mcph's side. Silently skips if
    // the client doesn't advertise the sampling capability.
    if (budget === 1 && shouldTiebreak(ranked)) {
      progress?.("Top candidates close — asking LLM to pick…");
      const serversByNamespace = new Map(activeServers.map((s) => [s.namespace, s]));
      const candidates = buildCandidates(ranked.slice(0, 3), serversByNamespace, this.toolCache);
      const picked = await tiebreakViaSampling(this.server, trimmed, candidates);
      if (picked) {
        const winner = ranked.find((r) => r.namespace === picked);
        if (winner) {
          // Re-sort so the LLM's pick sits at position 0; preserve the
          // rest of the order so budget>1 callers still see a stable list.
          const rest = ranked.filter((r) => r.namespace !== picked);
          ranked.length = 0;
          ranked.push(winner, ...rest);
          progress?.(`LLM chose ${picked}`);
        }
      }
    }

    const safeBudget = Math.max(1, Math.min(10, Math.floor(budget)));
    const winners = ranked.slice(0, safeBudget);

    const results: string[] = [];
    let anyChanged = false;
    let anyError = false;

    let i = 0;
    for (const winner of winners) {
      i += 1;
      progress?.(`Loading ${winner.namespace} (${i}/${winners.length})`, i - 1, winners.length);
      const r = await this.activateOne(winner.namespace, progress);
      results.push(`${winner.namespace} (score ${winner.score.toFixed(2)}): ${r.message}`);
      if (r.isChanged) anyChanged = true;
      if (!r.ok) anyError = true;
      // Treat a successful activation as a positive dispatch signal.
      // Actual tool-call success is tracked via trackUsageAndAutoDeactivate
      // on the proxy path, so dispatch-success is the right granularity
      // here — we're grading the routing decision, not the tool call.
      this.learning.recordDispatch(winner.namespace);
      if (r.ok) this.learning.recordSuccess(winner.namespace);
      this.scheduleStateSave();
    }
    // No trailing "Dispatch complete" progress — see handleActivate for
    // the client-side race this avoids.

    if (anyChanged) {
      this.rebuildRoutes();
      await this.notifyAllListsChanged();
    }

    const header = `Dispatched "${trimmed}" — loaded top ${winners.length} of ${ranked.length} matching server${ranked.length === 1 ? "" : "s"}.\n`;
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
        results.push(`"${namespace}" wasn't loaded.`);
        continue;
      }

      await disconnectFromUpstream(connection);
      this.connections.delete(namespace);
      this.idleCallCounts.delete(namespace);
      this.adaptiveSkipLogged.delete(namespace);
      this.toolFilters.delete(namespace);
      anyChanged = true;
      results.push(`Unloaded "${namespace}". Tools removed from context.`);
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
    // Record this call in the rolling history BEFORE computing per-ns
    // thresholds — so adaptive bonuses reflect the fact we just called
    // this namespace (protects it from deactivation on a back-to-back
    // burst where another ns happens to tick over the baseline).
    pushToolCall(this.recentToolCalls, { namespace: calledNamespace, at: Date.now() }, HISTORY_LIMIT);
    // Reset idle count for the server that was just called, and forget
    // any previous "we already logged the patience message for you"
    // marker — the next time it goes idle we want a fresh log.
    this.idleCallCounts.set(calledNamespace, 0);
    this.adaptiveSkipLogged.delete(calledNamespace);

    // Increment idle count for all OTHER active servers
    for (const ns of this.connections.keys()) {
      if (ns !== calledNamespace) {
        this.idleCallCounts.set(ns, (this.idleCallCounts.get(ns) ?? 0) + 1);
      }
    }

    // Auto-deactivate servers that have been idle too long, using an
    // adaptive per-namespace threshold so bursty upstreams get more
    // patience. The baseline is the static IDLE_CALL_THRESHOLD (env
    // var-overridable); the adaptive function adds a bonus based on
    // that namespace's recent activity.
    const toDeactivate: string[] = [];
    for (const [ns, idleCount] of this.idleCallCounts) {
      if (!this.connections.has(ns)) continue;
      const threshold = adaptiveThreshold(ns, this.recentToolCalls, ConnectServer.IDLE_CALL_THRESHOLD);
      if (idleCount >= threshold) {
        toDeactivate.push(ns);
      } else if (idleCount >= ConnectServer.IDLE_CALL_THRESHOLD && !this.adaptiveSkipLogged.has(ns)) {
        // We would have deactivated under the static threshold but the
        // adaptive bonus is keeping this ns alive. Log once per ns so
        // users can see the mechanism doing its job, then stay quiet.
        log("info", "Adaptive idle patience keeping bursty upstream alive", {
          namespace: ns,
          idleCalls: idleCount,
          baseline: ConnectServer.IDLE_CALL_THRESHOLD,
          adaptiveThreshold: threshold,
        });
        this.adaptiveSkipLogged.add(ns);
      }
    }

    for (const ns of toDeactivate) {
      log("info", "Auto-deactivating idle server", { namespace: ns, idleCalls: this.idleCallCounts.get(ns) });
      const connection = this.connections.get(ns);
      if (connection) {
        await disconnectFromUpstream(connection);
        this.connections.delete(ns);
        this.idleCallCounts.delete(ns);
        this.adaptiveSkipLogged.delete(ns);
        this.toolFilters.delete(ns);
      }
    }

    if (toDeactivate.length > 0) {
      this.rebuildRoutes();
      await this.notifyAllListsChanged();
    }
  }

  private async fetchAndApplyConfig(): Promise<void> {
    // Evict expired activation failures. healthFactor() checks the TTL
    // at read-time, so stale entries never produce a wrong penalty —
    // but without a sweep the map grows unbounded across a long
    // session. Piggyback the sweep on each poll so it costs nothing
    // extra.
    this.pruneExpiredActivationFailures();

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

    // Swap the config reference BEFORE reconcileConfig awaits. Other
    // handlers (handleActivate, handleDispatch, handleDiscover) read
    // this.config synchronously and can interleave at every await
    // point below. With the old order, a caller in the middle of
    // reconcile would see the stale config — and could try to
    // activate a namespace that's about to be disconnected, racing
    // the reconcile. Setting config first means readers see the
    // intended-future state; the connection map is the authority for
    // "what's actually running" and catches up shortly after.
    this.config = newConfig;
    this.configVersion = newConfig.configVersion;
    await this.reconcileConfig(newConfig);
  }

  private pruneExpiredActivationFailures(now: number = Date.now()): void {
    for (const [ns, failure] of this.activationFailures) {
      if (now - failure.at > ACTIVATION_FAILURE_TTL_MS) {
        this.activationFailures.delete(ns);
      }
    }
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
        this.adaptiveSkipLogged.delete(namespace);
        this.toolFilters.delete(namespace);
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
        this.adaptiveSkipLogged.delete(namespace);
        this.toolFilters.delete(namespace);
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

    // Security: only allow known MCP config filenames. The check must
    // run on the RESOLVED path's basename, not the caller-supplied
    // string — otherwise `some/dir/mcp.json/../../../etc/passwd` would
    // have basename "passwd" and correctly fail, but a path like
    // `/weird/place/claude_desktop_config.json` would succeed at the
    // basename check even though the intent was to restrict reads to
    // well-known MCP config locations. Computing the basename on
    // `resolved` normalizes `..` segments and handles ~ expansion
    // before we decide whether the file is allowed.
    const ALLOWED_FILENAMES = ["claude_desktop_config.json", "mcp.json", "settings.json", "mcp_config.json"];

    try {
      const resolved =
        filepath.startsWith("~/") || filepath.startsWith("~\\")
          ? resolve(homedir(), filepath.slice(2))
          : resolve(filepath);
      const resolvedBasename = resolved.split(/[/\\]/).pop() || "";
      if (!ALLOWED_FILENAMES.includes(resolvedBasename)) {
        return {
          content: [
            {
              type: "text",
              text: `Only MCP config files are allowed: ${ALLOWED_FILENAMES.join(", ")}. Got: ${resolvedBasename}`,
            },
          ],
          isError: true,
        };
      }
      // Scope the file read to the user's home dir OR cwd. The
      // basename allowlist above stops arbitrary reads from proving
      // contents, but a caller can still probe for file existence at
      // odd paths (e.g. `/var/log/claude_desktop_config.json`). All
      // legitimate imports live under home (Claude Desktop configs)
      // or cwd (project-local `.mcp.json`), so anything outside both
      // is almost certainly an oracle probe — refuse it.
      //
      // `path.relative` returns an absolute-looking string when the
      // two paths sit on different Windows drives (no relative-traversal
      // between C: and D: exists), so the `..`-prefix check alone
      // isn't enough on Windows — also treat an absolute return value
      // as "outside".
      const isUnder = (base: string, p: string) => {
        const rel = relative(base, p);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      };
      if (!isUnder(homedir(), resolved) && !isUnder(process.cwd(), resolved)) {
        return {
          content: [
            { type: "text", text: "Import path must be under your home directory or the current working directory." },
          ],
          isError: true,
        };
      }
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
      await this.fetchAndApplyConfig().catch((err: Error) =>
        log("warn", "Post-import config refresh failed", { error: err?.message }),
      );

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

  // Install a new MCP server on the user's mcp.hosting account. Validates
  // via the shared buildInstallPayload helper so local/remote + namespace
  // shape errors fail here with a clear message instead of burning a
  // round-trip to the backend. On 403 plan-limit we forward the structured
  // error body verbatim (JSON) — the model surfaces that to the user so
  // the upgrade URL is visible in chat. On 201 we force a config refetch
  // so `discover` sees the new namespace without waiting for the 60s
  // poll.
  private async handleInstall(
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const built = buildInstallPayload(args);
    if (!built.ok) {
      return { content: [{ type: "text", text: built.message }], isError: true };
    }
    const payload = built.payload;

    try {
      const res = await request(`${this.apiUrl.replace(/\/$/, "")}/api/connect/servers`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
      });

      let body: any;
      try {
        body = await res.body.json();
      } catch {
        body = {};
      }

      // Plan-cap: forward the backend's structured body so the model can
      // render the upgrade URL. Returning the JSON verbatim is the
      // load-bearing bit of the mcph install-tool contract — see
      // buildPlanLimitExceededError in mcp-hosting/src/lib/plans.ts.
      if (res.statusCode === 403 && body && body.code === "plan_limit_exceeded") {
        return {
          content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
          isError: true,
        };
      }

      if (res.statusCode === 409) {
        return {
          content: [
            {
              type: "text",
              text: `Namespace "${payload.namespace}" is already installed. Use mcp_connect_activate to load its tools, or pick a different namespace.`,
            },
          ],
          isError: true,
        };
      }

      if (res.statusCode >= 400) {
        return {
          content: [{ type: "text", text: `Install failed: ${body.error || `HTTP ${res.statusCode}`}` }],
          isError: true,
        };
      }

      // Refresh config so the new server shows up in discover immediately.
      // Race against a 3s timeout — if the backend is slow, the install
      // itself already succeeded and the next 60s poll will catch the new
      // namespace; better to return than hang the tool call. If the race
      // loses, we tell the model to expect a brief delay so it doesn't
      // immediately call activate on a namespace the client hasn't seen.
      let configFresh = true;
      try {
        await Promise.race([
          this.fetchAndApplyConfig(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("refresh timeout")), 3000)),
        ]);
      } catch (err) {
        configFresh = false;
        log("warn", "Post-install config refresh failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const activateCall = `mcp_connect_activate({ server: "${payload.namespace}" })`;
      const activateHint = configFresh
        ? `Call ${activateCall} to load its tools${payload.type === "local" ? " into this session" : ""}.`
        : `The new server will appear in mcp_connect_discover within ~60s. If the first ${activateCall} reports an unknown namespace, wait a minute and retry.`;
      return {
        content: [
          {
            type: "text",
            text: `Installed "${payload.name}" (namespace "${payload.namespace}"). ${activateHint}`,
          },
        ],
      };
    } catch (err: unknown) {
      // Map the raw undici/network error to a user-facing string instead
      // of leaking `err.message` verbatim to the model. We keep the raw
      // error in the log for ops debugging but don't surface node error
      // codes or stack fragments to the LLM/user.
      const code =
        typeof err === "object" && err !== null
          ? (err as { code?: string; cause?: { code?: string } }).code || (err as any).cause?.code
          : undefined;
      let text: string;
      if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
        text = "Install timed out talking to mcp.hosting. Retry in a moment.";
      } else if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "UND_ERR_SOCKET") {
        text = "Couldn't reach mcp.hosting (network unreachable or DNS failure). Check your connection and retry.";
      } else {
        text = "Install failed unexpectedly. Check mcph logs on this machine for the underlying error.";
      }
      log("warn", "handleInstall error", {
        error: err instanceof Error ? err.message : String(err),
        code,
      });
      return { content: [{ type: "text", text }], isError: true };
    }
  }

  // Signature-on-demand: return one tool's full input schema without
  // persistently activating its server. When the server is already
  // loaded we read from the in-memory connection. When it isn't, we
  // spawn a transient upstream, extract the tool, and disconnect. The
  // transient path does NOT register the connection in this.connections
  // or toolRoutes — `mcp_connect_health` and `tools/list` stay unchanged
  // so the caller's context doesn't grow until they commit via activate.
  private async handleReadTool(
    serverArg: string,
    toolArg: string,
    progress?: ProgressReporter,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    if (!serverArg) {
      return {
        content: [{ type: "text", text: "`server` is required (namespace of an installed MCP server)." }],
        isError: true,
      };
    }
    if (!toolArg) {
      return { content: [{ type: "text", text: "`tool` is required (name of the tool to inspect)." }], isError: true };
    }

    const serverConfig = this.config?.servers.find((s) => s.namespace === serverArg && s.isActive);
    if (!serverConfig) {
      return {
        content: [
          {
            type: "text",
            text: `"${serverArg}" is not installed on this account. Call mcp_connect_discover to list available servers.`,
          },
        ],
        isError: true,
      };
    }

    const toolName = normalizeToolName(serverArg, toolArg);

    // Fast path: server already loaded. Schema is already in context,
    // no network cost.
    const existing = this.connections.get(serverArg);
    if (existing && existing.status === "connected") {
      const tool = findTool(existing.tools, toolName);
      if (!tool) {
        return {
          content: [{ type: "text", text: formatToolNotFound(serverConfig, toolName, existing.tools) }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: formatReadToolOutput({ tool, server: serverConfig, loaded: true }),
          },
        ],
      };
    }

    // Slow path: transient connect. Same spawn cost as activate, but
    // we tear down immediately after reading the tool list so the
    // server doesn't linger in the session.
    progress?.(`Inspecting "${serverArg}" (transient — not loading into session)…`);
    let transient: UpstreamConnection | undefined;
    try {
      transient = await connectToUpstream(serverConfig);
    } catch (err) {
      const message = err instanceof ActivationError ? err.message : err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: `Could not connect to "${serverArg}" to read tool schema: ${message}`,
          },
        ],
        isError: true,
      };
    }

    try {
      const tool = findTool(transient.tools, toolName);
      if (!tool) {
        return {
          content: [{ type: "text", text: formatToolNotFound(serverConfig, toolName, transient.tools) }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: formatReadToolOutput({ tool, server: serverConfig, loaded: false }),
          },
        ],
      };
    } finally {
      // Tear the transient connection down no matter what happened
      // above. Leaving it open would silently promote "read tool"
      // into "activate", which is exactly what this meta-tool exists
      // to avoid.
      await disconnectFromUpstream(transient).catch((e) =>
        log("warn", "transient disconnect after read_tool failed", {
          namespace: serverArg,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  private handleHealth(): { content: Array<{ type: string; text: string }> } {
    const lines: string[] = [];
    if (this.profile) {
      // Label depends on which sources were loaded. If userPath is set,
      // both a project-local and a user-global profile contributed; show
      // both so it's obvious what's applied. Otherwise it's one or the
      // other — we can't tell which from `path` alone, so the generic
      // "Profile:" label covers both cases.
      if (this.profile.userPath) {
        lines.push(`Project profile: ${this.profile.path}`);
        lines.push(`User profile:    ${this.profile.userPath}`);
      } else {
        lines.push(`Profile: ${this.profile.path}`);
      }
      if (this.profile.servers?.length) lines.push(`  allow: ${this.profile.servers.join(", ")}`);
      if (this.profile.blocked?.length) lines.push(`  block: ${this.profile.blocked.join(", ")}`);
      lines.push("");
    }

    if (this.connections.size === 0) {
      lines.push("No servers loaded in this session yet.");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    lines.push("Session health:\n");

    for (const [namespace, conn] of this.connections) {
      const h = conn.health;
      const avgLatency = h.totalCalls > 0 ? Math.round(h.totalLatencyMs / h.totalCalls) : 0;
      const errorRate = h.totalCalls > 0 ? Math.round((h.errorCount / h.totalCalls) * 100) : 0;
      const idleCount = this.idleCallCounts.get(namespace) ?? 0;
      const idleLimit = adaptiveThreshold(namespace, this.recentToolCalls, ConnectServer.IDLE_CALL_THRESHOLD);
      const toolNames = conn.tools.map((t) => t.name).join(", ");

      lines.push(`  ${namespace} [${conn.status}] (${conn.config.type})`);
      lines.push(`    tools: ${conn.tools.length} — ${toolNames}`);
      lines.push(`    calls: ${h.totalCalls}, errors: ${h.errorCount} (${errorRate}%)`);
      lines.push(`    avg latency: ${avgLatency}ms`);
      lines.push(`    idle: ${idleCount}/${idleLimit} until auto-unload`);
      if (h.lastErrorMessage) {
        lines.push(`    last error: ${h.lastErrorMessage} at ${h.lastErrorAt}`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Pack suggestion. Surfaces recurring multi-server tool-call sequences
  // observed in this session. Observation only — never activates
  // anything. Ranked by frequency primarily, with recency as a tiebreak
  // so the hottest-most-recent pattern sits at the top.
  private handleSuggest(): { content: Array<{ type: string; text: string }> } {
    const detected = this.packDetector.detectChains();
    if (detected.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No recurring multi-server patterns yet. Keep using tools across servers — once the same 2-3 server combination recurs in quick succession, it will show up here as a suggested pack.",
          },
        ],
      };
    }

    // Rank by frequency (primary) then recency (secondary). Both matter:
    // a pattern that repeated 5 times hours ago still beats one that
    // repeated twice last minute, but at equal frequency fresher wins.
    const ranked = [...detected].sort((a, b) => {
      if (b.frequency !== a.frequency) return b.frequency - a.frequency;
      return b.lastSeenAt - a.lastSeenAt;
    });

    const lines: string[] = [
      // Pack history carries across mcph restarts (see persistence.ts),
      // so "recurring" isn't scoped to the live process — don't over
      // -claim with "this session" here.
      `Detected ${ranked.length} recurring server pack${ranked.length === 1 ? "" : "s"}:\n`,
    ];
    for (const pack of ranked) {
      const nsList = pack.namespaces.join(", ");
      const secondsAgo = Math.max(0, Math.round((Date.now() - pack.lastSeenAt) / 1000));
      lines.push(`  {${nsList}} — seen ${pack.frequency} times (last ${secondsAgo}s ago)`);
    }
    // Nudge toward the concrete action. `mcp_connect_activate` is the
    // loading meta-tool — `dispatch` is for invoking tools on servers
    // that are already active, so pointing at dispatch here used to
    // send the model the wrong direction.
    const top = ranked[0];
    const nsJson = JSON.stringify(top.namespaces);
    lines.push(`\nTo load the top pack in one step, call \`mcp_connect_activate\` with namespaces=${nsJson}.`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Curated multi-server bundles. Static client-side data (see bundles.ts)
  // — no network call. `action=list` prints every bundle with a ready-to-
  // run `mcp_connect_activate` snippet; `action=match` cross-references
  // the installed server list and partitions into fully-ready vs
  // partially-installed so the caller only sees bundles that are actually
  // actionable on this account.
  private handleBundles(action: "list" | "match"): { content: Array<{ type: string; text: string }> } {
    if (action === "list") {
      const lines: string[] = [`Curated server bundles (${CURATED_BUNDLES.length}):\n`];
      for (const bundle of CURATED_BUNDLES) {
        lines.push(`  ${bundle.id} — ${bundle.description}`);
        lines.push(`    namespaces: ${JSON.stringify(bundle.namespaces)}`);
        lines.push(`    activate: ${bundleActivateHint(bundle)}`);
      }
      lines.push("");
      lines.push(
        'Call mcp_connect_bundles with action="match" to filter these against servers already installed on this account.',
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // action === "match"
    const installedNamespaces = this.getProfiledActiveServers().map((s) => s.namespace);
    const { ready, partial } = matchBundles(installedNamespaces);

    if (ready.length === 0 && partial.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No curated bundles match your currently installed servers. Browse https://mcp.hosting/explore to add the servers a bundle needs, then re-run mcp_connect_bundles.",
          },
        ],
      };
    }

    const lines: string[] = [];

    if (ready.length > 0) {
      lines.push("Bundles ready to activate now:");
      for (const bundle of ready) {
        lines.push(`  ${bundle.id} — ${bundle.description}`);
        lines.push(`    namespaces: ${JSON.stringify(bundle.namespaces)}`);
        lines.push(`    activate: ${bundleActivateHint(bundle)}`);
      }
    }

    if (partial.length > 0) {
      if (ready.length > 0) lines.push("");
      lines.push("Bundles partially installed:");
      for (const entry of partial) {
        const { bundle, have, missing } = entry;
        lines.push(`  ${bundle.id} — ${bundle.description}`);
        lines.push(`    have: ${have.join(", ")}`);
        lines.push(`    missing: ${missing.join(", ")} (install from https://mcp.hosting/explore)`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Declarative pipeline executor. Runs N tool calls in order, binding
  // each output under the step's id (or positional index), and lets
  // later steps splice those outputs into their args via
  // `{"$ref": "<id>.path"}` markers. No eval, no expression language —
  // the only dynamic behavior is the ref resolver in exec-engine.ts.
  //
  // Failure model: any step error fails the whole exec. The caller gets
  // the failed step's id/index, the error string, and the outputs of
  // the steps that did complete so they can reason about how far the
  // pipeline got without re-running the good ones.
  //
  // Meta-tool calls are rejected: exec only routes to upstream tools,
  // because recursively dispatching meta-tools (exec inside exec,
  // activate from exec) would hide side-effects that belong at the
  // top level of the model's reasoning.
  private async handleExec(
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const validation = validateExecRequest(args);
    if (!validation.ok) {
      return {
        content: [{ type: "text", text: `exec: ${validation.message}` }],
        isError: true,
      };
    }

    const steps = (args.steps as ExecStepInput[]).map((s) => ({
      id: typeof s.id === "string" ? s.id : undefined,
      tool: s.tool,
      args: (s.args ?? {}) as Record<string, unknown>,
    }));
    const explicitReturn = typeof args.return === "string" ? args.return : undefined;

    const bindings: Record<string, unknown> = {};
    const stepKeys: string[] = [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const key = stepBindingKey(step, i);
      stepKeys.push(key);

      // Resolve $ref markers against the running bindings map BEFORE the
      // tool call goes out, so the upstream sees a concrete args object.
      let resolvedArgs: Record<string, unknown>;
      try {
        const resolved = resolveArgs(step.args, bindings);
        // validateExecRequest already ensured step.args is an object,
        // and resolveArgs only produces non-object values when the ENTIRE
        // args is itself a $ref node — which is legal (a step can take
        // its full args from a prior step) but must still be an object.
        if (resolved === null || typeof resolved !== "object" || Array.isArray(resolved)) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: false,
                    failedStep: key,
                    error: `step "${key}": resolved args are not an object (${typeof resolved})`,
                    partial: bindings,
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        resolvedArgs = resolved as Record<string, unknown>;
      } catch (err) {
        const msg = err instanceof RefError ? err.message : err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  failedStep: key,
                  error: `step "${key}": ${msg}`,
                  partial: bindings,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      // Meta-tools are callable by the client directly; routing them
      // through exec would let a step, say, deactivate the server
      // another step is about to use. Keep exec's surface narrowly
      // proxy-only.
      // Cast: META_TOOL_NAMES is a Set typed over the literal meta-tool
      // names, but step.tool is a user-supplied string. The cast widens
      // `.has()` to accept arbitrary strings without losing the runtime
      // check.
      if ((META_TOOL_NAMES as Set<string>).has(step.tool)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  failedStep: key,
                  error: `step "${key}": meta-tool "${step.tool}" cannot be called from exec; call it directly`,
                  partial: bindings,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      // Dispatch through the same handleToolCall path that normal
      // tool-calls use. This reuses the auto-reconnect, deferred-route,
      // and pack-detector logic so exec steps behave identically to
      // direct calls — the caller pays no per-step cost in surprises.
      //
      // `extra` is omitted so exec steps don't fight for the top-level
      // progress token; the exec itself emits no progress.
      const stepResult = await this.handleToolCall(step.tool, resolvedArgs);

      if (stepResult.isError) {
        const errText = stepResult.content?.[0]?.text ?? "unknown error";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  failedStep: key,
                  error: errText,
                  partial: bindings,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }

      bindings[key] = stepResult;
    }

    const returnKey = explicitReturn ?? stepKeys[stepKeys.length - 1];
    const finalResult = bindings[returnKey];

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: true,
              result: finalResult,
              steps: bindings,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  async shutdown(): Promise<void> {
    log("info", "Shutting down mcph");

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Flush any pending state save before we stop accepting writes.
    // Cancels the debounce timer so no stale snapshot writes after.
    if (this.stateSaveTimer) {
      clearTimeout(this.stateSaveTimer);
      this.stateSaveTimer = null;
    }
    if (this.persistenceReady) {
      await this.flushStateSave();
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

  // Debounced save trigger. Called after every learning/pack-detector
  // write — the timer collapses bursts into one write so a busy session
  // isn't writing the state file 10×/sec. Silently no-ops until start()
  // has hydrated state, which keeps unit tests that skip start() from
  // touching the user's ~/.mcph/state.json.
  private scheduleStateSave(): void {
    if (!this.persistenceReady) return;
    if (this.stateSaveTimer) clearTimeout(this.stateSaveTimer);
    this.stateSaveTimer = setTimeout(() => {
      this.stateSaveTimer = null;
      this.flushStateSave().catch(() => {});
    }, ConnectServer.STATE_SAVE_DEBOUNCE_MS);
    if (this.stateSaveTimer.unref) this.stateSaveTimer.unref();
  }

  private async flushStateSave(): Promise<void> {
    await saveState({
      learning: this.learning.exportSnapshot(),
      packHistory: this.packDetector.exportSnapshot(),
    });
  }
}
