import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CreateMessageRequestParamsBase } from "@modelcontextprotocol/sdk/types.js";
import { log } from "./logger.js";
import { capForPrompt, INTENT_MAX } from "./reward-grader.js";
import type { UpstreamServerConfig } from "./types.js";

// Top-2 scores within this ratio of each other trigger a sampling
// tiebreak. 0.9 means "runner-up scored ≥90% of the leader" — if the
// gap is wider than that, BM25+rerank is confident enough on its own.
export const SAMPLING_TIEBREAK_RATIO = 0.9;

// Small budget — the LLM's job here is to name one candidate, not to
// write an essay. Room for a short rationale.
const SAMPLING_MAX_TOKENS = 120;

// Hard ceiling on best-of-N samples. N is clamped into [1, MAX_SAMPLES]
// so a misconfigured effort dial can never fan out unboundedly.
export const MAX_SAMPLES = 5;

// Wall-clock budget for the whole best-of-N aggregate (all N calls
// combined), so added latency stays bounded regardless of N. On timeout
// we fall back to the ranker's order.
export const SAMPLING_TIMEOUT_MS = 2000;

// Temperature asked for on a best-of-N fan-out (n > 1) only. N byte-identical
// requests to a deterministic client come back N identical answers, so the
// majority vote is unanimous by construction and "aggressive" pays N times the
// cost for exactly the information one sample already had. A non-zero
// temperature is what gives the samples a reason to differ. Deliberately NOT
// sent at n=1: the "auto" path keeps the client's own default, so the default
// dispatch path is unchanged by the dial.
export const BEST_OF_N_TEMPERATURE = 0.7;

// Ambiguity threshold for the "aggressive" effort gate. "auto" does NOT use
// this -- it delegates to shouldTiebreak (the exact pre-dial 0.9 top-2 ratio)
// so the default path's sampling frequency is unchanged. Only "aggressive"
// samples on the broader entropy-aware ambiguity signal, at a lower bar.
//
// NOT a fixed top-2 ratio: computeAmbiguity returns max(inverse margin,
// normalized entropy), and the entropy half is normalized by
// Math.log(topK.length) -- so the number of candidates in the top-K moves the
// effective bar. Worked example at this 0.6 setting, on shapes the sole
// production caller can actually produce (rankServers drops every zero-scored
// server, so a ranked list reaching here carries only positive scores): with
// exactly TWO candidates a runner-up scoring ~20% of the leader already yields
// ~0.65 and samples; add a THIRD candidate at ~5% of the leader and the same
// top-2 shape divides by log(3) instead of log(2), lands at ~0.55, and does
// not. Read this constant as "how flat the top-K is", not "how close the
// runner-up is". Both shapes are pinned by value in sampling-rank.test.ts.
export const AGGRESSIVE_AMBIGUITY_THRESHOLD = 0.6;

export interface TiebreakCandidate {
  namespace: string;
  score: number;
  description?: string;
  tools: Array<{ name: string; description?: string }>;
}

// Decide whether the ranked list is close enough at the top to warrant
// consulting the LLM. Single-candidate and wide-margin cases skip the
// round-trip — sampling isn't free.
//
// `ratio` has no production caller: server.ts reaches this through
// shouldSample, which always takes the SAMPLING_TIEBREAK_RATIO default. It is
// a tuning seam -- a threshold sweep can vary it without editing this module
// -- and sampling-rank.test.ts exercises it explicitly so the parameter is not
// silently dead weight.
export function shouldTiebreak(
  ranked: Array<{ namespace: string; score: number }>,
  ratio: number = SAMPLING_TIEBREAK_RATIO,
): boolean {
  if (ranked.length < 2) return false;
  const [top, second] = ranked;
  if (!top || !second || top.score <= 0) return false;
  return second.score / top.score >= ratio;
}

