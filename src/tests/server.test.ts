import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock external dependencies before importing the module under test
vi.mock("undici", () => ({
  request: vi.fn().mockResolvedValue({
    statusCode: 200,
    body: {
      text: vi.fn().mockResolvedValue(""),
      json: vi.fn().mockResolvedValue({ servers: [], configVersion: "v1" }),
    },
  }),
}));

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    fetchConfig: vi.fn().mockResolvedValue({ servers: [], configVersion: "v1" }),
  };
});

import { request } from "undici";
import { fetchConfig } from "../config.js";

vi.mock("../analytics.js", () => ({
  initAnalytics: vi.fn(),
  recordConnectEvent: vi.fn(),
  shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
}));

import { buildToolList } from "../proxy.js";
import { ConnectServer, computeToolOverlaps, isAutoLoadEnabled } from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { connectToUpstream, disconnectFromUpstream } from "../upstream.js";

function makeConfig(servers: UpstreamServerConfig[]) {
  return { servers, configVersion: "v1" };
}

function makeServerConfig(overrides: Partial<UpstreamServerConfig> = {}): UpstreamServerConfig {
  return {
    id: "1",
    name: "Test Server",
    namespace: "test",
    type: "local",
    command: "echo",
    isActive: true,
    ...overrides,
  };
}

function makeConnection(
  namespace: string,
  tools: string[] = [],
  status: "connected" | "error" = "connected",
): UpstreamConnection {
  return {
    config: makeServerConfig({ namespace, name: namespace }),
    client: { callTool: vi.fn(), close: vi.fn() } as any,
    transport: {} as any,
    tools: tools.map((name) => ({
      name,
      namespacedName: `${namespace}_${name}`,
      inputSchema: { type: "object" },
    })),
    resources: [],
    prompts: [],
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0 },
    status,
  } as UpstreamConnection;
}

// Access private members for testing
function getPrivate(server: ConnectServer) {
  return server as any;
}

