import { describe, expect, it } from "vitest";
import { findTool, formatReadToolOutput, formatToolNotFound, normalizeToolName } from "../read-tool.js";
import type { UpstreamServerConfig, UpstreamToolDef } from "../types.js";

function makeServer(overrides: Partial<UpstreamServerConfig> = {}): UpstreamServerConfig {
  return {
    id: "s1",
    name: "GitHub",
    namespace: "gh",
    type: "local",
    command: "npx",
    isActive: true,
    ...overrides,
  };
}

function makeTool(overrides: Partial<UpstreamToolDef> = {}): UpstreamToolDef {
  return {
    name: "create_issue",
    namespacedName: "gh_create_issue",
    description: "Create a new GitHub issue.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
    ...overrides,
  };
}

describe("normalizeToolName", () => {
  it("returns the bare name unchanged", () => {
    expect(normalizeToolName("gh", "create_issue")).toBe("create_issue");
  });

  it("strips the namespace prefix", () => {
    expect(normalizeToolName("gh", "gh_create_issue")).toBe("create_issue");
  });

  it("preserves underscore-containing namespaces", () => {
    // "google_maps" is what a user gets by naming the catalog's google-maps
    // server that way in bundles.json (NAMESPACE_RE allows "_"). The tool
    // "search_places" must not have its leading "google_" mistaken for a
    // namespace prefix, and neither half of the namespace is a boundary.
    expect(normalizeToolName("google_maps", "google_maps_search_places")).toBe("search_places");
    expect(normalizeToolName("google_maps", "search_places")).toBe("search_places");
  });

  it("returns unchanged when prefix matches without a name tail", () => {
    // "gh_" alone is not a valid tool — the function returns it as-is
    // rather than silently producing an empty string that would match
    // the wrong thing downstream.
    expect(normalizeToolName("gh", "gh_")).toBe("gh_");
  });

  it("returns raw name unchanged when it exactly matches a tool in the list", () => {
    expect(normalizeToolName("gh", "gh_create_issue", [{ name: "gh_create_issue" }])).toBe("gh_create_issue");
  });

  it("strips prefix when raw name is not in the tools list", () => {
    expect(normalizeToolName("gh", "gh_create_issue", [{ name: "create_issue" }])).toBe("create_issue");
  });

  it("strips prefix when tools list is empty", () => {
    expect(normalizeToolName("gh", "gh_foo", [])).toBe("foo");
  });
});

describe("findTool", () => {
  it("returns the tool by bare name", () => {
    const tools = [makeTool(), makeTool({ name: "close_issue", namespacedName: "gh_close_issue" })];
    expect(findTool(tools, "close_issue")?.name).toBe("close_issue");
  });

  it("returns undefined for missing tool", () => {
    expect(findTool([makeTool()], "nope")).toBeUndefined();
  });
});

describe("formatReadToolOutput", () => {
  it("renders tool, server, description, schema for a loaded server", () => {
    const text = formatReadToolOutput({
      tool: makeTool(),
      server: makeServer(),
      loaded: true,
    });
    expect(text).toContain("Tool: gh_create_issue");
    expect(text).toContain("Server: GitHub (gh)");
    expect(text).toContain("Description: Create a new GitHub issue.");
    expect(text).toContain('"required": [\n    "title"\n  ]');
    // No "not currently loaded" nudge when the server IS loaded.
    expect(text).not.toContain("not currently loaded");
  });

  it("appends an activation hint when the server is not loaded", () => {
    const text = formatReadToolOutput({
      tool: makeTool(),
      server: makeServer(),
      loaded: false,
    });
    expect(text).toContain("not currently loaded");
    expect(text).toContain('mcp_connect_activate({ server: "gh" })');
  });

  it("omits the description line when the tool has no description", () => {
    const text = formatReadToolOutput({
      tool: makeTool({ description: undefined }),
      server: makeServer(),
      loaded: true,
    });
    expect(text).not.toContain("Description:");
  });

  it("still prints an empty schema rather than crashing", () => {
    const text = formatReadToolOutput({
      tool: makeTool({ inputSchema: undefined as unknown as Record<string, unknown> }),
      server: makeServer(),
      loaded: true,
    });
    expect(text).toContain("Input schema:\n{}");
  });

  it("uses the tool's own namespacedName rather than rebuilding it", () => {
    // upstream.ts derives namespacedName once; rebuilding `${ns}_${name}`
    // here would be a second copy of that rule, free to drift from it.
    const text = formatReadToolOutput({
      tool: makeTool({ namespacedName: "gh_actions_create_issue" }),
      server: makeServer(),
      loaded: true,
    });
    expect(text).toContain("Tool: gh_actions_create_issue");
  });

  it("renders outputSchema, title and annotations when the tool carries them", () => {
    // outputSchema is what an exec caller needs to write correct $ref paths
    // into a step's output, so dropping it made read_tool answer a narrower
    // question than the one asked.
    const text = formatReadToolOutput({
      tool: makeTool({
        title: "Create Issue",
        outputSchema: { type: "object", properties: { number: { type: "integer" } } },
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
      server: makeServer(),
      loaded: true,
    });
    expect(text).toContain("Title: Create Issue");
    expect(text).toContain("Output schema:");
    expect(text).toContain('"number"');
    expect(text).toContain('Annotations: {"readOnlyHint":false,"destructiveHint":false}');
  });

  it("omits the output-schema, title and annotation lines when the tool has none", () => {
    const text = formatReadToolOutput({
      tool: makeTool(),
      server: makeServer(),
      loaded: true,
    });
    expect(text).not.toContain("Output schema:");
    expect(text).not.toContain("Title:");
    expect(text).not.toContain("Annotations:");
  });
});

describe("formatToolNotFound", () => {
  it("lists available tools alphabetically", () => {
    const msg = formatToolNotFound(makeServer(), "nope", [
      { name: "close_issue" },
      { name: "create_issue" },
      { name: "add_label" },
    ]);
    expect(msg).toBe('"nope" not found on "gh". Available tools: add_label, close_issue, create_issue');
  });

  it("handles servers that expose no tools", () => {
    const msg = formatToolNotFound(makeServer(), "nope", []);
    expect(msg).toContain("exposes no tools");
  });
});
