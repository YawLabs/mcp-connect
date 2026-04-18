# @yawlabs/mcph

One install. All your MCP servers. Managed from the cloud.

mcph is an MCP server that orchestrates all your other MCP servers. Configure your servers once on [mcp.hosting](https://mcp.hosting), install mcph in your client, and never hand-edit MCP JSON configs again.

## How it works

```
Your MCP client (Claude Code, Cursor, etc.)
    |
    |  single stdio connection
    v
@yawlabs/mcph
    |         |         |
    v         v         v
  GitHub    Slack    Stripe     ← your MCP servers (local or remote)
```

1. You add servers on [mcp.hosting](https://mcp.hosting) (name, command, args, env vars)
2. mcph pulls your config on startup
3. You use a handful of meta-tools to control which servers' tools are loaded in the current session:
   - **`mcp_connect_dispatch`** — describe a task in plain English; mcph picks the right server, loads its tools, and exposes them. The fast path when you know what you want.
   - **`mcp_connect_discover`** — list all installed servers, optionally ranked by relevance to a context string. Auto-loads the top match when one server clearly wins.
   - **`mcp_connect_activate`** — load specific servers' tools by namespace.
   - **`mcp_connect_deactivate`** — unload a server and remove its tools from context.
   - **`mcp_connect_install`** — install a new MCP server on your mcp.hosting account.
   - **`mcp_connect_import`** — bulk-import servers from an existing client config (`claude_desktop_config.json`, `mcp.json`, etc.).
   - **`mcp_connect_health`** — show call counts, error rates, and latency per loaded server.
   - **`mcp_connect_suggest`** — surface recurring multi-server workflows mcph has learned from persisted pack history. When you repeatedly use `gh` → `linear` → `slack` for the same kind of task, `suggest` lists the pattern with a ready-to-run `activate` call so you can load the whole pack at once.
   - **`mcp_connect_read_tool`** — return a single tool's schema + docs without activating its server. Reads 1–2 schemas instead of loading a whole catalog when the model only needs a couple of tools from a big server.
   - **`mcp_connect_exec`** — run a short declarative pipeline of tool calls in one round-trip. Steps name namespaced tools + args; `{"$ref": "<stepId>[.path]"}` markers splice prior outputs into later inputs. No eval — only dot/bracket path resolution. Capped at 16 steps.
   - **`mcp_connect_bundles`** — list curated multi-server presets (DevOps incident, PR review, growth stack, data ops, etc.) and/or match them against your current config. Pair it with `mcp_connect_activate` to load a whole bundle at once.

Installing a server puts it on your account; loading it brings its tools into the current session's context. mcph loads servers lazily so your context window stays clean.

Ranking is two-stage when the backend has a Voyage embeddings key configured: a local BM25 pass narrows to a shortlist, then a `/api/connect/rerank` call semantically reorders. With no key on the backend it gracefully degrades to BM25-only — `dispatch` and `discover(context)` keep working, just with slightly weaker ranking on ambiguous queries.

On top of the ranker, mcph applies three client-side signals to dispatch scores:

- **Health-aware**: servers that have recently failed to load or have high error rates get down-ranked. Never boosts above raw — "all else equal, prefer the one that works".
- **Learning**: servers that have succeeded before get a small (+10% max) nudge, so the router remembers what's been useful. Success counts persist across restarts via `~/.mcph/state.json` (opt out with `MCPH_DISABLE_PERSISTENCE=1`).
- **Sampling tiebreak**: when the top two candidates are within 10% of each other and your client supports [MCP sampling](https://modelcontextprotocol.io/specification/server/sampling), mcph asks your client's LLM to pick. Uses the model you're already running — no extra provider key, no extra cost to mcph.

## Install

### One command (recommended)

```bash
npx -y @yawlabs/mcph install <claude-code|claude-desktop|cursor|vscode> --token mcp_pat_your_token_here
```

This:

1. Edits the chosen client's config file (correct path for your OS, correct JSON shape) to launch mcph.
2. Writes your token to `~/.mcph/config.json` so every other client you install picks it up automatically — no need to copy the token into each client's `env` block.
3. On Windows, wraps `npx` in `cmd /c` (without this, MCP clients hit `ENOENT` on the `npx.cmd` shim).

Run it once per client. To rotate the token later, run `install` again with `--token` — both files get rewritten.

Helpful flags:

- `--scope user|project|local` — which file to write (Claude Code + Cursor support project/local; VS Code is workspace-only; Claude Desktop is user-only).
- `--dry-run` — print the diff and exit without writing.
- `--force` / `--skip` — overwrite or leave an existing `mcp.hosting` entry. Without either, mcph prompts (TTY) or refuses (non-TTY).
- `--no-mcph-config` — write only the client config; leave `~/.mcph/config.json` untouched.

Or install into every detected client at once:

```bash
mcph install --list                       # read-only: detect clients + show install state per scope
mcph install --all --token mcp_pat_…     # one-shot: install into every user-scope client on this machine
```

`--list` never writes (no token needed). `--all` installs into every client whose user-scope target is resolvable on this OS — Claude Desktop is skipped on Linux, VS Code is skipped unless `--project-dir` is given (it's workspace-only). Aggregate exit code is non-zero if any sub-install fails.

Or [edit the JSON by hand](#manual-install) if you'd rather.

### Diagnose problems — `mcph doctor`

```bash
npx -y @yawlabs/mcph doctor          # human-readable report
npx -y @yawlabs/mcph doctor --json   # machine-readable snapshot for pipelines
```

Prints the loaded config files, your token's source + fingerprint (last 4 chars), the API base URL, installed clients, env overrides, persisted learning state, flaky-namespace reliability rollup, shell-history "shadow" hits (CLIs you run that an MCP server could replace), and an upgrade check against the npm registry. Exits `0` healthy / `1` no token / `2` warnings (e.g. world-readable token file). Paste the text output into a support ticket; the `--json` blob is the same data as a structured snapshot, so dashboards and CI scripts can `jq` instead of parsing the text layout.

### Other CLI subcommands

```bash
mcph servers [<namespace-filter>] [--json]    # list servers; optional substring filter on namespace
mcph bundles [list|match] [--json]    # browse curated multi-server bundles (PR review, DevOps incident, etc.)
mcph reset-learning                   # clear cross-session learning history (~/.mcph/state.json)
mcph completion <bash|zsh|fish|powershell>   # print shell completion script
mcph compliance <target> [--publish]  # run the compliance suite against an MCP server
mcph --version                        # print version
```

Every CLI that reads state has a `--json` mode for pipeline use. `mcph servers` hits the backend; `mcph bundles list` and `mcph completion` are fully static (no network, no token). `mcph bundles match` partitions the curated set against your enabled servers so you see the same ready-to-activate vs. partially-installed view the LLM-facing `mcp_connect_bundles` meta-tool produces.

To wire up shell completion:

```bash
# bash
mcph completion bash > ~/.local/share/bash-completion/completions/mcph

# zsh (must be on $fpath, then rebuild compinit)
mcph completion zsh > "${fpath[1]}/_mcph"

# fish
mcph completion fish > ~/.config/fish/completions/mcph.fish

# powershell
mcph completion powershell >> $PROFILE
```

### Getting your token

1. Sign up at [mcp.hosting](https://mcp.hosting)
2. Go to **Settings > API Tokens**
3. Create a token — it starts with `mcp_pat_`
4. Pass it to `mcph install` as shown above

### Manual install

If you'd rather edit the config files yourself, the JSON shapes are:

**Claude Code, Cursor, Claude Desktop** — top-level key `mcpServers`:

```json
{
  "mcpServers": {
    "mcp.hosting": {
      "command": "npx",
      "args": ["-y", "@yawlabs/mcph"]
    }
  }
}
```

**VS Code** — top-level key `servers` (NOT `mcpServers`) in `.vscode/mcp.json`:

```json
{
  "servers": {
    "mcp.hosting": {
      "command": "npx",
      "args": ["-y", "@yawlabs/mcph"]
    }
  }
}
```

**Windows** — `command: "cmd", args: ["/c", "npx", "-y", "@yawlabs/mcph"]` (the `cmd /c` wrapper is required because `npx.cmd` is a shim).

Then put your token in `~/.mcph/config.json` so mcph picks it up at startup:

```json
{
  "version": 1,
  "token": "mcp_pat_your_token_here"
}
```

Or set `MCPH_TOKEN` in the client's `env` block — both work.

## Adding servers

On [mcp.hosting](https://mcp.hosting), add each MCP server you want to orchestrate:

| Field | Description |
|-------|-------------|
| **Name** | Display name (e.g., "GitHub") |
| **Namespace** | Short prefix for tool names (e.g., "gh") |
| **Type** | `local` (stdio) or `remote` (HTTP) |
| **Command** | For local: the command to run (e.g., "npx") |
| **Args** | For local: command arguments (e.g., ["-y", "@modelcontextprotocol/server-github"]) |
| **Env** | Environment variables (API keys, tokens) |
| **URL** | For remote: the server URL |

## Usage

### Fast path — `dispatch`

When you know what you want to do, skip the discover/load dance:

```
> Create a GitHub issue for the login bug

[mcp_connect_dispatch is called with intent="create a GitHub issue for the login bug"]

Dispatched "create a GitHub issue for the login bug" — loaded top 1 of 1 matching server.
gh (score 4.32): Loaded "gh" — 24 tools: gh_create_issue, gh_list_prs, ...

[gh_create_issue is then called, returns the new issue]
```

`dispatch` ranks every installed server, loads the top match's tools, and immediately exposes them so the LLM can call them. Default budget is 1 (one server). For tasks that need multiple servers, pass `budget: 3` etc.

### Manual control

```
> What MCP servers do I have?

Installed MCP servers:

  gh — GitHub [ready] (local)
  slack — Slack [ready] (local)
  stripe — Stripe [ready] (local)

0 loaded in this session, 0 tools in context.
```

```
> Load my GitHub server

Loaded "gh" — 24 tools: gh_create_issue, gh_list_prs, ...
```

You can load multiple at once: `> Load GitHub and Slack`. Tools are namespaced as `{namespace}_{original_tool_name}` to prevent collisions. The tool list updates automatically via `tools/list_changed`.

```
> Unload GitHub when you're done

Unloaded "gh". Tools removed from context.
```

Servers also auto-unload after ~10 tool calls to other servers, so context stays clean even if you forget. The threshold is adaptive per-namespace: a server that's been called in bursts recently gets more patience (up to +20) before it's unloaded, so heavily-used servers don't get torn down mid-task. Long-idle servers still unload at the baseline.

## `.mcph/` config directory

mcph stores its config under a `.mcph/` directory — mirroring the `.git/`, `.vscode/`, `.claude/` convention so everything related to mcph (config, project guide, future additions) lives under one predictable folder you can grep, gitignore, or blow away atomically. mcph reads `config.json` from three optional locations (highest precedence first):

| Scope | Path | Holds |
|-------|------|-------|
| **local** | `<project>/.mcph/config.local.json` | Machine-local override; `gitignore` it. Token allowed. |
| **project** | `<project>/.mcph/config.json` | Shared with the team via git. Token NOT allowed (warned). |
| **global** | `~/.mcph/config.json` | Personal default for every project. Token allowed. |

The project `.mcph/` is found by walking UP from the current directory until a `.mcph/` is found, stopping just before `$HOME` (exclusive) so a `.mcph/` sitting at `$HOME` is treated as user-global only and never double-loaded as project.

Full schema:

```jsonc
{
  // Schema version. mcph >= 0.11 emits version 1; older fields stay
  // readable. Newer versions log a warning so an old mcph can't silently
  // miss new fields.
  "version": 1,

  // Personal access token from mcp.hosting → Settings → API Tokens.
  // env MCPH_TOKEN still wins over the file value.
  "token": "mcp_pat_your_token_here",

  // API base override — point mcph at a self-hosted backend or staging.
  // Defaults to https://mcp.hosting. env MCPH_URL still wins.
  "apiBase": "https://mcp.hosting",

  // Project profile: which namespaces are allowed.
  "servers": ["gh", "pg", "linear"],

  // Project profile: namespaces denied even if in `servers`.
  "blocked": ["prod-db"]
}
```

**Comments are allowed** (line `//` and block `/* … */`) — handy for documenting a shared `config.json` checked into git.

**Resolution:**

- **Token** — `MCPH_TOKEN` env > local > global. (`token` in the project file is ignored and warned: it'd get committed to git.)
- **apiBase** — `MCPH_URL` env > local > project > global > `https://mcp.hosting`.
- **servers** allow-list — local wins if set, else project, else global (most-specific scope overrides).
- **blocked** deny-list — UNION across every scope that sets it (fail-safe on deny).
- Malformed files log a warning and fall through — fail-open so a typo doesn't brick the session.
- On POSIX, mcph warns if the file contains a token and is readable by group/other; run `chmod 600 ~/.mcph/config.json` to silence it.

**Token rotation**: mcph reads its config at startup. After editing `~/.mcph/config.json`, restart the MCP client (or kill mcph; the client respawns it).

`mcp_connect_health` shows which file(s) are currently applied.

## Project guide — `MCPH.md`

Drop a `MCPH.md` next to `config.json` inside either `.mcph/` and mcph surfaces its contents to your client via an `mcph://guide` MCP resource. The meta-tool descriptions (`discover`, `dispatch`) tell the model to read this resource first, so project-specific routing conventions ("use the `gh` server for GitHub, not bash") and credential guidance ("keys go in the dashboard, not `.mcp.json`") stick without the user restating them every session.

| Scope | Path | Purpose |
|-------|------|---------|
| **user** | `~/.mcph/MCPH.md` | Personal defaults that apply everywhere (your preferred tools, credential conventions). |
| **project** | `<project>/.mcph/MCPH.md` | Project-specific guidance shared via git (which servers are load-bearing, project idioms). |

When both exist, the project guide is appended after the user guide with a `---` separator so project-specific rules get the final word in the reader's attention. A missing or empty file is silently skipped — if neither file exists, the `mcph://guide` resource isn't listed at all.

## Elicitation for missing credentials

When a server fails to start with stderr like `GITHUB_TOKEN is required` and your client advertises the MCP [elicitation](https://modelcontextprotocol.io/specification/server/elicitation) capability, mcph prompts you for the missing value inline and retries the load. Values stay in-memory for the current mcph session only — persist them in the mcp.hosting dashboard if you want them across restarts.

### Test from the dashboard

The `/dashboard/connect` page in mcp.hosting has a **Test** button per server that loads it through your running mcph and shows pass/fail inline — no LLM round-trip needed. Useful when you've just added a server and want to confirm the token works without prompting your AI.

### Errors come with deep-links

When a load fails (missing token, runtime not on PATH, server crashes on init), mcph emits a message ending with `→ Edit at https://mcp.hosting/dashboard/connect#server-<id>`. Most LLMs render that as a clickable link, and the dashboard scrolls to and highlights the matching card so you find the right server in one click.

## Config sync

mcph polls [mcp.hosting](https://mcp.hosting) every 60 seconds for config changes. When you add, remove, or modify a server on the dashboard, mcph picks it up automatically — no restart needed.

### Multi-device sync

Because every mcph install reads the same account's server list, the same token gives you the same servers across every machine. Install mcph on a second laptop with the same `mcp_pat_...`, and within 60 seconds it sees the same GitHub/Slack/Stripe/etc. servers you configured from the first. Tokens, environment variables, and credentials stay in the dashboard — you don't have to sync a JSON file across machines, copy secrets into a dotfile repo, or re-paste an API key per device.

Rotate a credential in one place (the dashboard), every machine picks up the new value on the next poll. Revoke a token in Settings → API Tokens, every install stops working immediately (the token is the only thing authenticating the config pull). This is why `~/.mcph/config.json` holds a token, not a server list — the server list is the cloud's concern.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCPH_TOKEN` | Yes (or in `~/.mcph/config.json`) | Personal access token from mcp.hosting. Env wins over `~/.mcph/config.json`. |
| `MCPH_URL` | No | API URL (default: `https://mcp.hosting`). Env wins over `apiBase` in `config.json`. |
| `LOG_LEVEL` | No | Log verbosity: `debug`, `info`, `warn`, `error` (default: `info`) |
| `MCPH_POLL_INTERVAL` | No | Config-poll interval in seconds. `0` disables polling (config fetched once at startup). Default: `60` |
| `MCPH_AUTO_ACTIVATE` | No | When `discover` is called with a context string and one server clearly wins, auto-load it. Set to `0` to disable. Default: enabled |
| `MCPH_SERVER_CAP` | No | Hard cap on concurrently activated servers. Default: `6`. Set to `0` to disable. |
| `MCPH_PRUNE_RESPONSES` | No | Conservative response pruning (redact large file blobs etc. before returning to the client). Set to `0` or `false` to disable. Default: enabled. |
| `MCPH_DISABLE_PERSISTENCE` | No | Set to `1` or `true` to keep learning + pack-history scoped to the current process — nothing loaded at start, nothing written on shutdown. Intended for ephemeral / shared environments (CI, containers). Default: cross-session persistence enabled at `~/.mcph/state.json`. |
| `MCPH_AUTO_LOAD` | No | Set to `1` or `true` to pre-activate the top recurring pack (from persisted pack-history) on startup — no LLM round-trip required. Skips silently when history is empty or no pack's namespaces are all installed. Default: off. Requires persistence to be enabled. |
| `MCPH_MIN_COMPLIANCE` | No | Minimum compliance grade (`A`, `B`, `C`, `D`, or `F`, case-insensitive) an installed server must report before `mcp_connect_activate` will load it. Ungraded servers always pass (don't punish unknown). `discover()` annotates below-grade servers in place and shows a "Compliance filter active" header when set. Invalid values log a warning and disable the filter. Default: unset (no filter). |
| `MCP_CONNECT_TIMEOUT` | No | Connection timeout in ms for upstream servers (default: `15000`) |
| `MCP_CONNECT_IDLE_THRESHOLD` | No | Baseline for idle auto-unload (default: `10`). The per-namespace adaptive cap is `[5, 50]` — bursty namespaces extend past the baseline, long-idle ones unload at it. |

## Runtime detection

On startup, mcph probes your machine for `node`, `npx`, `python`, `uvx`, and `docker` and reports the snapshot to mcp.hosting. The dashboard uses this to warn before you add a catalog server whose runtime isn't installed (e.g., adding the Sentry server when Python isn't on your PATH). No prompt, no LLM round-trip — just a yellow banner on the Add Server form.

The detection is best-effort: each probe has a 3-second timeout and missing runtimes are recorded as absent rather than blocking startup. mcph itself only requires Node.js — every other runtime is optional and only matters for servers that need it.

### Automatic `uv` bootstrap

The popular Python-based MCP servers (`fetch`, `sqlite`, `time`, `sentry`, etc.) all launch via Astral's `uv`/`uvx`. mcph ships its own bootstrap for these: on first encounter with a `uv`/`uvx` command, if the binary isn't on your PATH, mcph lazily downloads Astral's standalone `uv` release, verifies the sha256, and caches it under the platform-appropriate cache dir. Subsequent loads reuse the cached binary. If you already have `uv` installed, mcph uses your version and never downloads.

`uvx ARGS` is always rewritten to `uv tool run ARGS` at spawn time — so only `uv` needs to be reachable, not `uvx` separately. Fixes Windows setups where one was on PATH and the other wasn't.

## Requirements

- Node.js 18+
- An [mcp.hosting](https://mcp.hosting) account

## Links

- [mcp.hosting](https://mcp.hosting) — Dashboard and server management
- [@yawlabs/mcp-compliance](https://www.npmjs.com/package/@yawlabs/mcp-compliance) — Test your MCP servers for spec compliance
- [CHANGELOG](./CHANGELOG.md) — Release notes
- [GitHub](https://github.com/YawLabs/mcph) — Source code and issues
