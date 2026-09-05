import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// mcp_connect_dispatch + auto-warm discover coverage — server.ts
//
// NOT the CLI dispatcher, despite the file name. This sits between
// cli-dispatch.test.ts and index-dispatch.test.ts, which both cover argv
// routing in src/index.ts; the shared "dispatch" across the three names is
// a collision, not a family. What this file exercises is the MCP TOOL
// `mcp_connect_dispatch` and its sibling `mcp_connect_discover` — two
// handlers on ConnectServer in server.ts. Nothing below touches argv,
// process.exit, a subcommand, or the built CLI.
//
// Exercises the BM25-ranked routing surface:
//   mcp_connect_dispatch(intent, budget) — rank + activate top-N
//   mcp_connect_discover(context)        — auto-warm a decisive winner
// ═══════════════════════════════════════════════════════════════════════

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn().mockResolvedValue(undefined),
  };
});

import { ConnectServer } from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { ActivationError, connectToUpstream, disconnectFromUpstream } from "../upstream.js";

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
    // reset, not clear. clearAllMocks wipes call records but LEAVES
    // implementations in place, so the mockRejectedValue set in "surfaces
    // the ActivationError message" survived into every later test that did
    // not overwrite connectToUpstream itself -- a latent order dependence
    // that only stays green because the tests after it happen to set their
    // own. Reset also drops the mockResolvedValue the vi.mock factory gave
    // disconnectFromUpstream, so re-arm it here: afterEach's
    // server.shutdown() awaits it.
    vi.resetAllMocks();
    vi.mocked(disconnectFromUpstream).mockResolvedValue(undefined);
    server = new ConnectServer();
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

  it("errors when no servers are configured, naming the local add path", async () => {
    const priv = getPrivate(server);
    priv.config = { configVersion: "v1", servers: [] };
    const result = await priv.handleDispatch("do something", 1);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("No servers installed");
    // dispatch is the documented FIRST call, so this is the fresh-install
    // path. The hosted add UI at yaw.sh/mcp it used to point at is gone
    // (control plane retired); the CLI that works and where its result
    // lands are the answer. Same text as discover's empty state, so the two
    // cannot drift apart again.
    expect(text).toContain("yaw-mcp add <slug>");
    expect(text).toContain("~/.yaw-mcp/bundles.json");
    expect(text).not.toContain("Add servers at yaw.sh/mcp");
    expect(text).toEqual(priv.handleDiscover().content[0].text);
  });

  it("errors when every installed server is disabled, naming the bundles.json toggle", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub", isActive: false })],
    };
    const result = await priv.handleDispatch("do something", 1);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("No servers enabled");
    // "Enable servers at yaw.sh/mcp" named a hosted toggle that no longer
    // exists; the fix is a local edit.
    expect(text).toContain('"isActive": true');
    expect(text).toContain("~/.yaw-mcp/bundles.json");
    expect(text).not.toContain("yaw.sh/mcp");
  });

  it("names the blocked namespace and the profile's allow list when the profile keeps every server out", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub" })],
    };
    priv.profile = { path: "/proj/.yaw-mcp/config.json", servers: ["linear"] };
    const result = await priv.handleDispatch("do something", 1);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("No servers enabled");
    expect(text).toContain("project profile at /proj/.yaw-mcp/config.json");
    expect(text).toContain('add "gh" to its "servers" allow list');
    // gh is already active. The old text sent the model to bundles.json to
    // flip a toggle that was already on, and to discover's disabled list,
    // where a profile-blocked server never appears.
    expect(text).not.toContain('"isActive": true');
    expect(text).not.toContain("installed but disabled");
    expect(text).not.toContain("yaw.sh/mcp");
  });

  it("points a block-listed namespace at the profile's blocked list, not its allow list", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub" })],
    };
    // An explicit "blocked" entry wins over the allow list (isAllowed), so
    // adding gh to "servers" would change nothing -- the edit is the removal.
    priv.profile = { path: "/proj/.yaw-mcp/config.json", blocked: ["gh"] };
    const result = await priv.handleDispatch("do something", 1);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("project profile at /proj/.yaw-mcp/config.json");
    expect(text).toContain('remove "gh" from its "blocked" list');
    expect(text).not.toContain("allow list");
    expect(text).not.toContain('"isActive": true');
  });

  it("names both fixes when one server is disabled and another is profile-blocked", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "slack", name: "Slack", isActive: false }),
      ],
    };
    priv.profile = { path: "/proj/.yaw-mcp/config.json", servers: ["linear"] };
    const result = await priv.handleDispatch("do something", 1);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('add "gh" to its "servers" allow list');
    expect(text).toContain('"isActive": true');
    expect(text).toContain("~/.yaw-mcp/bundles.json");
    // slack is disabled, not profile-blocked: the profile sentence must not
    // name it, or the model edits the profile for a server bundles.json is
    // keeping out.
    expect(text).not.toContain('"slack"');
  });

  it("errors when no installed server matches the intent, pointing at the catalog + CLI", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub", description: "Repos and issues" })],
    };
    const result = await priv.handleDispatch("xylophone orchestration", 1);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/No installed server matches/);
    // Same migration as the two empty states above: the browsable catalog
    // plus the CLI, not the retired hosted add flow.
    expect(text).toContain("https://yaw.sh/mcp/catalog/");
    expect(text).toContain("yaw-mcp add <slug>");
    expect(text).not.toContain("add a relevant server at yaw.sh/mcp");
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
    expect(result.content[0].text).toContain('Loaded "gh"');
  });

  it("a fractional budget resolves to ONE winner and still reaches the sampling-tiebreak gate", async () => {
    // The gate keys on the CLAMPED budget: 1.5 (or 0, or 0.5) yields
    // exactly one primary, so the single-winner tiebreak must fire for it.
    // The old `budget === 1` test on the RAW value silently skipped the
    // tiebreak that exists precisely for the single-primary case. Two
    // servers with identical matched terms tie the BM25 scores, so
    // shouldSample("auto") fires; the mock server has no sampling
    // capability, so bestOfNViaSampling returns null and the ranker order
    // stands -- the observable is the progress line emitted at the gate.
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "a", namespace: "alpha", name: "Alpha", description: "manage github issues" }),
        makeServerConfig({ id: "b", namespace: "beta", name: "Beta", description: "manage github issues" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "tool_one", description: "Example" }]),
    );
    const progress = vi.fn();
    const result = await priv.handleDispatch("manage github issues", 1.5, progress);
    expect(result.isError).toBeUndefined();
    // One winner, not two: 1.5 floors to 1.
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    // The tiebreak gate fired for the single-winner dispatch.
    expect(progress.mock.calls.some((c) => String(c[0]).includes("Top candidates close"))).toBe(true);
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

  it("one winner loads, one is cap-refused -- result is not an error (isError undefined)", async () => {
    // When the budget allows 2 servers but the cap only admits 1 (the first),
    // the second activation returns capped:true. Since something DID load,
    // isError must be undefined (not true) -- same rule as handleActivate.
    const priv = getPrivate(server);
    // Pre-load one server to fill the cap (serverCap = 1 for this test).
    priv.serverCap = 1;
    const ghConfig = makeServerConfig({
      id: "gh-id",
      namespace: "gh",
      name: "GitHub",
      description: "Repos and issues",
    });
    const slackConfig = makeServerConfig({
      id: "slack-id",
      namespace: "slack",
      name: "Slack",
      description: "Issues and team messages",
    });
    priv.config = { configVersion: "v1", servers: [ghConfig, slackConfig] };

    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "tool_one", description: "issues" }]),
    );

    // budget=2 so dispatch tries both; cap=1 so only the top-ranked loads.
    const result = await priv.handleDispatch("issues", 2);
    // At least one loaded (gh), one refused (slack) -- isError must be undefined.
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/Loaded "gh"/);
  });

  it("ALL winners are cap-refused and nothing loads -- isError true", async () => {
    // Pre-fill the cap by seeding a connection that is already connected
    // (counts toward the slot), then set serverCap=1 so no new server can load.
    const priv = getPrivate(server);
    priv.serverCap = 1;
    const ghConfig = makeServerConfig({
      id: "gh-id",
      namespace: "gh",
      name: "GitHub",
      description: "Repos and issues",
    });
    const slackConfig = makeServerConfig({
      id: "slack-id",
      namespace: "slack",
      name: "Slack",
      description: "Issues and team messages",
    });
    priv.config = { configVersion: "v1", servers: [ghConfig, slackConfig] };
    // Pre-load a DIFFERENT server to fill the single slot so both winners are refused.
    priv.connections.set("other", makeConnection("other", [{ name: "t" }]));

    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "tool_one" }]),
    );

    const result = await priv.handleDispatch("issues", 2);
    // Nothing loaded -- anyCapped && !anyChanged => isError true.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/concurrent.*cap|cap.*concurrent/i);
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
    expect(result.content[0].text).toContain("already loaded");
  });
});

