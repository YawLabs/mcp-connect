import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock external dependencies before importing the module under test
// start() fires maybeRefreshSidecars() with no injectable seam, so without
// this every test that starts a ConnectServer runs the real gate ladder --
// against the developer's own ~/.yaw-mcp and cwd, not CI's. Its defaults are
// VITEST-gated (sidecar-refresh.ts), but that guard is the module's to keep,
// not this suite's to depend on: a future ungated default (a network probe, a
// real npm spawn) would otherwise land in every server test unnoticed.
vi.mock("../sidecar-refresh.js", () => ({
  maybeRefreshSidecars: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    // Mirrors PRODUCTION: upstream.ts flips the status synchronously and only
    // then awaits the close. A plain mockResolvedValue(undefined) does not, so
    // whether a test ran against the production shape used to depend on
    // whether an EARLIER test had installed the flipping implementation --
    // ordering decided semantics. Passed to vi.fn() (not attached afterwards)
    // so mockReset() restores exactly this behaviour for every test.
    disconnectFromUpstream: vi.fn(async (c: UpstreamConnection) => {
      c.status = "disconnected";
    }),
    // Mocked because the real one reads the DEVELOPER's ~/.yaw-mcp/secrets.json
    // via vaultPath()/homedir(). Unmocked, every elicitation test would be
    // graded against whatever vault the machine running the suite happens to
    // have -- green on a machine with no vault, red on one with a real vault
    // whose passphrase is not the test string. Its own behaviour is covered in
    // upstream.test.ts, where secrets-vault is mocked.
    verifyVaultPassphrase: vi.fn().mockResolvedValue(true),
  };
});

import { CONFIG_DIRNAME } from "../paths.js";
import { isRoutingFaultResult } from "../proxy.js";
import {
  ConnectServer,
  computeToolOverlaps,
  DEFAULT_IDLE_CALL_THRESHOLD,
  isAutoActivateEnabled,
  isAutoLoadEnabled,
  isRoutingFaultText,
  MAX_VAULT_PASSPHRASE_PROMPTS,
  ROUTING_FAULT_DISCONNECTED,
  ROUTING_FAULT_UNKNOWN_TOOL,
  resolveIdleThreshold,
  resolveToolExposure,
} from "../server.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";
import {
  ActivationError,
  clearSessionVaultPassphrase,
  connectToUpstream,
  type DownstreamClientBridge,
  disconnectFromUpstream,
  VaultPassphraseRequiredError,
  vaultPassphrase,
  verifyVaultPassphrase,
} from "../upstream.js";

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

// Drive the REAL tools/list handler rather than re-implementing its call to
// buildToolList. The handler is where resolveToolExposure() (gateway by
// default) and this.sessionActivated are wired together, so a regression in
// that wiring shows up here instead of being papered over by a hand-passed
// argument list.
async function listTools(priv: any): Promise<Array<{ name: string; inputSchema?: unknown }>> {
  const handler = priv.server._requestHandlers.get("tools/list");
  const res = await handler({ method: "tools/list", params: {} }, {} as never);
  return res.tools;
}

// The same list with the meta-tools dropped, i.e. what a client sees of the
// UPSTREAM catalog.
async function listedUpstreamToolNames(priv: any): Promise<string[]> {
  return (await listTools(priv)).map((t) => t.name).filter((n) => !n.startsWith("mcp_connect_"));
}

// runActivateOne sleeps a fixed 1s before its single retry (server.ts). Every
// test that drives a FAILING activation pays that second in real wall clock;
// running the call under fake timers collapses it. Only setTimeout/clearTimeout
// are faked -- Date stays real so activationFailures ageing and the 3s discover
// cache TTL keep behaving exactly as they do under real time.
async function withoutRetryBackoff(run: () => Promise<any>): Promise<any> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const promise = run();
    // Comfortably past the single 1s step, so a call that ends up scheduling
    // more than one of them (a batch, an elicited re-entry) still drains.
    await vi.advanceTimersByTimeAsync(5000);
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

// Yield to the microtask queue until `predicate` holds. Everything under these
// tests is mocked, so waiting on the STATE we actually care about beats
// sleeping a fixed number of milliseconds and hoping it was enough.
async function until(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition never became true");
}

// File-level, so it runs before EVERY describe's own beforeEach.
// vi.clearAllMocks() only wipes call history: a persistent mockRejectedValue /
// mockImplementation installed by one test otherwise survives into every later
// test in the file, which made the module mocks' default behaviour depend on
// test ORDER (a later test's first call past its own ...Once queue picked up an
// earlier test's leftovers). mockReset() restores each mock to the
// implementation the vi.mock factory handed vi.fn(), so every test starts from
// the same declared default.
beforeEach(() => {
  vi.mocked(connectToUpstream).mockReset();
  vi.mocked(disconnectFromUpstream).mockReset();
});

