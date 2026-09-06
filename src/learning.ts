// Lightweight usage signal. Tracks how often each namespace's tools
// were called AND the GRADED quality of those replies (not just
// "answered without isError"), then exposes a bounded boost factor so
// future dispatches nudge toward servers that have been genuinely
// useful — and AWAY from servers that have been flaky.
//
// `succeeded` is a SUM of graded rewards in [0,1] (see recordOutcome /
// reward.ts), so `succeeded / dispatched` is a mean graded reward, not a
// raw success count. When every reward is exactly 0 or 1 this collapses
// to the old binary count, which is why the existing boostFactor math and
// tests carry over unchanged.
//
// Recorded on the proxy path in handleToolCall through recordOutcome:
// ONE call per routed tool call, banking the dispatch (denominator) and
// the graded reward (numerator) together. The older binary pair
// (recordDispatch + a conditional recordSuccess) is retired -- it has no
// production caller left and survives only for tests; see the
// @deprecated notes on those two methods. Activation success is
// deliberately NOT recorded -- otherwise a server that activates fine
// but every tool call 500s would still look 100% reliable in the
// cross-session signal.
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
//   - Snapshots persist to ~/.yaw-mcp/state.json across restarts
//     (see persistence.ts); ConnectServer handles the load/save
//     lifecycle via exportSnapshot/loadSnapshot.

import { setJsonKey } from "./json-key.js";

export const LEARNING_MIN_OBSERVATIONS = 3;
export const LEARNING_MAX_BOOST = 1.1;
export const LEARNING_MIN_BOOST = 0.9;
// Success-rate floor below which the penalty branch fires. Imported
// directly by usage-hints.ts (formatReliabilityWarning /
// selectFlakyNamespaces, and through those the cross-session reliability
// block in handleHealth and `yaw-mcp doctor`) so the "what counts as
// flaky" definition those surfaces render cannot drift from the routing
// penalty -- otherwise discover says "flaky" about a server that dispatch
// still happily routes to, or vice versa. Same story for
// LEARNING_MIN_OBSERVATIONS.
export const PENALTY_RATE_THRESHOLD = 0.8;
const SATURATION_AT = 10;

export interface NamespaceUsage {
  dispatched: number;
  succeeded: number;
  lastUsedAt: number;
}

export class LearningStore {
  // Growth bound: the map keys on namespace, and every recorder is only
  // reached with validated/bounded namespaces from the dispatch path, so
  // cardinality is bounded by the number of distinct namespaces ever
  // dispatched OR persisted -- not by the currently configured set.
  // loadSnapshot admits every namespace state.json carries, so a row for a
  // server that was since removed or renamed is restored, re-saved on the
  // next flush, and can still surface in health/doctor flaky lists; nothing
  // prunes against the installed set on load. No explicit cap is needed
  // unless untrusted strings can reach recordOutcome / recordMiss (they
  // cannot today).
  private usage = new Map<string, NamespaceUsage>();

  /**
   * @deprecated Test-only. The binary recordDispatch + recordSuccess pair was
   * replaced on the proxy path by the graded recordOutcome; no production
   * caller remains (grep src/ outside tests). Kept because existing tests still
   * seed stores through it: learning.test.ts is by far the heaviest user, with
   * persistence.test.ts and server.test.ts behind it -- delete both methods
   * together with all three sets of call sites, not before. Do NOT
   * reach for it in new code: it records a denominator with no numerator,
   * which recordMiss already expresses with an accurate name.
   */
  recordDispatch(namespace: string): void {
    const prev = this.usage.get(namespace);
    this.usage.set(namespace, {
      dispatched: (prev?.dispatched ?? 0) + 1,
      succeeded: prev?.succeeded ?? 0,
      lastUsedAt: Date.now(),
    });
  }

  /**
   * @deprecated Test-only -- see recordDispatch. Use recordOutcome, which banks
   * the dispatch and the graded credit in one call and therefore cannot produce
   * the succeeded > dispatched state this method can.
   */
  recordSuccess(namespace: string): void {
    const prev = this.usage.get(namespace);
    // Symmetric with recordDispatch (which leaves succeeded at 0): a bare
    // success leaves dispatched at 0 rather than seeding it to 1, so it never
    // fabricates a dispatch the caller never recorded (which would imply a
    // 100% rate from a call that recorded no dispatch). boostFactor coerces
    // dispatched up to succeeded (Math.max), so the rate still lands in [0, 1]
    // -- see the coerce comment there. Note that this in-memory-only shape does
    // NOT survive a save/load cycle: both loadSnapshot and persistence.ts's
    // sanitizeLearning clamp succeeded back down to dispatched.
    this.usage.set(namespace, {
      dispatched: prev?.dispatched ?? 0,
      succeeded: (prev?.succeeded ?? 0) + 1,
      lastUsedAt: Date.now(),
    });
  }

  // Graded outcome in [0,1] for a single dispatched proxy call. This is
  // the SOUND replacement for the binary recordDispatch + recordSuccess
  // pair on the proxy path: a 200/empty/error-shaped reply no longer banks
  // full credit (the reward is computed by reward.ts/computeOutcomeReward).
  // One call records BOTH the dispatch (denominator) and the graded credit
  // (numerator), so callers no longer pair recordDispatch with a
  // conditional recordSuccess. reward is clamped to [0,1].
  recordOutcome(namespace: string, reward: number): void {
    const r = Number.isFinite(reward) ? Math.min(1, Math.max(0, reward)) : 0;
    const prev = this.usage.get(namespace);
    this.usage.set(namespace, {
      dispatched: (prev?.dispatched ?? 0) + 1,
      succeeded: (prev?.succeeded ?? 0) + r,
      lastUsedAt: Date.now(),
    });
  }

