import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { describe, expect, it, vi } from "vitest";
import { INTENT_MAX } from "../reward-grader.js";
import {
  AGGRESSIVE_AMBIGUITY_THRESHOLD,
  BEST_OF_N_TEMPERATURE,
  bestOfNViaSampling,
  buildCandidates,
  buildTiebreakPrompt,
  CANDIDATE_DESCRIPTION_MAX,
  computeAmbiguity,
  MAX_SAMPLES,
  parseRouteEffort,
  parseTiebreakResponse,
  SAMPLING_TIEBREAK_RATIO,
  SAMPLING_TIMEOUT_MS,
  sampleCountForEffort,
  shouldSample,
  shouldTiebreak,
} from "../sampling-rank.js";

const candidates = [
  { namespace: "github", score: 1.0, tools: [{ name: "create_issue" }] },
  { namespace: "gitlab", score: 0.95, tools: [{ name: "create_mr" }] },
];

describe("shouldTiebreak", () => {
  it("returns false for single candidate", () => {
    expect(shouldTiebreak([{ namespace: "a", score: 1 }])).toBe(false);
  });

  it("returns false when the top score dominates", () => {
    expect(
      shouldTiebreak([
        { namespace: "a", score: 10 },
        { namespace: "b", score: 1 },
      ]),
    ).toBe(false);
  });

  it("returns true when top-2 are within the default ratio", () => {
    expect(
      shouldTiebreak([
        { namespace: "a", score: 1.0 },
        { namespace: "b", score: 0.95 },
      ]),
    ).toBe(true);
  });

  it("returns false when top score is zero", () => {
    expect(
      shouldTiebreak([
        { namespace: "a", score: 0 },
        { namespace: "b", score: 0 },
      ]),
    ).toBe(false);
  });

  it("honors an explicit ratio (the tuning seam no production caller passes)", () => {
    // shouldSample always takes the SAMPLING_TIEBREAK_RATIO default, so the
    // `ratio` parameter has no production caller -- exercised here so a
    // threshold sweep can lower the bar without editing the module, and so the
    // parameter is not silently dead weight.
    const ranked = [
      { namespace: "a", score: 1 },
      { namespace: "b", score: 0.8 },
    ];
    expect(shouldTiebreak(ranked)).toBe(false);
    expect(shouldTiebreak(ranked, SAMPLING_TIEBREAK_RATIO)).toBe(false);
    expect(shouldTiebreak(ranked, 0.75)).toBe(true);
  });
});

describe("buildTiebreakPrompt", () => {
  it("includes intent and each candidate", () => {
    const prompt = buildTiebreakPrompt("create a PR", candidates);
    expect(prompt).toContain("create a PR");
    expect(prompt).toContain("github");
    expect(prompt).toContain("gitlab");
    expect(prompt).toContain("create_issue");
  });

  it("tells the LLM to reply with just the namespace", () => {
    const prompt = buildTiebreakPrompt("x", candidates);
    expect(prompt.toLowerCase()).toContain("namespace");
  });

  it("caps a long intent at INTENT_MAX, the bound reward-grader.ts applies to the same field", () => {
    // server.ts rejects only an EMPTY intent and passes the rest verbatim, and
    // under "aggressive" this prompt goes out up to MAX_SAMPLES times per
    // dispatch on the client's sampling budget -- for a one-word reply. A
    // pasted document used to ride along in full on every one of those calls.
    const prompt = buildTiebreakPrompt("z".repeat(INTENT_MAX + 300), candidates);
    expect(prompt).toContain(`User intent: ${"z".repeat(INTENT_MAX)}...`);
    expect(prompt).not.toContain("z".repeat(INTENT_MAX + 1));
  });

  it("leaves an intent exactly at the cap alone, with no marker", () => {
    const prompt = buildTiebreakPrompt("y".repeat(INTENT_MAX), candidates);
    expect(prompt).toContain(`User intent: ${"y".repeat(INTENT_MAX)}\n`);
  });

  it("caps each candidate description at CANDIDATE_DESCRIPTION_MAX", () => {
    // Descriptions come from local-bundles.ts with no bound of their own.
    const prompt = buildTiebreakPrompt("x", [
      { namespace: "github", score: 1, description: "d".repeat(CANDIDATE_DESCRIPTION_MAX + 100), tools: [] },
      { namespace: "gitlab", score: 0.95, description: "short", tools: [] },
    ]);
    expect(prompt).toContain(`github -- ${"d".repeat(CANDIDATE_DESCRIPTION_MAX)}...`);
    expect(prompt).not.toContain("d".repeat(CANDIDATE_DESCRIPTION_MAX + 1));
    // An in-bounds description passes through untouched, no marker.
    expect(prompt).toContain("gitlab -- short\n");
  });
});

