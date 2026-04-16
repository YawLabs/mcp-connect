import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildCandidates,
  buildTiebreakPrompt,
  parseTiebreakResponse,
  shouldTiebreak,
  tiebreakViaSampling,
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

describe("tiebreakViaSampling", () => {
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
    const out = await tiebreakViaSampling(server, "intent", candidates);
    expect(out).toBeNull();
  });

  it("returns null with fewer than 2 candidates", async () => {
    const server = mockServer({ sampling: {} });
    const out = await tiebreakViaSampling(server, "intent", [candidates[0]!]);
    expect(out).toBeNull();
  });

  it("returns the picked namespace when sampling succeeds", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: { type: "text", text: "github" },
    });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await tiebreakViaSampling(server, "intent", candidates);
    expect(out).toBe("github");
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it("handles array-shaped content", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "gitlab is better" }],
    });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await tiebreakViaSampling(server, "intent", candidates);
    expect(out).toBe("gitlab");
  });

  it("returns null when the LLM names no candidate", async () => {
    const createMessage = vi.fn().mockResolvedValue({
      content: { type: "text", text: "I don't know" },
    });
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await tiebreakViaSampling(server, "intent", candidates);
    expect(out).toBeNull();
  });

  it("swallows createMessage errors and returns null", async () => {
    const createMessage = vi.fn().mockRejectedValue(new Error("upstream refused"));
    const server = mockServer({ sampling: {} }, createMessage);
    const out = await tiebreakViaSampling(server, "intent", candidates);
    expect(out).toBeNull();
  });
});
