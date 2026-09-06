import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { META_TOOLS } from "../meta-tools.js";
import {
  type BuiltinResource,
  buildPromptList,
  buildPromptRoutes,
  buildResourceList,
  buildResourceRoutes,
  buildToolList,
  buildToolRoutes,
  isRoutingFaultResult,
  type PromptRoute,
  type ResourceRoute,
  routePromptGet,
  routeResourceRead,
  routeToolCall,
} from "../proxy.js";
import type { UpstreamConnection, UpstreamServerConfig } from "../types.js";

function makeInactiveServer(
  namespace: string,
  cachedTools: Array<{ name: string; description?: string }>,
): UpstreamServerConfig {
  return {
    id: `id-${namespace}`,
    name: namespace,
    namespace,
    type: "local",
    isActive: true,
    toolCache: cachedTools,
  };
}

function makeConnection(
  namespace: string,
  tools: string[],
  resources: string[] = [],
  prompts: string[] = [],
): UpstreamConnection {
  return {
    config: { id: "1", name: namespace, namespace, type: "local", isActive: true },
    client: {} as any,
    transport: {} as any,
    tools: tools.map((name) => ({
      name,
      namespacedName: `${namespace}_${name}`,
      inputSchema: { type: "object" },
    })),
    resources: resources.map((uri) => ({
      uri,
      namespacedUri: `connect://${namespace}/${uri}`,
      name: uri,
    })),
    prompts: prompts.map((name) => ({
      name,
      namespacedName: `${namespace}_${name}`,
    })),
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0 },
    status: "connected",
  } as UpstreamConnection;
}

/** Run `fn` with process.stderr.write captured, returning every line the
 *  logger wrote alongside whatever `fn` returned. The real writer is restored
 *  even when `fn` throws.
 *
 *  Assertions belong AFTER the call, not inside `fn`: a failing expect while
 *  stderr is monkey-patched swallows the diff vitest would otherwise print.
 *  Pair it with a pinned LOG_LEVEL -- log() consults the env var per call, so
 *  an ambient LOG_LEVEL=error makes a "warns" assertion fail and a "does NOT
 *  warn" assertion pass for the wrong reason. */
function withCapturedStderr<T>(fn: () => T): { writes: string[]; value: T } {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  try {
    return { writes, value: fn() };
  } finally {
    process.stderr.write = original;
  }
}

/** withCapturedStderr for an async `fn`: the sync form restores the writer as
 *  soon as `fn` RETURNS, which for a promise is before any of the awaited
 *  work has logged anything. */
async function withCapturedStderrAsync<T>(fn: () => Promise<T>): Promise<{ writes: string[]; value: T }> {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  try {
    return { writes, value: await fn() };
  } finally {
    process.stderr.write = original;
  }
}

/** Pin LOG_LEVEL for a describe whose assertions read captured stderr. */
function pinLogLevel(): void {
  beforeEach(() => {
    vi.stubEnv("LOG_LEVEL", "warn");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
}

describe("buildToolList", () => {
  it("includes meta-tools first", () => {
    const connections = new Map<string, UpstreamConnection>();
    const tools = buildToolList(connections);
    const metaNames = Object.values(META_TOOLS).map((m) => m.name);
    expect(tools.length).toBe(metaNames.length);
    for (const name of metaNames) {
      expect(tools.some((t) => t.name === name)).toBe(true);
    }
  });

  it("includes upstream tools after meta-tools", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["create_issue", "list_prs"]));
    const tools = buildToolList(connections);
    const metaCount = Object.keys(META_TOOLS).length;
    expect(tools.length).toBe(metaCount + 2);
    expect(tools[metaCount].name).toBe("gh_create_issue");
    expect(tools[metaCount + 1].name).toBe("gh_list_prs");
  });

  it("includes tools from multiple connections", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["create_issue"]));
    connections.set("slack", makeConnection("slack", ["send_message"]));
    const tools = buildToolList(connections);
    const metaCount = Object.keys(META_TOOLS).length;
    expect(tools.length).toBe(metaCount + 2);
  });

  it("forwards title, outputSchema and _meta from upstream tool defs", () => {
    const conn = makeConnection("srv", ["structured"]);
    conn.tools[0].title = "Structured Tool";
    conn.tools[0].outputSchema = { type: "object", properties: { ok: { type: "boolean" } } };
    conn.tools[0]._meta = { "example.com/k": 1 };
    const connections = new Map<string, UpstreamConnection>([["srv", conn]]);

    const tools = buildToolList(connections);
    const entry = tools.find((t) => t.name === "srv_structured");
    expect(entry).toBeDefined();
    // The structured-output contract must survive the proxy: routeToolCall
    // passes structuredContent through verbatim, so the advertised schema
    // has to travel with the tool for clients to validate against.
    expect(entry?.title).toBe("Structured Tool");
    expect(entry?.outputSchema).toEqual({ type: "object", properties: { ok: { type: "boolean" } } });
    expect(entry?._meta).toEqual({ "example.com/k": 1 });
  });
});

describe("buildToolRoutes", () => {
  it("maps namespaced names to original names", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["create_issue"]));
    const routes = buildToolRoutes(connections);
    expect(routes.get("gh_create_issue")).toEqual({ namespace: "gh", originalName: "create_issue" });
  });

  it("handles multiple connections", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["create_issue"]));
    connections.set("slack", makeConnection("slack", ["send_message"]));
    const routes = buildToolRoutes(connections);
    expect(routes.size).toBe(2);
    expect(routes.get("slack_send_message")).toEqual({ namespace: "slack", originalName: "send_message" });
  });
});

