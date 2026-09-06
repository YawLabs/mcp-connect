import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeOutcomeReward } from "../reward.js";
import {
  buildGraderPrompt,
  capForPrompt,
  firstResultText,
  gradeOutcomeViaSampling,
  isRewardGraderEnabled,
  isUncertainReward,
  parseGrade,
} from "../reward-grader.js";

function mockServer(
  caps: Record<string, unknown> | undefined,
  createMessage?: (params: unknown, options?: unknown) => Promise<unknown>,
): Server {
  return {
    getClientCapabilities: () => caps,
    createMessage: createMessage ?? (async () => ({})),
  } as unknown as Server;
}

describe("isRewardGraderEnabled", () => {
  const orig = process.env.YAW_MCP_REWARD_GRADER;
  afterEach(() => {
    if (orig === undefined) delete process.env.YAW_MCP_REWARD_GRADER;
    else process.env.YAW_MCP_REWARD_GRADER = orig;
  });

  it("is disabled by default (unset)", () => {
    delete process.env.YAW_MCP_REWARD_GRADER;
    expect(isRewardGraderEnabled()).toBe(false);
  });

  it('is enabled for "1" and "true" (trimmed, case-insensitive)', () => {
    for (const v of ["1", "true", " TRUE "]) {
      process.env.YAW_MCP_REWARD_GRADER = v;
      expect(isRewardGraderEnabled()).toBe(true);
    }
  });

  it('is disabled for "0" / "false" / garbage', () => {
    for (const v of ["0", "false", "yes", "nope"]) {
      process.env.YAW_MCP_REWARD_GRADER = v;
      expect(isRewardGraderEnabled()).toBe(false);
    }
  });
});

describe("isUncertainReward", () => {
  it("is true only on the 0.2 / 0.3 heuristic bands", () => {
    expect(isUncertainReward(0.2)).toBe(true);
    expect(isUncertainReward(0.3)).toBe(true);
  });
  it("is false on the confident bands and outside the range", () => {
    for (const r of [0.0, 0.19, 0.31, 0.5, 1.0]) {
      expect(isUncertainReward(r)).toBe(false);
    }
  });

  // Coupling guard. The bands are defined in reward.ts and this predicate used
  // to restate them as bare literals, so moving one would have switched the
  // grader off with nothing red. Drive the predicate from the grades
  // computeOutcomeReward actually produces instead of from numbers.
  it("is true for the grades computeOutcomeReward produces for the uncertain shapes", () => {
    // Error-shaped 200 (soft failure) and empty body -- the two bands where the
    // keyword heuristic is most likely wrong in either direction.
    expect(isUncertainReward(computeOutcomeReward({ content: [{ type: "text", text: "not found" }] }))).toBe(true);
    expect(isUncertainReward(computeOutcomeReward({ content: [{ type: "text", text: "" }] }))).toBe(true);
  });

  it("is false for the grades computeOutcomeReward produces for the confident shapes", () => {
    expect(isUncertainReward(computeOutcomeReward({ isError: true }))).toBe(false);
    expect(isUncertainReward(computeOutcomeReward({ content: [{ type: "text", text: "all good" }] }))).toBe(false);
  });
});

describe("firstResultText", () => {
  it("returns the first NON-EMPTY text block", () => {
    expect(
      firstResultText({
        content: [
          { type: "text", text: "  " },
          { type: "text", text: "actual content" },
        ],
      }),
    ).toBe("actual content");
  });

  it('returns "(empty result)" when there is no usable text', () => {
    expect(firstResultText({})).toBe("(empty result)");
    expect(firstResultText({ content: [] })).toBe("(empty result)");
    expect(firstResultText({ content: [{ type: "text", text: "   " }] })).toBe("(empty result)");
  });

  it("truncates long bodies", () => {
    const long = "x".repeat(1000);
    const out = firstResultText({ content: [{ type: "text", text: long }] });
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThan(long.length);
  });

  it("never cuts a surrogate pair in half, whatever the tool returned", () => {
    // Third-party tool output is where an emoji or CJK-extension character
    // most plausibly straddles the 600-char boundary. A plain slice left the
    // high half alone in the string, the SDK serialized it as a lone escape,
    // and a strict client-side decoder rejected the sampling request -- a
    // null vote nobody could see in the prompt text.
    const text = `${"x".repeat(599)}${String.fromCodePoint(0x1f511)} tail`;
    const out = firstResultText({ content: [{ type: "text", text }] });
    expect(hasLoneSurrogate(out), out.slice(-8)).toBe(false);
    expect(out.endsWith("...")).toBe(true);
  });
});

