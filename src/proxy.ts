import { log } from "./logger.js";
import { META_TOOLS } from "./meta-tools.js";
import type { UpstreamConnection, UpstreamServerConfig } from "./types.js";

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
  const suffix = `[mcph: server "${server.namespace}" not yet connected — first call activates it]`;
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

// A resource mcph itself provides — not proxied from an upstream server.
// Today the only one is `mcph://guide` (rendered MCPH.md), but the shape
// is general so future hosts like `mcph://config` or `mcph://health`
// can slot in the same way. Keeping the read side as a closure means
// callers (e.g. server.ts) can capture session state without mcph
// having to thread request context into proxy.ts.
export interface BuiltinResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  read: () => Promise<ResourceContents> | ResourceContents;
}

export function buildToolList(
  activeConnections: Map<string, UpstreamConnection>,
  inactiveWithCache: UpstreamServerConfig[] = [],
  // Optional per-namespace filter: when a namespace has an entry, only
  // tools whose BARE name is in the set are advertised via tools/list.
  // Routes (buildToolRoutes) stay complete regardless, so the filter
  // only affects surfacing — mcp_connect_dispatch can still reach
  // hidden tools by name.
  toolFilters?: Map<string, Set<string>>,
): Array<{
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}> {
  const tools: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
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

  // Active upstream tools
  for (const conn of activeConnections.values()) {
    const filter = toolFilters?.get(conn.config.namespace);
    for (const tool of conn.tools) {
      if (filter && !filter.has(tool.name)) continue;
      tools.push({
        name: tool.namespacedName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      });
      seen.add(tool.namespacedName);
    }
  }

  // Deferred tools from inactive-but-configured servers. Active entries
  // above win any collision — a tool the client just saw backed by a
  // live connection must not be silently swapped for a placeholder.
  for (const server of inactiveWithCache) {
    if (activeConnections.has(server.namespace)) continue;
    if (!server.toolCache || server.toolCache.length === 0) continue;
    for (const cached of server.toolCache) {
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

  for (const conn of activeConnections.values()) {
    for (const tool of conn.tools) {
      routes.set(tool.namespacedName, {
        namespace: conn.config.namespace,
        originalName: tool.name,
      });
    }
  }

  // Deferred routes. Skip names that already route to an active
  // connection — the active route is authoritative.
  for (const server of inactiveWithCache) {
    if (activeConnections.has(server.namespace)) continue;
    if (!server.toolCache || server.toolCache.length === 0) continue;
    for (const cached of server.toolCache) {
      const namespacedName = `${server.namespace}_${cached.name}`;
      if (routes.has(namespacedName)) continue;
      routes.set(namespacedName, {
        namespace: server.namespace,
        originalName: cached.name,
        deferred: true,
      });
    }
  }

  return routes;
}

// Builtins come FIRST in the list — they come from mcph itself and are
// always present regardless of which servers are activated, so clients
// that scan the list top-down (Claude Code does) see the guide before
// the upstream noise.
export function buildResourceList(
  activeConnections: Map<string, UpstreamConnection>,
  builtins: BuiltinResource[] = [],
): Array<{ uri: string; name?: string; description?: string; mimeType?: string }> {
  const resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }> = [];
  for (const b of builtins) {
    resources.push({ uri: b.uri, name: b.name, description: b.description, mimeType: b.mimeType });
  }
  for (const conn of activeConnections.values()) {
    for (const r of conn.resources) {
      resources.push({
        uri: r.namespacedUri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      });
    }
  }
  return resources;
}

export function buildResourceRoutes(activeConnections: Map<string, UpstreamConnection>): Map<string, ResourceRoute> {
  const routes = new Map<string, ResourceRoute>();
  for (const conn of activeConnections.values()) {
    for (const r of conn.resources) {
      routes.set(r.namespacedUri, { namespace: conn.config.namespace, originalUri: r.uri });
    }
  }
  return routes;
}

export function buildPromptList(activeConnections: Map<string, UpstreamConnection>): Array<{
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}> {
  const prompts: Array<{
    name: string;
    description?: string;
    arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  }> = [];
  for (const conn of activeConnections.values()) {
    for (const p of conn.prompts) {
      prompts.push({
        name: p.namespacedName,
        description: p.description,
        arguments: p.arguments,
      });
    }
  }
  return prompts;
}

export function buildPromptRoutes(activeConnections: Map<string, UpstreamConnection>): Map<string, PromptRoute> {
  const routes = new Map<string, PromptRoute>();
  for (const conn of activeConnections.values()) {
    for (const p of conn.prompts) {
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
  // Builtin resources are served directly by mcph and never route to an
  // upstream — check them first. A builtin's URI intentionally SHADOWS
  // an upstream URI with the same string, since the builtin is the
  // canonical answer for mcph-namespaced content (e.g. `mcph://guide`).
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
  if (!connection || connection.status !== "connected") {
    return { contents: [{ uri, text: `Server "${route.namespace}" is not connected.` }] };
  }

  try {
    const result = await connection.client.readResource({ uri: route.originalUri });
    return result as ResourceContents;
  } catch (err: any) {
    log("error", "Resource read failed", { uri, namespace: route.namespace, error: err.message });
    return { contents: [{ uri, text: `Error: ${err.message}` }] };
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
  if (!connection || connection.status !== "connected") {
    return {
      messages: [{ role: "user", content: { type: "text", text: `Server "${route.namespace}" is not connected.` } }],
    };
  }

  try {
    const result = await connection.client.getPrompt({ name: route.originalName, arguments: args });
    return result as { messages: Array<{ role: string; content: { type: string; text: string } }> };
  } catch (err: any) {
    log("error", "Prompt get failed", { name, namespace: route.namespace, error: err.message });
    return { messages: [{ role: "user", content: { type: "text", text: `Error: ${err.message}` } }] };
  }
}

export async function routeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  toolRoutes: Map<string, ToolRoute>,
  activeConnections: Map<string, UpstreamConnection>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const route = toolRoutes.get(toolName);

  if (!route) {
    return {
      content: [
        {
          type: "text",
          text: `Unknown tool: ${toolName}. Use mcp_connect_discover to see available servers, then mcp_connect_activate to load tools.`,
        },
      ],
      isError: true,
    };
  }

  const connection = activeConnections.get(route.namespace);

  if (!connection || connection.status !== "connected") {
    return {
      content: [
        {
          type: "text",
          text: `Server "${route.namespace}" is no longer connected. Use mcp_connect_activate with server "${route.namespace}" to reconnect.`,
        },
      ],
      isError: true,
    };
  }

  try {
    const result = await connection.client.callTool({
      name: route.originalName,
      arguments: args,
    });

    return result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  } catch (err: any) {
    log("error", "Tool call failed", { tool: toolName, namespace: route.namespace, error: err.message });

    return {
      content: [{ type: "text", text: `Error calling ${toolName}: ${err.message}` }],
      isError: true,
    };
  }
}
