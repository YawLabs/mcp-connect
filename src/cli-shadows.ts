// Static registry: which MCP server namespaces shadow which local CLIs.
//
// Used by:
//   - discover: surface "this server shadows `<cli>`" per candidate
//   - guide: auto-generated "Active servers" section appended to MCPH.md
//   - doctor: scan shell history for shadowed-CLI invocations
//
// Covers every slug in the mcp.hosting Explore catalog so a user who
// imports from the catalog with the default namespace gets the hint
// with no configuration. Namespace keys are lowercased at lookup time.
// Well-known alias namespaces (gh, k8s, pg, …) are also registered so
// a user who renamed the server on import still matches. For custom
// namespaces, a tool-name heuristic (shared lowercase prefix across
// three or more tool-cache entries) catches the common CLI prefixes.
// Beyond that, the user can document the mapping in their MCPH.md and
// that copy is authoritative.

import type { UpstreamServerConfig } from "./types.js";

export interface CliShadow {
  /** The local CLI this server shadows (e.g. "npm", "tailscale"). */
  cli: string;
  /** Optional subset of subcommands the server specifically covers.
   *  Undefined means "the CLI's read/admin surface generally". */
  subcommands?: string[];
}

// Empty array means "known MCP server, nothing useful to shadow" —
// e.g. API-only services (Notion, Firecrawl, Linear) with no
// widely-used CLI. Declaring them explicitly keeps the heuristic from
// inferring a wrong shadow from the tool-name prefix.
const EMPTY: readonly CliShadow[] = [];

// Namespace → shadowed CLI(s). Keys cover every catalog slug plus
// common aliases. Subcommand lists are only filled in where the MCP
// server meaningfully restricts itself to a subset (e.g. npmjs is a
// read/admin-only surface, not `npm install`).
const NAMESPACE_REGISTRY: Record<string, readonly CliShadow[]> = {
  // —— Dev / code —————————————————————————————————————————————
  github: [{ cli: "gh" }],
  gh: [{ cli: "gh" }],
  gitlab: [{ cli: "glab" }],
  glab: [{ cli: "glab" }],
  ssh: [{ cli: "ssh" }, { cli: "scp" }],
  playwright: [{ cli: "playwright" }],
  puppeteer: EMPTY,
  electron: EMPTY,
  sentry: [{ cli: "sentry-cli" }],

  // —— npm / package registries ——————————————————————————————————
  npmjs: [
    {
      cli: "npm",
      subcommands: ["search", "view", "info", "audit", "owner", "deprecate", "dist-tag", "whoami", "profile", "token"],
    },
  ],
  npm: [
    {
      cli: "npm",
      subcommands: ["search", "view", "audit", "owner", "deprecate", "dist-tag"],
    },
  ],

  // —— Databases ——————————————————————————————————————————————
  postgres: [{ cli: "psql" }, { cli: "pg_dump" }],
  pg: [{ cli: "psql" }, { cli: "pg_dump" }],
  sqlite: [{ cli: "sqlite3" }],
  mongodb: [{ cli: "mongosh" }, { cli: "mongodump" }],
  mongo: [{ cli: "mongosh" }],
  supabase: [{ cli: "supabase" }],

  // —— Infra / ops ————————————————————————————————————————————
  tailscale: [{ cli: "tailscale" }],
  kubernetes: [{ cli: "kubectl" }],
  kubectl: [{ cli: "kubectl" }],
  k8s: [{ cli: "kubectl" }],
  caddy: [{ cli: "caddy" }],
  cloudflare: [{ cli: "wrangler" }],
  wrangler: [{ cli: "wrangler" }],
  vercel: [{ cli: "vercel" }],
  "aws-api": [{ cli: "aws" }],
  aws: [{ cli: "aws" }],
  "aws-knowledge": EMPTY,
  "aws-pricing": EMPTY,
  grafana: EMPTY,

  // —— YawLabs tools —————————————————————————————————————————
  ctxlint: [{ cli: "ctxlint" }],
  "mcp-compliance": [{ cli: "mcp-compliance" }],

  // —— Data / observability —————————————————————————————————————
  posthog: EMPTY,
  honeycomb: EMPTY,

  // —— Payments / commerce ——————————————————————————————————————
  stripe: [{ cli: "stripe" }],
  shopify: [{ cli: "shopify" }],
  lemonsqueezy: EMPTY,
  hubspot: EMPTY,

  // —— Comms / productivity ——————————————————————————————————————
  slack: [{ cli: "slack" }],
  discord: EMPTY,
  twilio: [{ cli: "twilio" }],
  elevenlabs: EMPTY,
  notion: EMPTY,
  linear: EMPTY,
  figma: EMPTY,
  atlassian: EMPTY,
  airtable: EMPTY,
  obsidian: EMPTY,
  "google-workspace": EMPTY,
  "google-maps": EMPTY,

  // —— Search / web —————————————————————————————————————————————
  "brave-search": EMPTY,
  firecrawl: EMPTY,
  exa: EMPTY,
  fetch: [{ cli: "curl" }, { cli: "wget" }],

  // —— Filesystem / local tools ——————————————————————————————————
  filesystem: EMPTY,
  memory: EMPTY,
  "sequential-thinking": EMPTY,
  time: EMPTY,
  context7: EMPTY,

  // —— Identity / secrets ————————————————————————————————————————
  "1password": [{ cli: "op" }],
  op: [{ cli: "op" }],
};

