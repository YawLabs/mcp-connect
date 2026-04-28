import type { NamespaceUsage } from "./learning.js";
import type { DetectedPack } from "./pack-detect.js";

// Inline usage hints for discover() output. Two signals:
//
//   1. Success count from LearningStore — "you called a tool on this
//      server N times and it worked." Populated on the proxy path in
//      handleToolCall: every routed tool call where the upstream
//      replied without isError. Activation alone doesn't contribute.
//
//   2. Co-activation peers from PackDetector — "when you loaded X
//      you usually had Y loaded too." Populated by successful proxied
//      tool calls across ≥2 distinct namespaces within a short gap.
//
// Both signals persist across mcph restarts via ~/.mcph/state.json
// (see persistence.ts) so a freshly-started session still knows which
// servers the user has been relying on. Counts reflect cumulative
// successful use since persistence started, not just the live process.
// Set MCPH_DISABLE_PERSISTENCE=1 to keep signals session-local only.

// Cap on peers per hint. Keeps the discover() line length bounded —
// more than ~3 peers quickly drowns out the rest of the server card.
const MAX_PEERS = 3;
const MIN_SUCCESS_TO_SHOW = 1;

// Thresholds for the dormant-reliability hint. Exported so
// handleHealth and `mcph doctor` can share the same "what counts as
// flaky" definition — otherwise the various views would disagree about
// which namespaces qualify and the LLM / operator ends up confused.
export const RELIABILITY_MIN_OBSERVATIONS = 3;
export const RELIABILITY_THRESHOLD = 0.8;

// Flatten detected packs into a per-namespace peer list. Each pack is
// a set of 2-3 namespaces that co-occurred in ≥2 bursts; the map
// entry for namespace N lists every OTHER namespace that appeared in
// any pack containing N.
//
// Output is sorted + deduped so rendering is stable across calls even
// as the underlying pack list's internal order shifts.
export function buildCoUsageMap(packs: DetectedPack[]): Map<string, string[]> {
  const result = new Map<string, Set<string>>();
  for (const pack of packs) {
    for (const ns of pack.namespaces) {
      const bucket = result.get(ns) ?? new Set<string>();
      for (const peer of pack.namespaces) {
        if (peer !== ns) bucket.add(peer);
      }
      result.set(ns, bucket);
    }
  }
  const sorted = new Map<string, string[]>();
  for (const [ns, peers] of result) {
    sorted.set(ns, Array.from(peers).sort());
  }
  return sorted;
}

// Render a one-line "usage:" hint summarizing the two signals. Returns
// null when neither signal has enough evidence — the caller should
// skip the line entirely rather than print "usage: —" or similar.
//
// The string form starts with "usage: " so the LLM can scan past it
// cheaply and the prefix is consistent with other diagnostic lines
// (warn:, known tools:).
export function formatUsageHint(usage: NamespaceUsage | undefined, coUsedWith: string[]): string | null {
  const parts: string[] = [];
  if (usage && usage.succeeded >= MIN_SUCCESS_TO_SHOW) {
    // No "this session" qualifier: with cross-session persistence the
    // count is cumulative (restored from state.json on startup). Tacking
    // "this session" on overclaims freshness; dropping it is both
    // shorter and accurate in both persistence-on and opt-out states.
    parts.push(`used ${usage.succeeded}x`);
  }
  if (coUsedWith.length > 0) {
    const shown = coUsedWith.slice(0, MAX_PEERS);
    const more = coUsedWith.length - shown.length;
    const names = shown.map((n) => `"${n}"`).join(", ");
    const tail = more > 0 ? ` +${more} more` : "";
    parts.push(`often loaded with ${names}${tail}`);
  }
  if (parts.length === 0) return null;
  return `usage: ${parts.join("; ")}`;
}

// Dormant-reliability warning rendered inline under the server card in
// discover(). Returns null unless the persisted learning for this
// namespace shows ≥3 dispatches AND <80% success. Caller is responsible
// for suppressing this when the server is currently loaded (the live
// health warning takes precedence there — see formatHealthWarning).
export function formatReliabilityWarning(usage: NamespaceUsage | undefined): string | null {
  if (!usage || usage.dispatched < RELIABILITY_MIN_OBSERVATIONS) return null;
  const rate = usage.succeeded / usage.dispatched;
  if (rate >= RELIABILITY_THRESHOLD) return null;
  const pct = Math.round(rate * 100);
  return `reliability: ${pct}% success across ${usage.dispatched} past calls`;
}

export interface FlakyNamespaceEntry {
  namespace: string;
  usage: NamespaceUsage;
}

// Shared selector for the flaky-namespace lists shown by handleHealth
// and `mcph doctor`'s RELIABILITY section. Filter rules are the same as
// formatReliabilityWarning; sort is worst-rate first, tie-break by most
// calls (more evidence = more credible), then alphabetical so output is
// deterministic. Caller passes any pre-filter (e.g., handleHealth
// excludes currently-connected namespaces).
export function selectFlakyNamespaces(entries: Iterable<FlakyNamespaceEntry>, limit: number): FlakyNamespaceEntry[] {
  if (limit <= 0) return [];
  return Array.from(entries)
    .filter(({ usage }) => {
      if (usage.dispatched < RELIABILITY_MIN_OBSERVATIONS) return false;
      return usage.succeeded / usage.dispatched < RELIABILITY_THRESHOLD;
    })
    .sort((a, b) => {
      const aRate = a.usage.succeeded / a.usage.dispatched;
      const bRate = b.usage.succeeded / b.usage.dispatched;
      if (aRate !== bRate) return aRate - bRate;
      if (a.usage.dispatched !== b.usage.dispatched) return b.usage.dispatched - a.usage.dispatched;
      return a.namespace.localeCompare(b.namespace);
    })
    .slice(0, limit);
}