describe("ConnectServer", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://mcp.hosting", "test-token");
  });

  afterEach(async () => {
    await server.shutdown();
  });

  describe("handleDiscover", () => {
    it("returns empty message when no config", () => {
      const priv = getPrivate(server);
      priv.config = null;
      const result = priv.handleDiscover();
      expect(result.content[0].text).toContain("No servers installed");
    });

    it("returns empty message when no servers", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([]);
      const result = priv.handleDiscover();
      expect(result.content[0].text).toContain("No servers installed");
    });

    it("lists active servers with status", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "slack", name: "Slack" }),
      ]);
      const conn = makeConnection("gh", ["create_issue", "list_prs"]);
      priv.connections.set("gh", conn);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("gh — GitHub [loaded (2 tools)]");
      expect(text).toContain("slack — Slack [ready]");
      expect(text).toContain("1 loaded in this session, 2 tools in context");
    });

    it("shows disabled servers separately", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub", isActive: true }),
        makeServerConfig({ namespace: "old", name: "Old Server", isActive: false }),
      ]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("Disabled servers:");
      expect(text).toContain("old — Old Server (disabled in dashboard)");
    });

    it("shows cached tools for inactive connections", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.toolCache.set("gh", [{ name: "create_issue" }, { name: "list_prs" }]);

      const result = priv.handleDiscover();
      expect(result.content[0].text).toContain("known tools: create_issue, list_prs");
    });

    it("surfaces a token-cost estimate per server line", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "slack", name: "Slack" }),
      ]);
      // gh is loaded — live tool count, no tilde. slack has cached tools
      // only — cached estimate, tilde prefix.
      priv.connections.set("gh", makeConnection("gh", ["create_issue", "list_prs"]));
      priv.toolCache.set("slack", [{ name: "post" }, { name: "list_channels" }, { name: "dm" }]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      // Connected: "N tools, M tokens" (no tilde prefix on the count).
      expect(text).toMatch(/gh — GitHub.*?— 2 tools, \d+ tokens/);
      // Cached: "N tools, ~M tokens" with tilde.
      expect(text).toMatch(/slack — Slack.*?— 3 tools, ~\d+ tokens/);
      // Session summary also mentions approximate total tokens.
      expect(text).toMatch(/1 loaded in this session, 2 tools in context \(~\d+ tokens\)/);
    });

    it("omits the cost label when there's nothing to estimate", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "nothing", name: "Nothing" })]);
      // No connection, no toolCache — label should be suppressed so the
      // line doesn't read "— 0 tools, 0 tokens".
      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("nothing — Nothing [ready]");
      expect(text).not.toMatch(/nothing — Nothing.*0 tools/);
    });

    it("surfaces a health warning when recent calls are failing", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      // 4/10 failed = 40% → above the 30% warning threshold.
      conn.health = { totalCalls: 10, errorCount: 4, totalLatencyMs: 0, lastErrorMessage: "502 bad gateway" };
      priv.connections.set("gh", conn);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("warn: 4 of last 10 calls failed: 502 bad gateway");
    });

    it("surfaces a recent activation failure as a discover warning", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      // No live connection; activation failure stashed in the map.
      priv.activationFailures.set("gh", { at: Date.now() - 60_000, message: "spawn ENOENT" });

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toMatch(/warn: last activation failed \d+m ago: spawn ENOENT/);
    });

    it("sorts servers by relevance when context provided", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "slack", name: "Slack" }),
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
      ]);

      const result = priv.handleDiscover("github issues");
      const text = result.content[0].text;
      // GitHub should come first due to relevance
      const ghIndex = text.indexOf("gh —");
      const slackIndex = text.indexOf("slack —");
      expect(ghIndex).toBeLessThan(slackIndex);
    });

    it("shows error status for disconnected connections", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      const conn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", conn);

      const result = priv.handleDiscover();
      expect(result.content[0].text).toContain("ERROR (disconnected, will auto-reconnect on use)");
    });

    it("surfaces the marketplace URL hint when the user has a sparse config", () => {
      // Threshold is 5 installed servers; 2 is well below. Hint should
      // point to the publicly-browsable catalog at /explore — there is
      // no JSON API for the catalog, so this is an URL pointer, not a
      // programmatic surface.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "slack", name: "Slack" }),
      ]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("https://mcp.hosting/explore");
      expect(text).toContain("within 60s");
    });

    it("omits the marketplace hint once the user has plenty of servers", () => {
      // Five or more installed servers is a power-user config — the hint
      // would just be noise. Verify the URL pointer is absent.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "slack", name: "Slack" }),
        makeServerConfig({ namespace: "pg", name: "Postgres" }),
        makeServerConfig({ namespace: "s3", name: "S3" }),
        makeServerConfig({ namespace: "redis", name: "Redis" }),
      ]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).not.toContain("https://mcp.hosting/explore");
    });

    it("includes the marketplace pointer in the empty-state message", () => {
      // A fresh user with zero servers sees the empty-state branch —
      // that message also needs the catalog link so they can get started.
      const priv = getPrivate(server);
      priv.config = makeConfig([]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("No servers installed");
      expect(text).toContain("https://mcp.hosting/explore");
    });
  });

  describe("discover tool overlaps", () => {
    it("surfaces a bare tool name shared by two connected servers", () => {
      // fs and github both expose `read_file` — the LLM needs a nudge
      // toward dispatch to pick the right one, so the overlap line lists
      // both namespaces and points at mcp_connect_dispatch.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "fs", name: "FS" }),
        makeServerConfig({ namespace: "github", name: "GitHub" }),
      ]);
      priv.connections.set("fs", makeConnection("fs", ["read_file", "write_file"]));
      priv.connections.set("github", makeConnection("github", ["read_file", "list_repos"]));

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("Overlapping tools (same bare name in multiple servers):");
      expect(text).toContain("read_file — available in: fs, github");
      expect(text).toContain("use mcp_connect_dispatch to disambiguate");
    });

    it("suppresses the overlaps block when no bare names collide", () => {
      // One connected server, no collisions — the block should not even
      // print its header, otherwise we're adding noise to the common case.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "fs", name: "FS" })]);
      priv.connections.set("fs", makeConnection("fs", ["read_file", "write_file"]));

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).not.toContain("Overlapping tools");
    });

    it("lists all namespaces alphabetically when three or more share a name", () => {
      // Three-way overlap — every namespace shows up on the line, sorted
      // alphabetically so the output is deterministic across runs.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "linear", name: "Linear" }),
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "jira", name: "Jira" }),
      ]);
      priv.connections.set("linear", makeConnection("linear", ["list_issues"]));
      priv.connections.set("gh", makeConnection("gh", ["list_issues"]));
      priv.connections.set("jira", makeConnection("jira", ["list_issues"]));

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("list_issues — available in: gh, jira, linear");
    });

    it("caps the overlaps block at the top 5", () => {
      // Seven distinct overlapping bare names, all with the same pair
      // count — the block must stop at 5 and tie-break alphabetically
      // so the rendered list stays bounded. `toolA` through `toolE`
      // should be kept; `toolF` and `toolG` should be dropped.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "x", name: "X" }),
        makeServerConfig({ namespace: "y", name: "Y" }),
      ]);
      const overlapping = ["toolG", "toolA", "toolC", "toolE", "toolB", "toolF", "toolD"];
      priv.connections.set("x", makeConnection("x", overlapping));
      priv.connections.set("y", makeConnection("y", overlapping));

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      for (const kept of ["toolA", "toolB", "toolC", "toolD", "toolE"]) {
        expect(text).toContain(`${kept} — available in: x, y`);
      }
      expect(text).not.toContain("toolF — available in");
      expect(text).not.toContain("toolG — available in");
    });

    it("ignores disconnected servers when computing overlaps", () => {
      // A dormant server whose tool cache would otherwise collide must
      // not count — we don't have a live schema for it, so claiming an
      // overlap would be a lie. computeToolOverlaps only sees the
      // connected connection, so no overlap is emitted.
      const conn = makeConnection("fs", ["read_file"]);
      const errored = makeConnection("github", ["read_file"], "error");
      const result = computeToolOverlaps([conn, errored]);
      expect(result).toEqual([]);
    });
  });

  describe("handleActivate", () => {
    it("returns error when no namespaces provided", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleActivate([]);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("server namespace is required");
    });

    it("returns error when namespace not in config", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([]);
      const result = await priv.handleActivate(["unknown"]);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found or disabled");
    });

    it("skips already-active servers", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      priv.connections.set("gh", conn);

      const result = await priv.handleActivate(["gh"]);
      expect(result.content[0].text).toContain("already loaded");
      expect(connectToUpstream).not.toHaveBeenCalled();
    });

    it("activates server and updates tool cache", async () => {
      const priv = getPrivate(server);
      const config = makeServerConfig({ namespace: "gh" });
      priv.config = makeConfig([config]);

      const conn = makeConnection("gh", ["create_issue"]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(conn);

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Loaded "gh"');
      expect(priv.connections.has("gh")).toBe(true);
      expect(priv.toolCache.has("gh")).toBe(true);
      expect(priv.idleCallCounts.get("gh")).toBe(0);
    });

    it("retries on first failure", async () => {
      const priv = getPrivate(server);
      const config = makeServerConfig({ namespace: "gh" });
      priv.config = makeConfig([config]);

      const conn = makeConnection("gh", ["create_issue"]);
      vi.mocked(connectToUpstream).mockRejectedValueOnce(new Error("connection refused")).mockResolvedValueOnce(conn);

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Loaded "gh"');
      expect(connectToUpstream).toHaveBeenCalledTimes(2);
    });

    it("reports failure after both attempts fail", async () => {
      const priv = getPrivate(server);
      const config = makeServerConfig({ namespace: "gh" });
      priv.config = makeConfig([config]);

      vi.mocked(connectToUpstream).mockRejectedValue(new Error("timeout"));

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to load "gh": timeout');
    });

    it("activates multiple servers", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh" }),
        makeServerConfig({ namespace: "slack", name: "Slack" }),
      ]);

      vi.mocked(connectToUpstream)
        .mockResolvedValueOnce(makeConnection("gh", ["create_issue"]))
        .mockResolvedValueOnce(makeConnection("slack", ["send_message"]));

      const result = await priv.handleActivate(["gh", "slack"]);
      expect(result.isError).toBeUndefined();
      expect(priv.connections.size).toBe(2);
    });
  });

  describe("compliance-aware routing", () => {
    // vi.unstubAllEnvs() restores every stubbed env var after each case so
    // an errant MCPH_MIN_COMPLIANCE can't leak into later suites.
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("refuses to activate a below-grade server with a clear error", async () => {
      vi.stubEnv("MCPH_MIN_COMPLIANCE", "B");
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "D" })]);

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Refused to load "gh"');
      expect(text).toContain("grade D");
      expect(text).toContain("MCPH_MIN_COMPLIANCE=B");
      expect(text).toContain("Unset MCPH_MIN_COMPLIANCE");
      // No upstream spawn — the gate must short-circuit before activation.
      expect(connectToUpstream).not.toHaveBeenCalled();
      expect(priv.connections.has("gh")).toBe(false);
    });

    it("allows activation when the grade meets the minimum", async () => {
      vi.stubEnv("MCPH_MIN_COMPLIANCE", "B");
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "A" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Loaded "gh"');
      expect(priv.connections.has("gh")).toBe(true);
    });

    it("allows activation for ungraded servers even when the filter is on (don't punish unknown)", async () => {
      vi.stubEnv("MCPH_MIN_COMPLIANCE", "A");
      const priv = getPrivate(server);
      // No complianceGrade on this config — mirrors today's backend.
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBeUndefined();
      expect(priv.connections.has("gh")).toBe(true);
    });

    it("does not filter anything when MCPH_MIN_COMPLIANCE is unset", async () => {
      vi.stubEnv("MCPH_MIN_COMPLIANCE", "");
      const priv = getPrivate(server);
      // Even an F-grade server is activatable with the filter disabled.
      priv.config = makeConfig([makeServerConfig({ namespace: "bad", name: "Bad", complianceGrade: "F" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("bad", ["t"]));

      const result = await priv.handleActivate(["bad"]);
      expect(result.isError).toBeUndefined();
      expect(priv.connections.has("bad")).toBe(true);
    });

    it("annotates below-grade servers in discover output and emits a filter header", () => {
      vi.stubEnv("MCPH_MIN_COMPLIANCE", "B");
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "A" }),
        makeServerConfig({ namespace: "bad", name: "Bad Server", complianceGrade: "D" }),
        makeServerConfig({ namespace: "raw", name: "Ungraded" }),
      ]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("Compliance filter active: MCPH_MIN_COMPLIANCE=B");
      // Passing grade is surfaced inline as `[A]`.
      expect(text).toMatch(/gh — GitHub.*\[A\]/);
      // Failing server is surfaced in place with the refusal reason.
      expect(text).toContain("bad — Bad Server");
      expect(text).toContain("(grade D — below MCPH_MIN_COMPLIANCE=B, won't auto-activate)");
      // Ungraded server gets no annotation — avoids cluttering every
      // current deploy where nothing is scored yet.
      expect(text).not.toMatch(/raw — Ungraded.*\[[A-F]\]/);
      expect(text).not.toMatch(/raw — Ungraded.*won't auto-activate/);
    });

    it("omits the filter header and `[grade]` annotations when the env is unset", () => {
      vi.stubEnv("MCPH_MIN_COMPLIANCE", "");
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "B" })]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).not.toContain("Compliance filter active");
      // With the filter off we still don't clutter the line with a
      // grade tag — the annotation is only interesting relative to a
      // configured minimum. (Current behavior: `[B]` appears only when
      // the filter is on. Keep this test honest to that contract.)
      expect(text).not.toMatch(/gh — GitHub.*\[B\]/);
    });
  });

  describe("per-tool load", () => {
    // `tools/list` is constructed by buildToolList(this.connections, …,
    // this.toolFilters). These tests drive handleToolCall so the full
    // activate → filter-apply → routes rebuild → list path is exercised
    // end-to-end, matching what a real MCP client would see.
    function listedUpstreamToolNames(priv: any): string[] {
      return buildToolList(priv.connections, priv.getDeferredServers(), priv.toolFilters)
        .map((t: { name: string }) => t.name)
        .filter((n: string) => !n.startsWith("mcp_connect_"));
    }

    it("activate without tools exposes every upstream tool (baseline)", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo", "bar", "baz"]));

      const result = await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
      expect(result.isError).toBeUndefined();
      expect(priv.toolFilters.has("gh")).toBe(false);
      expect(listedUpstreamToolNames(priv).sort()).toEqual(["gh_bar", "gh_baz", "gh_foo"]);
    });

    it("activate with tools: ['foo'] only surfaces that one tool (others hidden)", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo", "bar", "baz"]));

      await priv.handleToolCall("mcp_connect_activate", { server: "gh", tools: ["foo"] });

      // Filter is persisted on the server for subsequent tools/list calls.
      expect(priv.toolFilters.get("gh")).toEqual(new Set(["foo"]));
      expect(listedUpstreamToolNames(priv)).toEqual(["gh_foo"]);
    });

    it("re-activating the same namespace without tools clears the filter", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      // Both calls go through handleToolCall → activateOne; the second
      // hits the "already connected" early return but still has to
      // clear the filter so the list re-expands.
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo", "bar"]));

      await priv.handleToolCall("mcp_connect_activate", { server: "gh", tools: ["foo"] });
      expect(listedUpstreamToolNames(priv)).toEqual(["gh_foo"]);

      await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
      expect(priv.toolFilters.has("gh")).toBe(false);
      expect(listedUpstreamToolNames(priv).sort()).toEqual(["gh_bar", "gh_foo"]);
    });

    it("dispatch path still routes filtered-out tools (raw upstream reachable)", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const conn = makeConnection("gh", ["foo", "bar"]);
      // The filtered-out tool `bar` must still reach the upstream.
      conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "bar called" }] });
      vi.mocked(connectToUpstream).mockResolvedValueOnce(conn);

      await priv.handleToolCall("mcp_connect_activate", { server: "gh", tools: ["foo"] });

      // `gh_bar` is absent from tools/list …
      expect(listedUpstreamToolNames(priv)).toEqual(["gh_foo"]);
      // … but the route map still carries it (dispatch path unchanged).
      expect(priv.toolRoutes.has("gh_bar")).toBe(true);

      // And handleToolCall on the hidden tool dispatches to the upstream.
      const callResult = await priv.handleToolCall("gh_bar", {});
      expect(callResult.isError).toBeUndefined();
      expect(callResult.content[0].text).toBe("bar called");
      expect(conn.client.callTool).toHaveBeenCalledWith({ name: "bar", arguments: {} });
    });

    it("discover() surfaces a 'filtered: K of N' indicator for filtered servers", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo", "bar", "baz"]));

      await priv.handleToolCall("mcp_connect_activate", { server: "gh", tools: ["foo"] });

      const text = priv.handleDiscover().content[0].text;
      // Count reflects the filtered (exposed) tool set …
      expect(text).toContain("loaded (1 tools)");
      // … and the indicator shows how many are hidden behind the filter.
      expect(text).toContain("filtered: 1 of 3");
      // Session summary counts only exposed tools, not the full upstream.
      expect(text).toContain("1 loaded in this session, 1 tools in context");
    });

    it("multi-server activate ignores tools and clears any existing filter", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh" }),
        makeServerConfig({ namespace: "slack", name: "Slack" }),
      ]);
      // Pre-seed a filter on gh from an earlier single-server activate.
      priv.connections.set("gh", makeConnection("gh", ["foo", "bar"]));
      priv.toolFilters.set("gh", new Set(["foo"]));
      // Re-activate multi-server → filter must clear.
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("slack", ["send"]));

      await priv.handleToolCall("mcp_connect_activate", { servers: ["gh", "slack"], tools: ["foo"] });

      expect(priv.toolFilters.has("gh")).toBe(false);
      expect(priv.toolFilters.has("slack")).toBe(false);
      expect(listedUpstreamToolNames(priv).sort()).toEqual(["gh_bar", "gh_foo", "slack_send"]);
    });

    it("deactivating a server also drops its filter", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh", ["foo", "bar"]));
      priv.toolFilters.set("gh", new Set(["foo"]));

      await priv.handleDeactivate(["gh"]);
      expect(priv.toolFilters.has("gh")).toBe(false);
    });
  });

  describe("handleDeactivate", () => {
    it("returns error when no namespaces provided", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleDeactivate([]);
      expect(result.isError).toBe(true);
    });

    it("reports when server is not loaded", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleDeactivate(["unknown"]);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("wasn't loaded");
    });

    it("unloads a loaded server", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      priv.connections.set("gh", conn);
      priv.idleCallCounts.set("gh", 5);

      const result = await priv.handleDeactivate(["gh"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Unloaded "gh"');
      expect(priv.connections.has("gh")).toBe(false);
      expect(priv.idleCallCounts.has("gh")).toBe(false);
      expect(disconnectFromUpstream).toHaveBeenCalledWith(conn);
    });

    it("deactivates multiple servers", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("slack", makeConnection("slack"));

      const result = await priv.handleDeactivate(["gh", "slack"]);
      expect(priv.connections.size).toBe(0);
      expect(result.content[0].text).toContain("gh");
      expect(result.content[0].text).toContain("slack");
    });
  });

  describe("trackUsageAndAutoDeactivate", () => {
    it("resets idle count for called server", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.idleCallCounts.set("gh", 5);

      await priv.trackUsageAndAutoDeactivate("gh");
      expect(priv.idleCallCounts.get("gh")).toBe(0);
    });

    it("increments idle count for other servers", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("slack", makeConnection("slack"));
      priv.idleCallCounts.set("gh", 0);
      priv.idleCallCounts.set("slack", 0);

      await priv.trackUsageAndAutoDeactivate("gh");
      expect(priv.idleCallCounts.get("gh")).toBe(0);
      expect(priv.idleCallCounts.get("slack")).toBe(1);
    });

    it("auto-deactivates servers at idle threshold", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("slack", makeConnection("slack"));
      priv.idleCallCounts.set("gh", 0);
      // Set slack to threshold - 1; the next increment will trigger deactivation
      priv.idleCallCounts.set("slack", (ConnectServer as any).IDLE_CALL_THRESHOLD - 1);

      await priv.trackUsageAndAutoDeactivate("gh");
      expect(priv.connections.has("slack")).toBe(false);
      expect(priv.idleCallCounts.has("slack")).toBe(false);
      expect(disconnectFromUpstream).toHaveBeenCalled();
    });

    it("does not deactivate servers below threshold", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("slack", makeConnection("slack"));
      priv.idleCallCounts.set("gh", 0);
      priv.idleCallCounts.set("slack", 3);

      await priv.trackUsageAndAutoDeactivate("gh");
      expect(priv.connections.has("slack")).toBe(true);
    });

    it("records called namespace in rolling history", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));

      await priv.trackUsageAndAutoDeactivate("gh");
      expect(priv.recentToolCalls.length).toBe(1);
      expect(priv.recentToolCalls[0].namespace).toBe("gh");
      expect(typeof priv.recentToolCalls[0].at).toBe("number");
    });

    it("gives a bursty namespace adaptive patience past the baseline", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("slack", makeConnection("slack"));

      const baseline = (ConnectServer as any).IDLE_CALL_THRESHOLD as number;
      const now = Date.now();
      // Seed history with recent slack activity so slack has earned
      // adaptive patience. 5 recent calls → bonus 10 → threshold 20.
      for (let i = 0; i < 5; i++) {
        priv.recentToolCalls.push({ namespace: "slack", at: now - i * 1000 });
      }
      // Push slack one tick away from the STATIC baseline.
      priv.idleCallCounts.set("slack", baseline - 1);

      await priv.trackUsageAndAutoDeactivate("gh");

      // Slack now sits at exactly baseline idle calls, but the
      // adaptive threshold is higher — it should stay connected.
      expect(priv.connections.has("slack")).toBe(true);
      expect(priv.idleCallCounts.get("slack")).toBe(baseline);
    });

    it("still deactivates a bursty namespace once idle exceeds adaptive cap", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("slack", makeConnection("slack"));

      const now = Date.now();
      // Give slack some recent activity (earns adaptive patience).
      for (let i = 0; i < 3; i++) {
        priv.recentToolCalls.push({ namespace: "slack", at: now - i * 1000 });
      }
      // Set slack way over the adaptive ceiling (50) so it's definitely toast.
      priv.idleCallCounts.set("slack", 60);

      await priv.trackUsageAndAutoDeactivate("gh");
      expect(priv.connections.has("slack")).toBe(false);
    });
  });

  describe("reconcileConfig", () => {
    it("removes servers no longer in config", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.idleCallCounts.set("gh", 0);

      await priv.reconcileConfig(makeConfig([]));
      expect(priv.connections.has("gh")).toBe(false);
      expect(disconnectFromUpstream).toHaveBeenCalled();
    });

    it("removes servers that became disabled", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));

      await priv.reconcileConfig(makeConfig([makeServerConfig({ namespace: "gh", isActive: false })]));
      expect(priv.connections.has("gh")).toBe(false);
    });

    it("removes servers whose config changed", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh");
      conn.config = makeServerConfig({ namespace: "gh", command: "old-cmd" });
      priv.connections.set("gh", conn);

      await priv.reconcileConfig(makeConfig([makeServerConfig({ namespace: "gh", command: "new-cmd" })]));
      expect(priv.connections.has("gh")).toBe(false);
    });

    it("keeps servers whose config is unchanged", async () => {
      const priv = getPrivate(server);
      const config = makeServerConfig({ namespace: "gh" });
      const conn = makeConnection("gh");
      conn.config = config;
      priv.connections.set("gh", conn);

      await priv.reconcileConfig(makeConfig([config]));
      expect(priv.connections.has("gh")).toBe(true);
      expect(disconnectFromUpstream).not.toHaveBeenCalled();
    });

    it("detects args changes without JSON.stringify", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh");
      conn.config = makeServerConfig({ namespace: "gh", args: ["--flag"] });
      priv.connections.set("gh", conn);

      await priv.reconcileConfig(makeConfig([makeServerConfig({ namespace: "gh", args: ["--other-flag"] })]));
      expect(priv.connections.has("gh")).toBe(false);
    });

    it("detects env changes", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh");
      conn.config = makeServerConfig({ namespace: "gh", env: { KEY: "old" } });
      priv.connections.set("gh", conn);

      await priv.reconcileConfig(makeConfig([makeServerConfig({ namespace: "gh", env: { KEY: "new" } })]));
      expect(priv.connections.has("gh")).toBe(false);
    });
  });

  describe("handleHealth", () => {
    it("returns empty message when no connections", () => {
      const priv = getPrivate(server);
      const result = priv.handleHealth();
      expect(result.content[0].text).toContain("No servers loaded in this session");
    });

    it("shows health stats for active connections", () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.health = { totalCalls: 10, errorCount: 2, totalLatencyMs: 500 };
      priv.connections.set("gh", conn);
      priv.idleCallCounts.set("gh", 3);

      const result = priv.handleHealth();
      const text = result.content[0].text;
      expect(text).toContain("gh [connected]");
      expect(text).toContain("calls: 10, errors: 2 (20%)");
      expect(text).toContain("avg latency: 50ms");
      expect(text).toContain("idle: 3/");
    });

    it("shows last error when present", () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh");
      conn.health = {
        totalCalls: 5,
        errorCount: 1,
        totalLatencyMs: 100,
        lastErrorMessage: "timeout",
        lastErrorAt: "2026-01-01T00:00:00Z",
      };
      priv.connections.set("gh", conn);

      const result = priv.handleHealth();
      expect(result.content[0].text).toContain("last error: timeout at 2026-01-01T00:00:00Z");
    });
  });

  describe("discover usage hints", () => {
    it("surfaces a success count from the learning store", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      // Three successful dispatches — enough for the hint to show.
      priv.learning.recordSuccess("gh");
      priv.learning.recordSuccess("gh");
      priv.learning.recordSuccess("gh");

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).toContain("usage: used 3x");
    });

    it("surfaces co-usage peers from the pack detector", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "gh", name: "GitHub" }),
        makeServerConfig({ id: "2", namespace: "linear", name: "Linear" }),
      ]);
      // Two bursts of (gh, linear) — enough for a detected pack.
      const t0 = 1_000_000;
      priv.packDetector.recordCall("gh", "create_issue", t0);
      priv.packDetector.recordCall("linear", "list_issues", t0 + 1000);
      priv.packDetector.recordCall("gh", "create_issue", t0 + 300_000);
      priv.packDetector.recordCall("linear", "list_issues", t0 + 301_000);

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).toContain('often loaded with "linear"');
      expect(result.content[0].text).toContain('often loaded with "gh"');
    });

    it("stays silent when neither signal has evidence", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).not.toContain("usage:");
    });
  });

  describe("discover recurring-packs block", () => {
    it("surfaces an actionable pack with a ready-to-run activate call", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "gh", name: "GitHub" }),
        makeServerConfig({ id: "2", namespace: "linear", name: "Linear" }),
      ]);
      // Two bursts of (gh, linear) → one detected pack.
      const t0 = 1_000_000;
      priv.packDetector.recordCall("gh", "create_issue", t0);
      priv.packDetector.recordCall("linear", "list_issues", t0 + 1000);
      priv.packDetector.recordCall("gh", "create_issue", t0 + 300_000);
      priv.packDetector.recordCall("linear", "list_issues", t0 + 301_000);

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      const text = result.content[0].text;
      expect(text).toContain("Recurring packs");
      expect(text).toContain("seen 2x");
      // Both namespaces appear, ready-to-run namespaces=["..","..."] verbatim.
      expect(text).toMatch(/namespaces=\[.*"gh".*"linear".*\]|namespaces=\[.*"linear".*"gh".*\]/);
    });

    it("omits the block when every pack is already fully loaded", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "gh", name: "GitHub" }),
        makeServerConfig({ id: "2", namespace: "linear", name: "Linear" }),
      ]);
      const t0 = 1_000_000;
      priv.packDetector.recordCall("gh", "create_issue", t0);
      priv.packDetector.recordCall("linear", "list_issues", t0 + 1000);
      priv.packDetector.recordCall("gh", "create_issue", t0 + 300_000);
      priv.packDetector.recordCall("linear", "list_issues", t0 + 301_000);
      // Already connected — no action for the LLM to take.
      priv.connections.set("gh", { ...makeConnection("gh"), status: "connected" });
      priv.connections.set("linear", { ...makeConnection("linear"), status: "connected" });

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).not.toContain("Recurring packs");
    });

    it("omits the block when any pack namespace isn't installed", async () => {
      const priv = getPrivate(server);
      // `linear` is NOT in the installed set, so the {gh, linear} pack
      // can't be activated as a whole — don't advertise it.
      priv.config = makeConfig([makeServerConfig({ id: "1", namespace: "gh", name: "GitHub" })]);
      const t0 = 1_000_000;
      priv.packDetector.recordCall("gh", "t", t0);
      priv.packDetector.recordCall("linear", "t", t0 + 1000);
      priv.packDetector.recordCall("gh", "t", t0 + 300_000);
      priv.packDetector.recordCall("linear", "t", t0 + 301_000);

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).not.toContain("Recurring packs");
    });
  });

  describe("concurrent server cap", () => {
    it("refuses a new activation when already at cap", async () => {
      const priv = getPrivate(server);
      priv.serverCap = 2;
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "a" }),
        makeServerConfig({ id: "2", namespace: "b" }),
        makeServerConfig({ id: "3", namespace: "c" }),
      ]);
      priv.connections.set("a", makeConnection("a"));
      priv.connections.set("b", makeConnection("b"));

      const result = await priv.handleActivate(["c"]);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Cannot load "c"');
      expect(result.content[0].text).toContain("2-server concurrent cap");
      // The blocked server must not have spawned an upstream.
      expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
      expect(priv.connections.has("c")).toBe(false);
    });

    it("allows reactivating an already-loaded namespace even at cap", async () => {
      const priv = getPrivate(server);
      priv.serverCap = 2;
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "a" }),
        makeServerConfig({ id: "2", namespace: "b" }),
      ]);
      priv.connections.set("a", makeConnection("a"));
      priv.connections.set("b", makeConnection("b"));

      const result = await priv.handleActivate(["a"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('"a" is already loaded');
    });

    it("ignores error-state connections when counting slots", async () => {
      const priv = getPrivate(server);
      priv.serverCap = 2;
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "a" }),
        makeServerConfig({ id: "2", namespace: "b" }),
        makeServerConfig({ id: "3", namespace: "c" }),
      ]);
      priv.connections.set("a", makeConnection("a"));
      // "b" is in error-state — it's not contributing tools, so it must
      // NOT count toward the cap. Otherwise a one-time connection
      // failure permanently burns a slot.
      priv.connections.set("b", makeConnection("b", [], "error"));
      const connC = makeConnection("c", ["t"]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(connC);

      const result = await priv.handleActivate(["c"]);
      expect(result.isError).toBeUndefined();
      expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    });

    it("permits unlimited loads when cap is 0", async () => {
      const priv = getPrivate(server);
      priv.serverCap = 0;
      priv.config = makeConfig([makeServerConfig({ id: "99", namespace: "big" })]);
      // Pre-load 20 servers. Cap of 0 should not care.
      for (let i = 0; i < 20; i++) {
        priv.connections.set(`pre${i}`, makeConnection(`pre${i}`));
      }
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("big", ["t"]));

      const result = await priv.handleActivate(["big"]);
      expect(result.isError).toBeUndefined();
    });
  });

  describe("handleReadTool", () => {
    it("rejects a missing server arg", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleReadTool("", "create_issue");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("`server` is required");
    });

    it("rejects a missing tool arg", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleReadTool("gh", "");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("`tool` is required");
    });

    it("returns a helpful error when the server is not installed", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([]);
      const result = await priv.handleReadTool("gh", "create_issue");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not installed on this account");
    });

    it("reads the schema from a loaded server without reconnecting", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.tools[0].description = "Create a new issue.";
      priv.connections.set("gh", conn);

      const result = await priv.handleReadTool("gh", "create_issue");
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Tool: gh_create_issue");
      expect(result.content[0].text).toContain("Server: GitHub (gh)");
      expect(result.content[0].text).toContain("Create a new issue.");
      // Loaded-server path must NOT trigger a transient connect.
      expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
      expect(vi.mocked(disconnectFromUpstream)).not.toHaveBeenCalled();
    });

    it("accepts the namespaced tool form", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.connections.set("gh", makeConnection("gh", ["create_issue"]));
      const result = await priv.handleReadTool("gh", "gh_create_issue");
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Tool: gh_create_issue");
    });

    it("reports tool-not-found with available tools as a hint", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.connections.set("gh", makeConnection("gh", ["close_issue", "create_issue"]));

      const result = await priv.handleReadTool("gh", "nope");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('"nope" not found on "gh"');
      expect(result.content[0].text).toContain("close_issue");
      expect(result.content[0].text).toContain("create_issue");
    });

    it("transiently connects when the server is installed but not loaded, then disconnects", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      const transient = makeConnection("gh", ["create_issue"]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(transient);

      const result = await priv.handleReadTool("gh", "create_issue");
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Tool: gh_create_issue");
      expect(result.content[0].text).toContain("not currently loaded");
      // The transient connection must be torn down and never registered.
      expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(disconnectFromUpstream)).toHaveBeenCalledTimes(1);
      expect(priv.connections.has("gh")).toBe(false);
    });

    it("surfaces a clean error when the transient connect fails", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      vi.mocked(connectToUpstream).mockRejectedValueOnce(new Error("spawn ENOENT npx"));

      const result = await priv.handleReadTool("gh", "create_issue");
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("spawn ENOENT npx");
      expect(priv.connections.has("gh")).toBe(false);
    });
  });

  describe("handleToolCall", () => {
    it("routes meta-tool discover", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([]);
      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).toContain("No servers installed");
    });

    it("routes meta-tool health", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleToolCall("mcp_connect_health", {});
      expect(result.content[0].text).toContain("No servers loaded in this session");
    });

    it("routes meta-tool activate", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(conn);

      const result = await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
      expect(result.content[0].text).toContain('Loaded "gh"');
    });

    it("routes meta-tool deactivate", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      const result = await priv.handleToolCall("mcp_connect_deactivate", { server: "gh" });
      expect(result.content[0].text).toContain('Unloaded "gh"');
    });

    it("routes meta-tool read_tool", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.connections.set("gh", makeConnection("gh", ["create_issue"]));
      const result = await priv.handleToolCall("mcp_connect_read_tool", { server: "gh", tool: "create_issue" });
      expect(result.content[0].text).toContain("Tool: gh_create_issue");
    });

    it("routes upstream tool calls and tracks health", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Issue created" }],
      });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const result = await priv.handleToolCall("gh_create_issue", { title: "test" });
      expect(result.content[0].text).toBe("Issue created");
      expect(conn.health.totalCalls).toBe(1);
      expect(conn.health.totalLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it("tracks error health on failed tool calls", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.client.callTool = vi.fn().mockRejectedValue(new Error("upstream failed"));
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBe(true);
      expect(conn.health.errorCount).toBe(1);
      expect(conn.health.lastErrorMessage).toBeDefined();
    });

    it("attempts auto-reconnect for errored connections", async () => {
      const priv = getPrivate(server);
      const errorConn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", errorConn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const freshConn = makeConnection("gh", ["create_issue"]);
      freshConn.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Success after reconnect" }],
      });
      vi.mocked(connectToUpstream).mockResolvedValueOnce(freshConn);

      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(disconnectFromUpstream).toHaveBeenCalledWith(errorConn);
      expect(connectToUpstream).toHaveBeenCalled();
      expect(result.content[0].text).toBe("Success after reconnect");
    });

    it("returns error when auto-reconnect fails", async () => {
      const priv = getPrivate(server);
      const errorConn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", errorConn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      vi.mocked(connectToUpstream)
        .mockRejectedValueOnce(new Error("still down"))
        .mockRejectedValueOnce(new Error("still down"));

      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("auto-reconnect failed");
      expect(result.content[0].text).toContain("still down");
    });

    it("returns error for unknown tools", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleToolCall("nonexistent_tool", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });

    it("auto-activates a deferred upstream on first tools/call and re-dispatches", async () => {
      // v0.13: the LLM sees gh_create_issue in tools/list because we
      // advertised it from toolCache before activation. When the LLM
      // calls it, we activate gh, rebuild routes, notify list_changed,
      // then re-dispatch through the fresh (non-deferred) route.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", toolCache: [{ name: "create_issue", description: "cached" }] }),
      ]);
      priv.rebuildRoutes();
      // Pre-call sanity: the route is a deferred placeholder.
      expect(priv.toolRoutes.get("gh_create_issue")?.deferred).toBe(true);

      const freshConn = makeConnection("gh", ["create_issue"]);
      freshConn.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "issue created post-activation" }],
      });
      vi.mocked(connectToUpstream).mockResolvedValueOnce(freshConn);

      const result = await priv.handleToolCall("gh_create_issue", { title: "hi" });
      expect(connectToUpstream).toHaveBeenCalled();
      expect(result.content[0].text).toBe("issue created post-activation");
      // Post-activation the route is live (no deferred flag).
      expect(priv.toolRoutes.get("gh_create_issue")?.deferred).toBeUndefined();
    });

    it("surfaces activation failure when a deferred tool can't connect", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", toolCache: [{ name: "create_issue" }] })]);
      priv.rebuildRoutes();

      vi.mocked(connectToUpstream)
        .mockRejectedValueOnce(new Error("spawn failed"))
        .mockRejectedValueOnce(new Error("spawn failed"));

      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("could not be loaded");
    });

    it("records successful proxied calls into the pack detector", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      await priv.handleToolCall("gh_create_issue", {});
      const history = priv.packDetector.getHistory();
      expect(history.length).toBe(1);
      expect(history[0].namespace).toBe("gh");
      expect(history[0].toolName).toBe("create_issue");
    });

    it("does not record errored proxied calls into the pack detector", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.client.callTool = vi.fn().mockRejectedValue(new Error("upstream failed"));
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      await priv.handleToolCall("gh_create_issue", {});
      expect(priv.packDetector.getHistory().length).toBe(0);
    });

    it("does not record meta-tool calls into the pack detector", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([]);
      await priv.handleToolCall("mcp_connect_discover", {});
      await priv.handleToolCall("mcp_connect_health", {});
      expect(priv.packDetector.getHistory().length).toBe(0);
    });

    it("routes meta-tool suggest and returns friendly message with no patterns", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleToolCall("mcp_connect_suggest", {});
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("No recurring multi-server patterns yet");
    });

    it("routes meta-tool suggest and lists detected packs ranked by frequency", async () => {
      const priv = getPrivate(server);
      const t0 = 1_000_000;
      // Seed two bursts that each contain {gh, linear}
      priv.packDetector.recordCall("gh", "a", t0);
      priv.packDetector.recordCall("linear", "b", t0 + 1_000);
      priv.packDetector.recordCall("gh", "c", t0 + 5 * 60_000);
      priv.packDetector.recordCall("linear", "d", t0 + 5 * 60_000 + 1_000);

      const result = await priv.handleToolCall("mcp_connect_suggest", {});
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain("Detected 1 recurring server pack");
      expect(text).toContain("gh");
      expect(text).toContain("linear");
      expect(text).toContain("seen 2 times");
      // Must nudge toward `activate` (the loading meta-tool) and embed
      // the concrete namespaces from the top pack so the caller can run
      // it verbatim. `dispatch` is for invoking tools on already-active
      // servers — suggesting it here mis-directs the model.
      expect(text).toContain("mcp_connect_activate");
      expect(text).not.toContain("mcp_connect_dispatch");
      expect(text).toMatch(/namespaces=\[.*"gh".*"linear".*\]|namespaces=\[.*"linear".*"gh".*\]/);
    });

    it("routes meta-tool bundles and separates ready vs partial against installed servers", async () => {
      const priv = getPrivate(server);
      // Install github + linear + slack. pr-review (github+linear) must
      // surface as ready; devops-incident (github+pagerduty+slack) must
      // surface as partial with pagerduty missing.
      priv.config = makeConfig([
        makeServerConfig({ namespace: "github" }),
        makeServerConfig({ namespace: "linear" }),
        makeServerConfig({ namespace: "slack" }),
      ]);
      const result = await priv.handleToolCall("mcp_connect_bundles", { action: "match" });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain("Bundles ready to activate now:");
      expect(text).toContain("pr-review");
      expect(text).toContain('activate: mcp_connect_activate({ namespaces: ["github","linear"] })');
      expect(text).toContain("Bundles partially installed:");
      expect(text).toContain("devops-incident");
      expect(text).toContain("missing: pagerduty");
      expect(text).toContain("https://mcp.hosting/explore");
    });

    it("routes meta-tool exec through a two-step pipeline with $ref binding", async () => {
      // Exec threads the first tool's output into the second tool's
      // args via {"$ref": "first.content[0].text"}. Proves the server
      // wires the exec-engine resolver to the real dispatch path.
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["list_prs", "get_pr"]);
      const callTool = vi
        .fn()
        .mockResolvedValueOnce({ content: [{ type: "text", text: "42" }] })
        .mockResolvedValueOnce({ content: [{ type: "text", text: "PR #42 body" }] });
      conn.client.callTool = callTool;
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [
          { id: "first", tool: "gh_list_prs", args: {} },
          {
            id: "second",
            tool: "gh_get_pr",
            args: { number: { $ref: "first.content[0].text" } },
          },
        ],
        return: "second",
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      expect(parsed.result.content[0].text).toBe("PR #42 body");
      // Both steps should have landed in the output map.
      expect(Object.keys(parsed.steps).sort()).toEqual(["first", "second"]);
      // The second upstream call must have received the resolved value,
      // not the raw $ref marker — otherwise the resolver never fired.
      expect(callTool).toHaveBeenNthCalledWith(2, {
        name: "get_pr",
        arguments: { number: "42" },
      });
    });

    it("fails the whole pipeline and surfaces partial outputs when a step errors", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["list_prs", "get_pr"]);
      conn.client.callTool = vi
        .fn()
        .mockResolvedValueOnce({ content: [{ type: "text", text: "ok step 1" }] })
        .mockRejectedValueOnce(new Error("upstream boom"));
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [
          { id: "first", tool: "gh_list_prs", args: {} },
          { id: "second", tool: "gh_get_pr", args: {} },
        ],
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(false);
      expect(parsed.failedStep).toBe("second");
      expect(parsed.error).toContain("upstream boom");
      // The first step ran and its output survives in `partial` so the
      // caller knows how far the pipeline got before the failure.
      expect(parsed.partial.first.content[0].text).toBe("ok step 1");
      expect(parsed.partial.second).toBeUndefined();
    });

    it("enforces the MAX_EXEC_STEPS cap", async () => {
      const priv = getPrivate(server);
      // 17 steps — one over the cap of 16. Must reject before any call.
      const steps = Array.from({ length: 17 }, (_, i) => ({
        id: `s${i}`,
        tool: "gh_list_prs",
        args: {},
      }));
      const result = await priv.handleToolCall("mcp_connect_exec", { steps });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("too many steps");
    });
  });

  describe("MCPH_POLL_INTERVAL env var", () => {
    // vi.unstubAllEnvs() restores every stubbed env var after each case so
    // test order can't leak into unrelated suites.
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("defaults to a ~60s poll when the env var is unset", () => {
      vi.stubEnv("MCPH_POLL_INTERVAL", "");
      const priv = getPrivate(server);
      priv.startPolling();
      expect(priv.pollTimer).not.toBeNull();
      clearTimeout(priv.pollTimer);
      priv.pollTimer = null;
    });

    it("respects a custom interval when MCPH_POLL_INTERVAL is set to a positive integer", () => {
      vi.stubEnv("MCPH_POLL_INTERVAL", "300");
      const priv = getPrivate(server);
      priv.startPolling();
      expect(priv.pollTimer).not.toBeNull();
      clearTimeout(priv.pollTimer);
      priv.pollTimer = null;
    });

    it("disables polling entirely when MCPH_POLL_INTERVAL=0", () => {
      vi.stubEnv("MCPH_POLL_INTERVAL", "0");
      const priv = getPrivate(server);
      priv.pollTimer = null;
      priv.startPolling();
      expect(priv.pollTimer).toBeNull();
    });

    it("falls back to the default when the env var is garbage", () => {
      vi.stubEnv("MCPH_POLL_INTERVAL", "not-a-number");
      const priv = getPrivate(server);
      priv.startPolling();
      expect(priv.pollTimer).not.toBeNull();
      clearTimeout(priv.pollTimer);
      priv.pollTimer = null;
    });

    it("falls back to the default when the env var is negative", () => {
      vi.stubEnv("MCPH_POLL_INTERVAL", "-30");
      const priv = getPrivate(server);
      priv.startPolling();
      expect(priv.pollTimer).not.toBeNull();
      clearTimeout(priv.pollTimer);
      priv.pollTimer = null;
    });
  });

  describe("shutdown", () => {
    it("clears poll timer", async () => {
      const priv = getPrivate(server);
      priv.pollTimer = setTimeout(() => {}, 60000);

      await server.shutdown();
      expect(priv.pollTimer).toBeNull();
    });

    it("disconnects all upstream connections", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("slack", makeConnection("slack"));

      await server.shutdown();
      expect(disconnectFromUpstream).toHaveBeenCalledTimes(2);
      expect(priv.connections.size).toBe(0);
    });
  });
});

