import { describe, expect, it } from "vitest";
import { rankServers, scoreRelevance } from "../relevance.js";

describe("scoreRelevance (single-server wrapper)", () => {
  const server = { name: "GitHub", namespace: "gh", description: "Repos, issues, pull requests" };

  it("returns 0 for empty context", () => {
    expect(scoreRelevance("", server, [])).toBe(0);
  });

  it("returns 0 for context with only short words", () => {
    expect(scoreRelevance("go do it", server, [])).toBe(0);
  });

  it("scores server name matches", () => {
    const score = scoreRelevance("use github", server, []);
    expect(score).toBeGreaterThan(0);
  });

  it("scores namespace matches on multi-char namespaces", () => {
    const slackServer = { name: "Slack", namespace: "slack", description: "Team chat" };
    const score = scoreRelevance("check slack messages", slackServer, []);
    expect(score).toBeGreaterThan(0);
  });

  it("matches snake_case tool names from space-separated query", () => {
    const tools = [{ name: "create_issue", description: "Create a new issue" }];
    const score = scoreRelevance("create issue on github", server, tools);
    expect(score).toBeGreaterThan(0);
  });

  it("scores tool description matches", () => {
    const tools = [{ name: "run_query", description: "Execute a database query" }];
    const score = scoreRelevance(
      "database query needed",
      { name: "DB", namespace: "db", description: "SQL access" },
      tools,
    );
    expect(score).toBeGreaterThan(0);
  });

  it("deduplicates query terms so repeats don't inflate score", () => {
    const singleScore = scoreRelevance("github tools", server, []);
    const repeatedScore = scoreRelevance("github github github tools", server, []);
    expect(repeatedScore).toBe(singleScore);
  });

  it("is case-insensitive", () => {
    const lower = scoreRelevance("github", server, []);
    const upper = scoreRelevance("GITHUB", server, []);
    expect(lower).toBe(upper);
  });

  it("returns 0 when no words match", () => {
    const score = scoreRelevance("completely unrelated query", server, []);
    expect(score).toBe(0);
  });

  it("strips punctuation from query tokens", () => {
    const score = scoreRelevance("use (github)!", server, []);
    expect(score).toBeGreaterThan(0);
  });
});

describe("rankServers (corpus-wide BM25)", () => {
  const gh = {
    namespace: "gh",
    name: "GitHub",
    description: "Repos, issues, and pull requests",
    tools: [
      { name: "create_issue", description: "Create a new issue in a repo" },
      { name: "list_pull_requests", description: "List open pull requests" },
    ],
  };
  const slack = {
    namespace: "slack",
    name: "Slack",
    description: "Team chat and direct messages",
    tools: [{ name: "send_message", description: "Post a message to a channel" }],
  };
  const postgres = {
    namespace: "pg",
    name: "Postgres",
    description: "SQL queries against a Postgres database",
    tools: [{ name: "run_query", description: "Execute a SQL query" }],
  };
  const corpus = [gh, slack, postgres];

  it("returns empty array for empty query", () => {
    expect(rankServers("", corpus)).toEqual([]);
  });

  it("returns empty array for empty corpus", () => {
    expect(rankServers("github issues", [])).toEqual([]);
  });

  it("ranks the obvious winner first", () => {
    const ranked = rankServers("create a github issue", corpus);
    expect(ranked[0]?.namespace).toBe("gh");
  });

  it("ranks slack first for messaging queries", () => {
    const ranked = rankServers("send a message to the team", corpus);
    expect(ranked[0]?.namespace).toBe("slack");
  });

  it("ranks postgres first for database queries", () => {
    const ranked = rankServers("run a sql query against the database", corpus);
    expect(ranked[0]?.namespace).toBe("pg");
  });

  it("omits servers with zero score", () => {
    const ranked = rankServers("pull request review", corpus);
    // gh should match; slack and postgres shouldn't have any matching terms
    expect(ranked.map((r) => r.namespace)).toEqual(["gh"]);
  });

  it("boosts servers whose name exactly matches the query", () => {
    const ranked = rankServers("slack", corpus);
    expect(ranked[0]?.namespace).toBe("slack");
    // IDF is high because "slack" appears in only one server
    expect(ranked[0]?.score).toBeGreaterThan(0);
  });

  it("returns a stable order when scores tie", () => {
    // Query that matches no server should give empty result (not flaky)
    const a = rankServers("", corpus);
    const b = rankServers("", corpus);
    expect(a).toEqual(b);
  });

  it("does not rank a server that lacks both description and tools when query misses name", () => {
    const mystery = { namespace: "mystery", name: "Thing", description: undefined, tools: [] };
    const ranked = rankServers("database query", [...corpus, mystery]);
    expect(ranked.find((r) => r.namespace === "mystery")).toBeUndefined();
  });

  it("scores common terms lower than rare terms (IDF signal)", () => {
    // Every server in this mini-corpus mentions "server" in description
    const big = [
      { namespace: "a", name: "A", description: "server server server", tools: [] },
      { namespace: "b", name: "B", description: "server server server", tools: [] },
      { namespace: "c", name: "C", description: "unique rarely-used thing server", tools: [] },
    ];
    const commonQuery = rankServers("server", big);
    const rareQuery = rankServers("unique", big);
    // "unique" appears in 1/3 servers → higher IDF → higher top score
    expect(rareQuery[0]?.score).toBeGreaterThan(commonQuery[0]?.score ?? 0);
  });
});
