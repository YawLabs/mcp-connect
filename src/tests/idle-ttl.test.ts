import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADAPTIVE_BONUS_CAP,
  ADAPTIVE_LOOKBACK,
  ADAPTIVE_MAX,
  ADAPTIVE_MIN,
  ADAPTIVE_WINDOW_MS,
  adaptiveThreshold,
  HISTORY_LIMIT,
  pushToolCall,
  type ToolCallRecord,
} from "../idle-ttl.js";

// Fixed "now" used throughout tests so relative timestamps read easily.
const NOW = 1_700_000_000_000;

function record(namespace: string, offsetMs: number): ToolCallRecord {
  return { namespace, at: NOW - offsetMs };
}

describe("adaptiveThreshold", () => {
  it("returns base when there's no history at all", () => {
    expect(adaptiveThreshold("gh", [], 10, NOW)).toBe(10);
  });

  it("returns base when the namespace has no recent activity", () => {
    // History has other namespaces but not `gh`.
    const history: ToolCallRecord[] = [record("slack", 1000), record("jira", 2000), record("slack", 500)];
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBe(10);
  });

  it("returns base when gh was called long ago (outside the window)", () => {
    // Just outside the 5-minute window.
    const outsideWindow = ADAPTIVE_WINDOW_MS + 1;
    const history = [record("gh", outsideWindow), record("gh", outsideWindow + 1000)];
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBe(10);
  });

  it("adds 2 per recent same-namespace call", () => {
    const history = [record("gh", 10_000), record("gh", 20_000), record("gh", 30_000)];
    // 3 recent gh calls → bonus = min(3*2, 20) = 6 → 10 + 6 = 16
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBe(16);
  });

  it("caps the adaptive bonus at ADAPTIVE_BONUS_CAP", () => {
    // 15 recent gh calls — raw bonus 30, capped to 20.
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < 15; i++) history.push(record("gh", i * 1000));
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBe(10 + ADAPTIVE_BONUS_CAP);
  });

  it("honors a custom base (env-var override)", () => {
    const history = [record("gh", 10_000), record("gh", 20_000)];
    // 2 recent gh calls → bonus 4 → base 15 + 4 = 19
    expect(adaptiveThreshold("gh", history, 15, NOW)).toBe(19);
  });

  it("clamps final result to ADAPTIVE_MIN (5) when base is smaller", () => {
    // Contrived: someone passes base=1 with no activity. We still
    // refuse to deactivate after fewer than 5 idle calls.
    expect(adaptiveThreshold("gh", [], 1, NOW)).toBe(ADAPTIVE_MIN);
  });

  it("snaps a non-finite base to ADAPTIVE_MIN instead of returning NaN", () => {
    // resolveIdleThreshold (server.ts) no longer produces one -- it parses the
    // env var with a strict digit-run test -- but `base` is a plain parameter
    // on an exported pure function, so a future caller computing a baseline
    // some other way could. NaN fails BOTH clamp comparisons, so before
    // the guard this returned NaN -- and `idleCalls >= NaN` is always false,
    // i.e. the namespace never deactivated at all. That is the opposite of
    // the documented "never deactivate faster than ADAPTIVE_MIN" floor.
    expect(adaptiveThreshold("gh", [], Number.NaN, NOW)).toBe(ADAPTIVE_MIN);
    // Also with activity present, so the bonus path cannot mask it.
    const history = [record("gh", 10_000), record("gh", 20_000)];
    expect(adaptiveThreshold("gh", history, Number.NaN, NOW)).toBe(ADAPTIVE_MIN);
    expect(adaptiveThreshold("gh", [], Number.POSITIVE_INFINITY, NOW)).toBe(ADAPTIVE_MIN);
    expect(adaptiveThreshold("gh", [], Number.NEGATIVE_INFINITY, NOW)).toBe(ADAPTIVE_MIN);
  });

  it("clamps final result to ADAPTIVE_MAX (50)", () => {
    // Contrived: base=40 + full bonus cap 20 = 60 → clamped to 50.
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < 20; i++) history.push(record("gh", i * 1000));
    expect(adaptiveThreshold("gh", history, 40, NOW)).toBe(ADAPTIVE_MAX);
  });

  it("distinguishes namespaces — bursty gh does not help slack", () => {
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < 10; i++) history.push(record("gh", i * 1000));
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBeGreaterThan(10);
    expect(adaptiveThreshold("slack", history, 10, NOW)).toBe(10);
  });

  it("only considers same-namespace calls within the time window", () => {
    // 2 recent gh calls, 3 old ones outside the window. Only the 2
    // recent count toward the bonus.
    const history = [
      record("gh", ADAPTIVE_WINDOW_MS + 1000), // old
      record("gh", ADAPTIVE_WINDOW_MS + 2000), // old
      record("gh", ADAPTIVE_WINDOW_MS + 3000), // old
      record("gh", 10_000), // recent
      record("gh", 20_000), // recent
    ];
    // 2 recent → bonus 4 → 14
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBe(14);
  });

  it("uses Date.now() by default when no explicit now is passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const history = [record("gh", 10_000), record("gh", 20_000)];
      // 2 recent → bonus 4 → 14
      expect(adaptiveThreshold("gh", history, 10)).toBe(14);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the scan after ADAPTIVE_LOOKBACK same-namespace entries", () => {
    // The stop is a WORK bound, not a scoring rule, and this test has to be
    // read that way. On a chronologically-ordered history -- the only kind
    // pushToolCall and server.ts produce -- it cannot change the answer: the
    // entries it drops are always older than the 20th-most-recent hit, so
    // dropping them matters only when 20+ hits sit inside the window, and 10
    // in-window hits already saturate ADAPTIVE_BONUS_CAP. Making the stop
    // OBSERVABLE therefore takes an out-of-order history, built here by hand.
    //
    // The 20 entries the backwards walk reaches FIRST are 5 recent + 15 old,
    // so the walk halts while still outside the window; 5 more recent entries
    // sit beyond the stop and must not be counted. Bonus = 5 * 2 = 10, not
    // 10 * 2 = 20. Reddens if `sameNsSeen < ADAPTIVE_LOOKBACK` leaves the loop.
    const history: ToolCallRecord[] = [];
    // Pushed first => walked LAST, beyond the stop. Recent, and ignored.
    for (let i = 0; i < 5; i++) history.push(record("gh", (i + 1) * 1000));
    // Pushed last => walked FIRST: 5 inside the window, then 15 outside it.
    for (let i = 0; i < ADAPTIVE_LOOKBACK; i++) {
      history.push(record("gh", i < 5 ? (i + 6) * 1000 : ADAPTIVE_WINDOW_MS + (i + 1) * 1000));
    }
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBe(20);
  });

  it("scores the same set identically once it is in chronological order", () => {
    // The other half of the claim above, pinned so the comment on
    // ADAPTIVE_LOOKBACK cannot quietly become false: sorted oldest-first (what
    // pushToolCall produces), the very same 25 entries score the saturated
    // 10 + ADAPTIVE_BONUS_CAP, which is what they would score with no stop at
    // all. The stop buys bounded work here, not a different threshold.
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < 10; i++) history.push(record("gh", (i + 1) * 1000));
    for (let i = 0; i < 15; i++) history.push(record("gh", ADAPTIVE_WINDOW_MS + (i + 1) * 1000));
    history.sort((a, b) => a.at - b.at);
    expect(adaptiveThreshold("gh", history, 10, NOW)).toBe(10 + ADAPTIVE_BONUS_CAP);
  });
});