describe("ConnectServer", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
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
      // Advertised, not merely connected. Under the default gateway exposure
      // discover reports what tools/list actually surfaces, and that keys on
      // sessionActivated -- a hand-injected connection is what prewarm or a
      // deferred first call produces, which is deliberately rendered as
      // "connected (not advertised)" and contributes nothing to the tool
      // total. handleActivate is what adds the namespace here, so a test
      // asserting the LOADED rendering has to do the same.
      priv.sessionActivated.add("gh");

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("gh — GitHub [loaded (2 tools)]");
      expect(text).toContain("slack — Slack [ready]");
      expect(text).toContain("1 loaded in this session, 2 tools in context");
    });

    it("calls a connected-but-never-activated server unadvertised, and leaves it out of the tool total", () => {
      // The other half of the rule the test above pins: prewarm's claim and a
      // deferred first tools/call both leave a CONNECTED entry the client
      // never asked for. It holds a slot (so it counts as loaded), but under
      // gateway exposure tools/list withholds its tools -- so the "in context"
      // number must not include them.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.connections.set("gh", makeConnection("gh", ["create_issue", "list_prs"]));
      // Pinned blank: resolveToolExposure reads the env on every discover, so
      // an exported YAW_MCP_TOOL_EXPOSURE=full would advertise the namespace
      // and quietly turn this into a no-op assertion.
      vi.stubEnv("YAW_MCP_TOOL_EXPOSURE", "");
      try {
        const text = priv.handleDiscover().content[0].text;
        expect(text).toContain("gh — GitHub [connected (not advertised — activate to expose)]");
        expect(text).toContain("1 loaded in this session, 0 tools in context");
      } finally {
        vi.unstubAllEnvs();
      }
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
      expect(text).toContain('old — Old Server ("isActive": false in bundles.json)');
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
      // Only an ADVERTISED namespace adds to the session token total (the
      // per-server label is rendered either way -- it is what activating WOULD
      // cost). Injecting the connection by hand skips handleActivate, so the
      // namespace has to be marked activated for the summary to describe
      // context actually spent.
      priv.sessionActivated.add("gh");

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      // Connected: "N tools, M tokens" (no tilde prefix on the count).
      expect(text).toMatch(/gh — GitHub.*?— 2 tools, \d+ tokens/);
      // Cached: "N tools, ~M tokens" with tilde.
      expect(text).toMatch(/slack — Slack.*?— 3 tools, ~\d+ tokens/);
      // Session summary also mentions approximate total tokens. The source
      // renders that number with toLocaleString(), so the digits can carry
      // grouping separators once the total crosses 1,000 (and can be non-ASCII
      // under a non-Latin locale) -- match a rendered NUMBER, not a bare \d+.
      expect(text).toMatch(/1 loaded in this session, 2 tools in context \(~\p{N}[\p{N}\p{P}\p{Zs}]* tokens\)/u);
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
      // 4/10 failed = 40% → above WARN_RATE_FLOOR, the 10% warning gate in
      // health-score.ts (and past the 3-call observation floor).
      conn.health = { totalCalls: 10, errorCount: 4, totalLatencyMs: 0, lastErrorMessage: "502 bad gateway" };
      priv.connections.set("gh", conn);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      // "4 of 10", not "4 of the last 10": health.totalCalls / errorCount run
      // from the first call of the session and never decay, so there is no
      // window for "last" to name (see formatHealthWarning in health-score.ts).
      expect(text).toContain("warn: 4 of 10 calls failed: 502 bad gateway");
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
      // point to the publicly-browsable catalog at https://yaw.sh/mcp/catalog/
      // — there is no JSON API for the catalog, so this is an URL pointer,
      // not a programmatic surface.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "slack", name: "Slack" }),
      ]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("https://yaw.sh/mcp/catalog/");
      expect(text).toContain("yaw-mcp add <slug>");
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
      expect(text).not.toContain("https://yaw.sh/mcp/catalog/");
    });

    it("includes the marketplace pointer in the empty-state message", () => {
      // A fresh user with zero servers sees the empty-state branch —
      // that message also needs the catalog link so they can get started.
      const priv = getPrivate(server);
      priv.config = makeConfig([]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("No servers installed");
      expect(text).toContain("https://yaw.sh/mcp/catalog/");
    });
  });

  describe("getProfiledActiveServers toolCache merge", () => {
    // The merge in getProfiledActiveServers feeds the in-memory toolCache into
    // formatShadowLine so unknown namespaces with learned/persisted tools can
    // surface a heuristic shadow hint. These tests pin the merge contract.
    it("surfaces a heuristic shadow hint for an unknown namespace with a learned toolCache", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "my-npm-proxy", name: "npm proxy" })]);
      priv.toolCache.set("my-npm-proxy", [{ name: "npm_search" }, { name: "npm_audit" }, { name: "npm_view" }]);

      const text = priv.handleDiscover().content[0].text;
      expect(text).toContain("prefer over local CLI: `npm`");
    });

    it("preserves object identity when no in-memory cache exists", () => {
      // mergeToolCache (server.ts) promises to return `server` unchanged
      // when there is nothing to merge, so downstream consumers keyed on
      // reference equality are unaffected. Pin that.
      const priv = getPrivate(server);
      const serverConfig = makeServerConfig({ namespace: "gh" });
      priv.config = makeConfig([serverConfig]);

      const merged = priv.getProfiledActiveServers();
      expect(merged[0]).toBe(serverConfig); // same reference, not a clone
    });

    it("does not leak a namespace's cache to a sibling", () => {
      // gh and github share a prefix but no shared cache — github's output
      // must not see gh's tools. (The heuristic would also reject this case
      // via the namespace-name test, but the merge itself keys on namespace.)
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "github", name: "GitHub alias" }),
      ]);
      priv.toolCache.set("gh", [{ name: "gh_create_issue" }, { name: "gh_list_prs" }, { name: "gh_search" }]);

      const merged = priv.getProfiledActiveServers();
      const github = merged.find((s: UpstreamServerConfig) => s.namespace === "github");
      expect(github?.toolCache).toBeUndefined();
    });

    it("narrows by profile BEFORE merging cache", () => {
      // Filter-then-merge and merge-then-filter produce the same OUTPUT
      // (mergeToolCache is side-effect-free and profileAllows keys only on
      // namespace), so the returned array can't pin the order. Spy on the
      // merge instead: a profile-excluded server must never reach it — the
      // flipped order would clone caches for servers the profile drops.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub" }),
        makeServerConfig({ namespace: "linear", name: "Linear" }),
      ]);
      priv.toolCache.set("gh", [{ name: "gh_create" }, { name: "gh_list" }, { name: "gh_search" }]);
      priv.profile = { servers: ["gh"] };

      const mergeSpy = vi.spyOn(priv, "mergeToolCache");
      const merged = priv.getProfiledActiveServers();
      expect(merged.map((s: UpstreamServerConfig) => s.namespace)).toEqual(["gh"]);
      // And the surviving gh still got its cache merged.
      expect(merged[0].toolCache).toBeDefined();
      expect(merged[0].toolCache.length).toBe(3);
      // The ordering pin: only the profile-surviving server reaches the merge.
      expect(mergeSpy.mock.calls.map((c: any[]) => c[0].namespace)).toEqual(["gh"]);
    });

    it("treats an empty-array cache the same as no cache (object identity preserved)", () => {
      // Guards the `sessionCache.length > 0` check. A regression that drops
      // the guard would always-spread and fragment identity for dormant
      // servers — every consumer keyed on reference equality breaks silently.
      const priv = getPrivate(server);
      const serverConfig = makeServerConfig({ namespace: "gh" });
      priv.config = makeConfig([serverConfig]);
      priv.toolCache.set("gh", []); // learned entry that points at nothing

      const merged = priv.getProfiledActiveServers();
      expect(merged[0]).toBe(serverConfig);
    });

    it("prefers the in-memory sessionCache over the server's own toolCache on collision", () => {
      // When both `server.toolCache` (the path bundles.json / state.json
      // hydration would have taken) and `this.toolCache.get(namespace)`
      // (the live in-memory map, updated as servers activate) have entries,
      // the in-memory one wins. Pin the precedence so a regression that
      // flips the ternary can't silently let a stale persisted list
      // shadow fresh learning.
      const priv = getPrivate(server);
      const serverConfig = makeServerConfig({
        namespace: "my-npm-proxy",
        name: "npm proxy",
        toolCache: [{ name: "persisted_old" }, { name: "persisted_stale" }, { name: "persisted_gone" }],
      });
      priv.config = makeConfig([serverConfig]);
      priv.toolCache.set("my-npm-proxy", [{ name: "npm_search" }, { name: "npm_audit" }, { name: "npm_view" }]);

      const merged = priv.getProfiledActiveServers();
      expect(merged[0].toolCache).toEqual([{ name: "npm_search" }, { name: "npm_audit" }, { name: "npm_view" }]);
    });

    it("discover's known-tools line and the BM25 corpus read the SAME merged list", () => {
      // rankableFor and the discover body used to re-resolve the cold tool
      // list on their own with `this.toolCache.get(ns) ?? server.toolCache`,
      // under which an EMPTY learned list beat a curated one -- while
      // mergeToolCache (what getDeferredServers and formatShadowLine see) let
      // the curated list win. Four copies, two empty-list semantics. Pin the
      // one rule: mergeToolCache's.
      const priv = getPrivate(server);
      const serverConfig = makeServerConfig({
        namespace: "gh",
        name: "GitHub",
        toolCache: [{ name: "create_issue", description: "open an issue" }],
      });
      priv.config = makeConfig([serverConfig]);
      priv.toolCache.set("gh", []); // learned "zero tools", curated list present

      const text = priv.handleDiscover().content[0].text;
      expect(text).toContain("known tools: create_issue");
      expect(priv.rankableFor(serverConfig).tools).toEqual([{ name: "create_issue", description: "open an issue" }]);
    });

    it("exposes the merged cache to the guide auto-section via getBuiltinResources", () => {
      // cli-shadows.ts:166 promises "discover + guide see learned tools".
      // The discover path is covered above; the guide resource reads the
      // same merged list inside renderGuide and renders an "Active servers"
      // block. Pin the guide path so a regression that splits
      // getProfiledActiveServers between the two callers (or caches the
      // guide body past toolCache changes) breaks this test rather than
      // silently dropping the heuristic hint from the guide resource.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "my-npm-proxy", name: "npm proxy" })]);
      priv.toolCache.set("my-npm-proxy", [{ name: "npm_search" }, { name: "npm_audit" }, { name: "npm_view" }]);
      priv.guides = {
        user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "user guide" },
        project: null,
      };

      const builtin = priv.getBuiltinResources()[0];
      const text = builtin.read().contents[0].text;
      expect(text).toContain("my-npm-proxy");
      expect(text).toContain("prefer over local CLI: `npm`");
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

  describe("discover bundle completions", () => {
    it("surfaces a bundle-completion nudge when a curated bundle is partially installed", () => {
      // Install github only. pr-review needs github + linear, so the
      // inline block must surface it as a partial with linear missing.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "github", name: "GitHub" })]);
      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("Bundle completions (install to unlock curated stacks):");
      expect(text).toContain("pr-review");
      expect(text).toContain("have: github");
      expect(text).toContain("add: linear");
    });

    it("feeds the nudge the ACTIVE profile-allowed set, matching mcp_connect_bundles", () => {
      // github disabled + linear active: pr-review must read as PARTIAL
      // with github missing -- the same verdict mcp_connect_bundles match
      // and `yaw-mcp bundles match` give (both filter to active+allowed).
      // Feeding ALL configured servers here made the bundle read complete
      // in discover while the other two surfaces called it partial.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "github", name: "GitHub", isActive: false }),
        makeServerConfig({ namespace: "linear", name: "Linear" }),
      ]);
      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("pr-review");
      expect(text).toContain("have: linear");
      expect(text).toContain("add: github");
    });

    it("suppresses the bundle-completions block when no bundle has any overlap", () => {
      // Install only a namespace that matches no seeded bundle — the
      // block should not even print its header.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "nonsense-ns", name: "NS" })]);
      const result = priv.handleDiscover();
      expect(result.content[0].text).not.toContain("Bundle completions");
    });

    it("does not list a bundle whose servers are all installed", () => {
      // github + linear fully satisfies pr-review. devops-incident and
      // product-release still share those namespaces, so the block IS
      // rendered here -- which is exactly why the header assertion has to
      // come first: without it the negative match below passes trivially if
      // the whole block ever stops rendering.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "github", name: "GitHub" }),
        makeServerConfig({ namespace: "linear", name: "Linear" }),
      ]);
      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("Bundle completions");
      const completionsBlock = text.split("Bundle completions")[1] ?? "";
      expect(completionsBlock).not.toMatch(/^\s+pr-review/m);
    });

    it("suppresses the block when every bundle it touches is fully installed", () => {
      // postgres + aws + snowflake is exactly data-ops, and no other curated
      // bundle shares ANY of those namespaces -- so there is no partial
      // bundle left and the header must not be printed at all.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "postgres", name: "Postgres" }),
        makeServerConfig({ namespace: "aws", name: "AWS" }),
        makeServerConfig({ namespace: "snowflake", name: "Snowflake" }),
      ]);
      const result = priv.handleDiscover();
      expect(result.content[0].text).not.toContain("Bundle completions");
    });

    it("caps the bundle-completions block at 3 entries", () => {
      // Install slack — overlaps with devops-incident, growth-stack,
      // product-release, support-ops. All 4 are partial; the block must
      // cap at 3.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "slack", name: "Slack" })]);
      const result = priv.handleDiscover();
      const text = result.content[0].text;
      const completionLines = text.split("\n").filter((l: string) => l.startsWith("  ") && l.includes("have: slack"));
      // Exactly 3, not "at most 3": <= 3 is also satisfied by zero matching
      // lines, so it could not fail if the block stopped rendering or the
      // line format moved.
      expect(completionLines).toHaveLength(3);
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
      expect(result.content[0].text).toContain("not installed");
      // No lookalikes in an empty config — fall back to discover nudge.
      expect(result.content[0].text).toContain("mcp_connect_discover");
    });

    it("surfaces a 'Did you mean?' when the namespace is a near-miss of an installed one", async () => {
      // User typed "githu" when "github" is installed — one-edit typo.
      // closestNames is intentionally quiet on wild misses, so this also
      // proves we emit the suggestion only when signal is high.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "github", name: "GitHub" }),
        makeServerConfig({ namespace: "linear", name: "Linear" }),
      ]);
      const result = await priv.handleActivate(["githu"]);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('"githu" is not installed');
      expect(text).toContain("Did you mean: github");
    });

    it("distinguishes an installed-but-disabled server from an unknown one", async () => {
      // Disabled-in-bundles.json case gets its own message so the model
      // doesn't tell the user to install something they already have.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", isActive: false })]);
      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain("installed but disabled");
      expect(text).toContain('"isActive": true');
      expect(text).toContain("~/.yaw-mcp/bundles.json");
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

      const result = await withoutRetryBackoff(() => priv.handleActivate(["gh"]));
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Loaded "gh"');
      expect(connectToUpstream).toHaveBeenCalledTimes(2);
    });

    it("reports failure after both attempts fail", async () => {
      const priv = getPrivate(server);
      const config = makeServerConfig({ namespace: "gh" });
      priv.config = makeConfig([config]);

      vi.mocked(connectToUpstream).mockRejectedValue(new Error("timeout"));

      const result = await withoutRetryBackoff(() => priv.handleActivate(["gh"]));
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

    it("fix#3: all-failed activation still sets isError true", async () => {
      // anyError=true and anyChanged=false. The old code's condition was
      // `anyError && !anyChanged ? true : undefined`; the current one is
      // `anyError || (anyCapped && !anyChanged) ? true : undefined`, so a
      // real failure ALWAYS surfaces (the anyChanged conjunct is gone) and
      // a cap refusal only errors when nothing loaded at all.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "bad" })]);
      vi.mocked(connectToUpstream).mockRejectedValue(new Error("bad server down"));

      const result = await withoutRetryBackoff(() => priv.handleActivate(["bad"]));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("bad server down");
    });

    it("fix#3: compliance-refusal partial success also sets isError true", async () => {
      // Compliance refusal is synchronous (no retry delay). Use it to
      // exercise the anyError && anyChanged=true branch without a 1s wait.
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh" }),
        makeServerConfig({ namespace: "bad", complianceGrade: "D" }),
      ]);
      // Only gh will be activated (bad is blocked by compliance).
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));
      // stubEnv, not a raw process.env write: `delete process.env.X` in the
      // finally would permanently REMOVE a real YAW_MCP_MIN_COMPLIANCE from
      // the developer's shell for the rest of the run, where unstubAllEnvs
      // restores whatever was there.
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      try {
        const result = await priv.handleActivate(["gh", "bad"]);
        // anyError=true (bad refused), anyChanged=true (gh loaded).
        // Old logic: isError = anyError && !anyChanged = false -> undefined.
        // Current logic: anyError alone forces true, regardless of
        // anyChanged (the anyCapped clause is the only one that still
        // consults it).
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Refused");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("compliance-aware routing", () => {
    // vi.unstubAllEnvs() restores every stubbed env var after each case so
    // an errant YAW_MCP_MIN_COMPLIANCE can't leak into later suites.
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("refuses to activate a below-grade server with a clear error", async () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "D" })]);

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Refused to load "gh"');
      expect(text).toContain("grade D");
      expect(text).toContain("YAW_MCP_MIN_COMPLIANCE=B");
      expect(text).toContain("Unset YAW_MCP_MIN_COMPLIANCE");
      // No upstream spawn — the gate must short-circuit before activation.
      expect(connectToUpstream).not.toHaveBeenCalled();
      expect(priv.connections.has("gh")).toBe(false);
    });

    it("dispatch honors the compliance floor via the shared activate path (not just handleActivate)", async () => {
      // The floor gate lives inside runActivateOne now, so a dispatch that
      // ranks a below-grade server first must refuse it before any spawn.
      // handleActivate's own early check does NOT cover the dispatch path —
      // this pins that the gate moved down into the shared activate flow.
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "D" })]);

      const result = await priv.handleDispatch("github issue", 1);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Refused to load "gh"');
      expect(text).toContain("grade D");
      // Gate short-circuits before connectToUpstream — no below-grade spawn.
      expect(connectToUpstream).not.toHaveBeenCalled();
      expect(priv.connections.has("gh")).toBe(false);
    });

    it("reports an unrecognized grade distinctly from a below-min grade", async () => {
      // passesMinCompliance fails closed on a garbled grade, but the message
      // must not call an unrecognized "Pass" grade "below B".
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      const priv = getPrivate(server);
      // "Pass" is intentionally off the Grade union: it simulates a backend
      // emitting a grade format yaw-mcp doesn't recognize (the case A6 fixes).
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "Pass" as never }),
      ]);

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Refused to load "gh"');
      expect(text).toContain("unrecognized compliance grade");
      expect(text).toContain('"Pass"');
      expect(text).not.toContain("grade Pass is below");
    });

    it("allows activation when the grade meets the minimum", async () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "A" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Loaded "gh"');
      expect(priv.connections.has("gh")).toBe(true);
    });

    it("allows activation for ungraded servers even when the filter is on (don't punish unknown)", async () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "A");
      const priv = getPrivate(server);
      // No complianceGrade on this config — mirrors today's backend.
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

      const result = await priv.handleActivate(["gh"]);
      expect(result.isError).toBeUndefined();
      expect(priv.connections.has("gh")).toBe(true);
    });

    it("does not filter anything when YAW_MCP_MIN_COMPLIANCE is unset", async () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "");
      const priv = getPrivate(server);
      // Even an F-grade server is activatable with the filter disabled.
      priv.config = makeConfig([makeServerConfig({ namespace: "bad", name: "Bad", complianceGrade: "F" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("bad", ["t"]));

      const result = await priv.handleActivate(["bad"]);
      expect(result.isError).toBeUndefined();
      expect(priv.connections.has("bad")).toBe(true);
    });

    it("annotates below-grade servers in discover output and emits a filter header", () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      const priv = getPrivate(server);
      priv.config = makeConfig([
        makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "A" }),
        makeServerConfig({ namespace: "bad", name: "Bad Server", complianceGrade: "D" }),
        makeServerConfig({ namespace: "raw", name: "Ungraded" }),
      ]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).toContain("Compliance filter active: YAW_MCP_MIN_COMPLIANCE=B");
      // Passing grade is surfaced inline as `[A]`.
      expect(text).toMatch(/gh — GitHub.*\[A\]/);
      // Failing server is surfaced in place with the refusal reason.
      expect(text).toContain("bad — Bad Server");
      expect(text).toContain("(grade D — below YAW_MCP_MIN_COMPLIANCE=B, won't auto-activate)");
      // Ungraded server gets no annotation — avoids cluttering every
      // current deploy where nothing is scored yet.
      expect(text).not.toMatch(/raw — Ungraded.*\[[A-F]\]/);
      expect(text).not.toMatch(/raw — Ungraded.*won't auto-activate/);
    });

    it("shows `[grade]` tags even when the filter env is unset (trust signal is always on)", () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "");
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", complianceGrade: "B" })]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      expect(text).not.toContain("Compliance filter active");
      // Grade tag surfaces unconditionally when the backend has scored
      // the server — a visible A-F mark on every discover output lets
      // the model factor trust into activation decisions without the
      // user having to pre-configure a floor.
      expect(text).toMatch(/gh — GitHub.*\[B\]/);
    });

    it("leaves ungraded servers unannotated with the filter unset", () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "");
      const priv = getPrivate(server);
      // No complianceGrade on this config — mirrors unscored catalog entries.
      priv.config = makeConfig([makeServerConfig({ namespace: "raw", name: "Ungraded" })]);

      const result = priv.handleDiscover();
      const text = result.content[0].text;
      // Ungraded stays clean — don't invent a placeholder that would
      // read as a grade to the model.
      expect(text).not.toMatch(/raw — Ungraded.*\[[A-F]\]/);
    });
  });

  // The grade cache written by `yaw-mcp audit` is the ONLY supplier of
  // `complianceGrade` in local mode: bundles.json entries never carry one
  // (validateEntry drops unknown fields). Until start() overlaid it, every
  // server was permanently ungraded — which made YAW_MCP_MIN_COMPLIANCE inert
  // (ungraded always passes) and blanked the discover badge. These pin the
  // overlay by its EFFECT on gating, not by the field being set.
  describe("compliance grades hydrated from grades.json", () => {
    let gradesHome: string;

    function writeGrades(entries: Record<string, { grade: string; score: number; gradedAt: string }>): void {
      mkdirSync(join(gradesHome, CONFIG_DIRNAME), { recursive: true });
      writeFileSync(join(gradesHome, CONFIG_DIRNAME, "grades.json"), JSON.stringify(entries, null, 2), "utf8");
    }

    const GRADE_D = { grade: "D", score: 41.2, gradedAt: "2026-06-11T00:00:00.000Z" };

    beforeEach(() => {
      gradesHome = mkdtempSync(join(tmpdir(), "yaw-mcp-srv-grades-"));
    });

    afterEach(() => {
      rmSync(gradesHome, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });

    it("gates a cache-graded server behind YAW_MCP_MIN_COMPLIANCE", async () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      writeGrades({ bad: GRADE_D });
      const priv = getPrivate(server);
      // No complianceGrade in the config — exactly what bundles.json yields.
      priv.config = makeConfig([makeServerConfig({ namespace: "bad", name: "Bad Server" })]);

      await priv.hydrateComplianceGrades(gradesHome);

      const result = await priv.handleActivate(["bad"]);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('Refused to load "bad"');
      expect(text).toContain("grade D");
      expect(text).toContain("YAW_MCP_MIN_COMPLIANCE=B");
      // The gate must short-circuit before any upstream spawn.
      expect(connectToUpstream).not.toHaveBeenCalled();
      expect(priv.connections.has("bad")).toBe(false);
    });

    it("without the overlay the same server reads as ungraded and passes the floor", async () => {
      // Pins WHY the bug was silent: absent the overlay, passesMinCompliance
      // sees `undefined` and fails open. If this ever starts refusing, the
      // fail-open-on-genuinely-ungraded policy changed and the test above is
      // no longer proving the overlay did the work.
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
      writeGrades({ bad: GRADE_D });
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "bad", name: "Bad Server" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("bad", ["t"]));

      const result = await priv.handleActivate(["bad"]);
      expect(result.isError).toBeUndefined();
      expect(priv.connections.has("bad")).toBe(true);
    });

    it("renders the [A]-[F] discover badge from a cached grade", async () => {
      vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "");
      writeGrades({ gh: { grade: "A", score: 97.7, gradedAt: "2026-06-11T00:00:00.000Z" } });
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);

      await priv.hydrateComplianceGrades(gradesHome);

      expect(priv.handleDiscover().content[0].text).toMatch(/gh — GitHub.*\[A\]/);
    });

    it("leaves servers absent from the cache ungraded", async () => {
      writeGrades({ other: GRADE_D });
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);

      await priv.hydrateComplianceGrades(gradesHome);

      expect(priv.config.servers[0].complianceGrade).toBeUndefined();
    });

    it("degrades to ungraded when the cache is missing or garbage", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);

      // Missing file.
      await priv.hydrateComplianceGrades(gradesHome);
      expect(priv.config.servers[0].complianceGrade).toBeUndefined();

      // Present but not JSON — must not throw and must not blank the list.
      mkdirSync(join(gradesHome, CONFIG_DIRNAME), { recursive: true });
      writeFileSync(join(gradesHome, CONFIG_DIRNAME, "grades.json"), "{{{ not json", "utf8");
      await expect(priv.hydrateComplianceGrades(gradesHome)).resolves.toBeUndefined();
      expect(priv.config.servers).toHaveLength(1);
      expect(priv.config.servers[0].complianceGrade).toBeUndefined();
    });
  });

  // Before the tool cache was persisted, `server.toolCache` was permanently
  // undefined, so prewarm classified EVERY active server as dormant and
  // re-spawned all of them (an `npx -y <pkg>@latest` resolve each) on every
  // client start. These pin that a known tool list suppresses the spawn.
  describe("persisted tool cache", () => {
    it("prewarm skips a server whose tools were hydrated from state.json", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.hydrateToolCache({
        gh: { tools: [{ name: "create_issue", description: "open an issue" }], learnedAt: Date.now() },
      });

      await priv.prewarmDormantServers();

      expect(connectToUpstream).not.toHaveBeenCalled();
    });

    it("prewarm still spawns a server whose tools are unknown to both sources", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

      await priv.prewarmDormantServers();

      expect(connectToUpstream).toHaveBeenCalledTimes(1);
    });

    // A resources/prompts-only upstream answers "zero tools", and that IS an
    // answer. It used to be thrown away at three separate points (the
    // persistence sanitizer, hydrateToolCache, exportToolCache) and rejected
    // by hasKnownTools, so such a server was dormant forever and paid a
    // full `npx -y <pkg>@latest` resolve on every single client start.
    it("prewarm skips a server whose learned tool list is legitimately empty", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "docs", name: "Docs" })]);
      priv.hydrateToolCache({ docs: { tools: [], learnedAt: Date.now() } });

      await priv.prewarmDormantServers();

      expect(connectToUpstream).not.toHaveBeenCalled();
    });

    it("an empty learned list still ages out on the weekly refresh cadence", async () => {
      // Trusting the empty answer must not pin it forever: if the upstream
      // later grows tools, the weekly re-learn is the only thing that finds
      // out. Same cadence every other learned list gets.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "docs", name: "Docs" })]);
      priv.hydrateToolCache({ docs: { tools: [], learnedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 } });
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("docs", ["search"]));

      await priv.prewarmDormantServers();

      expect(connectToUpstream).toHaveBeenCalledTimes(1);
    });

    it("exports a zero-tool namespace so the next session can skip it", () => {
      const priv = getPrivate(server);
      priv.toolCache.set("docs", []);
      priv.toolCacheLearnedAt.set("docs", 4_000);

      expect(priv.exportToolCache()).toEqual({ docs: { tools: [], learnedAt: 4_000 } });
    });

    it("hydrated tools make an inactive server deferred on the first tools/list", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.hydrateToolCache({ gh: { tools: [{ name: "create_issue" }], learnedAt: 1_000 } });

      const deferred = priv.getDeferredServers();
      expect(deferred.map((s: UpstreamServerConfig) => s.namespace)).toEqual(["gh"]);
      expect(deferred[0].toolCache).toEqual([{ name: "create_issue" }]);
    });

    it("exportToolCache preserves the hydrated learnedAt so entries still age out", () => {
      const priv = getPrivate(server);
      priv.hydrateToolCache({ gh: { tools: [{ name: "create_issue" }], learnedAt: 12_345 } });

      expect(priv.exportToolCache()).toEqual({ gh: { tools: [{ name: "create_issue" }], learnedAt: 12_345 } });
    });

    it('exportToolCache preserves a "__proto__" namespace as an own key', () => {
      // sanitizeToolCache/hydrateToolCache preserve a "__proto__" toolCache
      // namespace on load; the export side must not undo that one flush
      // later via the inherited setter (same shape as learning's
      // exportSnapshot hardening).
      const priv = getPrivate(server);
      priv.toolCache.set("__proto__", [{ name: "t", namespacedName: "__proto___t", inputSchema: {} }]);
      priv.toolCacheLearnedAt.set("__proto__", 123);
      const out = priv.exportToolCache();
      expect(Object.hasOwn(out, "__proto__")).toBe(true);
      const roundTripped = JSON.parse(JSON.stringify(out));
      expect(Object.getOwnPropertyDescriptor(roundTripped, "__proto__")?.value.learnedAt).toBe(123);
    });

    it("a live activation refreshes the cache and stamps it with a fresh learnedAt", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.hydrateToolCache({ gh: { tools: [{ name: "stale_tool" }], learnedAt: 1_000 } });
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

      const before = Date.now();
      await priv.handleActivate(["gh"]);

      const exported = priv.exportToolCache();
      expect(exported.gh.tools.map((t: { name: string }) => t.name)).toEqual(["create_issue"]);
      expect(exported.gh.learnedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe("shadow-driven install nudge", () => {
    let nudgeHome: string;

    // Point the scan at a synthetic home with a controlled .bash_history,
    // and an env with no APPDATA so only the bash source is read. The state
    // file (suppression) also lands under this synthetic home, so tests
    // never touch the developer's real ~/.yaw-mcp/ or shell history.
    function primeHistory(server: ConnectServer, lines: string[], extra: Record<string, string> = {}): void {
      writeFileSync(join(nudgeHome, ".bash_history"), `${lines.join("\n")}\n`, "utf8");
      const priv = getPrivate(server);
      priv.nudgeHome = nudgeHome;
      // No APPDATA, so the %APPDATA% PowerShell source is skipped. The
      // PowerShell 7 XDG source is NOT skipped -- doctor-cmd.ts always adds
      // it -- but it resolves under the synthetic home
      // (<home>/.local/share/powershell/...), where no history file exists,
      // so .bash_history is still the only source with content.
      priv.nudgeEnv = { ...extra };
      // The discover dedup cache is keyed on config/context/active-set, not
      // on nudge state — clear it so repeated handleDiscover() calls in one
      // test re-render instead of returning a stale cached block.
      priv.discoverCache = null;
    }

    // Repeat `tailscale` N times so its ShadowHit.count >= threshold (5).
    const HEAVY = (cli: string, n = 14): string[] => Array.from({ length: n }, () => `${cli} status`);

    beforeEach(() => {
      nudgeHome = mkdtempSync(join(tmpdir(), "yaw-mcp-srv-nudge-"));
    });

    afterEach(() => {
      rmSync(nudgeHome, { recursive: true, force: true });
    });

    it("OFF by default: scan never runs and output is byte-identical to a build without the feature", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      // Even with a heavy tailscale history present, the gate is off so
      // nothing is surfaced. The gate is NOT forced here: `installNudge = false`
      // is the constructor default (server.ts), and a test that reassigns it
      // could not tell "off by default" from "off because we said so".
      primeHistory(server, HEAVY("tailscale"));
      expect(priv.installNudge).toBe(false);

      // Instrument the one field the scan reads. buildInstallCandidatesLines
      // returns on the gate BEFORE it touches this.nudgeHome, so a read count
      // of 0 PROVES the history was never opened -- an absent substring only
      // proves nothing was rendered.
      let homeReads = 0;
      let home: string = priv.nudgeHome;
      Object.defineProperty(priv, "nudgeHome", {
        configurable: true,
        get: () => {
          homeReads++;
          return home;
        },
        set: (v: string) => {
          home = v;
        },
      });

      const withFeatureOff = priv.handleDiscover().content[0].text;
      expect(homeReads).toBe(0);
      expect(withFeatureOff).not.toContain("Install candidates");
      expect(withFeatureOff).not.toContain("tailscale");

      // Byte-identical to a server whose nudgeHome points nowhere (scan
      // would find nothing) — the off path renders the same discover body.
      const emptyHome = mkdtempSync(join(tmpdir(), "yaw-mcp-empty-"));
      try {
        priv.discoverCache = null;
        priv.nudgeHome = emptyHome;
        const baseline = priv.handleDiscover().content[0].text;
        expect(withFeatureOff).toBe(baseline);
      } finally {
        // finally, not a trailing statement: an assertion failure above used
        // to leak the temp dir for the life of the machine.
        rmSync(emptyHome, { recursive: true, force: true });
      }
    });

    it("ON: surfaces a heavily-used first-party CLI as an install candidate", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.installNudge = true;
      primeHistory(server, HEAVY("tailscale"));

      const text = priv.handleDiscover().content[0].text;
      expect(text).toContain("Install candidates (from your recent shell usage; history stays local):");
      expect(text).toContain("tailscale");
      expect(text).toContain("ran 14x recently");
      expect(text).toContain("install @yawlabs/tailscale-mcp");
      // The nudge points at the CLI, not a meta-tool: `yaw-mcp add <slug>`
      // is what actually writes ~/.yaw-mcp/bundles.json.
      expect(text).toContain("run: yaw-mcp add tailscale");
      expect(text).not.toContain("mcp_connect_install");
    });

    it("never leaks a raw history line / argument into the nudge output", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.installNudge = true;
      // Put a secret-looking argument in the history lines.
      const SECRET = "SUPERSECRETAUTHKEY-9f3a";
      primeHistory(
        server,
        Array.from({ length: 14 }, () => `tailscale up --authkey=${SECRET}`),
      );

      const text = priv.handleDiscover().content[0].text;
      // The CLI is surfaced …
      expect(text).toContain("tailscale");
      // … but the argument / raw command text NEVER appears.
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("--authkey");
      expect(text).not.toContain("tailscale up");
    });

    it("does NOT nudge a heavily-used CLI with no first-party target (kubectl/npm/ssh)", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.installNudge = true;
      primeHistory(server, [...HEAVY("kubectl"), ...HEAVY("npm"), ...HEAVY("ssh")]);

      const text = priv.handleDiscover().content[0].text;
      expect(text).not.toContain("Install candidates");
      expect(text).not.toContain("kubectl");
    });

    it("does NOT nudge below the count threshold", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.installNudge = true;
      // 4 runs < threshold of 5.
      primeHistory(server, HEAVY("tailscale", 4));

      const text = priv.handleDiscover().content[0].text;
      expect(text).not.toContain("Install candidates");
    });

    it("skips a CLI whose namespace is already installed (they already have it)", () => {
      const priv = getPrivate(server);
      // tailscale server IS installed/active — no nudge even with heavy usage.
      priv.config = makeConfig([makeServerConfig({ namespace: "tailscale", name: "Tailscale" })]);
      priv.installNudge = true;
      primeHistory(server, HEAVY("tailscale"));

      const text = priv.handleDiscover().content[0].text;
      expect(text).not.toContain("Install candidates");
    });

    // Titled for what it actually drives: buildInstallCandidatesLines twice,
    // not two discovers. A real second discover inside the 3s memo would hand
    // back the cached body without re-running the block at all, so it could
    // never exercise the per-CLI cooldown this pins.
    it("per-CLI suppression: a second buildInstallCandidatesLines within the cooldown does not re-nudge", () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.installNudge = true;
      primeHistory(server, HEAVY("tailscale"));

      // First call surfaces it (and records the nudge to the state file).
      const first = priv.buildInstallCandidatesLines(priv.getProfiledActiveServers()).join("\n");
      expect(first).toContain("tailscale");

      // Second call within the cooldown is suppressed.
      const second = priv.buildInstallCandidatesLines(priv.getProfiledActiveServers()).join("\n");
      expect(second).toBe("");
    });
  });

  describe("per-tool load", () => {
    // These tests drive handleToolCall so the full activate → filter-apply →
    // routes rebuild → list path is exercised end-to-end, and read the result
    // through the REAL tools/list handler (listedUpstreamToolNames) so the
    // exposure mode is production's, not a hand-passed "full". The env is
    // pinned to blank -- resolveToolExposure reads it per call, so an exported
    // YAW_MCP_TOOL_EXPOSURE=full would otherwise decide what these assert.
    beforeEach(() => {
      vi.stubEnv("YAW_MCP_TOOL_EXPOSURE", "");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("activate without tools exposes every upstream tool (baseline)", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo", "bar", "baz"]));

      const result = await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
      expect(result.isError).toBeUndefined();
      expect(priv.toolFilters.has("gh")).toBe(false);
      expect((await listedUpstreamToolNames(priv)).sort()).toEqual(["gh_bar", "gh_baz", "gh_foo"]);
    });

    it("activate with tools: ['foo'] only surfaces that one tool (others hidden)", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo", "bar", "baz"]));

      await priv.handleToolCall("mcp_connect_activate", { server: "gh", tools: ["foo"] });

      // Filter is persisted on the server for subsequent tools/list calls.
      expect(priv.toolFilters.get("gh")).toEqual(new Set(["foo"]));
      expect(await listedUpstreamToolNames(priv)).toEqual(["gh_foo"]);
    });

    it("a non-string entry in tools is dropped, not read as 'clear the filter'", async () => {
      // The raw args are untyped tool input. Discarding the WHOLE array on
      // one bad entry routed a malformed narrowing request into the
      // clear-the-filter branch, so `tools: ["foo", 42]` widened the
      // advertised surface to every tool -- the opposite of what was asked.
      // resolveNamespaces filters `servers` the same way.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo", "bar", "baz"]));

      await priv.handleToolCall("mcp_connect_activate", { server: "gh", tools: ["foo", 42, null, ""] });

      expect(priv.toolFilters.get("gh")).toEqual(new Set(["foo"]));
      expect(await listedUpstreamToolNames(priv)).toEqual(["gh_foo"]);
    });

    it("re-activating the same namespace without tools clears the filter", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      // Both calls go through handleToolCall → activateOne; the second
      // hits the "already connected" early return but still has to
      // clear the filter so the list re-expands.
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo", "bar"]));

      await priv.handleToolCall("mcp_connect_activate", { server: "gh", tools: ["foo"] });
      expect(await listedUpstreamToolNames(priv)).toEqual(["gh_foo"]);

      await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
      expect(priv.toolFilters.has("gh")).toBe(false);
      expect((await listedUpstreamToolNames(priv)).sort()).toEqual(["gh_bar", "gh_foo"]);
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
      expect(await listedUpstreamToolNames(priv)).toEqual(["gh_foo"]);
      // … but the route map still carries it (dispatch path unchanged).
      expect(priv.toolRoutes.has("gh_bar")).toBe(true);

      // And handleToolCall on the hidden tool dispatches to the upstream.
      const callResult = await priv.handleToolCall("gh_bar", {});
      expect(callResult.isError).toBeUndefined();
      expect(callResult.content[0].text).toBe("bar called");
      // Only the tools/call PARAMS are this test's business. routeToolCall
      // also passes `undefined` (keep the SDK's result schema) and a request-
      // options object carrying the call timeout; those two slots are pinned
      // in proxy.test.ts, and spelling them out here would make every server
      // test re-assert the proxy's calling convention.
      expect(vi.mocked(conn.client.callTool).mock.calls[0][0]).toEqual({ name: "bar", arguments: {} });
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
      expect((await listedUpstreamToolNames(priv)).sort()).toEqual(["gh_bar", "gh_foo", "slack_send"]);
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

    it("reports when server is not loaded (idempotent -- not an error)", async () => {
      // Already-unloaded is a no-op success, not an error, so idempotent
      // callers don't have to special-case "wasn't loaded" responses.
      const priv = getPrivate(server);
      const result = await priv.handleDeactivate(["unknown"]);
      expect(result.isError).toBeUndefined();
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

    it("fix#4: deactivating a mix of loaded and already-unloaded succeeds (idempotent)", async () => {
      // The tool is annotated idempotent; returning isError for an
      // already-unloaded namespace breaks retry loops. A mixed call
      // (one loaded, one not) must succeed overall.
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      // "slack" is not loaded.

      const result = await priv.handleDeactivate(["gh", "slack"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Unloaded");
      expect(result.content[0].text).toContain("wasn't loaded");
    });

    it("fix#4: deactivating only already-unloaded namespaces succeeds (idempotent)", async () => {
      const priv = getPrivate(server);
      // Nothing is loaded.
      const result = await priv.handleDeactivate(["ghost"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("wasn't loaded");
    });

    it("drops the namespace from sessionActivated so gateway mode stops advertising it", async () => {
      // Load-bearing for the default exposure: buildToolList keys the
      // advertised surface on sessionActivated, so an entry left behind here
      // keeps the tools in tools/list and makes the response's "Tools removed
      // from context" a lie.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.connections.set("gh", makeConnection("gh", ["create_issue"]));
      priv.sessionActivated.add("gh");

      await priv.handleDeactivate(["gh"]);

      expect(priv.sessionActivated.has("gh")).toBe(false);
    });

    it("refuses to unload a namespace with a call still in flight", async () => {
      // Same guard the idle reaper applies (see "idle reaper vs in-flight tool
      // calls"): closing under a live call rejects the caller's own pending
      // tools/call, the proxy turns that into an isError result, and
      // handleToolCall books a 0.0 reward against an upstream that was
      // answering normally. The namespace stays loaded instead.
      const priv = getPrivate(server);
      priv.connections.set("gh", makeConnection("gh"));
      priv.inflightCalls.set("gh", 1);
      const refresh = vi.spyOn(priv, "refreshRoutesAndNotify");

      const result = await priv.handleDeactivate(["gh"]);

      expect(vi.mocked(disconnectFromUpstream)).not.toHaveBeenCalled();
      expect(priv.connections.has("gh")).toBe(true);
      // The response has to name the count, or the caller cannot tell this
      // apart from "wasn't loaded" and won't know to call again.
      expect(result.content[0].text).toContain('"gh" still has 1 tool call in flight');
      expect(result.content[0].text).not.toContain("Unloaded");
      // Nothing moved, so no list_changed triplet either.
      expect(refresh).not.toHaveBeenCalled();

      // Once the call drains, the same request unloads it.
      priv.inflightCalls.delete("gh");
      const after = await priv.handleDeactivate(["gh"]);
      expect(after.content[0].text).toContain('Unloaded "gh"');
      expect(priv.connections.has("gh")).toBe(false);
    });

    it("skips the routes refresh when nothing was actually unloaded", async () => {
      // anyChanged gates refreshRoutesAndNotify. An idempotent retry against a
      // namespace that was never loaded moved no surface, so it must not emit
      // a list_changed triplet -- clients refetch all three lists on one.
      const priv = getPrivate(server);
      const refresh = vi.spyOn(priv, "refreshRoutesAndNotify");

      await priv.handleDeactivate(["ghost"]);
      expect(refresh).not.toHaveBeenCalled();

      // ...and a mixed call, where something DID unload, still refreshes once.
      priv.connections.set("gh", makeConnection("gh"));
      await priv.handleDeactivate(["gh", "ghost"]);
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe("trackUsageAndAutoDeactivate", () => {
    // The fixtures below are built from resolveIdleThreshold(), which reads
    // the real env. An operator value under the adaptive floor of 5, or at or
    // above the ceiling of 50, are both accepted by the parser and would make
    // these fail on that machine only -- pin the documented default instead.
    beforeEach(() => {
      vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "");
      vi.stubEnv("MCP_CONNECT_IDLE_THRESHOLD", "");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

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
      priv.idleCallCounts.set("slack", resolveIdleThreshold() - 1);

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

      const baseline = resolveIdleThreshold();
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

    describe("profile header block", () => {
      it("names both sources when a project profile is layered over a user one", () => {
        const priv = getPrivate(server);
        priv.profile = {
          path: "/proj/.yaw-mcp/config.json",
          userPath: "/h/.yaw-mcp/config.json",
          servers: ["gh", "linear"],
          blocked: ["prod-db"],
        };

        const text = priv.handleHealth().content[0].text;
        expect(text).toContain("Project profile: /proj/.yaw-mcp/config.json");
        expect(text).toContain("User profile:    /h/.yaw-mcp/config.json");
        expect(text).toContain("allow: gh, linear");
        expect(text).toContain("block: prod-db");
      });

      it("falls back to the generic label when only one source loaded", () => {
        // `path` alone cannot say WHICH of the two it came from, so the
        // generic label is the honest one -- claiming "Project profile" for a
        // user-global file would send the operator editing the wrong file.
        const priv = getPrivate(server);
        priv.profile = { path: "/h/.yaw-mcp/config.json" };

        const text = priv.handleHealth().content[0].text;
        expect(text).toContain("Profile: /h/.yaw-mcp/config.json");
        expect(text).not.toContain("Project profile:");
        expect(text).not.toContain("User profile:");
        // Neither list is configured, so neither line is printed.
        expect(text).not.toContain("allow:");
        expect(text).not.toContain("block:");
      });

      it("prints no profile block at all when no profile is loaded", () => {
        const priv = getPrivate(server);
        priv.profile = null;

        const text = priv.handleHealth().content[0].text;
        expect(text).not.toContain("Profile:");
        expect(text).toContain("No servers loaded in this session");
      });
    });

    describe("cross-session reliability block", () => {
      it("surfaces a flaky dormant namespace from persisted learning", () => {
        const priv = getPrivate(server);
        priv.learning.loadSnapshot({
          flaky: { dispatched: 10, succeeded: 5, lastUsedAt: Date.now() - 60_000 },
        });

        const result = priv.handleHealth();
        const text = result.content[0].text;
        expect(text).toContain("Cross-session reliability (dormant, <80% success):");
        expect(text).toContain("flaky — 10 calls, 50% success, last used");
      });

      it("skips namespaces currently loaded (in-session block covers them)", () => {
        const priv = getPrivate(server);
        const conn = makeConnection("gh");
        conn.health = { totalCalls: 10, errorCount: 5, totalLatencyMs: 100 };
        priv.connections.set("gh", conn);
        priv.learning.loadSnapshot({
          gh: { dispatched: 10, succeeded: 5, lastUsedAt: Date.now() },
        });

        const result = priv.handleHealth();
        expect(result.content[0].text).not.toContain("Cross-session reliability");
      });

      it("skips namespaces with fewer than 3 dispatches", () => {
        const priv = getPrivate(server);
        priv.learning.loadSnapshot({
          rare: { dispatched: 2, succeeded: 0, lastUsedAt: Date.now() },
        });

        const result = priv.handleHealth();
        expect(result.content[0].text).not.toContain("Cross-session reliability");
      });

      it("skips namespaces at or above 80% success", () => {
        const priv = getPrivate(server);
        priv.learning.loadSnapshot({
          solid: { dispatched: 10, succeeded: 9, lastUsedAt: Date.now() },
          perfect: { dispatched: 5, succeeded: 5, lastUsedAt: Date.now() },
        });

        const result = priv.handleHealth();
        expect(result.content[0].text).not.toContain("Cross-session reliability");
      });

      it("sorts worst success rate first, then highest dispatched, then alpha", () => {
        const priv = getPrivate(server);
        priv.learning.loadSnapshot({
          zeta: { dispatched: 10, succeeded: 5, lastUsedAt: Date.now() },
          alpha: { dispatched: 20, succeeded: 10, lastUsedAt: Date.now() },
          worst: { dispatched: 5, succeeded: 1, lastUsedAt: Date.now() },
          // aaa/bbb tie with zeta on BOTH keys (50% of 10), so only the
          // third comparator can order them. Without a pair like this the
          // test's name overclaims: alpha (20) and zeta (10) already differ
          // on dispatched, so the alphabetical tiebreak never runs.
          bbb: { dispatched: 10, succeeded: 5, lastUsedAt: Date.now() },
          aaa: { dispatched: 10, succeeded: 5, lastUsedAt: Date.now() },
        });

        const result = priv.handleHealth();
        const text = result.content[0].text;
        const worstIdx = text.indexOf("worst ");
        const alphaIdx = text.indexOf("alpha ");
        const aaaIdx = text.indexOf("aaa ");
        const bbbIdx = text.indexOf("bbb ");
        const zetaIdx = text.indexOf("zeta ");
        expect(worstIdx).toBeGreaterThan(-1);
        // 20% beats every 50%.
        expect(worstIdx).toBeLessThan(alphaIdx);
        // Same rate, more dispatched.
        expect(alphaIdx).toBeLessThan(aaaIdx);
        // Same rate AND same dispatched -> alphabetical.
        expect(aaaIdx).toBeLessThan(bbbIdx);
        expect(bbbIdx).toBeLessThan(zetaIdx);
      });

      it("caps the list at 5 entries", () => {
        const priv = getPrivate(server);
        const snapshot: Record<string, { dispatched: number; succeeded: number; lastUsedAt: number }> = {};
        for (let i = 0; i < 8; i++) {
          snapshot[`ns${i}`] = { dispatched: 10, succeeded: 5, lastUsedAt: Date.now() };
        }
        priv.learning.loadSnapshot(snapshot);

        const result = priv.handleHealth();
        const text = result.content[0].text;
        const matches = text.match(/^ {2}ns\d+ — /gm) ?? [];
        expect(matches).toHaveLength(5);
      });

      it("stays silent when no dormant namespace qualifies", () => {
        const priv = getPrivate(server);
        const result = priv.handleHealth();
        expect(result.content[0].text).not.toContain("Cross-session reliability");
      });
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

    it("drops a peer the user has since removed from bundles.json", async () => {
      // Pack history is PERSISTED across restarts, so it still names servers
      // that are no longer installed. Printing one as `often loaded with
      // "gone"` points the model at something activate can no longer load --
      // and "gone" was the only peer here, so gh earns no usage line at all.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ id: "1", namespace: "gh", name: "GitHub" })]);
      const t0 = 1_000_000;
      priv.packDetector.recordCall("gh", "create_issue", t0);
      priv.packDetector.recordCall("gone", "do_thing", t0 + 1000);
      priv.packDetector.recordCall("gh", "create_issue", t0 + 300_000);
      priv.packDetector.recordCall("gone", "do_thing", t0 + 301_000);

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).not.toContain("gone");
      expect(result.content[0].text).not.toContain("usage:");
    });

    it("stays silent when neither signal has evidence", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).not.toContain("usage:");
    });

    it("surfaces a reliability warning for a flaky dormant server", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.learning.loadSnapshot({
        gh: { dispatched: 10, succeeded: 3, lastUsedAt: Date.now() },
      });

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).toContain("reliability: 30% success across 10 past calls");
    });

    it("suppresses the reliability warning for currently-loaded servers", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      priv.learning.loadSnapshot({
        gh: { dispatched: 10, succeeded: 3, lastUsedAt: Date.now() },
      });
      priv.connections.set("gh", makeConnection("gh"));

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      expect(result.content[0].text).not.toContain("reliability:");
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
      priv.connections.set("gh", makeConnection("gh"));
      priv.connections.set("linear", makeConnection("linear"));

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

    it("caps the block at 3 and orders by frequency desc, then recency", async () => {
      // Four distinct actionable packs. Frequencies 4 / 3 / 2 / 2 exercise
      // both comparators: {a1,a2} and {b1,b2} separate on frequency, while
      // {c1,c2} and {d1,d2} tie at 2 and can only be ordered by lastSeenAt --
      // and the cap then has to drop the OLDER of the two.
      const priv = getPrivate(server);
      priv.config = makeConfig(
        ["a1", "a2", "b1", "b2", "c1", "c2", "d1", "d2"].map((ns, i) =>
          makeServerConfig({ id: String(i + 1), namespace: ns, name: ns }),
        ),
      );
      // Bursts are 300s apart (> the 120s idle gap) so each is its own burst;
      // the two calls inside a burst are 1s apart (< the gap).
      const t0 = 1_000_000;
      const burst = (pair: [string, string], index: number): void => {
        const at = t0 + index * 300_000;
        priv.packDetector.recordCall(pair[0], "t", at);
        priv.packDetector.recordCall(pair[1], "t", at + 1000);
      };
      for (const i of [0, 1, 2, 3]) burst(["a1", "a2"], i);
      for (const i of [4, 5, 6]) burst(["b1", "b2"], i);
      for (const i of [7, 8]) burst(["c1", "c2"], i);
      for (const i of [9, 10]) burst(["d1", "d2"], i);

      const result = await priv.handleToolCall("mcp_connect_discover", {});
      const text = result.content[0].text;
      const packLines = text.split("\n").filter((l: string) => l.startsWith("  {"));
      expect(packLines).toHaveLength(3);
      expect(packLines[0]).toContain("{a1, a2} — seen 4x");
      expect(packLines[1]).toContain("{b1, b2} — seen 3x");
      // d is the more RECENT of the two 2x packs, so it takes the last slot...
      expect(packLines[2]).toContain("{d1, d2} — seen 2x");
      // ...and c is dropped by the cap.
      expect(text).not.toContain("{c1, c2}");
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

    it("cap refusal beside a successful load is informational (isError undefined)", async () => {
      // One namespace loads (filling the last cap slot), the next is
      // cap-refused. The call did useful work, so the cap message stays
      // informational -- only an all-refused call signals isError.
      const priv = getPrivate(server);
      priv.serverCap = 2;
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "a" }),
        makeServerConfig({ id: "2", namespace: "b" }),
        makeServerConfig({ id: "3", namespace: "c" }),
      ]);
      priv.connections.set("a", makeConnection("a"));
      vi.mocked(connectToUpstream).mockResolvedValue(makeConnection("b"));

      const result = await priv.handleActivate(["b", "c"]);
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Cannot load "c"');
      expect(priv.connections.has("b")).toBe(true);
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

    it("two distinct namespaces activating concurrently do not overshoot the cap", async () => {
      // TOCTOU guard: the existing cap tests pre-seed connections
      // synchronously, so they never exercise the pendingActivations
      // reservation. Here "a" is held mid-`await connectToUpstream` (its
      // connect promise stays pending), so its slot only exists as a
      // reservation in pendingActivations — not yet in this.connections.
      // With cap=1, "b" racing the check must see that reservation and be
      // refused. Without the pendingActivations counting in evaluateCapFor
      // (and the synchronous reservation runActivateOne takes before its
      // first await) both would pass the check against the same empty
      // connected set and connect, overshooting the cap.
      const priv = getPrivate(server);
      priv.serverCap = 1;
      priv.config = makeConfig([
        makeServerConfig({ id: "1", namespace: "a" }),
        makeServerConfig({ id: "2", namespace: "b" }),
      ]);

      // Hold "a"'s upstream connect open so its reservation sits in
      // pendingActivations while "b" races the cap check.
      let resolveA: (conn: UpstreamConnection) => void = () => {};
      const aPromise = new Promise<UpstreamConnection>((r) => {
        resolveA = r;
      });
      vi.mocked(connectToUpstream).mockReturnValueOnce(aPromise);

      const pA = priv.activateOne("a");
      // "a" reserved its slot synchronously — before the first await —
      // even though no connection exists in the map yet.
      expect(priv.pendingActivations.has("a")).toBe(true);
      expect(priv.connections.has("a")).toBe(false);

      // "b" races against a full cap (the pending reservation occupies the
      // single slot) and must be refused as capped.
      const rB = await priv.activateOne("b");
      expect(rB.ok).toBe(false);
      expect(rB.capped).toBe(true);
      // "b" never spawned an upstream — only "a"'s connect fired.
      expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
      expect(priv.connections.has("b")).toBe(false);

      // Let "a" finish; it claims the one and only slot.
      resolveA(makeConnection("a", ["t"]));
      const rA = await pA;
      expect(rA.ok).toBe(true);
      expect(priv.connections.has("a")).toBe(true);

      // Total connected never exceeded the cap of 1.
      const connectedCount = [...priv.connections.values()].filter(
        (c: UpstreamConnection) => c.status === "connected",
      ).length;
      expect(connectedCount).toBe(1);
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
      expect(result.content[0].text).toContain("is not in ~/.yaw-mcp/bundles.json");
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
      // NOT `totalLatencyMs >= 0`: the fixture starts at 0 and the counter is
      // only ever added to, so that assertion held whether or not anything was
      // booked. The error side of the same booking is what can actually move.
      expect(conn.health.errorCount).toBe(0);
      expect(conn.health.lastErrorMessage).toBeUndefined();
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
      expect(conn.health.totalCalls).toBe(1);
      expect(conn.health.errorCount).toBe(1);
      // Pin the TEXT, not just its presence: a booking that stored the wrong
      // error (a generic "call failed", or a previous call's message) still
      // satisfies toBeDefined().
      expect(conn.health.lastErrorMessage).toContain("upstream failed");
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
      // The structural brand is what keeps this fault out of the health /
      // learning booking -- pin it on the REAL result, not a typed string.
      expect(isRoutingFaultResult(result)).toBe(true);
    });

    it("returns error for unknown tools", async () => {
      const priv = getPrivate(server);
      const result = await priv.handleToolCall("nonexistent_tool", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool");
    });

    it("every routing-fault message is recognized by isRoutingFaultText", async () => {
      // What handleExec (and the direct path) actually attribute blame with is
      // the STRUCTURAL brand, isRoutingFaultResult -- not these marker strings;
      // isRoutingFaultText has no production caller left and this test is its
      // only invoker. The markers are still worth pinning as the documented
      // phrasing: two of the four messages are produced in proxy.ts, so a
      // reword there (out of server.ts's reach) drifts the docs away from the
      // text an operator greps for. Cases 1 and 2 assert the real emitted
      // result (brand AND text); cases 3 and 4 pass hand-typed literals, so
      // they only re-prove that those constants are in ROUTING_FAULT_MARKERS.
      const priv = getPrivate(server);

      // 1. Unknown tool (proxy.ts). Both the pinned text AND the
      // structural brand (the authoritative booking signal) must hold.
      const unknown = await priv.handleToolCall("nonexistent_tool", {});
      expect(unknown.content[0].text).toContain(ROUTING_FAULT_UNKNOWN_TOOL);
      expect(isRoutingFaultText(unknown.content[0].text)).toBe(true);
      expect(isRoutingFaultResult(unknown)).toBe(true);

      // 2. Route survives but the connection is gone (proxy.ts).
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.connections.set("gh", makeConnection("gh", ["create_issue"]));
      priv.rebuildRoutes();
      priv.connections.delete("gh");
      const gone = await priv.handleToolCall("gh_create_issue", {});
      expect(gone.content[0].text).toContain(ROUTING_FAULT_DISCONNECTED);
      expect(isRoutingFaultText(gone.content[0].text)).toBe(true);
      expect(isRoutingFaultResult(gone)).toBe(true);

      // 3. Auto-reconnect exhausted (server.ts) -- covered by the
      // "returns error when auto-reconnect fails" case above; assert the
      // marker predicate agrees with the phrasing it asserts.
      expect(isRoutingFaultText('Server "gh" disconnected and auto-reconnect failed: still down.')).toBe(true);

      // 4. Deferred first-call load failure (server.ts). An activation
      // result, which is deliberately never a learning signal -- without
      // this marker, an exec step landing on a deferred route whose load
      // fails (including a server-cap or compliance refusal) was booked
      // as a 0.0 outcome against a server that never got to run.
      expect(isRoutingFaultText('Server "gh" could not be loaded on first call: spawn failed.')).toBe(true);

      // Negative control: a genuine upstream failure is NOT a routing fault.
      expect(isRoutingFaultText("GITHUB_TOKEN is invalid")).toBe(false);
    });

    it("a routing-fault error on the direct path books no learning outcome or redispatch reply", async () => {
      // Reproduce the reaper/prewarm teardown window: the route snapshot
      // still resolves but the connection is gone, so routeToolCall
      // returns the ROUTING_FAULT_DISCONNECTED text. That is yaw-mcp's
      // own fault -- booking it as a 0.0 outcome (the old behavior) sank
      // a healthy server's reliability for a fault the ROUTING_FAULT_*
      // comment promises is never counted against it.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.connections.set("gh", makeConnection("gh", ["create_issue"]));
      priv.rebuildRoutes();
      priv.connections.delete("gh");
      const markReply = vi.spyOn(priv.redispatch, "markReply");
      const markUse = vi.spyOn(priv.redispatch, "markUse");
      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(ROUTING_FAULT_DISCONNECTED);
      expect(priv.learning.get("gh")).toBeUndefined();
      expect(markReply).not.toHaveBeenCalled();
      // Not graded, but still USAGE: markUse keeps a graded-clean record
      // from freezing into a detectMiss "loser" over yaw-mcp's own fault.
      expect(markUse).toHaveBeenCalledWith("gh");
    });

    it("a routing fault on a still-registered connection is a health NON-observation", async () => {
      // The connection is still in the map (status "error") but its config
      // entry is gone, so the reconnect branch is skipped and routeToolCall
      // returns the branded DISCONNECTED fault while connForHealth is
      // non-null. The fault must book NOTHING on health: not an error (the
      // original bug), and not a call either -- a call-without-error is a
      // success-shaped observation that dilutes a flaky server's error
      // rate and drags its latency toward 0ms.
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      priv.config = makeConfig([]);
      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(ROUTING_FAULT_DISCONNECTED);
      expect(isRoutingFaultResult(result)).toBe(true);
      expect(conn.health.totalCalls).toBe(0);
      expect(conn.health.errorCount).toBe(0);
      expect(conn.health.totalLatencyMs).toBe(0);
      expect(conn.health.lastErrorMessage).toBeUndefined();
    });

    it("tool-gone-after-activation carries the routing-fault brand", async () => {
      // A deferred route for a tool the (already-connected) upstream no
      // longer exposes: activation is a no-op, the rebuild drops the stale
      // route, and the TOOL_GONE fault is emitted. It is yaw-mcp's stale
      // cache, not the upstream's failure -- brand + no booking.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      priv.connections.set("gh", conn);
      priv.toolRoutes = new Map([
        ["gh_renamed_tool", { namespace: "gh", originalName: "renamed_tool", deferred: true }],
      ]);
      const result = await priv.handleToolCall("gh_renamed_tool", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("no longer available");
      // Only the brand is asserted here: this fault returns BEFORE the
      // direct-path booking block, so "no booking" is vacuous on the direct
      // path. Where the brand is load-bearing for an early-return fault is
      // exec's step attribution -- see the two exec tests below.
      expect(isRoutingFaultResult(result)).toBe(true);
    });

    it("exec step attribution skips a branded early-return fault (tool gone after activation)", async () => {
      // handleExec books its OWN outcome per step after handleToolCall
      // returns, so an early-return fault that never reaches the direct-path
      // booking block IS booked here unless the brand says otherwise. This
      // test fails only if the exec brand check is DROPPED outright -- every
      // branded fault's text also carries a marker phrase, so a revert to
      // the old text sniff ALSO skips booking here and passes. The
      // text-sniff revert is caught by the next test (an upstream error
      // that merely CONTAINS a marker phrase must still book); the two
      // tests are a pair and both must stay.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      priv.connections.set("gh", conn);
      priv.toolRoutes = new Map([
        ["gh_renamed_tool", { namespace: "gh", originalName: "renamed_tool", deferred: true }],
      ]);
      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [{ id: "a", tool: "gh_renamed_tool", args: {} }],
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(false);
      expect(parsed.failedStep).toBe("a");
      expect(parsed.error).toContain("no longer available");
      expect(priv.learning.get("gh")).toBeUndefined();
    });

    it("concurrent calls during auto-reconnect share ONE activation (no spurious error, no double spawn)", async () => {
      // The reconnect now routes through activateOne, whose in-flight dedup
      // is the guarantee the old inline connectToUpstream path lacked: two
      // tool calls landing on an error-state upstream used to each spawn a
      // child (or, in production, the second got a spurious "no longer
      // connected" error while yaw-mcp was itself mid-reconnect).
      const priv = getPrivate(server);
      const errorConn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", errorConn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      let release!: (c: ReturnType<typeof makeConnection>) => void;
      const gate = new Promise<ReturnType<typeof makeConnection>>((r) => {
        release = r;
      });
      const fresh = makeConnection("gh", ["create_issue"]);
      fresh.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      vi.mocked(connectToUpstream).mockImplementation(() => gate as never);
      // The disconnect mock mirrors PRODUCTION by default now (see the
      // vi.mock factory at the top of this file): upstream.ts flips the status
      // synchronously before awaiting close, and with the old
      // disconnect-first ordering that flip made every concurrent caller skip
      // the reconnect branch and take a spurious "no longer connected" fault.
      const refresh = vi.spyOn(priv, "refreshRoutesAndNotify");
      const p1 = priv.handleToolCall("gh_create_issue", {});
      const p2 = priv.handleToolCall("gh_create_issue", {});
      // Wait for the STATE, not a stopwatch: both callers have reached the
      // reconnect await exactly once the shared spawn has been issued. Then
      // fire a THIRD caller mid-spawn -- the stale entry must still read
      // status "error" (the disconnect happens after activation), so it joins
      // the shared inflight instead of erroring.
      await until(() => vi.mocked(connectToUpstream).mock.calls.length === 1);
      const p3 = priv.handleToolCall("gh_create_issue", {});
      // One macrotask turn so p3 gets to the same await before the spawn
      // resolves. A zero-delay tick, not a 20ms guess.
      await new Promise((r) => setTimeout(r, 0));
      release(fresh);
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
      expect(r3.isError).toBeFalsy();
      expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
      // The orphaned stale transport was closed (idempotently -- each
      // caller's identity check sees the map already holds the fresh conn).
      expect(vi.mocked(disconnectFromUpstream)).toHaveBeenCalledWith(errorConn);
      // And the live connection was never closed.
      expect(vi.mocked(disconnectFromUpstream)).not.toHaveBeenCalledWith(fresh);
      // ONE routes rebuild serves all sharers: rebuilding per sharer
      // emitted N x three list_changed notifications for one reconnect.
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("an activate landing in a teardown window (status disconnected) gets no cap self-allowance", async () => {
      // "disconnected" only exists mid-teardown (prewarm teardown, idle
      // reaper, deactivate all flip it and then await the close before
      // deleting the map entry): the slot is being RELEASED, so an
      // activate in that window must queue behind the cap like a fresh
      // activation. Only an "error" entry -- a granted slot whose
      // transport died -- rides the self-allowance (see the reconnect-at-
      // full-cap test).
      const priv = getPrivate(server);
      priv.serverCap = 1;
      priv.connections.set("busy", makeConnection("busy", ["t"])); // holds the only slot
      const tearingDown = makeConnection("gh", ["create_issue"]);
      tearingDown.status = "disconnected" as never;
      priv.connections.set("gh", tearingDown);
      priv.config = makeConfig([makeServerConfig({ namespace: "busy" }), makeServerConfig({ namespace: "gh" })]);
      const result = await priv.activateOne("gh");
      expect(result.ok).toBe(false);
      expect(result.capped).toBe(true);
      expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    });

    it("auto-reconnect succeeds at a FULL cap (the namespace already owns its slot)", async () => {
      // A dead connection represents a slot that was already granted:
      // refusing the respawn at a full cap would strand a legitimately
      // loaded server in its error state, with a refusal message pointing
      // at mcp_connect_activate -- which would refuse identically.
      const priv = getPrivate(server);
      priv.serverCap = 2;
      priv.connections.set("other", makeConnection("other", ["t"]));
      const errorConn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", errorConn);
      priv.config = makeConfig([makeServerConfig({ namespace: "other" }), makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      const fresh = makeConnection("gh", ["create_issue"]);
      fresh.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      vi.mocked(connectToUpstream).mockResolvedValueOnce(fresh);
      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("ok");
    });

    it("auto-reconnect refuses after shutdown has latched (no spawn)", async () => {
      // The old inline path ignored the shuttingDown latch; through
      // activateOne a reconnect during shutdown is refused before any
      // child is spawned into the torn-down bookkeeping.
      const priv = getPrivate(server);
      const errorConn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", errorConn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      priv.shuttingDown = true;
      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("auto-reconnect failed");
      expect(isRoutingFaultResult(result)).toBe(true);
      expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    });

    it("a non-string discover context is ignored instead of throwing", async () => {
      // The low-level Server never validates input against inputSchema, so
      // a misbehaving client can send context: 123. It must degrade to an
      // unranked discover, not a TypeError inside the BM25 tokenizer
      // surfacing as a raw JSON-RPC internal error.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      const result = await priv.handleToolCall("mcp_connect_discover", { context: 123 });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain("gh");
    });

    it("tool-gone-after-RECONNECT carries the routing-fault brand", async () => {
      // The fifth emitter: auto-reconnect SUCCEEDS but the fresh upstream
      // no longer exposes the requested tool ("no longer available after
      // reconnecting"). Removing brandRoutingFault from that emitter left
      // the whole suite green -- this pins it on the real result.
      const priv = getPrivate(server);
      const errorConn = makeConnection("gh", ["create_issue"], "error");
      priv.connections.set("gh", errorConn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["other_tool"]));
      const result = await priv.handleToolCall("gh_create_issue", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("after reconnecting");
      expect(isRoutingFaultResult(result)).toBe(true);
      expect(priv.learning.get("gh")).toBeUndefined();
    });

    it("exec step attribution still books an upstream error that merely CONTAINS a marker phrase", async () => {
      // The exec counterpart of the direct-path brand test: a genuine
      // upstream error whose text includes "no longer available" carries no
      // brand, so the step is the server's own failure and books 0.0.
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["get_resource"]);
      conn.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "This resource is no longer available (deleted by owner)." }],
        isError: true,
      });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [{ id: "a", tool: "gh_get_resource", args: {} }],
      });
      expect(result.isError).toBe(true);
      expect(priv.learning.get("gh")).toMatchObject({ dispatched: 1, succeeded: 0 });
    });

    it("an upstream error that merely CONTAINS a marker phrase is still booked (brand, not text)", async () => {
      // The routing-fault guard is structural: only results yaw-mcp's own
      // routing layer constructed carry the brand. A genuine upstream
      // error whose text happens to include "no longer available" must
      // still count against the upstream's health and learning -- a text
      // sniff here would let real failures accumulate invisibly.
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["get_resource"]);
      conn.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "This resource is no longer available (deleted by owner)." }],
        isError: true,
      });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      const markReply = vi.spyOn(priv.redispatch, "markReply");
      const result = await priv.handleToolCall("gh_get_resource", {});
      expect(result.isError).toBe(true);
      expect(isRoutingFaultResult(result)).toBe(false);
      expect(priv.learning.get("gh")).toMatchObject({ dispatched: 1, succeeded: 0 });
      expect(conn.health.errorCount).toBe(1);
      expect(markReply).toHaveBeenCalledWith("gh", false);
    });

    it("exec steps mark redispatch replies on the dispatched namespace", async () => {
      // markReply must run OUTSIDE the deferLearning guard: exec steps are
      // real usage even though their learning credit is attributed per
      // step by handleExec. When they were skipped, a direct-call-then-
      // exec sequence left the namespace's dispatch record frozen as
      // cleanReply-without-furtherUse, and detectMiss flagged the server
      // as an abandoned "loser" on the next similar dispatch.
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "created #1" }] });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();
      const markReply = vi.spyOn(priv.redispatch, "markReply");
      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [{ id: "a", tool: "gh_create_issue", args: {} }],
      });
      expect(result.isError).toBeFalsy();
      expect(markReply).toHaveBeenCalledWith("gh", true);
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
      // Activation is never a learning signal: the deferred-load failure
      // must carry the routing-fault brand so exec's step attribution and
      // the direct-path booking both skip it.
      expect(isRoutingFaultResult(result)).toBe(true);
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

    it("records each successful proxied tool call as dispatched + succeeded in learning", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      await priv.handleToolCall("gh_create_issue", {});
      await priv.handleToolCall("gh_create_issue", {});
      const usage = priv.learning.get("gh");
      expect(usage?.dispatched).toBe(2);
      expect(usage?.succeeded).toBe(2);
    });

    it("counts upstream isError responses toward dispatched but NOT succeeded", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["create_issue"]);
      // Upstream returns a structured error response (not a transport
      // throw) — isError: true is the upstream's own assessment.
      conn.client.callTool = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "validation failed" }],
        isError: true,
      });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      await priv.handleToolCall("gh_create_issue", {});
      const usage = priv.learning.get("gh");
      expect(usage?.dispatched).toBe(1);
      expect(usage?.succeeded).toBe(0);
    });

    it("does not record activation alone as a learning signal", async () => {
      // handleDispatch activates a winner; previously that incremented
      // both dispatched and succeeded, masking flaky tool-call paths.
      // Tool-call success is now the only learning input.
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      const conn = makeConnection("gh", ["create_issue"]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(conn);

      const result = await priv.handleDispatch("github issue", 1);
      // Prove the activation HAPPENED first: "learning.get is undefined" is
      // also the untouched initial state, so without these the test would
      // pass on a dispatch that ranked nothing and activated nothing.
      expect(result.isError).toBeUndefined();
      expect(connectToUpstream).toHaveBeenCalledTimes(1);
      expect(priv.connections.get("gh")).toBe(conn);
      expect(priv.learning.get("gh")).toBeUndefined();
    });

    it("dispatch records loaded namespaces in sessionActivated so gateway mode advertises them", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

      expect(priv.sessionActivated.has("gh")).toBe(false);
      await priv.handleDispatch("github issue", 1);
      // Without this, the tools/list_changed dispatch fires changes nothing
      // under the default gateway exposure: the loaded tools stay
      // unadvertised, and the response's "tools are now callable" promise
      // is false for any client that can only invoke advertised tools.
      expect(priv.sessionActivated.has("gh")).toBe(true);
    });

    it("dispatch does NOT record a namespace whose activation failed", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      // Persistent rejection: runActivateOne retries once, and a ...Once mock
      // would hand the retry whatever the module mock resolves to (undefined,
      // now that the file-level beforeEach resets implementations between
      // tests) rather than a second failure.
      vi.mocked(connectToUpstream).mockRejectedValue(new Error("spawn ENOENT"));

      await withoutRetryBackoff(() => priv.handleDispatch("github issue", 1));
      // Success-only, mirroring handleActivate.
      expect(priv.sessionActivated.has("gh")).toBe(false);
    });

    it("discover auto-warm records the warmed namespace in sessionActivated", async () => {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
      // Rank decisively so the auto-warm gate fires without depending on
      // BM25 scoring internals.
      vi.spyOn(priv, "twoStageRank").mockResolvedValue([{ namespace: "gh", score: 5 }]);
      vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

      await priv.handleDiscoverWithAutoWarm("github issue");
      // Auto-warm exists so a one-shot discover(context) is enough to
      // start calling tools -- which requires the warmed namespace to be
      // advertised under the default gateway exposure.
      expect(priv.sessionActivated.has("gh")).toBe(true);
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
      expect(text).toContain('activate: mcp_connect_activate({ servers: ["github","linear"] })');
      expect(text).toContain("Bundles partially installed:");
      expect(text).toContain("devops-incident");
      expect(text).toContain("missing: pagerduty");
      expect(text).toContain("yaw-mcp add ");
    });

    it("routes meta-tool exec through a two-step pipeline with $ref binding", async () => {
      // Exec threads the first tool's parsed output into the second
      // tool's args via {"$ref": "first"}. After fix #2 the step binding
      // holds the PARSED payload, not the raw MCP wrapper -- so a single-
      // text-item response whose text is a plain string binds as that
      // string directly, not as {content:[{type,text}]}.
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
            // After parseStepPayload: "first" is the string "42", not the
            // MCP wrapper. Ref directly to the step id.
            args: { number: { $ref: "first" } },
          },
        ],
        return: "second",
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      // "second" step output: single text item -> parsed as string.
      expect(parsed.result).toBe("PR #42 body");
      // Both steps should have landed in the output map.
      expect(Object.keys(parsed.steps).sort()).toEqual(["first", "second"]);
      // The second upstream call must have received the resolved value,
      // not the raw $ref marker -- otherwise the resolver never fired.
      // "42" parses as the number 42 via JSON.parse, so number (not string).
      // Params only -- routeToolCall's result-schema and request-options slots
      // are proxy.test.ts's contract, not this pipeline test's.
      expect(callTool.mock.calls[1][0]).toEqual({
        name: "get_pr",
        arguments: { number: 42 },
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
      // After fix #2 the binding holds the parsed payload (string), not
      // the MCP wrapper.
      expect(parsed.partial.first).toBe("ok step 1");
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

    it("fix#1: return can point to a positional-index key for unnamed steps", async () => {
      // validateExecRequest was only tracking explicit ids in seenIds, so
      // `return: "0"` for a step without an `id` always failed with
      // "unknown step id". The fix adds String(i) to allBindingKeys for
      // unnamed steps.
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["list_prs"]);
      conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "result" }] });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      // No `id` on the step; `return: "0"` uses the positional key.
      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [{ tool: "gh_list_prs", args: {} }],
        return: "0",
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
    });

    it("fix#2: parseStepPayload -- JSON text binds as parsed value", async () => {
      // When the upstream returns a single text item whose text is valid
      // JSON, the binding should hold the parsed object, not the wrapper.
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["list_prs", "get_pr"]);
      conn.client.callTool = vi
        .fn()
        .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify([{ number: 7 }]) }] })
        .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ title: "bug fix" }) }] });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [
          { id: "list", tool: "gh_list_prs", args: {} },
          { id: "get", tool: "gh_get_pr", args: { number: { $ref: "list[0].number" } } },
        ],
        return: "get",
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
      // The parsed object from the second call.
      expect(parsed.result).toEqual({ title: "bug fix" });
      // The upstream received the resolved number from the first step. Params
      // only, for the reason the sibling $ref test above gives.
      expect(vi.mocked(conn.client.callTool).mock.calls[1][0]).toEqual({
        name: "get_pr",
        arguments: { number: 7 },
      });
    });

    it("fix#2: parseStepPayload -- non-JSON text binds as string", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["list_prs"]);
      conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "plain text" }] });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [{ id: "a", tool: "gh_list_prs", args: {} }],
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.steps.a).toBe("plain text");
    });

    it("fix#2: parseStepPayload -- multi-content result binds as content array", async () => {
      const priv = getPrivate(server);
      const conn = makeConnection("gh", ["list_prs"]);
      conn.client.callTool = vi.fn().mockResolvedValue({
        content: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
      });
      priv.connections.set("gh", conn);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      priv.rebuildRoutes();

      const result = await priv.handleToolCall("mcp_connect_exec", {
        steps: [{ id: "a", tool: "gh_list_prs", args: {} }],
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(Array.isArray(parsed.steps.a)).toBe(true);
      expect(parsed.steps.a).toHaveLength(2);
    });
  });

  describe("shutdown", () => {
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

// ─────────────────────────────────────────────────────────────────────────
// Concurrency and atomicity regression tests. These cover the races
// exposed by the review:
//   1. activateOne — two concurrent callers for the same namespace must
//      share one spawn, not race to double-spawn.
//   2. handleToolCall — the routes map captured at method entry must be
//      used for the actual call, even if rebuildRoutes fires during
//      the auto-reconnect awaits.
// ─────────────────────────────────────────────────────────────────────────
describe("activateOne dedup", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
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

    const r1 = await withoutRetryBackoff(() => priv.activateOne("gh"));
    expect(r1.ok).toBe(false);
    expect(priv.activationInflight.has("gh")).toBe(false);

    // Second call should retry, not return the failed promise from #1.
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["x"]));
    const r2 = await priv.activateOne("gh");
    expect(r2.ok).toBe(true);
  });
});

