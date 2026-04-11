import { describe, expect, it } from "vitest";
import { META_TOOLS } from "../meta-tools.js";
import {
  buildPromptList,
  buildPromptRoutes,
  buildResourceList,
  buildResourceRoutes,
  buildToolList,
  buildToolRoutes,
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