describe("argsEqual (via reconcileConfig)", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://mcp.hosting", "test-token");
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("treats identical args as unchanged", async () => {
    const priv = getPrivate(server);
    const conn = makeConnection("gh");
    conn.config = makeServerConfig({ namespace: "gh", args: ["--verbose", "--flag"] });
    priv.connections.set("gh", conn);

    await priv.reconcileConfig(makeConfig([makeServerConfig({ namespace: "gh", args: ["--verbose", "--flag"] })]));
    expect(priv.connections.has("gh")).toBe(true);
  });

  it("treats different arg order as changed", async () => {
    const priv = getPrivate(server);
    const conn = makeConnection("gh");
    conn.config = makeServerConfig({ namespace: "gh", args: ["--flag", "--verbose"] });
    priv.connections.set("gh", conn);

    await priv.reconcileConfig(makeConfig([makeServerConfig({ namespace: "gh", args: ["--verbose", "--flag"] })]));
    expect(priv.connections.has("gh")).toBe(false);
  });

  it("treats undefined vs empty array as changed", async () => {
    const priv = getPrivate(server);
    const conn = makeConnection("gh");
    conn.config = makeServerConfig({ namespace: "gh", args: undefined });
    priv.connections.set("gh", conn);

    await priv.reconcileConfig(makeConfig([makeServerConfig({ namespace: "gh", args: [] })]));
    expect(priv.connections.has("gh")).toBe(false);
  });

  it("treats both undefined as unchanged", async () => {
    const priv = getPrivate(server);
    const conn = makeConnection("gh");
    conn.config = makeServerConfig({ namespace: "gh", args: undefined });
    priv.connections.set("gh", conn);

    await priv.reconcileConfig(makeConfig([makeServerConfig({ namespace: "gh", args: undefined })]));
    expect(priv.connections.has("gh")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Concurrency and atomicity regression tests. These cover the three
// races exposed by the review:
//   1. activateOne — two concurrent callers for the same namespace must
//      share one spawn, not race to double-spawn.
//   2. fetchAndApplyConfig — this.config must be set before reconcile's
//      awaits so readers don't observe the stale config mid-reconcile.
//   3. handleToolCall — the routes map captured at method entry must be
//      used for the actual call, even if rebuildRoutes fires during
//      the auto-reconnect awaits.
// ─────────────────────────────────────────────────────────────────────────
describe("activateOne dedup", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://mcp.hosting", "test-token");
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("dedupes two concurrent activations of the same namespace to one spawn", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);

    // Hold the connectToUpstream promise open so both activateOne
    // callers can enqueue before the first resolves.
    let resolveConnect: (conn: UpstreamConnection) => void = () => {};
    const connectPromise = new Promise<UpstreamConnection>((r) => {
      resolveConnect = r;
    });
    vi.mocked(connectToUpstream).mockReturnValueOnce(connectPromise);

    const p1 = priv.activateOne("gh");
    const p2 = priv.activateOne("gh");

    // Both should be awaiting the same in-flight promise at this point.
    expect(priv.activationInflight.has("gh")).toBe(true);

    resolveConnect(makeConnection("gh", ["create_issue"]));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Critical: only ONE spawn happened despite two parallel activations.
    expect(connectToUpstream).toHaveBeenCalledTimes(1);
    // Map entry cleared after settle.
    expect(priv.activationInflight.has("gh")).toBe(false);
  });

  it("clears the inflight entry after failure so a later call can retry", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);

    vi.mocked(connectToUpstream).mockRejectedValue(new Error("down"));

    const r1 = await priv.activateOne("gh");
    expect(r1.ok).toBe(false);
    expect(priv.activationInflight.has("gh")).toBe(false);

    // Second call should retry, not return the failed promise from #1.
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["x"]));
    const r2 = await priv.activateOne("gh");
    expect(r2.ok).toBe(true);
  });
});

