import { scrubForWarning } from "./health-score.js";
import { log } from "./logger.js";
import { META_TOOLS } from "./meta-tools.js";
import type { UpstreamConnection, UpstreamServerConfig } from "./types.js";
import { resolveTimeoutEnv } from "./upstream.js";

export interface ToolRoute {
  namespace: string;
  originalName: string;
  // True when this route points at a server that isn't currently
  // connected but has a persisted toolCache — the call handler is
  // expected to activate the upstream on first tools/call, rebuild
  // routes, and re-dispatch. Not set (or false) for routes backed by
  // an active connection.
  deferred?: boolean;
}

// Permissive placeholder schema for deferred tools. We don't have the
// upstream's real inputSchema until it's been activated; clients that
// validate locally need *something*, and `additionalProperties: true`
// lets any shape through. The real schema takes over after activation
// via list_changed.
const DEFERRED_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

function deferredDescription(server: UpstreamServerConfig, cachedDesc: string | undefined): string {
  const base = cachedDesc?.trim();
  const suffix = `[yaw-mcp: server "${server.namespace}" not yet connected — first call activates it]`;
  return base ? `${base}\n\n${suffix}` : suffix;
}

export interface ResourceRoute {
  namespace: string;
  originalUri: string;
}

export interface PromptRoute {
  namespace: string;
  originalName: string;
}

export type ResourceContents = {
  contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }>;
};

// A resource yaw-mcp itself provides — not proxied from an upstream server.
// Today the only one is `yaw-mcp://guide` (rendered YAW-MCP.md), but the shape
// is general so future hosts like `yaw-mcp://config` or `yaw-mcp://health`
// can slot in the same way. Keeping the read side as a closure means
// callers (e.g. server.ts) can capture session state without yaw-mcp
// having to thread request context into proxy.ts.
export interface BuiltinResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  read: () => Promise<ResourceContents> | ResourceContents;
}

/**
 * How much of the catalog `tools/list` advertises.
 *
 * - `gateway` (default): the meta-tools, plus the tools of namespaces
 *   activated THIS SESSION. Nothing else — no deferred placeholders.
 * - `full`: the historical behavior — meta-tools, every active upstream's
 *   tools, and a deferred placeholder for every cached-but-inactive one.
 *
 * WHY GATEWAY IS THE DEFAULT. Deferring only the SCHEMA is not enough to make
 * a large catalog affordable. Measured 2026-08-09 against this install:
 * `tools/list` returned 252 tools / 108,025 chars (~27,000 tokens), of which
 * only 10 were meta-tools -- and the other 242 were ALREADY deferred, each
 * carrying the 61-char placeholder schema. The bytes were in the NAMES and
 * DESCRIPTIONS, which schema-deferral never removed. That payload is ~13% of a
 * 200K context and does not fit a 32K one at all: it failed every turn of a
 * 32,768-token local model with a hard 400 before the user's first token.
 *
 * Clients like Claude Code hide those descriptions themselves, which is why
 * this stayed invisible -- but that is a client-side compensation, and yaw-mcp
 * is used by clients with no such mechanism. Withholding the catalog at the
 * SERVER makes the gateway pattern work everywhere: discovery moves to
 * mcp_connect_discover / _suggest / _bundles, activation is explicit, and
 * mcp_connect_dispatch still reaches any tool by name without it ever having
 * been advertised.
 */
export type ToolExposure = "gateway" | "full";