  // Synthetic failed observation with NO success credit. Used by the
  // re-dispatch routing-miss signal (redispatch.ts): when the model
  // abandons server A and re-routes a similar intent to B, A's earlier
  // "clean" reply was useless in hindsight, so we depress A's success rate
  // by one failed observation. Denominator-only — same shape as a
  // recordDispatch that never sees a matching success.
  recordMiss(namespace: string): void {
    const prev = this.usage.get(namespace);
    this.usage.set(namespace, {
      dispatched: (prev?.dispatched ?? 0) + 1,
      succeeded: prev?.succeeded ?? 0,
      lastUsedAt: Date.now(),
    });
  }

  // Apply a DELTA to a namespace's success credit WITHOUT touching the
  // dispatched count. Used by the optional LLM reward grader (reward-grader.ts)
  // to revise a previously-recorded heuristic reward in the background: the
  // caller records the heuristic via recordOutcome immediately, then later
  // adjusts by (graded - heuristic) once the LLM verdict lands. Adding a delta
  // (rather than setting an absolute) stays correct under concurrent
  // recordOutcome calls on the same namespace. No-op for an unknown namespace
  // (nothing to revise); succeeded is clamped to [0, dispatched].
  adjustSucceeded(namespace: string, delta: number): void {
    const u = this.usage.get(namespace);
    if (!u || !Number.isFinite(delta)) return;
    u.succeeded = Math.min(u.dispatched, Math.max(0, u.succeeded + delta));
    u.lastUsedAt = Date.now();
  }

  // Read a namespace's counters. Returns a COPY, and types it readonly:
  // handing out the live object let any caller write straight past the
  // clamps the recorders maintain (recordOutcome banks at most 1.0 of credit
  // per dispatch, adjustSucceeded clamps succeeded to [0, dispatched]), which
  // would then flow into boostFactor and, via exportSnapshot, onto disk.
  // entries() and exportSnapshot() already copy; this closes the one reader
  // that did not.
  get(namespace: string): Readonly<NamespaceUsage> | undefined {
    const u = this.usage.get(namespace);
    return u === undefined ? undefined : { ...u };
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

    // Defensive coerce. No production recorder can produce succeeded >
    // dispatched (recordOutcome banks at most 1.0 of credit per dispatch,
    // recordMiss banks none, adjustSucceeded clamps to [0, dispatched]) and
    // neither loading path lets that shape in from disk -- but the deprecated
    // recordSuccess still can in-memory. Treat dispatched as at least succeeded
    // so the rate computation stays in [0, 1] and the penalty branch is not
    // triggered by a perfectly-successful namespace that happened to bypass the
    // dispatch counter.
    const dispatched = Math.max(u.dispatched, u.succeeded);

    // Penalty branch — flaky history shrinks the score so dispatch
    // prefers an equivalent healthy alternative. Rate-based signal;
    // positive success counts can't rescue a server whose overall
    // record is poor.
    if (dispatched >= LEARNING_MIN_OBSERVATIONS) {
      const rate = u.succeeded / dispatched;
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
      // setJsonKey, not out[ns]: persistence.ts deliberately preserves a
      // "__proto__" learning key on LOAD (setJsonKey + a pinning test);
      // plain assignment here invoked the inherited setter on the next
      // SAVE, so the entry silently vanished from state.json.
      setJsonKey(out, ns, { dispatched: usage.dispatched, succeeded: usage.succeeded, lastUsedAt: usage.lastUsedAt });
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
      // The signature promises NamespaceUsage rows, but the point of the
      // coercions below is to enforce the store's OWN invariants rather than
      // trust the caller -- and a null row threw on the first dereference,
      // aborting the whole restore (good rows included) for one bad entry,
      // while a primitive row coerced into a phantom all-zero entry that then
      // round-tripped to disk forever. Only an object can be a row -- and an
      // array or an empty object is `typeof "object"` too, coercing to the
      // very same all-zero phantom, so the row also has to CARRY a numeric
      // dispatched count (persistence.ts's sanitizeLearning draws the line in
      // the same place).
      if (!usage || typeof usage !== "object" || Array.isArray(usage) || typeof usage.dispatched !== "number") {
        continue;
      }
      // Enforce the store's own invariants rather than trusting upstream
      // sanitization: reject negatives/NaN (coerce to 0), then clamp
      // succeeded DOWN to dispatched.
      //
      // The direction is not a free choice. The only route that reaches
      // here in production is persistence.ts loadState -> sanitizeLearning,
      // which ALREADY clamps succeeded to dispatched. Coercing dispatched
      // UP here instead would leave the two files resolving one invariant
      // in opposite directions with the disk path silently winning, so the
      // round-trip would look lossless in-process and quietly change shape
      // across a restart. Clamping down also matches what every production
      // recorder maintains (recordOutcome banks at most 1.0 of credit per
      // dispatch, recordMiss banks none, adjustSucceeded clamps to
      // [0, dispatched]), so a persisted succeeded > dispatched is corrupt
      // or hand-edited state, not credit anyone earned.
      const dispatched = Number.isFinite(usage.dispatched) ? Math.max(0, usage.dispatched) : 0;
      const succeededRaw = Number.isFinite(usage.succeeded) ? Math.max(0, usage.succeeded) : 0;
      const succeeded = Math.min(succeededRaw, dispatched);
      const lastUsedAt = Number.isFinite(usage.lastUsedAt) ? usage.lastUsedAt : 0;
      this.usage.set(ns, { dispatched, succeeded, lastUsedAt });
    }
  }
}