// Prefixes the tool-name heuristic will trust. A tool cache whose
// entries all share one of these as their first segment is treated as
// shadowing that CLI. Intentionally narrow: broad prefixes ("get",
// "set", "list") would generate false positives.
const KNOWN_CLI_PREFIXES = new Set<string>([
  "npm",
  "tailscale",
  "gh",
  "aws",
  "kubectl",
  "docker",
  "psql",
  "mongosh",
  "redis",
  "stripe",
  "heroku",
  "supabase",
  "flyctl",
  "shopify",
  "vercel",
  "wrangler",
  "twilio",
  "caddy",
  "playwright",
  "sqlite3",
  "glab",
  "op",
]);

export function resolveShadowedClis(server: Pick<UpstreamServerConfig, "namespace" | "toolCache">): CliShadow[] {
  const direct = NAMESPACE_REGISTRY[server.namespace.toLowerCase()];
  if (direct !== undefined) return [...direct];

  // Heuristic fallback — look for a single common lowercase prefix
  // across the tool cache. Needs at least three tools to trust it; a
  // server with one or two tools could share a prefix by coincidence.
  const cache = server.toolCache ?? [];
  if (cache.length < 3) return [];
  const prefixes = new Set<string>();
  for (const t of cache) {
    const first = t.name.split(/[_.\-]/)[0];
    if (first) prefixes.add(first.toLowerCase());
  }
  if (prefixes.size !== 1) return [];
  const only = [...prefixes][0];
  return KNOWN_CLI_PREFIXES.has(only) ? [{ cli: only }] : [];
}

/** Return the set of CLI binary names shadowed by the given server.
 *  Convenience wrapper for callers that don't care about subcommands —
 *  e.g. the doctor shell-history scan's first-pass match. */
export function shadowedCliNames(server: Pick<UpstreamServerConfig, "namespace" | "toolCache">): string[] {
  return resolveShadowedClis(server).map((s) => s.cli);
}

/** Reverse index: CLI binary name → namespaces that shadow it. Built
 *  lazily from NAMESPACE_REGISTRY. Used by doctor's shell-history scan
 *  so a bash line starting with `npm` can be pointed back at the
 *  `npmjs` MCP server (and vice versa). */
let reverseIndexCache: Map<string, string[]> | null = null;
export function cliToNamespaces(): Map<string, string[]> {
  if (reverseIndexCache !== null) return reverseIndexCache;
  const map = new Map<string, string[]>();
  for (const [namespace, shadows] of Object.entries(NAMESPACE_REGISTRY)) {
    for (const s of shadows) {
      const list = map.get(s.cli) ?? [];
      if (!list.includes(namespace)) list.push(namespace);
      map.set(s.cli, list);
    }
  }
  reverseIndexCache = map;
  return map;
}

/** Format a single server's shadow info as one human line. Used by
 *  discover + the guide auto-section. Returns null when the server
 *  shadows nothing — callers skip the line entirely. */
export function formatShadowLine(server: Pick<UpstreamServerConfig, "namespace" | "toolCache">): string | null {
  const shadows = resolveShadowedClis(server);
  if (shadows.length === 0) return null;
  const parts = shadows.map((s) => {
    if (s.subcommands && s.subcommands.length > 0) {
      return `\`${s.cli}\` (${s.subcommands.join(", ")})`;
    }
    return `\`${s.cli}\``;
  });
  return `prefer over local CLI: ${parts.join(", ")}`;
}