describe("parseTiebreakResponse", () => {
  it("accepts a bare namespace", () => {
    expect(parseTiebreakResponse("github", candidates)).toBe("github");
  });

  it("strips quotes and backticks", () => {
    expect(parseTiebreakResponse("`github`", candidates)).toBe("github");
    expect(parseTiebreakResponse('"gitlab"', candidates)).toBe("gitlab");
  });

  it("finds namespace inside prose", () => {
    expect(parseTiebreakResponse("I pick github because it fits best.", candidates)).toBe("github");
  });

  it("returns null when no candidate is named", () => {
    expect(parseTiebreakResponse("I don't know", candidates)).toBeNull();
  });

  it("prefers first line that names a candidate", () => {
    expect(parseTiebreakResponse("github\ngitlab", candidates)).toBe("github");
  });

  it("within a single line, picks the candidate at the earliest position (LLM's lexical choice wins)", () => {
    // "I prefer gitlab over github" -- the LLM is naming gitlab first;
    // we must not return github just because it iterates first.
    expect(parseTiebreakResponse("I prefer gitlab over github", candidates)).toBe("gitlab");
    expect(parseTiebreakResponse("github vs gitlab -- pick github", candidates)).toBe("github");
  });

  it("prefers the longest match when two namespaces tie on position (hyphen-prefix)", () => {
    // '-' is a word boundary for \b, so "aws-s3" matches at the SAME index as
    // "aws-s3-tools" inside "use aws-s3-tools". Iteration order must not
    // decide the winner -- the longest (exact) match has to win, or the LLM
    // naming the longer server gets misparsed as the shorter one.
    const hyphenCandidates = [
      { namespace: "aws-s3", score: 1.0, tools: [{ name: "list_buckets" }] },
      { namespace: "aws-s3-tools", score: 0.98, tools: [{ name: "sync_bucket" }] },
    ];
    expect(parseTiebreakResponse("use aws-s3-tools for this", hyphenCandidates)).toBe("aws-s3-tools");
    // Order-independent: same answer with the candidate list reversed.
    expect(parseTiebreakResponse("use aws-s3-tools for this", [...hyphenCandidates].reverse())).toBe("aws-s3-tools");
    // The shorter namespace is still parsed correctly when it is the one named.
    expect(parseTiebreakResponse("use aws-s3 for this", hyphenCandidates)).toBe("aws-s3");
    // A bare-namespace line still short-circuits on the exact-match branch.
    expect(parseTiebreakResponse("aws-s3-tools", hyphenCandidates)).toBe("aws-s3-tools");
    // An earlier-positioned candidate still beats a longer later one.
    expect(parseTiebreakResponse("aws-s3 beats aws-s3-tools here", hyphenCandidates)).toBe("aws-s3");
  });

  it("resolves a prefix-shaped mention in the CANONICAL underscore namespace shape", () => {
    // The hyphen test above pins a shape NAMESPACE_RE (local-bundles.ts,
    // /^[a-z][a-z0-9_]{0,29}$/) currently REJECTS -- '-' is not a legal
    // namespace character. The shape real namespaces actually take joins with
    // '_', which is a word character, so `\b` cannot fire between "aws_s3"
    // and its "_tools" suffix: only the longer namespace matches at all and
    // the position/length tiebreak never runs. Pinned so that relaxing
    // NAMESPACE_RE to allow '-' (which would route these mentions through the
    // tiebreak instead) has to face a test on the shape in production use.
    const underscoreCandidates = [
      { namespace: "aws_s3", score: 1.0, tools: [{ name: "list_buckets" }] },
      { namespace: "aws_s3_tools", score: 0.98, tools: [{ name: "sync_bucket" }] },
    ];
    expect(parseTiebreakResponse("use aws_s3_tools for this", underscoreCandidates)).toBe("aws_s3_tools");
    // Order-independent, exactly as in the hyphen case.
    expect(parseTiebreakResponse("use aws_s3_tools for this", [...underscoreCandidates].reverse())).toBe(
      "aws_s3_tools",
    );
    // The shorter namespace still wins when it is the one named.
    expect(parseTiebreakResponse("use aws_s3 for this", underscoreCandidates)).toBe("aws_s3");
  });

  it("handles a namespace containing regex-special characters without throwing", () => {
    // Namespaces like "aws+s3" contain '+', which is a regex quantifier.
    // escapeRegex must neutralize it so the RegExp constructor doesn't throw
    // and the match still works correctly.
    const specialCandidates = [
      { namespace: "aws+s3", score: 1.0, tools: [{ name: "list_buckets" }] },
      { namespace: "github", score: 0.9, tools: [{ name: "create_issue" }] },
    ];
    expect(() => parseTiebreakResponse("I pick aws+s3 for this task.", specialCandidates)).not.toThrow();
    expect(parseTiebreakResponse("I pick aws+s3 for this task.", specialCandidates)).toBe("aws+s3");
    // Non-matching response should still return null cleanly.
    expect(parseTiebreakResponse("neither", specialCandidates)).toBeNull();
  });
});

