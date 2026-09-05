import { homedir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { maybeAutoUpgrade } from "./auto-upgrade.js";
import { bundleActivateHint, CURATED_BUNDLES, matchBundles, topPartialBundles } from "./bundles.js";
import { formatShadowLine, installTargetForCli } from "./cli-shadows.js";
import { type ComplianceGrade, classifyGrade, parseMinCompliance, passesMinCompliance } from "./compliance.js";
import { loadYawMcpConfig, type Profile, profileAllows, type ResolvedConfig, toProfile } from "./config-loader.js";
import { estimateFromConnectedTools, estimateFromToolCache, formatCostLabel } from "./cost-estimate.js";
import { detectMissingCredentials } from "./credentials.js";
import { formatRelativeAge, scanShellHistoryForShadows } from "./doctor-cmd.js";
import { classifyError } from "./error-category.js";
import {
  collectRefDeps,
  type ExecStepInput,
  RefError,
  resolveArgs,
  stepBindingKey,
  validateExecRefs,
  validateExecRequest,
} from "./exec-engine.js";
import { appendFoundryTrace, isFoundryEnabled, redactIntent } from "./foundry.js";
import { closestNames } from "./fuzzy.js";
import { type GradesCache, readGradesCache } from "./grades-cache.js";
import { type LoadedGuides, loadGuides, renderGuide } from "./guide.js";
import { type ActivationFailure, formatHealthWarning, healthFactor } from "./health-score.js";
import {
  ADAPTIVE_MAX,
  ADAPTIVE_MIN,
  adaptiveThreshold,
  HISTORY_LIMIT,
  pushToolCall,
  type ToolCallRecord,
} from "./idle-ttl.js";
import { INSTALL_NUDGE_MIN_COUNT, installNudgeEnabled, recordNudges, shouldNudge } from "./install-nudge.js";
import { setJsonKey } from "./json-key.js";
import { LearningStore, PENALTY_RATE_THRESHOLD } from "./learning.js";
import { loadLocalBundles } from "./local-bundles.js";
import { log } from "./logger.js";
import { computeSecretsReport, META_TOOL_NAMES, META_TOOLS } from "./meta-tools.js";
import { PackDetector } from "./pack-detect.js";
import { isPersistenceDisabled, loadState, type PersistedToolCacheEntry, saveState } from "./persistence.js";
import { createProgressReporter, type ProgressReporter } from "./progress.js";
import {
  type BuiltinResource,
  brandRoutingFault,
  buildPromptList,
  buildPromptRoutes,
  buildResourceList,
  buildResourceRoutes,
  buildToolList,
  buildToolRoutes,
  isRoutingFaultResult,
  type PromptRoute,
  type ResourceRoute,
  routePromptGet,
  routeResourceRead,
  routeToolCall,
  type ToolExposure,
  type ToolRoute,
} from "./proxy.js";
import { type Content, pruneContent } from "./prune.js";
import { findTool, formatReadToolOutput, formatToolNotFound, normalizeToolName } from "./read-tool.js";
import { RedispatchTracker } from "./redispatch.js";
import { type RankableServer, rankServers, tokenize, tokenizeQuery } from "./relevance.js";
import { computeOutcomeReward } from "./reward.js";
import {
  firstResultText,
  type GraderContext,
  gradeOutcomeViaSampling,
  isRewardGraderEnabled,
  isUncertainReward,
} from "./reward-grader.js";
import {
  bestOfNViaSampling,
  buildCandidates,
  parseRouteEffort,
  sampleCountForEffort,
  shouldSample,
} from "./sampling-rank.js";
import { listKeys, loadVault, vaultPath } from "./secrets-vault.js";
import { type CapDecision, evaluateServerCap, type LoadedSlot, resolveServerCap } from "./server-cap.js";
import { maybeRefreshSidecars } from "./sidecar-refresh.js";
import type { ConnectConfig, UpstreamConnection, UpstreamServerConfig } from "./types.js";
import {
  ActivationError,
  clearSessionVaultPassphrase,
  connectToUpstream,
  type DownstreamClientBridge,
  disconnectFromUpstream,
  INTERNAL_SECRET_ENV_KEYS,
  setSessionVaultPassphrase,
  VaultPassphraseRequiredError,
  verifyVaultPassphrase,
} from "./upstream.js";
import { buildCoUsageMap, formatReliabilityWarning, formatUsageHint, selectFlakyNamespaces } from "./usage-hints.js";
import { ensureUv, uvLaunchKind } from "./uv-bootstrap.js";

declare const __VERSION__: string;

// The YAW_MCP_DISABLE_PERSISTENCE opt-out lives in persistence.ts (the module
// it disables) and is imported above. This file used to define its own copy;
// the shared one reads process.env by default, which is exactly what the call
// site below wants.

// Current minimum compliance filter, parsed from YAW_MCP_MIN_COMPLIANCE.
// Re-read on every call so tests can stub the env between cases. Null
// means "filter disabled" — every server passes regardless of grade.
// Invalid values log a one-shot warning (see parseMinCompliance) and
// fall back to disabled so a typo never hides the user's whole catalog.
export function resolveMinCompliance(): ComplianceGrade | null {
  return parseMinCompliance(process.env.YAW_MCP_MIN_COMPLIANCE);
}

// Human-readable reason a server is refused under a compliance floor.
// passesMinCompliance returns a single boolean for both "unrecognized
// grade" and "recognized grade below the minimum", so a naive message
// would call an unrecognized "Pass" grade "below B". classifyGrade
// splits the two so the refusal names the real problem. Ungraded servers
// never reach here (they pass the floor).
function complianceRefusalReason(grade: string | undefined | null, min: ComplianceGrade): string {
  const c = classifyGrade(grade);
  if (c.kind === "unrecognized") {
    return `unrecognized compliance grade "${c.raw}" (not A-F); failing closed under YAW_MCP_MIN_COMPLIANCE=${min}`;
  }
  return `compliance grade ${grade ?? "unknown"} is below YAW_MCP_MIN_COMPLIANCE=${min}`;
}

// Opt-in auto-load. Set YAW_MCP_AUTO_LOAD=1 (or "true") to pre-activate the
// top recurring pack from persisted history on startup — no LLM round
// trip required. Default off: auto-activation normally rides on an
// explicit discover() call (see YAW_MCP_AUTO_ACTIVATE). This is for users
// who know their workflow starts the same way every session and want
// to skip the discover step entirely.
export function isAutoLoadEnabled(): boolean {
  // Trimmed like every other env resolver (resolveToolExposure,
  // parseMinCompliance): cmd.exe's `set VAR=1 && ...` keeps the space
  // before `&&`, so the raw value arrives as "1 " on Windows.
  const raw = process.env.YAW_MCP_AUTO_LOAD?.trim();
  if (raw === undefined || raw === "") return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

// Last unrecognized YAW_MCP_TOOL_EXPOSURE value the warning in
// resolveToolExposure fired for. Null means "nothing warned about yet".
let exposureWarnedFor: string | null = null;

// How much of the catalog tools/list advertises. Gateway by default -- see
// ToolExposure in proxy.ts for the measurement that made it the default.
// YAW_MCP_TOOL_EXPOSURE=full restores the previous behavior for a client that
// genuinely wants the whole catalog inlined. Re-read per call, same discipline
// as resolveMinCompliance, so a mid-session change lands on the next
// tools/list instead of needing a restart.
export function resolveToolExposure(): ToolExposure {
  const raw = process.env.YAW_MCP_TOOL_EXPOSURE?.trim().toLowerCase();
  if (raw === "full") return "full";
  if (raw === undefined || raw === "" || raw === "gateway") return "gateway";
  // Unknown value: an operator who mistyped should not silently get the
  // 27,000-token surface back. Said once per distinct bad value, not once
  // per call: this resolver runs from all three list handlers, so an
  // unconditional warn is three lines per client refresh and three more
  // after every list_changed notification. Keyed on the VALUE (same
  // discipline as idleThresholdClampWarnedFor below) so a session that
  // swaps one typo for another is still told.
  if (exposureWarnedFor !== raw) {
    exposureWarnedFor = raw;
    log("warn", `unrecognized YAW_MCP_TOOL_EXPOSURE "${raw}"; using "gateway"`, { raw });
  }
  return "gateway";
}

// Baseline number of non-matching tool calls a namespace tolerates before
// the idle reaper unloads it. adaptiveThreshold() (idle-ttl.ts) stacks a
// per-namespace bonus on top of this and clamps the result to [5, 50].
export const DEFAULT_IDLE_CALL_THRESHOLD = 10;

/** How many times one session may ask for the vault passphrase, across every
 *  namespace. Two, not one: the value is typed by a human into a no-echo
 *  field, and each entry is verified before it is stored, so the second ask
 *  exists purely to make a transposed character cost a retry instead of the
 *  session. Not higher -- an elicitation is a modal interruption in the
 *  user's client, and someone who does not know the passphrase is not going
 *  to recall it on the third prompt. Related to but NOT the same as
 *  secrets-cmd's MAX_PASSPHRASE_PROMPTS (3): that one caps re-prompts on an
 *  EMPTY entry so a closed/EOF stdin cannot loop forever on a TTY, which is
 *  a different failure and a different number. The shared idea is only
 *  "bound the asking". */
export const MAX_VAULT_PASSPHRASE_PROMPTS = 2;

/** How many times one session may ask for a given namespace's MISSING CHILD
 *  credentials. Two, for the reason the vault budget above is two: the value
 *  is typed by a human, and a transposed character used to latch for the
 *  whole session (the stored-but-wrong value made every later activation
 *  skip the prompt entirely), so one slip cost every activation of that
 *  server until the client restarted. Per NAMESPACE, unlike the vault
 *  budget: these credentials are the child's, not yaw-mcp's, so a wrong
 *  GITHUB_TOKEN says nothing about the next server's. */
const MAX_CREDENTIAL_PROMPTS = 2;

// Last baseline the clamp warning in resolveIdleThreshold fired for. Keyed on
// the VALUE, not a boolean, so a session (or a test) that changes the env to a
// different out-of-range value is told again, while a steady out-of-range value
// logs once instead of once per tool call. One slot covers both ends: a given
// baseline is either above the ceiling or below the floor, never both.
let idleThresholdClampWarnedFor: number | null = null;

// Live idle-threshold baseline. YAW_MCP_IDLE_THRESHOLD is the current
// name; MCP_CONNECT_IDLE_THRESHOLD is the pre-rename spelling and stays
// honored as a fallback so existing setups keep working. Re-read on every
// call (same discipline as resolveMinCompliance / isAutoActivateEnabled)
// rather than latched in a static initializer, so a mid-session env change
// — or a test stubbing the env between cases — takes effect immediately.
// A non-numeric or <1 value falls back to the default instead of
// silently disabling the reaper.
export function resolveIdleThreshold(): number {
  // An empty value counts as unset for BOTH names, so `YAW_MCP_IDLE_THRESHOLD=`
  // falls through to the legacy spelling rather than swallowing it. Trimmed
  // before that emptiness test for the cmd.exe reason the other resolvers
  // document (`set VAR= && ...` keeps the space, so the value arrives as
  // " "): an all-whitespace new name would otherwise read as PRESENT and
  // mask a perfectly good MCP_CONNECT_IDLE_THRESHOLD.
  const current = process.env.YAW_MCP_IDLE_THRESHOLD?.trim();
  const raw = current !== undefined && current !== "" ? current : process.env.MCP_CONNECT_IDLE_THRESHOLD;
  if (!raw) return DEFAULT_IDLE_CALL_THRESHOLD;
  // Strict digit-run parse, the same shape resolveServerCap (server-cap.ts)
  // was hardened to. Number.parseInt's PREFIX parsing turns "1e2" into 1 and
  // "10abc" into 10, so a malformed value silently made the reaper far more
  // aggressive than the operator asked for instead of falling back to the
  // documented default.
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_IDLE_CALL_THRESHOLD;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_IDLE_CALL_THRESHOLD;
  // adaptiveThreshold() clamps its computed result to ADAPTIVE_MAX, so a
  // baseline above that ceiling is silently capped -- YAW_MCP_IDLE_THRESHOLD=100
  // behaves exactly like 50. Say so once per distinct configured value
  // (this function runs on every tool call, so an unconditional log would
  // be per-call spam) rather than letting the operator believe the number
  // they set is in effect.
  if (n > ADAPTIVE_MAX && idleThresholdClampWarnedFor !== n) {
    idleThresholdClampWarnedFor = n;
    log("warn", "Idle threshold above the adaptive ceiling; it will be clamped", {
      configured: n,
      effectiveMax: ADAPTIVE_MAX,
    });
  }
  // The mirror image, and the reason it lives HERE: adaptiveThreshold() clamps
  // UP to ADAPTIVE_MIN too, so YAW_MCP_IDLE_THRESHOLD=1..4 all behave as 5 --
  // an operator asking for aggressive reaping gets the floor instead and is
  // never told. The warn cannot go in adaptiveThreshold: that function is pure
  // and is scored on every tool call, so it would log per call. Same
  // once-per-distinct-value dedup as the ceiling branch above.
  if (n < ADAPTIVE_MIN && idleThresholdClampWarnedFor !== n) {
    idleThresholdClampWarnedFor = n;
    log("warn", "Idle threshold below the adaptive floor; it will be clamped", {
      configured: n,
      effectiveMin: ADAPTIVE_MIN,
    });
  }
  return n;
}

// Auto-warm gate for discover(context): when one candidate clearly wins,
// activate it in the same call instead of making the LLM follow up with an
// explicit activate. Default ON; set YAW_MCP_AUTO_ACTIVATE=0 to disable.
// Re-read on every call (same discipline as resolveMinCompliance /
// isAutoLoadEnabled) so a mid-session env change -- or a test stubbing the
// env between cases -- takes effect without restarting the process.
export function isAutoActivateEnabled(): boolean {
  // Trimmed for the same cmd.exe trailing-space reason as isAutoLoadEnabled.
  const raw = process.env.YAW_MCP_AUTO_ACTIVATE?.trim();
  if (raw === undefined || raw === "") return true;
  return raw === "1" || raw.toLowerCase() === "true";
}

// Marker phrases that identify an INTERNAL routing/cache fault rather than
// a genuine upstream failure. The AUTHORITATIVE signal is the structural
// brand every emitter attaches via brandRoutingFault (proxy.ts) -- the
// health/learning/redispatch booking in handleToolCall and handleExec's
// step attribution check isRoutingFaultResult, never the text, because
// these phrases are generic English an upstream error can legitimately
// contain ("This resource is no longer available"), and such an error must
// still count against the upstream. The text constants remain the pinned
// user-facing message shapes (shared constants so the messages and the
// isRoutingFaultText predicate cannot drift). isRoutingFaultText and
// ROUTING_FAULT_MARKERS have NO production callers today -- every live
// check is structural -- and are exported only so the guard tests in
// tests/server.test.ts can assert each emitted message still matches its
// marker. Do not reintroduce a text-based check on the booking paths.
// TOOL_GONE / RECONNECT_FAILED / LOAD_FAILED are emitted by handleToolCall
// below; DISCONNECTED / UNKNOWN_TOOL by routeToolCall in proxy.ts
// (see the guard test in tests/server.test.ts that pins those two).
export const ROUTING_FAULT_TOOL_GONE = "no longer available";
export const ROUTING_FAULT_DISCONNECTED = "no longer connected";
export const ROUTING_FAULT_RECONNECT_FAILED = "auto-reconnect failed";
export const ROUTING_FAULT_UNKNOWN_TOOL = "Unknown tool:";
// A deferred first-call activation that fails is an ACTIVATION result, and
// activation is deliberately not a learning signal (see handleDispatch) --
// without this marker, an exec step landing on a deferred route whose
// load fails (including a server-cap or compliance refusal) was booked as
// a 0.0 tool-call outcome against a server that never got to run.
export const ROUTING_FAULT_LOAD_FAILED = "could not be loaded on first call";
export const ROUTING_FAULT_MARKERS: readonly string[] = [
  ROUTING_FAULT_TOOL_GONE,
  ROUTING_FAULT_DISCONNECTED,
  ROUTING_FAULT_RECONNECT_FAILED,
  ROUTING_FAULT_UNKNOWN_TOOL,
  ROUTING_FAULT_LOAD_FAILED,
];

/** True when an error text came from yaw-mcp's own routing layer (stale
 *  toolCache, dropped connection, failed auto-reconnect, unknown tool)
 *  rather than from the upstream server itself. */
export function isRoutingFaultText(text: string): boolean {
  return ROUTING_FAULT_MARKERS.some((marker) => text.includes(marker));
}

// The empty-catalog message, shared by discover and dispatch. One constant
// because the two used to drift: discover was rewritten for the local-only
// product (`yaw-mcp add <slug>` into ~/.yaw-mcp/bundles.json) while dispatch
// -- the documented FIRST call, so the fresh-install path -- kept sending the
// user to the retired hosted add/enable UI at yaw.sh/mcp, a page that can no
// longer do what the text said.
const NO_SERVERS_INSTALLED_TEXT =
  "No servers installed. Browse the catalog at https://yaw.sh/mcp/catalog/ and add one with `yaw-mcp add <slug>` — it lands in ~/.yaw-mcp/bundles.json. Restart this MCP client afterwards; yaw-mcp reads bundles.json once at startup.";

/** Namespaces from an activate/deactivate meta-tool args bag. `servers`
 *  (array) wins over the single `server` form; empty when neither is
 *  usable. Exported so tests exercise the real resolver, not a copy. */
export function resolveNamespaces(args: Record<string, unknown>): string[] {
  if (Array.isArray(args.servers)) {
    // Filter to non-empty strings before trusting the array — the raw
    // value is untyped tool input, so a `servers: [1, null, ""]` bag must
    // not flow through as namespaces. Mirrors the `tools` filter in
    // handleToolCall. A present-but-all-invalid array falls through to the
    // single `server` form, and an all-invalid bag yields no namespaces.
    const filtered = args.servers.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (filtered.length > 0) return filtered;
  }
  if (typeof args.server === "string" && args.server) {
    return [args.server];
  }
  return [];
}

/**
 * True if `p` settled within `ms`, false if the budget expired first.
 * Never rejects — the caller only wants to know whether to keep waiting.
 * The timer is cleared on the fast path and unref'd on the slow one, so a
 * bounded wait can neither leak a handle nor hold an embedded host's event
 * loop open past the wait itself.
 */
export function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    if (typeof timer.unref === "function") timer.unref();
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    p.then(done, done);
  });
}

// Words that are never content terms but clear relevance.ts's 3-char prose
// floor, so tokenizeQuery keeps them. BM25 tolerates them (IDF flattens a
// term that occurs everywhere), but the summary's per-tool match below is a
// bare set-intersection with no IDF at all: one "the" in the query matched
// nearly every tool description, and the 5-hit cap then filled with whatever
// happened to come first in list order. Only closed-class words -- anything
// that could name a tool or a domain stays out.
const SUMMARY_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "your",
  "you",
  "are",
  "was",
  "has",
  "how",
  "can",
  "will",
  "some",
  "any",
  "all",
]);