describe("exec step-level split-blame attribution", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("splits blame when a $ref-consuming step fails with a validation error", async () => {
    // A two-step pipeline across DISTINCT namespaces: producer "prod"
    // succeeds and feeds its output into consumer "cons" via {$ref:"p"}.
    // "cons" then fails with an input-shaped (validation) error. The
    // split-blame logic in handleExec's step-attribution block (the
    // `inputShaped && deps.length > 0` arm in server.ts) must:
    //   - leave the producer's dispatch count at 1 (it already booked its
    //     own dispatch on success) and only DOCK its earned credit by 0.5
    //     via delta-only adjustSucceeded — NOT re-book a fresh dispatch.
    //   - book the failing consumer its own half-credit recordOutcome(0.5).
    // A revert of the producer line to recordOutcome(depNs, 0.5) would
    // push prod.dispatched to 2 (and succeeded to 1.5), failing the
    // assertions below.
    const priv = getPrivate(server);

    const prodConn = makeConnection("prod", ["make"]);
    // Plain non-JSON, non-error-shaped success -> computeOutcomeReward 1.0.
    prodConn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "prod-ok" }] });

    const consConn = makeConnection("cons", ["use"]);
    // Upstream self-validation failure: structured isError body carrying
    // the -32602 code, so classifyError -> validation_error (inputShaped).
    consConn.client.callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "MCP error -32602: Input validation error" }],
      isError: true,
    });

    priv.connections.set("prod", prodConn);
    priv.connections.set("cons", consConn);
    priv.config = makeConfig([makeServerConfig({ namespace: "prod" }), makeServerConfig({ namespace: "cons" })]);
    priv.rebuildRoutes();

    const result = await priv.handleToolCall("mcp_connect_exec", {
      steps: [
        { id: "p", tool: "prod_make", args: {} },
        { id: "c", tool: "cons_use", args: { x: { $ref: "p" } } },
      ],
      return: "c",
    });

    // The pipeline fails on the consumer step and surfaces the error.
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.failedStep).toBe("c");
    expect(parsed.error).toContain("-32602");

    // Producer: dispatch booked ONCE on its success, credit docked 0.5 by
    // the delta-only adjustSucceeded. A recordOutcome revert would make
    // dispatched=2 / succeeded=1.5 and fail here.
    const prod = priv.learning.get("prod");
    expect(prod?.dispatched).toBe(1);
    expect(prod?.succeeded).toBeCloseTo(0.5, 5);

    // Consumer: booked its own fresh half-credit dispatch.
    const cons = priv.learning.get("cons");
    expect(cons?.dispatched).toBe(1);
    expect(cons?.succeeded).toBeCloseTo(0.5, 5);
  });

  it("splits blame on the TRANSPORT-level [code=-32602] arm too", async () => {
    // inputShaped is a disjunction: the case above covers the structured
    // isError body that classifyError reads as validation_error. This covers
    // the OTHER arm -- callTool THROWS a JSON-RPC error carrying code -32602,
    // and proxy.ts renders it as a "[code=-32602]" tag in the error text.
    //
    // The message is deliberately one classifyError does NOT read as a
    // validation_error: it names an argument called `timeout`, unquoted, so
    // classifyError's timeout check (which runs FIRST) preempts the -32602
    // branch and returns "timeout". That leaves the code tag as the ONLY
    // signal that this was bad input -- which is exactly the arm under test.
    // With a plain "Invalid arguments" message the other disjunct also fires
    // and deleting the tag check keeps this test green.
    const priv = getPrivate(server);

    const prodConn = makeConnection("prod", ["make"]);
    prodConn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "prod-ok" }] });

    const consConn = makeConnection("cons", ["use"]);
    consConn.client.callTool = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("timeout must be a positive integer"), { code: -32602 }));

    priv.connections.set("prod", prodConn);
    priv.connections.set("cons", consConn);
    priv.config = makeConfig([makeServerConfig({ namespace: "prod" }), makeServerConfig({ namespace: "cons" })]);
    priv.rebuildRoutes();

    const result = await priv.handleToolCall("mcp_connect_exec", {
      steps: [
        { id: "p", tool: "prod_make", args: {} },
        { id: "c", tool: "cons_use", args: { x: { $ref: "p" } } },
      ],
      return: "c",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.failedStep).toBe("c");
    expect(parsed.error).toContain("[code=-32602]");

    // Same split as the structured-body case: producer docked, consumer
    // booked at half credit. A regression that only recognised the
    // classifyError arm would full-blame the consumer (succeeded 0) here.
    const prod = priv.learning.get("prod");
    expect(prod?.dispatched).toBe(1);
    expect(prod?.succeeded).toBeCloseTo(0.5, 5);
    const cons = priv.learning.get("cons");
    expect(cons?.dispatched).toBe(1);
    expect(cons?.succeeded).toBeCloseTo(0.5, 5);
  });
});

