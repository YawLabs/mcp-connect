// Context-aware idle TTL.
//
// The original auto-deactivate logic used a single static threshold
// (MCP_CONNECT_IDLE_THRESHOLD, default 10) for every namespace: once an
// upstream had seen N calls for OTHER namespaces since its own last call,
// we'd tear it down to save RAM.
//
// That worked for long-tail usage but penalized bursty workflows. If a
// user fired off five `github_*` calls in a row, then bounced to `slack`
// for a dozen follow-up tool calls, the github upstream would get
// deactivated mid-task even though we were almost certainly about to
// come back to it. Re-activation is slow (spawn + tools/list + handshake)
// so the "patience" for a just-used server should be longer than for one
// we touched half an hour ago and forgot about.
//
// This module computes an adaptive per-namespace threshold from a rolling
// history of recent tool calls. The function is deliberately pure: the
// server keeps the history, this file just scores it.

export interface ToolCallRecord {
  namespace: string;
  at: number; // epoch millis
}

// Window of recent tool calls considered when computing adaptive
// threshold. Only same-namespace hits within this window count toward
// "burstiness".
export const ADAPTIVE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// Only look at the last N calls from history when counting recent hits.
// Combined with the time window this caps how bursty a namespace can
// register — 20 hits in 5 minutes is already "very active".
export const ADAPTIVE_LOOKBACK = 20;

// Hard bounds on the final threshold. Even with a high base and a very
// bursty namespace we never wait longer than 50 idle calls; even with a
// low/invalid base we never deactivate faster than 5.
export const ADAPTIVE_MIN = 5;
export const ADAPTIVE_MAX = 50;

// Maximum bonus an adaptive namespace can earn on top of `base`. A
// completely idle namespace gets `base` exactly; a heavily-used one gets
// `base + ADAPTIVE_BONUS_CAP`.
export const ADAPTIVE_BONUS_CAP = 20;

// Rolling history size kept by the server. Bounded so we don't grow
// unbounded on long sessions; 100 is enough to feed several lookback
// windows across namespaces.
export const HISTORY_LIMIT = 100;

/**
 * Compute the adaptive idle-call threshold for `namespace` given the
 * rolling history of recent tool calls.
 *
 * Rules:
 *  - Count same-namespace calls within the last ADAPTIVE_WINDOW_MS from
 *    the most recent ADAPTIVE_LOOKBACK history entries for that namespace.
 *  - Return `base + min(recent * 2, ADAPTIVE_BONUS_CAP)`.
 *  - Clamp the final result to [ADAPTIVE_MIN, ADAPTIVE_MAX].
 *
 * The caller supplies `base` so the env-var override
 * (MCP_CONNECT_IDLE_THRESHOLD) continues to control the baseline. The
 * adaptive cap is not user-tunable — it's a safety valve.
 *
 * @param namespace The upstream namespace we're scoring.
 * @param recentCalls The server's rolling history of recent tool calls.
 * @param base Baseline threshold (default 10, overridable via env var).
 * @param now Current time in epoch millis — injected for deterministic
 *   tests. Defaults to Date.now().
 */
export function adaptiveThreshold(
  namespace: string,
  recentCalls: ReadonlyArray<ToolCallRecord>,
  base: number,
  now: number = Date.now(),
): number {
  const cutoff = now - ADAPTIVE_WINDOW_MS;

  // Walk the history backwards so we only examine the last
  // ADAPTIVE_LOOKBACK same-namespace entries — older burst activity
  // doesn't count against a namespace that's since gone quiet.
  let sameNsSeen = 0;
  let recent = 0;
  for (let i = recentCalls.length - 1; i >= 0 && sameNsSeen < ADAPTIVE_LOOKBACK; i--) {
    const rec = recentCalls[i];
    if (rec.namespace !== namespace) continue;
    sameNsSeen++;
    if (rec.at >= cutoff) recent++;
  }

  const bonus = Math.min(recent * 2, ADAPTIVE_BONUS_CAP);
  const computed = base + bonus;

  if (computed < ADAPTIVE_MIN) return ADAPTIVE_MIN;
  if (computed > ADAPTIVE_MAX) return ADAPTIVE_MAX;
  return computed;
}

/**
 * Append a tool call to a rolling history, evicting the oldest entries
 * so the history never exceeds `limit`. Returns the (possibly trimmed)
 * array — callers can use the return value or rely on in-place mutation.
 */
export function pushToolCall(
  history: ToolCallRecord[],
  record: ToolCallRecord,
  limit: number = HISTORY_LIMIT,
): ToolCallRecord[] {
  history.push(record);
  if (history.length > limit) {
    history.splice(0, history.length - limit);
  }
  return history;
}
