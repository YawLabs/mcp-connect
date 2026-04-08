import { log } from "./logger.js";
import { META_TOOLS } from "./meta-tools.js";
import type { UpstreamConnection, UpstreamToolDef } from "./types.js";

export interface ToolRoute {
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