describe("buildCandidates", () => {
  it("attaches description and tool metadata", () => {
    const servers = new Map([
      [
        "github",
        {
          id: "1",
          name: "GitHub",
          namespace: "github",
          type: "local" as const,
          isActive: true,
          description: "GitHub API wrapper",
        },
      ],
    ]);
    const tools = new Map([["github", [{ name: "create_issue" }]]]);
    const out = buildCandidates([{ namespace: "github", score: 1.0 }], servers, tools);
    expect(out).toHaveLength(1);
    expect(out[0]?.description).toBe("GitHub API wrapper");
    expect(out[0]?.tools).toEqual([{ name: "create_issue" }]);
  });

  it("skips servers not in the map", () => {
    const out = buildCandidates([{ namespace: "missing", score: 1 }], new Map(), new Map());
    expect(out).toEqual([]);
  });
});

// Single-sample tiebreak == bestOfNViaSampling at n=1. There is no separate
// tiebreakViaSampling helper any more (it duplicated this path and nothing in
// production called it), so these pin the n=1 contract directly.
describe("bestOfNViaSampling (n=1 single-sample tiebreak)", () => {
  function mockServer(
    caps: { sampling?: object } | undefined,
    createMessage?: (params: unknown) => Promise<unknown>,
  ): Server {
    return {
      getClientCapabilities: () => caps,
      createMessage: createMessage ?? (async () => ({})),
    } as unknown as Server;
  }

  it("returns null when client does not support sampling", async () => {
    const server = mockServer(undefined);
    const out = await bestOfNViaSampling(server, "intent", candidates, 1);
    expect(out).toBeNull();
  });

  it("returns null with fewer than 2 candidates", async () => {
    const server = mockServer({ sampling: {} });
    const out = await bestOfNViaSampling(server, "intent", [candidates[0]!], 1);
    expect(out).toBeNull();
  });

  it("returns the picked namespace when sampling succeeds", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: { type: "text", text: "github" },
    });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 1);
    expect(out).toBe("github");
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it("handles array-shaped content", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "gitlab is better" }],
    });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 1);
    expect(out).toBe("gitlab");
  });

  it("returns null when the LLM names no candidate", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: { type: "text", text: "I don't know" },
    });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 1);
    expect(out).toBeNull();
  });

  it("swallows createMessage errors and returns null", async () => {
    const createMessage = vi.fn().mockRejectedValue(new Error("upstream refused"));
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 1);
    expect(out).toBeNull();
  });
});

// =============================================================================
// Effort dial (idea 5)
// =============================================================================

