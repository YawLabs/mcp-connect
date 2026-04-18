// Chain detection. Watches tool-call sequences across namespaces and
// surfaces recurring multi-server patterns as suggested "packs" the
// LLM/user could dispatch in one step via mcp_connect_dispatch.
//
// Scope is intentionally small:
//   - Snapshots persist across restarts via exportSnapshot/loadSnapshot
//     (see persistence.ts); ConnectServer owns the load/save timing.
//   - Observation only. Detection never activates a server — we surface
//     the suggestion and let the caller decide.
//   - Short time window. A "chain" is a burst of calls across ≥2 distinct
//     namespaces with small gaps between consecutive calls. Slow meanders
//     across a day aren't a pack, they're just usage.
//
// The packId is the sorted-unique namespace set; that way [gh, linear, gh]
// and [gh, linear] count toward the same {gh, linear} pack. Order is
// remembered in the original sequence list but not in the identity.

const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_MAX_GAP_MS = 120_000; // 120s between consecutive calls
const MIN_NAMESPACES = 2;
const MAX_NAMESPACES = 3;
const MIN_RECURRENCES = 2;

export interface PackCall {
  namespace: string;
  toolName: string;
  at: number;
}

export interface DetectedPack {
  namespaces: string[];
  frequency: number;
  lastSeenAt: number;
}

export interface PackDetectorOptions {
  maxHistory?: number;
  maxGapMs?: number;
}

interface Burst {
  namespaces: string[]; // distinct, order-of-first-appearance
  lastAt: number;
}

function packIdFromNamespaces(namespaces: string[]): string {
  // Sort for set-identity; dedupe defensively (callers already dedupe).
  return Array.from(new Set(namespaces)).sort().join("|");
}

export class PackDetector {
  private readonly maxHistory: number;
  private readonly maxGapMs: number;
  private history: PackCall[] = [];

  constructor(options: PackDetectorOptions = {}) {
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.maxGapMs = options.maxGapMs ?? DEFAULT_MAX_GAP_MS;
  }

  recordCall(namespace: string, toolName: string, at: number): void {
    if (!namespace || !toolName) return;
    this.history.push({ namespace, toolName, at });
    if (this.history.length > this.maxHistory) {
      // Drop the oldest entries once we exceed the cap. Slice once
      // rather than shift-per-call so push-heavy sessions stay O(1)
      // amortized.
      const overflow = this.history.length - this.maxHistory;
      this.history = this.history.slice(overflow);
    }
  }

  // Walk the history, segmenting it into "bursts" separated by gaps
  // longer than maxGapMs. Each burst with ≥2 distinct namespaces is a
  // candidate pack. A pack is returned when the same namespace set
  // appears in ≥MIN_RECURRENCES bursts.
  detectChains(): DetectedPack[] {
    if (this.history.length < 2) return [];

    const bursts = this.segmentBursts();
    // Fold each burst's distinct-namespace set into pack counts.
    const packCounts = new Map<string, { namespaces: string[]; frequency: number; lastSeenAt: number }>();

    for (const burst of bursts) {
      if (burst.namespaces.length < MIN_NAMESPACES) continue;
      if (burst.namespaces.length > MAX_NAMESPACES) continue;
      const id = packIdFromNamespaces(burst.namespaces);
      const prev = packCounts.get(id);
      if (prev) {
        prev.frequency += 1;
        if (burst.lastAt > prev.lastSeenAt) prev.lastSeenAt = burst.lastAt;
      } else {
        packCounts.set(id, {
          namespaces: [...burst.namespaces],
          frequency: 1,
          lastSeenAt: burst.lastAt,
        });
      }
    }

    const packs: DetectedPack[] = [];
    for (const entry of packCounts.values()) {
      if (entry.frequency >= MIN_RECURRENCES) {
        packs.push({
          namespaces: entry.namespaces,
          frequency: entry.frequency,
          lastSeenAt: entry.lastSeenAt,
        });
      }
    }
    return packs;
  }

  // Segment the call history into bursts. A new burst starts whenever
  // the gap to the previous call exceeds maxGapMs. Within a burst, each
  // namespace is recorded only once (order-of-first-appearance); the
  // "last seen" timestamp tracks the most recent call in the burst so
  // recency ranking is truthful even when the burst has many calls.
  private segmentBursts(): Burst[] {
    const bursts: Burst[] = [];
    let current: Burst | null = null;
    let prevAt = 0;

    for (const call of this.history) {
      if (!current || call.at - prevAt > this.maxGapMs) {
        current = { namespaces: [call.namespace], lastAt: call.at };
        bursts.push(current);
      } else {
        if (!current.namespaces.includes(call.namespace)) {
          current.namespaces.push(call.namespace);
        }
        current.lastAt = call.at;
      }
      prevAt = call.at;
    }

    return bursts;
  }

  // Exposed for tests.
  getHistory(): ReadonlyArray<PackCall> {
    return this.history;
  }

  reset(): void {
    this.history = [];
  }

  // Return a defensive copy of history for persistence. Each entry is a
  // fresh object, safe to JSON.stringify without worrying about later
  // mutations to the detector's internal array.
  exportSnapshot(): PackCall[] {
    return this.history.map((c) => ({ namespace: c.namespace, toolName: c.toolName, at: c.at }));
  }

  // Replace in-memory history with the given snapshot. Respects the
  // configured maxHistory cap — if the snapshot exceeds it, the oldest
  // entries are dropped, matching the cap behavior of recordCall.
  loadSnapshot(snapshot: ReadonlyArray<PackCall>): void {
    const clean: PackCall[] = [];
    for (const c of snapshot) {
      if (!c || !c.namespace || !c.toolName) continue;
      clean.push({ namespace: c.namespace, toolName: c.toolName, at: c.at });
    }
    if (clean.length > this.maxHistory) {
      this.history = clean.slice(clean.length - this.maxHistory);
    } else {
      this.history = clean;
    }
  }
}