describe("handleDiscoverWithAutoWarm", () => {
  let server: ConnectServer;

  beforeEach(() => {
    // Same reset-not-clear reasoning as handleDispatch above.
    vi.resetAllMocks();
    vi.mocked(disconnectFromUpstream).mockResolvedValue(undefined);
    server = new ConnectServer();
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
    expect(result.content[0].text).toContain('Auto-loaded "gh"');
  });

  it("does not auto-activate when no context is provided", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ namespace: "gh", name: "GitHub", description: "Issues" })],
    };
    const result = await priv.handleDiscoverWithAutoWarm(undefined);
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    // The banner string is "Auto-loaded" -- asserting on "Auto-activated"
    // (the old wording) passed vacuously no matter what the code did.
    expect(result.content[0].text).not.toContain("Auto-loaded");
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
    expect(result.content[0].text).not.toContain("Auto-loaded");
  });

  it("does not spawn an already-connected winner, but still advertises and names it", async () => {
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
    // No new spawn -- the connection already exists.
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    // But under the default gateway exposure "connected" is not
    // "advertised": an auto-loaded winner the client never asked for is
    // invisible in tools/list, so the intent-driven pick must still reach
    // sessionActivated and the banner must still name it -- otherwise the
    // one-shot discover(context) promise breaks exactly when the server
    // was already warm.
    expect(priv.sessionActivated.has("gh")).toBe(true);
    expect(result.content[0].text).toContain('Auto-loaded "gh"');
  });

  it("claims an already-connected winner away from prewarm, like activate and dispatch do", async () => {
    // The already-connected shortcut bypasses activateOne, which is where an
    // explicit activation deletes the prewarm claim. If the winner is a
    // prewarm-owned connection at that instant (its teardown has not run
    // yet), prewarm would close the very server this response calls
    // "Auto-loaded".
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
    priv.prewarmNamespaces.add("gh");

    const result = await priv.handleDiscoverWithAutoWarm("file a github issue");

    expect(result.content[0].text).toContain('Auto-loaded "gh"');
    expect(priv.prewarmNamespaces.has("gh")).toBe(false);
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });

  it("YAW_MCP_AUTO_ACTIVATE=0 disables the auto-warm entirely", async () => {
    // The gate used to be a static initializer evaluated at import, so an
    // env change (or a test stub) after the first import of server.ts was
    // ignored. It is now read per call.
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "0");
    try {
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
      vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
        makeConnection(cfg.namespace, [{ name: "create_issue" }]),
      );

      const result = await priv.handleDiscoverWithAutoWarm("file a github issue");
      expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
      expect(result.content[0].text).not.toContain("Auto-loaded");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rebuilds the routing table for the server it auto-warmed", async () => {
    // The auto-warm used to activate without rebuilding routes. With a
    // persisted toolCache the stale route stays `deferred`, so the very
    // next tools/call takes the deferred branch, finds gh already
    // connected (isChanged:false), and returns "no longer available" --
    // and neither a second discover nor an explicit activate can clear it.
    const priv = getPrivate(server);
    const ghConfig = makeServerConfig({
      id: "gh-id",
      namespace: "gh",
      name: "GitHub",
      description: "Repos, issues, and pull requests on GitHub",
      toolCache: [{ name: "create_issue", description: "Open an issue" }],
    });
    priv.config = { configVersion: "v1", servers: [ghConfig] };
    // Cold-start shape: routes built from the cache, so gh_create_issue is
    // present but deferred.
    priv.rebuildRoutes();
    expect(priv.toolRoutes.get("gh_create_issue")?.deferred).toBe(true);

    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "create_issue" }]),
    );

    await priv.handleDiscoverWithAutoWarm("file a github issue");

    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    expect(priv.toolRoutes.get("gh_create_issue")?.deferred).toBeUndefined();
  });

  it("names the namespace it actually warmed, not the head of the BM25 list", async () => {
    // The banner used to print sorted[0] from the ranking the list
    // rendering uses, while the server that got activated came from
    // twoStageRank. When the two disagree the banner named a server that
    // was never loaded.
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "a-id", namespace: "alpha", name: "Alpha", description: "issues issues issues" }),
        makeServerConfig({ id: "b-id", namespace: "bravo", name: "Bravo", description: "issues" }),
      ],
    };
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [{ name: "create_issue" }]),
    );
    // Force the auto-warm winner to be "bravo" regardless of BM25 order.
    // Scores are on the BM25 scale (unbounded positive) so they clear
    // AUTO_ACTIVATE_MIN_SCORE_BM25 / _MARGIN_BM25.
    priv.twoStageRank = async () => [
      { namespace: "bravo", score: 9.0 },
      { namespace: "alpha", score: 1.0 },
    ];

    const result = await priv.handleDiscoverWithAutoWarm("issues");
    expect(vi.mocked(connectToUpstream).mock.calls[0][0].namespace).toBe("bravo");
    expect(result.content[0].text).toContain('Auto-loaded "bravo"');
    expect(result.content[0].text).not.toContain('Auto-loaded "alpha"');
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