// Tokenizer for the discover "matches" summary. Delegates to relevance.ts's
// tokenizeQuery -- the SAME tokenizer the BM25 query path uses (1-char floor
// so "pr" / "ci" survive, minus the sub-floor closed-class words) -- so the
// summary's per-tool match logic lines up with the ranking that chose the
// servers it annotates. SUMMARY_STOPWORDS above is the extra subtraction the
// summary needs and the ranker does not.
function tokenizeForSummary(text: string): Set<string> {
  return new Set(tokenizeQuery(text).filter((t) => !SUMMARY_STOPWORDS.has(t)));
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

/** What one vault-passphrase elicitation round produced. Three states, not a
 *  boolean, because a REJECTED entry (the user typed something and it did not
 *  verify) needs different words from an UNAVAILABLE one (declined, empty, or
 *  the request itself failed) -- and only the first of those is worth telling
 *  the caller a retry is still on offer. */
type VaultPromptOutcome = "unlocked" | "rejected" | "unavailable";

export class ConnectServer {
  private server: Server;
  private clientBridge: DownstreamClientBridge;
  private connections = new Map<string, UpstreamConnection>();
  private config: ConnectConfig | null = null;
  private configVersion: string | null = null;
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
  // Tool lists learned from a live upstream handshake, keyed by namespace.
  // Hydrated from ~/.yaw-mcp/state.json at start() and re-written there
  // whenever a server's tools are learned, so a fresh session already knows
  // what an inactive server offers: getDeferredServers() can surface its
  // tools cold, and prewarmDormantServers() skips re-spawning it. Before
  // this was persisted, every session re-spawned every active server.
  private toolCache = new Map<string, Array<{ name: string; description?: string }>>();
  // When each namespace's toolCache entry was learned. Carried through the
  // persistence round-trip so a hydrated entry keeps its original age and
  // still ages out under the TTL rather than being refreshed for free on
  // every save.
  private toolCacheLearnedAt = new Map<string, number>();
  // Per-namespace tool filters set by mcp_connect_activate({ tools: [...] }).
  // When a namespace has an entry, only those BARE tool names surface in
  // tools/list; routing tables stay complete so mcp_connect_dispatch can
  // still reach unlisted tools. Cleared on activate-without-tools of the
  // same namespace and on deactivate.
  private toolFilters = new Map<string, Set<string>>();
  // Namespaces the CLIENT explicitly activated this session. In gateway mode
  // (the default) this is the entire surface tools/list advertises beyond the
  // meta-tools. Deliberately NOT the same question as "is it connected":
  // prewarmDormantServers spawns dormant servers on its own, so keying on
  // connectedness would re-advertise the whole catalog and defeat the mode.
  // Session-scoped on purpose -- it is not persisted, so a new session starts
  // at the meta-tools again and the client re-asks for what it needs.
  private sessionActivated = new Set<string>();
  private profile: Profile | null = null;
  // Shadow-driven install-nudge gate. Resolved once at start() from the
  // env override (YAW_MCP_INSTALL_NUDGE=1) OR config (installNudge: true);
  // off by default. When false, discover NEVER runs the shell-history scan
  // and its output is byte-identical to today (the load-bearing privacy
  // property). See install-nudge.ts. Stays false in unit tests that skip
  // start(), so the nudge block is opt-in there too.
  private installNudge = false;
  // home / env used by the install-nudge shell-history scan. Default to the
  // real process values; overridable so tests can point the scan at a
  // synthetic home + stubbed env without touching the developer's real
  // shell history or ~/.yaw-mcp/ state file.
  private nudgeHome: string = homedir();
  private nudgeEnv: NodeJS.ProcessEnv = process.env;
  // Loaded YAW-MCP.md guides (user-global + project-local). Null until
  // start() has run the loader; fail-open if either file is missing,
  // unreadable, or empty.
  private guides: LoadedGuides = { user: null, project: null };
  // Tracks whether the client has actually READ `yaw-mcp://guide` this
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
  // Cleared on shutdown — persistence belongs in the Yaw MCP
  // bundles.json, these are a "get me running now" shortcut.
  private elicitedEnv = new Map<string, Record<string, string>>();
  // Stop-asking latch for the VAULT PASSPHRASE elicitation. Not keyed by
  // namespace like elicitedEnv, because the passphrase is not per-server --
  // one vault, one passphrase, and every server with `${secret:...}` refs
  // needs the same one. Set by a VERIFIED passphrase, an explicit decline, or
  // exhausting MAX_VAULT_PASSPHRASE_PROMPTS. A rejected typo deliberately
  // does NOT set it: the value is verified before it is stored, so a slip
  // costs one retry instead of every vault-backed server for the session.
  private vaultPassphraseElicited = false;
  // How many times we have ASKED this session, across every namespace.
  // Separate from the latch so a wrong entry stays re-askable while still
  // being bounded -- the pestering maybeElicitAndRetry exists to avoid.
  private vaultPassphrasePrompts = 0;
  // The vault-passphrase elicitation currently in flight, if any. One vault,
  // one passphrase: prewarm activates three namespaces at a time, so without
  // this each locked-vault namespace in a batch opened its own modal for the
  // same question and the batch spent the whole
  // MAX_VAULT_PASSPHRASE_PROMPTS budget in a single round. Followers await
  // this instead of prompting. Cleared when the prompt settles.
  private vaultElicitInflight: Promise<VaultPromptOutcome> | null = null;
  // How many times we have asked for a given NAMESPACE's missing child
  // credentials. Per-namespace (unlike the vault counter) because these are
  // the child's own secrets. Bounds the re-ask that replaced the old
  // "already elicited, never ask again" latch -- see MAX_CREDENTIAL_PROMPTS.
  private credentialPrompts = new Map<string, number>();
  // In-flight activation promises, keyed by namespace. Dedupes
  // concurrent activation attempts for the same namespace so that two
  // tool calls landing on a disconnected upstream don't each spawn
  // their own child process. Second and subsequent callers await the
  // same promise as the first; the entry is cleared when the promise
  // settles (success or failure).
  private activationInflight = new Map<
    string,
    Promise<{ ok: boolean; message: string; isChanged: boolean; serverId?: string; capped?: boolean }>
  >();
  // Tracks namespaces whose current activationInflight was initiated by
  // prewarmDormantServers. An explicit mcp_connect_activate clears the
  // namespace from this set, which prevents prewarm from disconnecting a
  // connection the user just claimed. Without this, the prewarm race is:
  //   1. prewarm activateOne("foo") -> inflight P1
  //   2. user activateOne("foo") -> joins P1 (same promise)
  //   3. P1 resolves ok=true for both callers
  //   4. prewarm disconnects "foo" — user's next tool call fails
  // With this set: prewarm only disconnects when the namespace was NOT
  // claimed by an explicit activate while P1 was in flight.
  private prewarmNamespaces = new Set<string>();
  // Slot reservations for the concurrent-server cap. A namespace is added
  // here synchronously (before the first `await connectToUpstream`) once it
  // clears the cap check, and removed when its activation settles. Counting
  // these pending reservations alongside connected servers closes a TOCTOU
  // gap: two DISTINCT namespaces activating concurrently would otherwise
  // both pass the cap check against the same connected set and overshoot
  // YAW_MCP_SERVER_CAP. Distinct from activationInflight (which dedupes
  // repeat activations of the SAME namespace) — this bounds the TOTAL count.
  private pendingActivations = new Set<string>();
  // Per-namespace count of tool calls currently awaiting an upstream
  // response. Incremented immediately before routeToolCall and decremented
  // in a finally, so it is accurate across concurrent calls. Read by
  // trackUsageAndAutoDeactivate: the idle reaper runs on OTHER calls'
  // completions, so without this a long call to B can be killed mid-flight
  // by a burst of short calls to A (and then booked as B's failure).
  private inflightCalls = new Map<string, number>();
  // Latched by shutdown() before it drains anything. Three gates read it so a
  // connection can't be registered into this.connections after the teardown
  // snapshot and leak a live child process: activateOne refuses BEFORE a
  // spawn; runActivateOne refuses at the top of EVERY attempt (its retry
  // sleep and the elicitation re-entries, which call it directly, are both
  // reachable after the latch without passing activateOne again); and
  // runActivateOne re-checks AFTER `await connectToUpstream` -- shutdown()'s
  // drain is bounded, so a handshake that outlives it resolves into a map
  // shutdown has already cleared, and that gate is the only thing that
  // closes the transport in that case.
  private shuttingDown = false;
  // Usage learning — nudges dispatch toward namespaces that have been
  // genuinely useful. Counts persist across yaw-mcp restarts via state.json
  // (see persistence.ts). YAW_MCP_DISABLE_PERSISTENCE=1 makes it session
  // -scoped only. See learning.ts.
  private readonly learning = new LearningStore();
  // Session-scoped chain detection — watches proxied tool calls across
  // namespaces and surfaces recurring multi-server patterns as suggested
  // "packs". Observation-only; never activates anything. Meta-tool calls
  // are deliberately excluded because they aren't user workflow.
  private readonly packDetector = new PackDetector();
  // Session-scoped re-dispatch tracking — watches for the model abandoning
  // one server and re-routing a similar intent to another, which is
  // evidence the first route was wrong. Feeds a negative learning signal
  // (LearningStore.recordMiss). Not persisted: a re-dispatch window that
  // spans a restart is meaningless. See redispatch.ts.
  private readonly redispatch = new RedispatchTracker();
  // Last dispatch intent per namespace (session-scoped, not persisted). Lets
  // the optional reward grader (reward-grader.ts) judge a tool call against the
  // goal the server was routed for. Bounded by the number of namespaces.
  private readonly lastIntentByNamespace = new Map<string, string>();

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

  // Baseline idle-call threshold lives in resolveIdleThreshold() (module
  // scope, re-read per call) rather than in a static initializer here: a
  // static latches the env at import, which is exactly the pattern the
  // isAutoActivateEnabled comment above calls out as the one to avoid.

  // Concurrent-load ceiling. See server-cap.ts — checked in
  // runActivateOne before a new upstream is spawned so we refuse at
  // the door instead of over-inflating the LLM's context. Instance
  // field (not static) so tests can override per-instance without
  // poisoning other instances or re-importing the module.
  private serverCap = resolveServerCap();

  // Delay before runActivateOne's single retry. One fixed step, not
  // exponential backoff. An instance field (not a literal at the call site)
  // purely so a test exercising the second attempt can set it to 0 rather
  // than spending a real second of wall time per case; production never
  // changes it.
  private activationRetryDelayMs = 1000;

  // Cross-session persistence state (learning + pack history).
  // `persistenceReady` gates the save path so unit tests — which
  // never call start() — don't write to ~/.yaw-mcp/state.json. The
  // debounced timer collapses bursts of record*/recordCall into a
  // single write; flushed synchronously on shutdown.
  private persistenceReady = false;
  private stateSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STATE_SAVE_DEBOUNCE_MS = 1000;

  // How long shutdown() will wait for in-flight activations before it
  // stops caring and tears down anyway. Sized against index.ts's 10s
  // force-exit timer — see the drain comment in shutdown() for the
  // arithmetic.
  private static readonly SHUTDOWN_DRAIN_MS = 2000;

  constructor() {
    this.server = new Server(
      { name: "yaw-mcp", version: typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev" },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: { listChanged: true },
        },
      },
    );
    // yaw-mcp itself does not handle elicitation or sampling requests; it
    // originates them. The capability declaration for originated features
    // is implicit -- the client advertises whether IT supports receiving
    // them, which we check via getClientCapabilities() before prompting.
    //
    // Upstream-originated requests are a different story: this bridge is
    // handed to every connectToUpstream call so proxied servers keep
    // elicitation, sampling, and roots when the downstream client declared
    // them. upstream.ts mirrors the declared set onto each upstream Client
    // and forwards those requests through these methods; capabilities are
    // read lazily because upstream connects happen after the downstream
    // initialize.
    this.clientBridge = {
      getClientCapabilities: () => this.server.getClientCapabilities(),
      elicitInput: (params, options) => this.server.elicitInput(params, options),
      createMessage: (params, options) => this.server.createMessage(params, options),
      listRoots: (params, options) => this.server.listRoots(params, options),
    };
    this.setupHandlers();
  }

  // Builtin resources served directly by yaw-mcp (not proxied from an
  // upstream). Today: just `yaw-mcp://guide`. Rebuilt each request so the
  // list reflects the latest loaded guides — start() populates
  // `this.guides` once, but tests and future hot-reload code paths may
  // mutate it, and the cost of rebuilding is negligible.
  private getBuiltinResources(): BuiltinResource[] {
    const body = renderGuide(this.guides, this.getProfiledActiveServers());
    if (!body) return [];
    return [
      {
        uri: "yaw-mcp://guide",
        name: "yaw-mcp guide",
        description:
          "Project + user guidance from YAW-MCP.md. Read this to learn how THIS user/project routes MCP work (which servers to prefer, where credentials live, gotchas).",
        mimeType: "text/markdown",
        read: () => {
          // Flip the session flag — the meta-tools one-shot nudge keys
          // off this so we only remind the client to read the guide if
          // they haven't yet. Re-render at read time so the auto
          // "Active servers" section reflects the current connection
          // set, not the one at list time.
          this.guideRead = true;
          const text = renderGuide(this.guides, this.getProfiledActiveServers()) ?? "";
          return { contents: [{ uri: "yaw-mcp://guide", text, mimeType: "text/markdown" }] };
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
      tools: buildToolList(
        this.connections,
        this.getDeferredServers(),
        this.toolFilters,
        resolveToolExposure(),
        this.sessionActivated,
      ),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      return this.handleToolCall(name, args ?? {}, extra);
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: buildResourceList(
        this.connections,
        this.getBuiltinResources(),
        resolveToolExposure(),
        this.sessionActivated,
      ),
    }));

    // Registered so a client probing resources/templates/list gets a valid
    // empty result instead of -32601 — the constructor declares the
    // resources capability, which implies this method, and the SDK ships no
    // default handler for it. yaw-mcp does not proxy upstream resource
    // TEMPLATES yet: buildResourceRoutes only ever sees concrete
    // conn.resources, so routeResourceRead could not resolve a templated
    // URI anyway. If template proxying lands, this handler is where the
    // aggregated upstream templates get returned.
    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: [],
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return routeResourceRead(request.params.uri, this.resourceRoutes, this.connections, this.getBuiltinResourceMap());
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: buildPromptList(this.connections, resolveToolExposure(), this.sessionActivated),
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
    // Re-learn the tool list from the refreshed connection, exactly as
    // runActivateOne does on a fresh activation. upstream.ts has already
    // re-listed the tools onto the connection by the time this fires, and
    // this.toolCache is what every COLD reader uses: the deferred routes
    // rebuilt after an idle eviction, discover's `known tools:` line, the
    // BM25 corpus, and the next state.json save. Without this the routing
    // table follows the change while all four keep serving the pre-change
    // list until the namespace is activated again.
    const conn = this.connections.get(ns);
    if (conn?.status === "connected") {
      this.toolCache.set(
        ns,
        conn.tools.map((t) => ({ name: t.name, description: t.description })),
      );
      this.toolCacheLearnedAt.set(ns, Date.now());
      this.scheduleStateSave();
    }
    this.refreshRoutesAndNotify().catch((err: Error) => {
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

  // The obligatory pair after ANY change to the connected set: rebuild the
  // routing tables, then tell the client its lists moved. Every activation
  // and deactivation site funnels through here because doing only half of
  // it is the bug that keeps recurring — a namespace lands in
  // this.connections while toolRoutes still holds its `deferred` entry, so
  // the next tools/call takes the deferred branch, finds the server already
  // connected (isChanged:false), and returns the misleading "no longer
  // available after loading X" error with no way for the model to recover.
  private async refreshRoutesAndNotify(): Promise<void> {
    this.rebuildRoutes();
    await this.notifyAllListsChanged();
  }

  // Active servers, narrowed by the project profile if one is loaded.
  // Centralizing this here means discover/dispatch/auto-warm all see the
  // same set — no accidental bypass of the profile via a second code path.
  // The merge in mergeToolCache feeds the in-memory toolCache (hydrated
  // from state.json at startup, updated as servers activate) into each
  // server so callers like formatShadowLine can see learned tools.
  // bundles.json doesn't carry toolCache (validateEntry's fixed whitelist
  // drops it), and without this merge the tool-prefix heuristic in
  // resolveShadowedClis is inert on a real run — see the KNOWN_CLI_PREFIXES
  // comment in cli-shadows.ts.
  private getProfiledActiveServers(): UpstreamServerConfig[] {
    const all = (this.config?.servers ?? []).filter((s) => s.isActive);
    const profiled = this.profile ? all.filter((s) => profileAllows(this.profile, s.namespace)) : all;
    return profiled.map((server) => this.mergeToolCache(server));
  }

  // Configured-but-not-currently-connected servers that have a persisted
  // toolCache. Fed into buildToolList/buildToolRoutes so the LLM can see
  // their tools in tools/list before activation; first tools/call on any
  // of those tools triggers lazy activation via activateOne in
  // handleToolCall. Merges in any in-session toolCache (this.toolCache)
  // that hasn't yet been persisted to bundles.json, so recently-used
  // servers that got idle-evicted still appear as deferred.
  private getDeferredServers(): UpstreamServerConfig[] {
    const out: UpstreamServerConfig[] = [];
    for (const server of this.getProfiledActiveServers()) {
      if (this.connections.has(server.namespace)) continue;
      if (!server.toolCache || server.toolCache.length === 0) continue;
      out.push(server);
    }
    return out;
  }

  // Return `server` with its in-memory toolCache applied. The in-memory
  // entry (this.toolCache) wins over server.toolCache when both exist —
  // the persisted copy can be stale relative to a fresh activation, and
  // the in-memory map is what tools/list and formatShadowLine should
  // actually see. An EMPTY learned list does not win: it is a real
  // observation for hasKnownTools, but as a tool list it has nothing to
  // show, so a curated list is still worth rendering over it.
  //
  // This is the ONE precedence rule for a cold server's tool list. Every
  // reader goes through it -- getProfiledActiveServers merges once and the
  // discover body reads the merged `server.toolCache`; rankableFor calls it
  // for the BM25 corpus. Two more copies of the resolution used to live in
  // those readers with `??` semantics (empty learned list WINS), so discover
  // could rank a server on an empty list while listing its curated tools.
  //
  // Identity preservation: when both sides resolve to the same array
  // reference — which in practice means BOTH are undefined (server.ts
  // has no toolCache and this.toolCache has no entry for this namespace)
  // — we return `server` unchanged. The `===` guard pins that, so
  // downstream consumers keyed on reference equality (the identity-
  // preservation tests in server.test.ts) keep working. In production,
  // server.toolCache is almost always undefined: bundles.json validation
  // drops the field (local-bundles.ts), and hydrateToolCache (below)
  // writes the persisted array into this.toolCache rather than back into
  // server.toolCache. So the commonly-fired path is the
  // "spread a clone" branch — the identity guard mostly catches the
  // dormant-namespace case.
  private mergeToolCache(server: UpstreamServerConfig): UpstreamServerConfig {
    const sessionCache = this.toolCache.get(server.namespace);
    const cache = sessionCache && sessionCache.length > 0 ? sessionCache : server.toolCache;
    return cache === server.toolCache ? server : { ...server, toolCache: cache };
  }

  // Does this server's tool list already exist somewhere we trust — the
  // toolCache shipped in bundles.json, or the one we learned in a previous
  // session and hydrated from state.json? Gates pre-warm: a `false` here
  // means the only way to find out what the server offers is to spawn it.
  //
  // A LEARNED entry counts as known even when it is empty. "We spawned this
  // server and it offered zero tools" is an answer, and a resources/prompts-
  // only upstream is a real shape; requiring length > 0 here meant that
  // answer was never trusted, so pre-warm spawned such a server every
  // session forever. A CURATED empty list in bundles.json is still treated
  // as absent -- validation drops the field, so an empty one there is a
  // config artifact rather than an observation.
  private hasKnownTools(server: UpstreamServerConfig): boolean {
    if (server.toolCache && server.toolCache.length > 0) return true;
    return this.toolCache.get(server.namespace) !== undefined;
  }

  // How long a LEARNED tool list stays trusted before the next pre-warm
  // re-spawns the server to refresh it. Installs resolve at @latest, so an
  // upstream that renames or removes a tool would otherwise keep discover's
  // "known tools:" line, the BM25 corpus, and the deferred routes pointing
  // at dead names for the full persistence TTL (TOOLCACHE_TTL_MS, 30 days)
  // -- the only recovery being the "no longer available after loading"
  // error on a live call. A weekly re-learn bounds that drift at one extra
  // spawn per server per week.
  private static readonly TOOLCACHE_REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  // True when the list hasKnownTools trusts came from a PREVIOUS session's
  // learning and is old enough to re-verify. Scoped to learned entries on
  // purpose: a toolCache shipped in bundles.json is curated, carries no
  // learnedAt, and is never refreshed here -- refreshing it every session
  // is exactly the per-session `npx -y <pkg>@latest` resolve pre-warm
  // exists to avoid. runActivateOne stamps a fresh learnedAt on every
  // activation, so a server in actual use never looks stale.
  private isLearnedCacheStale(namespace: string): boolean {
    const cached = this.toolCache.get(namespace);
    // An empty learned list ages on the same weekly cadence as any other.
    // Now that hasKnownTools trusts it, exempting it here would pin a
    // zero-tool server as permanently known -- if the upstream later grew
    // tools, nothing would ever re-spawn it to find out.
    if (cached === undefined) return false;
    const learnedAt = this.toolCacheLearnedAt.get(namespace);
    if (learnedAt === undefined) return false;
    return Date.now() - learnedAt > ConnectServer.TOOLCACHE_REFRESH_MS;
  }

  // Seed the in-memory tool cache from the persisted snapshot. Runs early
  // in start() so the first tools/list of the session can already
  // include deferred servers' tools. Entries for namespaces no longer in
  // bundles.json are harmless — every reader iterates the CONFIGURED
  // servers — and age out via the persistence-layer TTL.
  private hydrateToolCache(persisted: Record<string, PersistedToolCacheEntry>): void {
    let restored = 0;
    for (const [namespace, entry] of Object.entries(persisted)) {
      // Empty lists are restored too -- see hasKnownTools. The persistence
      // layer has already dropped the corrupt-entry case, so anything that
      // arrives empty here is a real zero-tool observation.
      this.toolCache.set(namespace, entry.tools);
      this.toolCacheLearnedAt.set(namespace, entry.learnedAt);
      restored++;
    }
    if (restored > 0) log("info", "Restored learned tool lists", { namespaces: restored });
  }

  // Snapshot the in-memory tool cache for persistence. The persistence layer
  // owns the caps/TTL, so this just pairs each list with the timestamp it
  // was learned at (falling back to now for a list learned before the
  // timestamp map existed — belt-and-braces; runActivateOne always sets it).
  private exportToolCache(): Record<string, PersistedToolCacheEntry> {
    const out: Record<string, PersistedToolCacheEntry> = {};
    for (const [namespace, tools] of this.toolCache) {
      // Zero-length lists are exported, not skipped: that is the observation
      // pre-warm needs next session (see hasKnownTools).
      // setJsonKey, not out[namespace]: sanitizeToolCache preserves a
      // "__proto__" namespace on LOAD (Object.fromEntries makes it an own
      // property) and hydrateToolCache copies it into the Map; plain
      // assignment here invoked the inherited setter on the next save, so
      // the entry silently vanished from state.json -- the same
      // load-side-hardening-undone-one-flush-later shape exportSnapshot
      // (learning.ts) had.
      setJsonKey(out, namespace, { tools, learnedAt: this.toolCacheLearnedAt.get(namespace) ?? Date.now() });
    }
    return out;
  }

  // Overlay the A-F grades `yaw-mcp audit` cached in ~/.yaw-mcp/grades.json
  // onto the loaded server list. That cache is the ONLY supplier of
  // `complianceGrade` in local mode — validateEntry drops unknown fields, so
  // a grade never rides along in bundles.json. Without this overlay every
  // server is permanently ungraded, which silently disables the
  // YAW_MCP_MIN_COMPLIANCE gate (ungraded always passes) and blanks the
  // `[A]`-`[F]` badge in discover. Mirrors the same overlay `yaw-mcp list`
  // applies (local-add-cmd.ts runList) so the CLI and the server agree.
  //
  // `home` is a parameter rather than a field so tests can point it at a
  // synthetic ~/.yaw-mcp without running the whole of start().
  private async hydrateComplianceGrades(home: string = homedir()): Promise<void> {
    if (!this.config) return;
    // readGradesCache never throws (missing/garbled cache -> {}), but the
    // catch keeps a surprise I/O rejection from aborting startup: an
    // unreadable grade cache must degrade to "ungraded", not to "no server".
    const grades: GradesCache = await readGradesCache(home).catch(() => ({}));
    if (Object.keys(grades).length === 0) return;
    let applied = 0;
    this.config.servers = this.config.servers.map((server) => {
      const cached = grades[server.namespace];
      if (!cached) return server;
      applied++;
      return { ...server, complianceGrade: cached.grade };
    });
    if (applied > 0) log("info", "Applied cached compliance grades", { graded: applied });
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

  // `config`: an already-resolved .yaw-mcp/config.* result. The CLI entry
  // (index.ts) loads the config before constructing this server -- for the
  // warnings, which it logs itself -- so handing it in here means one read
  // per startup instead of two. When absent (an embedded or test host that
  // constructs ConnectServer directly), start() loads it AND logs its
  // warnings, so a typo'd key that fails open to allow-all is reported on
  // every path rather than only on the one whose caller happened to log
  // first.
  async start(opts: { config?: ResolvedConfig } = {}): Promise<void> {
    // Hydrate learning + pack-history state from ~/.yaw-mcp/state.json
    // before anything else so subsequent record* writes land on top of
    // the restored signal rather than replacing it. loadState() never
    // throws — missing/corrupt files yield an empty snapshot.
    //
    // YAW_MCP_DISABLE_PERSISTENCE=1 keeps `persistenceReady` false, which
    // silently no-ops both the debounced scheduleStateSave() and the
    // shutdown flush — the whole pathway disappears in one toggle.
    if (isPersistenceDisabled()) {
      log("info", "Cross-session persistence disabled via YAW_MCP_DISABLE_PERSISTENCE");
    } else {
      const persisted = await loadState();
      if (Object.keys(persisted.learning).length > 0 || persisted.packHistory.length > 0) {
        this.learning.loadSnapshot(persisted.learning);
        this.packDetector.loadSnapshot(persisted.packHistory);
        log("info", "Restored yaw-mcp state", {
          learningEntries: Object.keys(persisted.learning).length,
          packHistoryEntries: persisted.packHistory.length,
        });
      }
      this.hydrateToolCache(persisted.toolCache);
      // loadFailed means the state file exists but could not be READ (a
      // transient handle error, not a missing or corrupt file). The empty
      // snapshot we just hydrated is a stand-in, not the truth -- leaving
      // persistenceReady false keeps scheduleStateSave and the shutdown
      // flush from overwriting the real file with it. Session-local
      // learning is lost for this run; that is the safe direction.
      if (!persisted.loadFailed) this.persistenceReady = true;
    }

    // Load the effective config (allow/deny lists + the install-nudge flag)
    // from .yaw-mcp/config.* files. Walks up from cwd for a project-local
    // .yaw-mcp/ dir and also consults ~/.yaw-mcp/config.json (user-global).
    // Local beats project beats global for the allow-list; denies union.
    // Failure is silent — fail-open so a bad config doesn't brick the
    // session. One read here derives BOTH the profile and the nudge gate
    // (previously loadEffectiveProfile re-read the config just for the
    // profile slice).
    let resolvedConfig: ResolvedConfig | null;
    if (opts.config) {
      resolvedConfig = opts.config;
    } else {
      resolvedConfig = await loadYawMcpConfig({ cwd: process.cwd() }).catch(() => null);
      // The loader's soft problems (unknown keys, wrong-typed values, retired
      // hosted-backend keys). Logged HERE only when we did the load: a caller
      // that hands the config in has already seen them, and the same line
      // twice reads like two problems.
      for (const w of resolvedConfig?.warnings ?? []) log("warn", "Config warning", { warning: w });
    }
    this.profile = resolvedConfig ? toProfile(resolvedConfig) : null;
    if (this.profile) {
      log("info", "Loaded profile", {
        path: this.profile.path,
        userPath: this.profile.userPath,
        allow: this.profile.servers,
        block: this.profile.blocked,
      });
    }
    // Resolve the shadow-driven install-nudge gate once, from the env
    // override OR the resolved config flag (either enables it; off by
    // default). Gating here means a fresh load per session picks up a
    // config change on restart. When this stays false, buildDiscoverOutput
    // never runs the shell-history scan.
    //
    // The env value is trimmed here rather than inside installNudgeEnabled
    // (whose contract is a literal "1", so a stray value can't turn the scan
    // on) for the cmd.exe reason isAutoLoadEnabled documents: `set
    // YAW_MCP_INSTALL_NUDGE=1 && ...` keeps the space before `&&`, so the
    // value arrives as "1 " and the gate silently stayed off. Only the one
    // key is overridden; every other env read still sees process.env.
    const rawNudge = process.env.YAW_MCP_INSTALL_NUDGE?.trim();
    const nudgeGateEnv = rawNudge === undefined ? process.env : { ...process.env, YAW_MCP_INSTALL_NUDGE: rawNudge };
    this.installNudge = installNudgeEnabled(nudgeGateEnv, resolvedConfig);
    if (this.installNudge) {
      log("info", "Shadow-driven install nudge enabled");
    }

    // Load YAW-MCP.md guides (user-global + project-local). Fail-open:
    // loadGuides() swallows I/O errors internally, so the worst case
    // is `this.guides` stays { user: null, project: null } and the
    // `yaw-mcp://guide` builtin simply isn't listed.
    this.guides = await loadGuides(process.cwd()).catch(() => ({ user: null, project: null }));
    if (this.guides.user || this.guides.project) {
      log("info", "Loaded YAW-MCP.md guide", {
        user: this.guides.user?.path ?? null,
        project: this.guides.project?.path ?? null,
      });
    }

    // Load config from bundles.json -- the only config source. Non-fatal
    // errors allow startup with an empty config.
    const result = await loadLocalBundles({ cwd: process.cwd() }).catch((err: Error) => {
      log("warn", "loadLocalBundles failed; starting with empty config", { error: err?.message });
      return { config: null, path: null, warnings: [] };
    });
    for (const w of result.warnings) log("warn", "bundles.json warning", { warning: w });
    this.config = result.config ?? { servers: [], configVersion: "" };
    // Deduplicate by namespace -- keep first occurrence. The routing
    // state assumes one server per namespace, so a duplicate in
    // bundles.json has to be filtered before it is ever read.
    const seenNs = new Set<string>();
    this.config.servers = this.config.servers.filter((s) => {
      if (seenNs.has(s.namespace)) {
        log("warn", "Duplicate namespace in bundles.json, skipping", { namespace: s.namespace });
        return false;
      }
      seenNs.add(s.namespace);
      return true;
    });
    this.configVersion = this.config.configVersion;
    log("info", "Loaded bundles", {
      path: result.path,
      serverCount: this.config.servers.length,
    });
    // Overlay cached compliance grades BEFORE anything reads the config,
    // so the routing state and every downstream grade reader see the same
    // graded server list.
    //
    // NOTE: there is deliberately NO config "reconcile" step here. A
    // reconcileConfig method (deactivate servers removed/changed in a new
    // config) lived at this call site for a long time, but bundles.json is
    // read exactly ONCE per process (discover's own user-facing text says
    // so) and start() runs before any connection can exist, so its entire
    // diff/deactivate body was dead code with live-looking tests. If a
    // hot-reload path ever lands, reintroduce it AS the reload handler --
    // do not resurrect it here.
    await this.hydrateComplianceGrades();

    // Prewarm the uv bootstrap if any configured server needs it. Fire
    // and forget — ensureUv() is memoized, so the first activation
    // awaits the same in-flight promise rather than triggering a
    // second download. This moves the 2–10s first-run cost off the
    // activation path (where it could collide with CONNECT_TIMEOUT)
    // and onto startup, where it's expected. The gate is uvLaunchKind --
    // the SAME predicate resolveUvSpawn bootstraps against -- so
    // `uvx.exe` / `UV.CMD` configs prewarm too; an exact-string match
    // here silently pushed those back onto the activation path.
    //
    // Scanned over getProfiledActiveServers(), not every configured server:
    // a disabled ("isActive": false) or profile-blocked Python server can
    // never be activated in this session, so letting it trigger ensureUv's
    // ~20MB download at startup buys nothing and spends the user's network.
    if (this.getProfiledActiveServers().some((s) => s.command !== undefined && uvLaunchKind(s.command) !== null)) {
      ensureUv().catch((err: Error) => log("warn", "uv prewarm failed", { error: err?.message }));
    }

    const transport = new StdioServerTransport();

    // Both startup activation paths -- pre-warm and the opt-in auto-load --
    // wait for the downstream client's initialize handshake to complete.
    // Protocol.connect() below only starts the transport; the SDK records
    // the client's declared capabilities in _oninitialize and fires
    // `oninitialized` on the client's notifications/initialized. Upstream
    // connects mirror that capability snapshot at Client construction
    // (upstream.ts reads bridge.getClientCapabilities() once), so an
    // upstream spawned before initialize deterministically mirrors EMPTY
    // capabilities -- and when an explicit activate later joins a prewarm
    // inflight and keeps that connection alive, elicitation/sampling/roots
    // forwarding is silently dead for the connection's whole lifetime.
    // A client that never initializes never triggers either path: with no
    // downstream there is nothing to serve. Registered BEFORE connect so
    // a fast client can't complete the handshake into a missing callback.
    this.server.oninitialized = () => {
      // Dormant servers (isActive but no persisted toolCache yet) are
      // invisible in tools/list because getDeferredServers() filters on
      // toolCache presence. That breaks the "I toggled it on in the
      // bundles.json and it disappeared" user experience. Pre-warm each one
      // in the background: activate → populate the in-memory toolCache
      // → disconnect so we're not holding 9 upstream processes idle.
      // Fire-and-forget so this doesn't gate the handshake response.
      this.prewarmDormantServers().catch((err: Error) => log("warn", "Pre-warm failed", { error: err?.message }));

      // Opt-in auto-load of the top recurring pack. Requires persistence
      // (so there IS a history to learn from) AND YAW_MCP_AUTO_LOAD=1. Runs
      // alongside prewarm so both paths see the same config snapshot;
      // they're independent (prewarm populates toolCache for newly-enabled
      // servers, this one spins up the recurring workflow's servers for
      // real). Fire-and-forget — the handshake shouldn't block on it.
      if (isAutoLoadEnabled()) {
        if (this.persistenceReady) {
          this.autoLoadRecurringPack().catch((err: Error) => log("warn", "Auto-load failed", { error: err?.message }));
        } else {
          // The flag is set but there is no history to replay from, so the
          // recurring pack will never load -- and without this line nothing
          // says why. persistenceReady is false for exactly two reasons (see
          // the state hydration at the top of start()), so name the one that
          // applies. Once per session: oninitialized fires once.
          log("info", "YAW_MCP_AUTO_LOAD is set but persisted history is unavailable; skipping auto-load", {
            reason: isPersistenceDisabled() ? "YAW_MCP_DISABLE_PERSISTENCE is set" : "state.json could not be read",
          });
        }
      }
    };
    await this.server.connect(transport);

    // Self-upgrade check: if this install is stale, upgrade it in the
    // background so the next client restart runs the latest version.
    // Fire-and-forget -- never awaited, never gates transport readiness.
    // Not handshake-gated: it spawns no upstream, so the capability
    // snapshot is irrelevant to it.
    maybeAutoUpgrade().catch((err: Error) => log("warn", "Auto-upgrade check failed", { error: err?.message }));

    // The same check one level down: maybeAutoUpgrade above refreshes yaw-mcp
    // itself, this refreshes the managed SIDECAR tree it spawns servers from.
    // Needed because `sidecars install` trades npx's per-spawn re-resolution
    // for a copy on disk -- an oam-hosted server runs that copy and cannot
    // re-resolve "@latest", so without this the tree sits at whatever version
    // the last manual `yaw-mcp sidecars install` happened to fetch, forever.
    // No-op for npx users (nothing managed to refresh) and for explicitly
    // pinned specs, which are the user's stated version and never auto-moved.
    //
    // Fire-and-forget for its sibling's reasons, and emphatically not awaited:
    // the work it can trigger is an `npm install` that runs for tens of
    // seconds. Ordering against maybeAutoUpgrade does not matter -- they touch
    // different trees (the global prefix vs ~/.yaw-mcp/sidecars) and each
    // serializes itself with its own lockfile.
    maybeRefreshSidecars().catch((err: Error) => log("warn", "Sidecar refresh check failed", { error: err?.message }));

    log("info", "yaw-mcp started", {
      servers: this.config?.servers.length ?? 0,
    });
  }

  // Auto-activate the single highest-ranked pack whose every namespace
  // is installed. Opt-in via YAW_MCP_AUTO_LOAD. Silent no-op when there's
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
    const loaded: string[] = [];
    const refused: { namespace: string; message: string }[] = [];
    for (const namespace of top.namespaces) {
      try {
        const result = await this.activateOne(namespace);
        if (result.ok) {
          loaded.push(namespace);
          // Advertise it. Under the default gateway exposure a connected
          // namespace is invisible in tools/list until it lands here, so
          // without this the feature spends a server-cap slot and a child
          // process on a pack the client still has to discover + activate
          // before it can call anything -- exactly the step
          // YAW_MCP_AUTO_LOAD says it skips. The pack is the user's OWN
          // recurring workflow, replayed from persisted history, which is
          // an intent signal at least as strong as the discover(context)
          // auto-warm that records the same way. Successes only, matching
          // handleActivate.
          this.sessionActivated.add(namespace);
        } else {
          // activateOne returns ok:false on cap rejection, profile
          // refusal, "not installed", etc. -- not an exception path.
          refused.push({ namespace, message: result.message });
        }
      } catch (err) {
        refused.push({ namespace, message: (err as Error)?.message ?? "unknown error" });
      }
    }

    // Same obligation prewarm has: the namespaces we just activated are in
    // this.connections but toolRoutes still carries whatever start() built
    // (deferred entries, or nothing at all for a server with no toolCache).
    // Without this the first call on an auto-loaded tool takes the deferred
    // branch, sees the server already connected, and dead-ends on
    // "no longer available" — for a server that loaded fine seconds ago.
    if (loaded.length > 0) {
      await this.refreshRoutesAndNotify();
    }

    log("info", "Auto-loaded recurring pack", {
      loaded,
      refusedCount: refused.length,
      frequency: top.frequency,
    });
    if (refused.length > 0) {
      // Single aggregate warn so a SERVER_CAP=6 user with a 9-server
      // recurring pack gets one actionable line, not N silent ok:false
      // returns disappearing into the void.
      const message =
        loaded.length === 0
          ? "Auto-load could not activate any namespace in the pack"
          : "Auto-load could not activate every namespace in the pack";
      log("warn", message, {
        serverCap: this.serverCap,
        loadedCount: loaded.length,
        refused,
      });
    }
  }

  // Populate toolCache for any isActive server whose tools we don't know
  // yet, so Claude's tools/list shows the full toggled set on first run.
  // "Don't know yet" spans BOTH sources — the toolCache in bundles.json and
  // the one hydrated from state.json — so this is a one-time cost per
  // server rather than a per-session `npx -y <pkg>@latest` resolve for
  // every active server (which is what it degenerated into while the
  // learned cache had nowhere to persist). A learned list past
  // TOOLCACHE_REFRESH_MS counts as dormant again so @latest drift gets
  // re-learned weekly instead of only at the 30-day persistence expiry.
  private async prewarmDormantServers(): Promise<void> {
    // An already-connected namespace is never dormant, even when its
    // learned cache is past the refresh window: runActivateOne stamps a
    // fresh learnedAt on every real activation, and the connections here
    // (auto-loaded pack members, early explicit activates) are ones
    // prewarm didn't create and must not tear down. The isChanged gate
    // in the batch below covers the race where a namespace connects
    // between this snapshot and its activation turn.
    const dormant = this.getProfiledActiveServers().filter(
      (s) =>
        this.connections.get(s.namespace)?.status !== "connected" &&
        (!this.hasKnownTools(s) || this.isLearnedCacheStale(s.namespace)),
    );
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
            const result = await this.activateOne(server.namespace, undefined, /* fromPrewarm */ true);
            if (!result.ok) {
              // Release the claim activateOne(fromPrewarm) took. Prewarm owns
              // nothing here -- the activation failed, so there is no
              // connection to protect from a later explicit activate -- and a
              // claim left behind outlives this pass: a second prewarm sweep
              // (or any future reader of prewarmNamespaces) would read the
              // namespace as "currently claimed by prewarm" for the rest of
              // the session. Cheap now, and it stops the stale entry becoming
              // load-bearing later.
              this.prewarmNamespaces.delete(server.namespace);
              // A failed prewarm means the namespace gets no toolCache
              // entry and stays invisible in tools/list for the session --
              // the exact UX prewarm exists to prevent. Never silent.
              log("warn", "Pre-warm could not learn a dormant server's tools", {
                namespace: server.namespace,
                message: result.message,
              });
              return;
            }
            // isChanged:false means runActivateOne's already-connected
            // early return fired -- someone else (an earlier batch's claimed
            // activate, auto-load, a client call) connected this namespace
            // after the dormant snapshot. Prewarm spawned nothing, so it
            // owns nothing to tear down; disconnecting here would kill a
            // LIVE connection. Drop the prewarm claim and leave it alone.
            if (!result.isChanged) {
              this.prewarmNamespaces.delete(server.namespace);
              return;
            }
            // Only disconnect if no explicit activate claimed this namespace
            // while the inflight promise was in flight. If an explicit activate
            // joined our shared promise, prewarmNamespaces will no longer
            // contain this namespace (activateOne with fromPrewarm=false clears
            // it), so we leave the connection alive for the user.
            if (!this.prewarmNamespaces.has(server.namespace)) {
              log("info", "Pre-warm skipping disconnect — namespace claimed by explicit activate", {
                namespace: server.namespace,
              });
              anyPopulated = true;
              return;
            }
            this.prewarmNamespaces.delete(server.namespace);
            // Immediately disconnect — the tool list is already in
            // this.toolCache, so getDeferredServers() surfaces the
            // server without us holding the upstream process alive.
            const conn = this.connections.get(server.namespace);
            if (conn) {
              await disconnectFromUpstream(conn).catch(() => {});
              // Re-read the map after the await and only drop the entry when
              // it is still OUR connection. disconnectFromUpstream marks the
              // old connection "disconnected" synchronously, so an explicit
              // activate that starts during the close sees a dead connection,
              // spawns a fresh child, and re-registers under the same key.
              // An unconditional delete here would orphan that child: live,
              // unreferenced, and invisible to shutdown().
              if (this.connections.get(server.namespace) === conn) {
                this.connections.delete(server.namespace);
                this.idleCallCounts.delete(server.namespace);
              }
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
      await this.refreshRoutesAndNotify();
    }
  }

  // One-shot nudge: if an YAW-MCP.md guide was loaded at startup but the
  // client hasn't read `yaw-mcp://guide` yet, append a short reminder to
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
    const text = `[yaw-mcp] Tip: read the \`yaw-mcp://guide\` resource for project-specific routing & credential guidance (from ${sources}). This hint appears once per session.`;
    // Appended as its OWN text block, never spliced into an existing one:
    // exec and secrets return a single block whose text is JSON.stringify
    // of a documented payload, and tacking prose onto that text breaks
    // JSON.parse on the body the tool description promises. A separate
    // block keeps every documented body byte-identical. Building a fresh
    // content array (rather than pushing in place) also matters: some
    // callers hand us a result that is ALSO held elsewhere --
    // buildDiscoverOutput stores its result in discoverCache -- so
    // mutating content in place would bake this once-per-session hint
    // into the cached body and replay it on every cache hit for the rest
    // of the TTL.
    return { ...result, content: [...result.content, { type: "text", text }] };
  }

  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
    extra?: { sendNotification?: any; _meta?: Record<string, unknown> },
    // When deferLearning is set (exec steps), the proxy path does NOT record
    // the cross-session learning signal — handleExec records step-level,
    // cascading-blame credit instead so a failing consumer doesn't wrongly
    // sink the upstream that fed it.
    //
    // deferIdleTracking is the same idea for the idle reaper: an exec step
    // must not tick every OTHER namespace's idle counter, or a 10-step
    // pipeline on A ages B by 10 calls and can evict B mid-pipeline (the
    // step after next may be routed to it). handleExec ticks ONCE for the
    // whole pipeline instead — see the trackUsageForNamespaces call there.
    opts?: { deferLearning?: boolean; deferIdleTracking?: boolean },
    // `text` optional, matching routeToolCall (proxy.ts): the proxy path
    // returns the UPSTREAM's body, and an image / audio / resource content
    // block carries no text. The meta-tool branches below all produce text and
    // are assignable to this wider shape.
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
    const progress = createProgressReporter(extra);
    if (name === META_TOOLS.discover.name) {
      // When the LLM supplies task context, automatically warm the top
      // confident candidate so a one-shot discover() is enough to start
      // calling tools. Ambiguous queries fall through to the manual list.
      // typeof guard like every sibling arg (intent, server, tool): the
      // low-level Server does not validate tool input against inputSchema,
      // so a non-string context from a misbehaving client would otherwise
      // survive the `!context` falsiness check and throw a TypeError inside
      // the BM25 tokenizer -- surfacing as a raw JSON-RPC internal error
      // instead of a tool result.
      return this.attachGuideNudge(
        await this.handleDiscoverWithAutoWarm(typeof args.context === "string" ? args.context : undefined, progress),
      );
    }
    if (name === META_TOOLS.dispatch.name) {
      const intent = typeof args.intent === "string" ? args.intent : "";
      const budget = typeof args.budget === "number" && Number.isFinite(args.budget) ? args.budget : 1;
      // Per-call override of the routing effort dial (off|auto|aggressive);
      // falls back to YAW_MCP_ROUTE_EFFORT when absent. See sampling-rank.ts.
      const routeEffort = typeof args.routeEffort === "string" ? args.routeEffort : undefined;
      return this.attachGuideNudge(await this.handleDispatch(intent, budget, progress, routeEffort));
    }
    if (name === META_TOOLS.activate.name) {
      const namespaces = resolveNamespaces(args);
      // `tools` is only meaningful when activating a single server —
      // a flat list of bare names has no unambiguous mapping to a
      // multi-server call. For any other shape the filter is reset
      // (see handleActivate), matching the "activate without tools
      // clears the filter" rule.
      //
      // Non-string entries are DROPPED, not fatal -- the same rule
      // resolveNamespaces applies to `servers`. The raw value is untyped tool
      // input, and discarding the whole array on one bad entry handed a
      // malformed NARROWING request to the clear-the-filter branch, so
      // `tools: ["foo", 42]` widened the advertised surface to every tool.
      // Only when nothing usable survives does the request mean "no filter".
      let toolsFilter: string[] | undefined;
      if (namespaces.length === 1 && Array.isArray(args.tools)) {
        const names = args.tools.filter((t): t is string => typeof t === "string" && t.length > 0);
        toolsFilter = names.length > 0 ? names : undefined;
      }
      const result = await this.handleActivate(namespaces, progress, toolsFilter);
      return this.attachGuideNudge(result);
    }
    if (name === META_TOOLS.deactivate.name) {
      const namespaces = resolveNamespaces(args);
      const result = await this.handleDeactivate(namespaces);
      return this.attachGuideNudge(result);
    }
    if (name === META_TOOLS.health.name) {
      return this.attachGuideNudge(this.handleHealth());
    }
    if (name === META_TOOLS.read_tool.name) {
      const serverArg = typeof args.server === "string" ? args.server : "";
      const toolArg = typeof args.tool === "string" ? args.tool : "";
      const result = await this.handleReadTool(serverArg, toolArg, progress);
      return this.attachGuideNudge(result);
    }
    if (name === META_TOOLS.suggest.name) {
      return this.attachGuideNudge(this.handleSuggest());
    }
    if (name === META_TOOLS.exec.name) {
      const result = await this.handleExec(args);
      return this.attachGuideNudge(result);
    }
    if (name === META_TOOLS.bundles.name) {
      const action = args.action === "match" ? "match" : "list";
      return this.attachGuideNudge(this.handleBundles(action));
    }
    if (name === META_TOOLS.secrets.name) {
      const serverArg = typeof args.server === "string" ? args.server : undefined;
      return this.attachGuideNudge(await this.handleSecretsReport(serverArg));
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
      // Capture the namespace before the re-snapshot below reassigns
      // `route` (which can go undefined). The messages downstream must
      // name the namespace we activated, matching the reconnect path.
      const deferredNs = route.namespace;
      // Sampled BEFORE activateOne, exactly like the reconnect path below:
      // false means this call STARTS the activation (its initiator), true
      // means it JOINS one already in flight, so only the initiator sends
      // the list_changed triplet. Without it, N parallel first-calls on one
      // dormant server each emitted three notifications and made the client
      // refetch the whole catalog N times for a single load. The prewarm
      // exclusion matters: a prewarm-initiated inflight notifies only when
      // the whole sweep finishes, so a caller joining THAT one must still
      // notify itself. Order is load-bearing -- prewarm registers its claim
      // before its inflight entry, and an explicit activateOne deletes the
      // claim, so both reads have to happen before the call.
      const joinedExisting = this.activationInflight.has(deferredNs) && !this.prewarmNamespaces.has(deferredNs);
      progress?.(`Loading "${deferredNs}" on first tools/call…`);
      const activation = await this.activateOne(deferredNs, progress);
      if (!activation.ok) {
        return brandRoutingFault({
          content: [
            {
              type: "text",
              text: `Server "${deferredNs}" ${ROUTING_FAULT_LOAD_FAILED}: ${activation.message}`,
            },
          ],
          isError: true,
        });
      }
      // Rebuild unconditionally on a successful activation, NOT only when
      // isChanged. We got here holding a `deferred` route, so toolRoutes is
      // stale by construction; isChanged is false whenever the namespace was
      // already connected (auto-warmed by discover, loaded by dispatch, or
      // activated concurrently), and gating on it left the deferred entry in
      // place — which then fails the re-snapshot below with the misleading
      // "no longer available" error that no retry can clear. The NOTIFY half
      // is the initiator's job only (see joinedExisting above); a joiner
      // still rebuilds locally, which is synchronous, idempotent and silent.
      if (joinedExisting) {
        this.rebuildRoutes();
      } else {
        await this.refreshRoutesAndNotify();
      }
      // Re-snapshot against fresh routes. If the upstream no longer
      // exposes a tool by this name (cache was stale), fall through to
      // the routes.get(name) miss path below with a clear message.
      routes = this.toolRoutes;
      route = routes.get(name);
      if (!route || route.deferred) {
        return brandRoutingFault({
          content: [
            {
              type: "text",
              text: `Tool "${name}" is ${ROUTING_FAULT_TOOL_GONE} after loading "${deferredNs}" — the upstream's tool set changed. Call mcp_connect_discover to list the current tools for that namespace.`,
            },
          ],
          isError: true,
        });
      }
    }

    if (route) {
      // Capture the namespace once: `route` is reassigned by the re-snapshot
      // below (and is captured in the .find closure), which widens it back to
      // Route | undefined for the rest of this block. The namespace being
      // reconnected is invariant across the re-snapshot, so a stable local
      // keeps the in-block references correctly typed.
      const ns = route.namespace;
      const conn = this.connections.get(ns);
      if (conn && conn.status === "error") {
        const serverConfig = this.config?.servers.find((s) => s.namespace === ns);
        if (serverConfig) {
          // Route the reconnect through activateOne rather than calling
          // connectToUpstream inline. The inline path was a second,
          // unguarded activation surface: it bypassed the in-flight dedup,
          // the server cap (with a self-allowance for the slot this
          // namespace already owns -- see evaluateCapFor), the
          // compliance/profile gates, the shuttingDown latch, and the
          // toolCache/learnedAt/activationFailures refresh. activateOne
          // provides all of those plus the same retry and elicited-env
          // re-injection semantics (runActivateOne merges this.elicitedEnv
          // and retries once).
          //
          // ORDER MATTERS: the dead transport is closed AFTER the
          // activation settles, never before. The old shape disconnected
          // first, and disconnectFromUpstream flips status to
          // "disconnected" synchronously -- so for the whole respawn await,
          // a concurrent tools/call failed this branch's status === "error"
          // gate, fell through to routeToolCall, and got a spurious "no
          // longer connected" fault while yaw-mcp was itself
          // mid-reconnect. Leaving the error-state entry in the map keeps
          // every concurrent caller entering THIS branch, where
          // activateOne's dedup makes them all await the one shared
          // respawn. runActivateOne replaces the map entry on success
          // without closing the old client, so the close below is the old
          // transport's only teardown.
          const staleConn = conn;
          // Sampled BEFORE activateOne: false means we are about to START
          // the activation (its initiator); true means we will JOIN one
          // already in flight. Used below to send the list_changed
          // notifications exactly once per reconnect.
          const joinedExisting = this.activationInflight.has(ns);
          progress?.(`Reconnecting "${ns}"…`);
          const activation = await this.activateOne(ns, progress);
          if (!activation.ok) {
            // Close the dead transport (idempotent, swallows errors), then
            // restore "error" so a later call can still retry -- this
            // branch gates on it.
            await disconnectFromUpstream(staleConn);
            staleConn.status = "error";
            log("error", "Auto-reconnect failed", { namespace: ns, error: activation.message });
            return brandRoutingFault({
              content: [
                {
                  type: "text",
                  text: `Server "${ns}" disconnected and ${ROUTING_FAULT_RECONNECT_FAILED}: ${activation.message} Use mcp_connect_activate with server "${ns}" to reload it manually.`,
                },
              ],
              isError: true,
            });
          }
          // Success: the map now holds the fresh connection; close the
          // orphaned old transport. The guard's ONE invariant is never
          // closing the connection currently in the map (the live one).
          // Every sharer of a deduped activation passes the check and
          // closes staleConn -- that repeat close is safe only because
          // disconnectFromUpstream is idempotent and swallows close errors
          // (and the "error" status means the transport was already dead).
          // Do not make disconnectFromUpstream non-idempotent.
          if (this.connections.get(ns) !== staleConn) {
            await disconnectFromUpstream(staleConn);
          }
          log("info", "Auto-reconnected to upstream", { namespace: ns });
          // Rebuild is needed by construction (we got here holding a route
          // into a dead connection, and the fresh upstream's tool set may
          // differ) -- so EVERY sharer rebuilds the routing tables locally
          // (synchronous, idempotent, no wire traffic) before its own
          // re-dispatch. The list_changed NOTIFICATIONS, though, go out
          // once per reconnect: only the activation's initiator sends
          // them. Notifying per sharer emitted N x three list_changed
          // triplets (and N list refetches from clients like Claude Code)
          // for one reconnect. If the upstream no longer exposes a tool by
          // this name, surface the same clear "no longer available"
          // message the deferred path emits.
          if (joinedExisting) {
            this.rebuildRoutes();
          } else {
            await this.refreshRoutesAndNotify();
          }
          routes = this.toolRoutes;
          route = routes.get(name);
          if (!route || route.deferred) {
            return brandRoutingFault({
              content: [
                {
                  type: "text",
                  text: `Tool "${name}" is ${ROUTING_FAULT_TOOL_GONE} after reconnecting "${serverConfig.namespace}" — the upstream's tool set changed. Call mcp_connect_discover to list the current tools for that namespace.`,
                },
              ],
              isError: true,
            });
          }
        }
      }
    }

    // Capture the connection ref BEFORE the await. The map entry for this
    // namespace can be swapped out from under the call while the upstream
    // is working -- an auto-reconnect re-registering under the same key, the
    // idle reaper or prewarm teardown deleting it -- and the health stats
    // below must be booked on the connection that actually served the call,
    // not on whatever holds the key afterwards (or on nothing).
    const connForHealth = route ? this.connections.get(route.namespace) : undefined;

    // Mark the namespace busy for the duration of the upstream call. The
    // idle reaper (trackUsageAndAutoDeactivate) runs on OTHER calls'
    // completions, and this namespace's idle counter is only reset AFTER
    // this call returns — so without the marker a burst of short calls to A
    // can tip a slow, still-in-flight B over its threshold, close B's
    // transport, reject the user's pending call, and book the rejection as
    // B's own 0.0 reward.
    const callNamespace = route?.namespace;
    if (callNamespace !== undefined) {
      this.inflightCalls.set(callNamespace, (this.inflightCalls.get(callNamespace) ?? 0) + 1);
    }
    const startMs = Date.now();
    // Route against the snapshot, not this.toolRoutes, so a rebuild
    // between the initial lookup and this call can't misdirect us.
    let result: { content: Array<{ type: string; text?: string }>; isError?: boolean };
    try {
      result = await routeToolCall(name, args, routes, this.connections);
    } finally {
      if (callNamespace !== undefined) {
        const remaining = (this.inflightCalls.get(callNamespace) ?? 1) - 1;
        if (remaining > 0) this.inflightCalls.set(callNamespace, remaining);
        else this.inflightCalls.delete(callNamespace);
      }
    }
    const latencyMs = Date.now() - startMs;

    if (route) {
      // yaw-mcp's own routing faults (stale toolCache, dropped connection,
      // failed auto-reconnect, failed deferred load) say nothing about the
      // upstream's reliability. Keep them out of the health error stats,
      // the learning signal, the reward grader, and the graded redispatch
      // reply below -- the same guard handleExec applies to its step
      // attribution. Without this, any call landing in the window between
      // disconnectFromUpstream and connections.delete (idle reaper, prewarm
      // teardown) booked a 0.0 outcome against a healthy server for
      // yaw-mcp's own fault -- exactly what the ROUTING_FAULT_* comment
      // above promises does not happen. Checked STRUCTURALLY (the brand
      // every fault emitter attaches), not by text: an upstream error that
      // happens to contain a marker phrase must still be booked.
      const routingFault = result.isError === true && isRoutingFaultResult(result);
      // A routing fault is a NON-observation for health, not a success: it
      // must skip totalCalls and totalLatencyMs as well as errorCount.
      // Booking the call without the error would dilute a genuinely flaky
      // server's error rate toward 0 (healthFactor is errorCount /
      // totalCalls), push totalCalls past the observation floor with zero
      // real upstream observations, and drag average latency toward the
      // fault's near-0ms -- the opposite bias, not neutrality.
      if (connForHealth && !routingFault) {
        connForHealth.health.totalCalls++;
        connForHealth.health.totalLatencyMs += latencyMs;
        if (result.isError) {
          connForHealth.health.errorCount++;
          connForHealth.health.lastErrorMessage = result.content[0]?.text;
          connForHealth.health.lastErrorAt = new Date().toISOString();
        }
      }

      // Prune the response before it hits the LLM. Rules are
      // conservative (drop null / undefined / empty collections,
      // collapse runs of blank lines) so we trim obvious dead weight
      // without changing meaning. Disable with YAW_MCP_PRUNE_RESPONSES=0
      // if a caller needs the exact upstream bytes through.
      //
      // Error responses skip pruning entirely — the text IS the error
      // message, and stripping nulls or collapsing whitespace could
      // obscure it.
      //
      // A result carrying `structuredContent` skips pruning too. Per MCP
      // 2025-06-18 a tool with an outputSchema returns BOTH the structured
      // payload and a text fallback that is supposed to mirror it, and the
      // proxy passes structuredContent through verbatim (types.ts). Pruning
      // only the text side makes the two representations of one result
      // disagree -- a required field whose value is null survives in
      // structuredContent and vanishes from the text -- which is worse for a
      // reader than the bytes the prune would have saved. The cast is because
      // handleToolCall's local result type names only content/isError; the
      // field rides along at runtime from the upstream body.
      const hasStructuredContent = (result as { structuredContent?: unknown }).structuredContent !== undefined;
      if (!result.isError && !hasStructuredContent && Array.isArray(result.content)) {
        try {
          const pr = pruneContent(result.content as Content[]);
          // Only swap in the pruned body when it's actually smaller,
          // per the MIN_SAVINGS_RATIO check inside pruneContent.
          if (pr.bytesPruned < pr.bytesRaw) result.content = pr.content;
        } catch (err: any) {
          // Pruner should never throw; if it does, pass the upstream
          // content through untouched rather than failing the call.
          log("warn", "pruneContent failed", { error: err?.message });
        }
      }
      // Cross-session learning signal — GRADED, not binary. recordOutcome
      // records both the dispatch (denominator) and a quality-weighted
      // credit in [0,1]: a clean-but-empty or error-shaped 200 no longer
      // banks full credit (see reward.ts/computeOutcomeReward). This is the
      // ground truth that boostFactor + formatReliabilityWarning + the
      // cross-session reliability block in handleHealth all read — activation
      // success is deliberately NOT counted here (see handleDispatch). Exec
      // steps defer it (opts.deferLearning) for step-level attribution.
      if (!opts?.deferLearning && !routingFault) {
        const reward = computeOutcomeReward(result);
        this.learning.recordOutcome(route.namespace, reward);
        this.scheduleStateSave();
        // The learning counters feed discover's `usage:` / `reliability:`
        // lines, which the cache key doesn't cover — drop the memo so the
        // next discover reflects the call that just happened.
        this.invalidateDiscoverCache();
        // Optional LLM grader (opt-in, YAW_MCP_REWARD_GRADER): on the uncertain
        // heuristic bands only, ask the client LLM whether the call actually
        // accomplished the goal and revise the credit in the BACKGROUND. The
        // tool result is not held up -- the correction lands when the grade does.
        if (isRewardGraderEnabled() && isUncertainReward(reward)) {
          void this.refineRewardInBackground(route.namespace, reward, {
            intent: this.lastIntentByNamespace.get(route.namespace),
            toolName: route.originalName,
            resultText: firstResultText(result),
          });
        }
      }

      // Re-dispatch routing-miss tracking: record whether the server the
      // model most recently dispatched to produced a clean reply. An
      // abandoned clean reply becomes a negative signal when a similar
      // intent later re-routes elsewhere (detectMiss in handleDispatch).
      // OUTSIDE the deferLearning guard, like packDetector below: exec
      // steps are real USAGE of the namespace even though their learning
      // credit is attributed per step by handleExec. Skipping them let
      // detectMiss flag a server as an abandoned "loser" after a
      // direct-call-then-exec sequence in which the model never left it.
      if (!routingFault) {
        this.redispatch.markReply(route.namespace, !result.isError);
      } else {
        // A routing fault must not GRADE the record (it says nothing about
        // the server), but it must still count as USAGE: before the guard,
        // this fault called markReply(ns, false), whose second-reply path
        // set furtherUse and protected a clean earlier record from
        // detectMiss. Skipping the tracker entirely would leave that
        // record frozen as cleanReply-without-furtherUse and let yaw-mcp's
        // own teardown fault turn into a recordMiss penalty.
        this.redispatch.markUse(route.namespace);
      }

      // Only count successful calls toward chain detection. An errored
      // call isn't a real usage signal — the user likely abandons or
      // retries on a different server. Meta-tools were short-circuited
      // above so they never reach this point.
      if (!result.isError) {
        this.packDetector.recordCall(route.namespace, route.originalName, Date.now());
      }
      if (!opts?.deferIdleTracking) {
        await this.trackUsageAndAutoDeactivate(route.namespace);
      }
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
  //
  // NAME hits win over DESCRIPTION hits, and the whole list is collected
  // before the cap is applied. This is a bare set-intersection with no IDF
  // to flatten a common term (`queryTokens` already dropped the closed-class
  // words -- see tokenizeForSummary), so a term that survives can still be
  // common in prose: taking the first five in LIST order dropped a tool
  // whose NAME matched in favor of five earlier tools that merely mention
  // the word in their description.
  private matchedToolNames(server: UpstreamServerConfig, queryTokens: Set<string>): string[] {
    const tools = this.rankableFor(server).tools;
    if (tools.length === 0) return [];
    const nameHits: string[] = [];
    const descHits: string[] = [];
    for (const tool of tools) {
      const nameTokens = tool.name.toLowerCase().split(/[^a-z0-9]+/);
      if (nameTokens.some((t) => queryTokens.has(t))) {
        nameHits.push(tool.name);
        continue;
      }
      const descTokens = (tool.description ?? "").toLowerCase().split(/[^a-z0-9]+/);
      if (descTokens.some((t) => queryTokens.has(t))) descHits.push(tool.name);
    }
    const hits = [...nameHits, ...descHits];
    if (hits.length > 0) return hits.slice(0, 5);
    return tools.slice(0, 3).map((t) => t.name);
  }

  // The BM25 view of one server. A LIVE tool list wins outright; a cold
  // server's list comes from mergeToolCache, which is the ONE precedence rule
  // between the learned (this.toolCache) and curated (server.toolCache)
  // lists. This used to carry its own `sessionCache ?? persistedCache` chain,
  // under which an EMPTY learned list beat a curated one -- the opposite of
  // what discover's `known tools:` line and getDeferredServers showed for the
  // same server. mergeToolCache is idempotent, so callers that already pass a
  // merged server (every current one does) pay one small clone and nothing
  // else.
  private rankableFor(server: UpstreamServerConfig): RankableServer {
    const connection = this.connections.get(server.namespace);
    const liveTools = connection?.tools.map((t) => ({ name: t.name, description: t.description }));
    return {
      namespace: server.namespace,
      name: server.name,
      description: server.description,
      tools: liveTools ?? this.mergeToolCache(server).toolCache ?? [],
    };
  }

  // BM25 shortlist cap — wider than the budget so downstream re-sorts
  // (health penalty, learning boost, sampling tiebreak) have room to
  // promote a server BM25 ranked below the head of the list.
  private static readonly BM25_TOP_K = 25;

  // Local BM25 ranking over the profiled active servers. Shared by
  // discover's auto-warm gate and dispatch so both pick the same winner
  // for the same intent.
  private async twoStageRank(
    context: string,
    servers: UpstreamServerConfig[],
  ): Promise<Array<{ namespace: string; score: number }>> {
    const bm25Input = servers.map((s) => this.rankableFor(s));
    const bm25 = rankServers(context, bm25Input);
    if (bm25.length === 0) return [];
    return bm25.slice(0, ConnectServer.BM25_TOP_K);
  }

  // Auto-warm confidence gate — applied to discover(context) so a single
  // clearly-winning server gets activated without the LLM needing to
  // follow up with a separate activate call. Default ON; flip off with
  // YAW_MCP_AUTO_ACTIVATE=0 if it causes surprise. The env read lives in
  // the module-level isAutoActivateEnabled() (re-read per call) rather
  // than a static initializer, which would latch the value at import.
  //
  // Top score must clear this floor AND the gap over the runner-up must
  // be convincing before we auto-activate. BM25 scores are unbounded
  // positive numbers. Tuned by intuition; revisit when we have real
  // usage data.
  private static readonly AUTO_ACTIVATE_MIN_SCORE_BM25 = 1.0;
  private static readonly AUTO_ACTIVATE_MARGIN_BM25 = 1.3;

  // Below this installed-server count, discover() appends a one-line
  // marketplace pointer so sparse-config users see where to add more.
  // At or above the threshold we stay silent — power users already know
  // the score, and the line would just be chat noise.
  private static readonly MARKETPLACE_HINT_THRESHOLD = 5;

  private handleDiscover(context?: string): { content: Array<{ type: string; text: string }> } {
    return this.buildDiscoverOutput(context, /* warmedNamespace */ null);
  }

  private async handleDiscoverWithAutoWarm(
    context?: string,
    progress?: ProgressReporter,
  ): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (!context || !isAutoActivateEnabled()) return this.handleDiscover(context);

    const activeServers = this.getProfiledActiveServers();
    if (activeServers.length === 0) return this.handleDiscover(context);

    // Use the same ranker dispatch uses so discover + dispatch pick the
    // same winner for the same intent.
    const ranked = await this.twoStageRank(context, activeServers);
    if (ranked.length === 0) return this.handleDiscover(context);

    // Only auto-warm if one candidate dominates: top score clears the
    // floor and either stands alone or beats the runner-up by the
    // margin.
    const top = ranked[0];
    const second = ranked[1];
    const minScore = ConnectServer.AUTO_ACTIVATE_MIN_SCORE_BM25;
    const margin = ConnectServer.AUTO_ACTIVATE_MARGIN_BM25;
    const topWinsDecisively =
      top !== undefined &&
      top.score >= minScore &&
      (second === undefined || top.score / (second.score || 1e-6) >= margin);

    if (!topWinsDecisively || !top) return this.handleDiscover(context);

    // Already connected -- nothing to SPAWN, but under gateway exposure
    // "connected" is not "advertised": a prewarm-claimed winner, or one
    // connected by a deferred first tools/call, is still invisible in
    // tools/list because the client never asked for the server itself.
    // The pick is intent-driven (the client's context chose it), so record
    // it like the freshly-warmed path below, notify if that grew the
    // advertised set, and name it in the banner -- otherwise the one-shot
    // discover(context) promise breaks exactly when the server was already
    // warm, and this branch stays asymmetric with dispatch's handling of
    // an already-connected winner.
    const existing = this.connections.get(top.namespace);
    if (existing && existing.status === "connected") {
      // Claim it, as activateOne(fromPrewarm=false) would: if this connection
      // is prewarm's (its teardown has not run yet), prewarm must see the
      // claim and leave it alive -- otherwise it closes the very server this
      // response is about to call "Auto-loaded". The other two intent-driven
      // sites (handleActivate, handleDispatch) get this from activateOne;
      // this shortcut bypasses it and so has to do it by hand.
      this.prewarmNamespaces.delete(top.namespace);
      const grew = !this.sessionActivated.has(top.namespace);
      this.sessionActivated.add(top.namespace);
      if (grew) {
        // Routes are current (whoever connected it rebuilt them); only the
        // tools/list surface moved.
        await this.notifyAllListsChanged();
      }
      return this.buildDiscoverOutput(context, top.namespace);
    }

    progress?.(`Auto-warming top candidate "${top.namespace}"`);
    const result = await this.activateOne(top.namespace, progress);
    if (result.ok) {
      // Auto-warm exists so a one-shot discover(context) is enough to
      // start calling tools -- under the default gateway exposure that
      // only holds if the warmed namespace is advertised, so record it
      // like handleActivate/handleDispatch do. This is intent-driven (the
      // client supplied the context that picked the winner), unlike
      // prewarm or the deferred first-call path.
      this.sessionActivated.add(top.namespace);
      // The namespace is connected now, so its `deferred` route (built from
      // the persisted toolCache) is stale. Every other activation site
      // rebuilds + notifies; skipping it here wedged the very next
      // tools/call on this server behind a "no longer available" error.
      await this.refreshRoutesAndNotify();
      log("info", "Auto-warmed top-ranked server on discover", { namespace: top.namespace, score: top.score });
    }

    // Pass the namespace we ACTUALLY warmed, not a bare boolean: the
    // banner below must name the server twoStageRank picked, which is
    // not necessarily the head of the list the output renders.
    const output = this.buildDiscoverOutput(context, result.ok ? top.namespace : null);
    if (result.ok) return output;

    // Auto-warm failed. Say WHY, in the same response: result.message carries
    // the refusal (cap reached, compliance floor, profile, spawn error) and
    // was previously dropped on the floor. formatHealthWarning only renders
    // failures runActivateOne recorded in activationFailures, which a cap or
    // policy refusal never reaches -- so without this line a refused
    // auto-warm looks identical to a query that simply had no clear winner,
    // and the model retries the same discover.
    //
    // Appended as its OWN content block over a COPY of the output (the same
    // discipline attachGuideNudge documents): buildDiscoverOutput hands back
    // the object it memoized in discoverCache, so mutating it would bake this
    // one attempt's failure into every cache hit for the rest of the TTL.
    return {
      ...output,
      content: [
        ...output.content,
        {
          type: "text",
          text: `Could not auto-load "${top.namespace}" (top match for your query): ${result.message}`,
        },
      ],
    };
  }

  // Drop the memoized discover body. The cache key only covers
  // (configVersion, context, warmedNamespace, connected set, tool filters,
  // advertised set), so state that
  // discover RENDERS but the key does not see -- activation failures
  // (formatHealthWarning) and learning counters (usage:/reliability: lines)
  // -- has to invalidate explicitly. Without this the exact case the cache
  // was built for ("discover, failed activate, discover again") replays the
  // pre-failure text and the model retries the dead server.
  private invalidateDiscoverCache(): void {
    this.discoverCache = null;
  }

  private discoverCacheKey(context: string | undefined, warmedNamespace: string | null): string {
    const activeNamespaces = [...this.connections.entries()]
      .filter(([, c]) => c.status === "connected")
      .map(([ns]) => ns)
      .sort()
      .join(",");
    // Tool filters are part of the RENDERED body -- they drive the per-server
    // `loaded (N tools)` count, the `(filtered: K of N)` suffix, and the
    // session tool total. Installing a filter on an ALREADY-connected server
    // (activate with `tools`) changes none of the other key components, so
    // without this signature a discover inside the 3s TTL replayed the
    // unfiltered line and told the model tools were in context that tools/list
    // no longer advertises. Sorted on both axes so an identical filter set
    // always produces an identical key.
    const filterSignature = [...this.toolFilters.entries()]
      .map(([ns, names]) => `${ns}:${[...names].sort().join("+")}`)
      .sort()
      .join(";");
    // The ADVERTISED set, for the same reason as the filter signature: the
    // per-server status label, the token total and the `N tools in context`
    // line all key on it under gateway exposure, and activating a namespace
    // that was ALREADY connected moves only this set -- no other key
    // component changes, so without it a discover inside the 3s TTL would
    // still call the freshly-activated server "not advertised".
    const advertisedSignature = [...this.sessionActivated].sort().join(",");
    return `${this.configVersion ?? ""}|${context ?? ""}|${warmedNamespace ?? ""}|${activeNamespaces}|${filterSignature}|${advertisedSignature}`;
  }

  private buildDiscoverOutput(
    context: string | undefined,
    warmedNamespace: string | null,
  ): { content: Array<{ type: string; text: string }> } {
    const key = this.discoverCacheKey(context, warmedNamespace);
    const now = Date.now();
    const cached = this.discoverCache;
    if (cached && cached.key === key && cached.expires > now) {
      return cached.result;
    }
    const result = this.buildDiscoverOutputImpl(context, warmedNamespace);
    this.discoverCache = { key, result, expires: now + ConnectServer.DISCOVER_CACHE_TTL_MS };
    return result;
  }

  private buildDiscoverOutputImpl(
    context: string | undefined,
    warmedNamespace: string | null,
  ): { content: Array<{ type: string; text: string }> } {
    if (!this.config || this.config.servers.length === 0) {
      return { content: [{ type: "text", text: NO_SERVERS_INSTALLED_TEXT }] };
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
      // Index by namespace once rather than re-scanning activeServers for
      // every ranked entry (that was a linear find inside a map -- O(N^2)).
      const byNamespace = new Map(activeServers.map((s) => [s.namespace, s]));
      const matched = ranked
        .map((r) => byNamespace.get(r.namespace))
        .filter((s): s is UpstreamServerConfig => s !== undefined);
      const rankedSet = new Set(ranked.map((r) => r.namespace));
      const rest = activeServers.filter((s) => !rankedSet.has(s.namespace));
      sorted = [...matched, ...rest];
    } else {
      sorted = activeServers;
    }

    const lines: string[] = [context ? "Servers ranked by relevance:\n" : "Installed MCP servers:\n"];
    if (warmedNamespace) {
      lines.push(`Auto-loaded "${warmedNamespace}" — top match for your query.\n`);
    }

    // Compliance filter banner. When YAW_MCP_MIN_COMPLIANCE is active, the
    // per-server lines below will annotate any below-grade server with a
    // "won't auto-activate" marker; this header tells the model WHY
    // those markers are there so it doesn't try to activate them and
    // get a refusal surprise.
    const minCompliance = resolveMinCompliance();
    if (minCompliance !== null) {
      lines.push(`Compliance filter active: YAW_MCP_MIN_COMPLIANCE=${minCompliance}\n`);
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

    // Hoisted above the co-usage map because both blocks need it: pack
    // history is PERSISTED across restarts, so without the installed filter a
    // server the user has since removed from bundles.json still shows up in
    // another server's `often loaded with "<ns>"` line -- naming something
    // `activate` can no longer load. The Suggested-packs block below filters
    // exactly the same way.
    const installedNamespaces = new Set(activeServers.map((s) => s.namespace));
    // Precompute the co-usage map once per discover call. Derived from
    // the PackDetector's current history — same signal `suggest` surfaces,
    // but delivered inline so the LLM doesn't need a second meta-tool
    // roundtrip to see "often used with X."
    const chains = this.packDetector.detectChains();
    const coUsageMap = buildCoUsageMap(chains, installedNamespaces);

    // Inline "Suggested packs" block. Surfaces recurring co-activation
    // history from chains at the top of the output so the LLM can take
    // action in this call rather than needing a separate mcp_connect_suggest
    // round-trip. Filter: every namespace in the pack must be installed
    // (so `activate` can actually load them) AND at least one must not
    // be connected yet (otherwise the pack is already loaded — no action
    // to take). Ranked by frequency desc, tie-break by recency.
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

    // Under the default gateway exposure, CONNECTED is not ADVERTISED:
    // tools/list only surfaces namespaces the client asked for
    // (sessionActivated), so a server connected by prewarm's claim or by a
    // deferred first tools/call holds a process and a cap slot while
    // contributing nothing to the model's context. Every "what is in
    // context" number below -- the per-server status label, the token
    // accumulator, the session tool total -- keys on this predicate so the
    // summary means what it says. Resolved once per discover; the whole
    // body is rendered from one snapshot.
    const exposure = resolveToolExposure();
    const isAdvertised = (namespace: string): boolean => exposure === "full" || this.sessionActivated.has(namespace);

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
          : isAdvertised(server.namespace)
            ? `loaded (${exposed} tools)${filterSuffix}`
            : "connected (not advertised — activate to expose)"
        : "ready";

      const score = scores.get(server.namespace);
      const relevance = score && score > 0 ? ` (relevance: ${score.toFixed(2)})` : "";

      // Token-cost estimate — live for connected servers, tool-cache-
      // padded for dormant ones. Guides the LLM's activate/skip choice
      // when context budget is tight. Suppressed when we have nothing
      // to measure (no cache, no connection yet). When a filter is
      // active the cost reflects the EXPOSED tools only — hidden tools
      // don't surface in tools/list and therefore don't spend context. The
      // per-server label is rendered either way (it is what activating
      // WOULD cost), but only an advertised namespace adds to the session
      // total, which describes context actually spent.
      let costLabel = "";
      if (connection && connection.tools.length > 0) {
        const visible = filter ? connection.tools.filter((t) => filter.has(t.name)) : connection.tools;
        if (visible.length > 0) {
          const sample = estimateFromConnectedTools(visible);
          if (isAdvertised(server.namespace)) totalContextTokens += sample.tokens;
          costLabel = ` — ${formatCostLabel(sample)}`;
        }
      } else {
        // `server` came through getProfiledActiveServers, so this is the
        // merged list (see mergeToolCache) -- do not re-resolve it here.
        const cached = server.toolCache;
        if (cached && cached.length > 0) {
          costLabel = ` — ${formatCostLabel(estimateFromToolCache(cached))}`;
        }
      }

      // Compliance annotation — the grade is a trust signal, so it's
      // shown unconditionally whenever the backend has scored this
      // server (A–F). Passing graded server → `[A]` tag. When
      // YAW_MCP_MIN_COMPLIANCE is set and the grade is below it, replace
      // the tag with an inline refusal reason so the model knows why
      // the line is surfaced but won't be activated. Ungraded servers
      // stay unannotated — don't punish unknown on a catalog where
      // many entries aren't scored yet.
      let complianceLabel = "";
      if (server.complianceGrade) {
        if (minCompliance !== null && !passesMinCompliance(server.complianceGrade, minCompliance)) {
          // Distinguish an unrecognized grade string from a recognized
          // grade that ranks below the floor — both fail the filter, but
          // calling an unrecognized "Pass" grade "below B" is misleading.
          const label =
            classifyGrade(server.complianceGrade).kind === "unrecognized"
              ? `unrecognized, won't auto-activate`
              : `below YAW_MCP_MIN_COMPLIANCE=${minCompliance}, won't auto-activate`;
          complianceLabel = ` (grade ${server.complianceGrade} — ${label})`;
        } else {
          complianceLabel = ` [${server.complianceGrade}]`;
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

      // Dormant-reliability warning — pulls from persisted learning when
      // this server isn't currently loaded, so the LLM sees flaky history
      // before it tries to activate. Suppressed for loaded servers (the
      // live health warning above already covers them with fresher data).
      if (!connection) {
        const reliability = formatReliabilityWarning(this.learning.get(server.namespace));
        if (reliability) lines.push(`    ${reliability}`);
      }

      // Inline usage hint — cumulative success count + who tends to
      // get loaded alongside this server. Counts come from state.json
      // (persistence.ts) so they carry across yaw-mcp restarts. Silent
      // when neither signal has evidence yet. See usage-hints.ts.
      const usageHint = formatUsageHint(this.learning.get(server.namespace), coUsageMap.get(server.namespace) ?? []);
      if (usageHint) lines.push(`    ${usageHint}`);

      // Show cached tool names for servers that aren't currently connected.
      // Same merged list as the cost label above.
      if (!connection) {
        const cached = server.toolCache;
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

    // Bundle completions — inline install nudge for curated stacks where
    // the user already has ≥1 member installed. Top 3 by fewest-missing-
    // first (cheapest to complete), ties broken by most-momentum then id.
    // Suppressed when every bundle is either fully installed or entirely
    // absent. Same data source AND same server set as mcp_connect_bundles
    // action="match" and `yaw-mcp bundles match` (active + profile-allowed
    // via getProfiledActiveServers) but surfaced here so the model can act
    // without the extra round-trip. Feeding ALL configured servers here --
    // disabled and profile-blocked included -- made the three surfaces
    // disagree: a bundle whose only missing member was a DISABLED server
    // read as complete in discover while match called it partial.
    //
    // Reuses `activeServers` rather than calling getProfiledActiveServers()
    // a second time: it is the same list, and the re-call paid for another
    // mergeToolCache clone per server on every uncached discover.
    const allInstalled = activeServers.map((s) => s.namespace);
    const bundleGaps = topPartialBundles(allInstalled, 3);
    if (bundleGaps.length > 0) {
      lines.push("\nBundle completions (install to unlock curated stacks):");
      for (const { bundle, have, missing } of bundleGaps) {
        lines.push(`  ${bundle.id} — have: ${have.join(", ")}; add: ${missing.join(", ")}`);
      }
    }

    const inactive = this.config.servers.filter((s) => !s.isActive);
    if (inactive.length > 0) {
      lines.push("\nDisabled servers:");
      for (const server of inactive) {
        lines.push(`  ${server.namespace} — ${server.name} ("isActive": false in bundles.json)`);
      }
    }

    // Shadow-driven install candidates — its OWN section, gated OFF by
    // default. Only runs the offline shell-history scan when the gate is
    // on (env or config); otherwise this is a no-op and the output above
    // is byte-identical to a build without the feature. See
    // buildInstallCandidatesLines + install-nudge.ts.
    lines.push(...this.buildInstallCandidatesLines(activeServers));

    // Count CONNECTED connections only, the same slot definition the
    // concurrent-load cap uses (evaluateCapFor). An error-state entry is an
    // EMPTY slot to the cap, so counting it here made the summary claim a
    // server was "loaded in this session" that a concurrent activation could
    // take the slot of -- two different answers to one question. This is a
    // count of held SLOTS, deliberately not of advertised namespaces: a
    // connected-but-unadvertised server still occupies one.
    const activeCount = Array.from(this.connections.values()).filter((c) => c.status === "connected").length;
    // Count ADVERTISED, EXPOSED tools (post-filter) so the summary matches
    // what tools/list actually hands the client — hidden tools don't spend
    // context even though the upstream exposes them, and under gateway
    // exposure neither do the tools of a namespace the client never
    // activated (see isAdvertised above). Error-state connections are
    // excluded for the same reason they don't count as slots: their tools
    // are not reachable.
    const totalTools = Array.from(this.connections.values()).reduce((sum, c) => {
      const ns = c.config.namespace;
      if (c.status !== "connected" || !isAdvertised(ns)) return sum;
      const f = this.toolFilters.get(ns);
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
    // inactive) in the user's bundles.json; anyone under the cutoff gets a
    // one-line pointer at the public catalog. No API is hit — the catalog
    // is a static browsable surface, so this is a URL hint, not a full
    // meta-tool.
    if (this.config.servers.length < ConnectServer.MARKETPLACE_HINT_THRESHOLD) {
      lines.push(
        "Browse the catalog at https://yaw.sh/mcp/catalog/ and add servers with `yaw-mcp add <slug>` — they land in ~/.yaw-mcp/bundles.json and load on the next client restart.",
      );
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Build the opt-in "Install candidates" block from the offline shell-
  // history shadow scan. Returns [] (no lines, byte-identical output) when
  // the gate is off — the load-bearing privacy property: with the gate
  // unset the scan never runs and nothing about shell history is read.
  //
  // When ON, for each heavily-used CLI the scan found:
  //   - skip unless count >= INSTALL_NUDGE_MIN_COUNT (noise floor),
  //   - skip unless a FIRST-PARTY install target exists (installTargetForCli;
  //     a CLI like kubectl/npm/ssh with no target produces no nudge),
  //   - skip if ANY namespace the CLI maps to is already installed (the user
  //     already has a server that covers it — intersect the hit's namespaces
  //     with the installed set),
  //   - skip if the per-CLI cooldown hasn't elapsed (shouldNudge).
  // Surviving CLIs are recorded (recordNudges, one write per discover) so they stay suppressed for
  // the cooldown, and rendered as one line + the `yaw-mcp add <slug>` CLI
  // command that installs the server. The nudge points at the CLI rather
  // than a meta-tool: adding a server writes ~/.yaw-mcp/bundles.json, which
  // is the CLI's job, and the model can surface the command to the user.
  //
  // Privacy: the only data emitted is the aggregate integer count + the
  // first-party package / namespace / name. No raw history line, command
  // text, or argument ever reaches this output, and nothing here is sent to
  // analytics — scanShellHistoryForShadows is local-only and returns just
  // { cli, count, namespaces }.
  private buildInstallCandidatesLines(activeServers: UpstreamServerConfig[]): string[] {
    if (!this.installNudge) return [];

    // Namespaces the user already has installed (active, profile-narrowed).
    // A CLI whose shadow maps onto any of these is already covered — no nudge.
    const installedNamespaces = new Set(activeServers.map((s) => s.namespace));

    const hits = scanShellHistoryForShadows({ home: this.nudgeHome, env: this.nudgeEnv });

    const candidates: Array<{
      cli: string;
      count: number;
      target: { package: string; namespace: string; name: string };
    }> = [];
    for (const hit of hits) {
      if (hit.count < INSTALL_NUDGE_MIN_COUNT) continue;
      // Already covered by an installed server for any namespace this CLI
      // shadows — they have it; don't nudge.
      if (hit.namespaces.some((ns) => installedNamespaces.has(ns))) continue;
      const target = installTargetForCli(hit.cli);
      if (!target) continue;
      // Defense in depth: never nudge toward a target whose own namespace is
      // already installed, even if the shadow registry didn't list it.
      if (installedNamespaces.has(target.namespace)) continue;
      if (!shouldNudge(hit.cli, this.nudgeHome)) continue;
      candidates.push({ cli: hit.cli, count: hit.count, target });
    }

    if (candidates.length === 0) return [];

    const lines: string[] = ["\nInstall candidates (from your recent shell usage; history stays local):"];
    for (const { cli, count, target } of candidates) {
      lines.push(`  ${cli.padEnd(10)} (ran ${count}x recently) -> install ${target.package}`);
      lines.push(`     run: yaw-mcp add ${target.namespace}`);
    }
    // Suppress every surfaced CLI for the cooldown in ONE read-modify-write
    // (see install-nudge.ts recordNudges) -- the per-CLI call in the loop was
    // N writes of the same file for one discover.
    recordNudges(
      candidates.map((c) => c.cli),
      this.nudgeHome,
    );
    return lines;
  }

  // Activate a single server by namespace. Shared by handleActivate,
  // handleDispatch, and handleDiscoverWithAutoWarm so error handling,
  // retries, and caching live in one place.
  //
  // Dedup guarantee: two concurrent callers for the same namespace
  // share one in-flight activation. Without this, a tool call landing
  // on a disconnected upstream while another tool call was already
  // trying to reactivate the same namespace would spawn a duplicate
  // child process; the second set() would win and the first would leak
  // until its transport noticed. See activationInflight.
  //
  // `fromPrewarm` marks the inflight as prewarm-initiated so that
  // prewarmDormantServers can safely disconnect when it is the sole
  // caller, but skip the disconnect when an explicit activate has also
  // joined the inflight promise. An explicit call (fromPrewarm=false)
  // removes the namespace from prewarmNamespaces so prewarm's teardown
  // code sees it as "claimed" and leaves the connection alive.
  //
  // Returns:
  //   { ok: true, message } — already connected or newly connected
  //   { ok: false, message, isChanged: false } — failed or not in config
  private activateOne(
    namespace: string,
    progress?: ProgressReporter,
    fromPrewarm = false,
  ): Promise<{ ok: boolean; message: string; isChanged: boolean; serverId?: string; capped?: boolean }> {
    // Refuse once shutdown() has latched. Anything spawned from here would
    // land in this.connections after the teardown snapshot and outlive the
    // process's own bookkeeping — a live child nothing will ever close.
    // (runActivateOne carries its own gates: one per attempt, for the retry
    // sleep and the elicitation re-entries that bypass this wrapper, and one
    // after its await, for the spawn that was already in flight when the
    // latch went down.)
    if (this.shuttingDown) {
      return Promise.resolve(this.shuttingDownRefusal(namespace));
    }

    // An explicit (non-prewarm) activation claims the namespace: prewarm
    // must not tear down a connection the user asked for.
    if (!fromPrewarm) {
      const wasPrewarmClaim = this.prewarmNamespaces.delete(namespace);

      // Joining a PREWARM-initiated in-flight activation needs its own cap
      // check: the prewarm activation skipped it (prewarm never advertises
      // tools), but a claim converts that connection into a real, advertised
      // one. Without this, an explicit activate landing while prewarm was
      // mid-spawn slipped a live server past a full cap. On refusal, restore
      // the prewarm claim so prewarm's teardown proceeds normally, and
      // refuse exactly like a fresh activation would.
      if (wasPrewarmClaim && this.activationInflight.has(namespace)) {
        const capDecision = this.evaluateCapFor(namespace);
        if (!capDecision.allow) {
          this.prewarmNamespaces.add(namespace);
          return Promise.resolve({
            ok: false,
            isChanged: false,
            capped: true,
            message: capDecision.message,
          });
        }
      }
    }

    const inflight = this.activationInflight.get(namespace);
    if (inflight) {
      progress?.(`"${namespace}" load already in flight — awaiting existing attempt`);
      return inflight;
    }

    if (fromPrewarm) {
      this.prewarmNamespaces.add(namespace);
    }

    const promise = this.runActivateOne(namespace, progress, fromPrewarm).finally(() => {
      // Clear only if this promise is still the registered one. The
      // elicitation retry deliberately does NOT register a follow-up
      // (maybeElicitAndRetry re-enters runActivateOne directly, inside this
      // very promise, so going through the wrapper would deadlock on our own
      // entry) -- but an identity check is what makes any future path that
      // DOES register one safe, and it costs a Map lookup.
      if (this.activationInflight.get(namespace) === promise) {
        this.activationInflight.delete(namespace);
      }
    });
    this.activationInflight.set(namespace, promise);
    return promise;
  }

  // The one refusal every shutdown gate returns -- the pre-spawn check in
  // activateOne, the per-attempt check at the top of runActivateOne's loop,
  // and its post-handshake check -- so they cannot drift apart in wording.
  private shuttingDownRefusal(namespace: string): { ok: false; message: string; isChanged: false } {
    return { ok: false, isChanged: false, message: `"${namespace}" was not loaded — yaw-mcp is shutting down.` };
  }

  // Evaluate the concurrent-server cap for one candidate namespace against
  // the CURRENT slot occupancy. Shared by runActivateOne and the prewarm
  // claim path in activateOne so the two can never disagree on what counts.
  //
  // What occupies a slot: connected non-prewarm connections, plus pending
  // reservations (a DIFFERENT namespace mid-`await connectToUpstream`
  // occupies a slot even though its connection isn't in this.connections
  // yet -- without that, two concurrent activations of distinct namespaces
  // both pass the check against the same connected set and overshoot the
  // cap, a TOCTOU). Prewarm-claimed namespaces are exempt in both
  // directions -- see the fromPrewarm note at the runActivateOne call site.
  //
  // What gets a self-allowance: the candidate's OWN entry in
  // this.connections, at status "error" ONLY. A dead (error-state)
  // connection represents a slot that was already granted -- auto-reconnect
  // re-spawns through this same path, and refusing it at a full cap would
  // strand a legitimately-loaded server in its error state (with a refusal
  // message pointing at mcp_connect_activate, which would refuse
  // identically). evaluateServerCap treats a namespace present in `loaded`
  // as free. A "disconnected" entry gets NO allowance: that status only
  // exists mid-teardown (disconnectFromUpstream flips it synchronously,
  // then the prewarm teardown / idle reaper / deactivate await the close
  // before deleting the map entry), i.e. the slot is being RELEASED -- an
  // activate landing in that multi-second window must queue behind the cap
  // like any fresh activation, not ride a slot that is going away. The
  // auto-reconnect path never sees this: its stale entry reads "error" for
  // the entire activation (the failure path restores "error" after the
  // close, keeping later retries eligible).
  private evaluateCapFor(namespace: string): CapDecision {
    const loadedSlots: LoadedSlot[] = [];
    const counted = new Set<string>();
    for (const [ns, conn] of this.connections) {
      const ownDeadSlot = ns === namespace && conn.status === "error";
      if ((conn.status === "connected" || ownDeadSlot) && !this.prewarmNamespaces.has(ns)) {
        loadedSlots.push({ namespace: ns, idleCount: this.idleCallCounts.get(ns) ?? 0 });
        counted.add(ns);
      }
    }
    for (const ns of this.pendingActivations) {
      // Skip self (not reserved yet), anything already counted as a
      // live connection, and prewarm-claimed reservations.
      if (ns !== namespace && !counted.has(ns) && !this.prewarmNamespaces.has(ns)) {
        loadedSlots.push({ namespace: ns, idleCount: this.idleCallCounts.get(ns) ?? 0 });
        counted.add(ns);
      }
    }
    return evaluateServerCap(namespace, loadedSlots, this.serverCap);
  }

  // The policy gates every SPAWN path shares, in one place and one order:
  // disabled, then project profile, then the YAW_MCP_MIN_COMPLIANCE floor.
  // Returns the refusal text, or null when the server clears all three.
  //
  // Both callers -- runActivateOne (persistent activation) and handleReadTool
  // (transient inspect) -- actually execute the server's configured command
  // with its resolved env, so "we disconnect afterwards" buys read_tool no
  // exemption. They used to carry line-for-line copies of this block, which
  // meant a policy change had to land twice to stay consistent. `purpose`
  // supplies the only words that legitimately differ: what the caller was
  // about to do with the server once it started.
  private spawnGateRefusal(server: UpstreamServerConfig, purpose: "activate" | "inspect its tools"): string | null {
    if (!server.isActive) {
      return `"${server.namespace}" is installed but disabled. Set "isActive": true for it in ~/.yaw-mcp/bundles.json and restart this MCP client to ${purpose}.`;
    }
    if (!profileAllows(this.profile, server.namespace)) {
      return `"${server.namespace}" is not allowed by the project profile at ${this.profile?.path}.`;
    }
    const minCompliance = resolveMinCompliance();
    if (minCompliance !== null && !passesMinCompliance(server.complianceGrade, minCompliance)) {
      return `Refused to load "${server.namespace}": ${complianceRefusalReason(server.complianceGrade, minCompliance)}. Unset YAW_MCP_MIN_COMPLIANCE (or lower it) to override.`;
    }
    return null;
  }

  // `skipCap` is for the post-elicitation retry only: that caller is already
  // inside this namespace's own activation, holding its pendingActivations
  // reservation, and the user has just typed a credential. evaluateCapFor
  // deliberately does NOT grant a self-allowance for a pending reservation
  // (see its "skip self" comment), so a re-check there could refuse the
  // retry because OTHER namespaces filled the cap while the modal was open --
  // credentials typed, slot gone, nothing to show for it.
  //
  // `isElicitRetry` marks the ONE re-entry maybeElicitAndRetry makes after the
  // user typed credentials. It exists to stop that re-entry eliciting again:
  // the prompt budget is per namespace, not per activate, so a child that
  // keeps reporting the same key missing would otherwise open a second,
  // byte-identical modal inside the same activate call -- spending the whole
  // budget (and three spawn attempts plus their retry sleeps) before the user
  // has any chance to go fix the value somewhere else.
  private async runActivateOne(
    namespace: string,
    progress?: ProgressReporter,
    fromPrewarm = false,
    skipCap = false,
    isElicitRetry = false,
  ): Promise<{ ok: boolean; message: string; isChanged: boolean; serverId?: string; capped?: boolean }> {
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

    const anyMatch = this.config?.servers.find((s) => s.namespace === namespace);
    if (!anyMatch) {
      // Split "not found" from "disabled" so the caller knows whether to
      // (a) fix a typo / install the server or (b) set "isActive": true
      // for it in ~/.yaw-mcp/bundles.json. Fuzzy suggestions only when the
      // input is a clear near-miss — noise-free by construction
      // (closestNames returns [] otherwise).
      const allNamespaces = this.config?.servers.map((s) => s.namespace) ?? [];
      const suggestions = closestNames(namespace, allNamespaces, 3);
      const hint =
        suggestions.length > 0
          ? ` Did you mean: ${suggestions.join(", ")}?`
          : " Use mcp_connect_discover to see installed servers.";
      return { ok: false, isChanged: false, message: `"${namespace}" is not installed.${hint}` };
    }
    const serverConfig = anyMatch;

    // Disabled / profile / compliance, in that precedence, from the one
    // copy shared with handleReadTool. EVERY activation path — activate,
    // dispatch, discover auto-warm, deferred lazy-activation,
    // autoLoadRecurringPack — funnels through here, so the floor is honored
    // before connectToUpstream with one refusal string per case (and
    // not-installed, above, first). Ungraded servers pass the compliance
    // floor (see passesMinCompliance).
    const gateRefusal = this.spawnGateRefusal(serverConfig, "activate");
    if (gateRefusal) {
      return { ok: false, isChanged: false, message: gateRefusal };
    }

    // Concurrent-load cap. Connected servers count; error-state
    // connections don't, because they aren't contributing tools to
    // the LLM's context. We compute the slot list fresh here — it's
    // cheap (Map iteration) and guaranteed to reflect state after
    // any auto-unloads that fired between the check and this call.
    // Pending reservations (pendingActivations) count too: a DIFFERENT
    // namespace mid-`await connectToUpstream` occupies a slot even though
    // its connection isn't in this.connections yet. Without this, two
    // concurrent activations of distinct namespaces both pass the check
    // against the same connected set and overshoot the cap (TOCTOU).
    // The cap exists to bound the LLM's context (server-cap.ts), and
    // prewarm contributes nothing to it: prewarm connections are never
    // advertised (gateway exposure keys on sessionActivated) and are torn
    // down within milliseconds of learning the tool list. So prewarm is
    // exempt in BOTH directions -- a prewarm activation skips the check
    // (fromPrewarm), and prewarm-claimed namespaces do not occupy slots
    // that would refuse a concurrent real activation (the startup race
    // with autoLoadRecurringPack: both fire from oninitialized, and a
    // batch of 3 prewarm reservations used to eat half a default cap of
    // 6). A prewarm namespace CLAIMED by an explicit activate leaves
    // prewarmNamespaces (activateOne with fromPrewarm=false deletes it)
    // and starts counting like any other connection. `skipCap` is the other
    // exemption -- the post-elicitation retry, which is re-entering an
    // activation that already cleared this gate (see the flag's comment
    // above runActivateOne).
    if (!fromPrewarm && !skipCap) {
      const capDecision = this.evaluateCapFor(namespace);
      if (!capDecision.allow) {
        return {
          ok: false,
          isChanged: false,
          capped: true,
          message: capDecision.message,
        };
      }
    }

    // Reserve our slot synchronously — before the first `await` below — so
    // a concurrent activation of a different namespace sees us in the count
    // above. Released in the finally regardless of outcome; on success the
    // namespace lives in this.connections (counted there), so there is no
    // gap. maybeElicitAndRetry re-enters runActivateOne for the SAME
    // namespace, which the Set makes idempotent -- but NOT cap-safe on its
    // own: evaluateCapFor skips a self-reservation rather than treating it
    // as an occupied slot, so the retry would be re-checked against a cap
    // other namespaces may have filled during the elicitation. That is why
    // the retry passes skipCap rather than relying on the reservation.
    this.pendingActivations.add(namespace);
    try {
      // Merge any session-elicited env over the server's configured env.
      // Elicited values only apply inside this yaw-mcp process lifetime.
      const elicited = this.elicitedEnv.get(namespace);
      const effectiveConfig = elicited ? { ...serverConfig, env: { ...serverConfig.env, ...elicited } } : serverConfig;

      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        // Re-check the latch before EVERY spawn, not only in activateOne.
        // The wrapper's gate is the last one on the way in for attempt 0 of
        // a fresh activation, and it is stale by the time we get here in
        // every other case: attempt 1 sits behind the retry sleep below, and
        // the elicitation re-entries (maybeElicitAndRetry,
        // elicitVaultPassphraseAndRetry) call runActivateOne directly, behind
        // a modal round-trip of up to 60s. A SIGTERM landing in either window
        // used to spawn a fresh child AFTER shutdown() had latched. The
        // post-handshake gate below would close that child -- but only once
        // its handshake resolves, and a cold npx handshake outlives the
        // bounded drain and then the process itself, which orphans it.
        // Refuse instead of spawning.
        if (this.shuttingDown) return this.shuttingDownRefusal(namespace);
        try {
          progress?.(
            attempt === 0 ? `Spawning "${namespace}" upstream…` : `Retrying "${namespace}" (attempt ${attempt + 1})…`,
          );
          const connection = await connectToUpstream(
            effectiveConfig,
            this.onUpstreamDisconnect,
            this.onUpstreamListChanged,
            this.clientBridge,
          );
          // shutdown() latched while this handshake was in flight. Its drain
          // is bounded (SHUTDOWN_DRAIN_MS), so by now the teardown may already
          // have snapshotted and cleared this.connections -- registering here
          // would put a live child into a map nothing reads again, and
          // yaw-mcp would exit without ever closing its transport (a child
          // that does not exit on stdin EOF is then orphaned). Close it
          // ourselves and report the refusal the pre-spawn gate would have.
          if (this.shuttingDown) {
            await disconnectFromUpstream(connection).catch(() => {});
            return this.shuttingDownRefusal(namespace);
          }
          progress?.(`"${namespace}" loaded ${connection.tools.length} tools`);
          this.connections.set(namespace, connection);
          this.idleCallCounts.set(namespace, 0);
          const toolMeta = connection.tools.map((t) => ({ name: t.name, description: t.description }));
          this.toolCache.set(namespace, toolMeta);
          this.toolCacheLearnedAt.set(namespace, Date.now());
          // Persist the learned list so the NEXT session skips the pre-warm
          // spawn for this namespace. Debounced + best-effort; a failed save
          // just means we re-learn next time.
          this.scheduleStateSave();

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
          // A locked or wrong-passphrase vault is decided BEFORE any child is
          // spawned, from state that cannot change in a second. Retrying it
          // buys nothing and costs the fixed 1s sleep plus a warn-level
          // "retrying" line that reads like a transient spawn failure -- on a
          // startup prewarming several vault-backed servers that is seconds of
          // dead time on the connect path. Go straight to the elicitation
          // branch below, which is the only thing that CAN change the outcome.
          if (err instanceof VaultPassphraseRequiredError) break;
          if (attempt === 0) {
            const msg = err instanceof Error ? err.message : String(err);
            log("warn", "Activation attempt failed, retrying", { namespace, error: msg });
            // One fixed step before the single retry -- NOT exponential
            // backoff. Read from the instance field so a test that has to
            // reach attempt 2 can set it to 0 instead of burning a real
            // second of wall time per case.
            await new Promise((r) => setTimeout(r, this.activationRetryDelayMs));
          }
        }
      }

      // Before giving up, see if the failure looks like a missing credential
      // and the client supports elicitation. If both hold, ask the user for
      // the missing values and retry exactly once — one round-trip max.
      //
      // Guarded by the haven't-just-tried-this-credential check: if elicited
      // values are already present for every detected name, don't ask twice.
      const elicitedRetry = await this.maybeElicitAndRetry(namespace, lastError, progress, fromPrewarm, isElicitRetry);
      if (elicitedRetry) return elicitedRetry;

      log("error", "Failed to activate upstream", {
        namespace,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });

      // Record the failure so dispatch down-ranks this namespace for a
      // few minutes. The TTL is short enough that a fixed server (user
      // edited bundles.json env, for example) recovers on the next client restart.
      this.activationFailures.set(namespace, {
        at: Date.now(),
        message: lastError instanceof Error ? lastError.message : String(lastError),
      });
      // discover renders this failure as a `warn: last activation failed ...`
      // line, but the failure touches nothing in the discover cache key, so
      // a re-discover inside the 3s TTL would hand back the pre-failure text.
      this.invalidateDiscoverCache();

      // Prefer the ActivationError's message (includes stderr tail + category
      // hint) over the raw SDK error. Falls back cleanly for transport errors.
      const message =
        lastError instanceof ActivationError
          ? `Failed to load "${namespace}": ${lastError.message}`
          : `Failed to load "${namespace}": ${lastError instanceof Error ? lastError.message : String(lastError)}`;
      return { ok: false, isChanged: false, message };
    } finally {
      this.pendingActivations.delete(namespace);
    }
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
    fromPrewarm = false,
    isElicitRetry = false,
  ): Promise<{ ok: boolean; message: string; isChanged: boolean; serverId?: string } | null> {
    // yaw-mcp's OWN vault passphrase is a separate path, matched by ERROR
    // TYPE rather than by pattern-matching text. resolveServerEnv throws
    // before any child is spawned, so there is no child stderr in play and no
    // way for an upstream to induce this prompt by printing the right words.
    if (lastError instanceof VaultPassphraseRequiredError) {
      return this.elicitVaultPassphraseAndRetry(namespace, lastError, progress, fromPrewarm);
    }

    const stderr = lastError instanceof ActivationError ? lastError.stderrTail : undefined;
    const errMessage = lastError instanceof Error ? lastError.message : String(lastError);
    const haystack = [stderr, errMessage].filter(Boolean).join("\n");
    // Never elicit yaw-mcp's own secrets on this path. The haystack includes
    // a CHILD's stderr, and detectMissingCredentials happily matches
    // "YAW_MCP_VAULT_PASSPHRASE is not set" in it -- so without this filter a
    // server could print that line and be handed the vault passphrase, via a
    // prompt that names the server rather than yaw-mcp. Worse, the accepted
    // value lands in elicitedEnv and is merged into that same child's env on
    // retry, walking straight past stripInternalSecretsFromEnv. The genuine
    // case is the typed branch above.
    const missing = detectMissingCredentials(haystack).filter((k) => !INTERNAL_SECRET_ENV_KEYS.has(k.toUpperCase()));
    if (missing.length === 0) return null;

    // Only a key the prompt actually SUPPLIED can have been "not accepted".
    // A child that validates sequentially (rejects on AWS_ACCESS_KEY_ID,
    // then on AWS_SECRET_ACCESS_KEY once the first one is accepted) names a
    // key nobody has typed yet -- that is new information, not a
    // byte-identical second modal, so it belongs on the normal
    // MAX_CREDENTIAL_PROMPTS-bounded ask below rather than in the branch
    // that tells the user their values were rejected.
    const supplied = this.elicitedEnv.get(namespace) ?? {};

    // We are already inside the retry a prompt bought, and the child still
    // reports missing exactly the keys we just supplied. Asking again HERE
    // opens a second modal in the same breath as the first, worded
    // identically, with nothing new for the user to type -- and it spends the
    // rest of the per-namespace budget (plus another pair of spawn attempts
    // and their retry sleeps) before they can go look the real value up. Say
    // what happened instead and leave the budget alone, so the next explicit
    // activate can re-ask. The vault path's "rejected" branch reports its own
    // not-accepted value the same way.
    if (isElicitRetry && missing.every((k) => k in supplied)) {
      log("info", "Credentials still missing after the elicited retry — not re-asking inside the same activation", {
        namespace,
        missing,
      });
      // Returning non-null short-circuits runActivateOne at the
      // `if (elicitedRetry) return elicitedRetry;` line, which sits ABOVE the
      // give-up path that normally books the failure. Book it here or nothing
      // does: formatHealthWarning (discover's `warn: last activation failed`
      // line) and healthFactor (dispatch routing) both read activationFailures,
      // so without this routing keeps picking a server that cannot start.
      this.activationFailures.set(namespace, {
        at: Date.now(),
        message: lastError instanceof Error ? lastError.message : String(lastError),
      });
      // The failure touches nothing in the discover cache key, so a
      // re-discover inside the 3s TTL would hand back the pre-failure text.
      this.invalidateDiscoverCache();
      const promptsSoFar = this.credentialPrompts.get(namespace) ?? 0;
      const retryHint =
        promptsSoFar >= MAX_CREDENTIAL_PROMPTS
          ? ` No further prompts for "${namespace}" this session: set ${missing.join(", ")} in its "env" in ~/.yaw-mcp/bundles.json and restart this MCP client.`
          : ` Activate "${namespace}" again to try new ones.`;
      return {
        ok: false,
        isChanged: false,
        message: `Could not load "${namespace}": it still reports ${missing.join(", ")} missing, so the values just provided were not accepted.${retryHint}`,
      };
    }

    // A value we already supplied did not work. That used to end it for the
    // session: the stored-but-wrong entry made every later activation of
    // this namespace skip the prompt, so one mistyped token cost the server
    // until the client restarted -- the same "one slip costs the session"
    // failure the vault path was redesigned away from. Re-ask instead,
    // bounded by MAX_CREDENTIAL_PROMPTS per namespace so a server failing
    // for an unrelated reason cannot turn every activation into a modal.
    const asked = this.credentialPrompts.get(namespace) ?? 0;
    if (asked >= MAX_CREDENTIAL_PROMPTS) {
      log("info", "Missing credentials persist after the prompt budget; not asking again", {
        namespace,
        missing,
        prompts: asked,
      });
      return null;
    }

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
        description: `The value for ${key} required by "${namespace}". Stored only for this yaw-mcp session.`,
      };
    }

    progress?.(`Asking for ${missing.length === 1 ? "credential" : "credentials"}: ${missing.join(", ")}`);
    // Count the ask BEFORE the round-trip, for the reason the vault path
    // does: an elicitInput that throws must still spend an attempt, or a
    // client failing that request in a loop re-prompts on every activation.
    this.credentialPrompts.set(namespace, asked + 1);

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

    this.elicitedEnv.set(namespace, { ...supplied, ...values });
    progress?.("Got credentials — retrying load");
    // Recurse — runActivateOne merges elicitedEnv on this attempt.
    // Call runActivateOne directly (not activateOne) because we're
    // already inside the in-flight activation promise registered by
    // activateOne; going through the wrapper again would deadlock on
    // our own entry in activationInflight.
    // Thread fromPrewarm through the retry: dropping it re-entered
    // runActivateOne as a REAL activation, so a prewarm spawn that elicited
    // credentials could be refused by the cap prewarm is exempt from --
    // resurrecting the silent-invisibility UX the exemption exists to stop.
    // skipCap for the same class of reason: this namespace already cleared
    // the cap on the way in and still holds its reservation, so re-checking
    // it here could refuse a user who has just typed credentials because
    // OTHER namespaces filled the cap while the modal was open.
    // isElicitRetry: this re-entry is the one round-trip the prompt bought.
    // If the child STILL reports the same key missing, the branch above turns
    // that into a message rather than a second identical modal.
    return this.runActivateOne(namespace, progress, fromPrewarm, /* skipCap */ true, /* isElicitRetry */ true);
  }

  // The vault-passphrase counterpart to maybeElicitAndRetry. Split out
  // rather than folded in because almost nothing about the generic path
  // transfers: there is exactly one value, its name is fixed, it must NOT be
  // remembered in elicitedEnv (that map is merged into the CHILD's env), and
  // the retry hinges on a process-wide session value instead of a per-server
  // override.
  //
  // Bounded by attempts rather than latched after one ask, because the value
  // is typed by a human into a no-echo field: a single transposed character
  // otherwise cost the entire session. Each entry is VERIFIED against the
  // vault before it is stored (see verifyVaultPassphrase), so a wrong one is
  // rejected without ever becoming the session passphrase, and the user gets
  // MAX_VAULT_PASSPHRASE_PROMPTS tries in total across every server. A
  // decline still ends it immediately -- that is an answer, not a typo.
  //
  // Concurrency: the prompt itself is deduped through vaultElicitInflight.
  // Prewarm runs three activations at once, so several namespaces can reach a
  // locked vault in the same instant -- and they are all asking the ONE
  // question this vault has. Followers await the winner's prompt instead of
  // opening a second modal for it.
  private async elicitVaultPassphraseAndRetry(
    namespace: string,
    lastError: VaultPassphraseRequiredError,
    progress?: ProgressReporter,
    fromPrewarm = false,
  ): Promise<{ ok: boolean; message: string; isChanged: boolean; serverId?: string } | null> {
    // Someone else is already asking. Join their prompt: on success retry
    // straight away (the vault is now unlocked for every namespace, which is
    // the whole point); on a rejected entry report it exactly as the winner
    // does; on anything else give up quietly rather than opening a second
    // modal. Deliberately conservative -- the winner already spent an
    // attempt from the shared budget, and a later explicit activate can
    // still re-ask while that budget lasts.
    //
    // Checked BEFORE the stop-asking latch, which governs STARTING a prompt:
    // the winner sets that latch as it asks (and always on a verified
    // answer), so testing it first would make a follower abandon the very
    // prompt that is about to unlock the vault for it.
    const joined = this.vaultElicitInflight;
    if (joined) {
      progress?.("Waiting for the vault passphrase prompt already in flight");
      const outcome = await joined;
      if (outcome === "unlocked") return this.runActivateOne(namespace, progress, fromPrewarm, /* skipCap */ true);
      // The follower saw the SAME rejected entry the winner did, so it gets
      // the same words and the same no-penalty exit. Returning null here
      // instead sent it down runActivateOne's give-up path, which logged the
      // stale "vault locked" error, booked an activationFailures entry that
      // down-ranked the server in dispatch for the TTL, and told the user
      // YAW_MCP_VAULT_PASSPHRASE was not set when they had just typed one --
      // for every namespace in the batch but the winner.
      if (outcome === "rejected") return this.vaultPassphraseRejected(namespace, lastError);
      return null;
    }

    if (this.vaultPassphraseElicited) return null;

    const caps = this.server.getClientCapabilities();
    if (!caps?.elicitation) {
      log("info", "Vault is locked but client does not support elicitation", {
        namespace,
        refKeys: lastError.refKeys,
        reason: lastError.reason,
      });
      return null;
    }

    const prompt = this.promptForVaultPassphrase(namespace, lastError, progress);
    this.vaultElicitInflight = prompt;
    let outcome: VaultPromptOutcome;
    try {
      outcome = await prompt;
    } finally {
      // Only clear OUR entry: a later prompt (the re-ask after a typo)
      // registers its own, and this one must not delete it.
      if (this.vaultElicitInflight === prompt) this.vaultElicitInflight = null;
    }

    if (outcome === "unlocked") {
      progress?.("Got the passphrase -- retrying load");
      // skipCap: this namespace already cleared the cap and still holds its
      // reservation; re-checking after a modal the user just answered could
      // refuse them for slots other namespaces took meanwhile.
      return this.runActivateOne(namespace, progress, fromPrewarm, /* skipCap */ true);
    }

    if (outcome === "rejected") return this.vaultPassphraseRejected(namespace, lastError);

    return null;
  }

  // The result for a vault passphrase the user typed that did not verify.
  // Shared by the prompt's winner and every follower that joined it (they all
  // saw the one rejected entry), so the two paths cannot drift. Say what
  // actually happened: falling through to runActivateOne's generic failure
  // path reported the ORIGINAL "vault is locked" error, which is no longer
  // the problem -- the user typed something and it was wrong -- and booked an
  // activationFailures penalty against a server that never got to run.
  // Returning this skips both.
  private vaultPassphraseRejected(
    namespace: string,
    lastError: VaultPassphraseRequiredError,
  ): { ok: false; message: string; isChanged: false } {
    const retryHint = this.vaultPassphraseElicited
      ? " No further prompts this session: set YAW_MCP_VAULT_PASSPHRASE in yaw-mcp's own env and restart this MCP client."
      : ` Activate "${namespace}" again to try another passphrase.`;
    return {
      ok: false,
      isChanged: false,
      message: `Could not load "${namespace}": the passphrase entered does not unlock your local secret vault, which its env (${lastError.refKeys.join(", ")}) references.${retryHint}`,
    };
  }

  // The prompt half of the vault path, split out so concurrent callers can
  // await ONE of them (see vaultElicitInflight). Owns the ask budget, the
  // latch, verification, and storing the verified value; tells the caller
  // which of the three things happened, because they need different words:
  //   "unlocked"    -- verified and stored; retry the activation.
  //   "rejected"    -- the user typed a passphrase and it did not verify.
  //   "unavailable" -- declined, empty, or the elicitation request failed.
  private async promptForVaultPassphrase(
    namespace: string,
    lastError: VaultPassphraseRequiredError,
    progress?: ProgressReporter,
  ): Promise<VaultPromptOutcome> {
    // Count the ask BEFORE the round-trip: an elicitInput that throws must
    // still consume an attempt, or a client failing that request in a loop
    // would re-prompt on every server with vault refs, forever.
    this.vaultPassphrasePrompts++;
    if (this.vaultPassphrasePrompts >= MAX_VAULT_PASSPHRASE_PROMPTS) this.vaultPassphraseElicited = true;
    progress?.("Vault is locked -- asking for the passphrase");

    // The two reasons need different words. "invalid" means a passphrase IS
    // configured and does not work; telling that user the vault is merely
    // "locked" reads as though they forgot to set something they did set.
    const why =
      lastError.reason === "invalid"
        ? `the vault passphrase yaw-mcp has does not unlock your local secret vault (${lastError.refKeys.join(", ")} reference it). Enter the correct passphrase to use for this session, or decline to cancel. The value in YAW_MCP_VAULT_PASSPHRASE is wrong or belongs to a different vault -- fix it there to stop this recurring.`
        : `its env (${lastError.refKeys.join(", ")}) references your local secret vault, which is locked. Enter your vault passphrase to unlock it for this session, or decline to cancel. Set YAW_MCP_VAULT_PASSPHRASE in yaw-mcp's own env to skip this prompt in future sessions.`;

    let result: Awaited<ReturnType<Server["elicitInput"]>>;
    try {
      result = await this.server.elicitInput({
        message: `"${namespace}" cannot start: ${why}`,
        requestedSchema: {
          type: "object",
          properties: {
            YAW_MCP_VAULT_PASSPHRASE: {
              type: "string",
              title: "Vault passphrase",
              description:
                "Unlocks ~/.yaw-mcp/secrets.json. Kept in memory for this session only -- never written to disk, and never passed to the server being started.",
            },
          },
          required: ["YAW_MCP_VAULT_PASSPHRASE"],
        },
      });
    } catch (err) {
      log("warn", "Vault passphrase elicitation failed", {
        namespace,
        error: err instanceof Error ? err.message : String(err),
      });
      return "unavailable";
    }

    if (result.action !== "accept" || !result.content) {
      // An explicit decline is a decision, not a slip -- stop asking.
      this.vaultPassphraseElicited = true;
      log("info", "User declined vault passphrase elicitation", { namespace, action: result.action });
      return "unavailable";
    }

    const value = result.content.YAW_MCP_VAULT_PASSPHRASE;
    if (typeof value !== "string" || value.length === 0) return "unavailable";

    // VERIFY before storing. setSessionVaultPassphrase writes module-global
    // state that shadows the env var for every later resolve, so an unverified
    // value does not merely fail once -- it replaces a possibly-correct
    // YAW_MCP_VAULT_PASSPHRASE with a typo for the rest of the process.
    if (!(await verifyVaultPassphrase(value))) {
      log("info", "Elicited vault passphrase did not unlock the vault", {
        namespace,
        attempt: this.vaultPassphrasePrompts,
      });
      progress?.("That passphrase did not unlock the vault");
      return "rejected";
    }

    // Into the module-level session slot, deliberately NOT into elicitedEnv:
    // runActivateOne merges that map over the server's configured env, so
    // storing it there would hand the vault passphrase to the very child we
    // are unlocking the vault FOR.
    setSessionVaultPassphrase(value);
    // Verified, so no further asking is warranted whatever happens next.
    this.vaultPassphraseElicited = true;
    return "unlocked";
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
    //
    // A filter SET this way is rolled back below when the activation it was
    // meant for fails: leaving it behind means a later successful load of
    // the same namespace (via dispatch, or a deferred first call — neither
    // touches toolFilters) silently advertises only the tools the FAILED
    // call asked for. The clear-filter branch needs no rollback: it widens
    // the surface back to the documented default.
    let filtersChanged = false;
    // Set when this call INSTALLED a filter, so a failed activation can put
    // the previous state back. `prev: undefined` means "there was none".
    let installedFilter: { namespace: string; prev: Set<string> | undefined } | null = null;
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
          installedFilter = { namespace: ns, prev };
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
    let anyCapped = false;
    // Did sessionActivated actually GROW? A winner can succeed without a
    // connection change (isChanged:false -- e.g. a namespace a deferred
    // first tools/call connected, now being asked for by name). Under
    // gateway exposure that still moves the tools/list surface, so the
    // anyChanged-gated notify below is not enough on its own.
    let advertisedGrew = false;

    // NB: no compliance pre-check here. The YAW_MCP_MIN_COMPLIANCE floor is
    // enforced once, inside runActivateOne, so every activation path shares
    // one gate and one refusal string. The duplicate that used to live here
    // produced identical text for the common case but silently REORDERED
    // precedence for a server failing two gates: a below-grade server that
    // is also disabled or profile-blocked reported the compliance reason to
    // `activate` and the disabled/blocked reason to `dispatch`. Refusals are
    // still errors (not cap-style budgeting) because a failed activateOne
    // returns ok:false with capped unset, which sets anyError below.
    const total = namespaces.length;
    let i = 0;
    for (const namespace of namespaces) {
      i += 1;
      progress?.(`Loading ${namespace} (${i}/${total})`, i - 1, total);
      const r = await this.activateOne(namespace, progress);
      results.push(r.message);
      if (r.isChanged) anyChanged = true;
      // Gateway mode advertises a namespace only after the USER asks for
      // it -- BY NAME here, by INTENT in handleDispatch and discover's
      // auto-warm, by REPLAY of their own recurring pack in
      // autoLoadRecurringPack -- not in activateOne, which the deferred
      // first-call path and prewarm also route through. Those reach a tool
      // without the client having chosen the server, so surfacing the whole
      // namespace off them would grow the tool list as a side effect of
      // one call. Recorded on success only.
      if (r.ok) {
        if (!this.sessionActivated.has(namespace)) advertisedGrew = true;
        this.sessionActivated.add(namespace);
      }
      // Cap refusals are tracked separately: alongside successes they are
      // informational (the per-namespace message says what to unload), but
      // when NOTHING loads the call did no work and must signal an error.
      if (!r.ok) {
        if (r.capped) anyCapped = true;
        else anyError = true;
        // Roll back a filter we installed for a namespace that never came
        // up. Otherwise the entry outlives this call and narrows the tool
        // surface of a LATER, successful activation nobody filtered — and
        // for a namespace that isn't installed at all it is permanent.
        if (installedFilter && installedFilter.namespace === namespace) {
          if (installedFilter.prev) this.toolFilters.set(namespace, installedFilter.prev);
          else this.toolFilters.delete(namespace);
          installedFilter = null;
          // The surface never actually moved, so don't announce that it did.
          filtersChanged = false;
        }
      }
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
      await this.refreshRoutesAndNotify();
    } else if (filtersChanged || advertisedGrew) {
      // Filter changed, or the advertised set grew, on an already-connected
      // server -- routes are unchanged (whoever connected it rebuilt them,
      // and dispatch still reaches hidden tools) but the tools/list surface
      // moved, so notify the client to re-list. Without the advertisedGrew
      // arm, a gateway-exposure client that activates an auto-loaded-but-
      // never-advertised namespace is told the tools are "now callable"
      // while its tools/list never learns they exist.
      await this.notifyAllListsChanged();
    }

    return {
      content: [{ type: "text", text: results.join("\n") }],
      isError: anyError || (anyCapped && !anyChanged) ? true : undefined,
    };
  }

  // Background refinement of a just-recorded heuristic reward via the optional
  // LLM grader. Fire-and-forget: the tool result has already returned. If the
  // grader returns a verdict different from the heuristic, revise the credit by
  // the delta (recordOutcome already counted the dispatch). Never throws.
  private async refineRewardInBackground(namespace: string, heuristic: number, ctx: GraderContext): Promise<void> {
    try {
      const graded = await gradeOutcomeViaSampling(this.server, ctx);
      if (graded === null || graded === heuristic) return;
      this.learning.adjustSucceeded(namespace, graded - heuristic);
      this.scheduleStateSave();
      this.invalidateDiscoverCache();
    } catch {
      // Refinement is best-effort; it must never surface to the caller.
    }
  }

  // Is A -> B a designed multi-server flow rather than a routing miss? True
  // when both namespaces co-occur in a curated bundle or a detected usage
  // pack — those A-then-B sequences are intentional, so re-dispatch from A
  // to B must NOT penalize A. Used as detectMiss's exclusion predicate.
  private isLegitChain(a: string, b: string): boolean {
    for (const bundle of CURATED_BUNDLES) {
      if (bundle.namespaces.includes(a) && bundle.namespaces.includes(b)) return true;
    }
    for (const pack of this.packDetector.detectChains()) {
      if (pack.namespaces.includes(a) && pack.namespaces.includes(b)) return true;
    }
    return false;
  }

  // Smart-routing meta-tool. The LLM describes the task in plain English
  // ("create a github issue for this bug"); yaw-mcp ranks configured servers
  // with BM25 and activates the top N, then lets the LLM call the now-
  // exposed tools normally. Default budget is 1 because over-activating
  // pollutes the tool list in the LLM's context with noise.
  //
  // The three empty-state messages below are the fresh-install path (dispatch
  // is the documented first call), so each names the LOCAL fix -- `yaw-mcp
  // add <slug>`, `"isActive": true` in ~/.yaw-mcp/bundles.json -- rather than
  // the retired hosted add/enable UI at yaw.sh/mcp that discover and bundles
  // were already migrated away from.
  private async handleDispatch(
    intent: string,
    budget: number,
    progress?: ProgressReporter,
    routeEffortOverride?: string,
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
        content: [{ type: "text", text: NO_SERVERS_INSTALLED_TEXT }],
        isError: true,
      };
    }

    const activeServers = this.getProfiledActiveServers();
    if (activeServers.length === 0) {
      // Every installed server is either "isActive": false or kept out by
      // the project profile -- there is no third way past the filter above,
      // so at least one of the two lists below is non-empty. Both fixes are
      // local edits, but they are DIFFERENT edits in different files, so
      // name only the ones that apply. A profile-blocked server is already
      // active: telling the model to set "isActive": true for it, or to look
      // for it in discover's disabled list (discover renders profile-blocked
      // entries nowhere), sent it to the wrong file. Name the namespaces and
      // the exact list in the profile that keeps each one out instead.
      const profile = this.profile;
      const disabled = this.config.servers.filter((s) => !s.isActive);
      const blocked = profile
        ? this.config.servers.filter((s) => s.isActive && !profileAllows(profile, s.namespace))
        : [];
      const parts = ["No servers enabled."];
      if (profile && blocked.length > 0) {
        const quote = (servers: UpstreamServerConfig[]) => servers.map((s) => `"${s.namespace}"`).join(", ");
        // isAllowed: an explicit "blocked" entry wins over the allow list, so
        // a namespace on it needs removing from there; every other blocked
        // namespace is missing from a non-empty "servers" allow list.
        const denied = blocked.filter((s) => profile.blocked?.includes(s.namespace));
        const unlisted = blocked.filter((s) => !profile.blocked?.includes(s.namespace));
        const edits: string[] = [];
        if (unlisted.length > 0) edits.push(`add ${quote(unlisted)} to its "servers" allow list`);
        if (denied.length > 0) edits.push(`remove ${quote(denied)} from its "blocked" list`);
        parts.push(`The project profile at ${profile.path} keeps ${quote(blocked)} out: ${edits.join(" and ")}.`);
      }
      if (disabled.length > 0) {
        parts.push(
          `Set "isActive": true for a server in ~/.yaw-mcp/bundles.json; mcp_connect_discover lists what is installed but disabled.`,
        );
      }
      parts.push("Restart this MCP client after editing.");
      return {
        content: [{ type: "text", text: parts.join(" ") }],
        isError: true,
      };
    }

    progress?.(`Ranking ${activeServers.length} servers…`);
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
            text: `No installed server matches "${trimmed}". Use mcp_connect_discover to see what's installed, or browse https://yaw.sh/mcp/catalog/ and add one with \`yaw-mcp add <slug>\`.`,
          },
        ],
        isError: true,
      };
    }

    // Sampling tiebreak: when BM25+health rank the top-2
    // candidates within a close margin, ask the client LLM to choose.
    // Uses the same model the user is already running — no extra
    // provider key, no extra cost from yaw-mcp's side. Silently skips if
    // the client doesn't advertise the sampling capability.
    // safeBudget === 1 is intentional: the tiebreak only matters when a
    // single primary is returned. A multi-load (safeBudget>1) tolerates a
    // wrong primary because the close runner-up is also in the returned
    // slice — paying the sampling round-trip there buys nothing. Do not
    // "fix" this to fire for safeBudget>1. The gate keys on the CLAMPED
    // budget, not the raw one: 0, 0.5, 1.5 and -1 all resolve to exactly
    // one winner below, and skipping the tiebreak for them was a hole the
    // schema (type integer) narrows but cannot close.
    // The effort dial generalizes the old fixed 10%-tiebreak into an
    // ambiguity-aware gate (off|auto|aggressive). auto preserves today's
    // behavior (one sample on genuine ambiguity); aggressive samples
    // best-of-3 on milder ambiguity.
    const safeBudget = Math.max(1, Math.min(10, Math.floor(budget)));
    const effort = parseRouteEffort(routeEffortOverride ?? process.env.YAW_MCP_ROUTE_EFFORT);
    if (safeBudget === 1 && shouldSample(ranked, effort)) {
      progress?.("Top candidates close — asking LLM to pick…");
      const serversByNamespace = new Map(activeServers.map((s) => [s.namespace, s]));
      const candidates = buildCandidates(ranked.slice(0, 3), serversByNamespace, this.toolCache);
      const samples = sampleCountForEffort(effort);
      const picked = await bestOfNViaSampling(this.server, trimmed, candidates, samples);
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

    const winners = ranked.slice(0, safeBudget);

    // Re-dispatch routing-miss + opt-in foundry harvest. The primary winner
    // is the server this dispatch actually routed to. If a token-similar
    // intent was recently routed to a DIFFERENT, then-abandoned server, that
    // earlier choice was the wrong route — penalize it (recordMiss). Then
    // record this dispatch so a future re-route can be judged against it.
    const primary = winners[0]?.namespace;
    if (primary) {
      // Remember the intent each activated server was routed for, so the
      // optional LLM reward grader can judge later tool calls against the goal.
      for (const w of winners) this.lastIntentByNamespace.set(w.namespace, trimmed);
      const intentTokens = tokenize(trimmed);
      const now = Date.now();
      const miss = this.redispatch.detectMiss(primary, intentTokens, now, (a, b) => this.isLegitChain(a, b));
      if (miss) {
        this.learning.recordMiss(miss.loser);
        this.scheduleStateSave();
        // recordMiss moves the loser's `usage:` / `reliability:` numbers,
        // which discover renders and the cache key does not cover -- drop
        // the memo so the next discover inside the TTL shows the penalty
        // instead of the pre-miss text.
        this.invalidateDiscoverCache();
      }
      this.redispatch.push(primary, intentTokens, now);
      // Privacy-safe, opt-in routing-eval harvest (the "environment foundry").
      // Disabled unless YAW_MCP_FOUNDRY is set; only a REDACTED token bag plus
      // the chosen namespace is ever written -- never the raw intent string,
      // and not the ranker's shortlist either (it was accepted and dropped on
      // the floor for a release; see FoundryTrace in foundry.ts).
      if (isFoundryEnabled()) {
        const redacted = redactIntent(trimmed);
        void appendFoundryTrace({
          tokens: redacted.tokens,
          redactedCount: redacted.redactedCount,
          chosen: primary,
        });
      }
    }

    const results: string[] = [];
    let anyChanged = false;
    let anyError = false;
    let anyCapped = false;
    // Same growth tracking as handleActivate: an already-connected winner
    // (isChanged:false) can still be newly advertised, and the notify below
    // must fire for that too or the "now callable" tools stay invisible to
    // a list_changed-driven gateway client.
    let advertisedGrew = false;

    let i = 0;
    for (const winner of winners) {
      i += 1;
      progress?.(`Loading ${winner.namespace} (${i}/${winners.length})`, i - 1, winners.length);
      const r = await this.activateOne(winner.namespace, progress);
      results.push(`${winner.namespace} (score ${winner.score.toFixed(2)}): ${r.message}`);
      if (r.isChanged) anyChanged = true;
      // Gateway mode must advertise what dispatch just loaded: the client
      // asked for a server for THIS intent (bounded by `budget`), and the
      // response promises the tools are now callable ("no separate
      // discover + load step" -- meta-tools.ts). Without this, the
      // tools/list_changed fired below changes nothing under the default
      // gateway exposure and the loaded tools stay invisible to any client
      // that can only invoke advertised tools. Recorded on success only,
      // mirroring handleActivate.
      if (r.ok) {
        if (!this.sessionActivated.has(winner.namespace)) advertisedGrew = true;
        this.sessionActivated.add(winner.namespace);
      }
      // Cap refusals are expected when the budget exceeds the concurrent
      // server cap -- informational alongside successes, but if NOTHING
      // loaded the dispatch did no work and must signal (same rule as
      // handleActivate).
      if (!r.ok) {
        if (r.capped) anyCapped = true;
        else anyError = true;
      }
      // Activation success is NOT recorded as a learning signal — that
      // would inflate "this server worked" into "every activation
      // counts as a successful tool call," which collapses the
      // dispatched/succeeded ratio that boostFactor and the flaky-
      // namespace warnings rely on. The ground truth is tool-call
      // success, recorded in handleToolCall on the proxy path.
    }
    // No trailing "Dispatch complete" progress — see handleActivate for
    // the client-side race this avoids.

    if (anyChanged) {
      await this.refreshRoutesAndNotify();
    } else if (advertisedGrew) {
      // Advertised set grew without a connection change (winner already
      // connected but never advertised) -- routes are current, but the
      // tools/list surface moved. Mirrors handleActivate.
      await this.notifyAllListsChanged();
    }

    const header = `Dispatched "${trimmed}" — loaded top ${winners.length} of ${ranked.length} matching server${ranked.length === 1 ? "" : "s"}.\n`;
    return {
      content: [{ type: "text", text: header + results.join("\n") }],
      isError: anyError || (anyCapped && !anyChanged) ? true : undefined,
    };
  }

  // Drop every per-namespace bit of session state after its connection has
  // been closed. Called by BOTH teardown sites -- explicit deactivate and the
  // idle reaper -- which used to carry identical copies of this list, so a
  // new piece of per-namespace state had to be remembered in two places to
  // avoid leaking into the next load of the same server.
  //
  // Deliberately NOT cleared here: toolCache / toolCacheLearnedAt (what the
  // server offers survives an unload -- that is what makes it deferred
  // rather than invisible), activationFailures (a health signal with its own
  // TTL), and learning counters (cross-session by design).
  private forgetNamespace(namespace: string): void {
    this.connections.delete(namespace);
    this.idleCallCounts.delete(namespace);
    this.adaptiveSkipLogged.delete(namespace);
    this.toolFilters.delete(namespace);
    // Without this the namespace stays advertised in gateway mode after
    // being unloaded -- "Tools removed from context" would be a lie, and a
    // LATER dispatch-driven activation would re-advertise the whole
    // namespace without the client ever asking for it.
    this.sessionActivated.delete(namespace);
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

      // Never close under a live call, the same guard the idle reaper
      // applies: the close rejects the caller's own pending tools/call, the
      // proxy turns that into an isError result, and handleToolCall books an
      // errorCount plus a 0.0 reward against an upstream that was answering
      // normally. Report it instead of doing that -- the namespace stays
      // loaded and one more deactivate once the call drains unloads it.
      const inflight = this.inflightCalls.get(namespace) ?? 0;
      if (inflight > 0) {
        log("info", "Skipping deactivation — tool call in flight", { namespace, inflight });
        results.push(
          `"${namespace}" still has ${inflight} tool call${inflight === 1 ? "" : "s"} in flight — not unloaded. Call mcp_connect_deactivate again once they finish.`,
        );
        continue;
      }

      await disconnectFromUpstream(connection);
      this.forgetNamespace(namespace);
      anyChanged = true;
      results.push(`Unloaded "${namespace}". Tools removed from context.`);
    }

    if (anyChanged) {
      await this.refreshRoutesAndNotify();
    }

    return {
      content: [{ type: "text", text: results.join("\n") }],
    };
  }

  private async trackUsageAndAutoDeactivate(calledNamespace: string): Promise<void> {
    await this.trackUsageForNamespaces([calledNamespace]);
  }

  // Idle bookkeeping for one logical unit of work. A direct tool call names
  // exactly one namespace; an exec pipeline names every namespace its steps
  // touched and ticks the rest ONCE, so a long pipeline can't age (and evict)
  // a server a later step still needs. Every namespace in `calledNamespaces`
  // is treated as freshly used; everything else connected ages by one.
  private async trackUsageForNamespaces(calledNamespaces: string[]): Promise<void> {
    const called = new Set(calledNamespaces);
    // Record the call(s) in the rolling history BEFORE computing per-ns
    // thresholds — so adaptive bonuses reflect the fact we just called
    // these namespaces (protects them from deactivation on a back-to-back
    // burst where another ns happens to tick over the baseline).
    const at = Date.now();
    for (const ns of calledNamespaces) {
      pushToolCall(this.recentToolCalls, { namespace: ns, at }, HISTORY_LIMIT);
      // Reset idle count for the server that was just called, and forget
      // any previous "we already logged the patience message for you"
      // marker — the next time it goes idle we want a fresh log.
      this.idleCallCounts.set(ns, 0);
      this.adaptiveSkipLogged.delete(ns);
    }

    // Increment idle count for all OTHER active servers
    for (const ns of this.connections.keys()) {
      if (!called.has(ns)) {
        this.idleCallCounts.set(ns, (this.idleCallCounts.get(ns) ?? 0) + 1);
      }
    }

    // Auto-deactivate servers that have been idle too long, using an
    // adaptive per-namespace threshold so bursty upstreams get more
    // patience. The baseline comes from resolveIdleThreshold() (env
    // var-overridable, re-read per call); the adaptive function adds a
    // bonus based on that namespace's recent activity.
    const baseline = resolveIdleThreshold();
    const toDeactivate: string[] = [];
    for (const [ns, idleCount] of this.idleCallCounts) {
      if (!this.connections.has(ns)) continue;
      const threshold = adaptiveThreshold(ns, this.recentToolCalls, baseline);
      if (idleCount >= threshold) {
        // Never reap a namespace with a tool call still in flight: the
        // close would reject the user's own pending callTool, which the
        // proxy turns into an isError result and handleToolCall then books
        // as a 0.0 reward against a server WE killed. Leaving it connected
        // costs one more idle tick — it is re-evaluated on the next
        // completion, by which point the call has drained.
        if ((this.inflightCalls.get(ns) ?? 0) > 0) {
          log("info", "Skipping idle deactivation — tool call in flight", {
            namespace: ns,
            idleCalls: idleCount,
          });
          continue;
        }
        toDeactivate.push(ns);
      } else if (idleCount >= baseline && !this.adaptiveSkipLogged.has(ns)) {
        // We would have deactivated under the baseline threshold but the
        // adaptive bonus is keeping this ns alive. Log once per ns so
        // users can see the mechanism doing its job, then stay quiet.
        log("info", "Adaptive idle patience keeping bursty upstream alive", {
          namespace: ns,
          idleCalls: idleCount,
          baseline,
          adaptiveThreshold: threshold,
        });
        this.adaptiveSkipLogged.add(ns);
      }
    }

    let deactivated = 0;
    for (const ns of toDeactivate) {
      const connection = this.connections.get(ns);
      if (!connection) continue;
      // Re-check the in-flight guard immediately before the close, not just
      // when the list was built: this loop awaits per namespace, and each
      // disconnectFromUpstream burns real event-loop time (the SDK's stdio
      // close races a 2s timer twice), so a tools/call for a LATER entry can
      // be routed and started in that window. The snapshot taken above is
      // stale by then, and closing under a live call is exactly the 0.0
      // reliability hit against our own kill that the guard exists to stop.
      if ((this.inflightCalls.get(ns) ?? 0) > 0) {
        log("info", "Skipping idle deactivation — tool call landed during teardown", {
          namespace: ns,
          idleCalls: this.idleCallCounts.get(ns),
        });
        continue;
      }
      log("info", "Auto-deactivating idle server", { namespace: ns, idleCalls: this.idleCallCounts.get(ns) });
      await disconnectFromUpstream(connection);
      // Same teardown as an explicit deactivate -- one copy, so the two can
      // never drift over which per-namespace state survives an unload.
      this.forgetNamespace(ns);
      deactivated++;
    }

    // Only notify when a connection actually went away — a run where every
    // candidate was skipped leaves the routing table exactly as it was.
    if (deactivated > 0) {
      await this.refreshRoutesAndNotify();
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

    // Refuse once shutdown() has latched, for the same reason activateOne
    // does: the transient connect below SPAWNS a child, and one spawned
    // after the teardown snapshot is outside this.connections -- nothing
    // reaps it, so it survives until index.ts force-exits the process.
    // activateOne was the only caller checking the latch; read_tool spawns
    // through connectToUpstream directly and slipped past it.
    if (this.shuttingDown) {
      return {
        content: [{ type: "text", text: `"${serverArg}" was not inspected — yaw-mcp is shutting down.` }],
        isError: true,
      };
    }

    // Look up WITHOUT the isActive filter, then split "not installed" from
    // "installed but disabled" exactly as runActivateOne does (fuzzy hint
    // included). Filtering on isActive in the find collapsed both cases into
    // "not in ~/.yaw-mcp/bundles.json", which is a lie for a server that IS
    // in the file with "isActive": false -- and it pointed the model at
    // installing something it already has instead of flipping the toggle.
    const serverConfig = this.config?.servers.find((s) => s.namespace === serverArg);
    if (!serverConfig) {
      const allNamespaces = this.config?.servers.map((s) => s.namespace) ?? [];
      const suggestions = closestNames(serverArg, allNamespaces, 3);
      const hint =
        suggestions.length > 0
          ? ` Did you mean: ${suggestions.join(", ")}?`
          : " Call mcp_connect_discover to list available servers.";
      return {
        content: [
          {
            type: "text",
            text: `"${serverArg}" is not in ~/.yaw-mcp/bundles.json.${hint}`,
          },
        ],
        isError: true,
      };
    }
    // Disabled / profile / compliance, from the SAME copy runActivateOne
    // uses (spawnGateRefusal) so the two spawn paths cannot drift apart on
    // policy or wording -- only the trailing verb differs, which is the
    // `purpose` argument. The transient connect below still SPAWNS the
    // server's configured command with its resolved env (vault secrets
    // included) — "we disconnect afterwards" does not make executing a
    // deny-listed or below-floor server acceptable, and every other
    // surface (discover, dispatch, secrets, bundles, prewarm) narrows by
    // the profile before it reaches a server.
    const gateRefusal = this.spawnGateRefusal(serverConfig, "inspect its tools");
    if (gateRefusal) {
      return { content: [{ type: "text", text: gateRefusal }], isError: true };
    }

    // Fast path: server already loaded. Schema is already in context,
    // no network cost. Normalize with the live tool list so exact-match
    // takes priority over prefix-stripping.
    const existing = this.connections.get(serverArg);
    if (existing && existing.status === "connected") {
      const toolName = normalizeToolName(serverArg, toolArg, existing.tools);
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
    //
    // Accepted race: if an mcp_connect_activate for the same namespace
    // is in-flight via activateOne, this transient connect spawns a
    // SECOND upstream process. Both complete independently; the transient
    // is torn down in the finally block below, while activateOne's
    // connection is registered normally. The double-spawn is harmless
    // (two brief children, one wins the connections map) and fixing it
    // would require routing read_tool through activateOne's inflight
    // dedup map, which would change its semantics (persistent activation
    // vs transient inspection). Accepted as-is.
    progress?.(`Inspecting "${serverArg}" (transient — not loading into session)…`);
    let transient: UpstreamConnection | undefined;
    try {
      // Include any session-elicited credentials for this namespace so the
      // transient connect uses the same env as a persistent activation
      // would — otherwise schema inspection re-trips the missing-credential
      // error the user already supplied a value for this session.
      const elicitedForTransient = this.elicitedEnv.get(serverArg);
      const transientConfig = elicitedForTransient
        ? { ...serverConfig, env: { ...serverConfig.env, ...elicitedForTransient } }
        : serverConfig;
      transient = await connectToUpstream(transientConfig, undefined, undefined, this.clientBridge);
    } catch (err) {
      // One branch, not two: ActivationError extends Error and carries its
      // stderr tail + category hint inside `message`, so the separate
      // instanceof arm returned the identical string.
      const message = err instanceof Error ? err.message : String(err);
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
      // Normalize with the transient tool list so exact-match takes
      // priority over prefix-stripping.
      const toolName = normalizeToolName(serverArg, toolArg, transient.tools);
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

  // Values-free preview of which local-vault secrets each installed
  // server's `${secret:NAME}` env refs resolve to. NAMES ONLY -- this
  // reads the vault's KEY LIST (listKeys, no unlock, no passphrase) and
  // the servers' env-reference names, and NEVER calls getSecret /
  // decryptEntry. Servers with no refs are omitted.
  private async handleSecretsReport(
    serverArg?: string,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    // Vault key list only -- no unlock, no decryption. A missing/unreadable
    // vault yields an empty key set, so every referenced name reports as
    // missing rather than erroring.
    const vault = await loadVault(vaultPath()).catch(() => null);
    const vaultKeys = new Set(vault ? listKeys(vault) : []);

    let servers = this.getProfiledActiveServers().map((s) => ({ namespace: s.namespace, env: s.env }));
    if (serverArg) servers = servers.filter((s) => s.namespace === serverArg);

    const rows = computeSecretsReport(servers, vaultKeys);

    if (serverArg && servers.length === 0) {
      // "Not installed" is only ONE of the ways the filter above can come up
      // empty: getProfiledActiveServers() drops disabled and profile-blocked
      // namespaces too, and reporting either of those as "No installed
      // server" contradicts handleReadTool, which names the real reason for
      // the very same namespace and points at the fix. Same lookup and same
      // wording as that path, so the two agree.
      //
      // spawnGateRefusal covers exactly the two ways getProfiledActiveServers()
      // drops a configured server (disabled, profile-blocked), so a
      // configured-but-filtered namespace ALWAYS yields a refusal here, and a
      // null means the namespace was never configured at all -- the
      // not-installed message below. There is no third state; the fallback
      // string that used to stand in for one could not run.
      const configured = this.config?.servers.find((s) => s.namespace === serverArg);
      const refusal = configured ? this.spawnGateRefusal(configured, "inspect its tools") : null;
      if (refusal) return { content: [{ type: "text", text: refusal }], isError: true };
      return {
        content: [
          {
            type: "text",
            text: `No installed server with namespace "${serverArg}". Call mcp_connect_discover to list installed servers.`,
          },
        ],
        isError: true,
      };
    }

    if (rows.length === 0) {
      // Both scopes must read as a NEGATION. The single-server phrasing
      // needs its own verb ("does not reference") -- reusing the
      // all-servers sentence with a "Server \"gh\"" prefix produced
      // 'Server "gh" references any ${secret:NAME} vault values.', which
      // asserts the opposite of what happened.
      const sentence = serverArg
        ? `Server "${serverArg}" does not reference any \${secret:NAME} vault values.`
        : "No installed server references any ${secret:NAME} vault values.";
      return {
        content: [
          {
            type: "text",
            text: `${sentence} Add a reference in a server's env (e.g. GITHUB_TOKEN=\${secret:gh}) and store the value with \`yaw-mcp secrets set <name>\`.`,
          },
        ],
      };
    }

    // Names only -- no value ever appears in this payload.
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
    };
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
    } else {
      lines.push("Session health:\n");

      for (const [namespace, conn] of this.connections) {
        const h = conn.health;
        const avgLatency = h.totalCalls > 0 ? Math.round(h.totalLatencyMs / h.totalCalls) : 0;
        const errorRate = h.totalCalls > 0 ? Math.round((h.errorCount / h.totalCalls) * 100) : 0;
        const idleCount = this.idleCallCounts.get(namespace) ?? 0;
        const idleLimit = adaptiveThreshold(namespace, this.recentToolCalls, resolveIdleThreshold());
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
    }

    // Cross-session reliability — flaky dormant servers pulled from
    // persisted learning. The in-session block above already covers
    // loaded namespaces with rich per-call telemetry; this surfaces
    // history for servers we AREN'T currently talking to so the LLM /
    // operator knows which ones have been unreliable before reloading
    // them. Threshold + sort shared with `yaw-mcp doctor` via
    // selectFlakyNamespaces (see usage-hints.ts).
    const now = Date.now();
    const flaky = selectFlakyNamespaces(
      this.learning.entries().filter(({ namespace }) => !this.connections.has(namespace)),
      5,
    );
    if (flaky.length > 0) {
      // The percentage is DERIVED from the constant selectFlakyNamespaces
      // filters on, never typed as a literal: hardcoding "80%" meant moving
      // PENALTY_RATE_THRESHOLD silently relabelled a list it no longer
      // described.
      const flakyPct = Math.round(PENALTY_RATE_THRESHOLD * 100);
      lines.push(`\nCross-session reliability (dormant, <${flakyPct}% success):`);
      for (const { namespace, usage } of flaky) {
        const rate = Math.round((usage.succeeded / usage.dispatched) * 100);
        const age = formatRelativeAge(now - usage.lastUsedAt);
        lines.push(`  ${namespace} — ${usage.dispatched} calls, ${rate}% success, last used ${age} ago`);
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
      // Pack history carries across yaw-mcp restarts (see persistence.ts),
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
  // actionable with the servers in bundles.json.
  private handleBundles(action: "list" | "match"): { content: Array<{ type: string; text: string }> } {
    if (action === "list") {
      const lines: string[] = [`Curated server bundles (${CURATED_BUNDLES.length}):\n`];
      for (const bundle of CURATED_BUNDLES) {
        lines.push(`  ${bundle.id} — ${bundle.description}`);
        lines.push(`    servers: ${JSON.stringify(bundle.namespaces)}`);
        lines.push(`    activate: ${bundleActivateHint(bundle)}`);
      }
      lines.push("");
      lines.push(
        'Call mcp_connect_bundles with action="match" to filter these against the servers already in the user\'s bundles.json.',
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
            text: "No curated bundles match your currently installed servers. Browse the catalog at https://yaw.sh/mcp/catalog/ and add what a bundle needs with `yaw-mcp add <slug>`, then restart this MCP client and re-run mcp_connect_bundles.",
          },
        ],
      };
    }

    const lines: string[] = [];

    if (ready.length > 0) {
      lines.push("Bundles ready to activate now:");
      for (const bundle of ready) {
        lines.push(`  ${bundle.id} — ${bundle.description}`);
        lines.push(`    servers: ${JSON.stringify(bundle.namespaces)}`);
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
        lines.push(`    missing: ${missing.join(", ")} (add with: yaw-mcp add ${missing.join(" && yaw-mcp add ")})`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Extract the semantic payload from a successful MCP tool result for use
  // as a step binding in exec pipelines. The MCP wire format wraps every
  // result in `{ content: [{type, text}, ...], isError? }`, but the exec
  // tool description promises `$ref` targets that behave like the tool's
  // actual output -- e.g. `a = gh_list_prs(); b = gh_get_pr(a[0].number)`.
  //
  // Rules, in order:
  //   1. Single text item whose text is valid JSON -> the parsed JSON value.
  //   2. Single text item (non-JSON) -> the raw text string.
  //   3. Everything else (multi-item, non-text, empty) -> the content array.
  //
  // This is intentionally simple and loss-free: callers can still reach
  // the full wire payload via the `partial` / `steps` objects if needed.
  private static parseStepPayload(result: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }): unknown {
    const content = result.content;
    if (!Array.isArray(content) || content.length !== 1) return content ?? [];
    const item = content[0];
    if (item.type !== "text" || typeof item.text !== "string") return content;
    try {
      return JSON.parse(item.text);
    } catch {
      return item.text;
    }
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

    // Whole-pipeline refusals, decided BEFORE step 0 fires a side effect.
    // Both used to be per-step checks inside the dispatch loop below, where
    // "before" only meant before the OFFENDING step: a one-character typo in
    // the second step of `create issue -> comment on it` still cost a filed
    // issue, and the usual reaction (fix the ref, re-run the exec) filed a
    // second one. Every producer key is known statically, so neither refusal
    // needs anything to have run. Nothing has, so there is no partial output
    // to report and no idle tracking to settle on these paths.
    //
    // Meta-tools first, which is validateExecRefs' documented ORDERING
    // CONTRACT: what makes a meta-tool step illegal is the tool it names, not
    // its arguments, so a meta-tool step carrying a bad $ref must report the
    // meta-tool refusal rather than a ref error that sends the model off
    // fixing arguments for a call exec will never make.
    //
    // Meta-tools are callable by the client directly; routing them through
    // exec would let a step, say, deactivate the server another step is about
    // to use. Keep exec's surface narrowly proxy-only.
    //
    // Cast: META_TOOL_NAMES is a Set typed over the literal meta-tool names,
    // but step.tool is a user-supplied string. The cast widens `.has()` to
    // accept arbitrary strings without losing the runtime check.
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!(META_TOOL_NAMES as Set<string>).has(step.tool)) continue;
      const key = stepBindingKey(step, i);
      // Plain text, like both sibling preflight refusals, because the SHAPE is
      // the phase marker: `exec: ...` means nothing ran, while the
      // {ok, failedStep, error, partial} envelope means execution started and
      // `partial` holds what completed. That distinction is what tells a reader
      // whether a retry is free or can double a side effect, so a preflight
      // refusal must not borrow the envelope -- reporting `partial: {}` here
      // asserted the pipeline ran and completed nothing. This check used to sit
      // INSIDE the dispatch loop, where the envelope was right; hoisting it to a
      // pre-pass moved it across that boundary, and the shape moves with it.
      return {
        content: [
          {
            type: "text",
            text: `exec: step "${key}": meta-tool "${step.tool}" cannot be called from exec; call it directly`,
          },
        ],
        isError: true,
      };
    }
    const refCheck = validateExecRefs(steps);
    if (!refCheck.ok) {
      // Same plain-text shape as the validateExecRequest refusal above: this
      // is preflight, so there is no failedStep to attribute and no partial
      // bindings map -- the message already names the offending step index.
      return {
        content: [{ type: "text", text: `exec: ${refCheck.message}` }],
        isError: true,
      };
    }

    const bindings: Record<string, unknown> = {};
    const stepKeys: string[] = [];
    // stepKey -> namespace, built as steps run, so a failing step can
    // attribute cascading blame to the upstream steps it consumed via $ref.
    const stepNamespaces = new Map<string, string>();
    // Every namespace this pipeline actually dispatched to. The steps run
    // with deferIdleTracking, so the idle reaper is fed ONCE for the whole
    // exec (below) instead of once per step -- otherwise a 10-step pipeline
    // on A ages every other connected server by 10 calls and can evict one
    // a later step in this same pipeline was about to use.
    const touchedNamespaces = new Set<string>();
    // Namespaces PINNED for the pipeline's lifetime. Deferring this exec's
    // own idle tick only stops the pipeline aging its own servers; BETWEEN
    // two steps it has no call in flight at all, so a concurrent tool call
    // completing mid-pipeline ticks the reaper and can disconnect a server
    // the next step is about to use. The reaper (and explicit deactivate)
    // both skip any namespace with a non-zero inflightCalls entry, so
    // holding one per reachable namespace IS the pin. Released in
    // settleIdleTracking, which every exit from this method runs.
    const pinned = new Set<string>();
    const pinNamespace = (ns: string): void => {
      if (pinned.has(ns)) return;
      pinned.add(ns);
      this.inflightCalls.set(ns, (this.inflightCalls.get(ns) ?? 0) + 1);
    };
    const releasePins = (): void => {
      for (const ns of pinned) {
        const remaining = (this.inflightCalls.get(ns) ?? 1) - 1;
        if (remaining > 0) this.inflightCalls.set(ns, remaining);
        else this.inflightCalls.delete(ns);
      }
      pinned.clear();
    };
    const settleIdleTracking = async (): Promise<void> => {
      // Pins go first: the tick below is the pipeline's ONE idle tick, and
      // the namespaces it names are reset to zero idle by it anyway, so
      // holding the pins across it would only mask an unrelated reap.
      releasePins();
      if (touchedNamespaces.size === 0) return;
      const used = [...touchedNamespaces];
      touchedNamespaces.clear();
      await this.trackUsageForNamespaces(used);
    };

    // Pin what the pipeline can already see. A step whose tool has no route
    // yet (a deferred server an EARLIER step activates) is pinned as it
    // resolves, below.
    for (const step of steps) {
      const ns = this.toolRoutes.get(step.tool)?.namespace;
      if (ns) pinNamespace(ns);
    }

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
          await settleIdleTracking();
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
        await settleIdleTracking();
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

      // Dispatch through the same handleToolCall path that normal
      // tool-calls use. This reuses the auto-reconnect, deferred-route,
      // and pack-detector logic so exec steps behave identically to
      // direct calls — the caller pays no per-step cost in surprises.
      //
      // `extra` is omitted so exec steps don't fight for the top-level
      // progress token; the exec itself emits no progress.
      // Step-level (process) reward: defer the proxy path's learning signal
      // and attribute credit per step here, using the $ref dependency graph
      // so a step that fails on bad INPUT it consumed from an upstream step
      // shares the blame rather than sinking the upstream alone.
      // Snapshot the route map for THIS step before the lookup, and use
      // the snapshot for the call's blame attribution -- the same
      // discipline handleToolCall documents at its entry. Per-step (not
      // per-exec): an earlier step can legitimately rebuild routes by
      // activating a deferred server, so the next step must re-snapshot
      // rather than reuse a map captured before the pipeline started.
      const routes = this.toolRoutes;
      const stepNs = routes.get(step.tool)?.namespace;
      if (stepNs) {
        stepNamespaces.set(key, stepNs);
        touchedNamespaces.add(stepNs);
        // Pin a namespace whose route only appeared during this pipeline
        // (an earlier step activated a deferred server); the up-front pass
        // could not see it. No-op when it is already pinned.
        pinNamespace(stepNs);
      }
      let stepResult: { content: Array<{ type: string; text?: string }>; isError?: boolean };
      try {
        stepResult = await this.handleToolCall(step.tool, resolvedArgs, undefined, {
          deferLearning: true,
          deferIdleTracking: true,
        });
      } catch (err) {
        // Every ordinary exit from this method settles idle tracking (and
        // with it releases the pins). An unexpected throw must not be the
        // one path that leaves them held for the rest of the session, which
        // would make the reaper skip these namespaces forever.
        await settleIdleTracking();
        throw err;
      }

      if (stepResult.isError) {
        const errText = stepResult.content?.[0]?.text ?? "unknown error";
        // Internal routing/cache faults (stale toolCache, dropped connection,
        // failed auto-reconnect, unknown tool, failed deferred load) are NOT
        // the upstream's failure, so don't penalize the namespace's
        // reliability for them. Checked structurally (the brand the fault
        // emitters attach), not by text -- an upstream error that happens to
        // contain a marker phrase must still count against the upstream.
        const routingFault = isRoutingFaultResult(stepResult);
        if (stepNs && !routingFault) {
          // Invalid-params is recognized either by the transport-level code
          // tag ("[code=-32602]") OR by classifyError on a structured isError
          // body (the common MCP self-validation pattern, which carries no
          // code tag). When the failing step consumed $ref data from earlier
          // steps, the bad input likely came from a producer — split the blame
          // instead of full-blaming this server. Other errors are this
          // server's own failure (0.0).
          const inputShaped = errText.includes("[code=-32602]") || classifyError(errText) === "validation_error";
          const deps = collectRefDeps(step.args);
          if (inputShaped && deps.length > 0) {
            // The consumer failed and was never booked, so record its half
            // credit as a fresh dispatch. Each producer, however, ALREADY
            // booked its own dispatch when its step succeeded (recordOutcome
            // below) — booking it again here would double-count one real
            // dispatch (dispatched=2). Dock its earned credit with a
            // delta-only adjustment instead, leaving the dispatch count intact.
            this.learning.recordOutcome(stepNs, 0.5);
            for (const dep of deps) {
              const depNs = stepNamespaces.get(dep);
              if (depNs) this.learning.adjustSucceeded(depNs, -0.5);
            }
          } else {
            this.learning.recordOutcome(stepNs, 0);
          }
          this.scheduleStateSave();
          // Same reason the proxy path invalidates after its own
          // recordOutcome: discover renders `usage:` / `reliability:` lines
          // straight off these counters, and the discover cache key doesn't
          // see them -- so without this a discover inside the 3s TTL replays
          // the pre-failure numbers for the server that just failed.
          this.invalidateDiscoverCache();
        }
        await settleIdleTracking();
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

      if (stepNs) {
        // Grade the success the same way the proxy path does -- an empty or
        // error-shaped 200 must not bank full 1.0 credit just because it
        // wasn't flagged isError.
        this.learning.recordOutcome(stepNs, computeOutcomeReward(stepResult));
        this.scheduleStateSave();
        // The counters discover renders moved; drop the memo (see the
        // failure branch above and the proxy path's own invalidation).
        this.invalidateDiscoverCache();
      }
      bindings[key] = ConnectServer.parseStepPayload(stepResult);
    }

    const returnKey = explicitReturn ?? stepKeys[stepKeys.length - 1];
    const finalResult = bindings[returnKey];

    // One idle tick for the whole pipeline, after the last step, and the
    // point at which the namespace pins taken above are released. The
    // deferral alone only guarantees the pipeline never ticks the reaper
    // ITSELF; the pins are what stop a CONCURRENT call's tick unloading a
    // server between two steps of this exec.
    await settleIdleTracking();

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
    log("info", "Shutting down yaw-mcp");

    // Latch FIRST: activateOne refuses from here on, runActivateOne refuses
    // to start another attempt (its retry, an elicitation re-entry), and it
    // closes any handshake that resolves after this instead of registering
    // it, so nothing new can land in this.connections behind the teardown
    // below.
    this.shuttingDown = true;

    // Flush any pending state save before we stop accepting writes.
    // Cancels the debounce timer so no stale snapshot writes after.
    if (this.stateSaveTimer) {
      clearTimeout(this.stateSaveTimer);
      this.stateSaveTimer = null;
    }
    if (this.persistenceReady) {
      await this.flushStateSave();
    }

    // Drain activations that were already past the gate when we latched.
    // start()'s fire-and-forget prewarm can have several children mid-
    // handshake. One that resolves inside this window is closed by
    // runActivateOne's post-handshake shuttingDown gate (it never reaches
    // this.connections), and the drain is what gives that close time to run
    // before index.ts exits the process; one that resolves AFTER the window
    // takes the same gate, so a late handshake can no longer register into
    // the map cleared below and leak a live child.
    //
    // BOUNDED, deliberately. A single runActivateOne can burn a 15s connect
    // timeout (upstream.ts) retried once, plus a 60s elicitInput round-trip
    // — an unbounded await here outlives index.ts's 10s force-exit timer, so
    // a SIGTERM landing on a cold npx handshake would sit for 10s and then
    // exit(1) instead of exiting 0 promptly. 2s is what we can spend and
    // still finish: the disconnects below race the SDK's stdio close timers
    // (2s, twice) and then server.close() has to run, which leaves ~4s of
    // headroom under the 10s cap. Anything an activation needs beyond 2s was
    // never going to fit under that cap anyway, so waiting for it only buys
    // a forced exit(1).
    if (this.activationInflight.size > 0) {
      log("info", "Waiting for in-flight activations before teardown", { count: this.activationInflight.size });
      const drained = await settledWithin(
        Promise.allSettled([...this.activationInflight.values()]),
        ConnectServer.SHUTDOWN_DRAIN_MS,
      );
      if (!drained) {
        log("warn", "In-flight activations did not settle in time — tearing down anyway", {
          budgetMs: ConnectServer.SHUTDOWN_DRAIN_MS,
          count: this.activationInflight.size,
        });
      }
    }

    // An activation that landed during the drain calls scheduleStateSave()
    // for its freshly learned tool list, which re-arms the debounce timer we
    // cleared above — and that timer is unref'd, so it never fires before
    // the process exits. Flush once more when the drain re-armed it, so
    // bounding the drain cannot cost state the pre-drain flush would have
    // banked.
    if (this.stateSaveTimer) {
      clearTimeout(this.stateSaveTimer);
      this.stateSaveTimer = null;
      if (this.persistenceReady) await this.flushStateSave();
    }
    // Close the save path for good. Anything that lands from here on -- a
    // fire-and-forget refineRewardInBackground resolving late, a tool call an
    // embedded host lets finish after shutdown -- would otherwise re-arm the
    // debounce and write state.json AFTER the final flush above. In the CLI
    // process exit masks that; in an embedded or test host nothing does.
    this.persistenceReady = false;

    // Disconnect all upstreams
    const disconnects = Array.from(this.connections.values()).map((conn) => disconnectFromUpstream(conn));
    await Promise.allSettled(disconnects);
    this.connections.clear();
    // Drop session-elicited credentials, as the field's contract promises:
    // plaintext the user typed must not sit in this process's memory past the
    // session it was typed for.
    //
    // This is hygiene, NOT a reset for reuse -- a ConnectServer is
    // single-use. `shuttingDown` is latched above and nothing ever clears it
    // (activateOne refuses from here on, permanently), and `this.server` is
    // closed below. The other session-lifecycle fields (sessionActivated,
    // toolFilters, idleCallCounts, toolCache) are deliberately left as they
    // are: clearing them would advertise a second-session path that the
    // permanent latch and the closed transport cannot actually deliver. An
    // embedded or test host that wants another session constructs another
    // ConnectServer.
    this.elicitedEnv.clear();
    // Same contract, one scope wider. The vault passphrase lives in a MODULE
    // variable in upstream.ts (so no child env can ever inherit it), which
    // means it outlives this instance rather than being collected with it --
    // "session-scoped by construction" only holds when the process lifetime
    // equals the server lifetime. Two ConnectServers in one process would
    // otherwise share a passphrase while owning independent ask-latches, so
    // the second inherits plaintext its own user never typed. Clearing here
    // makes the passphrase's lifetime the SERVER's, which is what the prompt
    // that collected it ("for this session") told the user.
    clearSessionVaultPassphrase();
    this.inflightCalls.clear();

    await this.server.close();

    log("info", "yaw-mcp shutdown complete");
  }

  // Debounced save trigger. Called after every learning/pack-detector
  // write — the timer collapses bursts into one write so a busy session
  // isn't writing the state file 10×/sec. Silently no-ops until start()
  // has hydrated state, which keeps unit tests that skip start() from
  // touching the user's ~/.yaw-mcp/state.json.
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
      toolCache: this.exportToolCache(),
    });
  }
}