describe("handleToolCall route snapshot", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("survives a toolRoutes swap during the reconnect await", async () => {
    // Named for what actually recovers here. The entry snapshot is NOT it:
    // the reconnect branch re-snapshots (`routes = this.toolRoutes; route =
    // routes.get(name)`) after its own rebuild, so this test would stay green
    // even if routeToolCall read this.toolRoutes directly. What it pins is
    // that the post-reconnect rebuild repopulates the table an unrelated
    // rebuild emptied mid-await, instead of dead-ending on "Unknown tool".
    const priv = getPrivate(server);
    const errorConn = makeConnection("gh", ["create_issue"], "error");
    priv.connections.set("gh", errorConn);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    priv.rebuildRoutes();

    const freshConn = makeConnection("gh", ["create_issue"]);
    freshConn.client.callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok after reconnect" }],
    });

    // Simulate an unrelated rebuild swapping this.toolRoutes during the
    // reconnect await.
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
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("lists no builtins when no guide is loaded", () => {
    const priv = getPrivate(server);
    priv.guides = { user: null, project: null };
    expect(priv.getBuiltinResources()).toEqual([]);
  });

  it("surfaces yaw-mcp://guide when either guide is present", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u" },
      project: null,
    };
    const builtins = priv.getBuiltinResources();
    expect(builtins.length).toBe(1);
    expect(builtins[0].uri).toBe("yaw-mcp://guide");
    expect(builtins[0].mimeType).toBe("text/markdown");
    expect(builtins[0].name).toBe("yaw-mcp guide");
  });

  it("builtin read() returns the rendered body and flips guideRead", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u-body" },
      project: { scope: "project", path: "/p/.yaw-mcp/YAW-MCP.md", content: "p-body" },
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
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u" },
      project: null,
    };
    const map = priv.getBuiltinResourceMap();
    expect(map.size).toBe(1);
    expect(map.get("yaw-mcp://guide")?.uri).toBe("yaw-mcp://guide");
  });

  it("attaches a one-shot guide nudge to meta-tool responses when guide is loaded but unread", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u" },
      project: null,
    };
    const res1 = priv.attachGuideNudge({ content: [{ type: "text", text: "discover-body" }] });
    // The nudge rides as its OWN content block — the original body stays
    // byte-identical (exec/secrets return JSON.stringify text that must
    // survive JSON.parse).
    expect(res1.content[0].text).toBe("discover-body");
    expect(res1.content).toHaveLength(2);
    expect(res1.content[1].text).toContain("yaw-mcp://guide");
    expect(res1.content[1].text).toContain("/h/.yaw-mcp/YAW-MCP.md");
    // One-shot: a second call does NOT add the nudge again.
    const res2 = priv.attachGuideNudge({ content: [{ type: "text", text: "second-body" }] });
    expect(res2.content).toHaveLength(1);
    expect(res2.content[0].text).toBe("second-body");
  });

  it("keeps a JSON body parseable when the nudge fires (exec/secrets contract)", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u" },
      project: null,
    };
    const body = JSON.stringify({ ok: true, result: { hits: 3 }, steps: [] });
    const res = priv.attachGuideNudge({ content: [{ type: "text", text: body }] });
    expect(res.content).toHaveLength(2);
    // The documented payload block still parses — the nudge did not append
    // trailing prose to it.
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true, result: { hits: 3 }, steps: [] });
    expect(res.content[1].text).toContain("yaw-mcp://guide");
  });

  it("does not bake the one-shot nudge into the cached discover result", async () => {
    // attachGuideNudge used to mutate result.content in place. The object
    // it received from buildDiscoverOutput is the SAME object stored in
    // discoverCache, so the once-per-session hint got replayed on every
    // cache hit for the rest of the 3s TTL.
    const priv = getPrivate(server);
    priv.config = { servers: [], configVersion: "v1" };
    priv.guides = {
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u" },
      project: null,
    };

    const first = await priv.handleToolCall("mcp_connect_discover", {});
    expect(first.content).toHaveLength(2);
    expect(first.content[1].text).toContain("yaw-mcp://guide");

    // Second call inside the cache TTL: same body, no nudge block.
    const second = await priv.handleToolCall("mcp_connect_discover", {});
    expect(second.content).toHaveLength(1);
    expect(second.content[0].text).not.toContain("yaw-mcp://guide");
    // ...and the cache itself is still clean.
    expect(priv.discoverCache.result.content).toHaveLength(1);
    expect(priv.discoverCache.result.content[0].text).not.toContain("yaw-mcp://guide");
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
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u" },
      project: null,
    };
    priv.guideRead = true;
    const res = priv.attachGuideNudge({ content: [{ type: "text", text: "body" }] });
    expect(res.content[0].text).toBe("body");
  });

  it("reading the guide via the builtin flips guideRead and suppresses the nudge", () => {
    const priv = getPrivate(server);
    priv.guides = {
      user: { scope: "user", path: "/h/.yaw-mcp/YAW-MCP.md", content: "u" },
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

describe("resources/templates/list", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("registers a handler so a probing client gets an empty list, not -32601", async () => {
    // The constructor declares the resources capability, which implies
    // resources/templates/list; the SDK ships no default handler, so
    // without an explicit registration a probe errors with Method not
    // found. Empty is honest today: buildResourceRoutes only ever sees
    // concrete conn.resources, so a templated URI could not be read
    // through the proxy anyway.
    //
    // Driven through a REAL client over a linked in-memory transport rather
    // than reaching into the SDK's private _requestHandlers map: the point of
    // the test is that a probing client does not get -32601, and a rename of
    // that internal field is not a behaviour change.
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const priv = getPrivate(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await priv.server.connect(serverTransport);
    const client = new Client({ name: "templates-probe", version: "0" });
    try {
      await client.connect(clientTransport);
      await expect(client.listResourceTemplates()).resolves.toEqual({ resourceTemplates: [] });
    } finally {
      await client.close();
    }
  });
});

describe("prewarmDormantServers", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  // "caches", not "persists": nothing is written to disk in unit tests --
  // persistenceReady stays false without start(), so scheduleStateSave no-ops
  // and the only thing this can (and does) assert is the in-memory toolCache.
  it("activates dormant servers, caches their tools in memory, and disconnects", async () => {
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

  it("is exempt from the server cap in BOTH directions", async () => {
    // The cap bounds the LLM's context; prewarm contributes nothing to it
    // (never advertised, torn down within milliseconds). So (a) a prewarm
    // activation must not be refused by a full cap -- the refusal was
    // SILENT and left the namespace invisible in tools/list all session --
    // and (b) a prewarm-claimed connection must not occupy a slot that
    // refuses a concurrent real activation (the startup race with
    // autoLoadRecurringPack).
    const priv = getPrivate(server);
    priv.serverCap = 1;
    // (a) One real connected server holds the only slot; prewarm still runs.
    priv.connections.set("busy", makeConnection("busy", ["t"]));
    priv.config = makeConfig([makeServerConfig({ namespace: "busy" }), makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]),
    );
    await priv.prewarmDormantServers();
    expect(priv.toolCache.get("gh")).toEqual([{ name: "gh_tool", description: undefined }]);

    // (b) A prewarm-claimed connection does not block a real activation.
    priv.connections.delete("busy");
    priv.connections.set("warm", makeConnection("warm", ["t"]));
    priv.prewarmNamespaces.add("warm");
    priv.config = makeConfig([makeServerConfig({ namespace: "warm" }), makeServerConfig({ namespace: "slack" })]);
    const result = await priv.activateOne("slack");
    expect(result.ok).toBe(true);
    expect(result.capped).toBeUndefined();
  });

  it("an explicit claim of an in-flight prewarm activation is cap-checked (no bypass)", async () => {
    // The prewarm activation itself skips the cap (it never advertises
    // tools) -- but an explicit activate that CLAIMS it converts the
    // connection into a real, advertised one, so the claim must pass the
    // cap a fresh activation would. On refusal the prewarm claim is
    // restored so prewarm's teardown proceeds normally.
    const priv = getPrivate(server);
    priv.serverCap = 1;
    priv.connections.set("busy", makeConnection("busy", ["t"])); // holds the only slot
    priv.config = makeConfig([makeServerConfig({ namespace: "busy" }), makeServerConfig({ namespace: "gh" })]);
    let release!: (c: ReturnType<typeof makeConnection>) => void;
    const gate = new Promise<ReturnType<typeof makeConnection>>((r) => {
      release = r;
    });
    vi.mocked(connectToUpstream).mockImplementation(() => gate as never);
    // Prewarm starts activating "gh" (cap skipped) and stalls mid-spawn.
    const prewarmP = priv.activateOne("gh", undefined, /* fromPrewarm */ true);
    // An explicit activate lands while the prewarm spawn is in flight.
    const claim = await priv.activateOne("gh");
    expect(claim.ok).toBe(false);
    expect(claim.capped).toBe(true);
    // The claim was refused, so the prewarm claim is back in place and the
    // prewarm teardown still owns the connection.
    expect(priv.prewarmNamespaces.has("gh")).toBe(true);
    release(makeConnection("gh", ["t"]));
    await prewarmP;
  });

  it("a prewarm activation that elicits credentials keeps its cap exemption on the retry", async () => {
    // maybeElicitAndRetry re-enters runActivateOne; dropping fromPrewarm
    // there re-ran the cap check prewarm is exempt from, so a prewarm spawn
    // that elicited credentials could be refused at a full cap -- and the
    // namespace stayed invisible in tools/list, the exact UX the exemption
    // exists to prevent.
    const priv = getPrivate(server);
    priv.serverCap = 1;
    priv.connections.set("busy", makeConnection("busy", ["t"])); // cap full
    priv.config = makeConfig([makeServerConfig({ namespace: "busy" }), makeServerConfig({ namespace: "gh" })]);
    // First spawn fails naming a missing credential; the elicited retry
    // succeeds. Elicitation needs the client capability + a bridge answer.
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    priv.server.elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { GITHUB_TOKEN: "ghp_x" },
    });
    vi.mocked(connectToUpstream)
      .mockRejectedValueOnce(new Error("GITHUB_TOKEN is required"))
      .mockRejectedValueOnce(new Error("GITHUB_TOKEN is required"))
      .mockImplementationOnce(async (cfg: UpstreamServerConfig) => makeConnection(cfg.namespace, ["t"]));
    const result = await withoutRetryBackoff(() => priv.activateOne("gh", undefined, /* fromPrewarm */ true));
    expect(result.ok).toBe(true);
    // Pin the SHAPE, not just the outcome: two failed attempts plus exactly
    // one elicited retry. Without these, a path that simply succeeded on some
    // other attempt would satisfy the assertions below and the "the ELICITED
    // retry stayed cap-exempt" claim would be inferred rather than proved.
    expect(connectToUpstream).toHaveBeenCalledTimes(3);
    expect(priv.server.elicitInput).toHaveBeenCalledTimes(1);
    // The retry ran cap-exempt: toolCache learned, namespace visible.
    expect(priv.toolCache.get("gh")).toBeDefined();
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

  it("re-warms a server whose learned toolCache is older than the refresh window", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub" })],
    };
    // Learned in a prior session, 8 days ago -- past the 7-day refresh
    // window. Installs resolve @latest, so the upstream may have renamed
    // tools since; hasKnownTools alone would keep skipping this server
    // until the 30-day persistence TTL finally dropped the entry.
    priv.toolCache.set("gh", [{ name: "renamed_away" }]);
    priv.toolCacheLearnedAt.set("gh", Date.now() - 8 * 24 * 60 * 60 * 1000);
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]),
    );

    await priv.prewarmDormantServers();

    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    // The stale list was replaced and re-stamped.
    expect(priv.toolCache.get("gh")).toEqual([{ name: "gh_tool", description: undefined }]);
    expect(Date.now() - priv.toolCacheLearnedAt.get("gh")).toBeLessThan(60_000);
  });

  it("does not re-warm a fresh learned list or a curated bundles.json toolCache", async () => {
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [
        makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub" }),
        makeServerConfig({
          id: "slack-id",
          namespace: "slack",
          name: "Slack",
          toolCache: [{ name: "post_message" }],
        }),
      ],
    };
    // gh: learned yesterday -- inside the refresh window.
    priv.toolCache.set("gh", [{ name: "list_issues" }]);
    priv.toolCacheLearnedAt.set("gh", Date.now() - 24 * 60 * 60 * 1000);
    // slack: curated bundles.json cache only -- carries no learnedAt and is
    // never refreshed here (that would reintroduce the per-session
    // `npx -y <pkg>@latest` resolve pre-warm exists to avoid).

    await priv.prewarmDormantServers();

    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
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

    await withoutRetryBackoff(() => priv.prewarmDormantServers());

    // "ok" still populated its cache even though "broken" threw.
    expect(priv.toolCache.get("ok")).toEqual([{ name: "ok_tool", description: undefined }]);
    expect(priv.toolCache.get("broken")).toBeUndefined();
    expect(priv.connections.size).toBe(0);
  });
});