// Cap on each candidate description interpolated into the tiebreak prompt.
// Descriptions arrive from local-bundles.ts with no length bound of their own,
// and the prompt asks for one namespace word back, so a paragraph-long
// description is tokens the vote cannot use.
export const CANDIDATE_DESCRIPTION_MAX = 300;

// The cut helper is reward-grader's capForPrompt (imported above): one rule
// for both sampling prompts, and one that never leaves a lone surrogate.

// Build a compact prompt describing the candidate servers. Keep it
// under a few hundred tokens so the sampling round-trip is cheap.
//
// The intent and every description are length-capped HERE, not by the caller:
// server.ts's handleDispatch rejects only an EMPTY intent and passes the rest
// verbatim, and under the "aggressive" effort dial this prompt goes out up to
// MAX_SAMPLES times per dispatch, each billed to the client's sampling budget.
// A pasted document as the intent used to ride along in full on every one of
// those calls, for a reply the prompt limits to a single namespace word.
// INTENT_MAX is reward-grader.ts's, which closed the same gap for the same
// field; the two prompts share one bound so they cannot drift apart.
export function buildTiebreakPrompt(intent: string, candidates: TiebreakCandidate[]): string {
  const blocks = candidates.map((c, i) => {
    const toolLine =
      c.tools.length > 0
        ? c.tools
            .slice(0, 8)
            .map((t) => t.name)
            .join(", ")
        : "(no tool metadata yet)";
    const desc = c.description ? ` -- ${capForPrompt(c.description, CANDIDATE_DESCRIPTION_MAX)}` : "";
    return `${i + 1}. ${c.namespace}${desc}\n   tools: ${toolLine}`;
  });
  return [
    "You are a router picking the best MCP server for a user task.",
    `User intent: ${capForPrompt(intent, INTENT_MAX)}`,
    "",
    "Candidates:",
    ...blocks,
    "",
    'Reply with ONLY the chosen server\'s namespace on the first line (e.g. "github"). No quotes, no explanation.',
  ].join("\n");
}