describe("buildToolList — deferred tools from inactive-but-cached servers", () => {
  it("emits deferred entries with a permissive placeholder schema", () => {
    const connections = new Map<string, UpstreamConnection>();
    const inactive = [makeInactiveServer("gh", [{ name: "create_issue", description: "open a new issue" }])];
    const tools = buildToolList(connections, inactive);
    const entry = tools.find((t) => t.name === "gh_create_issue");
    expect(entry).toBeDefined();
    // Permissive placeholder — the upstream's real schema is unknown
    // until first activation, so any-object is the safest stand-in.
    expect(entry?.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: true });
    // Cached description is preserved; a bracketed yaw-mcp note is appended
    // so the client knows activation hasn't happened yet.
    expect(entry?.description).toContain("open a new issue");
    expect(entry?.description).toContain("not yet connected");
  });

  it("an active connection with the same namespace wins over a deferred entry", () => {
    // Safety rail: if a server's real tool set exposes create_issue AND
    // its cached tools also include create_issue, the LIVE definition
    // (real inputSchema, real description) must not be shadowed by a
    // placeholder — clients would see their valid call fail validation.
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["create_issue"]));
    const inactive = [makeInactiveServer("gh", [{ name: "create_issue", description: "stale cached version" }])];
    const tools = buildToolList(connections, inactive);
    const ghTools = tools.filter((t) => t.name === "gh_create_issue");
    expect(ghTools.length).toBe(1);
    // The live schema { type: "object" } from makeConnection, not the
    // placeholder — ensures we didn't overwrite.
    expect(ghTools[0].inputSchema).toEqual({ type: "object" });
  });

  it("stands the activation note alone when the cached tool has no description", () => {
    // The other half of deferredDescription: with nothing to prepend, the
    // note must be the WHOLE description -- not "undefined\n\n[note]", and
    // not a leading blank line. A whitespace-only cached description takes
    // the same path (the `.trim()` is what makes it falsy).
    const bare = buildToolList(new Map(), [makeInactiveServer("gh", [{ name: "create_issue" }])]);
    const bareEntry = bare.find((t) => t.name === "gh_create_issue");
    expect(bareEntry?.description).toBe('[yaw-mcp: server "gh" not yet connected — first call activates it]');

    const blank = buildToolList(new Map(), [makeInactiveServer("gh", [{ name: "create_issue", description: "  " }])]);
    expect(blank.find((t) => t.name === "gh_create_issue")?.description).toBe(bareEntry?.description);
  });

  it("emits ONE entry when two INACTIVE servers flatten to the same name", () => {
    // buildToolRoutes warns about this pair and keeps the first cached
    // server; the LIST has to agree, or the client is shown a placeholder
    // belonging to a namespace dispatch will never reach.
    const tools = buildToolList(new Map(), [
      makeInactiveServer("gh", [{ name: "actions_list", description: "first-cached" }]),
      makeInactiveServer("gh_actions", [{ name: "list", description: "second-cached" }]),
    ]);
    const collided = tools.filter((t) => t.name === "gh_actions_list");
    expect(collided).toHaveLength(1);
    expect(collided[0].description).toContain("first-cached");
    expect(collided[0].description).not.toContain("second-cached");
  });

  it("skips inactive servers whose toolCache is missing or empty", () => {
    const connections = new Map<string, UpstreamConnection>();
    const inactive: UpstreamServerConfig[] = [
      { id: "a", name: "a", namespace: "a", type: "local", isActive: true },
      { id: "b", name: "b", namespace: "b", type: "local", isActive: true, toolCache: [] },
    ];
    const tools = buildToolList(connections, inactive);
    const meta = Object.keys(META_TOOLS).length;
    expect(tools.length).toBe(meta);
  });
});

describe("buildToolList — tool filters", () => {
  it("applies a namespace filter to ACTIVE tools", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["create_issue", "list_prs"]));
    const filters = new Map([["gh", new Set(["create_issue"])]]);
    const tools = buildToolList(connections, [], filters);
    expect(tools.some((t) => t.name === "gh_create_issue")).toBe(true);
    expect(tools.some((t) => t.name === "gh_list_prs")).toBe(false);
  });

  it("applies the SAME filter to deferred entries from an idle server", () => {
    // Without this, a filtered-out tool reappears in tools/list the moment
    // its server goes idle: the deferred branch would advertise the full
    // cached set while the filter still applies to the live one.
    const connections = new Map<string, UpstreamConnection>();
    const inactive = [makeInactiveServer("gh", [{ name: "create_issue" }, { name: "list_prs" }])];
    const filters = new Map([["gh", new Set(["create_issue"])]]);
    const tools = buildToolList(connections, inactive, filters);
    expect(tools.some((t) => t.name === "gh_create_issue")).toBe(true);
    expect(tools.some((t) => t.name === "gh_list_prs")).toBe(false);
  });

  it("leaves an unfiltered namespace's deferred entries alone", () => {
    const connections = new Map<string, UpstreamConnection>();
    const inactive = [makeInactiveServer("slack", [{ name: "send_message" }])];
    const filters = new Map([["gh", new Set(["create_issue"])]]);
    const tools = buildToolList(connections, inactive, filters);
    expect(tools.some((t) => t.name === "slack_send_message")).toBe(true);
  });
});

describe("buildToolList — cross-namespace name collisions", () => {
  it("emits ONE entry when two active namespaces flatten to the same name", () => {
    // (ns=`gh`, tool=`actions_list`) and (ns=`gh_actions`, tool=`list`) both
    // render as `gh_actions_list`. MCP tool names must be unique, so the
    // list must not carry the name twice.
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["actions_list"]));
    connections.set("gh_actions", makeConnection("gh_actions", ["list"]));
    const tools = buildToolList(connections);
    expect(tools.filter((t) => t.name === "gh_actions_list")).toHaveLength(1);
    expect(tools).toHaveLength(Object.keys(META_TOOLS).length + 1);
  });

  it("does not let an upstream tool duplicate a meta-tool name", () => {
    const metaName = Object.values(META_TOOLS)[0].name;
    const connections = new Map<string, UpstreamConnection>();
    // Craft a connection whose namespaced name IS a meta-tool name.
    const conn = makeConnection("ns", ["x"]);
    conn.tools[0].namespacedName = metaName;
    connections.set("ns", conn);
    const tools = buildToolList(connections);
    expect(tools.filter((t) => t.name === metaName)).toHaveLength(1);
  });
});

describe("buildToolRoutes — deferred routes", () => {
  pinLogLevel();

  it("marks deferred: true for routes generated from toolCache", () => {
    const connections = new Map<string, UpstreamConnection>();
    const inactive = [makeInactiveServer("gh", [{ name: "create_issue" }])];
    const routes = buildToolRoutes(connections, inactive);
    const route = routes.get("gh_create_issue");
    expect(route).toEqual({ namespace: "gh", originalName: "create_issue", deferred: true });
  });

  it("an active route takes precedence over a deferred one for the same name", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["create_issue"]));
    const inactive = [makeInactiveServer("gh", [{ name: "create_issue" }])];
    const routes = buildToolRoutes(connections, inactive);
    const route = routes.get("gh_create_issue");
    // No deferred flag — the active route wins. Without this rule a
    // tools/call on a live tool could get routed through the deferred
    // branch and activateOne would be called on an already-connected
    // server, racing with the real dispatch.
    expect(route?.deferred).toBeUndefined();
    expect(route?.namespace).toBe("gh");
    expect(route?.originalName).toBe("create_issue");
  });

  it("warns when two DEFERRED servers collide on the same namespaced name", () => {
    // First cached server wins; the loser's tool is unreachable until an
    // operator renames a namespace, so the collision must not be silent.
    // (The active-vs-deferred case above is intended shadowing -- no warn.)
    const { writes, value: routes } = withCapturedStderr(() =>
      buildToolRoutes(new Map(), [
        makeInactiveServer("gh", [{ name: "actions_list" }]),
        makeInactiveServer("gh_actions", [{ name: "list" }]),
      ]),
    );
    // First writer wins.
    expect(routes.get("gh_actions_list")).toEqual({
      namespace: "gh",
      originalName: "actions_list",
      deferred: true,
    });
    expect(writes.some((w) => w.includes("Deferred tool route collision"))).toBe(true);
  });

  it("does NOT warn when an active route shadows a deferred one", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["actions_list"]));
    const { writes } = withCapturedStderr(() =>
      buildToolRoutes(connections, [makeInactiveServer("gh_actions", [{ name: "list" }])]),
    );
    expect(writes.some((w) => w.includes("collision"))).toBe(false);
  });
});