describe("isAutoActivateEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults ON when unset or empty, and honors an explicit disable", () => {
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "");
    expect(isAutoActivateEnabled()).toBe(true);
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "0");
    expect(isAutoActivateEnabled()).toBe(false);
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "false");
    expect(isAutoActivateEnabled()).toBe(false);
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "true");
    expect(isAutoActivateEnabled()).toBe(true);
  });

  it("trims the value -- `set YAW_MCP_AUTO_ACTIVATE=1 && ...` from cmd.exe stores '1 '", () => {
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "1 ");
    expect(isAutoActivateEnabled()).toBe(true);
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "0 ");
    expect(isAutoActivateEnabled()).toBe(false);
    // Whitespace-only reads as unset -> default ON.
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "  ");
    expect(isAutoActivateEnabled()).toBe(true);
  });
});

describe("auto-load on startup", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.shutdown();
  });

  it("is disabled by default when YAW_MCP_AUTO_LOAD is unset", () => {
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "");
    expect(isAutoLoadEnabled()).toBe(false);
  });

  it("accepts '1' and 'true' but not other values", () => {
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "1");
    expect(isAutoLoadEnabled()).toBe(true);
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "true");
    expect(isAutoLoadEnabled()).toBe(true);
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "TRUE");
    expect(isAutoLoadEnabled()).toBe(true);
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "0");
    expect(isAutoLoadEnabled()).toBe(false);
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "yes");
    expect(isAutoLoadEnabled()).toBe(false);
  });

  it("trims the value -- cmd.exe's `set VAR=1 && npx ...` stores '1 '", () => {
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "1 ");
    expect(isAutoLoadEnabled()).toBe(true);
    vi.stubEnv("YAW_MCP_AUTO_LOAD", " true");
    expect(isAutoLoadEnabled()).toBe(true);
    // Whitespace-only reads as unset -> default OFF.
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "  ");
    expect(isAutoLoadEnabled()).toBe(false);
  });

  // The three cases below call autoLoadRecurringPack() DIRECTLY, which is
  // below the gate -- so no YAW_MCP_AUTO_LOAD stub is set here; one would be
  // dead setup that reads as coverage the gate does not have.
  it("activates every namespace in the top recurring pack when all are installed", async () => {
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
    const priv = getPrivate(server);
    priv.config = {
      configVersion: "v1",
      servers: [makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub" })],
    };

    await priv.autoLoadRecurringPack();

    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });

  it("the start() gate needs BOTH the env flag and hydrated persistence", () => {
    // The only consultation of isAutoLoadEnabled() is `isAutoLoadEnabled() &&
    // this.persistenceReady` inside start()'s oninitialized hook, and start()
    // needs a live stdio transport, so the conjunction itself is not reachable
    // from a unit test. Each conjunct is: the env read, and persistenceReady,
    // which stays false until start() has hydrated state -- which is why a
    // unit-test ConnectServer never auto-loads however the env is set.
    vi.stubEnv("YAW_MCP_AUTO_LOAD", "1");
    expect(isAutoLoadEnabled()).toBe(true);
    expect(getPrivate(server).persistenceReady).toBe(false);
  });
});

describe("fix#5: dispatch budget schema declares default: 1", () => {
  // Top-level: this is a meta-tools.ts schema assertion that never touches
  // ConnectServer, let alone auto-load, and was nested under "auto-load on
  // startup" purely by where it was written.
  it("budget property carries default: 1 in the JSON schema", async () => {
    // The description text says 'Default budget is 1' but the JSON schema
    // property had no `default` annotation. Both must agree with the
    // runtime behaviour (handleToolCall's dispatch branch in server.ts
    // defaults `budget` to 1 when it is absent or non-finite).
    const { META_TOOLS } = await import("../meta-tools.js");
    const budgetProp = (META_TOOLS.dispatch.inputSchema.properties as Record<string, unknown>).budget as Record<
      string,
      unknown
    >;
    expect(budgetProp).toBeDefined();
    expect(budgetProp.default).toBe(1);
  });
});

describe("fix#6: deferred-route miss error names mcp_connect_discover", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("names mcp_connect_discover in the 'tool vanished' error message", async () => {
    // When a deferred-route activation succeeds but the tool is no
    // longer in the live schema, the error must name the recovery call
    // so the model knows what to do next.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    // Set up a deferred route for gh_stale_tool.
    priv.toolRoutes = new Map([
      [
        "gh_stale_tool",
        {
          namespace: "gh",
          originalName: "stale_tool",
          namespacedName: "gh_stale_tool",
          deferred: true,
        },
      ],
    ]);
    // connectToUpstream succeeds but returns a connection without stale_tool.
    const conn = makeConnection("gh", ["create_issue"]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(conn);

    const result = await priv.handleToolCall("gh_stale_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("mcp_connect_discover");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Bug #2: prewarm race -- explicit activate during prewarm inflight must
// claim the connection so prewarm skips its teardown disconnect.
// ─────────────────────────────────────────────────────────────────────────
describe("prewarm race: explicit activate during prewarm inflight", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("connection survives when an explicit activate joins the prewarm inflight promise", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);

    // Hold the connect open so the explicit activate can enqueue before it resolves.
    let resolveConnect: (conn: UpstreamConnection) => void = () => {};
    const connectPromise = new Promise<UpstreamConnection>((r) => {
      resolveConnect = r;
    });
    vi.mocked(connectToUpstream).mockReturnValueOnce(connectPromise);

    // Launch prewarm -- this starts the inflight, marks gh as prewarm-only.
    const prewarmPromise = priv.prewarmDormantServers();

    // Explicit activate joins before the connect resolves -- this should
    // claim the namespace (remove it from prewarmNamespaces).
    const activatePromise = priv.activateOne("gh");

    // Resolve the upstream -- both waiters see ok=true.
    resolveConnect(makeConnection("gh", ["create_issue"]));
    await Promise.all([prewarmPromise, activatePromise]);

    // Prewarm must NOT have disconnected the connection that the explicit
    // activate claimed -- the user's next tool call must still work.
    expect(priv.connections.has("gh")).toBe(true);
    // Only one actual spawn happened (dedup guarantee still holds).
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
  });

  it("prewarm still disconnects when it is the sole caller (no explicit activate)", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

    await priv.prewarmDormantServers();

    // No explicit activate was called, so prewarm should disconnect.
    expect(priv.connections.has("gh")).toBe(false);
    expect(vi.mocked(disconnectFromUpstream)).toHaveBeenCalledTimes(1);
  });

  it("does not delete a connection that was replaced while its predecessor closed", async () => {
    // The other half of the same race: disconnectFromUpstream marks the old
    // connection dead synchronously, so an explicit activate that starts
    // during the close sees a dead entry, spawns a fresh child, and
    // re-registers under the same key. Deleting unconditionally after the
    // await orphans that child -- live, unreferenced, invisible to
    // shutdown() -- and the user's next tool call gets "no longer
    // connected" for a server that is actually running.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    const prewarmed = makeConnection("gh", ["create_issue"]);
    const replacement = makeConnection("gh", ["create_issue"]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(prewarmed);
    vi.mocked(disconnectFromUpstream).mockImplementationOnce(async () => {
      priv.connections.set("gh", replacement);
    });

    await priv.prewarmDormantServers();

    expect(priv.connections.get("gh")).toBe(replacement);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Bug #3: upstream.ts fetchToolsFromUpstream listTools failure must
// surface as ActivationError(category="protocol_error").
// ─────────────────────────────────────────────────────────────────────────
describe("fetchToolsFromUpstream propagates protocol_error on listTools failure", () => {
  it("throws ActivationError with category=protocol_error when listTools rejects", async () => {
    // Import directly from the module -- the vi.mock at the top of this file
    // replaces connectToUpstream/disconnectFromUpstream but leaves
    // fetchToolsFromUpstream is the real implementation (the mock uses
    // importOriginal and spreads the actual module). The thrown error is
    // asserted by name/category below, so the class itself isn't bound here.
    const { fetchToolsFromUpstream } = await import("../upstream.js");
    const client = { listTools: vi.fn().mockRejectedValue(new Error("JSON-RPC parse error")) } as any;

    await expect(fetchToolsFromUpstream(client, "testns")).rejects.toMatchObject({
      name: "ActivationError",
      category: "protocol_error",
      message: expect.stringContaining("JSON-RPC parse error"),
    });
  });

  it("includes the namespace in the error message for context", async () => {
    const { fetchToolsFromUpstream } = await import("../upstream.js");
    const client = { listTools: vi.fn().mockRejectedValue(new Error("timeout")) } as any;

    let caught: Error | null = null;
    try {
      await fetchToolsFromUpstream(client, "my-ns");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("my-ns");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Bug #6: ConnectServer.parseStepPayload unit tests (three branches).
// ─────────────────────────────────────────────────────────────────────────
describe("ConnectServer.parseStepPayload", () => {
  // Access the private static via cast.
  function parseStepPayload(result: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): unknown {
    return (ConnectServer as any).parseStepPayload(result);
  }

  it("branch 1: single text item whose text is valid JSON -> the parsed JSON value", () => {
    const input = { content: [{ type: "text", text: '{"id":42,"name":"test"}' }] };
    expect(parseStepPayload(input)).toEqual({ id: 42, name: "test" });
  });

  it("branch 1b: JSON array is also parsed and returned as-is", () => {
    const input = { content: [{ type: "text", text: "[1,2,3]" }] };
    expect(parseStepPayload(input)).toEqual([1, 2, 3]);
  });

  it("branch 2: single text item (non-JSON) -> the raw text string", () => {
    const input = { content: [{ type: "text", text: "plain text result" }] };
    expect(parseStepPayload(input)).toBe("plain text result");
  });

  it("branch 3a: multi-item content -> the content array itself", () => {
    const input = {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };
    expect(parseStepPayload(input)).toBe(input.content);
  });

  it("branch 3b: empty content array -> the empty array itself", () => {
    const input = { content: [] };
    expect(parseStepPayload(input)).toEqual([]);
  });

  it("branch 3c: no content field -> empty array fallback", () => {
    const input = {};
    expect(parseStepPayload(input)).toEqual([]);
  });

  it("branch 3d: single non-text item -> the content array", () => {
    const input = { content: [{ type: "image" }] };
    expect(parseStepPayload(input)).toBe(input.content);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Review follow-ups: activation without a route rebuild, the idle reaper
// racing an in-flight call, read_tool bypassing the policy gates, and a
// per-tool filter that outlived the activation it was set for.
// ─────────────────────────────────────────────────────────────────────────
describe("idle threshold env knob", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 10 with neither env var set", () => {
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "");
    vi.stubEnv("MCP_CONNECT_IDLE_THRESHOLD", "");
    expect(resolveIdleThreshold()).toBe(DEFAULT_IDLE_CALL_THRESHOLD);
  });

  it("reads YAW_MCP_IDLE_THRESHOLD", () => {
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "25");
    expect(resolveIdleThreshold()).toBe(25);
  });

  it("still honors the legacy MCP_CONNECT_IDLE_THRESHOLD spelling", () => {
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "");
    vi.stubEnv("MCP_CONNECT_IDLE_THRESHOLD", "7");
    expect(resolveIdleThreshold()).toBe(7);
  });

  it("prefers the YAW_MCP_ name when both are set", () => {
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "3");
    vi.stubEnv("MCP_CONNECT_IDLE_THRESHOLD", "40");
    expect(resolveIdleThreshold()).toBe(3);
  });

  it("falls back to the default on garbage or out-of-range values", () => {
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "banana");
    expect(resolveIdleThreshold()).toBe(DEFAULT_IDLE_CALL_THRESHOLD);
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "0");
    expect(resolveIdleThreshold()).toBe(DEFAULT_IDLE_CALL_THRESHOLD);
  });

  it("warns once per distinct baseline that sits below the adaptive floor", () => {
    // adaptiveThreshold() clamps UP to ADAPTIVE_MIN, so 1..4 all behave as 5
    // and an operator asking for aggressive reaping silently gets the floor.
    // The mirror of the above-the-ceiling warn, and it has to live in
    // resolveIdleThreshold: adaptiveThreshold is pure and is scored on every
    // tool call, so warning there would log per call. Same reason this
    // function must not warn per call either -- hence the once-per-value
    // assertion below.
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
    try {
      // Pinned so a developer running with LOG_LEVEL=error does not silence
      // the very line under test.
      vi.stubEnv("LOG_LEVEL", "");
      // 2 is not used by any sibling case here: the warn dedups on the VALUE,
      // and the module-level slot outlives a single test.
      vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "2");
      // The raw value still comes back -- clamping is adaptiveThreshold's job.
      expect(resolveIdleThreshold()).toBe(2);
      resolveIdleThreshold();

      const warns = written.filter((l) => l.includes("Idle threshold below the adaptive floor"));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('"configured":2');
      expect(warns[0]).toContain('"effectiveMin":5');
    } finally {
      stderr.mockRestore();
    }
  });

  it("is re-read per call, not latched at import", async () => {
    const s = new ConnectServer();
    const priv = getPrivate(s);
    priv.connections.set("gh", makeConnection("gh"));
    priv.connections.set("slack", makeConnection("slack"));
    // Baseline 1 clamps to the adaptive floor of 5, so an idle count of 4
    // tips over on the next call. Under the default baseline of 10 it does
    // not -- which is what makes this a test of the env read.
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "1");
    priv.idleCallCounts.set("slack", 4);

    await priv.trackUsageAndAutoDeactivate("gh");
    expect(priv.connections.has("slack")).toBe(false);
    await s.shutdown();
  });
});

describe("activation always refreshes the routing table", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("deferred first call rebuilds routes even when the server was already connected", async () => {
    // The wedge: discover's auto-warm (or dispatch) connected gh while
    // toolRoutes still held the deferred entry built from its toolCache.
    // activateOne then returns isChanged:false, so gating the rebuild on
    // isChanged left the stale route in place and the call dead-ended on
    // "no longer available" with no recovery path.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    const conn = makeConnection("gh", ["create_issue"]);
    conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "issue #1" }] });
    priv.connections.set("gh", conn);
    // Stale routes: gh is connected but its route still says deferred.
    priv.toolRoutes = new Map([
      [
        "gh_create_issue",
        { namespace: "gh", originalName: "create_issue", namespacedName: "gh_create_issue", deferred: true },
      ],
    ]);

    const result = await priv.handleToolCall("gh_create_issue", {});

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("issue #1");
    // No re-spawn: the server was already connected.
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    // Routes were refreshed, so the deferred entry is gone.
    expect(priv.toolRoutes.get("gh_create_issue")?.deferred).toBeUndefined();
  });

  it("auto-load rebuilds routes for the pack it just activated", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([
      makeServerConfig({ id: "gh-id", namespace: "gh" }),
      makeServerConfig({ id: "linear-id", namespace: "linear", name: "Linear" }),
    ]);
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      priv.packDetector.recordCall("gh", "create_issue", t0 + i * 300_000);
      priv.packDetector.recordCall("linear", "list_issues", t0 + i * 300_000 + 1000);
    }
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, [`${cfg.namespace}_tool`]),
    );

    await priv.autoLoadRecurringPack();

    // Without the rebuild the routing table keeps whatever start() left
    // behind and the first call on an auto-loaded tool misses entirely.
    expect(priv.toolRoutes.has("gh_gh_tool")).toBe(true);
    expect(priv.toolRoutes.has("linear_linear_tool")).toBe(true);
  });
});

