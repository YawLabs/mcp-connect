export const META_TOOLS = {
  discover: {
    name: "mcp_connect_discover",
    description:
      'List the MCP servers installed on the user\'s mcp.hosting account and ready to use. Call this when browsing what\'s available or when the task isn\'t specific yet. If the task is already clear ("file a github issue", "query postgres", "post to slack"), prefer `mcp_connect_dispatch` — it picks the right server and loads its tools in one call. Load only the servers the CURRENT task needs; each one adds tools to your context. Shows names, namespaces, tool counts, a token-cost estimate per server (e.g. "22 tools, ~2.8k tokens") so you can budget context before activating — tilde values are estimates based on cached tool metadata, unprefixed values reflect live tool schemas. Also surfaces whether each server is loaded, any local CLI it shadows (prefer the MCP tools over the CLI when a shadow is listed), and usage hints ("used Nx" or "often loaded with X") when the signals are present (counts persist across mcph restarts). Recurring packs that have been loaded together ≥2 times get their own block at the top with a ready-to-run `activate` call — skip the extra `mcp_connect_suggest` round-trip when the signal is already there. If a `mcph://guide` resource is listed, read it FIRST: it carries project/user-specific routing rules and credential conventions that override generic defaults.',
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
      'Load one or more installed MCP servers\' tools into the current session by namespace. Each server adds its tools to your context, so load only what the current task needs. When you move on, unload servers you\'re done with via `mcp_connect_deactivate` before loading new ones. Tools are prefixed by namespace (e.g., "gh_create_issue"). Pass "server" for one or "servers" for multiple. Optionally pass `tools: [...]` to expose only those tools by name — the rest stay proxyable via mcp_connect_dispatch. If `MCPH_MIN_COMPLIANCE` is set, activation refuses servers whose reported grade is below the floor (ungraded servers always pass); the refusal message names the grade and the env var to unset.',
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
        tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional per-server tool filter (bare tool names, not namespace-prefixed). When set, only the listed tools surface in tools/list — others stay reachable via mcp_connect_dispatch. Omit (or re-activate without it) to expose the full tool set. Only applied when activating a single server.",
        },
      },
    },
    annotations: {
      title: "Load MCP Server",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  deactivate: {
    name: "mcp_connect_deactivate",
    description:
      'Unload one or more MCP servers\' tools from the current session to free context. The server stays installed on the account and can be reloaded via `mcp_connect_activate` when needed again. Unload servers you\'re done with; mcph also auto-unloads any server idle for 10+ tool calls to other servers. Pass "server" for one or "servers" for multiple.',
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
      title: "Unload MCP Server",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  import_config: {
    name: "mcp_connect_import",
    description:
      "Install MCP servers on the user's mcp.hosting account by importing an existing client config (Claude Desktop, Cursor, VS Code, etc.). Reads the file, parses the mcpServers section, and creates matching entries on the account so they show up in `mcp_connect_discover`. Supported files: claude_desktop_config.json, mcp.json, settings.json. Env vars are NOT imported — set them in the dashboard.",
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
      "Show health stats for MCP servers loaded in the current session: total calls, error count, average latency, and last error. Installed-but-unloaded servers aren't included — load them first if you need their stats.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: {
      title: "Session Health",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  dispatch: {
    name: "mcp_connect_dispatch",
    description:
      'PREFERRED entry point when the task is already concrete. Picks the best-matching installed MCP server(s) for a natural-language task and loads their tools in ONE call — no separate discover + load step. Describe what you want to do ("create a github issue for the login bug", "post a summary to slack", "query the prod postgres") and mcph will rank the user\'s installed servers with BM25, load the top match into the session, and expose its tools so you can call them. Use `mcp_connect_discover` only when browsing what\'s installed without a specific task. When an installed MCP server shadows a local CLI (e.g. npmjs shadows `npm`, tailscale shadows `tailscale`, github shadows `gh`), prefer dispatching to the server over running the CLI via Bash. Default budget is 1 to keep the tool list focused; raise it only if the task genuinely spans multiple servers. If `mcph://guide` is listed as a resource, read it first — the project may have explicit routing rules (e.g. "use `gh` not bash for GitHub").',
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
            "How many top-ranked servers to load into the session. Defaults to 1. Cap is 10. Raise only when one task genuinely spans multiple servers.",
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
  install: {
    name: "mcp_connect_install",
    description:
      'Install a new MCP server on the user\'s mcp.hosting account so it shows up in `mcp_connect_discover` and is ready to use. Call this when the user asks to install/add a server they don\'t already have (check `mcp_connect_discover` first — if the namespace is already listed, the server is already installed; use `mcp_connect_activate` to load its tools into this session). Fill the install spec from your knowledge of the server: for most official Model Context Protocol servers this is `{ type: "local", command: "npx", args: ["-y", "@modelcontextprotocol/server-<name>"] }`; for uvx/python it\'s `{ command: "uvx", args: ["mcp-server-<name>"] }`; for remote HTTP it\'s `{ type: "remote", url: "https://..." }`. Namespace must match /^[a-z][a-z0-9_]{0,29}$/ and must not collide with one the user already has. If the server needs secrets (API tokens, etc.) pass them in `env` — they are stored encrypted and never logged. On 403 with `code: "plan_limit_exceeded"` the user is on the free tier cap (3 servers); surface the returned error body verbatim so they see the upgrade URL. After install mcph auto-refreshes its server list — the new namespace becomes callable without a restart.',
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: 'Human-readable server name shown in the dashboard (e.g., "GitHub", "Postgres").',
        },
        namespace: {
          type: "string",
          description:
            'Short lowercase slug used to prefix this server\'s tools (e.g., "gh" → tools become "gh_create_issue"). Must match /^[a-z][a-z0-9_]{0,29}$/.',
        },
        type: {
          type: "string",
          enum: ["local", "remote"],
          description:
            '"local" for stdio servers launched by command+args, "remote" for streamable HTTP/SSE servers reached by url.',
        },
        command: {
          type: "string",
          description:
            'Executable for local servers (e.g., "npx", "uvx", "node"). Required when type="local", omitted when type="remote".',
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: 'Args passed to `command` (e.g., ["-y", "@modelcontextprotocol/server-github"]). Max 50.',
        },
        env: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Environment variables the server needs (API tokens, connection strings). Stored encrypted on mcp.hosting. Max 50 keys.",
        },
        url: {
          type: "string",
          description: 'HTTPS URL of a remote MCP server. Required when type="remote", omitted when type="local".',
        },
        description: {
          type: "string",
          description:
            "Optional short description shown in the dashboard and used by the dispatch ranker. Max 500 chars.",
        },
      },
      required: ["name", "namespace", "type"],
    },
    annotations: {
      title: "Install MCP Server",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  read_tool: {
    name: "mcp_connect_read_tool",
    description:
      "Return one tool's full input schema without loading its server into the session. Use this when you need to inspect an MCP tool's arguments before deciding whether to activate its server, or to compare schemas across two tools. For already-loaded servers this is free (schema is in memory). For not-loaded servers mcph spawns a transient upstream connection, reads the schema, and tears the connection down — no tools are added to your context, and `mcp_connect_health` will not show the server as loaded. When you're ready to actually call the tool, pass the server namespace to `mcp_connect_activate` (or use `mcp_connect_dispatch` with the task intent).",
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description: 'Namespace of the server that exposes the tool (e.g., "gh", "slack").',
        },
        tool: {
          type: "string",
          description:
            'Tool name. The namespace prefix is optional — both "create_issue" and "gh_create_issue" are accepted.',
        },
      },
      required: ["server", "tool"],
    },
    annotations: {
      title: "Read Tool Schema",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  suggest: {
    name: "mcp_connect_suggest",
    description:
      "Surface recurring multi-server tool-call patterns as suggested 'packs' to activate in one step. Observation-only — this never loads or unloads anything. When the same 2-3 servers get used together in short bursts more than once, the pattern is surfaced here so the next workflow can call `mcp_connect_activate` once with the whole pack's namespaces instead of juggling discover + load for each server. Patterns persist across mcph restarts (via ~/.mcph/state.json) so a fresh process already knows what you usually use together. As a general rule: prefer loaded MCP servers over matching local CLIs (a loaded `npmjs` server replaces `npm audit`, `tailscale` replaces the `tailscale` CLI, etc.) — see `mcp_connect_discover` for which CLIs each installed server shadows. Returns a friendly 'no patterns yet' message when nothing has recurred.",
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
  bundles: {
    name: "mcp_connect_bundles",
    description:
      "List curated multi-server 'bundles' — presets like `pr-review` (github + linear) or `devops-incident` (github + pagerduty + slack) that commonly ship together. Use this BEFORE mcp_connect_discover when the user's intent maps to a known workflow (on-call triage, PR review, data pipeline debugging) — it returns a ready-to-run `mcp_connect_activate namespaces=[...]` call per bundle. With `action=\"match\"` (recommended after the user's installed list is known) the response partitions bundles into READY (every namespace already installed — activate now) and PARTIAL (some installed, some missing — shows the missing names and the mcp.hosting/explore install URL). With `action=\"list\"` (default) it returns the full curated catalog. Bundles are static client-side data, not a network call.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "match"],
          description:
            'Either "list" (return the full curated catalog; default) or "match" (partition bundles against installed servers into ready-to-activate vs partially-installed).',
        },
      },
    },
    annotations: {
      title: "Curated Server Bundles",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  exec: {
    name: "mcp_connect_exec",
    description:
      "Run a short DECLARATIVE pipeline of upstream tool calls in a single round-trip. Use this when you already know the exact 2-4 tool calls to make and one call's output feeds another's args — e.g. `a = gh_list_prs(); b = gh_get_pr(a[0].number); return b`. NOT a code sandbox: there is no expression language, no loops, no branching, no arithmetic. The only control flow is sequential step execution; the only data-flow primitive is `{\"$ref\": \"<stepId>[.path.to.value]\"}` which substitutes a prior step's output (or a nested field of it) into the next step's args. Paths support dot keys and `[N]` / `.N` array indexing. Each step's `tool` must be a namespaced, already-loaded tool name (the exec does not auto-activate — call `mcp_connect_activate` first). Max 16 steps per exec. If any step fails, the whole pipeline fails and returns `{ ok: false, failedStep, error, partial: { ...completed outputs } }`. On success returns `{ ok: true, result: <return-step output>, steps: { ...all outputs } }`. Prefer this over back-to-back tool calls when the chain is deterministic — it saves prompt-token replay and client round-trips.",
    inputSchema: {
      type: "object" as const,
      properties: {
        steps: {
          type: "array",
          description:
            'Ordered list of tool calls to run. Each step is `{ id?: string, tool: string, args?: object }`. `args` values may be `{"$ref": "<stepId>.path"}` to inject a prior step\'s output.',
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Optional binding name for this step's output. Later steps reference it via `$ref`. Defaults to the step's positional index as a string.",
              },
              tool: {
                type: "string",
                description:
                  'Namespaced tool name (e.g. "gh_list_prs"). Must be a tool currently loaded in the session. Meta-tools (mcp_connect_*) are not callable from exec.',
              },
              args: {
                type: "object",
                description:
                  'Arguments for the tool call. Any value (including deeply nested) may be `{"$ref": "<stepId>[.path]"}` to substitute a prior step\'s output at that position.',
                additionalProperties: true,
              },
            },
            required: ["tool"],
          },
        },
        return: {
          type: "string",
          description:
            "Optional: id of the step whose output should be surfaced as `result`. Defaults to the last step's id (or its positional index).",
        },
      },
      required: ["steps"],
    },
    annotations: {
      title: "Exec Pipeline",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
} as const;

