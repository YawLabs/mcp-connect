export const META_TOOLS = {
  discover: {
    name: "mcp_connect_discover",
    description:
      "List all available MCP servers. Call this FIRST before activating anything. Only activate servers you need for the CURRENT task — each one adds tools to your context. Shows server names, namespaces, tool counts, and activation status.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: {
      title: "Discover MCP Servers",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  activate: {
    name: "mcp_connect_activate",
    description:
      'Activate an MCP server by namespace to load its tools. Each server adds tools to context, so only activate what you need right now. Good practice: deactivate servers you are done with before activating new ones. Tools are prefixed by namespace (e.g., "gh_create_issue").',
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: 'The namespace of the server to activate (e.g., "gh", "slack", "stripe")',
        },
      },
      required: ["server"],
    },
    annotations: {
      title: "Activate MCP Server",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  deactivate: {
    name: "mcp_connect_deactivate",
    description:
      "Deactivate an MCP server to remove its tools and free context. Always deactivate servers you are finished with. Servers idle for 10+ tool calls to other servers are auto-deactivated.",
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: "The namespace of the server to deactivate",
        },
      },
      required: ["server"],
    },
    annotations: {
      title: "Deactivate MCP Server",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
} as const;

export const META_TOOL_NAMES = new Set([
  META_TOOLS.discover.name,
  META_TOOLS.activate.name,
  META_TOOLS.deactivate.name,
]);