describe("fetchAndApplyConfig atomicity", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://mcp.hosting", "test-token");
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("updates this.config and configVersion before reconcileConfig's awaits", async () => {
    const priv = getPrivate(server);
    // Seed the "old" config: one active upstream gh.
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    priv.configVersion = "old-v";
    priv.connections.set("gh", makeConnection("gh"));

    // The new config removes gh. reconcileConfig will disconnect it
    // and await the disconnect. That await is our observation point:
    // by then, this.config should already be the NEW config.
    vi.mocked(fetchConfig).mockResolvedValueOnce({ servers: [], configVersion: "new-v" } as any);

    let seenVersion: string | null = null;
    let seenServerCount: number | null = null;
    vi.mocked(disconnectFromUpstream).mockImplementationOnce(async () => {
      seenVersion = priv.configVersion;
      seenServerCount = priv.config.servers.length;
    });

    await priv.fetchAndApplyConfig();

    // If the old code ordering were still in place, these would see
    // the stale config (configVersion "old-v", 1 server).
    expect(seenVersion).toBe("new-v");
    expect(seenServerCount).toBe(0);
  });

  it("prunes expired activationFailures before fetching new config", async () => {
    const priv = getPrivate(server);
    const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
    priv.activationFailures.set("old", { at: sixMinutesAgo, message: "stale" });
    priv.activationFailures.set("recent", { at: Date.now(), message: "fresh" });

    // 304 shortcut — we only care that the prune sweep ran at the top.
    vi.mocked(fetchConfig).mockResolvedValueOnce(null as any);

    await priv.fetchAndApplyConfig();

    expect(priv.activationFailures.has("old")).toBe(false);
    expect(priv.activationFailures.has("recent")).toBe(true);
  });
});

