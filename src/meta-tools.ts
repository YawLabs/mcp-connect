export const META_TOOLS = {
  discover: {
    name: "mcp_connect_discover",
    description:
      'List all available MCP servers. Use this when you want to browse what\'s available or you have no specific task in mind yet. If you already know the task ("file a github issue", "query postgres", "post to slack"), prefer `mcp_connect_dispatch` instead — it discovers, ranks, and activates in one call. Only activate servers you need for the CURRENT task — each one adds tools to your context. Shows server names, namespaces, tool counts, activation status, and any local CLI the server shadows (prefer the MCP tools over the CLI when a shadow is listed). If a `mcph://guide` resource is listed, read it FIRST: it carries project/user-specific routing rules and credential conventions that override generic defaults.',
    inputSchema: {
      type: "object" as const,
      properties: {
        context: {
          type: "string",
          description:
            "Optional: describe the current task or conversation context. Servers will be sorted by relevance to help you pick the right one.",
        },
      },
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
      'Activate one or more MCP servers by namespace to load their tools. Each server adds tools to context, so only activate what you need right now. Good practice: deactivate servers you are done with before activating new ones. Tools are prefixed by namespace (e.g., "gh_create_issue"). Pass "server" for one or "servers" for multiple.',
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: 'Single server namespace to activate (e.g., "gh")',
        },
        servers: {
          type: "array",
          items: { type: "string" },
          description: 'Multiple server namespaces to activate at once (e.g., ["gh", "slack"])',
        },
      },
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
      'Deactivate one or more MCP servers to remove their tools and free context. Always deactivate servers you are finished with. Servers idle for 10+ tool calls to other servers are auto-deactivated. Pass "server" for one or "servers" for multiple.',
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: "The namespace of the server to deactivate",
        },
        servers: {
          type: "array",
          items: { type: "string" },
          description: 'Multiple server namespaces to deactivate at once (e.g., ["gh", "slack"])',
        },
      },
    },
    annotations: {
      title: "Deactivate MCP Server",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  import_config: {
    name: "mcp_connect_import",
    description:
      "Import MCP servers from an existing config file (Claude Desktop, Cursor, VS Code, etc.). Reads the file, parses the mcpServers section, and creates connect server entries in the cloud. Supported files: claude_desktop_config.json, mcp.json, settings.json.",
    inputSchema: {
      type: "object" as const,
      properties: {
        filepath: {
          type: "string",
          description: 'Path to the MCP config file (e.g., "~/.claude/claude_desktop_config.json", ".cursor/mcp.json")',
        },
      },
      required: ["filepath"],
    },
    annotations: {
      title: "Import MCP Config",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  health: {
    name: "mcp_connect_health",
    description:
      "Show health stats for all active MCP server connections: total calls, error count, average latency, and last error.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: {
      title: "Connection Health",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  dispatch: {
    name: "mcp_connect_dispatch",
    description:
      'PREFERRED entry point when you have a concrete task. Activates the best configured MCP server(s) for a natural-language task in ONE call — no separate discover+activate needed. Describe what you want to do ("create a github issue for the login bug", "post a summary to slack", "query the prod postgres") and mcph will rank all configured servers with BM25, activate the top match, and expose its tools so you can call them. Use `mcp_connect_discover` only when browsing what\'s available without a specific task. When a configured MCP server shadows a local CLI (e.g. npmjs shadows `npm`, tailscale shadows `tailscale`, github shadows `gh`), prefer dispatching to the server over running the CLI via Bash. Default budget is 1 to keep the tool list focused; raise it only if you genuinely need multiple servers for one task. If `mcph://guide` is listed as a resource, read it first — the project may have explicit routing rules (e.g. "use `gh` not bash for GitHub").',
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: {
          type: "string",
          description:
            'What you want to accomplish, in plain English (e.g., "file a github issue titled Fix login bug")',
        },
        budget: {
          type: "number",
          description:
            "How many top-ranked servers to activate. Defaults to 1. Cap is 10. Raise only when one task genuinely needs multiple servers.",
        },
      },
      required: ["intent"],
    },
    annotations: {
      title: "Dispatch to Best Server",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  suggest: {
    name: "mcp_connect_suggest",
    description:
      "Surface recurring multi-server tool-call patterns observed in this session as suggested 'packs' you could dispatch in one step. Observation-only — this never activates anything. When you see the same 2-3 servers used together in short bursts more than once, the pattern is surfaced here so a future workflow can call mcp_connect_dispatch with one intent instead of juggling discover+activate for each server. As a general rule: prefer active MCP servers over matching local CLIs (an activated `npmjs` server replaces `npm audit`, `tailscale` replaces the `tailscale` CLI, etc.) — see mcp_connect_discover for which CLIs each configured server shadows. Returns a friendly 'no patterns yet' message when nothing has recurred.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: {
      title: "Suggest Server Packs",
      readOnlyHint: true,
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
  META_TOOLS.import_config.name,
  META_TOOLS.health.name,
  META_TOOLS.dispatch.name,
  META_TOOLS.suggest.name,
]);
