// Single source of truth for the `${secret:NAME}` reference shape AND for the
// scan over it is secrets-vault's collectSecretRefNames. This file used to keep
// a byte-identical private copy of that loop, re-deriving the fresh-RegExp rule
// the module-shared /g object demands; importing the real scanner means a
// change to the reference syntax can't leave the values-free secrets report
// matching the old shape. (secrets-vault does touch the filesystem elsewhere in
// the module, but nothing runs at import time -- computeSecretsReport below
// stays pure.)
import { MAX_EXEC_STEPS } from "./exec-engine.js";
import { PENALTY_RATE_THRESHOLD } from "./learning.js";
import { collectMalformedSecretRefs, collectSecretRefNames } from "./secrets-vault.js";

// Numbers the descriptions below quote to the model, interpolated from the
// constants that actually enforce them rather than retyped. learning.ts
// promises that moving PENALTY_RATE_THRESHOLD moves every surface that
// renders it, and exec's step cap is enforced by validateExecRequest --
// a hardcoded "<80%" or "Max 16 steps" is a lie the moment either moves.
const PENALTY_RATE_PCT = Math.round(PENALTY_RATE_THRESHOLD * 100);

export const META_TOOLS = {
  discover: {
    name: "mcp_connect_discover",
    description:
      'List the MCP servers configured in the user\'s local ~/.yaw-mcp/bundles.json and ready to use. Call this when browsing what\'s available or when the task isn\'t specific yet. If the task is already clear ("file a github issue", "query postgres", "post to slack"), prefer `mcp_connect_dispatch` — it picks the right server and loads its tools in one call. Load only the servers the CURRENT task needs; each one adds tools to your context. Shows names, namespaces, tool counts, a token-cost estimate per server (e.g. "22 tools, ~2.8k tokens") so you can budget context before activating — tilde values are estimates based on cached tool metadata, unprefixed values reflect live tool schemas. Scored servers carry an inline `[A]`–`[F]` compliance grade from the Yaw MCP test suite — treat it as a trust signal and prefer higher-graded alternatives when otherwise equivalent (ungraded servers are unmarked, not penalized). Also surfaces whether each server is loaded, any local CLI it shadows (prefer the MCP tools over the CLI when a shadow is listed), and usage hints ("used Nx" or "often loaded with X") when the signals are present (counts persist across yaw-mcp restarts). Recurring packs that have been loaded together ≥2 times get their own block at the top with a ready-to-run `activate` call — skip the extra `mcp_connect_suggest` round-trip when the signal is already there. If a `yaw-mcp://guide` resource is listed, read it FIRST: it carries project/user-specific routing rules and credential conventions that override generic defaults.',
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
      'Load one or more installed MCP servers\' tools into the current session by namespace. Each server adds its tools to your context, so load only what the current task needs. When you move on, unload servers you\'re done with via `mcp_connect_deactivate` before loading new ones. Tools are prefixed by namespace (e.g., "gh_create_issue"). Pass "server" for one or "servers" for multiple. Optionally pass `tools: [...]` to expose only those tools by name — the rest stay proxyable via mcp_connect_dispatch. If `YAW_MCP_MIN_COMPLIANCE` is set, activation refuses servers whose reported grade is below the floor (ungraded servers always pass); the refusal message names the grade and the env var to unset.',
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
      'Unload one or more MCP servers\' tools from the current session to free context. The server stays configured in ~/.yaw-mcp/bundles.json and can be reloaded via `mcp_connect_activate` when needed again. Unload servers you\'re done with; yaw-mcp also auto-unloads a server after a stretch of tool calls to other servers (baseline set by YAW_MCP_IDLE_THRESHOLD, raised for a server used in bursts). Pass "server" for one or "servers" for multiple.',
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
  health: {
    name: "mcp_connect_health",
    description: `Show health stats for MCP servers loaded in the current session: total calls, error count, average latency, and last error. Per-call telemetry covers LOADED servers only; installed-but-unloaded servers with a poor persisted success rate (<${PENALTY_RATE_PCT}% across sessions) are listed in a separate cross-session reliability block — do NOT load a server just to see its history, loading it resets the in-session counters to zero.`,
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
      'PREFERRED entry point when the task is already concrete. Picks the best-matching installed MCP server(s) for a natural-language task and loads their tools in ONE call — no separate discover + load step. Describe what you want to do ("create a github issue for the login bug", "post a summary to slack", "query the prod postgres") and yaw-mcp will rank the user\'s installed servers with BM25, load the top match into the session, and expose its tools so you can call them. Use `mcp_connect_discover` only when browsing what\'s installed without a specific task. When an installed MCP server shadows a local CLI (e.g. npmjs shadows `npm`, tailscale shadows `tailscale`, github shadows `gh`), prefer dispatching to the server over running the CLI via Bash. Default budget is 1 to keep the tool list focused; raise it only if the task genuinely spans multiple servers. If `yaw-mcp://guide` is listed as a resource, read it first — the project may have explicit routing rules (e.g. "use `gh` not bash for GitHub").',
    inputSchema: {
      type: "object" as const,
      properties: {
        intent: {
          type: "string",
          description:
            'What you want to accomplish, in plain English (e.g., "file a github issue titled Fix login bug")',
        },
        budget: {
          // integer with bounds, matching the server-side clamp
          // (handleDispatch floors into [1,10]). Advisory only -- the
          // low-level Server never validates input against this schema --
          // but it steers well-behaved clients away from the fractional /
          // sub-1 band the clamp exists to absorb.
          type: "integer",
          minimum: 1,
          maximum: 10,
          default: 1,
          description:
            "How many top-ranked servers to load into the session. Defaults to 1. Cap is 10. Raise only when one task genuinely spans multiple servers.",
        },
        routeEffort: {
          type: "string",
          enum: ["off", "auto", "aggressive"],
          description:
            'Per-call override of the routing-effort dial. "off" never asks the client LLM to break ranking ties; "auto" (the default) asks once only on genuine ambiguity; "aggressive" samples best-of-3 on milder ambiguity. Falls back to the YAW_MCP_ROUTE_EFFORT env var when omitted. Only meaningful at budget 1.',
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
  read_tool: {
    name: "mcp_connect_read_tool",
    description:
      "Return one tool's full input schema without loading its server into the session. Use this when you need to inspect an MCP tool's arguments before deciding whether to activate its server, or to compare schemas across two tools. For already-loaded servers this is free (schema is in memory). For not-loaded servers yaw-mcp spawns a transient upstream connection, reads the schema, and tears the connection down — no tools are added to your context, and `mcp_connect_health` will not show the server as loaded. When you're ready to actually call the tool, pass the server namespace to `mcp_connect_activate` (or use `mcp_connect_dispatch` with the task intent).",
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
      "Surface recurring multi-server tool-call patterns as suggested 'packs' to activate in one step. Observation-only — this never loads or unloads anything. When the same 2-3 servers get used together in short bursts more than once, the pattern is surfaced here so the next workflow can call `mcp_connect_activate` once with the whole pack's namespaces instead of juggling discover + load for each server. Patterns persist across yaw-mcp restarts (via ~/.yaw-mcp/state.json) so a fresh process already knows what you usually use together. As a general rule: prefer loaded MCP servers over matching local CLIs (a loaded `npmjs` server replaces `npm audit`, `tailscale` replaces the `tailscale` CLI, etc.) — see `mcp_connect_discover` for which CLIs each installed server shadows. Returns a friendly 'no patterns yet' message when nothing has recurred.",
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
      'List curated multi-server \'bundles\' — presets like `pr-review` (github + linear) or `devops-incident` (github + pagerduty + slack) that commonly ship together. Routing order is `mcp_connect_dispatch` > this > `mcp_connect_discover`: when the task is one concrete action ("file a github issue"), dispatch still comes first. Reach for bundles when the intent maps to a known multi-server WORKFLOW (on-call triage, PR review, data pipeline debugging) rather than a single call, and before `mcp_connect_discover` — it returns a ready-to-run `mcp_connect_activate namespaces=[...]` call per bundle. With `action="match"` (recommended after the user\'s installed list is known) the response partitions bundles into READY (every namespace already in the user\'s bundles.json — activate now) and PARTIAL (some present, some missing — names the missing namespaces so you can tell the user to run `yaw-mcp add <slug>`; the slug catalog is at https://yaw.sh/mcp/catalog/). With `action="list"` (default) it returns the full curated catalog. Bundles are static client-side data, not a network call.',
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
  secrets: {
    name: "mcp_connect_secrets",
    description:
      "List, per installed server, which local-vault secrets its `${secret:NAME}` env references resolve to — by NAME only, never a value. Use this to confirm a server will get the credentials it needs before activating it, or to spot a typo'd / un-set secret reference. `injectedSecrets` are the names the local vault HAS and the server references; `missing` are names the server references but the vault LACKS (set them via `yaw-mcp secrets set <name>`); `malformed` are `${secret:` references that do not PARSE (a space in the name, a missing `}`), quoted in bounded form behind a `<malformed ref>` marker -- yaw-mcp refuses to start the server over one exactly as over a missing name, so the fix is editing the reference in the server's env. This is a values-free preview: it reads the vault's KEY LIST and the server's env-reference NAMES, and never decrypts or returns any secret value. Servers with no `${secret:...}` references (well-formed or malformed) are omitted. Requires no passphrase (no decryption happens).",
    inputSchema: {
      type: "object" as const,
      properties: {
        server: {
          type: "string",
          description:
            'Optional: restrict the report to a single server namespace (e.g. "gh"). Omit to report every installed server that references a vault secret.',
        },
      },
    },
    annotations: {
      title: "Inspect Vault Secret Resolution",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  exec: {
    name: "mcp_connect_exec",
    // Joined rather than one literal so the step cap can be interpolated from
    // MAX_EXEC_STEPS -- the constant validateExecRequest actually enforces.
    description: [
      "Run a short DECLARATIVE pipeline of upstream tool calls in a single round-trip. Use this when you already know the exact 2-4 tool calls to make and one call's output feeds another's args — e.g. `a = gh_list_prs(); b = gh_get_pr(a[0].number); return b`. NOT a code sandbox: there is no expression language, no loops, no branching, no arithmetic. The only control flow is sequential step execution; the only data-flow primitive is `{\"$ref\": \"<stepId>[.path.to.value]\"}` which substitutes a prior step's output (or a nested field of it) into the next step's args. Paths support dot keys and `[N]` / `.N` array indexing. Each step's `tool` is a namespaced upstream tool name: an already-loaded server is called directly, and a not-yet-loaded server whose tools are known from cache is loaded on first use exactly as a direct tools/call would be — that adds its tools to this session, and can still be refused (server cap, compliance floor). A name that is neither loaded nor cached fails the step.",
      `Max ${MAX_EXEC_STEPS} steps per exec.`,
      "If any step fails, the whole pipeline fails and returns `{ ok: false, failedStep, error, partial: { ...completed outputs } }`. On success the shape depends on whether you named a `return`: WITH one you get `{ ok: true, result: <that step's output>, stepKeys: [...] }` — only the output you asked for, plus the names of every step that ran; WITHOUT one you get `{ ok: true, result: <last step's output>, steps: { ...all outputs } }`. Name a `return` whenever you only need one value: it is what stops the intermediate outputs (a long list you only wanted one element of) from being replayed back into your context. Prefer this over back-to-back tool calls when the chain is deterministic — it saves prompt-token replay and client round-trips.",
    ].join(" "),
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
                  'Namespaced tool name (e.g. "gh_list_prs"). Loaded servers are called directly; a not-yet-loaded server whose tools are known from cache is loaded on first use, adding its tools to the session. A name that is neither loaded nor cached fails the step. Meta-tools (mcp_connect_*) are not callable from exec.',
              },
              args: {
                type: "object",
                description:
                  'Arguments for the tool call. Any value (including deeply nested) may be `{"$ref": "<stepId>[.path]"}` to substitute a prior step\'s output at that position.',
                additionalProperties: true,
              },
            },
            required: ["tool"],
            // A misspelled `arguments` / `arg` / `input` key would otherwise
            // read as a legal extension and the step would dispatch with no
            // arguments at all. validateExecRequest rejects the same shape at
            // runtime (the low-level Server never validates against this
            // schema); declaring it here is what steers a schema-aware client
            // away from sending it in the first place.
            additionalProperties: false,
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

export interface SecretsReportRow {
  server: string;
  /** Names the vault HAS and this server references (sorted). */
  injectedSecrets: string[];
  /** Names this server references but the vault LACKS (sorted). */
  missing: string[];
  /** `${secret:` references in this server's env that do not PARSE, in
   *  secrets-vault's bounded `display` form (`<malformed ref> ${secret:gh
   *  token}`; sorted). Never a raw env value: the span is control-stripped
   *  and capped before it gets here (see MalformedSecretRef). A server with
   *  only malformed refs still gets a row -- it is exactly the one whose
   *  spawn is being refused with nothing else to explain why. */
  malformed: string[];
}

/**
 * Pure, values-free computation backing the `mcp_connect_secrets`
 * meta-tool. Given each server's namespace + env map and the SET of secret
 * names the vault holds, returns one row per server that references at
 * least one `${secret:...}`, well-formed or not:
 *   - injectedSecrets = referenced names ∩ vaultKeys
 *   - missing         = referenced names \ vaultKeys
 *   - malformed       = references the strict regex cannot parse
 * Never decrypts; takes only NAMES in and emits only NAMES (plus bounded
 * malformed spans) out. Servers with no references at all are omitted.
 */
export function computeSecretsReport(
  servers: Array<{ namespace: string; env?: Record<string, string> }>,
  vaultKeys: Set<string>,
): SecretsReportRow[] {
  const rows: SecretsReportRow[] = [];
  for (const server of servers) {
    // The shared scanner, not a local matchAll over SECRET_REF_RE: that object
    // carries /g and is module-shared with secrets-vault's own callers, and
    // matchAll does NOT start from zero -- it seeds its internal clone from the
    // source regex's lastIndex, so a stale offset left behind by an
    // `.exec()`/`.test()` elsewhere would make the scan silently skip leading
    // matches, and a skipped `${secret:NAME}` drops a row from the report,
    // which reads as "this server needs no secrets". collectSecretRefNames owns
    // the fresh-instance rule for every name-only caller (upstream.ts's spawn
    // audit and doctor's vault section are the others).
    const referenced = collectSecretRefNames(server.env);
    // The strict scanner above cannot see a reference a typo has put outside
    // SECRET_REF_RE, while resolveServerEnv refuses the spawn over it. Without
    // this column the report said "gh: injected" about a server that will not
    // start, and said nothing at all about one whose only ref is the typo.
    const malformed = collectMalformedSecretRefs(server.env);
    if (referenced.size === 0 && malformed.length === 0) continue;
    const injectedSecrets: string[] = [];
    const missing: string[] = [];
    for (const name of referenced) {
      if (vaultKeys.has(name)) injectedSecrets.push(name);
      else missing.push(name);
    }
    rows.push({
      server: server.namespace,
      injectedSecrets: injectedSecrets.sort(),
      missing: missing.sort(),
      malformed: malformed.sort(),
    });
  }
  return rows;
}

/** Every meta-tool name, DERIVED from META_TOOLS rather than re-listed.
 *
 *  The sole consumer (server.ts) uses this to enforce the contract advertised
 *  on mcp_connect_exec: meta-tools are not callable from inside an exec
 *  pipeline. A hand-maintained copy made that a security-shaped invariant
 *  guarded by a list someone has to remember to update -- add an 11th
 *  meta-tool, forget the entry, and that tool becomes exec-callable (a step
 *  could deactivate a server a later step needs, or recurse exec into
 *  itself) with nothing to catch it. Deriving removes the drift surface. */
export const META_TOOL_NAMES = new Set(Object.values(META_TOOLS).map((m) => m.name));