describe("buildToolRoutes — active-vs-active collisions", () => {
  pinLogLevel();

  it("warns when two LIVE upstreams flatten to the same namespaced name", () => {
    // (ns=`gh`, tool=`actions_list`) and (ns=`gh_actions`, tool=`list`) both
    // render `gh_actions_list`. This used to be silent, so an operator had no
    // way to know one upstream's tool had become unreachable.
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", ["actions_list"]));
    connections.set("gh_actions", makeConnection("gh_actions", ["list"]));
    const { writes, value: routes } = withCapturedStderr(() => buildToolRoutes(connections));
    const warning = writes.find((w) => w.includes("Tool route collision"));
    expect(warning).toBeDefined();
    // Both sides are named so the operator knows which namespace to rename.
    expect(warning).toContain("gh_actions_list");
    expect(warning).toContain("gh_actions");
    // FIRST writer wins, and it must be the SAME winner buildToolList
    // picks. Regression guard: routes used to be last-writer-wins while
    // buildToolList's `seen` guard is first-writer-wins, so a collision
    // meant the model was shown `gh`'s description + inputSchema while a
    // call dispatched to `gh_actions` -- schema and execution pointing at
    // two different upstreams, with a later-activated server able to
    // capture an earlier one's traffic.
    expect(routes.get("gh_actions_list")).toEqual({ namespace: "gh", originalName: "actions_list" });
    expect(routes.size).toBe(1);

    // Pin the AGREEMENT itself, not just each side's value: whatever
    // tools/list advertises must be what dispatch resolves to. Tag each
    // upstream's inputSchema so the advertised entry is attributable --
    // the two tools are otherwise indistinguishable once flattened.
    const ghConn = connections.get("gh") as UpstreamConnection;
    const actionsConn = connections.get("gh_actions") as UpstreamConnection;
    ghConn.tools[0].inputSchema = { type: "object", properties: { from: { const: "gh" } } };
    actionsConn.tools[0].inputSchema = { type: "object", properties: { from: { const: "gh_actions" } } };

    const advertised = buildToolList(connections);
    const collided = advertised.filter((t) => t.name === "gh_actions_list");
    expect(collided).toHaveLength(1);
    const advertisedFrom = (collided[0].inputSchema as { properties: { from: { const: string } } }).properties.from
      .const;
    // Same namespace on both surfaces. Fails if either flips independently.
    expect(advertisedFrom).toBe("gh");
    // Captured too: the rebuild warns a second time, and that line is noise
    // in the run's real stderr, not part of what this test asserts.
    const { value: rebuilt } = withCapturedStderr(() => buildToolRoutes(connections));
    expect(rebuilt.get("gh_actions_list")?.namespace).toBe(advertisedFrom);
  });

  it("does NOT warn when one connection repeats a namespaced name against itself", () => {
    // Same namespace on both sides is not an operator-fixable collision --
    // there is no second upstream to rename -- so it must stay quiet.
    const conn = makeConnection("gh", ["list", "list_dup"]);
    conn.tools[1].namespacedName = "gh_list";
    const { writes } = withCapturedStderr(() => buildToolRoutes(new Map([["gh", conn]])));
    expect(writes.some((w) => w.includes("collision"))).toBe(false);
  });
});

describe("buildResourceList / buildResourceRoutes", () => {
  it("lists resources with namespaced URIs", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("db", makeConnection("db", [], ["db://tables"]));
    const resources = buildResourceList(connections);
    expect(resources.length).toBe(1);
    expect(resources[0].uri).toBe("connect://db/db://tables");
  });

  it("builds resource routes", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("db", makeConnection("db", [], ["db://tables"]));
    const routes = buildResourceRoutes(connections);
    expect(routes.get("connect://db/db://tables")).toEqual({ namespace: "db", originalUri: "db://tables" });
  });
});

describe("buildResourceList / buildResourceRoutes — duplicate uris", () => {
  // The resource path used to be the odd one out: no `seen` guard on the list
  // and last-writer-wins with no warning on the routes, while the tool and
  // prompt paths suppressed the duplicate and named both sides.
  pinLogLevel();

  it("emits ONE entry when an upstream lists the same uri twice", () => {
    const connections = new Map([["db", makeConnection("db", [], ["db://tables", "db://tables"])]]);
    const list = buildResourceList(connections);
    expect(list.filter((r) => r.uri === "connect://db/db://tables")).toHaveLength(1);
  });

  it("does NOT warn when one upstream repeats its own uri", () => {
    // Nothing an operator could rename, so it must stay quiet -- same rule
    // the tool and prompt routes follow for a self-collision.
    const connections = new Map([["db", makeConnection("db", [], ["db://tables", "db://tables"])]]);
    const { writes, value: routes } = withCapturedStderr(() => buildResourceRoutes(connections));
    expect(routes.size).toBe(1);
    expect(writes.some((w) => w.includes("collision"))).toBe(false);
  });

  it("warns and keeps the FIRST upstream when two namespaces flatten to one uri", () => {
    // `connect://${namespace}/${uri}` flattens just like the tool and prompt
    // names do: (ns=`db`, uri=`x/y`) and (ns=`db/x`, uri=`y`) both render
    // `connect://db/x/y`.
    const connections = new Map<string, UpstreamConnection>();
    connections.set("db", makeConnection("db", [], ["x/y"]));
    connections.set("db/x", makeConnection("db/x", [], ["y"]));
    const { writes, value: routes } = withCapturedStderr(() => buildResourceRoutes(connections));
    expect(routes.get("connect://db/x/y")).toEqual({ namespace: "db", originalUri: "x/y" });
    expect(routes.size).toBe(1);
    const warning = writes.find((w) => w.includes("Resource route collision"));
    // Both sides named so the operator knows which namespace to rename.
    // Keyed, not a bare substring: "db/x" also occurs inside the uri.
    expect(warning).toBeDefined();
    expect(warning).toContain("connect://db/x/y");
    expect(warning).toContain('"keptNamespace":"db"');
    expect(warning).toContain('"ignoredNamespace":"db/x"');
    // Both surfaces agree on the winner, same contract as tools and prompts.
    expect(buildResourceList(connections).filter((r) => r.uri === "connect://db/x/y")).toHaveLength(1);
  });

  it("a builtin uri shadows an upstream that published the same string", () => {
    // routeResourceRead already serves the builtin for a colliding uri; the
    // list has to agree, or the client sees the uri twice and can only read
    // one of them.
    const conn = makeConnection("ns", [], ["guide"]);
    conn.resources[0].namespacedUri = "yaw-mcp://guide";
    conn.resources[0].name = "impostor";
    const builtin: BuiltinResource = { uri: "yaw-mcp://guide", name: "yaw-mcp guide", read: () => ({ contents: [] }) };
    const list = buildResourceList(new Map([["ns", conn]]), [builtin]);
    expect(list.filter((r) => r.uri === "yaw-mcp://guide")).toHaveLength(1);
    expect(list[0].name).toBe("yaw-mcp guide");
  });
});

