# @yawlabs/mcp

**One install. Every MCP server. Managed from one place.**

Yaw MCP (the `yaw-mcp` CLI) is an MCP server that fronts every other MCP server you use. Point each AI client (Claude Code, Claude Desktop, Cursor, VS Code) at it once, and your servers load lazily from a single connection instead of a hand-edited `mcpServers` block per client.

It runs entirely on your machine. No account, no sign-in, no telemetry -- your servers live in a local `bundles.json` and your credentials in a local encrypted vault. Running as an MCP server, its only outbound calls are two background npm checks: one for its own updates (`YAW_MCP_AUTO_UPGRADE=0` to disable), and, if you have run `yaw-mcp sidecars install`, a once-a-day check that the managed sidecar packages are current (`YAW_MCP_SIDECAR_REFRESH=0` to disable). `yaw-mcp add` fetches the public server catalog on demand. Nothing else leaves your machine.

It earns its keep when you hit any of these:

- **More than one client.** Define a server once in `bundles.json`; every client on the machine picks it up. No copy-pasting the same JSON into four config files. (Sync `bundles.json` across machines with your dotfiles if you want it everywhere.)
- **Tool-context bloat.** The `dispatch` meta-tool ranks your servers against the task and loads only the top match. A 30-server setup keeps a handful of tools in context at a time instead of hundreds.
- **Tokens you'd rather not leave in disk configs.** Credentials live encrypted in a local vault and inject at spawn time. Rotate once; every client picks up the new value.
- **A trust signal before you activate.** Every scored server shows an A-F compliance grade. Set `YAW_MCP_MIN_COMPLIANCE=B` to refuse anything below.

One client, a few servers? `claude mcp add` is fine -- yaw-mcp's value shows up when that setup stops scaling.

## How it works

```
Your MCP client (Claude Code, Cursor, ...)
    |
    |  single stdio connection
    v
@yawlabs/mcp  --lazy load-->  GitHub | Slack | Stripe | ...  (your servers)
```

1. Add servers with `yaw-mcp add <slug>` (or edit `~/.yaw-mcp/bundles.json` directly).
2. yaw-mcp reads that file on startup.
3. The model uses a handful of **meta-tools** to control which servers' tools are in context. Adding a server puts it on your list; loading it brings its tools into the session.

| Meta-tool | What it does |
|-----------|--------------|
| `mcp_connect_dispatch` | Describe a task in plain English; picks the best server, loads its tools, exposes them in one call. The fast path. |
| `mcp_connect_discover` | List available servers, optionally ranked by a context string. Auto-loads the top match when one clearly wins. |
| `mcp_connect_activate` / `deactivate` | Load / unload specific servers by namespace. |
| `mcp_connect_read_tool` | Return one tool's schema without loading its server. |
| `mcp_connect_exec` | Run a short declarative pipeline of tool calls in one round-trip (`{"$ref": "<step>[.path]"}` splices prior outputs; no eval, max 16 steps). |
| `mcp_connect_bundles` | List curated multi-server presets (PR review, DevOps incident, ...) and match them against your config. |
| `mcp_connect_suggest` | Surface recurring multi-server workflows learned from usage, with a ready-to-run `activate` call. |
| `mcp_connect_secrets` | Show which local-vault secrets each server's `${secret:NAME}` refs resolve to -- by name only, never a value. |
| `mcp_connect_health` | Call counts, error rates, and latency per loaded server. |

**Ranking.** dispatch/discover rank with BM25, computed locally. On top of the ranker, three signals adjust scores:

