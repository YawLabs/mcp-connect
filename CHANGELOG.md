# Changelog

All notable changes to `@yawlabs/mcph` are documented here. This project uses [semantic versioning](https://semver.org) and a CI-gated release flow: pushing a `vX.Y.Z` tag triggers `.github/workflows/release.yml`, which publishes to npm.

## Unreleased

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