describe("idle reaper vs in-flight tool calls", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    // The fixtures below seed idle counts from resolveIdleThreshold(), which
    // reads the real env: an exported value below the adaptive floor of 5 (or
    // at/above the ceiling of 50) would make these fail on that machine only.
    // 10 is DEFAULT_IDLE_CALL_THRESHOLD, i.e. what an unset env resolves to.
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "10");
    vi.stubEnv("MCP_CONNECT_IDLE_THRESHOLD", "");
    server = new ConnectServer();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.shutdown();
  });

  it("does not disconnect a namespace with a call still in flight", async () => {
    const priv = getPrivate(server);
    priv.connections.set("gh", makeConnection("gh"));
    priv.connections.set("slack", makeConnection("slack"));
    priv.idleCallCounts.set("slack", resolveIdleThreshold() - 1);
    // slack is mid-call: killing it here rejects the user's own pending
    // callTool and then books the rejection against slack.
    priv.inflightCalls.set("slack", 1);

    await priv.trackUsageAndAutoDeactivate("gh");

    expect(priv.connections.has("slack")).toBe(true);
    expect(vi.mocked(disconnectFromUpstream)).not.toHaveBeenCalled();

    // Once the call drains, the next completion reaps it as usual.
    priv.inflightCalls.delete("slack");
    await priv.trackUsageAndAutoDeactivate("gh");
    expect(priv.connections.has("slack")).toBe(false);
  });

  it("re-checks the guard before each disconnect, not only when listing candidates", async () => {
    const priv = getPrivate(server);
    priv.connections.set("gh", makeConnection("gh"));
    priv.connections.set("b", makeConnection("b"));
    priv.connections.set("c", makeConnection("c"));
    // b and c both tick past the threshold on this one completion, so they
    // land in the same deactivation batch -- b first.
    priv.idleCallCounts.set("b", resolveIdleThreshold() - 1);
    priv.idleCallCounts.set("c", resolveIdleThreshold() - 1);

    vi.mocked(disconnectFromUpstream).mockImplementationOnce(async (conn: UpstreamConnection) => {
      expect(conn.config.namespace).toBe("b");
      // A tool call for c lands while b's transport is still closing. This is
      // real event-loop time, not a microtask -- the SDK's stdio close races
      // a 2s timer twice -- so the snapshot taken when the batch was built is
      // stale by the time c's turn comes up.
      priv.inflightCalls.set("c", 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await priv.trackUsageAndAutoDeactivate("gh");

    expect(priv.connections.has("b")).toBe(false);
    // Closing c here would reject the user's own pending callTool and then
    // book a 0.0 reliability hit against a server we killed ourselves.
    expect(priv.connections.has("c")).toBe(true);
    expect(vi.mocked(disconnectFromUpstream)).toHaveBeenCalledTimes(1);

    // Once the call drains, the next completion reaps c as usual.
    priv.inflightCalls.delete("c");
    await priv.trackUsageAndAutoDeactivate("gh");
    expect(priv.connections.has("c")).toBe(false);
  });

  it("counts a live proxied call as in-flight for the duration of the call", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    const conn = makeConnection("gh", ["create_issue"]);
    let seenDuringCall: number | undefined;
    conn.client.callTool = vi.fn().mockImplementation(async () => {
      seenDuringCall = priv.inflightCalls.get("gh");
      return { content: [{ type: "text", text: "ok" }] };
    });
    priv.connections.set("gh", conn);
    priv.rebuildRoutes();

    await priv.handleToolCall("gh_create_issue", {});

    expect(seenDuringCall).toBe(1);
    // ...and the marker is released afterwards, not leaked.
    expect(priv.inflightCalls.has("gh")).toBe(false);
  });

  it("releases the in-flight marker on the error path too", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    const conn = makeConnection("gh", ["create_issue"]);
    conn.client.callTool = vi.fn().mockRejectedValue(new Error("transport closed"));
    priv.connections.set("gh", conn);
    priv.rebuildRoutes();

    const result = await priv.handleToolCall("gh_create_issue", {});
    expect(result.isError).toBe(true);
    expect(priv.inflightCalls.has("gh")).toBe(false);
  });
});

describe("read_tool honors the same policy gates as activate", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.shutdown();
  });

  it("refuses a profile-blocked server instead of spawning it", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "prod-db", name: "Prod DB" })]);
    priv.profile = { path: "/proj/.yaw-mcp/config.json", blocked: ["prod-db"] };

    const result = await priv.handleReadTool("prod-db", "query");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not allowed by the project profile");
    // The transient inspect path spawns the real command with its resolved
    // env (vault secrets included) -- a deny-listed server must never
    // reach it just because we disconnect afterwards.
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });

  it("refuses a server outside an allow-list profile", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    priv.profile = { path: "/proj/.yaw-mcp/config.json", servers: ["slack"] };

    const result = await priv.handleReadTool("gh", "create_issue");

    expect(result.isError).toBe(true);
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });

  it("refuses a below-floor server under YAW_MCP_MIN_COMPLIANCE", async () => {
    vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", complianceGrade: "D" })]);

    const result = await priv.handleReadTool("gh", "create_issue");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Refused to load "gh"');
    expect(result.content[0].text).toContain("grade D");
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });

  it("still inspects an allowed, in-grade server", async () => {
    vi.stubEnv("YAW_MCP_MIN_COMPLIANCE", "B");
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", complianceGrade: "A" })]);
    priv.profile = { path: "/proj/.yaw-mcp/config.json", servers: ["gh"] };
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

    const result = await priv.handleReadTool("gh", "create_issue");

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Tool: gh_create_issue");
  });
});

describe("per-tool filter rollback on a failed activation", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("drops the filter when the activation it was set for fails", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockRejectedValue(new Error("spawn ENOENT"));

    const result = await withoutRetryBackoff(() => priv.handleActivate(["gh"], undefined, ["foo"]));
    expect(result.isError).toBe(true);
    // A surviving filter would silently narrow a LATER successful load --
    // dispatch and the deferred path never touch toolFilters.
    expect(priv.toolFilters.has("gh")).toBe(false);
  });

  it("restores the previous filter rather than clearing it outright", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    priv.toolFilters.set("gh", new Set(["create_issue"]));
    vi.mocked(connectToUpstream).mockRejectedValue(new Error("spawn ENOENT"));

    await withoutRetryBackoff(() => priv.handleActivate(["gh"], undefined, ["close_issue"]));

    expect([...(priv.toolFilters.get("gh") ?? [])]).toEqual(["create_issue"]);
  });

  it("leaves no filter behind for a namespace that isn't installed at all", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([]);

    const result = await priv.handleActivate(["ghost"], undefined, ["x"]);
    expect(result.isError).toBe(true);
    expect(priv.toolFilters.has("ghost")).toBe(false);
  });

  it("keeps the filter when the activation succeeds", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue", "close_issue"]));

    await priv.handleActivate(["gh"], undefined, ["create_issue"]);
    expect([...(priv.toolFilters.get("gh") ?? [])]).toEqual(["create_issue"]);
  });
});

describe("discover cache invalidation", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("a failed activation invalidates the memoized discover body", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);

    const first = priv.handleDiscover();
    expect(first.content[0].text).not.toContain("last activation failed");

    vi.mocked(connectToUpstream).mockRejectedValue(new Error("spawn ENOENT"));
    await withoutRetryBackoff(() => priv.activateOne("gh"));

    // Same cache key, still inside the 3s TTL -- but the failure warning
    // must show up. This is the exact "discover, failed activate, discover
    // again" sequence the cache comment names as its motivating case.
    const second = priv.handleDiscover();
    expect(second.content[0].text).toContain("last activation failed");
  });
});

describe("shutdown drains and refuses activations", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  it("refuses a new activation once shutdown has started", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    await server.shutdown();

    const result = await priv.activateOne("gh");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("shutting down");
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });

  it("waits for an in-flight activation and disconnects what it registered", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);

    let resolveConnect: (conn: UpstreamConnection) => void = () => {};
    vi.mocked(connectToUpstream).mockReturnValueOnce(
      new Promise<UpstreamConnection>((r) => {
        resolveConnect = r;
      }),
    );
    const activation = priv.activateOne("gh");

    const shutdownPromise = server.shutdown();
    // The child finishes its handshake AFTER shutdown started. The drain is
    // what gives runActivateOne's post-handshake gate time to close it
    // before the process exits; without either, the connection lands in a
    // map nobody will ever disconnect.
    resolveConnect(makeConnection("gh", ["create_issue"]));
    await Promise.all([activation, shutdownPromise]);

    expect(vi.mocked(disconnectFromUpstream)).toHaveBeenCalledTimes(1);
    expect(priv.connections.size).toBe(0);
  });

  it("closes a handshake that outlives the drain instead of registering it", async () => {
    vi.useFakeTimers();
    try {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);

      let resolveConnect: (conn: UpstreamConnection) => void = () => {};
      vi.mocked(connectToUpstream).mockReturnValueOnce(
        new Promise<UpstreamConnection>((r) => {
          resolveConnect = r;
        }),
      );
      const activation = priv.activateOne("gh");

      // The drain gives up at SHUTDOWN_DRAIN_MS and shutdown() clears the map.
      const shutdownPromise = server.shutdown();
      await vi.advanceTimersByTimeAsync(2000);
      await shutdownPromise;
      expect(priv.connections.size).toBe(0);

      // NOW the cold npx handshake comes back -- into a server that is done.
      // Registering it left a live child in a map nothing reads again, and
      // yaw-mcp exited without ever closing its transport.
      const late = makeConnection("gh", ["create_issue"]);
      resolveConnect(late);
      const result = await activation;

      expect(result.ok).toBe(false);
      expect(result.message).toContain("shutting down");
      expect(priv.connections.size).toBe(0);
      expect(vi.mocked(disconnectFromUpstream)).toHaveBeenCalledWith(late);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to spawn the retry when shutdown latches during the retry sleep", async () => {
    // Timers only: Date stays real, exactly as withoutRetryBackoff does.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
      vi.mocked(connectToUpstream).mockRejectedValueOnce(new Error("spawn ENOENT"));

      const activation = priv.activateOne("gh");
      // Attempt 1 has failed and runActivateOne is parked on its retry sleep
      // (the only pending timer) -- the window a SIGTERM lands in. The
      // wrapper's pre-spawn gate is behind us; only a gate INSIDE the loop
      // can stop the retry from spawning a child behind the latch.
      await until(() => vi.mocked(connectToUpstream).mock.calls.length === 1 && vi.getTimerCount() > 0);

      const shutdownPromise = server.shutdown();
      // Fires the retry sleep first, then the bounded drain.
      await vi.advanceTimersByTimeAsync(5000);
      const result = await activation;
      await shutdownPromise;

      expect(result.ok).toBe(false);
      expect(result.message).toContain("shutting down");
      // Exactly the failed first attempt: nothing was spawned after the latch.
      expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
      expect(priv.connections.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an elicitation re-entry that arrives after the latch", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    // The user answers the vault prompt AFTER shutdown latched. The modal is
    // a round-trip of up to 60s, so this is the common shape of a SIGTERM
    // mid-prompt; the re-entry calls runActivateOne directly and never
    // passes activateOne's gate, so runActivateOne has to refuse it itself.
    priv.server.elicitInput = vi.fn().mockImplementation(async () => {
      priv.shuttingDown = true;
      return { action: "accept", content: { YAW_MCP_VAULT_PASSPHRASE: "session-only" } };
    });
    vi.mocked(connectToUpstream).mockRejectedValueOnce(
      new VaultPassphraseRequiredError("vault locked", "gh", ["GITHUB_TOKEN"], "missing"),
    );

    try {
      const result = await withoutRetryBackoff(() => priv.activateOne("gh"));

      // Prove the prompt ran, so the single connect below is the refused
      // re-entry and not a path that never re-entered at all.
      expect(priv.server.elicitInput).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("shutting down");
      expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
      expect(priv.connections.size).toBe(0);
    } finally {
      // The accepted prompt installed a module-level session passphrase;
      // shutdown() is what clears it, and this describe has no afterEach.
      await server.shutdown();
      clearSessionVaultPassphrase();
    }
  });

  it("closes the save path so a late scheduleStateSave cannot write after the final flush", async () => {
    const priv = getPrivate(server);
    // Stand in for a start() that hydrated state. The flush itself is
    // stubbed so nothing touches ~/.yaw-mcp/state.json.
    priv.persistenceReady = true;
    priv.flushStateSave = vi.fn().mockResolvedValue(undefined);

    await server.shutdown();
    expect(priv.flushStateSave).toHaveBeenCalledTimes(1);

    // A fire-and-forget refineRewardInBackground (or a tool call an embedded
    // host lets finish) landing now must not re-arm the debounce: that timer
    // would write state.json after the flush shutdown() promised was final.
    priv.scheduleStateSave();
    expect(priv.persistenceReady).toBe(false);
    expect(priv.stateSaveTimer).toBeNull();
  });

  it("gives up on a hanging activation instead of outliving the force-exit timer", async () => {
    vi.useFakeTimers();
    try {
      const priv = getPrivate(server);
      priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);

      // A cold npx handshake that never comes back. upstream.ts would give up
      // after a 15s connect timeout retried once -- already well past the 10s
      // force-exit timer in index.ts, which exits(1) instead of 0.
      vi.mocked(connectToUpstream).mockReturnValueOnce(new Promise<UpstreamConnection>(() => {}));
      void priv.activateOne("gh");
      expect(priv.activationInflight.has("gh")).toBe(true);

      let done = false;
      const shutdownPromise = server.shutdown().then(() => {
        done = true;
      });

      // Nothing can settle the activation, so only the drain budget elapsing
      // lets shutdown() through -- and it must elapse well inside 10s.
      await vi.advanceTimersByTimeAsync(1999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await shutdownPromise;
      expect(done).toBe(true);

      // We tore down without it: the activation is still hung.
      expect(priv.activationInflight.has("gh")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears session-elicited credentials, as the field contract promises", async () => {
    const priv = getPrivate(server);
    priv.elicitedEnv.set("gh", { GITHUB_TOKEN: "ghp_secret" });

    await server.shutdown();

    expect(priv.elicitedEnv.size).toBe(0);
  });
});

describe("resolveToolExposure", () => {
  // stubEnv / unstubAllEnvs like the rest of the file, rather than a
  // hand-rolled save at COLLECTION time (which snapshots before any other
  // suite has run) and a restore in afterEach.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to gateway when unset or blank", () => {
    vi.stubEnv("YAW_MCP_TOOL_EXPOSURE", undefined);
    expect(resolveToolExposure()).toBe("gateway");
    vi.stubEnv("YAW_MCP_TOOL_EXPOSURE", "   ");
    expect(resolveToolExposure()).toBe("gateway");
  });

  it("honors an explicit full opt-out, case-insensitively", () => {
    vi.stubEnv("YAW_MCP_TOOL_EXPOSURE", "FULL");
    expect(resolveToolExposure()).toBe("full");
  });

  it("falls back to gateway on an unrecognized value, not to the full surface", () => {
    // A typo must not silently restore the ~27,000-token catalog; failing
    // toward the smaller surface is the recoverable direction.
    // LOG_LEVEL=error mutes the once-per-bad-value warn this path emits --
    // an expected diagnostic should not print into the suite's own output.
    vi.stubEnv("LOG_LEVEL", "error");
    vi.stubEnv("YAW_MCP_TOOL_EXPOSURE", "gatway");
    expect(resolveToolExposure()).toBe("gateway");
  });

  it("warns once per distinct bad value, not once per call", () => {
    // This resolver runs from all three list handlers, so an unconditional
    // warn is three lines per client refresh and three more after every
    // list_changed notification -- noise an operator learns to skim past.
    // Keyed on the VALUE, so swapping one typo for another is still reported.
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as never);
    try {
      // Matched on the structured `raw` field, not on the message: the line is
      // JSON, so the quotes the message puts around the value arrive escaped.
      const warnsFor = (value: string) =>
        written.filter((l) => l.includes("unrecognized YAW_MCP_TOOL_EXPOSURE") && l.includes(`"raw":"${value}"`));

      vi.stubEnv("LOG_LEVEL", "");
      vi.stubEnv("YAW_MCP_TOOL_EXPOSURE", "gatewya");
      resolveToolExposure();
      resolveToolExposure();
      expect(warnsFor("gatewya")).toHaveLength(1);

      vi.stubEnv("YAW_MCP_TOOL_EXPOSURE", "fulll");
      resolveToolExposure();
      expect(warnsFor("fulll")).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("session activation lifetime (gateway mode)", () => {
  let server: ConnectServer;
  beforeEach(() => {
    vi.clearAllMocks();
    // Gateway is the DEFAULT exposure, so the tests below read the real
    // tools/list handler (listedUpstreamToolNames) with the env left blank
    // rather than re-implementing the handler's buildToolList call with a
    // hardcoded "gateway". That is what puts resolveToolExposure() and
    // this.sessionActivated under test instead of around it.
    vi.stubEnv("YAW_MCP_TOOL_EXPOSURE", "");
    server = new ConnectServer();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.shutdown();
  });

  it("advertises a namespace only after an explicit activate", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo"]));
    expect(await listedUpstreamToolNames(priv)).toEqual([]);
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    expect(await listedUpstreamToolNames(priv)).toEqual(["gh_foo"]);
  });

  it("stops advertising it after deactivate", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo"]));
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    await priv.handleToolCall("mcp_connect_deactivate", { server: "gh" });
    expect(priv.sessionActivated.has("gh")).toBe(false);
  });

  it("clears activation when the idle reaper unloads the namespace", async () => {
    // The regression: the reaper cleared toolFilters but not sessionActivated,
    // so a later DISPATCH-driven reload re-advertised a namespace the client
    // had never asked for.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo"]));
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    expect(priv.sessionActivated.has("gh")).toBe(true);

    // Drive the real reaper: trackUsageAndAutoDeactivate unloads namespaces
    // whose idle-call count is past the adaptive threshold.
    priv.idleCallCounts.set("gh", 9999);
    await priv.trackUsageAndAutoDeactivate("other");
    expect(priv.connections.has("gh")).toBe(false);
    expect(priv.sessionActivated.has("gh")).toBe(false);
  });

  it("does not advertise a namespace that failed to activate", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockRejectedValueOnce(new Error("nope"));
    await withoutRetryBackoff(() => priv.handleToolCall("mcp_connect_activate", { server: "gh" }));
    expect(priv.sessionActivated.has("gh")).toBe(false);
  });
});

describe("gateway activation contract (what a client observes)", () => {
  let server: ConnectServer;
  beforeEach(() => {
    vi.clearAllMocks();
    // Same reason as the sibling describe: drive the REAL tools/list handler
    // (listTools) at the default exposure. The local `list()` helper this
    // replaced was a verbatim copy of the sibling's `listed()` minus the name
    // mapping, and neither exercised resolveToolExposure().
    vi.stubEnv("YAW_MCP_TOOL_EXPOSURE", "");
    server = new ConnectServer();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.shutdown();
  });

  it("serves only the meta-tools before any activation", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    const names = (await listTools(priv)).map((t) => t.name);
    expect(names.every((n) => n.startsWith("mcp_connect_"))).toBe(true);
    expect(names.length).toBeGreaterThan(0);
  });

  it("replaces nothing with a placeholder: an activated tool carries its REAL schema", async () => {
    // The deferred placeholder is {type:object, properties:{}, additionalProperties:true}.
    // A client that activated a server must get the upstream's actual contract,
    // or it validates arguments against a schema that accepts anything.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo"]));
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    const foo = (await listTools(priv)).find((t) => t.name === "gh_foo");
    expect(foo?.inputSchema).toEqual({ type: "object" });
    expect(foo?.inputSchema).not.toHaveProperty("additionalProperties");
  });

  it("notifies list_changed on activate, so a client refreshes without polling", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    const spy = vi.spyOn(priv.server, "sendToolListChanged").mockResolvedValue(undefined);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo"]));
    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    expect(spy).toHaveBeenCalled();
  });

  it("keeps a route to an unadvertised tool, so dispatch can still reach it", async () => {
    // The guarantee that makes withholding the catalog safe. Both halves now
    // run against the SERVER's own state: the config is installed and
    // rebuildRoutes() populates this.toolRoutes, instead of calling proxy.ts
    // directly with a hand-built list while the server knew about no servers
    // at all -- under which tools/list could not have contained the tool
    // under ANY exposure, so the negative half proved nothing.
    const priv = getPrivate(server);
    priv.config = makeConfig([{ ...makeServerConfig({ namespace: "tailscale" }), toolCache: [{ name: "status" }] }]);
    priv.rebuildRoutes();
    expect(priv.toolRoutes.has("tailscale_status")).toBe(true);
    expect((await listTools(priv)).some((t) => t.name === "tailscale_status")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Downstream client bridge threading -- every connectToUpstream call site must
// hand over the bridge that forwards elicitation/sampling/roots to the REAL
// downstream client via this.server. Without it, upstream.ts declares
// `capabilities: {}` and the SDK refuses those requests for proxied servers
// even when the downstream client supports all three.
// ---------------------------------------------------------------------------

describe("downstream client bridge", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("threads a bridge into activation connects that reads capabilities and forwards elicitation/sampling/roots off this.server", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));

    await priv.handleActivate(["gh"]);

    const bridge = vi.mocked(connectToUpstream).mock.calls[0][3] as DownstreamClientBridge;
    expect(bridge).toBeDefined();

    // The bridge reads LAZILY off this.server, so stubs installed after the
    // connect still answer -- mirroring "the declaration is only known after
    // the downstream initialize".
    const caps = { elicitation: { form: {} }, sampling: {}, roots: { listChanged: true } };
    priv.server.getClientCapabilities = () => caps;
    expect(bridge.getClientCapabilities()).toBe(caps);

    const elicitResult = { action: "accept", content: { TOKEN: "x" } };
    priv.server.elicitInput = vi.fn().mockResolvedValue(elicitResult);
    const elicitParams = { message: "m", requestedSchema: { type: "object", properties: {} } } as any;
    await expect(bridge.elicitInput(elicitParams, {})).resolves.toBe(elicitResult);
    expect(priv.server.elicitInput).toHaveBeenCalledWith(elicitParams, {});

    const sampleResult = { model: "m", role: "assistant", content: { type: "text", text: "ok" } };
    priv.server.createMessage = vi.fn().mockResolvedValue(sampleResult);
    const sampleParams = { messages: [], maxTokens: 8 } as any;
    await expect(bridge.createMessage(sampleParams, {})).resolves.toBe(sampleResult);
    expect(priv.server.createMessage).toHaveBeenCalledWith(sampleParams, {});

    const rootsResult = { roots: [{ uri: "file:///repo" }] };
    priv.server.listRoots = vi.fn().mockResolvedValue(rootsResult);
    await expect(bridge.listRoots(undefined, {})).resolves.toBe(rootsResult);
    expect(priv.server.listRoots).toHaveBeenCalledWith(undefined, {});

    // A downstream rejection surfaces verbatim -- no invented default.
    priv.server.elicitInput = vi.fn().mockRejectedValue(new Error("client declined"));
    await expect(bridge.elicitInput(elicitParams)).rejects.toThrow("client declined");
  });

  it("threads the same bridge into the transient read_tool connect", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["create_issue"]));
    vi.mocked(disconnectFromUpstream).mockResolvedValue(undefined);

    await priv.handleReadTool("gh", "create_issue", undefined);

    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(connectToUpstream).mock.calls[0][3]).toBe(priv.clientBridge);
  });
});

describe("resolveIdleThreshold strict parse + clamp notice", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejects a prefix-parsable value instead of silently shrinking the threshold", () => {
    // Number.parseInt("1e2", 10) is 1 -- one non-matching call would have
    // reaped every other server. server-cap.ts was hardened to a strict
    // digit run for the same reason; this is the matching guard.
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "1e2");
    expect(resolveIdleThreshold()).toBe(DEFAULT_IDLE_CALL_THRESHOLD);
  });

  it("rejects a trailing-garbage value rather than honoring its numeric prefix", () => {
    // parseInt("20abc") === 20, which is NOT the default -- so this case
    // pins the strict parse rather than coinciding with the fallback.
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "20abc");
    expect(resolveIdleThreshold()).toBe(DEFAULT_IDLE_CALL_THRESHOLD);
  });

  it("still honors a clean digit run, with surrounding whitespace trimmed", () => {
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", " 25 ");
    expect(resolveIdleThreshold()).toBe(25);
  });

  it("warns that a baseline above the adaptive ceiling will be clamped", () => {
    // log() drops warn-level lines before they reach stderr when LOG_LEVEL is
    // `error`, so an operator shell exporting that turns this red for reasons
    // that have nothing to do with the clamp. Pin the level the assertion needs.
    vi.stubEnv("LOG_LEVEL", "warn");
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") writes.push(chunk);
      return true;
    });
    // 137 is deliberately a value no other case in this file uses: the warn
    // latch is keyed on the configured value, so a fresh number always
    // produces the line regardless of test order.
    vi.stubEnv("YAW_MCP_IDLE_THRESHOLD", "137");

    expect(resolveIdleThreshold()).toBe(137);
    const warned = writes.filter((w) => w.includes("above the adaptive ceiling"));
    expect(warned.length).toBe(1);
    expect(JSON.parse(warned[0].trim()).effectiveMax).toBe(50);

    // Same value again: latched, so the reaper's per-call resolution cannot
    // turn this into per-call log spam.
    resolveIdleThreshold();
    expect(writes.filter((w) => w.includes("above the adaptive ceiling")).length).toBe(1);
  });
});