describe("buildResourceList — builtins", () => {
  const guideBuiltin: BuiltinResource = {
    uri: "yaw-mcp://guide",
    name: "yaw-mcp guide",
    description: "Project + user guidance from YAW-MCP.md",
    mimeType: "text/markdown",
    read: async () => ({ contents: [{ uri: "yaw-mcp://guide", text: "hello", mimeType: "text/markdown" }] }),
  };

  it("returns just builtins when no upstream connections exist", () => {
    const resources = buildResourceList(new Map(), [guideBuiltin]);
    expect(resources).toEqual([
      {
        uri: "yaw-mcp://guide",
        name: "yaw-mcp guide",
        description: "Project + user guidance from YAW-MCP.md",
        mimeType: "text/markdown",
      },
    ]);
  });

  it("lists builtins BEFORE upstream resources", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("db", makeConnection("db", [], ["db://tables"]));
    const resources = buildResourceList(connections, [guideBuiltin]);
    expect(resources.length).toBe(2);
    expect(resources[0].uri).toBe("yaw-mcp://guide");
    expect(resources[1].uri).toBe("connect://db/db://tables");
  });

  it("omits builtins when none are passed (back-compat)", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("db", makeConnection("db", [], ["db://tables"]));
    const resources = buildResourceList(connections);
    expect(resources.length).toBe(1);
    expect(resources[0].uri).toBe("connect://db/db://tables");
  });
});

describe("routeResourceRead — builtins", () => {
  it("serves a builtin from the builtins map without touching upstream", async () => {
    const builtins = new Map<string, BuiltinResource>();
    builtins.set("yaw-mcp://guide", {
      uri: "yaw-mcp://guide",
      read: () => ({ contents: [{ uri: "yaw-mcp://guide", text: "guide-body" }] }),
    });
    const result = await routeResourceRead("yaw-mcp://guide", new Map(), new Map(), builtins);
    expect(result.contents[0].text).toBe("guide-body");
  });

  it("awaits an async builtin reader", async () => {
    const builtins = new Map<string, BuiltinResource>();
    builtins.set("yaw-mcp://guide", {
      uri: "yaw-mcp://guide",
      read: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return { contents: [{ uri: "yaw-mcp://guide", text: "async-body" }] };
      },
    });
    const result = await routeResourceRead("yaw-mcp://guide", new Map(), new Map(), builtins);
    expect(result.contents[0].text).toBe("async-body");
  });

  it("returns a graceful error text when a builtin reader throws (does NOT propagate)", async () => {
    const builtins = new Map<string, BuiltinResource>();
    builtins.set("yaw-mcp://guide", {
      uri: "yaw-mcp://guide",
      read: () => {
        throw new Error("read exploded");
      },
    });
    // An MCP client that gets a thrown exception here would see a
    // generic JSON-RPC failure; by returning a text body we can surface
    // the actual error to the user without crashing the session.
    const result = await routeResourceRead("yaw-mcp://guide", new Map(), new Map(), builtins);
    expect(result.contents[0].text).toContain("read exploded");
  });

  it("falls through to upstream routing when URI is not a builtin", async () => {
    const builtins = new Map<string, BuiltinResource>();
    builtins.set("yaw-mcp://guide", {
      uri: "yaw-mcp://guide",
      read: () => ({ contents: [{ uri: "yaw-mcp://guide", text: "builtin" }] }),
    });
    // No matching upstream route either → the "Unknown resource" text path.
    const result = await routeResourceRead("connect://unknown/x", new Map(), new Map(), builtins);
    expect(result.contents[0].text).toContain("Unknown resource");
  });

  it("works with undefined builtins (back-compat)", async () => {
    const result = await routeResourceRead("yaw-mcp://guide", new Map(), new Map());
    // No builtins, no upstream route → unknown resource.
    expect(result.contents[0].text).toContain("Unknown resource");
  });

  it("builtin takes precedence even when an upstream resource has the same URI", async () => {
    // An upstream server accidentally registers `yaw-mcp://guide` as one of
    // its resources. The builtin should still win — yaw-mcp is canonical
    // for its own namespace.
    const connections = new Map<string, UpstreamConnection>();
    const fakeClient = {
      readResource: async () => ({ contents: [{ uri: "yaw-mcp://guide", text: "upstream-body" }] }),
    };
    const conn = makeConnection("evil", [], ["yaw-mcp://guide"]);
    (conn as any).client = fakeClient;
    connections.set("evil", conn);

    const routes = new Map();
    routes.set("yaw-mcp://guide", { namespace: "evil", originalUri: "yaw-mcp://guide" });

    const builtins = new Map<string, BuiltinResource>();
    builtins.set("yaw-mcp://guide", {
      uri: "yaw-mcp://guide",
      read: () => ({ contents: [{ uri: "yaw-mcp://guide", text: "builtin-body" }] }),
    });

    const result = await routeResourceRead("yaw-mcp://guide", routes, connections, builtins);
    expect(result.contents[0].text).toBe("builtin-body");
  });
});