/** A high half with no low half after it, or a low half with no high half
 *  before it -- the shape String.prototype.isWellFormed rejects (this
 *  project's TS lib target predates that method). */
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

describe("capForPrompt", () => {
  it("leaves a string under the cap alone, marker and all", () => {
    expect(capForPrompt("short", 200)).toBe("short");
    expect(capForPrompt("y".repeat(200), 200)).toBe("y".repeat(200));
  });

  it("backs off one unit when the cut lands inside a surrogate pair", () => {
    // The whole reason the three cuts in this file share one helper.
    const s = `${"a".repeat(199)}${String.fromCodePoint(0x1f600)}b`;
    const cut = capForPrompt(s, 200);
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(cut).toBe(`${"a".repeat(199)}...`);
  });

  it("cuts at the cap when the boundary is not a surrogate", () => {
    expect(capForPrompt("z".repeat(250), 200)).toBe(`${"z".repeat(200)}...`);
  });
});

describe("buildGraderPrompt", () => {
  it("includes the goal line when an intent is present", () => {
    const p = buildGraderPrompt({ intent: "find open PRs", toolName: "list_prs", resultText: "[]" });
    expect(p).toContain("Goal: find open PRs");
    expect(p).toContain("Tool called: list_prs");
    expect(p).toContain("YES, PARTIAL, or NO");
    // The labelled form parseGrade prefers.
    expect(p).toContain("GRADE: <word>");
  });

  it("omits the goal line when no intent is known", () => {
    const p = buildGraderPrompt({ toolName: "list_prs", resultText: "[]" });
    expect(p).not.toContain("Goal:");
  });

  it("truncates a long intent, the one field that used to skip every bound", () => {
    // resultText is fenced AND length-capped; the intent was interpolated raw,
    // so an unbounded caller-supplied string went straight into the client's
    // sampling budget.
    const p = buildGraderPrompt({ intent: "z".repeat(500), toolName: "t", resultText: "[]" });
    expect(p).toContain(`Goal: ${"z".repeat(200)}...`);
    expect(p).not.toContain("z".repeat(201));
  });

  it("truncates fenced content at 4000 chars and appends the truncation marker", () => {
    // Build resultText that is longer than the 4000-char cap.
    const longResult = "A".repeat(5000);
    const p = buildGraderPrompt({ toolName: "t", resultText: longResult });
    // The fenced region must not contain the full 5000 chars.
    expect(p.length).toBeLessThan(5000 + 500); // rough upper bound for prompt overhead
    // The truncation marker must appear inside the fenced block.
    expect(p).toContain("...<truncated>");
    // The first 4000 chars of resultText must be present.
    expect(p).toContain("A".repeat(4000));
    // Char 4001 onwards must NOT be present (they were cut off).
    expect(p).not.toContain("A".repeat(4001));
  });

  it("keeps the fenced cut off a surrogate pair, and the goal line too", () => {
    // The two remaining cuts in this prompt. Both feed the same sampling
    // request the snippet does, so both can put a lone surrogate in front of
    // the client's decoder; the fenced one carries third-party tool text,
    // where an emoji at 4000 chars is the likelier accident of the two.
    const key = String.fromCodePoint(0x1f511);
    const p = buildGraderPrompt({
      intent: `${"z".repeat(199)}${key} rest`,
      toolName: "t",
      resultText: `${"A".repeat(3999)}${key} rest`,
    });
    expect(hasLoneSurrogate(p)).toBe(false);
    expect(p).toContain("...<truncated>");
    expect(p).toContain(`Goal: ${"z".repeat(199)}...`);
  });
});

describe("parseGrade", () => {
  it("maps YES/PARTIAL/NO (case-insensitive) and handles stray prose", () => {
    expect(parseGrade("YES")).toBe(1.0);
    expect(parseGrade("partial")).toBe(0.5);
    expect(parseGrade("NO")).toBe(0.0);
    expect(parseGrade("No, it returned nothing")).toBe(0.0);
  });
  it("returns null when no verdict word appears", () => {
    expect(parseGrade("maybe?")).toBeNull();
    expect(parseGrade("")).toBeNull();
  });

  // Regression: the parse took the FIRST whole-word verdict, so a reply that
  // narrated before deciding was graded on a word from its subordinate
  // clause -- always in the harsh direction, wiping success credit off a
  // namespace whose call actually worked.
  it("takes the LAST verdict when the reply narrates before deciding", () => {
    expect(parseGrade("No results were returned, but YES the call succeeded")).toBe(1.0);
    expect(parseGrade("Yes, it answered, but NO it did not accomplish the goal")).toBe(0.0);
  });

  it("prefers an explicit GRADE: token over any verdict word in the prose", () => {
    // buildGraderPrompt asks for this shape, so it wins outright -- even when
    // a later bare word would otherwise be the last match. NL is built, not
    // typed, so no escape sequence is hand-written into the fixture.
    const NL = String.fromCharCode(10);
    expect(parseGrade(`GRADE: YES${NL}no errors were reported`)).toBe(1.0);
    expect(parseGrade(`The call looks fine.${NL}GRADE: partial`)).toBe(0.5);
    expect(parseGrade("grade:no")).toBe(0.0);
  });
});

