import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { log } from "./logger.js";
import type { UpstreamServerConfig } from "./types.js";

// Top-2 scores within this ratio of each other trigger a sampling
// tiebreak. 0.9 means "runner-up scored ≥90% of the leader" — if the
// gap is wider than that, BM25+rerank is confident enough on its own.
export const SAMPLING_TIEBREAK_RATIO = 0.9;

// Small budget — the LLM's job here is to name one candidate, not to
// write an essay. Room for a short rationale.
const SAMPLING_MAX_TOKENS = 120;

export interface TiebreakCandidate {
  namespace: string;
  score: number;
  description?: string;
  tools: Array<{ name: string; description?: string }>;
}

// Decide whether the ranked list is close enough at the top to warrant
// consulting the LLM. Single-candidate and wide-margin cases skip the
// round-trip — sampling isn't free.
export function shouldTiebreak(
  ranked: Array<{ namespace: string; score: number }>,
  ratio: number = SAMPLING_TIEBREAK_RATIO,
): boolean {
  if (ranked.length < 2) return false;
  const [top, second] = ranked;
  if (!top || !second || top.score <= 0) return false;
  return second.score / top.score >= ratio;
}

// Build a compact prompt describing the candidate servers. Keep it
// under a few hundred tokens so the sampling round-trip is cheap.
export function buildTiebreakPrompt(intent: string, candidates: TiebreakCandidate[]): string {
  const blocks = candidates.map((c, i) => {
    const toolLine =
      c.tools.length > 0
        ? c.tools
            .slice(0, 8)
            .map((t) => t.name)
            .join(", ")
        : "(no tool metadata yet)";
    return `${i + 1}. ${c.namespace}${c.description ? ` — ${c.description}` : ""}\n   tools: ${toolLine}`;
  });
  return [
    "You are a router picking the best MCP server for a user task.",
    `User intent: ${intent}`,
    "",
    "Candidates:",
    ...blocks,
    "",
    'Reply with ONLY the chosen server\'s namespace on the first line (e.g. "github"). No quotes, no explanation.',
  ].join("\n");
}

// Extract the chosen namespace from the LLM's free-text response. The
// prompt asks for just the namespace, but LLMs sometimes add prose —
// scan each non-empty line against the candidate list, prefer the
// first match. Returns null if no candidate appears in the response.
export function parseTiebreakResponse(response: string, candidates: TiebreakCandidate[]): string | null {
  const namespaces = new Set(candidates.map((c) => c.namespace));
  for (const rawLine of response.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[`"'*>\-\s]+|[`"'*\s]+$/g, "");
    if (!line) continue;
    if (namespaces.has(line)) return line;
    // Allow inline mentions like "I pick github because..."
    for (const ns of namespaces) {
      const re = new RegExp(`\\b${escapeRegex(ns)}\\b`);
      if (re.test(line)) return ns;
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Ask the client LLM to pick a winner among the top-tied candidates.
// Returns the chosen namespace, or null if sampling is unsupported,
// declined, failed, or the response doesn't name any candidate.
// Never throws — a bad tiebreak just falls back to the ranker's order.
export async function tiebreakViaSampling(
  server: Server,
  intent: string,
  candidates: TiebreakCandidate[],
): Promise<string | null> {
  const caps = server.getClientCapabilities();
  if (!caps?.sampling) return null;
  if (candidates.length < 2) return null;

  const prompt = buildTiebreakPrompt(intent, candidates);
  try {
    const result = await server.createMessage({
      messages: [{ role: "user", content: { type: "text", text: prompt } }],
      maxTokens: SAMPLING_MAX_TOKENS,
      // Hint that we want a cheap, fast response.
      includeContext: "none",
    });
    const text =
      result && typeof result === "object" && "content" in result && result.content ? extractText(result.content) : "";
    if (!text) return null;
    return parseTiebreakResponse(text, candidates);
  } catch (err) {
    log("warn", "Sampling tiebreak failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// createMessage can return content as a single block or an array (when
// the LLM used tools). For tiebreak we only care about text; collect
// any text blocks we find and join them.
function extractText(content: unknown): string {
  if (!content) return "";
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && "type" in c && c.type === "text" && "text" in c ? String(c.text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object" && content !== null && "type" in content) {
    const block = content as { type: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

// Build TiebreakCandidate descriptors for a subset of servers sharing
// the top of the ranking. Caller feeds us the ranked list and the raw
// servers so we can attach descriptions + tool metadata.
export function buildCandidates(
  topRanked: Array<{ namespace: string; score: number }>,
  serversByNamespace: Map<string, UpstreamServerConfig>,
  toolsByNamespace: Map<string, Array<{ name: string; description?: string }>>,
): TiebreakCandidate[] {
  const out: TiebreakCandidate[] = [];
  for (const r of topRanked) {
    const server = serversByNamespace.get(r.namespace);
    if (!server) continue;
    const candidate: TiebreakCandidate = {
      namespace: r.namespace,
      score: r.score,
      tools: toolsByNamespace.get(r.namespace) ?? server.toolCache ?? [],
    };
    if (server.description) candidate.description = server.description;
    out.push(candidate);
  }
  return out;
}
