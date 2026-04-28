// Lightweight usage signal. Tracks how often each namespace's tools
// were called AND how often the upstream answered without isError,
// then exposes a bounded boost factor so future dispatches nudge
// toward servers that have been genuinely useful — and AWAY from
// servers that have been flaky.
//
// Recorded on the proxy path in handleToolCall (every routed tool
// call increments dispatched; non-errored replies also increment
// succeeded). Activation success is deliberately NOT recorded —
// otherwise a server that activates fine but every tool call 500s
// would still look 100% reliable in the cross-session signal.
//
// Deliberately conservative:
//   - Positive boost never exceeds +10% — relevance is the primary
//     signal. Learning is a tiebreak, not a takeover.
//   - Negative penalty never drops below -10% — same floor, opposite
//     direction. We nudge, not reroute.
//   - Positive branch requires ≥3 successful observations.
//   - Penalty branch requires ≥3 dispatches AND <80% success, so we
//     never shout at a server for a single flaky call.
//   - Penalty beats boost when both could apply: a namespace with 10
//     successes but a 50% overall success rate is flaky, not useful —
//     the rate-based signal trumps the count-based one.
//   - Snapshots persist to ~/.mcph/state.json across restarts
//     (see persistence.ts); ConnectServer handles the load/save
//     lifecycle via exportSnapshot/loadSnapshot.

export const LEARNING_MIN_OBSERVATIONS = 3;
export const LEARNING_MAX_BOOST = 1.1;
export const LEARNING_MIN_BOOST = 0.9;
// Matches the >=3 / <80% threshold used by formatReliabilityWarning
// (usage-hints.ts) and the cross-session reliability block in
// handleHealth. Keep these in sync — otherwise discover says "flaky"
// about a server that dispatch still happily routes to, or vice versa.
const PENALTY_RATE_THRESHOLD = 0.8;
const SATURATION_AT = 10;

export interface NamespaceUsage {
  dispatched: number;
  succeeded: number;
  lastUsedAt: number;
}

export class LearningStore {
  private usage = new Map<string, NamespaceUsage>();

  recordDispatch(namespace: string): void {
    const prev = this.usage.get(namespace);
    this.usage.set(namespace, {
      dispatched: (prev?.dispatched ?? 0) + 1,
      succeeded: prev?.succeeded ?? 0,
      lastUsedAt: Date.now(),
    });
  }

  recordSuccess(namespace: string): void {
    const prev = this.usage.get(namespace);
    this.usage.set(namespace, {
      dispatched: prev?.dispatched ?? 1,
      succeeded: (prev?.succeeded ?? 0) + 1,
      lastUsedAt: Date.now(),
    });
  }

  get(namespace: string): NamespaceUsage | undefined {
    return this.usage.get(namespace);
  }

  // Boost factor in [LEARNING_MIN_BOOST, LEARNING_MAX_BOOST]. Penalty
  // branch wins when a namespace has been dispatched enough times and
  // its success rate has fallen below 80%; otherwise the positive
  // branch grows the factor with successful observation count, saturating
  // at SATURATION_AT successes so a heavily-used server can't runaway-win
  // against legitimately better matches.
  boostFactor(namespace: string): number {
    const u = this.usage.get(namespace);
    if (!u) return 1.0;

    // Penalty branch — flaky history shrinks the score so dispatch
    // prefers an equivalent healthy alternative. Rate-based signal;
    // positive success counts can't rescue a server whose overall
    // record is poor.
    if (u.dispatched >= LEARNING_MIN_OBSERVATIONS) {
      const rate = u.succeeded / u.dispatched;
      if (rate < PENALTY_RATE_THRESHOLD) {
        const distance = Math.min(1, (PENALTY_RATE_THRESHOLD - rate) / PENALTY_RATE_THRESHOLD);
        return 1.0 - distance * (1.0 - LEARNING_MIN_BOOST);
      }
    }

    if (u.succeeded < LEARNING_MIN_OBSERVATIONS) return 1.0;
    const progress = Math.min(1, u.succeeded / SATURATION_AT);
    return 1.0 + progress * (LEARNING_MAX_BOOST - 1.0);
  }

  // Reset is mostly for tests; production code lets the store live for
  // the process lifetime and dies with it.
  reset(): void {
    this.usage.clear();
  }

  // Return a plain-object snapshot suitable for JSON persistence. Copy
  // semantics — callers may serialize without guarding against later
  // in-memory mutations.
  exportSnapshot(): Record<string, NamespaceUsage> {
    const out: Record<string, NamespaceUsage> = {};
    for (const [ns, usage] of this.usage) {
      out[ns] = { dispatched: usage.dispatched, succeeded: usage.succeeded, lastUsedAt: usage.lastUsedAt };
    }
    return out;
  }

  // Iterate the current store as { namespace, usage } pairs. Used by
  // observability paths (e.g., mcp_connect_health's cross-session
  // reliability block) that need to walk every recorded namespace.
  entries(): Array<{ namespace: string; usage: NamespaceUsage }> {
    const out: Array<{ namespace: string; usage: NamespaceUsage }> = [];
    for (const [ns, u] of this.usage) {
      out.push({
        namespace: ns,
        usage: { dispatched: u.dispatched, succeeded: u.succeeded, lastUsedAt: u.lastUsedAt },
      });
    }
    return out;
  }

  // Replace in-memory state with the given snapshot. Used on startup
  // to restore persisted signal; silently overwrites anything already
  // in the store, so callers should only invoke this before recording.
  loadSnapshot(snapshot: Record<string, NamespaceUsage>): void {
    this.usage.clear();
    for (const [ns, usage] of Object.entries(snapshot)) {
      this.usage.set(ns, { dispatched: usage.dispatched, succeeded: usage.succeeded, lastUsedAt: usage.lastUsedAt });
    }
  }
}
