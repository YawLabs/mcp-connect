import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// Dispatch + auto-warm discover coverage
//
// Exercises the new BM25-ranked routing surface:
//   mcp_connect_dispatch(intent, budget) — rank + activate top-N
//   mcp_connect_discover(context)        — auto-warm a decisive winner
//
// Also pins tool-report integration (success path calls reportTools).
// ═══════════════════════════════════════════════════════════════════════

vi.mock("undici", () => ({
  request: vi.fn().mockResolvedValue({
    statusCode: 200,
    body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
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

vi.mock("../tool-report.js", () => ({
  initToolReport: vi.fn(),
  reportTools: vi.fn().mockResolvedValue(undefined),
}));

import { ConnectServer } from "../server.js";
import { reportTools } from "../tool-report.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { ActivationError, connectToUpstream } from "../upstream.js";

function makeServerConfig(overrides: Partial<UpstreamServerConfig> = {}): UpstreamServerConfig {
  return {
    id: "srv-id",
    name: "Test",
    namespace: "test",
    type: "local",
    command: "echo",
    isActive: true,
    ...overrides,
  };
}

function makeConnection(
  namespace: string,
  tools: Array<{ name: string; description?: string }> = [],
  status: "connected" | "error" = "connected",
): UpstreamConnection {
  return {
    config: makeServerConfig({ namespace, name: namespace }),
    client: { callTool: vi.fn(), close: vi.fn() } as any,
    transport: {} as any,
    tools: tools.map((t) => ({
      name: t.name,
      namespacedName: `${namespace}_${t.name}`,
      description: t.description,
      inputSchema: { type: "object" },
    })),
    resources: [],
    prompts: [],
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0 },
    status,
  } as UpstreamConnection;
}

function getPrivate(server: ConnectServer) {
  return server as any;
}

describe("handleDispatch", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://mcp.hosting", "test-token");
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("rejects empty intent", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub", description: "Repos and issues" })],
    };
    const result = await priv.handleDispatch("", 1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("intent is required");
  });

  it("errors when no servers are configured", async () => {
    const priv = getPrivate(server);
    priv.config = { configVersion: "v1", servers: [] };
    const result = await priv.handleDispatch("do something", 1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No servers configured");
  });

  it("errors when no configured server matches the intent", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub", description: "Repos and issues" })],
    };
    const result = await priv.handleDispatch("xylophone orchestration", 1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No configured server matches/);
  });

  it("activates only the top 1 by default", async () => {
    const priv = getPrivate(server);
    const ghConfig = makeServerConfig({
      id: "gh-id",
      namespace: "gh",
      name: "GitHub",
      description: "Repos, issues, and pull requests",
    });
    const slackConfig = makeServerConfig({
      id: "slack-id",
      namespace: "slack",
      name: "Slack",
      description: "Team chat and direct messages",
    });
    priv.config = { configVersion: "v1", servers: [ghConfig, slackConfig] };

    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "create_issue", description: "Create an issue" }]),
    );

    const result = await priv.handleDispatch("create a github issue", 1);
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("gh");
    expect(result.content[0].text).toContain('Activated "gh"');
  });

  it("respects a budget larger than 1", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "a", namespace: "gh", name: "GitHub", description: "Issues and pull requests" }),
        makeServerConfig({ id: "b", namespace: "slack", name: "Slack", description: "Issues and messages from team" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "tool_one", description: "Example" }]),
    );
    const result = await priv.handleDispatch("issues", 2);
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(2);
  });

  it("clamps an absurd budget request to 10", async () => {
    const priv = getPrivate(server);
    // Build a corpus where many servers share a term so rank returns many
    const servers = Array.from({ length: 15 }, (_, i) =>
      makeServerConfig({
        id: `id-${i}`,
        namespace: `ns${i}`,
        name: `Server${i}`,
        description: "common-term shared across all",
      }),
    );
    priv.config = { configVersion: "v1", servers };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, []),
    );
    const result = await priv.handleDispatch("common-term", 999);
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(connectToUpstream).mock.calls.length).toBeLessThanOrEqual(10);
  });

  it("surfaces the ActivationError message when a server fails to connect", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({
          id: "gh-id",
          namespace: "gh",
          name: "GitHub",
          description: "Repos and issues",
        }),
      ],
    };
    vi.mocked(connectToUpstream).mockRejectedValue(
      new ActivationError(
        'Server "gh" failed to start. stderr: Error: GITHUB_TOKEN is required',
        "install_failure",
        "Error: GITHUB_TOKEN is required",
      ),
    );
    const result = await priv.handleDispatch("github issue", 1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("GITHUB_TOKEN is required");
  });

  it("fires reportTools after a successful activation", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({
          id: "gh-id",
          namespace: "gh",
          name: "GitHub",
          description: "Repos and issues",
        }),
      ],
    };
    vi.mocked(connectToUpstream).mockResolvedValue(
      makeConnection("gh", [{ name: "create_issue", description: "Create" }]),
    );
    await priv.handleDispatch("github issues", 1);
    // Fire-and-forget — awaiting the microtask queue is enough
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(reportTools)).toHaveBeenCalledWith("gh-id", [{ name: "create_issue", description: "Create" }]);
  });

  it("does not reactivate a server that is already connected", async () => {
    const priv = getPrivate(server);
    const ghConfig = makeServerConfig({
      id: "gh-id",
      namespace: "gh",
      name: "GitHub",
      description: "Repos and issues",
    });
    priv.config = { configVersion: "v1", servers: [ghConfig] };
    priv.connections.set("gh", makeConnection("gh", [{ name: "create_issue" }]));

    const result = await priv.handleDispatch("github issue", 1);
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("already active");
  });
});