export function buildToolList(
  activeConnections: Map<string, UpstreamConnection>,
  inactiveWithCache: UpstreamServerConfig[] = [],
  // Optional per-namespace filter: when a namespace has an entry, only
  // tools whose BARE name is in the set are advertised via tools/list.
  // Routes (buildToolRoutes) stay complete regardless, so the filter
  // only affects surfacing — mcp_connect_dispatch can still reach
  // hidden tools by name.
  toolFilters?: Map<string, Set<string>>,
  // Defaults to "full" so this function's contract is unchanged for any
  // caller that does not pass it. The POLICY default (gateway) lives in
  // resolveToolExposure() and is applied by the server -- keeping it out of
  // here means a helper or test calling buildToolList directly cannot
  // silently lose its tools.
  exposure: ToolExposure = "full",
  // Namespaces the client explicitly activated this session. Only consulted
  // in gateway mode; `full` advertises everything regardless.
  exposedNamespaces?: ReadonlySet<string>,
): Array<{
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}> {
  const tools: Array<{
    name: string;
    title?: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  }> = [];
  const seen = new Set<string>();

  // Meta-tools first
  for (const meta of Object.values(META_TOOLS)) {
    tools.push({
      name: meta.name,
      description: meta.description,
      inputSchema: meta.inputSchema as Record<string, unknown>,
      annotations: meta.annotations as Record<string, unknown>,
    });
    seen.add(meta.name);
  }

  // Active upstream tools. The `seen` guard is load-bearing: the
  // namespaced name is `${namespace}_${tool}`, so (ns=`gh`,
  // tool=`actions_list`) and (ns=`gh_actions`, tool=`list`) both render as
  // `gh_actions_list`. Without the check the SAME name would be emitted
  // twice in tools/list (MCP names must be unique; clients dedupe
  // arbitrarily or error). First writer wins here, matching the meta-tool
  // precedence above; buildToolRoutes logs the collision.
  for (const conn of activeConnections.values()) {
    // Gateway mode advertises a namespace only once the client has asked for
    // it. A server that is merely CONNECTED does not qualify: yaw-mcp
    // pre-warms dormant servers on its own (prewarmDormantServers), so
    // keying on connectedness would re-advertise the whole catalog through
    // the back door and undo the point of the mode.
    if (exposure === "gateway" && !exposedNamespaces?.has(conn.config.namespace)) continue;
    const filter = toolFilters?.get(conn.config.namespace);
    for (const tool of conn.tools) {
      if (filter && !filter.has(tool.name)) continue;
      if (seen.has(tool.namespacedName)) continue;
      // title / outputSchema / _meta ride along so the structured-output
      // contract and display name survive the proxy (deferred placeholders
      // below stay minimal on purpose — their schema is a placeholder too).
      tools.push({
        name: tool.namespacedName,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        _meta: tool._meta,
      });
      seen.add(tool.namespacedName);
    }
  }

  // Deferred tools from inactive-but-configured servers. Active entries
  // above win any collision — a tool the client just saw backed by a
  // live connection must not be silently swapped for a placeholder.
  //
  // The per-namespace filter applies here too: a namespace with a live
  // filter but no connection would otherwise advertise its FULL cached
  // tool set, so a filtered-out tool reappears the moment its server goes
  // idle. Filters key on the BARE tool name, same as the active branch.
  for (const server of inactiveWithCache) {
    if (activeConnections.has(server.namespace)) continue;
    if (!server.toolCache || server.toolCache.length === 0) continue;
    // These placeholders ARE the ~27,000 tokens gateway mode exists to
    // remove. Withholding them costs nothing in reach: buildToolRoutes
    // ignores exposure, so mcp_connect_dispatch and a first tools/call
    // still activate the server and re-dispatch.
    if (exposure === "gateway") continue;
    const filter = toolFilters?.get(server.namespace);
    for (const cached of server.toolCache) {
      if (filter && !filter.has(cached.name)) continue;
      const namespacedName = `${server.namespace}_${cached.name}`;
      if (seen.has(namespacedName)) continue;
      tools.push({
        name: namespacedName,
        description: deferredDescription(server, cached.description),
        inputSchema: DEFERRED_INPUT_SCHEMA,
      });
      seen.add(namespacedName);
    }
  }

  return tools;
}