// Extract the chosen namespace from the LLM's free-text response. The
// prompt asks for just the namespace, but LLMs sometimes add prose --
// scan each non-empty line against the candidate list. Within a single
// line we pick whichever candidate appears earliest (by character
// index); a response like "I prefer gitlab over github" must return
// "gitlab", not the first candidate iterated. Returns null if no
// candidate appears anywhere.
export function parseTiebreakResponse(response: string, candidates: TiebreakCandidate[]): string | null {
  const namespaces = candidates.map((c) => c.namespace);
  // Case-insensitive match: LLMs occasionally title-case or upper-case the
  // namespace ("Github", "GITHUB"); the canonical form remains the lowercased
  // namespace in the candidate list.
  const namespaceSet = new Set(namespaces.map((n) => n.toLowerCase()));
  for (const rawLine of response.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[`"'*>\-\s]+|[`"'*\s]+$/g, "");
    if (!line) continue;
    if (namespaceSet.has(line.toLowerCase())) {
      // Return the canonical-cased namespace from the candidate list.
      const idx = namespaces.findIndex((n) => n.toLowerCase() === line.toLowerCase());
      if (idx >= 0) return namespaces[idx]!;
    }
    // Allow inline mentions like "I pick github because..." -- pick the
    // earliest-positioned candidate so the LLM's lexical choice wins
    // even when iteration order says otherwise.
    //
    // Position ties are broken by LENGTH, longest first. `\b` treats '-'
    // (and '+', '.', etc.) as a word boundary, so when one namespace is a
    // prefix of another under that rule -- "aws-s3" vs "aws-s3-tools" --
    // BOTH match at the same index in "use aws-s3-tools". Without the
    // length tiebreak the winner would be whichever happened to be
    // iterated first, silently misparsing the LLM's pick as the shorter
    // namespace. Longest-match-wins makes the exact mention win.
    //
    // Reachability note: today's NAMESPACE_RE (local-bundles.ts) is
    // /^[a-z][a-z0-9_]{0,29}$/ -- '-' is NOT a legal namespace character, and
    // '_' IS a word character, so in the canonical shape ("aws_s3" vs
    // "aws_s3_tools") `\b` cannot fire mid-name and only the longer namespace
    // matches at all. The tie this branch resolves therefore needs a
    // separator NAMESPACE_RE currently forbids; it is kept because relaxing
    // that regex to allow '-' would otherwise silently change which
    // namespace an inline mention resolves to. Both shapes are pinned in
    // sampling-rank.test.ts so an edit to either side has to face a test.
    let bestNs: string | null = null;
    let bestPos = Number.POSITIVE_INFINITY;
    for (const ns of namespaces) {
      const re = new RegExp(`\\b${escapeRegex(ns)}\\b`, "i");
      const match = re.exec(line);
      if (!match) continue;
      if (match.index < bestPos || (match.index === bestPos && bestNs !== null && ns.length > bestNs.length)) {
        bestPos = match.index;
        bestNs = ns;
      }
    }
    if (bestNs) return bestNs;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

// =============================================================================
// Effort dial: test-time-compute routing (idea 5)
//
// A coarse "how hard should the router try" knob layered on top of the
// existing tiebreak. "off" disables LLM sampling entirely; "auto" preserves
// today's behavior (one sample only on genuine ambiguity); "aggressive"
// samples sooner and fans out to best-of-N for a sturdier vote.
// =============================================================================

export type RouteEffort = "off" | "auto" | "aggressive";

// Parse YAW_MCP_ROUTE_EFFORT, or dispatch's per-call `routeEffort` argument.
// Default "auto". Unknown values fall back to "auto" so a typo never silently
// disables routing or burns compute.
//
// Precedence: the sole production caller (server.ts) passes the per-call
// argument first and only falls back to the env var when the argument is
// ABSENT. An unrecognized argument used to land in the "auto" default here,
// so a typo'd `routeEffort: "aggresive"` silently downgraded a deliberate
// YAW_MCP_ROUTE_EFFORT=aggressive deployment for that call. `fallbackRaw`
// closes that: a present-but-unrecognized `raw` is re-resolved against the
// environment before defaulting. An absent or empty `raw` is NOT re-resolved
// -- the caller has already collapsed that case into `raw` -- so
// parseRouteEffort(undefined) stays environment-independent.
export function parseRouteEffort(
  raw: string | undefined,
  fallbackRaw: string | undefined = process.env.YAW_MCP_ROUTE_EFFORT,
): RouteEffort {
  const direct = matchRouteEffort(raw);
  if (direct) return direct;
  if (raw !== undefined && raw.trim() !== "") {
    // Present but unrecognized -> a typo, not a choice. Prefer the
    // environment's setting over the "auto" default.
    const fromEnv = matchRouteEffort(fallbackRaw);
    if (fromEnv) return fromEnv;
  }
  return "auto";
}

// Match one effort spelling, case- and whitespace-insensitively. Returns null
// (rather than "auto") for anything unrecognized, so the caller can tell an
// explicit "auto" from a value it failed to understand.
function matchRouteEffort(raw: string | undefined): RouteEffort | null {
  if (raw === undefined) return null;
  switch (raw.trim().toLowerCase()) {
    case "off":
      return "off";
    case "auto":
      return "auto";
    case "aggressive":
      return "aggressive";
    default:
      // Includes the empty string and anything unrecognized.
      return null;
  }
}

// Measure how ambiguous the top of the ranking is, on [0,1]. We combine two
// independent signals over the top-K and take the larger (more cautious):
//
//   1. Top-2 closeness: ranked[1].score / ranked[0].score. A wide gap -> near
//      0; a near-tie -> near 1. (The "inverse top-2 margin" — high when the
//      margin between the leaders is small, i.e. the result is ambiguous.)
//   2. Normalized Shannon entropy of the top-K scores (normalized to a
//      probability distribution): one dominant score -> ~0; a flat spread
//      across K -> ~1.
//
// 0 means one clear winner; 1 means flat/ambiguous. Degenerate inputs
// (fewer than 2 candidates, non-positive leader score) return 0 — nothing to
// disambiguate.
//
// `k` has no production caller (shouldSample takes the default), but it is
// load-bearing: log(topK.length) is the entropy normalizer, so the default
// decides how often "aggressive" spends a best-of-N fan-out. Kept as a tuning
// seam and pinned by value in sampling-rank.test.ts, since a silent 3 -> 2
// change here is invisible to every other assertion in the suite.
export function computeAmbiguity(ranked: Array<{ namespace: string; score: number }>, k = 3): number {
  if (ranked.length < 2) return 0;
  const top = ranked[0];
  if (!top || top.score <= 0) return 0;

  const topK = ranked.slice(0, Math.max(2, k));

  // Signal 1: top-2 closeness (inverse margin). The closer the runner-up's
  // score is to the leader's, the higher the ambiguity. Clamp into [0,1] — a
  // runner-up can't legitimately outscore the leader, but guard float noise.
  const second = topK[1];
  const secondScore = second ? second.score : 0;
  const inverseMargin = Math.min(1, Math.max(0, secondScore / top.score));

  // Signal 2: normalized Shannon entropy. Treat non-positive scores as 0
  // mass. If every score is non-positive (can't happen given top>0) the
  // distribution is empty -> 0.
  const weights = topK.map((c) => Math.max(0, c.score));
  const total = weights.reduce((a, b) => a + b, 0);
  let entropy = 0;
  if (total > 0 && topK.length >= 2) {
    let h = 0;
    for (const w of weights) {
      if (w <= 0) continue;
      const p = w / total;
      h -= p * Math.log(p);
    }
    // Normalize by log(K) so a perfectly flat distribution maps to 1.
    const maxH = Math.log(topK.length);
    entropy = maxH > 0 ? h / maxH : 0;
  }

  return Math.max(inverseMargin, entropy);
}

// Effort-aware gate deciding whether to spend an LLM round-trip on this
// ranking. Pure; no I/O. "off" never samples. "auto" preserves the historical
// fixed-ratio tiebreak EXACTLY (delegates to shouldTiebreak: sample only when
// the runner-up scored >= SAMPLING_TIEBREAK_RATIO of the leader), so the
// DEFAULT path's sampling frequency is unchanged by the dial. Only
// "aggressive" uses the broader entropy-aware ambiguity gate, at a lower bar.
export function shouldSample(ranked: Array<{ namespace: string; score: number }>, effort: RouteEffort): boolean {
  if (effort === "off") return false;
  if (effort === "auto") return shouldTiebreak(ranked);
  return computeAmbiguity(ranked) >= AGGRESSIVE_AMBIGUITY_THRESHOLD;
}

// Map an effort level to the number of best-of-N samples. "auto" stays at a
// single sample so default latency matches today's tiebreak; "aggressive"
// fans out to 3. "off" never reaches here, but maps to 0 for completeness.
export function sampleCountForEffort(effort: RouteEffort): number {
  switch (effort) {
    case "off":
      return 0;
    case "aggressive":
      return 3;
    default:
      return 1;
  }
}

// Best-of-N tiebreak: call the client LLM N times, majority-vote the parsed
// namespace, ties broken by ranker order (the first candidate in the list
// wins). N is clamped into [1, MAX_SAMPLES]. The whole aggregate is wrapped
// in a SAMPLING_TIMEOUT_MS race so total added latency is bounded regardless
// of N. This is the ONLY sampling entry point: n=1 is the plain single-sample
// tiebreak (server.ts's "auto" effort path), so there is no separate
// single-shot helper to keep in sync. On timeout, missing sampling capability,
// fewer than 2 candidates, or total failure it returns null and the caller
// falls back to the ranker's order — it never throws.
export async function bestOfNViaSampling(
  server: Server,
  intent: string,
  candidates: TiebreakCandidate[],
  n: number,
): Promise<string | null> {
  const caps = server.getClientCapabilities();
  if (!caps?.sampling) return null;
  if (candidates.length < 2) return null;

  const samples = Math.min(MAX_SAMPLES, Math.max(1, Math.floor(n)));
  const prompt = buildTiebreakPrompt(intent, candidates);

  // Identical for every sample, so build it once. temperature rides along only
  // when we actually fan out -- see BEST_OF_N_TEMPERATURE for why an
  // unanimous-by-construction vote is not worth N round-trips.
  const params: CreateMessageRequestParamsBase = {
    messages: [{ role: "user", content: { type: "text", text: prompt } }],
    maxTokens: SAMPLING_MAX_TOKENS,
    includeContext: "none",
  };
  if (samples > 1) params.temperature = BEST_OF_N_TEMPERATURE;

  // One controller for the whole call: aborted in the finally below, so
  // when the race resolves -- by timeout OR by the aggregate winning --
  // any still-in-flight createMessage requests are torn down with it.
  // Without this, a timed-out "aggressive" dispatch left up to
  // MAX_SAMPLES client-LLM requests running (and billed) to the SDK's
  // 60s default request timeout, their results discarded. The timeout
  // is also passed per request so the SDK enforces the same bound.
  const controller = new AbortController();

  // One sampling call -> parsed namespace or null. Never throws.
  const sampleOnce = async (): Promise<string | null> => {
    try {
      const result = await server.createMessage(params, { signal: controller.signal, timeout: SAMPLING_TIMEOUT_MS });
      const text =
        result && typeof result === "object" && "content" in result && result.content
          ? extractText(result.content)
          : "";
      if (!text) return null;
      return parseTiebreakResponse(text, candidates);
    } catch (err) {
      // Our own teardown, not a client-LLM failure: the finally below aborts
      // every still-in-flight sample once the race resolves, so on the timeout
      // path each pending request rejects AFTER bestOfNViaSampling has already
      // returned -- up to MAX_SAMPLES warn lines blaming the client LLM for
      // yaw-mcp cancelling it. The vote is over either way; drop it quietly.
      if (controller.signal.aborted) return null;
      log("warn", "Best-of-N sample failed", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };

  // Run all N samples concurrently, bounded by a single timeout for the
  // whole aggregate. A timeout resolves to null (fall back to ranker order).
  const aggregate = (async (): Promise<string | null> => {
    const results = await Promise.all(Array.from({ length: samples }, () => sampleOnce()));

    // Tally votes; track first-seen order so ranker order can break ties.
    const votes = new Map<string, number>();
    for (const ns of results) {
      if (!ns) continue;
      votes.set(ns, (votes.get(ns) ?? 0) + 1);
    }
    if (votes.size === 0) return null;

    // Rank position for tie-breaking: earlier candidate wins.
    const order = new Map<string, number>();
    candidates.forEach((c, i) => {
      order.set(c.namespace, i);
    });

    let winner: string | null = null;
    let bestVotes = -1;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const [ns, count] of votes) {
      const rank = order.get(ns) ?? Number.POSITIVE_INFINITY;
      if (count > bestVotes || (count === bestVotes && rank < bestRank)) {
        winner = ns;
        bestVotes = count;
        bestRank = rank;
      }
    }
    return winner;
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SAMPLING_TIMEOUT_MS);
  });

  try {
    return await Promise.race([aggregate, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // Tear down the losing samples with the race: on timeout this cancels
    // every in-flight request; on a normal win the aggregate has already
    // awaited all of them (Promise.all), so aborting is a no-op.
    controller.abort();
  }
}