describe("routeResourceRead — upstream routing", () => {
  // Resource reads are where an upstream payload reaches the model, so every
  // arm here has to end in a well-formed ResourceContents rather than a throw:
  // an exception becomes an opaque JSON-RPC failure at the client, which tells
  // the user nothing about which server broke or why.
  const NAMESPACED = "connect://db/db://tables";

  function connectedWith(client: unknown, status: UpstreamConnection["status"] = "connected"): UpstreamConnection {
    const conn = makeConnection("db", [], ["db://tables"]);
    (conn as any).client = client;
    conn.status = status;
    return conn;
  }

  it("forwards the ORIGINAL (de-namespaced) uri upstream and returns its payload", async () => {
    const seen: string[] = [];
    const conn = connectedWith({
      readResource: async ({ uri }: { uri: string }) => {
        seen.push(uri);
        return { contents: [{ uri: "db://tables", text: "rows", mimeType: "text/plain" }] };
      },
    });
    const connections = new Map([["db", conn]]);
    const result = await routeResourceRead(NAMESPACED, buildResourceRoutes(connections), connections);
    // The upstream has never heard of yaw-mcp's `connect://` prefix; sending
    // it would look like a request for a resource the server does not have.
    expect(seen).toEqual(["db://tables"]);
    // ...and the reply is re-namespaced on the way back out. The upstream's
    // raw uri is a string the client cannot read again -- resources/list, the
    // route table and this function's own error arms all speak the
    // `connect://<ns>/<uri>` form.
    expect(result.contents).toEqual([{ uri: "connect://db/db://tables", text: "rows", mimeType: "text/plain" }]);
    // The guarantee that matters: whatever uri came back is resolvable.
    expect(buildResourceRoutes(connections).has(result.contents[0].uri)).toBe(true);
  });

  it("namespaces EVERY returned entry, not just the one the client asked for", async () => {
    // A read may legitimately answer with several sub-resources, so blindly
    // rewriting all of them to the requested uri would lose which is which.
    const conn = connectedWith({
      readResource: async () => ({
        contents: [
          { uri: "db://tables", text: "index" },
          { uri: "db://tables/users", text: "users" },
        ],
      }),
    });
    const connections = new Map([["db", conn]]);
    const result = await routeResourceRead(NAMESPACED, buildResourceRoutes(connections), connections);
    expect(result.contents.map((c) => c.uri)).toEqual(["connect://db/db://tables", "connect://db/db://tables/users"]);
    // Bodies ride through untouched -- only the uri is rewritten.
    expect(result.contents.map((c) => c.text)).toEqual(["index", "users"]);
  });

  it("does not fuzzy-match: a near-miss uri is Unknown even with a populated route table", async () => {
    const connections = new Map([["db", connectedWith({ readResource: async () => ({ contents: [] }) })]]);
    const result = await routeResourceRead(`${NAMESPACED}/extra`, buildResourceRoutes(connections), connections);
    expect(result.contents).toEqual([{ uri: `${NAMESPACED}/extra`, text: `Unknown resource: ${NAMESPACED}/extra` }]);
  });

  it("reports not-connected when the route's namespace has no connection at all", async () => {
    // Reachable in normal operation: resourceRoutes are rebuilt on connection
    // change, so a resources/read in flight can land after the server went
    // away and find a route pointing at a namespace that is gone.
    const routes = new Map<string, ResourceRoute>([[NAMESPACED, { namespace: "db", originalUri: "db://tables" }]]);
    const result = await routeResourceRead(NAMESPACED, routes, new Map());
    expect(result.contents).toEqual([{ uri: NAMESPACED, text: 'Server "db" is not connected.' }]);
  });

  it("reports not-connected for a connection that exists but is disconnected or errored", async () => {
    for (const status of ["disconnected", "error"] as const) {
      // A reader that resolves with a recognisable body: if the status guard
      // ever stopped short-circuiting, that body would show up below.
      const conn = connectedWith(
        { readResource: async () => ({ contents: [{ uri: "db://tables", text: "LEAKED" }] }) },
        status,
      );
      const connections = new Map([["db", conn]]);
      const result = await routeResourceRead(NAMESPACED, buildResourceRoutes(connections), connections);
      expect(result.contents).toEqual([{ uri: NAMESPACED, text: 'Server "db" is not connected.' }]);
    }
  });

  it("returns an Error body (keyed to the uri the CLIENT asked for) when the upstream read rejects", async () => {
    const conn = connectedWith({
      readResource: async () => {
        throw new Error("table vanished");
      },
    });
    const connections = new Map([["db", conn]]);
    const result = await routeResourceRead(NAMESPACED, buildResourceRoutes(connections), connections);
    // Namespaced uri, not route.originalUri -- the client indexes the reply
    // by the uri it sent.
    expect(result.contents).toEqual([{ uri: NAMESPACED, text: "Error: table vanished" }]);
  });

  it("stringifies a non-Error rejection instead of rendering it as undefined", async () => {
    const conn = connectedWith({ readResource: () => Promise.reject("upstream closed the pipe") });
    const connections = new Map([["db", conn]]);
    const result = await routeResourceRead(NAMESPACED, buildResourceRoutes(connections), connections);
    expect(result.contents).toEqual([{ uri: NAMESPACED, text: "Error: upstream closed the pipe" }]);
  });
});

describe("buildPromptList / buildPromptRoutes", () => {
  it("lists prompts with namespaced names", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", [], [], ["review_pr"]));
    const prompts = buildPromptList(connections);
    expect(prompts.length).toBe(1);
    expect(prompts[0].name).toBe("gh_review_pr");
  });

  it("builds prompt routes", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", [], [], ["review_pr"]));
    const routes = buildPromptRoutes(connections);
    expect(routes.get("gh_review_pr")).toEqual({ namespace: "gh", originalName: "review_pr" });
  });
});

describe("buildPromptList / buildPromptRoutes — cross-namespace name collisions", () => {
  // Prompts flatten exactly like tools: `${namespace}_${prompt}`, so
  // (ns=`gh`, prompt=`review_pr`) and (ns=`gh_review`, prompt=`pr`) both
  // render `gh_review_pr`. Underscore-bearing namespaces are real in this
  // product (e.g. `mcp_hosting`), so this is reachable, not theoretical.
  pinLogLevel();

  function collidingConnections(): Map<string, UpstreamConnection> {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("gh", makeConnection("gh", [], [], ["review_pr"]));
    connections.set("gh_review", makeConnection("gh_review", [], [], ["pr"]));
    return connections;
  }

  it("emits ONE entry when two active namespaces flatten to the same prompt name", () => {
    const prompts = buildPromptList(collidingConnections());
    expect(prompts.filter((p) => p.name === "gh_review_pr")).toHaveLength(1);
    expect(prompts).toHaveLength(1);
  });

  it("warns and keeps the FIRST upstream, and both surfaces agree on it", () => {
    const connections = collidingConnections();
    const { writes, value: routes } = withCapturedStderr(() => buildPromptRoutes(connections));
    const warning = writes.find((w) => w.includes("Prompt route collision"));
    // Silent before: an operator had no way to know one upstream's prompt
    // had become unreachable. Both sides are named so they know which
    // namespace to rename.
    expect(warning).toBeDefined();
    expect(warning).toContain("gh_review_pr");
    expect(warning).toContain("gh_review");

    // FIRST writer wins, matching buildPromptList's `seen` guard. Routes
    // used to be last-writer-wins, so a collision meant the client picked
    // the prompt it saw from `gh` and prompts/get executed `gh_review`'s --
    // and a later-activated server could capture an earlier one's traffic.
    expect(routes.get("gh_review_pr")).toEqual({ namespace: "gh", originalName: "review_pr" });
    expect(routes.size).toBe(1);

    // Pin the AGREEMENT itself, not just each side's value. Tag each
    // upstream's description so the advertised entry is attributable --
    // the two prompts are otherwise indistinguishable once flattened.
    (connections.get("gh") as UpstreamConnection).prompts[0].description = "from gh";
    (connections.get("gh_review") as UpstreamConnection).prompts[0].description = "from gh_review";

    const advertised = buildPromptList(connections).filter((p) => p.name === "gh_review_pr");
    expect(advertised).toHaveLength(1);
    expect(advertised[0].description).toBe("from gh");
    // Captured too: the rebuild warns again, and that line is noise in the
    // run's real stderr rather than part of what this test asserts.
    const { value: rebuilt } = withCapturedStderr(() => buildPromptRoutes(connections));
    expect(rebuilt.get("gh_review_pr")?.namespace).toBe("gh");
  });

  it("does NOT warn when one connection repeats a namespaced prompt name against itself", () => {
    // No second upstream to rename, so there is nothing an operator could fix.
    const conn = makeConnection("gh", [], [], ["review_pr", "review_pr_dup"]);
    conn.prompts[1].namespacedName = "gh_review_pr";
    const { writes } = withCapturedStderr(() => buildPromptRoutes(new Map([["gh", conn]])));
    expect(writes.some((w) => w.includes("collision"))).toBe(false);
  });
});