describe("handleToolCall route snapshot", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://mcp.hosting", "test-token");
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("uses the route snapshot even if toolRoutes is swapped mid-call", async () => {
    const priv = getPrivate(server);
    const errorConn = makeConnection("gh", ["create_issue"], "error");
    priv.connections.set("gh", errorConn);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    priv.rebuildRoutes();

    const freshConn = makeConnection("gh", ["create_issue"]);
    freshConn.client.callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok after reconnect" }],
    });

    // Simulate an unrelated rebuild swapping this.toolRoutes during
    // the reconnect await. With the old code, the subsequent
    // routeToolCall would run against the empty Map and return an
    // "Unknown tool" error. With the snapshot, it still resolves.
    vi.mocked(connectToUpstream).mockImplementationOnce(async () => {
      priv.toolRoutes = new Map();
      return freshConn;
    });

    const result = await priv.handleToolCall("gh_create_issue", {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("ok after reconnect");
  });
});

describe("guide resource + session tracking", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://mcp.hosting", "test-token");
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("lists no builtins when no guide is loaded", () => {
    const priv = getPrivate(server);
    priv.guides = { user: null, project: null };
    expect(priv.getBuiltinResources()).toEqual([]);
  });

  it("surfaces mcph://guide when either guide is present", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.mcph/MCPH.md", content: "u" },
      project: null,
    };
    const builtins = priv.getBuiltinResources();
    expect(builtins.length).toBe(1);
    expect(builtins[0].uri).toBe("mcph://guide");
    expect(builtins[0].mimeType).toBe("text/markdown");
    expect(builtins[0].name).toBe("mcph guide");
  });

  it("builtin read() returns the rendered body and flips guideRead", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.mcph/MCPH.md", content: "u-body" },
      project: { scope: "project", path: "/p/.mcph/MCPH.md", content: "p-body" },
    };
    expect(priv.guideRead).toBe(false);
    const builtin = priv.getBuiltinResources()[0];
    const result = builtin.read();
    expect(priv.guideRead).toBe(true);
    const text = result.contents[0].text;
    expect(text).toContain("u-body");
    expect(text).toContain("p-body");
    // Project goes last so its guidance has the final word (see renderGuide).
    expect(text.indexOf("p-body")).toBeGreaterThan(text.indexOf("u-body"));
  });

  it("builtin map exposes the same guide entry by URI", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.mcph/MCPH.md", content: "u" },
      project: null,
    };
    const map = priv.getBuiltinResourceMap();
    expect(map.size).toBe(1);
    expect(map.get("mcph://guide")?.uri).toBe("mcph://guide");
  });

  it("attaches a one-shot guide nudge to meta-tool responses when guide is loaded but unread", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.mcph/MCPH.md", content: "u" },
      project: null,
    };
    const res1 = priv.attachGuideNudge({ content: [{ type: "text", text: "discover-body" }] });
    expect(res1.content[0].text).toContain("discover-body");
    expect(res1.content[0].text).toContain("mcph://guide");
    expect(res1.content[0].text).toContain("/h/.mcph/MCPH.md");
    // One-shot: a second call does NOT add the nudge again.
    const res2 = priv.attachGuideNudge({ content: [{ type: "text", text: "second-body" }] });
    expect(res2.content[0].text).toBe("second-body");
  });

  it("does NOT nudge when no guide is loaded", () => {
    const priv = getPrivate(server);
    priv.guides = { user: null, project: null };
    const res = priv.attachGuideNudge({ content: [{ type: "text", text: "plain" }] });
    expect(res.content[0].text).toBe("plain");
  });

  it("does NOT nudge once the guide has been read", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.mcph/MCPH.md", content: "u" },
      project: null,
    };
    priv.guideRead = true;
    const res = priv.attachGuideNudge({ content: [{ type: "text", text: "body" }] });
    expect(res.content[0].text).toBe("body");
  });

  it("reading the guide via the builtin flips guideRead and suppresses the nudge", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.mcph/MCPH.md", content: "u" },
      project: null,
    };
    expect(priv.guideRead).toBe(false);
    priv.getBuiltinResources()[0].read();
    expect(priv.guideRead).toBe(true);
    const res = priv.attachGuideNudge({ content: [{ type: "text", text: "body" }] });
    // guideRead gates the nudge, so even with a guide loaded we shouldn't nudge.
    expect(res.content[0].text).toBe("body");
  });
});