export function buildToolRoutes(
  activeConnections: Map<string, UpstreamConnection>,
  inactiveWithCache: UpstreamServerConfig[] = [],
): Map<string, ToolRoute> {
  const routes = new Map<string, ToolRoute>();

  // Active routes. The namespaced name is `${namespace}_${tool}` and the
  // separator is `_` -- combinations like (ns=`gh`, tool=`actions_list`)
  // and (ns=`gh_actions`, tool=`list`) both produce `gh_actions_list`.
  // Last writer used to win silently; warn once per collision so the
  // operator can rename one of the upstreams.
  for (const conn of activeConnections.values()) {
    for (const tool of conn.tools) {
      const existing = routes.get(tool.namespacedName);
      if (existing && existing.namespace !== conn.config.namespace) {
        // FIRST writer wins, and the `continue` below is load-bearing.
        // buildToolList skips a duplicate namespacedName (see the `seen`
        // guard), so the schema the model is shown belongs to the FIRST
        // upstream. Letting routes.set fall through here made dispatch
        // last-writer-wins, so a collision meant the client validated
        // against one upstream's inputSchema and the call executed a
        // DIFFERENT upstream's tool -- and a later-activated server could
        // silently capture an earlier one's traffic. The two surfaces must
        // agree on the winner; first is the safe direction to agree on.
        log("warn", "Tool route collision; keeping the first upstream, ignoring the later one", {
          tool: tool.namespacedName,
          keptNamespace: existing.namespace,
          ignoredNamespace: conn.config.namespace,
        });
        continue;
      }
      routes.set(tool.namespacedName, {
        namespace: conn.config.namespace,
        originalName: tool.name,
      });
    }
  }

  // Deferred routes. Skip names that already route to an active
  // connection — the active route is authoritative, and that shadowing is
  // intended (no warn). A deferred-vs-DEFERRED collision is different:
  // two idle servers whose cached names flatten to the same string, first
  // one wins, and the loser's tool is unreachable until the operator
  // renames a namespace. Warn on that so it isn't silent.
  for (const server of inactiveWithCache) {
    if (activeConnections.has(server.namespace)) continue;
    if (!server.toolCache || server.toolCache.length === 0) continue;
    for (const cached of server.toolCache) {
      const namespacedName = `${server.namespace}_${cached.name}`;
      const existing = routes.get(namespacedName);
      if (existing) {
        if (existing.deferred && existing.namespace !== server.namespace) {
          log("warn", "Deferred tool route collision; earlier cached server wins", {
            tool: namespacedName,
            winningNamespace: existing.namespace,
            shadowedNamespace: server.namespace,
          });
        }
        continue;
      }
      routes.set(namespacedName, {
        namespace: server.namespace,
        originalName: cached.name,
        deferred: true,
      });
    }
  }

  return routes;
}

/** One resources/list entry as this proxy publishes it. `title` and `_meta`
 *  are MCP 2025-06-18 passthrough fields -- see the forwarding note in the
 *  upstream loop below. */
export interface ProxiedResourceEntry {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}

// Builtins come FIRST in the list — they come from yaw-mcp itself and are
// always present regardless of which servers are activated, so clients
// that scan the list top-down (Claude Code does) see the guide before
// the upstream noise.
export function buildResourceList(
  activeConnections: Map<string, UpstreamConnection>,
  builtins: BuiltinResource[] = [],
  // Same gate as buildToolList: "not activated" has to mean the same thing on
  // every list, or gateway mode leaks the catalog through a different call.
  // Builtins are always listed -- they are yaw-mcp's own, not an upstream's.
  exposure: ToolExposure = "full",
  exposedNamespaces?: ReadonlySet<string>,
): Array<ProxiedResourceEntry> {
  const resources: ProxiedResourceEntry[] = [];
  // Same `seen` guard, and for the same reason, as buildToolList and
  // buildPromptList: a resources/list reply must not carry one uri twice.
  // An upstream that lists the same uri in two entries is enough to produce
  // that (so is a `connect://${namespace}/${uri}` pair that flattens to one
  // string), and clients then dedupe arbitrarily or error. Builtins seed the
  // set so a builtin SHADOWS an upstream uri here exactly as it does in
  // routeResourceRead — one winner on both surfaces. First writer wins, and
  // buildResourceRoutes agrees on that winner.
  const seen = new Set<string>();
  for (const b of builtins) {
    if (seen.has(b.uri)) continue;
    resources.push({ uri: b.uri, name: b.name, description: b.description, mimeType: b.mimeType });
    seen.add(b.uri);
  }
  for (const conn of activeConnections.values()) {
    if (exposure === "gateway" && !exposedNamespaces?.has(conn.config.namespace)) continue;
    for (const r of conn.resources) {
      if (seen.has(r.namespacedUri)) continue;
      // title / _meta ride along, same as buildToolList: an upstream that
      // published a display name or a metadata convention must reach the
      // client with both intact (MCP 2025-06-18). Builtins above set
      // neither -- yaw-mcp's own resources have no upstream to forward.
      resources.push({
        uri: r.namespacedUri,
        name: r.name,
        title: r.title,
        description: r.description,
        mimeType: r.mimeType,
        _meta: r._meta,
      });
      seen.add(r.namespacedUri);
    }
  }
  return resources;
}

