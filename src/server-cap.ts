// Concurrent server cap. Puts a hard ceiling on how many MCP servers
// can be simultaneously loaded in a session so a chatty LLM doesn't
// balloon its own context by activating twelve servers "just in case."
// The idle auto-unload (see idle-ttl.ts) already trims unused servers
// after N non-matching tool calls, but that's reactive — a burst of
// activations in a short window can still inflate context past what
// the LLM can reason about before any auto-unload fires. This cap
// refuses the activation at the door instead.
//
// Default is 6 — large enough for the common "2-3 task areas, each
// with 1-2 servers" shape, small enough to keep tool-list tokens
// bounded. Ops can raise or lower via MCPH_SERVER_CAP.

export const DEFAULT_SERVER_CAP = 6;

// 0 disables the cap entirely (for ops/tests); any positive integer
// overrides the default. Invalid values fall back to the default
// rather than erroring — a typo in env shouldn't brick activations.
export function resolveServerCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MCPH_SERVER_CAP;
  if (raw === undefined || raw === "") return DEFAULT_SERVER_CAP;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SERVER_CAP;
  return n;
}

export interface LoadedSlot {
  namespace: string;
  idleCount: number;
}

export interface CapDecision {
  allow: boolean;
  message?: string;
}

// Decide whether to permit activating `namespace` given the set of
// currently-loaded slots and the cap. Returns a helpful error message
// when refused so the LLM can course-correct without a follow-up
// discover roundtrip.
//
// Ordering: the error lists loaded servers by descending idleCount
// (most-idle first) so the LLM's attention lands on the cheapest
// thing to drop, followed by read_tool as a zero-activation fallback.
export function evaluateServerCap(namespace: string, loaded: LoadedSlot[], cap: number): CapDecision {
  if (cap === 0) return { allow: true }; // disabled
  if (loaded.some((s) => s.namespace === namespace)) return { allow: true }; // already counts
  if (loaded.length < cap) return { allow: true };

  const sorted = [...loaded].sort((a, b) => {
    if (b.idleCount !== a.idleCount) return b.idleCount - a.idleCount;
    return a.namespace.localeCompare(b.namespace);
  });
  const list = sorted
    .map((s) => (s.idleCount > 0 ? `"${s.namespace}" (idle ${s.idleCount})` : `"${s.namespace}"`))
    .join(", ");

  return {
    allow: false,
    message: `Cannot load "${namespace}" — already at the ${cap}-server concurrent cap. Loaded: ${list}. Free a slot with mcp_connect_deactivate, or use mcp_connect_read_tool to inspect one tool without loading its server. Ops can change the limit via MCPH_SERVER_CAP.`,
  };
}