describe("routePromptGet", () => {
  // Same contract as routeResourceRead: every failure arm answers with a
  // well-formed messages[] carrying the reason, never a throw.
  function connectedWith(client: unknown, status: UpstreamConnection["status"] = "connected"): UpstreamConnection {
    const conn = makeConnection("gh", [], [], ["review_pr"]);
    (conn as any).client = client;
    conn.status = status;
    return conn;
  }

  it("forwards the ORIGINAL name plus the arguments and returns the upstream messages", async () => {
    const seen: Array<{ name: string; arguments?: Record<string, string> }> = [];
    const conn = connectedWith({
      getPrompt: async (req: { name: string; arguments?: Record<string, string> }) => {
        seen.push(req);
        return { messages: [{ role: "assistant", content: { type: "text", text: "review it" } }] };
      },
    });
    const connections = new Map([["gh", conn]]);
    const result = await routePromptGet("gh_review_pr", { pr: "42" }, buildPromptRoutes(connections), connections);
    // De-namespaced name, arguments passed straight through.
    expect(seen).toEqual([{ name: "review_pr", arguments: { pr: "42" } }]);
    expect(result.messages).toEqual([{ role: "assistant", content: { type: "text", text: "review it" } }]);
  });

  it("returns an Unknown prompt message for a name with no route", async () => {
    const result = await routePromptGet("nope", undefined, new Map(), new Map());
    expect(result.messages).toEqual([{ role: "user", content: { type: "text", text: "Unknown prompt: nope" } }]);
  });

  it("reports not-connected when the route's namespace has no connection at all", async () => {
    const routes = new Map<string, PromptRoute>([["gh_review_pr", { namespace: "gh", originalName: "review_pr" }]]);
    const result = await routePromptGet("gh_review_pr", undefined, routes, new Map());
    expect(result.messages).toEqual([
      { role: "user", content: { type: "text", text: 'Server "gh" is not connected.' } },
    ]);
  });

  it("reports not-connected for a connection that exists but is disconnected or errored", async () => {
    for (const status of ["disconnected", "error"] as const) {
      const conn = connectedWith(
        { getPrompt: async () => ({ messages: [{ role: "user", content: { type: "text", text: "LEAKED" } }] }) },
        status,
      );
      const connections = new Map([["gh", conn]]);
      const result = await routePromptGet("gh_review_pr", undefined, buildPromptRoutes(connections), connections);
      expect(result.messages[0].content.text).toBe('Server "gh" is not connected.');
    }
  });

  it("returns an Error message instead of throwing when the upstream getPrompt rejects", async () => {
    const conn = connectedWith({
      getPrompt: async () => {
        throw new Error("prompt gone");
      },
    });
    const connections = new Map([["gh", conn]]);
    const result = await routePromptGet("gh_review_pr", undefined, buildPromptRoutes(connections), connections);
    expect(result.messages).toEqual([{ role: "user", content: { type: "text", text: "Error: prompt gone" } }]);
  });

  it("stringifies a non-Error rejection instead of rendering it as undefined", async () => {
    const conn = connectedWith({ getPrompt: () => Promise.reject("transport closed") });
    const connections = new Map([["gh", conn]]);
    const result = await routePromptGet("gh_review_pr", undefined, buildPromptRoutes(connections), connections);
    expect(result.messages[0].content.text).toBe("Error: transport closed");
  });
});

describe("routeToolCall — upstream failures", () => {
  function callableWith(callTool: unknown): UpstreamConnection {
    const conn = makeConnection("gh", ["create_issue"]);
    (conn as any).client = { callTool };
    return conn;
  }

  it("tags the MCP error code so the model can tell bad args from a dead upstream", async () => {
    // This is the string error-category.ts's classifier reads and the one the
    // model sees. It was only ever pinned by a hand-typed literal in another
    // file, so producer and consumer could drift apart with nothing red.
    const err = Object.assign(new Error("MCP error -32602: bad args"), { code: -32602 });
    const connections = new Map([["gh", callableWith(() => Promise.reject(err))]]);
    const result = await routeToolCall("gh_create_issue", {}, buildToolRoutes(connections), connections);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("[code=-32602]");
    expect(result.content[0].text).toContain("bad args");
    expect(result.content[0].text).toContain("gh_create_issue");
    // NOT a routing fault: the upstream answered, badly. server.ts books it
    // against that server's health precisely because of this distinction.
    expect(isRoutingFaultResult(result)).toBe(false);
  });

  it("omits the tag when the rejection carries no numeric code", async () => {
    for (const thrown of [new Error("plain failure"), Object.assign(new Error("stringy"), { code: "-32602" })]) {
      const connections = new Map([["gh", callableWith(() => Promise.reject(thrown))]]);
      const result = await routeToolCall("gh_create_issue", {}, buildToolRoutes(connections), connections);
      expect(result.isError).toBe(true);
      // A string `code` must not render as `[code=-32602]`: the tag promises a
      // JSON-RPC error code, and the classifier keys on that promise.
      expect(result.content[0].text).not.toContain("[code=");
      expect(result.content[0].text).toContain(thrown.message);
    }
  });

  it("stringifies a non-Error rejection instead of rendering it as undefined", async () => {
    const connections = new Map([["gh", callableWith(() => Promise.reject("transport closed"))]]);
    const result = await routeToolCall("gh_create_issue", {}, buildToolRoutes(connections), connections);
    expect(result.content[0].text).toBe("Error calling gh_create_issue: transport closed");
  });
});

