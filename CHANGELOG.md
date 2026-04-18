# Changelog

All notable changes to `@yawlabs/mcph` are documented here. This project uses [semantic versioning](https://semver.org) and a CI-gated release flow: pushing a `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which publishes to npm.

## 0.41.0 — 2026-04-18

- **`mcph doctor --json` — machine-readable diagnostic output** — Doctor already tracks a lot of state (config files, token source, env overrides, persisted learning, installed clients, shell-history shadow hits, upgrade availability, diagnosis summary) and the text output optimises for pasting into a support ticket. `--json` emits the same data as a single structured blob so dashboards, CI scripts, and support tooling can pick fields with `jq` instead of parsing the text layout. Token is fingerprinted the same way in both modes (never raw). Section data is 1:1 with the text renderer: config (token/apiBase/loadedFiles/warnings), env overrides (null when unset), state (path/savedAt/entries; `disabled: true` when `MCPH_DISABLE_PERSISTENCE` is set), reliability (same `selectFlakyNamespaces` rollup that `mcp_connect_health` and the text RELIABILITY section use), clients probe results, shell shadow hits, upgrade info, and the exit-code diagnosis. Completes the `--json` pattern across `servers`, `bundles`, and now `doctor` — every CLI that reads state has a pipeline mode.

## 0.40.0 — 2026-04-18

- **`mcph bundles` CLI subcommand** — CLI counterpart to the `mcp_connect_bundles` meta-tool (v0.28.0). Two actions mirror the meta-tool's `action` parameter: `list` prints every curated bundle grouped by category with activate hints (static, no network, no token needed — good for browsing or sharing in onboarding docs), and `match` partitions the curated set against the user's enabled servers from the backend into ready-to-activate vs partially-installed, so a human can see in the terminal what the LLM-facing tool would suggest. The LLM tool has always been primary surface, but "what bundles exist?" is a frequent enough support question that surfacing them in the CLI earns its keep. Match only counts `isActive: true` servers — disabled ones don't auto-activate, so they shouldn't count toward "ready" — matching the LLM tool's filter so both surfaces agree. Partial bundles sort fewest-missing first to match the discover inline hint ranking. `--json` emits machine-readable output (`{bundles}` for list, `{installed, ready, partial}` for match). Exit codes: 0 success, 1 match needs a token and none resolved, 2 match couldn't reach the backend.

## 0.39.0 — 2026-04-18

- **`mcph servers` CLI subcommand** — Lists the servers currently configured for your account in the mcp.hosting dashboard, hitting the same `/api/connect/config` endpoint that `runServer` polls at startup. Fills a gap between `mcph doctor` (local state: config files, clients, state.json) and the web dashboard: users can sanity-check their dashboard edits from the terminal, support engineers can ask for `mcph servers --json` output in a ticket, and scripts can pick a namespace up-front before piping into `mcph compliance` or `mcph install`. Table view groups the relevant columns (namespace, name, type, enabled/disabled, compliance grade, cached tool count) and is sorted alphabetically by namespace for diffable re-runs; `--json` emits the raw backend response verbatim. Exit codes: 0 success, 1 no token, 2 fetch error.

## 0.38.0 — 2026-04-18

- **`mcph reset-learning` CLI subcommand** — Deletes `~/.mcph/state.json` so cross-session learning starts fresh; prints the entry counts that were cleared. Pairs with v0.37.0's doctor RELIABILITY section: once a namespace has been flagged flaky, the dispatch penalty branch (v0.36.0) keeps suppressing it until enough new successes pile up — but if the user has since fixed the underlying cause (rotated a token, swapped the upstream, re-authed), that history is stale and the penalty has overstayed its welcome. This gives them a direct CLI lever to clear it. Scope is all-or-nothing by design; a per-namespace flag is footgunny (user clears one, forgets the others, keeps getting silently mis-ranked). No-op with an explanatory message when `MCPH_DISABLE_PERSISTENCE` is set or the file doesn't exist, so `mcph reset-learning` never surprises. Exit 0 on success or no-op, exit 1 on I/O error (permissions, disk).

## 0.37.0 — 2026-04-18

- **`mcph doctor` RELIABILITY section** — New block surfaces flaky dormant namespaces pulled directly from `~/.mcph/state.json`, using the same ≥3-dispatches / <80%-success definition as `mcp_connect_health`'s cross-session reliability block — so the CLI diagnostic and the LLM-facing health tool agree on what "flaky" means. Sorted worst-rate first, capped at 5. Silently omitted when no namespace qualifies, state.json doesn't exist yet, or `MCPH_DISABLE_PERSISTENCE` is set. Threshold constants + sort logic extracted into `selectFlakyNamespaces` so handleHealth and doctor can't drift apart.

## 0.36.0 — 2026-04-18

- **Negative signal in dispatch ranking (`boostFactor` penalty branch)** — The learning store's `boostFactor` now drops *below* 1.0 for namespaces with flaky history, mirroring the existing upward boost. Threshold is the same ≥3 dispatches / <80% success gate used by discover's inline reliability warning (v0.35.0) and health's cross-session block (v0.34.0) — so a server flagged flaky in those views also loses rank points at dispatch time rather than quietly continuing to win routing. Floor is `-10%` (`LEARNING_MIN_BOOST = 0.9`), symmetric with the existing `+10%` ceiling. Rate-based signal trumps count-based: a namespace with 10 successes but a 50% overall rate is flaky, not useful, and the penalty branch beats the positive branch in that case.

## 0.35.0 — 2026-04-18

- **Inline reliability warning in `mcp_connect_discover`** — Discover now annotates dormant (not currently loaded) servers with `reliability: P% success across N past calls` when persisted learning shows ≥3 dispatches and <80% success. Renders under the server card right after the live health warning, so the LLM sees the flaky history *before* it picks a server to activate — not only after `handleHealth` surfaces it post-hoc. Thresholds match the cross-session reliability block from v0.34.0 so the two views stay consistent. Suppressed for loaded servers (the live per-call warning already covers them with fresher data).

## 0.34.0 — 2026-04-18

- **Cross-session reliability block in `mcp_connect_health`** — New section at the bottom of health output surfaces flaky *dormant* namespaces pulled from persisted learning: `<namespace> — N calls, P% success, last used <age> ago`. Threshold is deliberately high (≥3 dispatches, <80% success) so a one-off failure doesn't light up the panel; loaded namespaces are skipped (in-session block already covers them). Sorted worst-rate first, ties broken by most calls then alpha; capped at 5. Also fixes a gap where `handleHealth` returned early on an empty-connections session and never showed dormant history — now it falls through so operators can see which past servers were unreliable even before loading anything.

## 0.33.0 — 2026-04-18

- **`mcph doctor` ENVIRONMENT section** — New block enumerating every behavior-modifier env var mcph actually reads (`MCPH_POLL_INTERVAL`, `MCPH_SERVER_CAP`, `MCPH_MIN_COMPLIANCE`, `MCPH_AUTO_LOAD`, `MCPH_PRUNE_RESPONSES`). Each shows its current value, or `(not set — <default>)` when unset. Closes a diagnostic gap where users reporting "my server cap isn't taking effect" or "compliance filter isn't blocking anything" had no doctor signal on whether the knob was even set. TOKEN / URL / DISABLE_PERSISTENCE still get their dedicated sections (richer context there).

## 0.32.0 — 2026-04-18

- **Unknown CLI subcommand detection + typo suggestions** — `mcph <typo>` (e.g. `mcph instal`, `mcph docto`) now exits 2 with `unknown subcommand "X". Did you mean: install?` instead of silently falling through to MCP-server mode and erroring opaquely on the missing token. Bare flags (anything with a leading `-`) still fall through so server startup can parse them.

## 0.31.0 — 2026-04-18

- **"Did you mean?" suggestions on `mcp_connect_activate`** — When a caller tries to activate a namespace that doesn't exist, the error message now splits the two underlying cases: (a) not installed at all (with up to 3 fuzzy-matched installed namespaces via substring containment or ≤2 edit distance, or a pointer to `mcp_connect_discover` when nothing is close), and (b) installed but disabled in the dashboard (with a pointer to `mcp.hosting` to enable). Replaces the previous conflated "`X` not found or disabled" message.

## 0.30.0 — 2026-04-18

- **Inline bundle completions in `discover()`** — When a curated bundle has some installed servers but is missing one or two, `mcp_connect_discover` surfaces a "Bundle completions" block with the partial bundle id, what's already installed, and what to add. Top 3 entries, ranked by fewest-missing first (cheapest to complete), tie-broken by most-momentum then id. Same data source as `mcp_connect_bundles action="match"`, but inline so the model can act on the nudge without the extra round-trip. Suppressed when no curated bundle has any overlap with the installed set.

## 0.29.0 — 2026-04-18

- **Compliance-aware routing (`MCPH_MIN_COMPLIANCE`)** — Phase 3 item. Set the env var to `A`, `B`, `C`, `D`, or `F` and `mcp_connect_activate` refuses to load any installed server whose reported `complianceGrade` is below the floor, with an error that names the grade and the env var to unset. `mcp_connect_discover` annotates below-grade servers in place (so the model knows they exist and why they won't auto-activate) and emits a "Compliance filter active" header. Forward-compatible schema: the optional `complianceGrade` field on `UpstreamServerConfig` rides the existing `/api/connect/config` response — the feature kicks in automatically once the backend starts populating grades. Ungraded servers always pass (don't punish unknown).

## 0.28.1 — 2026-04-18

Docs-only release.

- First-ever `CHANGELOG.md`, covering 0.5.0 → 0.28.0. Linked from `README.md`.
- README catches up with the meta-tools shipped in the 0.20 – 0.28 arc: `mcp_connect_read_tool`, `mcp_connect_exec`, `mcp_connect_bundles` are now documented in the top-level list. Corrected "session-local" phrasing on the Learning ranker signal (cross-session since v0.23.0).
- New "Multi-device sync" section under "Config sync" — same token, same servers across every machine; no dotfile repos for secrets.
- Phase 2 "Multi-device config sync" marked shipped in `ROADMAP.md` (docs-only; backing behavior already worked).
- `package.json` `files` array now includes `CHANGELOG.md` so release notes ship with the npm tarball.

## 0.28.0 — 2026-04-18

Phase 3 opener. Two client-only intelligence features.

- **Tool deduplication** — `mcp_connect_discover` now surfaces an "Overlapping tools" block when two or more currently-connected servers expose the same bare tool name. Top 5 overlaps, sorted by namespace count descending, with a dispatch-to-disambiguate hint.
- **Curated bundles (`mcp_connect_bundles`)** — New meta-tool returning hand-picked multi-server presets: `devops-incident`, `pr-review`, `growth-stack`, `data-ops`, `product-release`, `support-ops`. `action: "list"` (default) returns all bundles; `action: "match"` partitions them into "ready to activate now" vs. "partially installed" against the user's current config.

## 0.27.0 — 2026-04-18

Four Phase 2 items shipped together.

- **Automatic load (`MCPH_AUTO_LOAD`)** — Opt-in env flag. On startup, after persistence hydration, activates every namespace in the top recurring pack (by frequency, tie-break recency) from pack history, provided every namespace is installed. Silent no-op otherwise.
- **Per-tool filter on `mcp_connect_activate`** — Pass `tools: [...]` to expose only the named tools via `tools/list`. Hidden tools stay reachable through `mcp_connect_dispatch` (routes are unfiltered). Re-activate without `tools` to clear the filter. `discover()` shows a `(filtered: K of N)` indicator on filtered connections.
- **Orchestration pipeline (`mcp_connect_exec`)** — Declarative multi-step tool-call pipeline. Each step names a namespaced tool plus args; `{"$ref": "<stepId>[.path]"}` markers in args splice a prior step's output into the next step's input. No eval / no expression language — only sequential dispatch and dot/bracket path resolution. Capped at 16 steps; any step failure fails the pipeline and returns completed outputs as `partial`.
- **Marketplace pointer** — `discover()` appends `https://mcp.hosting/explore` for users with fewer than 5 installed servers. URL hint only; a full marketplace meta-tool is parked until the backend ships a catalog API.

## 0.26.0 — 2026-04-18

- **Recurring packs block in `discover()`** — When pack history and installed config overlap, `discover()` now surfaces an "Recurring packs" block at the top of its output with a ready-to-run `mcp_connect_activate` call. Saves the second `mcp_connect_suggest` round-trip when the signal is already there.

## 0.25.1 — 2026-04-18

- Truthed up "this session" phrasing across user-facing strings and tool descriptions. With cross-session persistence (v0.23.0) shipping, counts and pack history are no longer session-scoped; the copy now matches.

## 0.25.0 — 2026-04-18

- `mcp_connect_suggest` now emits a ready-to-run `mcp_connect_activate` call with a verbatim `namespaces=[...]` JSON array, rather than pointing at `mcp_connect_dispatch` (the wrong primitive for loading a pack).

## 0.24.0 — 2026-04-18

- **`mcph doctor` STATE section** — Prints `~/.mcph/state.json` path, last-saved age, learning count, pack history count; shows "disabled" when persistence is opted out.
- **`MCPH_DISABLE_PERSISTENCE` opt-out** — Env flag skips both load and save. Useful for CI, sandboxed containers, or users who don't want a state file.

## 0.23.0 — 2026-04-18

- **Cross-session persistence** — Learning counts (`succeeded`/`dispatched`/`lastUsedAt` per namespace) and pack history (co-activation chains) now round-trip through `~/.mcph/state.json`. Schema-versioned, atomic write-rename.

## 0.22.0 — 2026-04-17

- **Inline usage hints in `discover()`** — `used Nx` success counts and "often loaded with X, Y" co-activation peers are surfaced per-server in discover output.

## 0.21.0 — 2026-04-17

- **Concurrent server cap** — Default max 6 simultaneously-active servers; `MCPH_SERVER_CAP` env override. Hard cap both as context protection and a business lever.

## 0.20.0 — 2026-04-17

- **`mcp_connect_read_tool`** — Schema-on-demand: return a single tool's schema + docs without activating its server. For servers with large tool catalogs where the model only needs 1–2 tools, reads 1–2 schemas instead of loading the entire catalog.

## 0.19.x and earlier

- v0.19.0 — internal refactor around config reconciliation.
- v0.18.0 — analytics uploads for tool-call patterns, load/unload events, error rates.
- v0.17.0 — resource + prompt proxying (beyond tools).
- v0.16.0 — error tracking surfaced in `discover()`.
- v0.15.x — `install` command gates success on config refresh; misc fixes.
- v0.14.0 — auto-allow mcph tools in Claude Code settings + discover dedup.
- v0.13.0 — deferred tools: advertise inactive-but-cached servers in `tools/list`.
- v0.12.x — legacy-config migrator + `doctor` freshness checks.
- v0.11.x — stability patches.
- v0.10.x — 7-feature bundle, adaptive routing, policy profiles.
- v0.9.0 — `mcph compliance` subcommand.
- v0.8.0 — runtime detection + test runner + error deep-links.
- v0.7.0 — two-stage retrieval: BM25 + semantic rerank.
- v0.6.0 — BM25 dispatch + auto-warm discover + stderr capture.
- v0.5.0 — `MCPH_POLL_INTERVAL` env var.
- v0.1.x – v0.4.x — initial public release, core meta-tools, namespace routing, config polling.