describe("pushToolCall", () => {
  it("appends records in order", () => {
    const history: ToolCallRecord[] = [];
    pushToolCall(history, { namespace: "gh", at: 1 });
    pushToolCall(history, { namespace: "slack", at: 2 });
    pushToolCall(history, { namespace: "gh", at: 3 });
    expect(history.map((r) => r.namespace)).toEqual(["gh", "slack", "gh"]);
  });

  it("trims oldest entries once over the limit", () => {
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < 5; i++) pushToolCall(history, { namespace: "n", at: i }, 3);
    // Limit 3 → keeps the last three: at=2, at=3, at=4
    expect(history.map((r) => r.at)).toEqual([2, 3, 4]);
  });

  it("defaults to HISTORY_LIMIT when no limit is provided", () => {
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) pushToolCall(history, { namespace: "n", at: i });
    expect(history.length).toBe(HISTORY_LIMIT);
    expect(history[0].at).toBe(10); // first 10 dropped
    expect(history[history.length - 1].at).toBe(HISTORY_LIMIT + 9);
  });
});

describe("the baseline is an argument, not an env read", () => {
  // server.ts's resolveIdleThreshold owns the env vars (YAW_MCP_IDLE_THRESHOLD,
  // with MCP_CONNECT_IDLE_THRESHOLD as the pre-rename fallback), parses them
  // strictly, warns about an over-ceiling value, and hands the RESULT here.
  //
  // This block used to set those vars and then assert on a hand-passed base --
  // three assertions that could not fail, because adaptiveThreshold never read
  // the environment. Assert the contract that actually exists instead.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ignores both idle-threshold env vars", () => {
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "25");
    vi.stubEnv("MCP_CONNECT_IDLE_THRESHOLD", "40");
    // Reddens if the env read is ever duplicated into this module, which would
    // apply the override twice and skip resolveIdleThreshold's strict parse,
    // its <1 fallback and its over-ceiling warning.
    expect(adaptiveThreshold("gh", [], 10, NOW)).toBe(10);
  });

  it("lets a high base stack with the adaptive bonus up to the hard cap", () => {
    const history: ToolCallRecord[] = [];
    for (let i = 0; i < 15; i++) history.push(record("gh", i * 1000));
    // 25 + 20 = 45, still under ADAPTIVE_MAX (50) -- the one case the clamp
    // tests above leave open, where a raised baseline and a full bonus stack
    // without either bound firing.
    expect(adaptiveThreshold("gh", history, 25, NOW)).toBe(45);
  });
});