describe("upstream error text is scrubbed before it is logged", () => {
  // error-category.ts's header says it: third-party servers routinely echo
  // args and secrets in error text (URLs with api_key=, request bodies,
  // tracebacks with locals). The three catch arms under test logged that text
  // verbatim at error level, and for a stdio server stderr IS the client's
  // on-disk log. The RESULT still carries the raw text -- the client needs it
  // to debug -- so each case checks both sides of that line.
  pinLogLevel();
  const SECRET = "eyJhbGciOiJIUzI1NiJ9dEADbEEF";
  const MESSAGE = `401 rejected Authorization: Bearer ${SECRET}`;

  function loggedLine(writes: string[], msg: string): string {
    const line = writes.find((w) => w.includes(msg));
    expect(line, `expected a "${msg}" log line; got ${JSON.stringify(writes)}`).toBeDefined();
    return line ?? "";
  }

  it("routeToolCall", async () => {
    const conn = makeConnection("gh", ["create_issue"]);
    (conn as any).client = { callTool: () => Promise.reject(new Error(MESSAGE)) };
    const connections = new Map([["gh", conn]]);
    const { writes, value } = await withCapturedStderrAsync(() =>
      routeToolCall("gh_create_issue", {}, buildToolRoutes(connections), connections),
    );
    const line = loggedLine(writes, "Tool call failed");
    expect(line).not.toContain(SECRET);
    expect(line).toContain("<redacted>");
    // The model still sees the whole thing.
    expect(value.content[0].text).toContain(SECRET);
  });

  it("routeResourceRead", async () => {
    const conn = makeConnection("db", [], ["db://tables"]);
    (conn as any).client = { readResource: () => Promise.reject(new Error(MESSAGE)) };
    const connections = new Map([["db", conn]]);
    const { writes, value } = await withCapturedStderrAsync(() =>
      routeResourceRead("connect://db/db://tables", buildResourceRoutes(connections), connections),
    );
    const line = loggedLine(writes, "Resource read failed");
    expect(line).not.toContain(SECRET);
    expect(line).toContain("<redacted>");
    expect(value.contents[0].text).toContain(SECRET);
  });

  it("routePromptGet", async () => {
    const conn = makeConnection("gh", [], [], ["review_pr"]);
    (conn as any).client = { getPrompt: () => Promise.reject(new Error(MESSAGE)) };
    const connections = new Map([["gh", conn]]);
    const { writes, value } = await withCapturedStderrAsync(() =>
      routePromptGet("gh_review_pr", undefined, buildPromptRoutes(connections), connections),
    );
    const line = loggedLine(writes, "Prompt get failed");
    expect(line).not.toContain(SECRET);
    expect(line).toContain("<redacted>");
    expect(value.messages[0].content.text).toContain(SECRET);
  });
});

