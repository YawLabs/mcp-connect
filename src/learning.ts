// Lightweight session-scoped usage signal. Tracks how often each
// namespace was picked by dispatch AND the tool call that followed
// actually succeeded, then exposes a bounded boost factor so future
// dispatches nudge toward servers that have been genuinely useful
// in this session.
//
// Deliberately conservative:
//   - Never more than +10% score boost — relevance is the primary
//     signal. Learning is a tiebreak, not a takeover.
//   - Requires ≥3 successful observations before any boost at all.
//   - In-memory only; no persistence across restarts. Cross-session
//     learning needs backend coordination (tracked separately).

export const LEARNING_MIN_OBSERVATIONS = 3;
export const LEARNING_MAX_BOOST = 1.1;
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

  // Boost factor in [1.0, LEARNING_MAX_BOOST]. Grows with successful
  // observation count, saturating at SATURATION_AT successes so a
  // heavily-used server can't runaway-win against legitimately better
  // matches.
  boostFactor(namespace: string): number {
    const u = this.usage.get(namespace);
    if (!u || u.succeeded < LEARNING_MIN_OBSERVATIONS) return 1.0;
    const progress = Math.min(1, u.succeeded / SATURATION_AT);
    return 1.0 + progress * (LEARNING_MAX_BOOST - 1.0);
  }

  // Reset is mostly for tests; production code lets the store live for
  // the process lifetime and dies with it.
  reset(): void {
    this.usage.clear();
  }
}