export function buildResourceRoutes(activeConnections: Map<string, UpstreamConnection>): Map<string, ResourceRoute> {
  const routes = new Map<string, ResourceRoute>();
  for (const conn of activeConnections.values()) {
    for (const r of conn.resources) {
      const existing = routes.get(r.namespacedUri);
      if (existing) {
        // FIRST writer wins, mirroring buildToolRoutes / buildPromptRoutes,
        // and the `continue` is load-bearing for the same reason:
        // buildResourceList skips a duplicate namespacedUri, so the entry the
        // client was shown belongs to the FIRST writer. Last-writer-wins here
        // meant resources/read fetched a DIFFERENT resource than the one
        // advertised under that uri. Warn only when a SECOND namespace is
        // involved -- one upstream repeating its own uri is not an
        // operator-fixable collision, there is no other server to rename.
        if (existing.namespace !== conn.config.namespace) {
          log("warn", "Resource route collision; keeping the first upstream, ignoring the later one", {
            uri: r.namespacedUri,
            keptNamespace: existing.namespace,
            ignoredNamespace: conn.config.namespace,
          });
        }
        continue;
      }
      routes.set(r.namespacedUri, { namespace: conn.config.namespace, originalUri: r.uri });
    }
  }
  return routes;
}

/** One prompts/list entry as this proxy publishes it. Same MCP 2025-06-18
 *  `title` / `_meta` passthrough as ProxiedResourceEntry. */
export interface ProxiedPromptEntry {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  _meta?: Record<string, unknown>;
}

export function buildPromptList(
  activeConnections: Map<string, UpstreamConnection>,
  exposure: ToolExposure = "full",
  exposedNamespaces?: ReadonlySet<string>,
): Array<ProxiedPromptEntry> {
  const prompts: ProxiedPromptEntry[] = [];
  // Same `seen` guard, and for the same reason, as buildToolList: prompts
  // flatten to `${namespace}_${prompt}` too, so (ns=`gh`, prompt=`review_pr`)
  // and (ns=`gh_review`, prompt=`pr`) both render as `gh_review_pr`. MCP
  // prompt names must be unique; without the check the SAME name is emitted
  // twice in prompts/list and clients dedupe arbitrarily or error. First
  // writer wins, and buildPromptRoutes agrees on that winner.
  const seen = new Set<string>();
  for (const conn of activeConnections.values()) {
    if (exposure === "gateway" && !exposedNamespaces?.has(conn.config.namespace)) continue;
    for (const p of conn.prompts) {
      if (seen.has(p.namespacedName)) continue;
      // title / _meta forwarded, same rationale as buildResourceList.
      prompts.push({
        name: p.namespacedName,
        title: p.title,
        description: p.description,
        arguments: p.arguments,
        _meta: p._meta,
      });
      seen.add(p.namespacedName);
    }
  }
  return prompts;
}

export function buildPromptRoutes(activeConnections: Map<string, UpstreamConnection>): Map<string, PromptRoute> {
  const routes = new Map<string, PromptRoute>();
  for (const conn of activeConnections.values()) {
    for (const p of conn.prompts) {
      const existing = routes.get(p.namespacedName);
      if (existing && existing.namespace !== conn.config.namespace) {
        // FIRST writer wins, mirroring buildToolRoutes -- and the `continue`
        // is load-bearing for the same reason. buildPromptList skips a
        // duplicate namespacedName, so the prompt (description + argument
        // list) the client was shown belongs to the FIRST upstream. Letting
        // routes.set fall through made prompts/get last-writer-wins, so a
        // collision meant the client picked one upstream's prompt and got a
        // DIFFERENT upstream's -- and a later-activated server could silently
        // capture an earlier one's traffic. Both surfaces must agree on the
        // winner; first is the safe direction to agree on.
        log("warn", "Prompt route collision; keeping the first upstream, ignoring the later one", {
          prompt: p.namespacedName,
          keptNamespace: existing.namespace,
          ignoredNamespace: conn.config.namespace,
        });
        continue;
      }
      routes.set(p.namespacedName, { namespace: conn.config.namespace, originalName: p.name });
    }
  }
  return routes;
}