describe("routeToolCall — request options", () => {
  function recordingConnection(calls: unknown[][]): UpstreamConnection {
    const conn = makeConnection("gh", ["create_issue"]);
    (conn as any).client = {
      callTool: async (...args: unknown[]) => {
        calls.push(args);
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    return conn;
  }

  it("bounds the call with a timeout passed as the THIRD argument", async () => {
    const calls: unknown[][] = [];
    const connections = new Map([["gh", recordingConnection(calls)]]);
    await routeToolCall("gh_create_issue", { title: "x" }, buildToolRoutes(connections), connections);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual({ name: "create_issue", arguments: { title: "x" } });
    // Slot 2 is the RESULT SCHEMA. Putting the options object there would
    // silently replace CallToolResultSchema and take the SDK's
    // structured-output validation with it.
    expect(calls[0][1]).toBeUndefined();
    // The default stays the SDK's own 60s: a longer ceiling holds the
    // namespace's inflightCalls marker and stalls the model that much longer
    // on a wedged upstream, so raising it is an operator decision.
    expect(calls[0][2]).toEqual({ timeout: 60_000 });
  });

  it("resolves the ceiling from MCP_CALL_TIMEOUT, falling back on junk and on out-of-range", async () => {
    // Read once at module load, like MCP_LIST_TIMEOUT, so each case needs a
    // fresh module rather than a plain stubEnv. The parsing contract itself is
    // pinned on resolveTimeoutEnv (upstream.test.ts); this pins that proxy.ts
    // is actually wired to it.
    //
    // "3e9" and "30s" are what Number.parseInt's PREFIX parsing turned into 3
    // and 30 -- a millisecond ceiling from a value that reads generous, making
    // EVERY proxied tools/call return -32001 immediately, and a timeout is not
    // branded a routing fault, so server.ts books each one against the
    // upstream's health and error rate. "3000000000" is out of range, and the
    // 60s default is the right answer there rather than MAX_TIMEOUT_MS: a
    // clamped ceiling never settles, so the namespace's inflightCalls marker
    // is never cleared and the namespace stops being deactivatable or
    // idle-reapable. The last two rows pin the edges of the accepted range.
    try {
      for (const [env, expected] of [
        ["5000", 5000],
        [" 5000 ", 5000],
        ["nonsense", 60_000],
        ["0", 60_000],
        ["3e9", 60_000],
        ["30s", 60_000],
        ["3000000000", 60_000],
        ["2147483647", 2_147_483_647],
        ["2147483648", 60_000],
      ] as const) {
        vi.stubEnv("MCP_CALL_TIMEOUT", env);
        vi.resetModules();
        const fresh = await import("../proxy.js");
        const calls: unknown[][] = [];
        const connections = new Map([["gh", recordingConnection(calls)]]);
        await fresh.routeToolCall("gh_create_issue", {}, fresh.buildToolRoutes(connections), connections);
        expect(calls[0][2], `MCP_CALL_TIMEOUT=${env}`).toEqual({ timeout: expected });
      }
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("warns at module load when MCP_CALL_TIMEOUT is rejected", async () => {
    // The diagnostic has to survive where the value is actually resolved: the
    // constant is latched in a module-level initialiser, so the only place the
    // operator can be told their knob was ignored is that import. Captured off
    // the REAL logger (this file does not stub it) to prove stderr at module
    // load is a path that works, not just that resolveTimeoutEnv calls log().
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    vi.stubEnv("LOG_LEVEL", "warn");
    vi.stubEnv("MCP_CALL_TIMEOUT", "3e9");
    vi.resetModules();
    (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };
    try {
      await import("../proxy.js");
    } finally {
      process.stderr.write = original;
      vi.unstubAllEnvs();
      vi.resetModules();
    }
    const warn = writes.find((w) => w.includes("MCP_CALL_TIMEOUT"));
    expect(warn).toBeDefined();
    // The rejected value, the ceiling, and the number actually in effect --
    // without the last one the operator cannot tell what the call is bounded by.
    expect(JSON.parse(warn as string)).toMatchObject({
      level: "warn",
      value: "3e9",
      maxMs: 2_147_483_647,
      usingMs: 60_000,
    });
  });
});

describe("buildToolList — gateway exposure", () => {
  const connections = new Map([["db", makeConnection("db", ["query", "explain"])]]);
  const inactive = [makeInactiveServer("tailscale", [{ name: "status", description: "d" }])];

  it("advertises only the meta-tools before anything is activated", () => {
    const tools = buildToolList(connections, inactive, undefined, "gateway", new Set());
    expect(tools).toHaveLength(Object.keys(META_TOOLS).length);
    expect(tools.every((t) => t.name.startsWith("mcp_connect_"))).toBe(true);
  });

  it("drops deferred placeholders, which are the bulk of the payload", () => {
    // 242 of 252 advertised tools were deferred placeholders carrying a
    // 61-char schema; the cost was in their names and descriptions.
    const tools = buildToolList(connections, inactive, undefined, "gateway", new Set());
    expect(tools.some((t) => t.name.startsWith("tailscale_"))).toBe(false);
  });

  it("surfaces a namespace once it has been activated by name", () => {
    const tools = buildToolList(connections, inactive, undefined, "gateway", new Set(["db"]));
    expect(tools.map((t) => t.name)).toContain("db_query");
    expect(tools.map((t) => t.name)).toContain("db_explain");
  });

  it("does NOT surface a merely-connected namespace nobody asked for", () => {
    // prewarmDormantServers connects servers on its own, so keying on
    // connectedness would re-advertise the catalog through the back door.
    const tools = buildToolList(connections, inactive, undefined, "gateway", new Set(["other"]));
    expect(tools.some((t) => t.name.startsWith("db_"))).toBe(false);
  });

  it("still honors a per-namespace tool filter on an activated namespace", () => {
    const filters = new Map([["db", new Set(["query"])]]);
    const tools = buildToolList(connections, inactive, filters, "gateway", new Set(["db"]));
    expect(tools.map((t) => t.name)).toContain("db_query");
    expect(tools.map((t) => t.name)).not.toContain("db_explain");
  });

  it("full exposure is unchanged, and is what the default preserves", () => {
    const explicit = buildToolList(connections, inactive, undefined, "full", new Set());
    const bare = buildToolList(connections, inactive);
    expect(bare).toEqual(explicit);
    expect(explicit.map((t) => t.name)).toContain("db_query");
    expect(explicit.map((t) => t.name)).toContain("tailscale_status");
  });

  it("builds routes for unadvertised tools, so dispatch can still reach them", () => {
    // The reach guarantee that makes withholding safe.
    const routes = buildToolRoutes(connections, inactive);
    expect(routes.has("tailscale_status")).toBe(true);
    expect(routes.has("db_query")).toBe(true);
  });
});

describe("gateway exposure covers resources and prompts too", () => {
  const connections = new Map([["db", makeConnection("db", ["query"], ["db://tables"], ["review"])]]);

  it("hides an unactivated namespace's resources", () => {
    const list = buildResourceList(connections, [], "gateway", new Set());
    expect(list.some((r) => r.uri.includes("db"))).toBe(false);
  });

  it("hides an unactivated namespace's prompts", () => {
    const list = buildPromptList(connections, "gateway", new Set());
    expect(list).toHaveLength(0);
  });

  it("surfaces both once the namespace is activated", () => {
    expect(buildResourceList(connections, [], "gateway", new Set(["db"])).length).toBeGreaterThan(0);
    expect(buildPromptList(connections, "gateway", new Set(["db"])).length).toBeGreaterThan(0);
  });

  it("always lists yaw-mcp's OWN builtin resources, which no upstream owns", () => {
    const builtin = [{ uri: "yaw-mcp://guide", read: () => ({ contents: [] }) }];
    const list = buildResourceList(connections, builtin, "gateway", new Set());
    expect(list.map((r) => r.uri)).toContain("yaw-mcp://guide");
  });

  it("full exposure still lists everything, unchanged", () => {
    expect(buildResourceList(connections, [], "full", new Set()).some((r) => r.uri.includes("db"))).toBe(true);
    expect(buildPromptList(connections, "full", new Set())).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MCP 2025-06-18 passthrough for RESOURCES and PROMPTS.
//
// buildToolList has forwarded `title` / `_meta` for a while; the resource
// and prompt builders dropped both, so an upstream that published a
// display name saw it silently replaced by the raw `name` downstream and a
// _meta convention the upstream/client pair agreed on never arrived.
// ═══════════════════════════════════════════════════════════════════════

describe("buildResourceList / buildPromptList — title + _meta passthrough", () => {
  /** A connection whose single resource and single prompt both carry the
   *  optional presentation fields, which the plain makeConnection helper
   *  above deliberately leaves unset. */
  function titledConnection(): UpstreamConnection {
    const conn = makeConnection("db", [], ["db://tables"], ["explain"]);
    conn.resources[0].title = "Database Tables";
    conn.resources[0]._meta = { "vendor/kind": "table-index" };
    conn.prompts[0].title = "Explain a query";
    conn.prompts[0]._meta = { "vendor/kind": "sql-helper" };
    return conn;
  }

  it("forwards an upstream resource's title and _meta", () => {
    const connections = new Map<string, UpstreamConnection>([["db", titledConnection()]]);
    const [resource] = buildResourceList(connections);
    expect(resource.title).toBe("Database Tables");
    expect(resource._meta).toEqual({ "vendor/kind": "table-index" });
    // The namespaced URI still wins over the upstream's raw one.
    expect(resource.uri).toBe("connect://db/db://tables");
  });

  it("forwards an upstream prompt's title and _meta", () => {
    const connections = new Map<string, UpstreamConnection>([["db", titledConnection()]]);
    const [prompt] = buildPromptList(connections);
    expect(prompt.title).toBe("Explain a query");
    expect(prompt._meta).toEqual({ "vendor/kind": "sql-helper" });
    expect(prompt.name).toBe("db_explain");
  });

  it("leaves both fields undefined when the upstream published neither", () => {
    // The common case: forwarding must not invent a title out of `name`.
    const connections = new Map<string, UpstreamConnection>([
      ["db", makeConnection("db", [], ["db://tables"], ["explain"])],
    ]);
    expect(buildResourceList(connections)[0].title).toBeUndefined();
    expect(buildResourceList(connections)[0]._meta).toBeUndefined();
    expect(buildPromptList(connections)[0].title).toBeUndefined();
    expect(buildPromptList(connections)[0]._meta).toBeUndefined();
  });
});
