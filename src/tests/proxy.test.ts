import { describe, expect, it } from "vitest";
import { META_TOOLS } from "../meta-tools.js";
import {
  type BuiltinResource,
  buildPromptList,
  buildPromptRoutes,
  buildResourceList,
  buildResourceRoutes,
  buildToolList,
  buildToolRoutes,
  routeResourceRead,
} from "../proxy.js";
import type { UpstreamConnection } from "../types.js";

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

describe("buildResourceList — builtins", () => {
  const guideBuiltin: BuiltinResource = {
    uri: "mcph://guide",
    name: "mcph guide",
    description: "Project + user guidance from MCPH.md",
    mimeType: "text/markdown",
    read: async () => ({ contents: [{ uri: "mcph://guide", text: "hello", mimeType: "text/markdown" }] }),
  };

  it("returns just builtins when no upstream connections exist", () => {
    const resources = buildResourceList(new Map(), [guideBuiltin]);
    expect(resources).toEqual([
      {
        uri: "mcph://guide",
        name: "mcph guide",
        description: "Project + user guidance from MCPH.md",
        mimeType: "text/markdown",
      },
    ]);
  });

  it("lists builtins BEFORE upstream resources", () => {
    const connections = new Map<string, UpstreamConnection>();
    connections.set("db", makeConnection("db", [], ["db://tables"]));
    const resources = buildResourceList(connections, [guideBuiltin]);
    expect(resources.length).toBe(2);
    expect(resources[0].uri).toBe("mcph://guide");
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
    builtins.set("mcph://guide", {
      uri: "mcph://guide",
      read: () => ({ contents: [{ uri: "mcph://guide", text: "guide-body" }] }),
    });
    const result = await routeResourceRead("mcph://guide", new Map(), new Map(), builtins);
    expect(result.contents[0].text).toBe("guide-body");
  });

  it("awaits an async builtin reader", async () => {
    const builtins = new Map<string, BuiltinResource>();
    builtins.set("mcph://guide", {
      uri: "mcph://guide",
      read: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return { contents: [{ uri: "mcph://guide", text: "async-body" }] };
      },
    });
    const result = await routeResourceRead("mcph://guide", new Map(), new Map(), builtins);
    expect(result.contents[0].text).toBe("async-body");
  });

  it("returns a graceful error text when a builtin reader throws (does NOT propagate)", async () => {
    const builtins = new Map<string, BuiltinResource>();
    builtins.set("mcph://guide", {
      uri: "mcph://guide",
      read: () => {
        throw new Error("read exploded");
      },
    });
    // An MCP client that gets a thrown exception here would see a
    // generic JSON-RPC failure; by returning a text body we can surface
    // the actual error to the user without crashing the session.
    const result = await routeResourceRead("mcph://guide", new Map(), new Map(), builtins);
    expect(result.contents[0].text).toContain("read exploded");
  });

  it("falls through to upstream routing when URI is not a builtin", async () => {
    const builtins = new Map<string, BuiltinResource>();
    builtins.set("mcph://guide", {
      uri: "mcph://guide",
      read: () => ({ contents: [{ uri: "mcph://guide", text: "builtin" }] }),
    });
    // No matching upstream route either → the "Unknown resource" text path.
    const result = await routeResourceRead("connect://unknown/x", new Map(), new Map(), builtins);
    expect(result.contents[0].text).toContain("Unknown resource");
  });

  it("works with undefined builtins (back-compat)", async () => {
    const result = await routeResourceRead("mcph://guide", new Map(), new Map());
    // No builtins, no upstream route → unknown resource.
    expect(result.contents[0].text).toContain("Unknown resource");
  });

  it("builtin takes precedence even when an upstream resource has the same URI", async () => {
    // An upstream server accidentally registers `mcph://guide` as one of
    // its resources. The builtin should still win — mcph is canonical
    // for its own namespace.
    const connections = new Map<string, UpstreamConnection>();
    const fakeClient = {
      readResource: async () => ({ contents: [{ uri: "mcph://guide", text: "upstream-body" }] }),
    };
    const conn = makeConnection("evil", [], ["mcph://guide"]);
    (conn as any).client = fakeClient;
    connections.set("evil", conn);

    const routes = new Map();
    routes.set("mcph://guide", { namespace: "evil", originalUri: "mcph://guide" });

    const builtins = new Map<string, BuiltinResource>();
    builtins.set("mcph://guide", {
      uri: "mcph://guide",
      read: () => ({ contents: [{ uri: "mcph://guide", text: "builtin-body" }] }),
    });

    const result = await routeResourceRead("mcph://guide", routes, connections, builtins);
    expect(result.contents[0].text).toBe("builtin-body");
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