describe("handleImport path validation", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://mcp.hosting", "test-token");
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("rejects a resolved path whose basename is not an allowed MCP config filename", async () => {
    const priv = getPrivate(server);
    // Traversal that normalizes to a resolved basename of "passwd" —
    // must be rejected even though the raw string has "mcp.json" in it.
    const result = await priv.handleImport("mcp.json/../etc/passwd");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Only MCP config files are allowed");
  });

  it("still accepts a real allowed basename", async () => {
    const priv = getPrivate(server);
    // This path points to a file that doesn't exist; we just want to
    // confirm the basename check doesn't reject it before readFile runs.
    const result = await priv.handleImport("./nonexistent/mcp.json");
    // Either readFile errors or mcpServers-shape check errors — but
    // NOT the allowed-filename check.
    expect(result.content[0].text).not.toContain("Only MCP config files are allowed");
  });

  it("rejects a resolved path outside both homedir and cwd (existence-oracle probe)", async () => {
    const priv = getPrivate(server);
    // An absolute path with an allowed basename but sitting outside
    // the user's home and cwd — canonical example is `/var/log/...`
    // on posix. On Windows, resolve() forces drive-absolute, so any
    // drive root that isn't the user's profile or project works too.
    const probePath =
      process.platform === "win32"
        ? "D:\\weirdplace\\claude_desktop_config.json"
        : "/var/log/claude_desktop_config.json";
    const result = await priv.handleImport(probePath);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/home directory or the current working directory/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// handleInstall integration tests. Mocks the undici `request` call that
// talks to /api/connect/servers so we can exercise each status-code
// branch without a live backend. Also covers the network-error mapping
// (H2) — raw error codes from undici must not leak to the model.
// ─────────────────────────────────────────────────────────────────────────
describe("handleInstall", () => {
  let server: ConnectServer;

  const validArgs = {
    name: "GitHub",
    namespace: "gh",
    type: "local" as const,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
  };

  function mockInstallResponse(statusCode: number, bodyJson: unknown = {}) {
    vi.mocked(request).mockResolvedValueOnce({
      statusCode,
      body: {
        text: vi.fn().mockResolvedValue(""),
        json: vi.fn().mockResolvedValue(bodyJson),
      },
    } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://mcp.hosting", "test-token");
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("returns the activate-call hint on 201 happy path", async () => {
    mockInstallResponse(201, { id: "srv-1", namespace: "gh" });
    const priv = getPrivate(server);
    const result = await priv.handleInstall(validArgs);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain('Installed "GitHub"');
    expect(text).toContain('mcp_connect_activate({ server: "gh" })');
    expect(text).toContain("into this session");
  });

  it("omits 'into this session' for remote installs", async () => {
    mockInstallResponse(201, { id: "srv-2", namespace: "notion" });
    const priv = getPrivate(server);
    const result = await priv.handleInstall({
      name: "Notion",
      namespace: "notion",
      type: "remote",
      url: "https://mcp.notion.com/mcp",
    });
    expect(result.content[0].text).toContain('mcp_connect_activate({ server: "notion" })');
    expect(result.content[0].text).not.toContain("into this session");
  });

  it("forwards the plan_limit_exceeded JSON body verbatim on 403", async () => {
    const errorBody = {
      code: "plan_limit_exceeded",
      error: "You've reached the 3-server limit on the free plan.",
      upgradeUrl: "https://mcp.hosting/dashboard/billing",
    };
    mockInstallResponse(403, errorBody);
    const priv = getPrivate(server);
    const result = await priv.handleInstall(validArgs);
    expect(result.isError).toBe(true);
    // The full JSON body must be in the text so the model can show
    // the upgrade URL; this is the load-bearing bit of the contract.
    expect(result.content[0].text).toContain("plan_limit_exceeded");
    expect(result.content[0].text).toContain("https://mcp.hosting/dashboard/billing");
  });

  it("returns a namespace-collision message on 409", async () => {
    mockInstallResponse(409, { error: "namespace already in use" });
    const priv = getPrivate(server);
    const result = await priv.handleInstall(validArgs);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Namespace "gh" is already installed');
    expect(result.content[0].text).toContain("mcp_connect_activate");
  });

  it("returns the backend's error field on generic 4xx", async () => {
    mockInstallResponse(400, { error: "namespace must match regex" });
    const priv = getPrivate(server);
    const result = await priv.handleInstall(validArgs);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Install failed");
    expect(result.content[0].text).toContain("namespace must match regex");
  });

  it("falls back to HTTP status when the error body is empty", async () => {
    mockInstallResponse(502, {});
    const priv = getPrivate(server);
    const result = await priv.handleInstall(validArgs);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("HTTP 502");
  });

  it("maps undici timeout codes to a friendly timeout message", async () => {
    const err: Error & { code?: string } = new Error("Headers timeout fired");
    err.code = "UND_ERR_HEADERS_TIMEOUT";
    vi.mocked(request).mockRejectedValueOnce(err);
    const priv = getPrivate(server);
    const result = await priv.handleInstall(validArgs);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("timed out");
    // Raw error internals must not leak.
    expect(result.content[0].text).not.toContain("UND_ERR_HEADERS_TIMEOUT");
    expect(result.content[0].text).not.toContain("Headers timeout fired");
  });

  it("maps ECONNREFUSED to a network-unreachable message", async () => {
    const err: Error & { code?: string } = new Error("connect ECONNREFUSED 127.0.0.1:443");
    err.code = "ECONNREFUSED";
    vi.mocked(request).mockRejectedValueOnce(err);
    const priv = getPrivate(server);
    const result = await priv.handleInstall(validArgs);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("network unreachable or DNS failure");
    expect(result.content[0].text).not.toContain("127.0.0.1");
  });

  it("unwraps err.cause.code when the top-level error has no code", async () => {
    const err = new Error("fetch failed", { cause: { code: "ENOTFOUND" } });
    vi.mocked(request).mockRejectedValueOnce(err);
    const priv = getPrivate(server);
    const result = await priv.handleInstall(validArgs);
    expect(result.content[0].text).toContain("network unreachable or DNS failure");
  });

  it("falls back to a generic message for unrecognized errors", async () => {
    vi.mocked(request).mockRejectedValueOnce(new Error("something weird happened"));
    const priv = getPrivate(server);
    const result = await priv.handleInstall(validArgs);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Install failed unexpectedly");
    // The raw error string must not appear in user-facing text.
    expect(result.content[0].text).not.toContain("something weird happened");
  });

  it("returns the validation error text without hitting the network on bad input", async () => {
    const priv = getPrivate(server);
    const result = await priv.handleInstall({ name: "X", type: "local" }); // missing namespace
    expect(result.isError).toBe(true);
    // No network call should have been made.
    expect(vi.mocked(request)).not.toHaveBeenCalled();
  });

  it("warns but still returns success when config refresh times out", async () => {
    mockInstallResponse(201, { id: "srv-3", namespace: "gh" });
    // Make fetchConfig hang so the 3s refresh race loses.
    vi.mocked(fetchConfig).mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ servers: [], configVersion: "v2" }), 10_000)),
    );
    const priv = getPrivate(server);
    const result = await priv.handleInstall(validArgs);
    expect(result.isError).toBeFalsy();
    // Hint must tell the model to wait ~60s before calling activate.
    expect(result.content[0].text).toContain("within ~60s");
    expect(result.content[0].text).toContain('mcp_connect_activate({ server: "gh" })');
  }, 10_000);
});

