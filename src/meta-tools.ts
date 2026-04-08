export const META_TOOLS = {
  discover: {
    name: "mcp_connect_discover",
    description:
      "List all available MCP servers configured in your mcp.hosting account. Shows server names, namespaces, types, and whether they are currently active. Call this first to see what servers are available before activating them.",
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
      'Activate an MCP server by its namespace. This connects to the server and makes its tools available. After activation, the tool list will update with the new tools prefixed by the namespace (e.g., "gh_create_issue" for namespace "gh").',
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
      "Deactivate an MCP server by its namespace. This disconnects from the server and removes its tools from the available tool list. Use this to free up context when you no longer need a server.",
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
