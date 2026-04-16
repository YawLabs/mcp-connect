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

vi.mock("../analytics.js", () => ({
  initAnalytics: vi.fn(),
  recordConnectEvent: vi.fn(),
  shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
}));

import { ConnectServer } from "../server.js";
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
      expect(result.content[0].text).toContain("No servers configured");
    });

    it("returns empty message when no servers", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([]);
      const result = priv.handleDiscover();
      expect(result.content[0].text).toContain("No servers configured");
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
      expect(text).toContain("gh — GitHub [ACTIVE (2 tools)]");
      expect(text).toContain("slack — Slack [available]");
      expect(text).toContain("1 active, 2 tools loaded");
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
      expect(result.content[0].text).toContain("already active");
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
      expect(result.content[0].text).toContain('Activated "gh"');
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
      expect(result.content[0].text).toContain('Activated "gh"');
      expect(connectToUpstream).toHaveBeenCalledTimes(2);
    });

    it("reports failure after both attempts fail", async () => {
      const priv = getPrivate(server);
      const config = makeServerConfig({ namespace: "gh" });
      priv.config = makeConfig([config]);

      vi.mocked(connectToUpstream).mockRejectedValue(new Error("timeout"));

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to activate "gh": timeout');
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

  describe("handleDeactivate", () => {
    it("returns error when no namespaces provided", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleDeactivate([]);
      expect(result.isError).toBe(true);
    });

    it("reports when server is not active", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleDeactivate(["unknown"]);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not active");
    });

    it("deactivates an active server", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      priv.connections.set("gh", conn);
      priv.idleCallCounts.set("gh", 5);

      const result = await priv.handleDeactivate(["gh"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Deactivated "gh"');
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
      expect(result.content[0].text).toContain("No active connections");
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

  describe("handleToolCall", () => {
    it("routes meta-tool discover", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([]);
      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).toContain("No servers configured");
    });

    it("routes meta-tool health", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleToolCall("mcp_connect_health", {});
      expect(result.content[0].text).toContain("No active connections");
    });

    it("routes meta-tool activate", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(conn);

      const result = await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
      expect(result.content[0].text).toContain('Activated "gh"');
    });

    it("routes meta-tool deactivate", async () => {
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      const result = await priv.handleToolCall("mcp_connect_deactivate", { server: "gh" });
      expect(result.content[0].text).toContain('Deactivated "gh"');
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