describe("prewarmDormantServers", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://mcp.hosting", "test-token");
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("activates dormant servers, persists toolCache, and disconnects", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub" }),
        makeServerConfig({ id: "slack-id", namespace: "slack", name: "Slack" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]),
    );

    await priv.prewarmDormantServers();

    // Both servers were connected once and disconnected once.
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(disconnectFromUpstream)).toHaveBeenCalledTimes(2);
    // No live connections held after prewarm.
    expect(priv.connections.size).toBe(0);
    // toolCache populated for both so getDeferredServers() can surface them.
    expect(priv.toolCache.get("gh")).toEqual([{ name: "gh_tool", description: undefined }]);
    expect(priv.toolCache.get("slack")).toEqual([{ name: "slack_tool", description: undefined }]);
  });

  it("skips servers that already have a persisted toolCache", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({
          id: "gh-id",
          namespace: "gh",
          name: "GitHub",
          toolCache: [{ name: "list_issues", description: "List issues" }],
        }),
        makeServerConfig({ id: "slack-id", namespace: "slack", name: "Slack" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]),
    );

    await priv.prewarmDormantServers();

    // Only slack (no toolCache) got activated; gh was skipped.
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("slack");
  });

  it("is a no-op when every server already has a toolCache", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({
          id: "gh-id",
          namespace: "gh",
          name: "GitHub",
          toolCache: [{ name: "list_issues" }],
        }),
      ],
    };

    await priv.prewarmDormantServers();

    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(vi.mocked(disconnectFromUpstream)).not.toHaveBeenCalled();
  });

  it("survives individual activation failures without aborting the batch", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "broken-id", namespace: "broken", name: "Broken" }),
        makeServerConfig({ id: "ok-id", namespace: "ok", name: "Ok" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) => {
      if (cfg.namespace === "broken") throw new Error("spawn ENOENT");
      return makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]);
    });

    await priv.prewarmDormantServers();

    // "ok" still populated its cache even though "broken" threw.
    expect(priv.toolCache.get("ok")).toEqual([{ name: "ok_tool", description: undefined }]);
    expect(priv.toolCache.get("broken")).toBeUndefined();
    expect(priv.connections.size).toBe(0);
  });
});

