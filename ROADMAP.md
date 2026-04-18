# mcph Roadmap

## Phase 1 — v0.1 (Complete)

- [x] Cloud-configured, locally-executed MCP orchestrator
- [x] discover / load / unload meta-tools
- [x] Local server spawning (stdio) + remote server connections (HTTP)
- [x] Namespace-based tool routing
- [x] tools/list_changed notifications on load/unload
- [x] 60s config polling with version hash comparison
- [x] Auto-unload servers idle for 10+ tool calls
- [x] Directive tool descriptions for context-aware LLM behavior
- [x] Graceful shutdown (SIGTERM/SIGINT)
- [x] Plan-based server limits (free: 3, paid: unlimited)

## Phase 2 — Smart Routing & Observability

- [x] **Context cost estimates in discover()** — Show token cost per server (e.g., "npm: 22 tools, ~2,800 tokens") so the LLM can reason about context budget
- [x] **Usage pattern hints** — Track which servers are frequently loaded together and surface suggestions in discover() ("based on your last 3 calls, you probably need github next")
- [x] **Suggested load** — Orchestrator infers what to load based on recent tool call patterns, LLM confirms. Two surfaces: (a) `mcp_connect_suggest` returns explicit recommendations with ready-to-run `activate` calls; (b) `mcp_connect_discover` inlines a "Recurring packs" block at the top of its output so the model can act without the extra round-trip
- [ ] **Automatic load** — Pre-load servers based on learned patterns without LLM confirmation (opt-in)
- [x] **Routing analytics upload** — Send tool call patterns, load/unload events, and error rates to mcp.hosting dashboard
- [x] **Error tracking in discover()** — Show server health in discover results ("npm: last 3 calls failed, might be down")
- [x] **Concurrent server cap** — Limit max loaded servers (default 6, `MCPH_SERVER_CAP` override) as both a business lever and context protection
- [x] **Resource proxying** — Proxy MCP resources from upstream servers, not just tools
- [x] **Prompt proxying** — Proxy MCP prompts from upstream servers
- [x] **Cross-session persistence** — Learning + pack history restored across mcph restarts from `~/.mcph/state.json`; opt-out via `MCPH_DISABLE_PERSISTENCE`
- [x] **Per-tool load** — Load specific tools from a server instead of all tools (category-based subsets). `mcp_connect_activate({ server, tools: [...] })` hides every unlisted tool from `tools/list`; hidden tools stay reachable via `mcp_connect_dispatch` (routes are unfiltered). Re-activate without `tools` to clear the filter; discover surfaces a `(filtered: K of N)` indicator.
- [x] **Signature-on-demand meta-tool** — A `mcp_connect_read_tool` that returns a single tool's schema + docs without loading its server. For servers with many tools where the model only needs 1–2, loads 1–2 schemas instead of the whole catalog. One step beyond per-tool load: no load event at all. (Pattern borrowed from Bifrost Code Mode's `list → read → execute` surface.)
- [ ] **Orchestration sandbox** — A `mcp_connect_exec` meta-tool that runs a short sandboxed script (Starlark or a narrow JS subset) making multiple upstream tool calls in one round-trip. Saves both prompt-token replay and response round-trips when the model wants to do `a = call_x(); b = call_y(a); return b`. Sandboxed: no imports, no network, no fs — only tool calls + basic control flow.
- [ ] **Marketplace integration** — Browse and one-click add servers from the mcp.hosting marketplace directly through discover()
- [ ] **Multi-device config sync** — Same token, same config, across all machines (already works implicitly, but needs marketing)

## Phase 3 — Platform Intelligence

- [ ] **Server recommendation engine** — "Users who use GitHub MCP also use Slack MCP" based on anonymized load patterns
- [ ] **Pre-built orchestrator configs** — Curated bundles ("The DevOps Stack: GitHub + AWS + PagerDuty", "The Marketing Stack: HubSpot + Slack + Analytics")
- [ ] **Compliance-aware routing** — Only load servers that pass a minimum compliance grade
- [ ] **Tool deduplication** — Detect overlapping tools across servers and surface the best one
- [ ] **Conversation-aware routing** — If mcph could receive conversation context (future MCP spec), route automatically based on what the user is talking about