describe("parseRouteEffort", () => {
  it("defaults to auto when unset", () => {
    expect(parseRouteEffort(undefined)).toBe("auto");
  });

  it("defaults to auto for empty string", () => {
    expect(parseRouteEffort("")).toBe("auto");
  });

  it("parses each known value, case- and whitespace-insensitively", () => {
    expect(parseRouteEffort("off")).toBe("off");
    expect(parseRouteEffort("OFF")).toBe("off");
    expect(parseRouteEffort("auto")).toBe("auto");
    expect(parseRouteEffort("aggressive")).toBe("aggressive");
    expect(parseRouteEffort("  Aggressive  ")).toBe("aggressive");
  });

  it("falls back to auto for unknown values", () => {
    // Explicit `undefined` fallback: an unrecognized value now re-resolves
    // against YAW_MCP_ROUTE_EFFORT (see below), so leaving the second argument
    // off would make this assertion depend on the runner's environment.
    expect(parseRouteEffort("turbo", undefined)).toBe("auto");
    expect(parseRouteEffort("1", undefined)).toBe("auto");
  });

  it("re-resolves an unrecognized value against the environment before defaulting", () => {
    // server.ts passes dispatch's per-call `routeEffort` argument first and
    // only reaches YAW_MCP_ROUTE_EFFORT when that argument is ABSENT, so a
    // typo'd argument used to mask the env var and silently downgrade an
    // aggressive deployment to auto for that call.
    expect(parseRouteEffort("aggresive", "aggressive")).toBe("aggressive");
    expect(parseRouteEffort("aggresive", "off")).toBe("off");
    // Both unrecognized -> the documented "auto" default, unchanged.
    expect(parseRouteEffort("aggresive", "turbo")).toBe("auto");
    expect(parseRouteEffort("aggresive", undefined)).toBe("auto");
    // A recognized per-call value still wins outright, including "auto".
    expect(parseRouteEffort("off", "aggressive")).toBe("off");
    expect(parseRouteEffort("auto", "aggressive")).toBe("auto");
  });

  it("does not consult the environment for an absent or empty value", () => {
    // The caller has already collapsed "argument absent" into `raw` (it passes
    // routeEffort ?? process.env.YAW_MCP_ROUTE_EFFORT), so re-reading the env
    // for an absent value would resurrect a setting the caller deliberately
    // resolved away -- and would make this function environment-dependent for
    // every other caller.
    vi.stubEnv("YAW_MCP_ROUTE_EFFORT", "aggressive");
    try {
      expect(parseRouteEffort(undefined)).toBe("auto");
      expect(parseRouteEffort("")).toBe("auto");
      // ...but an unrecognized value picks the env setting up when no explicit
      // fallback is passed.
      expect(parseRouteEffort("aggresive")).toBe("aggressive");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("computeAmbiguity", () => {
  it("returns 0 for fewer than 2 candidates", () => {
    expect(computeAmbiguity([])).toBe(0);
    expect(computeAmbiguity([{ namespace: "a", score: 1 }])).toBe(0);
  });

  it("returns 0 when the leader score is non-positive", () => {
    expect(
      computeAmbiguity([
        { namespace: "a", score: 0 },
        { namespace: "b", score: 0 },
      ]),
    ).toBe(0);
    expect(
      computeAmbiguity([
        { namespace: "a", score: -1 },
        { namespace: "b", score: -2 },
      ]),
    ).toBe(0);
  });

  it("returns ~1 for tied scores", () => {
    expect(
      computeAmbiguity([
        { namespace: "a", score: 1 },
        { namespace: "b", score: 1 },
      ]),
    ).toBeCloseTo(1, 5);
  });

  it("returns ~0 for a dominant clear winner", () => {
    const a = computeAmbiguity([
      { namespace: "a", score: 10 },
      { namespace: "b", score: 0.1 },
    ]);
    expect(a).toBeLessThan(0.15);
    expect(a).toBeGreaterThanOrEqual(0);
  });

  it("normalizes by the top-K size, so k moves the value on identical data", () => {
    // The entropy half is divided by log(topK.length). Same three candidates,
    // different K: log(3) vs log(2). Nothing else in the suite notices a change
    // to the k=3 default, and that default decides how often "aggressive" pays
    // for a best-of-N fan-out -- so pin it by value, and exercise the `k`
    // parameter that has no production caller while we are here.
    const three = [
      { namespace: "a", score: 1 },
      { namespace: "b", score: 0.2 },
      { namespace: "c", score: 0.05 },
    ];
    const atThree = computeAmbiguity(three); // default k = 3
    const atTwo = computeAmbiguity(three, 2);
    expect(atThree).toBeGreaterThan(0.54);
    expect(atThree).toBeLessThan(0.56);
    expect(atTwo).toBeGreaterThan(0.64);
    expect(atTwo).toBeLessThan(0.66);
    expect(atThree).toBeLessThan(atTwo);
  });

  it("stays within [0,1]", () => {
    const vals = [
      computeAmbiguity([
        { namespace: "a", score: 5 },
        { namespace: "b", score: 4 },
        { namespace: "c", score: 3 },
      ]),
      computeAmbiguity([
        { namespace: "a", score: 1 },
        { namespace: "b", score: 0.95 },
      ]),
    ];
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("shouldSample", () => {
  const tied = [
    { namespace: "a", score: 1 },
    { namespace: "b", score: 0.95 },
  ];
  // Dominant winner relative to runner-up, but not so wide that even the
  // entropy signal vanishes -- sits in the band aggressive samples, auto does
  // not (ambiguity ~0.78).
  const moderate = [
    { namespace: "a", score: 1 },
    { namespace: "b", score: 0.3 },
  ];
  // Clear winner below every threshold.
  const clear = [
    { namespace: "a", score: 10 },
    { namespace: "b", score: 0.2 },
  ];

  it("off never samples, even when fully tied", () => {
    expect(shouldSample(tied, "off")).toBe(false);
    expect(shouldSample(moderate, "off")).toBe(false);
  });

  it("auto samples on genuine ambiguity but not a clear winner", () => {
    expect(shouldSample(tied, "auto")).toBe(true);
    expect(shouldSample(moderate, "auto")).toBe(false);
    expect(shouldSample(clear, "auto")).toBe(false);
  });

  it("auto preserves the SAMPLING_TIEBREAK_RATIO top-2 tiebreak exactly (no entropy-driven over-sampling)", () => {
    // The entropy blend would push these into sampling; the auto path must
    // NOT, since auto mirrors the historical second/top >= ratio gate. The
    // relative assertions below document that intent, but relative alone is
    // self-referential -- 0.81/0.85/0.88/0.95 all keep them green while the
    // DEFAULT dispatch path changes how often it spends a client-LLM
    // round-trip. So pin the constant by value too, the same way the k=3
    // default is pinned above; a deliberate retune must edit this line.
    expect(SAMPLING_TIEBREAK_RATIO).toBe(0.9);
    for (const r of [0.5, 0.7, SAMPLING_TIEBREAK_RATIO - 0.02, SAMPLING_TIEBREAK_RATIO - 0.01]) {
      const ranked = [
        { namespace: "a", score: 1 },
        { namespace: "b", score: r },
      ];
      expect(shouldSample(ranked, "auto"), `ratio ${r} should not sample under auto`).toBe(false);
    }
    // ...but a runner-up at exactly the ratio does sample.
    expect(
      shouldSample(
        [
          { namespace: "a", score: 1 },
          { namespace: "b", score: SAMPLING_TIEBREAK_RATIO },
        ],
        "auto",
      ),
    ).toBe(true);
  });

  it("aggressive samples on milder ambiguity than auto", () => {
    expect(shouldSample(tied, "aggressive")).toBe(true);
    expect(shouldSample(moderate, "aggressive")).toBe(true);
    expect(shouldSample(clear, "aggressive")).toBe(false);
  });

  it("the aggressive gate tracks the top-K SIZE, not just the top-2 shape (k=3 default)", () => {
    // Identical top-2 shape, one extra candidate: computeAmbiguity's entropy
    // normalizer moves from log(2) to log(3) and the same ranking crosses back
    // under the bar. That is the whole behavioral consequence of the k=3
    // default -- with k=2 the three-candidate case would sample too, spending
    // a best-of-3 fan-out on a ranking the current code treats as decided.
    // Asserted against AGGRESSIVE_AMBIGUITY_THRESHOLD, not a hardcoded 0.6.
    const two = [
      { namespace: "a", score: 1 },
      { namespace: "b", score: 0.2 },
    ];
    const three = [...two, { namespace: "c", score: 0.05 }];
    expect(computeAmbiguity(two)).toBeGreaterThan(AGGRESSIVE_AMBIGUITY_THRESHOLD);
    expect(computeAmbiguity(three)).toBeLessThan(AGGRESSIVE_AMBIGUITY_THRESHOLD);
    expect(shouldSample(two, "aggressive")).toBe(true);
    expect(shouldSample(three, "aggressive")).toBe(false);
  });

  it("never samples with a single candidate at any effort", () => {
    const one = [{ namespace: "a", score: 1 }];
    expect(shouldSample(one, "auto")).toBe(false);
    expect(shouldSample(one, "aggressive")).toBe(false);
  });
});

describe("sampleCountForEffort", () => {
  it("maps each effort to its best-of-N width", () => {
    // The only thing that makes "aggressive" cost more than "auto". Both
    // regressions are silent and billing-visible: auto -> 3 triples
    // client-LLM createMessage calls on the DEFAULT dispatch path, and
    // aggressive -> 1 voids the best-of-3 the tool schema advertises.
    expect(sampleCountForEffort("auto")).toBe(1);
    expect(sampleCountForEffort("aggressive")).toBe(3);
    // "off" documents intent rather than guarding behavior: shouldSample
    // returns false for "off" so this branch is never reached in production,
    // and bestOfNViaSampling clamps a 0 back up to 1 anyway.
    expect(sampleCountForEffort("off")).toBe(0);
  });
});

describe("bestOfNViaSampling", () => {
  function mockServer(
    caps: { sampling?: object } | undefined,
    createMessage?: (params: unknown) => Promise<unknown>,
  ): Server {
    return {
      getClientCapabilities: () => caps,
      createMessage: createMessage ?? (async () => ({})),
    } as unknown as Server;
  }

  it("returns null without sampling capability (no calls made)", async () => {
    const createMessage = vi.fn();
    const server = mockServer(undefined, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 3);
    expect(out).toBeNull();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("returns null with fewer than 2 candidates", async () => {
    const createMessage = vi.fn();
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", [candidates[0]!], 3);
    expect(out).toBeNull();
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("clamps N up to MAX_SAMPLES", async () => {
    const createMessage = vi.fn().mockResolvedValue({ content: { type: "text", text: "github" } });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 99);
    expect(out).toBe("github");
    expect(createMessage).toHaveBeenCalledTimes(MAX_SAMPLES);
  });

  it("clamps N up to at least 1", async () => {
    const createMessage = vi.fn().mockResolvedValue({ content: { type: "text", text: "github" } });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 0);
    expect(out).toBe("github");
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it("fans out to exactly sampleCountForEffort(effort) calls", async () => {
    // The composition the effort dial actually buys: aggressive -> 3 client-LLM
    // round-trips, auto -> 1. (dispatch.test.ts covers the same wiring through
    // handleDispatch, where the effort is resolved from the argument/env.)
    const createMessage = vi.fn().mockResolvedValue({ content: { type: "text", text: "github" } });
    const server = mockServer({ sampling: {} }, createMessage);
    await bestOfNViaSampling(server, "intent", candidates, sampleCountForEffort("aggressive"));
    expect(createMessage).toHaveBeenCalledTimes(3);
    createMessage.mockClear();
    await bestOfNViaSampling(server, "intent", candidates, sampleCountForEffort("auto"));
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it("asks for a temperature only when it actually fans out", async () => {
    // N byte-identical requests to a deterministic client come back N identical
    // answers, so the majority vote is unanimous by construction and best-of-3
    // costs 3x for one sample's information. n=1 stays on the client's own
    // default, so the "auto" path is unchanged by the dial.
    const seen: Array<Record<string, unknown>> = [];
    const createMessage = vi.fn().mockImplementation(async (params: unknown) => {
      seen.push(params as Record<string, unknown>);
      return { content: { type: "text", text: "github" } };
    });
    const server = mockServer({ sampling: {} }, createMessage);

    await bestOfNViaSampling(server, "intent", candidates, 3);
    expect(seen).toHaveLength(3);
    for (const params of seen) {
      expect(params.temperature).toBe(BEST_OF_N_TEMPERATURE);
    }
    expect(BEST_OF_N_TEMPERATURE).toBeGreaterThan(0);

    seen.length = 0;
    await bestOfNViaSampling(server, "intent", candidates, 1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("temperature");
  });

  it("majority-votes across N samples", async () => {
    // 3 calls: gitlab, gitlab, github -> gitlab wins 2-1.
    const replies = ["gitlab", "gitlab", "github"];
    let i = 0;
    const createMessage = vi.fn().mockImplementation(async () => ({
      content: { type: "text", text: replies[i++] },
    }));
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 3);
    expect(out).toBe("gitlab");
    expect(createMessage).toHaveBeenCalledTimes(3);
  });

  it("breaks vote ties by ranker order (first candidate wins)", async () => {
    // 2 calls split 1-1; github is first in `candidates`, so it wins the tie.
    const replies = ["gitlab", "github"];
    let i = 0;
    const createMessage = vi.fn().mockImplementation(async () => ({
      content: { type: "text", text: replies[i++] },
    }));
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 2);
    expect(out).toBe("github");
  });

  it("returns null when no sample names a candidate", async () => {
    const createMessage = vi.fn().mockResolvedValue({ content: { type: "text", text: "no idea" } });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 3);
    expect(out).toBeNull();
  });

  it("never throws; a failing sample is dropped from the vote", async () => {
    // First call rejects, remaining two vote github.
    let i = 0;
    const createMessage = vi.fn().mockImplementation(async () => {
      if (i++ === 0) throw new Error("upstream refused");
      return { content: { type: "text", text: "github" } };
    });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await bestOfNViaSampling(server, "intent", candidates, 3);
    expect(out).toBe("github");
  });

  it("passes an abort signal + per-request timeout to every sample and aborts them when the race ends", async () => {
    // A timed-out race must tear the losing samples DOWN, not merely stop
    // waiting for them: without the signal, up to MAX_SAMPLES client-LLM
    // requests kept running (and billing) to the SDK's 60s default request
    // timeout with their results discarded.
    vi.useFakeTimers();
    try {
      const seen: Array<{ signal?: AbortSignal; timeout?: number }> = [];
      const createMessage = vi.fn().mockImplementation((_params: unknown, options: never) => {
        seen.push(options as { signal?: AbortSignal; timeout?: number });
        return new Promise<unknown>(() => {}); // never settles
      });
      const server = mockServer({ sampling: {} }, createMessage as unknown as (params: unknown) => Promise<unknown>);
      const resultPromise = bestOfNViaSampling(server, "intent", candidates, 2);
      await vi.advanceTimersByTimeAsync(SAMPLING_TIMEOUT_MS + 100);
      const out = await resultPromise;
      expect(out).toBeNull();
      expect(seen).toHaveLength(2);
      for (const o of seen) {
        expect(o.timeout).toBe(SAMPLING_TIMEOUT_MS);
        expect(o.signal).toBeInstanceOf(AbortSignal);
        // Torn down with the race, not left to the SDK default.
        expect(o.signal?.aborted).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not warn when its OWN abort is what killed a sample", async () => {
    // The teardown above aborts every in-flight sample once the race resolves,
    // so on the timeout path each pending request rejects AFTER the function
    // has already returned. Warning there emits up to MAX_SAMPLES lines per
    // timed-out dispatch that blame the client LLM for yaw-mcp's own
    // cancellation -- the operator reads a healthy client as failing.
    vi.useFakeTimers();
    vi.stubEnv("LOG_LEVEL", "debug"); // a warn WOULD be written if one happened
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") writes.push(chunk);
      else if (Buffer.isBuffer(chunk)) writes.push(chunk.toString("utf8"));
      return true;
    });
    try {
      const createMessage = vi.fn().mockImplementation(
        (_params: unknown, options: { signal: AbortSignal }) =>
          new Promise<unknown>((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error("aborted by yaw-mcp")));
          }),
      );
      const server = mockServer({ sampling: {} }, createMessage as unknown as (params: unknown) => Promise<unknown>);
      const resultPromise = bestOfNViaSampling(server, "intent", candidates, 3);
      await vi.advanceTimersByTimeAsync(SAMPLING_TIMEOUT_MS + 100);
      expect(await resultPromise).toBeNull();
      // Let the aborted samples' rejections land in sampleOnce's catch.
      await vi.advanceTimersByTimeAsync(0);
      expect(writes.join("")).not.toContain("Best-of-N sample failed");
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it("returns null when all samples resolve after SAMPLING_TIMEOUT_MS", async () => {
    // All sample promises resolve after the timeout deadline. The race must
    // resolve to null (falling back to the ranker's order) rather than
    // hanging indefinitely or waiting for the slow samples to finish.
    vi.useFakeTimers();
    try {
      const createMessage = vi.fn().mockImplementation(
        () =>
          new Promise<unknown>((resolve) => {
            // Resolves well after the timeout window.
            setTimeout(() => resolve({ content: { type: "text", text: "github" } }), SAMPLING_TIMEOUT_MS + 5_000);
          }),
      );
      const server = mockServer({ sampling: {} }, createMessage);
      const resultPromise = bestOfNViaSampling(server, "intent", candidates, 3);
      // Advance past the timeout so the race resolves.
      await vi.advanceTimersByTimeAsync(SAMPLING_TIMEOUT_MS + 100);
      const out = await resultPromise;
      expect(out).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