- **Health-aware** -- servers that recently failed or error often get down-ranked (never boosted above raw).
- **Learning** -- servers that succeeded before get a small nudge (+10% max), persisted across restarts.
- **Sampling tiebreak** -- when the top two are within 10% and your client supports [MCP sampling](https://modelcontextprotocol.io/specification/server/sampling), yaw-mcp asks your own model to pick (no extra provider key or cost).

Servers auto-unload after ~10 tool calls to other servers, so context stays clean even if you forget. The threshold is adaptive per namespace (`[5, 50]`): bursty servers get more patience, long-idle ones unload at the baseline.

## Install

### One command (recommended)

```bash
npx -y @yawlabs/mcp@latest install <claude-code|claude-desktop|cursor|vscode>
```

This edits the chosen client's config (correct path + JSON shape for your OS) to launch yaw-mcp. On Windows it wraps `npx` in `cmd /c` (without which MCP clients hit `ENOENT` on the `npx.cmd` shim). Run it once per client.

Useful flags:

- `--scope user|project|local` -- which file to write (Claude Code + Cursor support project/local; VS Code is workspace-only; Claude Desktop is user-only).
- `--dry-run` -- print what would be added (never the rest of the file) and exit without writing.
- `--force` / `--skip` -- overwrite or leave an existing `mcp` entry (otherwise prompts on a TTY, refuses off-TTY).

Or do every detected client at once:

```bash
yaw-mcp install --list   # detect clients + show install state (read-only)
yaw-mcp install --all    # install into every user-scope client on this machine
```

> The launch entry is keyed `"mcp"`, so its tools surface under the `mcp__mcp__` namespace. Installs made before the rename used `"mcp.hosting"` / `"yaw-mcp"`; `yaw-mcp install` detects and migrates those.

### Manual install

The JSON shape (top-level `mcpServers`, except VS Code uses `servers` in `.vscode/mcp.json`):

```json
{
  "mcpServers": {
    "mcp": { "command": "npx", "args": ["-y", "@yawlabs/mcp@latest"] }
  }
}
```

On **Windows**, use `"command": "cmd", "args": ["/c", "npx", "-y", "@yawlabs/mcp@latest"]`.

### Running yaw-mcp on oam

yaw-mcp can host itself on [oam](https://oamjs.org), a Rust+V8 JavaScript runtime built for this shape of workload — short-lived, mostly-idle MCP processes.

`yaw-mcp install` writes the oam entry for you when two things are true:

- **oam is installed** — `curl -fsSL https://oamjs.org/install.sh | sh`, or `irm https://oamjs.org/install.ps1 | iex` on Windows. Those install the current release, which always satisfies the minimum. An older build is refused rather than silently used: versions below the floor predate fixes this workload sits on, including one where a client disconnecting mid-upload killed the process. `yaw-mcp doctor` prints the exact minimum under OAM RUNTIME.
- **yaw-mcp is durably installed** — `npm i -g @yawlabs/mcp`, or a project `node_modules`. A path in the npx cache is deliberately not used: that directory is evictable, and an entry pointing into it breaks the moment npm cleans it.

Neither is required, and nothing breaks without them — the npx entry is written as before, and install tells you which one you got. Afterwards `yaw-mcp doctor` marks a client whose entry launches the broker on oam with `(runs on oam)`, and its OAM RUNTIME section reports the binary, version, and minimum.

The entry it writes:

```json
{
  "mcpServers": {
    "mcp": { "command": "/path/to/oam", "args": ["run", "--no-check", "/path/to/@yawlabs/mcp/dist/index.js"] }
  }
}
```

Two consequences worth knowing. It pins a path, so it does not re-resolve `@latest` on every spawn the way the npx entry does — `npm update -g` still picks up new versions, because it rewrites that path in place. And this setting is about the **broker itself**; which runtime the *sidecars* get is decided separately, below.

### Which runtime the sidecars get

When oam is installed and meets the minimum, yaw-mcp hosts the MCP servers it spawns on it. Nothing needs configuring — install oam and the sidecars move over. Without oam they run on node/npx exactly as before, and no warning is printed, because nothing was asked for.

Only Node-based launches are rewritten. A server whose command is `docker`, `uvx`, or a native binary is left alone, as is an npx package that cannot be found on disk.

Two more npx shapes stay on npx, because npx re-resolves its spec against the registry while `oam run <entry>` just runs whatever sits at the path it is handed. A spec that **constrains the version** keeps npx unless the copy on disk can be shown to satisfy it — an exact pin moves to oam only when the resolved copy declares that same version, and a range or partial (`^1.2.3`, `~1.2`, `1.x`) always keeps npx, since honouring one would mean evaluating semver ranges against the tree. A spec naming a **git or path target** (`npx -y ./local-server`, `github:owner/repo`) keeps npx too: it is not a package name, so there is nothing to look it up as. A plain `@latest`, or no version at all, is the everyday case and does move over.

**One tradeoff worth knowing.** `npx -y <pkg>@latest` re-resolves that tag on every spawn, so those servers update themselves. `oam run <entry>` cannot — oam has no fetch-on-demand, so it runs the copy already on disk, and because npx then stops running for that server, the copy stops being refreshed. The version pins itself until something fetches a newer one. yaw-mcp logs the resolved version once per package at startup so this is visible rather than silent, and picks the newest copy present.

### Installing the servers durably

```
yaw-mcp sidecars install
```

Installs the npx-launched servers from your `bundles.json` into `~/.yaw-mcp/sidecars`, and yaw-mcp resolves from there in preference to npm's npx cache. That gives one copy per package at a version that is written down, instead of whichever of the several copies in the cache happened to be newest — and re-running the command is how you move them forward.

It is not automatic and nothing requires it. Acquiring packages means network and minutes, and the connect path is what an MCP client blocks on while waiting for its tools; a first connect that silently turned into an npm install would be the wrong trade. Without it, resolution falls back to the npx cache exactly as before.

Only npx servers naming a **registry package** are installed. An npx launch pointing at a git or path target — `npx -y github:owner/repo`, `npx -y ./local-server` — is skipped and named in the output; those keep using npx, since resolving them would mean fetching the target just to learn the name it declares. Two servers pinning the same package at different versions is also reported: one flat `node_modules` holds a single version, so the command tells you which one it installed rather than letting the loser start on something it did not ask for.

`yaw-mcp doctor` prints the installed version of each configured package under OAM RUNTIME, so a pinned or missing one is visible. To keep npx's self-updating behavior for a particular server instead, set `runtime: "node"` on it.

`--json` emits the same keys on every run — `root`, `installed`, `reason`, `error`, `conflicts`, `skipped` — so a script can read the result without first working out which path it took.

To override, in `~/.yaw-mcp/bundles.json`:

```json
{
  "defaultRuntime": "node",
  "servers": [{ "namespace": "postgres", "runtime": "oam" }]
}
```

- `runtime` on a server wins over everything, and `"node"` is the per-server escape hatch.
- `defaultRuntime` at the top level sets the machine-wide default; `"node"` opts the whole machine out.
- `YAW_MCP_DEFAULT_RUNTIME=node|oam` overrides `defaultRuntime` for one process.

`yaw-mcp doctor` prints the resolved runtime for every configured server, with the reason — including the cases where oam was wanted but not used, so a silent fallback is visible rather than guessed at.

## CLI

`yaw-mcp` with no subcommand runs as the MCP server, serving the servers in your `~/.yaw-mcp/bundles.json`. Most read-only subcommands accept `--json`. Run `yaw-mcp <cmd> --help` for per-command flags.

**Setup**

```bash
yaw-mcp install <client>       # connect a client to yaw-mcp (see above)
yaw-mcp doctor [--json]        # diagnose config, clients, learning, reliability, upgrade
```

**Servers** -- managed in `~/.yaw-mcp/bundles.json`, browse the catalog at [yaw.sh/mcp/catalog](https://yaw.sh/mcp/catalog/):

```bash
yaw-mcp add <slug> [--env KEY=value] [--dry-run]   # add a catalog server to bundles.json
yaw-mcp add <name> --command "npx -y my-mcp"       # ...or define a local server yourself
yaw-mcp add <name> --url https://host/mcp          # ...or a remote one
yaw-mcp remove <slug-or-namespace>                 # drop a server
yaw-mcp list [--json]                              # list configured servers with their cached compliance grade
yaw-mcp try <slug> [--client <name>] [--ttl 1h]    # wire a one-off trial straight into your client (expires)
yaw-mcp try-cleanup <slug>                          # remove a trial early (doctor GCs expired ones)
yaw-mcp trust [--yes|--list|--revoke [<path>]]     # approve the project-local .yaw-mcp/bundles.json found from cwd so yaw-mcp loads it (pinned to its exact contents)
```

`add` is not `install`: `install <client>` connects an AI client to yaw-mcp; `add <slug>` adds an MCP server to yaw-mcp itself. `try` points the client directly at the upstream server, bypassing yaw-mcp, so you can evaluate it in isolation. A `--env` value lands in your shell history and process argv like any argument. With `add` it is stored in plain text (file mode `0600`) in `bundles.json` -- keep real credentials in the [local secret vault](#local-secret-vault) and pass `--env KEY='${secret:NAME}'` instead (the single quotes are for bash, zsh and PowerShell; in cmd.exe pass it unquoted, since `$` is not special there and cmd.exe would keep the quotes as part of the value). A `missing` row in `yaw-mcp secrets audit` whose name starts with `<malformed ref>` is a reference that did not parse -- fix the typo in `bundles.json`. With `try` the value is written inline, in plain text, into the client's own config for the trial's lifetime, and is not vault-resolved (the client spawns the server, not yaw-mcp).

**Servers the catalog does not list.** The catalog is a curated front door, not the only one. Pass `--command` for a local (stdio) server or `--url` for a remote (HTTP) one, and `add` defines the server from your flags instead of looking up a slug -- no catalog fetch, so this also works offline:

```bash
yaw-mcp add mytool --command "npx -y @scope/my-mcp@latest" --description "what it is for"
yaw-mcp add linear --url https://mcp.linear.app/mcp \
  --header 'Authorization: Bearer ${secret:linear}'
```

`--header` is repeatable and remote-only: a remote server spawns no process, so `--env` cannot reach it (see [`headers`](#remote-servers-headers)). `--transport sse` selects SSE over the streamable-HTTP default. `--description` is worth setting either way, since dispatch ranks servers on it.

A project-local `.yaw-mcp/bundles.json` (committed with a repo) is ignored until `yaw-mcp trust` approves it, since every server in it is a command yaw-mcp spawns as you. Approval is pinned to the file's exact contents, so an edited file needs approving again; `--list` shows approvals (stale ones flagged) and `--revoke` withdraws one. Your own `~/.yaw-mcp/bundles.json` is never gated.

**Inspection & maintenance**

```bash
yaw-mcp bundles [list|match] [--json]  # browse curated bundles; match partitions against your enabled servers
yaw-mcp upgrade [--run] [--json]       # show (or run) the command that bumps @yawlabs/mcp
yaw-mcp reset-learning                 # clear cross-session learning (~/.yaw-mcp/state.json)
yaw-mcp completion <bash|zsh|fish|powershell>   # print a shell-completion script
```

**Compliance**

```bash
yaw-mcp compliance <target>   # run the 88-test compliance suite against a server
yaw-mcp audit <namespace>     # audit a stdio server from bundles.json, cache its A-F grade in grades.json
```

To install completion, redirect to your shell's completions dir, e.g. `yaw-mcp completion zsh > "${fpath[1]}/_yaw-mcp"`, or `yaw-mcp completion powershell >> $PROFILE`.

## Configuration -- `.yaw-mcp/`

yaw-mcp keeps its config under a `.yaw-mcp/` directory (mirroring `.git/`, `.vscode/`, `.claude/`). It reads `config.json` from three optional scopes, highest precedence first:

| Scope | Path | Use |
|-------|------|-----|
| **local** | `<project>/.yaw-mcp/config.local.json` | Machine-local overrides; gitignore it. |
| **project** | `<project>/.yaw-mcp/config.json` | Shared via git with the repo. |
| **global** | `~/.yaw-mcp/config.json` | Personal default for every project. |

The project `.yaw-mcp/` is found by walking up from the cwd -- stopping just before `$HOME` when started under it (so a `.yaw-mcp/` at `$HOME` is treated as global only); a cwd outside `$HOME` walks to the filesystem root with an ownership check. Files may contain `//` and `/* */` comments. Full schema:

```jsonc
{
  // optional -- gives editors key completion + inline validation
  "$schema": "https://raw.githubusercontent.com/YawLabs/mcp/main/schemas/yaw-mcp.config.v1.json",
  "version": 1,                          // schema version; newer versions log a warning
  "servers": ["gh", "pg", "linear"],     // allow-list of namespaces (most-specific scope wins)
  "blocked": ["prod_db"],                // deny-list (UNION across all scopes -- fail-safe on deny)
  "installNudge": true                   // opt-in: discover may suggest installing MCP servers for
                                         // CLIs found in your recent shell history (off by default)
}
```

That shape ships as a JSON Schema -- [`schemas/yaw-mcp.config.v1.json`](schemas/yaw-mcp.config.v1.json), served from the raw URL in the `$schema` line above -- so any editor that honors `$schema` completes the keys and flags a typo as you type. A namespace is `[a-z][a-z0-9_]{0,29}` (so `prod_db`, not `prod-db`); the schema rejects anything else, while the loader only warns and keeps loading.

Malformed files log a warning and fall through (fail-open). yaw-mcp reads config at startup, so restart the client after editing; `mcp_connect_health` shows which files are applied.

### Project guide -- `YAW-MCP.md`

Drop a `YAW-MCP.md` next to `config.json` in either `.yaw-mcp/` and yaw-mcp surfaces it via a `yaw-mcp://guide` MCP resource. The `discover`/`dispatch` descriptions tell the model to read it first, so project routing conventions ("use the `gh` server, not bash") and credential guidance stick without restating them each session. A user guide (`~/.yaw-mcp/YAW-MCP.md`) and a project guide are concatenated with the project one last; a missing file is skipped silently.

## Local secret vault

Rather than putting credentials in a client config, keep a value in an encrypted file on your own machine and reference it from any server's `env` with a `${secret:NAME}` placeholder:

```jsonc
"env": {
  "GITHUB_PERSONAL_ACCESS_TOKEN": "${secret:gh}",
  "AUTH_HEADER": "Bearer ${secret:gh}"   // placeholders compose inline
}
```

At spawn time, if `YAW_MCP_VAULT_PASSPHRASE` is set in yaw-mcp's own env, it decrypts the referenced names and substitutes them into the child's env. If the passphrase is absent or a name isn't stored, the spawn is **refused** -- the literal `${secret:NAME}` is never passed through, since some servers would treat the placeholder as a real token. The value never leaves your machine.

### Remote servers: `headers`

A remote (HTTP/SSE) server spawns no process, so it has no env to put a credential in -- yaw-mcp warns and ignores `env` on a remote entry. Its credential channel is `headers`, which takes the same `${secret:NAME}` references:

```jsonc
{
  "namespace": "linear",
  "type": "remote",
  "url": "https://mcp.linear.app/mcp",
  "headers": {
    "Authorization": "Bearer ${secret:linear}"
  }
}
```

Headers are resolved through the same fail-closed path: a missing or malformed reference refuses the **connect**, so no request is made at all rather than one carrying the literal to a third party. They apply to both transports, including the SSE stream.

**Where the passphrase comes from.** Three ways, in the order you'll meet them:

1. **`YAW_MCP_VAULT_PASSPHRASE` in yaw-mcp's own env** -- the `env` block of the *yaw-mcp* entry in your MCP client config, not the upstream server's (yaw-mcp strips its own secrets from the env of every child it starts: every server it spawns, the npm runs behind its self-upgrade and the daily sidecar refresh, and the compliance suite). This is the only option for a spawn, which happens over stdio with no terminal to prompt on.
2. **An in-session prompt.** If your client supports MCP [elicitation](https://modelcontextprotocol.io/specification/server/elicitation), a locked vault asks for the passphrase once per session and retries the server. It's held in memory for that session only -- never written to disk, and never handed to the server being started.
3. **The CLI prompt**, for `yaw-mcp secrets` runs: no-echo on a real TTY. Note that Git Bash/MSYS can't offer one (Node sees pipes, not a TTY) -- use PowerShell, `winpty`, or the env var there.

`yaw-mcp doctor` has a **SECRET VAULT** section showing what's stored, which servers reference it, and whether a passphrase is available -- start there when a server won't load. It reports names and a yes/no, never a value.

```bash
yaw-mcp secrets set <name>      # store a value (no-echo prompt, or --value/--stdin)
yaw-mcp secrets get <name>      # decrypt and print one value
yaw-mcp secrets list            # show entry NAMES only (values stay encrypted)
yaw-mcp secrets remove <name>   # delete an entry
yaw-mcp secrets lock            # forget this process's cached passphrase -- effectively a no-op from the CLI; cannot reach a running server or change the vault
yaw-mcp secrets rotate          # re-encrypt the whole vault under a NEW passphrase
yaw-mcp secrets audit [--secret NAME] [--server NS] [--json]   # who consumed which secret, when
```

The passphrase derives the key via scrypt and is cached in memory for one process; the on-disk file holds only ciphertext (AES-256-GCM, per-entry IV + tag, one vault salt). `rotate` decrypts every entry first and aborts untouched if any fails -- and it re-wraps the **encryption**, not the underlying tokens (a leaked token is still leaked; rotate it at its source). `audit` reads an append-only `0600` NDJSON log of secret NAME + namespace + timestamp -- never a value -- and writes fail-open so a broken log never blocks a spawn.

**Threat model.** The vault protects the on-disk file against offline brute-force after exfiltration (stolen laptop, leaked backup): useless without the passphrase, tamper-evident via GCM. It does **not** defend against a process running as you while the passphrase is cached, a keylogger, or a value already leaked at its source.

## Runtime detection & `uv` bootstrap

On startup yaw-mcp probes for `node`, `npx`, `python`, `uvx`, and `docker` (best-effort, 3s per probe) so it can warn when a server's runtime is missing. yaw-mcp itself needs only Node.js.

Python servers (`sqlite`, `time`, `sentry`, ...) launch via Astral's `uv`/`uvx`. On first encounter, if `uv` isn't on your PATH, yaw-mcp downloads Astral's standalone release, verifies the sha256, and caches it -- reusing your own `uv` if you have one. `uvx ARGS` is always rewritten to `uv tool run ARGS`, so only `uv` needs to be reachable.

## Trust & security

MCP servers are third-party code you choose to run. yaw-mcp doesn't sandbox them -- that's your OS and network. What it gives you is **visibility and a gate**:

- **Compliance grades (A-F)** -- the `@yawlabs/mcp-compliance` suite (88 tests) grades a server; `yaw-mcp list` shows it in a `GRADE` column and `discover` shows it inline (`github [ready] [A]`). `YAW_MCP_MIN_COMPLIANCE=B` makes `activate` refuse anything below the floor. Ungraded servers pass (don't punish unknown); audit them yourself with `yaw-mcp compliance <target>`.
- **Source transparency** -- `list` and `discover` show the exact `command`, `args`, and `url` each server launches with. Nothing is wrapped.
- **Local credentials** -- vault values are encrypted at rest (scrypt + AES-256-GCM), injected at spawn, and never logged. Nothing is transmitted off the machine.
- **Response pruning** (`YAW_MCP_PRUNE_RESPONSES`, on by default) -- trims token cost by dropping no-information keys (null / empty array / empty object) and trimming trailing whitespace and long blank runs in text results. Structured values are never altered or redacted; it is a token-savings feature, not a security control.
- **Namespace isolation** -- tools are namespace-prefixed (`gh_create_issue`, never bare `create_issue`), so a server can't impersonate another's tools. `mcp_connect_read_tool` inspects a schema before any code runs.

yaw-mcp does **not** block outbound traffic, firewall DNS, analyze source, or pin hashes -- a malicious server you chose to run can reach any URL your machine can. Review the command before adding a server, run untrusted ones under a restricted user or container, and prefer graded servers when alternatives are equivalent. Report a security issue in yaw-mcp itself via [GitHub private advisories](https://github.com/YawLabs/mcp/security/advisories/new) (see [`SECURITY.md`](./SECURITY.md)).

## Missing credentials

If a server exits with something like `GITHUB_TOKEN is required` and your client advertises MCP [elicitation](https://modelcontextprotocol.io/specification/server/elicitation), yaw-mcp prompts for the value and retries, rather than failing the call outright.

## Environment variables

Common ones (run `yaw-mcp --help` for the full list):

| Variable | Description |
|----------|-------------|
| `YAW_MCP_SERVER_CAP` | Max concurrently active servers. Default `6`; `0` disables the cap. |
| `YAW_MCP_MIN_COMPLIANCE` | Minimum grade (`A`-`F`) an installed server must report before `activate` loads it. |
| `YAW_MCP_VAULT_PASSPHRASE` | Passphrase for the local secret vault. Required for spawn-time `${secret:NAME}` substitution -- set it in yaw-mcp's own env, not the upstream server's. Clients supporting elicitation prompt for it instead. |
| `YAW_MCP_TRUST_PROJECT` | `1` skips the consent check on a project-local `.yaw-mcp/bundles.json` and loads it unconditionally. CI/automation only -- it lets any repo you run yaw-mcp inside spawn commands as you. Default: the file must be approved with `yaw-mcp trust`. |
| `YAW_MCP_AUTO_ACTIVATE` | `0` disables discover auto-loading a clearly-winning server. Default on. |
| `YAW_MCP_AUTO_UPGRADE` | `0` disables the background self-upgrade check at startup. Default on. |
| `YAW_MCP_SIDECAR_REFRESH` | `0` disables the daily background check that keeps managed sidecars current. Only ever runs if you have run `yaw-mcp sidecars install`; explicit pins and semver ranges are never moved. Default on. |
| `OAM_BIN` | Path to the `oam` binary to use instead of the one on `PATH`. A path that does not exist is reported by `doctor` as an unusable oam (fix the variable), not as oam being absent. |
| `OAM_MAX_HEAP_MB` | Raises the V8 heap cap oam applies to a hosted server (4 GiB by default since oam 0.9.2). Set it in that server's `env` when a hosted sidecar dies with a heap out-of-memory error, or give that server `"runtime": "node"`. |
| `YAW_MCP_AUTO_LOAD` | `1` pre-activates the top recurring pack at startup (needs persistence). Default off. |
| `YAW_MCP_PRUNE_RESPONSES` | `0` disables response pruning. Default on. |
| `MCP_CONNECT_TIMEOUT` | Milliseconds to wait for a server's MCP handshake. Default `15000`; a server's own `connectTimeoutMs` in `bundles.json` always wins. Whole milliseconds in `1..2147483647` -- anything else falls back to the default with one warn. |
| `MCP_LIST_TIMEOUT` | Milliseconds to wait for a server's tool/resource/prompt inventory calls after the handshake. Default `15000`; same `1..2147483647` whole-millisecond parse, invalid values fall back with one warn. |
| `MCP_CALL_TIMEOUT` | Milliseconds to wait for a single proxied `tools/call`. Default `60000` (the SDK's own bound); raise it for legitimately slow servers. Same `1..2147483647` whole-millisecond parse, invalid values fall back with one warn. |
| `YAW_MCP_IDLE_THRESHOLD` | Non-matching tool calls a loaded server tolerates before it is unloaded. Default `10`; bursty servers earn more patience automatically. The older name `MCP_CONNECT_IDLE_THRESHOLD` still works as a fallback. |
| `YAW_MCP_DISABLE_PERSISTENCE` | `1` keeps learning + pack history process-scoped (CI, containers). Default off. |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`. Default `info`. |

## Requirements

- Node.js 20+.
- No account. Everything runs locally.

## License

Source-available, not open source. Copyright (c) 2026 Yaw Labs, all rights reserved.

The source is published so you can read and audit it before running it -- `yaw-mcp` spawns processes on your machine and handles your credentials, and you should not have to take that on faith. You may use it freely, personally or commercially, and redistribute unmodified copies. You may not offer it to third parties as a competing product. See [LICENSE.md](./LICENSE.md) for the terms, and [CONTRIBUTING.md](./CONTRIBUTING.md) for the DCO sign-off contributors use.

## Links

- [yaw.sh/mcp/catalog](https://yaw.sh/mcp/catalog/) -- browse the server catalog
- [@yawlabs/mcp-compliance](https://www.npmjs.com/package/@yawlabs/mcp-compliance) -- test your MCP servers for spec compliance
- [CHANGELOG](./CHANGELOG.md) -- release notes
- [GitHub](https://github.com/YawLabs/mcp) -- source and issues
