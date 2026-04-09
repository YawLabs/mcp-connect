import { log } from "./logger.js";
import { META_TOOLS } from "./meta-tools.js";
import type { UpstreamConnection } from "./types.js";

export interface ToolRoute {
  namespace: string;
  originalName: string;
}

export interface ResourceRoute {
  namespace: string;
  originalUri: string;
}

export interface PromptRoute {
  namespace: string;
  originalName: string;
}

export function buildToolList(activeConnections: Map<string, UpstreamConnection>): Array<{
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

  // Meta-tools first
  for (const meta of Object.values(META_TOOLS)) {
    tools.push({
      name: meta.name,
      description: meta.description,
      inputSchema: meta.inputSchema as Record<string, unknown>,
      annotations: meta.annotations as Record<string, unknown>,
    });
  }

  // Active upstream tools
  for (const conn of activeConnections.values()) {
    for (const tool of conn.tools) {
      tools.push({
        name: tool.namespacedName,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      });
    }
  }

  return tools;
}

export function buildToolRoutes(activeConnections: Map<string, UpstreamConnection>): Map<string, ToolRoute> {
  const routes = new Map<string, ToolRoute>();

  for (const conn of activeConnections.values()) {
    for (const tool of conn.tools) {
      routes.set(tool.namespacedName, {
        namespace: conn.config.namespace,
        originalName: tool.name,
      });
    }
  }

  return routes;
}

export function buildResourceList(
  activeConnections: Map<string, UpstreamConnection>,
): Array<{ uri: string; name?: string; description?: string; mimeType?: string }> {
  const resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }> = [];
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
): Promise<{ contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> }> {
  const route = resourceRoutes.get(uri);
  if (!route) {
    return { contents: [{ uri, text: "Unknown resource: " + uri }] };
  }

  const connection = activeConnections.get(route.namespace);
  if (!connection || connection.status !== "connected") {
    return { contents: [{ uri, text: 'Server "' + route.namespace + '" is not connected.' }] };
  }

  try {
    const result = await connection.client.readResource({ uri: route.originalUri });
    return result as { contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> };
  } catch (err: any) {
    log("error", "Resource read failed", { uri, namespace: route.namespace, error: err.message });
    return { contents: [{ uri, text: "Error: " + err.message }] };
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
    return { messages: [{ role: "user", content: { type: "text", text: "Unknown prompt: " + name } }] };
  }

  const connection = activeConnections.get(route.namespace);
  if (!connection || connection.status !== "connected") {
    return {
      messages: [
        { role: "user", content: { type: "text", text: 'Server "' + route.namespace + '" is not connected.' } },
      ],
    };
  }

  try {
    const result = await connection.client.getPrompt({ name: route.originalName, arguments: args });
    return result as { messages: Array<{ role: string; content: { type: string; text: string } }> };
  } catch (err: any) {
    log("error", "Prompt get failed", { name, namespace: route.namespace, error: err.message });
    return { messages: [{ role: "user", content: { type: "text", text: "Error: " + err.message } }] };
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
          text:
            "Unknown tool: " +
            toolName +
            ". Use mcp_connect_discover to see available servers, then mcp_connect_activate to load tools.",
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
          text:
            'Server "' +
            route.namespace +
            '" is no longer connected. Use mcp_connect_activate("' +
            route.namespace +
            '") to reconnect.',
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
      content: [{ type: "text", text: "Error calling " + toolName + ": " + err.message }],
      isError: true,
    };
  }
}