describe("failed prewarm releases its namespace claim", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("removes the namespace from prewarmNamespaces when the activation fails", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    // Persistent rejection: runActivateOne retries once internally.
    vi.mocked(connectToUpstream).mockRejectedValue(new Error("spawn ENOENT"));

    await withoutRetryBackoff(() => priv.prewarmDormantServers());

    // The claim exists to stop prewarm tearing down a connection an explicit
    // activate took over. A FAILED prewarm owns no connection, so leaving the
    // claim behind tells any later reader (a second prewarm pass) that
    // prewarm still holds this namespace.
    expect(priv.prewarmNamespaces.has("gh")).toBe(false);
  });
});

describe("discover cache key covers tool filters", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("re-renders discover after a filter is installed on an already-connected server", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    vi.mocked(connectToUpstream).mockResolvedValueOnce(makeConnection("gh", ["foo", "bar", "baz"]));

    await priv.handleToolCall("mcp_connect_activate", { server: "gh" });
    // Memoize the unfiltered body.
    expect(priv.handleDiscover().content[0].text).toContain("loaded (3 tools)");

    // Filter-only activate on an ALREADY-connected server: configVersion,
    // context, warmedNamespace and the connected set are all unchanged, so
    // before the fix the 3s memo replayed the unfiltered line -- telling the
    // model about tools that tools/list no longer advertises.
    await priv.handleToolCall("mcp_connect_activate", { server: "gh", tools: ["foo"] });

    const text = priv.handleDiscover().content[0].text;
    expect(text).toContain("filtered: 1 of 3");
    expect(text).toContain("loaded (1 tools)");
  });
});

describe("discover summary counts only connected servers", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("excludes an error-state connection from the 'loaded in this session' count", () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([
      makeServerConfig({ namespace: "gh", name: "GitHub" }),
      makeServerConfig({ namespace: "slack", name: "Slack" }),
    ]);
    priv.connections.set("gh", makeConnection("gh", ["create_issue", "list_prs"]));
    // Both namespaces are marked activated so the tool total below is decided
    // by the connection STATUS -- the thing under test -- rather than by
    // gateway exposure withholding an unadvertised namespace, which would make
    // the assertion pass for the wrong reason.
    priv.sessionActivated.add("gh");
    priv.sessionActivated.add("slack");
    // Dead slot: the cap logic (evaluateCapFor) does not count it, so the
    // summary must not either.
    priv.connections.set("slack", makeConnection("slack", [], "error"));

    const text = priv.handleDiscover().content[0].text;
    expect(text).toContain("1 loaded in this session, 2 tools in context");
  });
});

describe("auto-warm failure reaches the discover output", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    // handleDiscoverWithAutoWarm short-circuits to a plain discover when
    // isAutoActivateEnabled() is false, so an operator YAW_MCP_AUTO_ACTIVATE=0
    // would make every case here assert against output the auto-warm path
    // never produced. Blank reads as the documented default (ON).
    vi.stubEnv("YAW_MCP_AUTO_ACTIVATE", "");
    server = new ConnectServer();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.shutdown();
  });

  it("names the cap refusal that stopped the auto-warm", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    vi.spyOn(priv, "twoStageRank").mockResolvedValue([{ namespace: "gh", score: 5 }]);
    // A cap refusal never reaches activationFailures, so formatHealthWarning
    // renders nothing for it: without this banner line the model cannot tell
    // "refused" from "no clear winner" and re-runs the same discover.
    vi.spyOn(priv, "activateOne").mockResolvedValue({
      ok: false,
      isChanged: false,
      capped: true,
      message: "Concurrent server cap reached (6 loaded).",
    });

    const result = await priv.handleDiscoverWithAutoWarm("github issue");
    const text = result.content.map((c: { text: string }) => c.text).join("\n");
    expect(text).toContain('Could not auto-load "gh"');
    expect(text).toContain("Concurrent server cap reached (6 loaded).");
  });

  it("names the spawn failure that stopped the auto-warm, without poisoning the memo", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    vi.spyOn(priv, "twoStageRank").mockResolvedValue([{ namespace: "gh", score: 5 }]);
    vi.mocked(connectToUpstream).mockRejectedValue(new Error("spawn ENOENT npx"));

    const result = await withoutRetryBackoff(() => priv.handleDiscoverWithAutoWarm("github issue"));
    const text = result.content.map((c: { text: string }) => c.text).join("\n");
    expect(text).toContain('Could not auto-load "gh"');
    expect(text).toContain("spawn ENOENT npx");

    // The failure line is appended to a COPY: a memoized body must never
    // carry this one attempt's failure into later cache hits. Asserted
    // unconditionally -- the old `if (priv.discoverCache)` guard silently
    // skipped the whole check if a future edit ever left the memo null after
    // a failed auto-warm, which is exactly when it would stop being proved.
    expect(priv.discoverCache).not.toBeNull();
    const cachedText = priv.discoverCache.result.content.map((c: { text: string }) => c.text).join("\n");
    expect(cachedText).not.toContain("Could not auto-load");
  });
});

describe("handleReadTool refusals", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("refuses to spawn a transient child while shutting down", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    vi.mocked(connectToUpstream).mockResolvedValue(makeConnection("gh", ["create_issue"]));
    priv.shuttingDown = true;

    const result = await priv.handleReadTool("gh", "create_issue");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("shutting down");
    // The point of the latch: a child spawned after the teardown snapshot is
    // outside this.connections, so nothing ever reaps it.
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });

  it("tells the user a server is disabled rather than claiming it is not installed", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", isActive: false })]);

    const result = await priv.handleReadTool("gh", "create_issue");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("installed but disabled");
    expect(result.content[0].text).toContain('"isActive": true');
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
  });

  it("offers a fuzzy suggestion for a near-miss namespace, like activate does", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "github", name: "GitHub" })]);

    const result = await priv.handleReadTool("guthub", "create_issue");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("is not in ~/.yaw-mcp/bundles.json");
    expect(result.content[0].text).toContain("Did you mean: github?");
  });
});

describe("exec pipeline idle tracking and meta-tool refusal ordering", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("ticks other namespaces once for the whole pipeline, not once per step", async () => {
    const priv = getPrivate(server);
    const aConn = makeConnection("alpha", ["work"]);
    aConn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const bConn = makeConnection("bravo", ["idle"]);

    priv.connections.set("alpha", aConn);
    priv.connections.set("bravo", bConn);
    priv.config = makeConfig([makeServerConfig({ namespace: "alpha" }), makeServerConfig({ namespace: "bravo" })]);
    priv.rebuildRoutes();
    priv.idleCallCounts.set("alpha", 0);
    priv.idleCallCounts.set("bravo", 0);

    const result = await priv.handleToolCall("mcp_connect_exec", {
      steps: [
        { id: "s1", tool: "alpha_work", args: {} },
        { id: "s2", tool: "alpha_work", args: {} },
        { id: "s3", tool: "alpha_work", args: {} },
        { id: "s4", tool: "alpha_work", args: {} },
      ],
      return: "s4",
    });
    expect(JSON.parse(result.content[0].text).ok).toBe(true);

    // Per-step ticking aged bravo by one call PER STEP, which on a long
    // pipeline can evict a server a later step still needs. One exec is one
    // unit of work for the reaper.
    expect(priv.idleCallCounts.get("bravo")).toBe(1);
    expect(priv.idleCallCounts.get("alpha")).toBe(0);
  });

  it("counts a multi-namespace pipeline as usage of every namespace it touched", async () => {
    const priv = getPrivate(server);
    const aConn = makeConnection("alpha", ["work"]);
    aConn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "a" }] });
    const bConn = makeConnection("bravo", ["work"]);
    bConn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "b" }] });
    const cConn = makeConnection("charlie", ["untouched"]);

    priv.connections.set("alpha", aConn);
    priv.connections.set("bravo", bConn);
    priv.connections.set("charlie", cConn);
    priv.config = makeConfig([
      makeServerConfig({ namespace: "alpha" }),
      makeServerConfig({ namespace: "bravo" }),
      makeServerConfig({ namespace: "charlie" }),
    ]);
    priv.rebuildRoutes();
    priv.idleCallCounts.set("alpha", 4);
    priv.idleCallCounts.set("bravo", 4);
    priv.idleCallCounts.set("charlie", 0);

    await priv.handleToolCall("mcp_connect_exec", {
      steps: [
        { id: "s1", tool: "alpha_work", args: {} },
        { id: "s2", tool: "bravo_work", args: {} },
      ],
      return: "s2",
    });

    // Both steps' namespaces were used, so neither may be left aging.
    expect(priv.idleCallCounts.get("alpha")).toBe(0);
    expect(priv.idleCallCounts.get("bravo")).toBe(0);
    expect(priv.idleCallCounts.get("charlie")).toBe(1);
  });

  it("drops the discover memo after an exec step's learning write", async () => {
    const priv = getPrivate(server);
    const aConn = makeConnection("alpha", ["work"]);
    aConn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    priv.connections.set("alpha", aConn);
    priv.config = makeConfig([makeServerConfig({ namespace: "alpha" })]);
    priv.rebuildRoutes();

    priv.handleDiscover();
    expect(priv.discoverCache).not.toBeNull();

    await priv.handleToolCall("mcp_connect_exec", {
      steps: [{ id: "s1", tool: "alpha_work", args: {} }],
      return: "s1",
    });

    // exec books its own per-step recordOutcome, and discover renders those
    // counters as usage / reliability lines the cache key cannot see.
    expect(priv.discoverCache).toBeNull();
  });

  it("refuses a typo'd $ref before step 0 fires its side effects", async () => {
    // The whole point of the preflight: step 0 FILES AN ISSUE. Catching the
    // one-character typo when step 1 resolves its args means the obvious
    // reaction -- fix the ref, re-run the exec -- files a second one. Every
    // producer key is known statically, so nothing has to run to decide this.
    const priv = getPrivate(server);
    const conn = makeConnection("gh", ["create_issue", "comment"]);
    conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: '{"number":7}' }] });
    priv.connections.set("gh", conn);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    priv.rebuildRoutes();

    const result = await priv.handleToolCall("mcp_connect_exec", {
      steps: [
        { id: "issue", tool: "gh_create_issue", args: {} },
        { tool: "gh_comment", args: { n: { $ref: "isue.number" } } },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('names step "isue"');
    // Zero dispatches. Not "one dispatch and a good error".
    expect(conn.client.callTool).not.toHaveBeenCalled();
  });

  it("refuses a meta-tool step before resolving its $refs", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "alpha" })]);
    priv.rebuildRoutes();

    const result = await priv.handleToolCall("mcp_connect_exec", {
      steps: [{ id: "m", tool: "mcp_connect_exec", args: { x: { $ref: "nonexistent" } } }],
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // What makes the step illegal is the tool it names, not its args -- a
    // ref error here sent the model off fixing arguments for a call exec was
    // never going to make.
    expect(text).toContain("meta-tool");
    expect(text).not.toContain("ref");
    // Preflight refusals are plain text; the {ok, failedStep, partial} envelope
    // is reserved for a failure AFTER steps have run, so that the shape alone
    // says whether anything happened. Pinned because this check was hoisted out
    // of the dispatch loop, where the envelope had been correct.
    expect(text.startsWith("exec: ")).toBe(true);
    expect(() => JSON.parse(text)).toThrow();
  });
});

describe("response pruning respects structuredContent", () => {
  let server: ConnectServer;

  const prunableText = JSON.stringify({
    keep: "x".repeat(60),
    droppedNull: null,
    droppedEmptyList: [],
    droppedEmptyObject: {},
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // isPruneEnabled() reads the env per call, so an operator
    // YAW_MCP_PRUNE_RESPONSES=0 would make the first case below assert against
    // an unpruned body. Blank reads as the documented default (pruning on).
    vi.stubEnv("YAW_MCP_PRUNE_RESPONSES", "");
    server = new ConnectServer();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.shutdown();
  });

  it("prunes the text body when there is no structured payload", async () => {
    const priv = getPrivate(server);
    const conn = makeConnection("gh", ["report"]);
    conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: prunableText }] });
    priv.connections.set("gh", conn);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    priv.rebuildRoutes();

    const result = await priv.handleToolCall("gh_report", {});
    expect(result.content[0].text).not.toContain("droppedNull");
  });

  it("leaves the text body verbatim when the tool also returned structuredContent", async () => {
    const priv = getPrivate(server);
    const conn = makeConnection("gh", ["report"]);
    // MCP 2025-06-18: an outputSchema tool returns the structured payload AND
    // a text fallback that mirrors it. Pruning only the text makes the two
    // representations of one result disagree on a null-valued field.
    conn.client.callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: prunableText }],
      structuredContent: { keep: "x".repeat(60), droppedNull: null, droppedEmptyList: [], droppedEmptyObject: {} },
    });
    priv.connections.set("gh", conn);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    priv.rebuildRoutes();

    const result = await priv.handleToolCall("gh_report", {});
    expect(result.content[0].text).toBe(prunableText);
  });
});

// ---------------------------------------------------------------------------
// Vault passphrase elicitation. resolveServerEnv fails CLOSED when a server's
// env carries ${secret:...} refs and the vault is locked, and the error text
// ("YAW_MCP_VAULT_PASSPHRASE is not set") already matched
// detectMissingCredentials -- so the user WAS prompted, but the answer went
// into elicitedEnv, which is merged into the CHILD's env, while
// resolveServerEnv reads yaw-mcp's own. The prompt appeared, the user typed
// the right passphrase, and the spawn failed identically. These cover the
// routing fix and the phishing/leak guard that comes with it.
// ---------------------------------------------------------------------------

describe("vault passphrase elicitation", () => {
  let server: ConnectServer;

  beforeEach(() => {
    // connectToUpstream / disconnectFromUpstream are reset by the file-level
    // beforeEach. verifyVaultPassphrase needs its own, and its default has to
    // be re-established because it was attached with mockResolvedValue rather
    // than passed to vi.fn(): a case that sets a persistent `false` here (the
    // attempt-budget one) would otherwise make every later case's passphrase
    // fail verification.
    vi.mocked(verifyVaultPassphrase).mockReset().mockResolvedValue(true);
    vi.clearAllMocks();
    // vaultPassphrase() falls back to the real env when no session value is
    // set, and exporting YAW_MCP_VAULT_PASSPHRASE is the product's own
    // documented way to skip the prompt -- so on such a machine every
    // `toBeUndefined()` below would read the developer's own passphrase.
    // `undefined` tells Vitest to DELETE the variable for the test.
    vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE", undefined);
    server = new ConnectServer();
  });

  afterEach(async () => {
    // shutdown() clears the module-level passphrase itself; this is belt and
    // braces for a case that throws before reaching it.
    await server.shutdown();
    clearSessionVaultPassphrase();
    vi.unstubAllEnvs();
  });

  function lockedVaultError(namespace: string, reason: "missing" | "invalid" = "missing") {
    return new VaultPassphraseRequiredError(
      "vault locked: server env references ${secret:...} but YAW_MCP_VAULT_PASSPHRASE is not set",
      namespace,
      ["GITHUB_PERSONAL_ACCESS_TOKEN"],
      reason,
    );
  }

  it("prompts for the passphrase, installs it, and the retry succeeds", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    priv.server.elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { YAW_MCP_VAULT_PASSPHRASE: "correct-horse-battery-staple" },
    });
    // ONE rejection: a vault refusal short-circuits the retry loop, so the
    // second connect is the post-elicitation retry, not attempt 2.
    vi.mocked(connectToUpstream)
      .mockRejectedValueOnce(lockedVaultError("gh"))
      .mockImplementationOnce(async (cfg: UpstreamServerConfig) => makeConnection(cfg.namespace, ["t"]));

    const result = await priv.activateOne("gh");

    expect(result.ok).toBe(true);
    // The value reached the module-level session slot -- which is what
    // resolveServerEnv actually reads.
    expect(vaultPassphrase()).toBe("correct-horse-battery-staple");
  });

  it("does not burn a retry on a refusal that cannot change in a second", async () => {
    // The vault verdict is reached before any child spawns, from state a 1s
    // sleep cannot alter. Retrying it costs that sleep plus a warn line that
    // reads like a transient spawn failure.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    priv.server.getClientCapabilities = () => ({});
    vi.mocked(connectToUpstream).mockRejectedValue(lockedVaultError("gh"));

    await priv.activateOne("gh");

    // Exactly one attempt -- not the two a generic spawn failure would get.
    expect(vi.mocked(connectToUpstream)).toHaveBeenCalledTimes(1);
  });

  it("re-asks after a wrong passphrase instead of spending the session on a typo", async () => {
    // The value is typed into a no-echo field. Before verification it was
    // stored unverified AND latched, so one transposed character meant every
    // vault-backed server failed until the client restarted.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    priv.server.elicitInput = vi
      .fn()
      .mockResolvedValueOnce({ action: "accept", content: { YAW_MCP_VAULT_PASSPHRASE: "typo" } })
      .mockResolvedValueOnce({ action: "accept", content: { YAW_MCP_VAULT_PASSPHRASE: "the-right-one" } });
    vi.mocked(verifyVaultPassphrase).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(connectToUpstream)
      .mockRejectedValueOnce(lockedVaultError("gh"))
      .mockRejectedValueOnce(lockedVaultError("gh"))
      .mockImplementationOnce(async (cfg: UpstreamServerConfig) => makeConnection(cfg.namespace, ["t"]));

    const first = await priv.activateOne("gh");
    expect(first.ok).toBe(false);
    // The typo was REJECTED, not stored -- it must not shadow the env var.
    expect(vaultPassphrase()).toBeUndefined();

    const second = await priv.activateOne("gh");
    expect(second.ok).toBe(true);
    expect(vaultPassphrase()).toBe("the-right-one");
    expect(priv.server.elicitInput).toHaveBeenCalledTimes(2);
  });

  it("stops asking after the attempt budget, however wrong the entries are", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    priv.server.elicitInput = vi
      .fn()
      .mockResolvedValue({ action: "accept", content: { YAW_MCP_VAULT_PASSPHRASE: "still-wrong" } });
    vi.mocked(verifyVaultPassphrase).mockResolvedValue(false);
    vi.mocked(connectToUpstream).mockRejectedValue(lockedVaultError("gh"));

    await priv.activateOne("gh");
    await priv.activateOne("gh");
    await priv.activateOne("gh");

    // An elicitation is a modal interruption; bounded, not endless.
    expect(priv.server.elicitInput).toHaveBeenCalledTimes(MAX_VAULT_PASSPHRASE_PROMPTS);
    expect(vaultPassphrase()).toBeUndefined();
  });

  it("offers a correction when the configured passphrase is WRONG, not just absent", async () => {
    // reason "invalid" is the case that had no recovery at all: the unlock
    // error went to the generic path, where the internal-key filter refuses
    // to elicit yaw-mcp's own secrets, so nothing could offer a fix.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    priv.server.elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { YAW_MCP_VAULT_PASSPHRASE: "the-real-passphrase" },
    });
    vi.mocked(connectToUpstream)
      .mockRejectedValueOnce(lockedVaultError("gh", "invalid"))
      .mockImplementationOnce(async (cfg: UpstreamServerConfig) => makeConnection(cfg.namespace, ["t"]));

    const result = await priv.activateOne("gh");

    expect(result.ok).toBe(true);
    expect(vaultPassphrase()).toBe("the-real-passphrase");
    // The prompt must not tell a user who DID set the var that it is unset.
    const msg = vi.mocked(priv.server.elicitInput).mock.calls[0][0].message as string;
    expect(msg).toContain("does not unlock");
    expect(msg).not.toContain("which is locked");
  });

  it("clears the module-level passphrase on shutdown", async () => {
    // It lives in upstream.ts module state so no child env can inherit it,
    // which also means it outlives the instance unless shutdown clears it --
    // a second ConnectServer would inherit plaintext its user never typed.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    priv.server.elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { YAW_MCP_VAULT_PASSPHRASE: "session-only" },
    });
    vi.mocked(connectToUpstream)
      .mockRejectedValueOnce(lockedVaultError("gh"))
      .mockImplementationOnce(async (cfg: UpstreamServerConfig) => makeConnection(cfg.namespace, ["t"]));

    await priv.activateOne("gh");
    expect(vaultPassphrase()).toBe("session-only");

    await server.shutdown();
    expect(vaultPassphrase()).toBeUndefined();
  });

  it("keeps the passphrase OUT of elicitedEnv, so it never reaches the child", async () => {
    // elicitedEnv is merged over the server's configured env on retry. Storing
    // the passphrase there would hand it to the very child we are unlocking
    // the vault FOR, walking straight past stripInternalSecretsFromEnv.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    priv.server.elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { YAW_MCP_VAULT_PASSPHRASE: "s3kr1t" },
    });
    vi.mocked(connectToUpstream)
      .mockRejectedValueOnce(lockedVaultError("gh"))
      .mockImplementationOnce(async (cfg: UpstreamServerConfig) => makeConnection(cfg.namespace, ["t"]));

    const result = await priv.activateOne("gh");

    // Prove the vault-elicitation path RAN before asserting what it did not
    // store: an elicitedEnv entry is absent on a path that never prompted at
    // all, so without these the test stays green if the whole flow no-ops.
    expect(priv.server.elicitInput).toHaveBeenCalledTimes(1);
    expect(vaultPassphrase()).toBe("s3kr1t");
    // One refused spawn plus the post-elicitation retry, and the retry won.
    expect(connectToUpstream).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);

    expect(priv.elicitedEnv.get("gh")).toBeUndefined();
    // Belt and braces: whatever env the retry spawned with, it is not in it.
    const spawnedEnv = vi.mocked(connectToUpstream).mock.calls.at(-1)?.[0].env ?? {};
    expect(spawnedEnv).not.toHaveProperty("YAW_MCP_VAULT_PASSPHRASE");
  });

  it("treats a decline as final, across different servers", async () => {
    // One vault, one passphrase. A decline is a decision, not a slip, so it
    // must not re-prompt on the next server that touches the vault -- unlike
    // a rejected typo, which gets one more try.
    const priv = getPrivate(server);
    priv.config = makeConfig([
      makeServerConfig({ namespace: "gh", name: "GitHub" }),
      makeServerConfig({ namespace: "slack", name: "Slack" }),
    ]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    priv.server.elicitInput = vi.fn().mockResolvedValue({ action: "decline" });
    vi.mocked(connectToUpstream).mockRejectedValue(lockedVaultError("gh"));

    await priv.activateOne("gh");
    await priv.activateOne("slack");

    expect(priv.server.elicitInput).toHaveBeenCalledTimes(1);
  });

  it("does not prompt when the client cannot elicit", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    priv.server.getClientCapabilities = () => ({});
    priv.server.elicitInput = vi.fn();
    vi.mocked(connectToUpstream).mockRejectedValue(lockedVaultError("gh"));

    const result = await priv.activateOne("gh");

    expect(result.ok).toBe(false);
    expect(priv.server.elicitInput).not.toHaveBeenCalled();
    expect(vaultPassphrase()).toBeUndefined();
  });

  it("refuses to elicit yaw-mcp's own secrets from a CHILD's stderr", async () => {
    // The phishing shape: detectMissingCredentials matches
    // "YAW_MCP_VAULT_PASSPHRASE is not set" anywhere in the haystack, and the
    // haystack includes the child's stderr. Without the internal-key filter a
    // server could print that line and be handed the vault passphrase, via a
    // prompt naming the SERVER rather than yaw-mcp -- and the value would then
    // be merged into that same server's env on retry.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "evil", name: "Evil" })]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    priv.server.elicitInput = vi.fn();
    vi.mocked(connectToUpstream).mockRejectedValue(
      new ActivationError("spawn failed", "unknown", "YAW_MCP_VAULT_PASSPHRASE is not set\n"),
    );

    const result = await withoutRetryBackoff(() => priv.activateOne("evil"));

    expect(result.ok).toBe(false);
    expect(priv.server.elicitInput).not.toHaveBeenCalled();
    expect(priv.elicitedEnv.get("evil")).toBeUndefined();
    expect(vaultPassphrase()).toBeUndefined();
  });

  it("still elicits a genuine child credential alongside the filter", async () => {
    // The filter must remove ONLY yaw-mcp's own keys -- a real missing child
    // credential still gets the generic prompt.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    priv.server.elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { GITHUB_TOKEN: "ghp_x" },
    });
    vi.mocked(connectToUpstream)
      .mockRejectedValueOnce(new ActivationError("boom", "unknown", "GITHUB_TOKEN is required\n"))
      .mockRejectedValueOnce(new ActivationError("boom", "unknown", "GITHUB_TOKEN is required\n"))
      .mockImplementationOnce(async (cfg: UpstreamServerConfig) => makeConnection(cfg.namespace, ["t"]));

    // Unlike the vault refusals above, a generic credential failure DOES burn
    // both attempts -- so this case pays runActivateOne's 1s retry sleep.
    const result = await withoutRetryBackoff(() => priv.activateOne("gh"));

    expect(result.ok).toBe(true);
    expect(priv.elicitedEnv.get("gh")).toEqual({ GITHUB_TOKEN: "ghp_x" });
    // The child credential goes to the child, NOT to the vault.
    expect(vaultPassphrase()).toBeUndefined();
  });

  it("opens ONE modal when two namespaces hit the locked vault at once, and both then load", async () => {
    // Prewarm runs several activations concurrently, so more than one
    // namespace can reach a locked vault in the same instant -- and they are
    // all asking the ONE question this vault has. Without vaultElicitInflight
    // each opened its own modal, which is N interruptions for one answer and
    // burns the shared MAX_VAULT_PASSPHRASE_PROMPTS budget N times faster.
    const priv = getPrivate(server);
    priv.config = makeConfig([
      makeServerConfig({ namespace: "gh", name: "GitHub" }),
      makeServerConfig({ namespace: "linear", name: "Linear" }),
    ]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });

    // The modal stays open until BOTH activations are parked on it. A prompt
    // that resolves immediately would let the winner finish before the
    // follower ever reaches the vault path, so the dedup would never be
    // exercised and the test would pass on a build without it.
    let answer: (result: unknown) => void = () => {};
    const answered = new Promise((resolve) => {
      answer = resolve;
    });
    priv.server.elicitInput = vi.fn().mockReturnValue(answered);

    // Locked until the passphrase lands -- the same gate for both namespaces,
    // which is the point: unlocking for one unlocks for all.
    vi.mocked(connectToUpstream).mockImplementation((async (cfg: UpstreamServerConfig) => {
      if (vaultPassphrase() === undefined) throw lockedVaultError(cfg.namespace);
      return makeConnection(cfg.namespace, ["t"]);
    }) as unknown as typeof connectToUpstream);

    const both = Promise.all([priv.activateOne("gh"), priv.activateOne("linear")]);
    await until(() => vi.mocked(priv.server.elicitInput).mock.calls.length > 0);
    answer({ action: "accept", content: { YAW_MCP_VAULT_PASSPHRASE: "s3kr1t" } });
    const [gh, linear] = await both;

    // One question, one modal.
    expect(priv.server.elicitInput).toHaveBeenCalledTimes(1);
    // And the follower gets the benefit: it retries on the winner's answer
    // rather than failing with the stale "vault is locked" error.
    expect(gh.ok).toBe(true);
    expect(linear.ok).toBe(true);
    expect(vaultPassphrase()).toBe("s3kr1t");
  });

  it("a follower on a REJECTED shared prompt gets the winner's words and no penalty", async () => {
    // Same batch as above, but the one passphrase typed is wrong. The winner
    // already reported that accurately ("does not unlock") with no
    // activationFailures entry. The follower used to fall through
    // runActivateOne's give-up path instead: "vault locked ... not set" when
    // the user had just typed one, plus the penalty healthFactor and
    // discover's `warn: last activation failed` line read for the TTL -- for
    // every namespace in the batch but the winner.
    const priv = getPrivate(server);
    priv.config = makeConfig([
      makeServerConfig({ namespace: "gh", name: "GitHub" }),
      makeServerConfig({ namespace: "linear", name: "Linear" }),
    ]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    let answer: (result: unknown) => void = () => {};
    const answered = new Promise((resolve) => {
      answer = resolve;
    });
    priv.server.elicitInput = vi.fn().mockReturnValue(answered);
    vi.mocked(verifyVaultPassphrase).mockResolvedValue(false);
    vi.mocked(connectToUpstream).mockImplementation((async (cfg: UpstreamServerConfig) => {
      throw lockedVaultError(cfg.namespace);
    }) as unknown as typeof connectToUpstream);

    const both = Promise.all([priv.activateOne("gh"), priv.activateOne("linear")]);
    await until(() => vi.mocked(priv.server.elicitInput).mock.calls.length > 0);
    answer({ action: "accept", content: { YAW_MCP_VAULT_PASSPHRASE: "wrong" } });
    const [gh, linear] = await both;

    expect(priv.server.elicitInput).toHaveBeenCalledTimes(1);
    for (const r of [gh, linear]) {
      expect(r.ok).toBe(false);
      expect(r.message).toContain("does not unlock");
      expect(r.message).not.toContain("vault locked");
    }
    expect(priv.activationFailures.size).toBe(0);
    expect(vaultPassphrase()).toBeUndefined();
  });
});