describe("gradeOutcomeViaSampling", () => {
  const ctx = { toolName: "t", resultText: "r" };

  it("returns null when the client has no sampling capability", async () => {
    const server = mockServer({}); // no sampling
    expect(await gradeOutcomeViaSampling(server, ctx)).toBeNull();
  });

  it("grades YES -> 1.0 / PARTIAL -> 0.5 / NO -> 0.0", async () => {
    for (const [word, expected] of [
      ["YES", 1.0],
      ["PARTIAL", 0.5],
      ["NO", 0.0],
    ] as const) {
      const server = mockServer({ sampling: {} }, async () => ({ content: { type: "text", text: word } }));
      expect(await gradeOutcomeViaSampling(server, ctx)).toBe(expected);
    }
  });

  it("reads text from an array content block", async () => {
    const server = mockServer({ sampling: {} }, async () => ({ content: [{ type: "text", text: "NO" }] }));
    expect(await gradeOutcomeViaSampling(server, ctx)).toBe(0.0);
  });

  it("returns null when the reply names no verdict", async () => {
    const server = mockServer({ sampling: {} }, async () => ({ content: { type: "text", text: "hmm" } }));
    expect(await gradeOutcomeViaSampling(server, ctx)).toBeNull();
  });

  it("returns null (never throws) when createMessage rejects", async () => {
    const server = mockServer({ sampling: {} }, async () => {
      throw new Error("declined");
    });
    expect(await gradeOutcomeViaSampling(server, ctx)).toBeNull();
  });

  it("returns null on timeout", async () => {
    vi.useFakeTimers();
    try {
      const server = mockServer({ sampling: {} }, () => new Promise(() => {})); // never resolves
      const p = gradeOutcomeViaSampling(server, ctx);
      await vi.advanceTimersByTimeAsync(4000);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression: the grader used to abandon the sampling promise locally at 4s
  // while the SDK request stayed outstanding (and the client generating)
  // until the SDK's 60s default request timeout. Passing a RequestOptions
  // timeout makes the SDK send notifications/cancelled at the same deadline.
  it("passes a request timeout to createMessage so the SDK cancels the sampling request", async () => {
    let seenOptions: unknown;
    const server = mockServer({ sampling: {} }, async (_params, options) => {
      seenOptions = options;
      return { content: { type: "text", text: "YES" } };
    });
    expect(await gradeOutcomeViaSampling(server, ctx)).toBe(1.0);
    expect(seenOptions).toMatchObject({ timeout: 4000 });
  });

  // Regression: an 8-token budget truncated the reply before the labelled
  // `GRADE:` line the prompt asks for could land, which put parseGrade back on
  // a verdict word from the narration -- the mis-grade the last-verdict rule
  // exists to prevent.
  it("budgets enough tokens for a labelled verdict to land after a sentence of narration", async () => {
    let seenParams: { maxTokens?: number } | undefined;
    const server = mockServer({ sampling: {} }, async (params) => {
      seenParams = params as { maxTokens?: number };
      return { content: { type: "text", text: "No results were returned, but the call succeeded. GRADE: YES" } };
    });
    expect(await gradeOutcomeViaSampling(server, ctx)).toBe(1.0);
    expect(seenParams?.maxTokens).toBeGreaterThanOrEqual(48);
  });

  it("returns null (never throws) when the SDK's request timeout rejects the call", async () => {
    // The SDK rejects with an McpError(RequestTimeout) after sending the
    // cancellation notification; the grader must swallow it into null.
    const server = mockServer({ sampling: {} }, async () => {
      throw new Error("MCP error -32001: Request timed out");
    });
    expect(await gradeOutcomeViaSampling(server, ctx)).toBeNull();
  });
});