describe("handleDiscoverWithAutoWarm", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer("https://mcp.hosting", "test-token");
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("auto-activates the decisive winner when context is provided", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({
          id: "gh-id",
          namespace: "gh",
          name: "GitHub",
          description: "Repos, issues, and pull requests on GitHub",
        }),
        makeServerConfig({
          id: "fs-id",
          namespace: "fs",
          name: "Filesystem",
          description: "Read and write local files",
        }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "create_issue" }]),
    );

    const result = await priv.handleDiscoverWithAutoWarm("file a github issue");
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("gh");
    expect(result.content[0].text).toContain('Auto-activated "gh"');
  });

  it("does not auto-activate when no context is provided", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub", description: "Issues" })],
    };
    const result = await priv.handleDiscoverWithAutoWarm(undefined);
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(result.content[0].text).not.toContain("Auto-activated");
  });

  it("does not auto-activate on an ambiguous query (top score below threshold)", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ namespace: "gh", name: "GitHub", description: "Issues" }),
        makeServerConfig({ namespace: "slack", name: "Slack", description: "Messages" }),
      ],
    };
    // Query has no tokens that match anything — ranked[] empty → fallback
    const result = await priv.handleDiscoverWithAutoWarm("xyzzy");
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(result.content[0].text).not.toContain("Auto-activated");
  });

  it("does not auto-activate a server that is already connected", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({
          id: "gh-id",
          namespace: "gh",
          name: "GitHub",
          description: "Repos, issues, and pull requests on GitHub",
        }),
      ],
    };
    priv.connections.set("gh", makeConnection("gh", [{ name: "create_issue" }]));
    const result = await priv.handleDiscoverWithAutoWarm("file a github issue");
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    expect(result.content[0].text).not.toContain("Auto-activated");
  });
});

describe("ActivationError", () => {
  it("carries category and stderr tail", () => {
    const err = new ActivationError("boom", "install_failure", "Error: missing env");
    expect(err.category).toBe("install_failure");
    expect(err.stderrTail).toBe("Error: missing env");
    expect(err.message).toBe("boom");
    expect(err.name).toBe("ActivationError");
  });

  it("works without an optional stderr tail", () => {
    const err = new ActivationError("timeout", "init_timeout");
    expect(err.stderrTail).toBeUndefined();
    expect(err.category).toBe("init_timeout");
  });
});