describe("handleSecretsReport refusals", () => {
  let server: ConnectServer;
  let synthHome: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // The report lists the vault's KEY NAMES from ~/.yaw-mcp/secrets.json;
    // point homedir() at an empty temp dir so the developer's real vault is
    // never read (USERPROFILE on win32, HOME on POSIX).
    synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-secrets-report-"));
    vi.stubEnv("HOME", synthHome);
    vi.stubEnv("USERPROFILE", synthHome);
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
    vi.unstubAllEnvs();
    rmSync(synthHome, { recursive: true, force: true });
  });

  // A configured server missing from getProfiledActiveServers() is ALWAYS
  // disabled or profile-blocked, and spawnGateRefusal words exactly those two
  // -- there is no third state for this branch to report.
  it("names the bundles.json toggle for an installed-but-disabled server", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", isActive: false })]);

    const result = await priv.handleSecretsReport("gh");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("installed but disabled");
    expect(result.content[0].text).toContain('"isActive": true');
  });

  it("names the profile for a profile-blocked server", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    priv.profile = { path: "/proj/.yaw-mcp/config.json", blocked: ["gh"] };

    const result = await priv.handleSecretsReport("gh");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not allowed by the project profile at /proj/.yaw-mcp/config.json");
  });

  it("reports an unconfigured namespace as not installed", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);

    const result = await priv.handleSecretsReport("nope");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No installed server with namespace "nope"');
  });
});

// ---------------------------------------------------------------------------
// Deferred-load notification fan-out. A first tools/call on a dormant server
// activates it and tells the client its lists moved. When several calls race
// for the SAME dormant server they share one activation, so they must also
// share one notification -- each racer notifying made a client like Claude
// Code refetch the whole catalog once per racer for a single load.
// ---------------------------------------------------------------------------

describe("concurrent deferred first calls", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("sends ONE list_changed triplet for one deferred load, however many callers raced for it", async () => {
    const priv = getPrivate(server);
    priv.config = makeConfig([
      { ...makeServerConfig({ namespace: "gh" }), toolCache: [{ name: "foo" }, { name: "bar" }] },
    ]);
    priv.rebuildRoutes();
    // Both routes are placeholders: neither caller has a live connection yet.
    expect(priv.toolRoutes.get("gh_foo")?.deferred).toBe(true);
    expect(priv.toolRoutes.get("gh_bar")?.deferred).toBe(true);

    const tools = vi.spyOn(priv.server, "sendToolListChanged").mockResolvedValue(undefined);
    const resources = vi.spyOn(priv.server, "sendResourceListChanged").mockResolvedValue(undefined);
    const prompts = vi.spyOn(priv.server, "sendPromptListChanged").mockResolvedValue(undefined);

    // Hold the spawn open so the second call lands while the first activation
    // is still in flight. That window is the only one in which a joiner can
    // duplicate the notification, so a mock that resolves immediately would
    // pass on a build without the fix.
    let finishConnect: (conn: UpstreamConnection) => void = () => {};
    const connecting = new Promise<UpstreamConnection>((resolve) => {
      finishConnect = resolve;
    });
    vi.mocked(connectToUpstream).mockReturnValue(connecting as never);

    const conn = makeConnection("gh", ["foo", "bar"]);
    conn.client.callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    const first = priv.handleToolCall("gh_foo", {});
    await until(() => priv.activationInflight.has("gh"));
    const second = priv.handleToolCall("gh_bar", {});
    await until(() => vi.mocked(connectToUpstream).mock.calls.length > 0);
    finishConnect(conn);

    const [a, b] = await Promise.all([first, second]);
    // Both calls reached the upstream -- the joiner rebuilds its routes
    // locally, so skipping the NOTIFY half must not cost it its dispatch.
    expect(a.isError).toBeUndefined();
    expect(b.isError).toBeUndefined();
    expect(connectToUpstream).toHaveBeenCalledTimes(1);

    expect(tools).toHaveBeenCalledTimes(1);
    expect(resources).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveBeenCalledTimes(1);
  });
});

describe("auto-loaded pack visibility under gateway exposure", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server.shutdown();
  });

  it("advertises every loaded pack member in tools/list, not just in this.connections", async () => {
    // The feature's whole claim is that it skips the discover + activate
    // round-trip. Connecting the pack without recording it in
    // sessionActivated spends a cap slot and a child process on tools the
    // client still cannot see, because gateway exposure keys tools/list on
    // exactly that set -- so the stated purpose does not hold.
    const priv = getPrivate(server);
    priv.config = makeConfig([
      makeServerConfig({ id: "gh-id", namespace: "gh", name: "GitHub" }),
      makeServerConfig({ id: "linear-id", namespace: "linear", name: "Linear" }),
    ]);
    // Three bursts of (gh, linear) -> one detected pack at frequency 3.
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      priv.packDetector.recordCall("gh", "create_issue", t0 + i * 300_000);
      priv.packDetector.recordCall("linear", "list_issues", t0 + i * 300_000 + 1000);
    }
    vi.mocked(connectToUpstream).mockImplementation(async (cfg: UpstreamServerConfig) =>
      makeConnection(cfg.namespace, ["do_thing"]),
    );
    // Pinned blank: resolveToolExposure reads the env on every tools/list, so
    // an exported YAW_MCP_TOOL_EXPOSURE=full would advertise both namespaces
    // regardless of sessionActivated and make the assertion vacuous.
    vi.stubEnv("YAW_MCP_TOOL_EXPOSURE", "");

    await priv.autoLoadRecurringPack();

    // Not vacuous the other way either: both really connected, so the only
    // thing under test is whether tools/list surfaces them.
    expect(priv.connections.get("gh")?.status).toBe("connected");
    expect(priv.connections.get("linear")?.status).toBe("connected");
    const listed = await listedUpstreamToolNames(priv);
    expect(listed).toContain("gh_do_thing");
    expect(listed).toContain("linear_do_thing");
  });
});

describe("upstream tools/list_changed re-learns the tool cache", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("refreshes toolCache so the post-eviction deferred routes carry the new names", async () => {
    // Rebuilding routes from the refreshed connection is only half of it:
    // this.toolCache is what every COLD reader uses (deferred routes after an
    // idle eviction, discover's `known tools:` line, the BM25 corpus, the next
    // state.json save), so leaving it stale keeps all four serving the
    // pre-change list until the namespace is activated again.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub" })]);
    const toolsChanged = vi.spyOn(priv.server, "sendToolListChanged").mockResolvedValue(undefined);
    vi.spyOn(priv.server, "sendResourceListChanged").mockResolvedValue(undefined);
    vi.spyOn(priv.server, "sendPromptListChanged").mockResolvedValue(undefined);

    const conn = makeConnection("gh", ["old_tool"]);
    priv.connections.set("gh", conn);
    priv.toolCache.set("gh", [{ name: "old_tool" }]);
    priv.toolCacheLearnedAt.set("gh", 1);

    // upstream.ts re-lists onto the SAME connection object and only then fires
    // the callback, so this is the state the handler actually observes.
    conn.tools = makeConnection("gh", ["new_tool"]).tools;
    priv.onUpstreamListChanged("gh");
    // Drain the fire-and-forget refreshRoutesAndNotify before touching routes.
    await until(() => toolsChanged.mock.calls.length > 0);

    expect(priv.toolCache.get("gh").map((t: { name: string }) => t.name)).toEqual(["new_tool"]);
    expect(priv.toolCacheLearnedAt.get("gh")).toBeGreaterThan(1);

    // Drop the connection the way the idle reaper does. The deferred routes
    // rebuilt from the learned cache must follow the change.
    priv.connections.delete("gh");
    priv.rebuildRoutes();
    expect(priv.toolRoutes.get("gh_new_tool")?.deferred).toBe(true);
    expect(priv.toolRoutes.has("gh_old_tool")).toBe(false);
  });
});

describe("elicitation retry vs the concurrent-server cap", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("connects the retry even when other namespaces filled the cap while the prompt was open", async () => {
    // By the time the retry runs the user has already typed the credential.
    // Refusing it there spends that input for nothing -- and the reservation
    // this namespace still holds is deliberately NOT a self-allowance in
    // evaluateCapFor, so only the explicit skipCap keeps the retry alive.
    const priv = getPrivate(server);
    priv.serverCap = 1;
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" }), makeServerConfig({ namespace: "busy" })]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    priv.server.elicitInput = vi.fn().mockImplementation(async () => {
      // The window the finding is about: an unrelated namespace takes the
      // last slot while the modal is up. gh cleared the cap on the way in.
      priv.connections.set("busy", makeConnection("busy", ["t"]));
      return { action: "accept", content: { GITHUB_TOKEN: "ghp_x" } };
    });
    // Both attempts of the first pass fail naming the credential; the elicited
    // retry is the third call and succeeds.
    vi.mocked(connectToUpstream)
      .mockRejectedValueOnce(new Error("GITHUB_TOKEN is required"))
      .mockRejectedValueOnce(new Error("GITHUB_TOKEN is required"))
      .mockImplementationOnce(async (cfg: UpstreamServerConfig) => makeConnection(cfg.namespace, ["t"]));

    const result = await withoutRetryBackoff(() => priv.activateOne("gh"));

    expect(result.ok).toBe(true);
    expect(result.capped).toBeUndefined();
    // Pin the SHAPE, not just the outcome: two failures plus exactly one
    // elicited retry, so a path that succeeded some other way could not
    // satisfy the assertions above.
    expect(connectToUpstream).toHaveBeenCalledTimes(3);
    expect(priv.server.elicitInput).toHaveBeenCalledTimes(1);
    expect(priv.connections.get("gh")?.status).toBe("connected");
    // The cap really was full when the retry ran.
    expect(priv.connections.get("busy")?.status).toBe("connected");
  });

  it("asks once per activate when the child keeps reporting the same key missing", async () => {
    // The prompt budget is per NAMESPACE, not per activate. The elicited retry
    // re-enters runActivateOne, so without the isElicitRetry guard the nested
    // maybeElicitAndRetry saw asked=1 < 2 and opened a SECOND, byte-identical
    // modal in the same breath as the first -- nothing new for the user to
    // type, the whole budget spent, six spawns and their retry sleeps inside
    // one activate, and the namespace latched for the session.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    priv.server.elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { GITHUB_TOKEN: "ghp_x" },
    });
    // The child never accepts the value: every spawn reports the same key.
    const stillMissing = new ActivationError("boom", "unknown", "GITHUB_TOKEN is required\n");
    vi.mocked(connectToUpstream).mockRejectedValue(stillMissing);

    const first = await withoutRetryBackoff(() => priv.activateOne("gh"));

    expect(first.ok).toBe(false);
    expect(priv.server.elicitInput).toHaveBeenCalledTimes(1);
    // One ask spent, not the whole budget.
    expect(priv.credentialPrompts.get("gh")).toBe(1);
    // And it says what happened, rather than repeating the raw spawn error.
    expect(first.message).toContain("were not accepted");
    expect(first.message).toContain('Activate "gh" again');

    // The budget survived, so the NEXT explicit activate still gets to ask --
    // which is the point of not burning it inside the first one.
    const second = await withoutRetryBackoff(() => priv.activateOne("gh"));
    expect(second.ok).toBe(false);
    expect(priv.server.elicitInput).toHaveBeenCalledTimes(2);
    expect(priv.credentialPrompts.get("gh")).toBe(2);
    // That ask spent the last of the budget, so this one must NOT invite
    // another activate it would refuse to prompt for.
    expect(second.message).toContain("No further prompts");

    // Budget exhausted: no third modal.
    const third = await withoutRetryBackoff(() => priv.activateOne("gh"));
    expect(third.ok).toBe(false);
    expect(priv.server.elicitInput).toHaveBeenCalledTimes(2);
  });

  it("books the activation failure on the first activate, not only once the budget runs out", async () => {
    // The isElicitRetry branch RETURNS a result, and runActivateOne hands that
    // straight back -- above the give-up path that records the failure. So the
    // branch has to book it itself: formatHealthWarning (discover's
    // `warn: last activation failed` line) and healthFactor (dispatch routing)
    // both read activationFailures, and a namespace that cannot start looked
    // healthy to both until the whole prompt budget was spent.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh" })]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    priv.server.elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { GITHUB_TOKEN: "ghp_x" },
    });
    vi.mocked(connectToUpstream).mockRejectedValue(
      new ActivationError("boom", "unknown", "GITHUB_TOKEN is required\n"),
    );
    // A discover body memoized before the failure: the failure touches nothing
    // in the cache KEY, so only an explicit invalidation stops a re-discover
    // inside the 3s TTL replaying the pre-failure text.
    priv.discoverCache = { key: "k", result: { content: [] }, expires: Date.now() + 3000 };

    const first = await withoutRetryBackoff(() => priv.activateOne("gh"));

    expect(first.ok).toBe(false);
    expect(first.message).toContain("were not accepted");
    // Booked here, on the first activate -- the budget still has an ask left.
    expect(priv.credentialPrompts.get("gh")).toBe(1);
    expect(priv.activationFailures.get("gh")?.message).toBe("boom");
    expect(priv.discoverCache).toBeNull();
  });

  it("asks for a key the prompt never supplied instead of calling the supplied ones rejected", async () => {
    // A child that validates its keys SEQUENTIALLY rejects on
    // AWS_ACCESS_KEY_ID, then -- once that one is accepted -- on
    // AWS_SECRET_ACCESS_KEY. Keying the guard on isElicitRetry alone read that
    // second rejection as "the values just provided were not accepted", which
    // is false (the first one was accepted fine) and never asked for the key
    // it actually names. A key nobody has typed yet is new information, not a
    // byte-identical second modal, so it earns a normal budget-bounded ask.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "aws" })]);
    priv.server.getClientCapabilities = () => ({ elicitation: {} });
    const elicit = vi
      .fn()
      .mockResolvedValueOnce({ action: "accept", content: { AWS_ACCESS_KEY_ID: "AKIA" } })
      .mockResolvedValueOnce({ action: "accept", content: { AWS_SECRET_ACCESS_KEY: "s3cr3t" } });
    priv.server.elicitInput = elicit;
    const noKeyId = new ActivationError("boom", "unknown", "AWS_ACCESS_KEY_ID is required\n");
    const noSecret = new ActivationError("boom", "unknown", "AWS_SECRET_ACCESS_KEY is required\n");
    vi.mocked(connectToUpstream)
      // Both spawn attempts of the first pass want the key id.
      .mockRejectedValueOnce(noKeyId)
      .mockRejectedValueOnce(noKeyId)
      // The key id was accepted; the child now names the NEXT one.
      .mockRejectedValueOnce(noSecret)
      .mockRejectedValueOnce(noSecret)
      // Both supplied, so it starts.
      .mockImplementationOnce(async (cfg: UpstreamServerConfig) => makeConnection(cfg.namespace, ["t"]));

    const result = await withoutRetryBackoff(() => priv.activateOne("aws"));

    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("were not accepted");
    expect(elicit).toHaveBeenCalledTimes(2);
    // The second modal names the new key, not a re-run of the first.
    expect(elicit.mock.calls[1][0].requestedSchema.required).toEqual(["AWS_SECRET_ACCESS_KEY"]);
    // Both values survived into the env the working spawn was given.
    expect(priv.elicitedEnv.get("aws")).toEqual({
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "s3cr3t",
    });
    // Nothing was booked against a server that did, in the end, start.
    expect(priv.activationFailures.has("aws")).toBe(false);
  });
});

describe("discover match summary", () => {
  let server: ConnectServer;

  beforeEach(() => {
    vi.clearAllMocks();
    server = new ConnectServer();
  });

  afterEach(async () => {
    await server.shutdown();
  });

  it("does not surface unrelated tools for a stopword-laden context", () => {
    // The per-tool match is a bare set intersection with no IDF, so a query
    // carrying "the" / "with" hit every tool whose DESCRIPTION happened to
    // contain one -- and the 5-hit cap then filled with whatever came first in
    // list order, dropping the tool that genuinely matched.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", description: "Issue tracker" })]);
    priv.toolCache.set("gh", [
      { name: "list_runners", description: "List the self-hosted runners" },
      { name: "get_workflow", description: "Fetch the workflow definition" },
      { name: "list_branches", description: "Enumerate the branches with their heads" },
      { name: "read_file", description: "Read the file contents" },
      { name: "list_commits", description: "Walk the commit log with pagination" },
      { name: "create_issue", description: "Open a bug report" },
    ]);

    const text = priv.handleDiscover("create the issue with the label").content[0].text;
    const lines = text.split("\n");
    const header = lines.indexOf("Matches for your query:");
    expect(header).toBeGreaterThanOrEqual(0);
    const summary = lines[header + 1];

    // The one genuine hit is a NAME match on create/issue and survives.
    expect(summary).toContain("create_issue");
    // Every other tool matched only through a closed-class word. Asserting
    // each by name also catches the empty-hits fallback, which would return
    // the first three tools in list order.
    expect(summary).not.toContain("list_runners");
    expect(summary).not.toContain("get_workflow");
    expect(summary).not.toContain("list_branches");
    expect(summary).not.toContain("read_file");
    expect(summary).not.toContain("list_commits");
  });

  it("keeps a late NAME match when earlier tools already fill the 5-hit cap by description", () => {
    // The other half of the same fix: hits are collected in full and only
    // then capped, so a tool matching on NAME outranks five earlier tools
    // that merely mention the term in prose. Breaking out of the loop at
    // five dropped it purely for being last in list order.
    const priv = getPrivate(server);
    priv.config = makeConfig([makeServerConfig({ namespace: "gh", name: "GitHub", description: "Issue tracker" })]);
    priv.toolCache.set("gh", [
      { name: "list_runners", description: "Report an issue with a runner" },
      { name: "get_workflow", description: "Diagnose an issue in a workflow" },
      { name: "list_branches", description: "Find an issue branch" },
      { name: "read_file", description: "Locate an issue in a file" },
      { name: "list_commits", description: "Trace an issue to a commit" },
      { name: "create_issue", description: "Open a bug report" },
    ]);

    const text = priv.handleDiscover("issue").content[0].text;
    const lines = text.split("\n");
    const header = lines.indexOf("Matches for your query:");
    expect(header).toBeGreaterThanOrEqual(0);
    const summary = lines[header + 1];

    // Last in list order, first in the summary.
    expect(summary).toContain("create_issue");
    // The cap still applies -- five hits, so the last description-only match
    // is the one that falls off, not the name match.
    expect(summary).not.toContain("list_commits");
  });
});