describe("auto-load on startup", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://mcp.hosting", "test-token");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.shutdown();
  });

  it("is disabled by default when MCPH_AUTO_LOAD is unset", () => {
    vi.stubEnv("MCPH_AUTO_LOAD", "");
    expect(isAutoLoadEnabled()).toBe(false);
  });

  it("accepts '1' and 'true' but not other values", () => {
    vi.stubEnv("MCPH_AUTO_LOAD", "1");
    expect(isAutoLoadEnabled()).toBe(true);
    vi.stubEnv("MCPH_AUTO_LOAD", "true");
    expect(isAutoLoadEnabled()).toBe(true);
    vi.stubEnv("MCPH_AUTO_LOAD", "TRUE");
    expect(isAutoLoadEnabled()).toBe(true);
    vi.stubEnv("MCPH_AUTO_LOAD", "0");
    expect(isAutoLoadEnabled()).toBe(false);
    vi.stubEnv("MCPH_AUTO_LOAD", "yes");
    expect(isAutoLoadEnabled()).toBe(false);
  });

  it("activates every namespace in the top recurring pack when all are installed", async () => {
    vi.stubEnv("MCPH_AUTO_LOAD", "1");
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub" }),
        makeServerConfig({ id: "linear-id", namespace: "linear", name: "Linear" }),
      ],
    };
    // Three bursts of (gh, linear) → one detected pack at frequency 3.
    const t0 = 1_000_000;
    priv.packDetector.recordCall("gh", "create_issue", t0);
    priv.packDetector.recordCall("linear", "list_issues", t0 + 1000);
    priv.packDetector.recordCall("gh", "create_issue", t0 + 300_000);
    priv.packDetector.recordCall("linear", "list_issues", t0 + 301_000);
    priv.packDetector.recordCall("gh", "create_issue", t0 + 600_000);
    priv.packDetector.recordCall("linear", "list_issues", t0 + 601_000);

    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]),
    );

    await priv.autoLoadRecurringPack();

    // Both namespaces got activated sequentially.
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(2);
    const activatedNs = vi.mocked(connectToUpstream).mock.calls.map((c) => (c[0] as UpstreamServerConfig).namespace);
    expect(activatedNs).toContain("gh");
    expect(activatedNs).toContain("linear");
    expect(priv.connections.get("gh")?.status).toBe("connected");
    expect(priv.connections.get("linear")?.status).toBe("connected");
  });

  it("does not activate anything when some pack namespaces aren't installed", async () => {
    vi.stubEnv("MCPH_AUTO_LOAD", "1");
    const priv = getPrivate(server);
    // Only `gh` is installed — the {gh, slack} pack can't be activated
    // as a whole, so we must skip it entirely. Activating just `gh`
    // would be a partial load that the caller didn't ask for.
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub" })],
    };
    const t0 = 1_000_000;
    priv.packDetector.recordCall("gh", "create_issue", t0);
    priv.packDetector.recordCall("slack", "post_message", t0 + 1000);
    priv.packDetector.recordCall("gh", "create_issue", t0 + 300_000);
    priv.packDetector.recordCall("slack", "post_message", t0 + 301_000);

    await priv.autoLoadRecurringPack();

    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(priv.connections.size).toBe(0);
  });

  it("is a silent no-op when pack history is empty", async () => {
    vi.stubEnv("MCPH_AUTO_LOAD", "1");
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub" })],
    };

    await priv.autoLoadRecurringPack();

    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });
});