export async function routeResourceRead(
  uri: string,
  resourceRoutes: Map<string, ResourceRoute>,
  activeConnections: Map<string, UpstreamConnection>,
  builtins?: Map<string, BuiltinResource>,
): Promise<ResourceContents> {
  // Builtin resources are served directly by yaw-mcp and never route to an
  // upstream — check them first. A builtin's URI intentionally SHADOWS
  // an upstream URI with the same string, since the builtin is the
  // canonical answer for yaw-mcp-namespaced content (e.g. `yaw-mcp://guide`).
  const builtin = builtins?.get(uri);
  if (builtin) {
    try {
      return await builtin.read();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", "Builtin resource read failed", { uri, error: message });
      return { contents: [{ uri, text: `Error: ${message}` }] };
    }
  }

  const route = resourceRoutes.get(uri);
  if (!route) {
    return { contents: [{ uri, text: `Unknown resource: ${uri}` }] };
  }

  const connection = activeConnections.get(route.namespace);
  if (connection?.status !== "connected") {
    return { contents: [{ uri, text: `Server "${route.namespace}" is not connected.` }] };
  }

  try {
    const result = (await connection.client.readResource({ uri: route.originalUri })) as ResourceContents;
    // Re-namespace every uri on the way out. resources/list, the route table
    // and this function's own error arms all speak the `connect://<ns>/<uri>`
    // form, so returning the upstream's raw uri handed the client back a
    // string it cannot read again -- the one surface that leaked the
    // un-namespaced form. Namespaced PER ENTRY rather than rewritten to the
    // requested uri: a single read may legitimately return several
    // sub-resources, and collapsing them onto the requested uri would lose
    // which is which.
    return {
      ...result,
      contents: (result.contents ?? []).map((c) => ({ ...c, uri: `connect://${route.namespace}/${c.uri}` })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Scrubbed for the log line only -- see routeToolCall's catch for why.
    // The client still gets the raw text in the body below.
    log("error", "Resource read failed", { uri, namespace: route.namespace, error: scrubForWarning(message) });
    return { contents: [{ uri, text: `Error: ${message}` }] };
  }
}

export async function routePromptGet(
  name: string,
  args: Record<string, string> | undefined,
  promptRoutes: Map<string, PromptRoute>,
  activeConnections: Map<string, UpstreamConnection>,
): Promise<{ messages: Array<{ role: string; content: { type: string; text: string } }> }> {
  const route = promptRoutes.get(name);
  if (!route) {
    return { messages: [{ role: "user", content: { type: "text", text: `Unknown prompt: ${name}` } }] };
  }

  const connection = activeConnections.get(route.namespace);
  if (connection?.status !== "connected") {
    return {
      messages: [{ role: "user", content: { type: "text", text: `Server "${route.namespace}" is not connected.` } }],
    };
  }

  try {
    const result = await connection.client.getPrompt({ name: route.originalName, arguments: args });
    return result as { messages: Array<{ role: string; content: { type: string; text: string } }> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Scrubbed for the log line only -- see routeToolCall's catch for why.
    // The client still gets the raw text in the message below.
    log("error", "Prompt get failed", { name, namespace: route.namespace, error: scrubForWarning(message) });
    return { messages: [{ role: "user", content: { type: "text", text: `Error: ${message}` } }] };
  }
}

// Brand for tool-call error results produced by yaw-mcp's OWN routing
// layer (stale toolCache, dropped connection, failed auto-reconnect,
// failed deferred load, unknown tool) rather than by the upstream server.
// server.ts's health/learning/redispatch booking and handleExec's step
// attribution check the brand -- an in-process object property -- instead
// of sniffing the error TEXT, because the ROUTING_FAULT_* marker phrases
// are generic English: a genuine upstream error that happens to say "no
// longer available" or echo "Unknown tool:" must still be booked against
// the upstream's reliability, and only results yaw-mcp itself constructed
// can carry the brand. A symbol property is invisible to JSON.stringify
// (and non-enumerable besides), so it never leaks onto the wire; it only
// travels between in-process callers. The ROUTING_FAULT_* text constants
// in server.ts remain the pinned user-facing message shapes.
const ROUTING_FAULT_BRAND: unique symbol = Symbol("yaw-mcp:routing-fault");

/** Mark `result` as a yaw-mcp-internal routing fault. Returns `result`. */
export function brandRoutingFault<T extends object>(result: T): T {
  Object.defineProperty(result, ROUTING_FAULT_BRAND, { value: true, enumerable: false });
  return result;
}

/** True when `result` was constructed by yaw-mcp's own routing layer
 *  (see brandRoutingFault). Never true for upstream-produced results. */
export function isRoutingFaultResult(result: unknown): boolean {
  return (
    typeof result === "object" && result !== null && (result as Record<symbol, unknown>)[ROUTING_FAULT_BRAND] === true
  );
}

// Bound on a single proxied tools/call. The SDK applies 60s of its own if no
// options object is passed; naming the number here turns it into an operator
// knob (MCP_CALL_TIMEOUT) instead of an SDK constant nobody can reach, matching
// MCP_CONNECT_TIMEOUT on the handshake and MCP_LIST_TIMEOUT on the inventory
// calls -- previously the only leg of a request with no override.
//
// The DEFAULT deliberately stays at the SDK's 60s. Raising it is an operator
// decision because a wedged upstream holds the namespace's inflightCalls marker
// (server.ts) for the whole ceiling and stalls the model that much longer
// before erroring.
//
// Why it needs to be tunable at all: a timeout is not a routing fault, so
// server.ts books it as a genuine upstream error (error rate up, outcome reward
// down) and a slow-but-HEALTHY server -- browser automation, a large query or
// repo index, a cold oam-hosted first call -- gets progressively down-ranked in
// the reliability/usage lines discover renders. This knob is how an operator
// says "that one is legitimately slow" instead of watching a working server be
// described as flaky.
//
// Parsed by the shared resolveTimeoutEnv (upstream.ts), which the connect and
// inventory knobs use too: a strict digit run in 1..MAX_TIMEOUT_MS, anything
// else falling back to the 60s default with one warn. Both halves matter here.
// A prefix-parsed "3e9" or "30s" would become a 3ms or 30ms ceiling, and an
// out-of-range value clamped to MAX_TIMEOUT_MS would be an effectively
// infinite one -- so EVERY proxied tools/call would either return -32001
// immediately (and a timeout is not branded a routing fault, so server.ts
// books each one against the upstream's health and error rate) or pend for
// ~24.8 days holding the namespace's inflightCalls marker.
const CALL_TIMEOUT = resolveTimeoutEnv("MCP_CALL_TIMEOUT", 60_000);

// `text` is OPTIONAL on the items this returns, and that is not pedantry: on
// the success path the body is whatever the upstream sent, and MCP content
// blocks include image / audio / resource_link / embedded-resource shapes that
// carry no `text` at all. Declaring `text: string` told every consumer
// (server.ts books health, prunes, grades and $ref-binds off these) that a
// string was always there, so `content[0].text` type-checked and handed them
// `undefined` at runtime on any non-text tool result. The two fault paths and
// the catch below do always produce text; the union is what the union has.
/** One upstream progress notification, as the SDK hands it to `onprogress`. */
export interface UpstreamProgress {
  progress: number;
  total?: number;
  message?: string;
}

/** The two things the DOWNSTREAM request carries that an upstream call needs.
 *
 *  Both used to stop at this function's parameter list. The CallToolRequest
 *  handler in server.ts receives an `extra` holding the client's abort signal
 *  and its progress token, but routeToolCall took four arguments and `extra`
 *  was not one of them -- so the call below went out with a timeout and
 *  nothing else, and two things the client asked for died at the hop:
 *
 *  - Cancellation. The downstream abort tore down yaw-mcp's own handler while
 *    the awaited upstream call ran on to completion (or to CALL_TIMEOUT). The
 *    reverse direction was already careful about this: upstream-originated
 *    elicitation / sampling / roots each forward `extra.signal` (upstream.ts).
 *  - Progress. Without `onprogress` the SDK injects no `_meta.progressToken`
 *    into the upstream request, so a long-running upstream tool was never even
 *    ASKED to report progress, and the client watched a blank wait. */
export interface RouteToolCallOptions {
  /** The downstream request's abort signal. Forwarding it makes the SDK send
   *  `notifications/cancelled` upstream and reject the pending call. */
  signal?: AbortSignal;
  /** Relay for upstream progress. Supply it ONLY when the downstream client
   *  actually asked for progress: passing it makes the SDK add a progress
   *  token to the upstream request, so an unconditional callback would change
   *  the wire shape of every proxied call to buy notifications nothing reads. */
  onprogress?: (p: UpstreamProgress) => void;
}

export async function routeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  toolRoutes: Map<string, ToolRoute>,
  activeConnections: Map<string, UpstreamConnection>,
  options?: RouteToolCallOptions,
): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
  const route = toolRoutes.get(toolName);

  if (!route) {
    return brandRoutingFault({
      content: [
        {
          type: "text",
          text: `Unknown tool: ${toolName}. Use mcp_connect_discover to see available servers, then mcp_connect_activate to load tools.`,
        },
      ],
      isError: true,
    });
  }

  const connection = activeConnections.get(route.namespace);

  if (connection?.status !== "connected") {
    return brandRoutingFault({
      content: [
        {
          type: "text",
          text: `Server "${route.namespace}" is no longer connected. Use mcp_connect_activate with server "${route.namespace}" to reconnect.`,
        },
      ],
      isError: true,
    });
  }

  try {
    const result = await connection.client.callTool(
      {
        name: route.originalName,
        arguments: args,
      },
      // The second argument is the RESULT SCHEMA, not the options: passing the
      // options object there would silently replace CallToolResultSchema and
      // take the SDK's structured-output validation with it. `undefined` keeps
      // the SDK default; the request options belong in the third slot.
      undefined,
      // `signal` and `onprogress` are passed straight through, undefined and
      // all: the SDK guards both (`options?.signal?.throwIfAborted()`, and
      // `if (options?.onprogress)` before it registers a token), so an absent
      // one is inert and needs no conditional spread here.
      //
      // `resetTimeoutOnProgress` is deliberately NOT set. It would let a
      // progress-reporting upstream push past CALL_TIMEOUT indefinitely,
      // which is a change to how long a call may run -- a separate decision
      // from restoring the two signals the client already sent, and one that
      // wants its own bound (maxTotalTimeout) rather than riding in here.
      { timeout: CALL_TIMEOUT, signal: options?.signal, onprogress: options?.onprogress },
    );

    return result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  } catch (err) {
    // Transport-level errors (timeouts, JSON-RPC errors, disconnects)
    // come through here; structured upstream errors (`isError: true` in
    // the result) flow back through the success path above. Include the
    // MCP error code if present so the LLM can tell "args were wrong"
    // (-32602) from "the upstream is down" (transport) and decide
    // whether retrying makes sense.
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "number"
        ? (err as { code: number }).code
        : undefined;
    // The log line is scrubbed; the tool result is not. Third-party servers
    // routinely echo args and secrets in error text (URLs with api_key=,
    // request bodies, tracebacks with locals -- see error-category.ts), and
    // for a stdio server this stderr IS the client's on-disk log, where it
    // outlives the session. The client already receives the full text in the
    // result below, so nothing is lost for debugging.
    log("error", "Tool call failed", {
      tool: toolName,
      namespace: route.namespace,
      error: scrubForWarning(message),
      code,
    });
    const codeTag = code !== undefined ? ` [code=${code}]` : "";
    return {
      content: [{ type: "text", text: `Error calling ${toolName}${codeTag}: ${message}` }],
      isError: true,
    };
  }
}