// Namespaces must match this on both mcph's side and the backend so the
// local validation message matches what the server would return (saves
// a round trip and gives the model a clean retry target).
const NAMESPACE_RE = /^[a-z][a-z0-9_]{0,29}$/;

export interface InstallPayload {
  name: string;
  namespace: string;
  type: "local" | "remote";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  description?: string;
}

export type InstallPayloadResult = { ok: true; payload: InstallPayload } | { ok: false; message: string };

/**
 * Validate + normalize mcp_connect_install arguments into the exact JSON body
 * the mcp.hosting POST /api/connect/servers endpoint expects. Pure function —
 * no I/O, safe to call from tests. Mirrors the backend's rules so malformed
 * requests fail here with a clear message instead of eating a 400 round-trip.
 */
export function buildInstallPayload(args: Record<string, unknown>): InstallPayloadResult {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const namespace = typeof args.namespace === "string" ? args.namespace.trim() : "";
  const type = args.type === "local" || args.type === "remote" ? args.type : null;

  if (!name) return { ok: false, message: "`name` is required (human-readable server name)." };
  if (name.length > 100) return { ok: false, message: "`name` must be 100 characters or fewer." };
  if (!namespace) return { ok: false, message: "`namespace` is required." };
  if (!NAMESPACE_RE.test(namespace)) {
    return { ok: false, message: "`namespace` must match /^[a-z][a-z0-9_]{0,29}$/." };
  }
  if (!type) return { ok: false, message: '`type` must be "local" or "remote".' };

  const payload: InstallPayload = { name, namespace, type };

  if (type === "local") {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return { ok: false, message: '`command` is required when type="local".' };
    payload.command = command;

    if (args.args !== undefined) {
      if (!Array.isArray(args.args)) return { ok: false, message: "`args` must be an array of strings." };
      if (args.args.length > 50) return { ok: false, message: "Maximum 50 args." };
      if (!args.args.every((a) => typeof a === "string")) {
        return { ok: false, message: "`args` must contain only strings." };
      }
      payload.args = args.args as string[];
    }
  }

  if (type === "remote") {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) return { ok: false, message: '`url` is required when type="remote".' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, message: "`url` must be a valid URL." };
    }
    // Remote MCP servers carry bearer tokens / session cookies. A
    // plaintext http:// URL leaks those on any untrusted network hop,
    // so require https:// — with the single exception of loopback,
    // so `mcph install` can wire up a dev server on localhost.
    if (parsed.protocol === "https:") {
      // ok
    } else if (parsed.protocol === "http:") {
      const host = parsed.hostname;
      const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
      if (!isLoopback) {
        return { ok: false, message: "`url` must use https:// (http:// is only allowed for localhost)." };
      }
    } else {
      return { ok: false, message: "`url` must use the https:// scheme." };
    }
    payload.url = url;
  }

  if (args.env !== undefined) {
    if (typeof args.env !== "object" || args.env === null || Array.isArray(args.env)) {
      return { ok: false, message: "`env` must be an object of string values." };
    }
    const entries = Object.entries(args.env as Record<string, unknown>);
    if (entries.length > 50) return { ok: false, message: "Maximum 50 env vars." };
    if (!entries.every(([, v]) => typeof v === "string")) {
      return { ok: false, message: "`env` values must all be strings." };
    }
    payload.env = args.env as Record<string, string>;
  }

  if (args.description !== undefined) {
    if (typeof args.description !== "string") return { ok: false, message: "`description` must be a string." };
    if (args.description.length > 500) return { ok: false, message: "`description` must be 500 characters or fewer." };
    payload.description = args.description.trim() || undefined;
  }

  return { ok: true, payload };
}

export const META_TOOL_NAMES = new Set([
  META_TOOLS.discover.name,
  META_TOOLS.activate.name,
  META_TOOLS.deactivate.name,
  META_TOOLS.import_config.name,
  META_TOOLS.health.name,
  META_TOOLS.dispatch.name,
  META_TOOLS.install.name,
  META_TOOLS.read_tool.name,
  META_TOOLS.suggest.name,
  META_TOOLS.exec.name,
  META_TOOLS.bundles.name,
]);
