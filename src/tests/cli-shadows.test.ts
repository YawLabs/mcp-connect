import { describe, expect, it } from "vitest";

import { cliToNamespaces, formatShadowLine, resolveShadowedClis, shadowedCliNames } from "../cli-shadows.js";

describe("resolveShadowedClis", () => {
  it("returns the registered shadow for a catalog slug", () => {
    const shadows = resolveShadowedClis({ namespace: "tailscale" });
    expect(shadows).toEqual([{ cli: "tailscale" }]);
  });

  it("returns npmjs's restricted npm subcommand list", () => {
    const shadows = resolveShadowedClis({ namespace: "npmjs" });
    expect(shadows).toHaveLength(1);
    expect(shadows[0].cli).toBe("npm");
    expect(shadows[0].subcommands).toContain("audit");
    expect(shadows[0].subcommands).toContain("deprecate");
    // npmjs-mcp is read/admin only — `install` should NOT appear.
    expect(shadows[0].subcommands).not.toContain("install");
  });

  it("returns multiple shadows for postgres", () => {
    const shadows = resolveShadowedClis({ namespace: "postgres" });
    expect(shadows.map((s) => s.cli).sort()).toEqual(["pg_dump", "psql"]);
  });

  it("resolves common alias namespaces (k8s → kubectl)", () => {
    expect(resolveShadowedClis({ namespace: "k8s" })).toEqual([{ cli: "kubectl" }]);
    expect(resolveShadowedClis({ namespace: "kubectl" })).toEqual([{ cli: "kubectl" }]);
  });

  it("is case-insensitive on namespace", () => {
    expect(resolveShadowedClis({ namespace: "GitHub" })).toEqual([{ cli: "gh" }]);
  });

  it("returns [] for a registered no-CLI service", () => {
    // Linear, Notion, Firecrawl etc. are known catalog entries with no
    // widely-used CLI. Registering them explicitly keeps the heuristic
    // from inferring a bogus shadow from their tool-name prefix.
    expect(resolveShadowedClis({ namespace: "linear" })).toEqual([]);
    expect(resolveShadowedClis({ namespace: "notion" })).toEqual([]);
  });

  it("falls back to the tool-prefix heuristic for unknown namespaces", () => {
    // A user who named their server "my-npm-proxy" isn't in the registry,
    // but its tool cache shares the `npm` prefix across ≥3 entries — infer.
    const shadows = resolveShadowedClis({
      namespace: "my-npm-proxy",
      toolCache: [{ name: "npm_search" }, { name: "npm_audit" }, { name: "npm_view" }],
    });
    expect(shadows).toEqual([{ cli: "npm" }]);
  });

  it("refuses the heuristic when fewer than 3 tools share a prefix", () => {
    const shadows = resolveShadowedClis({
      namespace: "unknown",
      toolCache: [{ name: "npm_search" }, { name: "npm_audit" }],
    });
    expect(shadows).toEqual([]);
  });

  it("refuses the heuristic for unlisted prefixes (no false positives)", () => {
    // Three tools share the prefix `get` — but `get` isn't in the
    // KNOWN_CLI_PREFIXES list, so we don't invent a "get" CLI.
    const shadows = resolveShadowedClis({
      namespace: "unknown",
      toolCache: [{ name: "get_user" }, { name: "get_repo" }, { name: "get_file" }],
    });
    expect(shadows).toEqual([]);
  });
});

describe("shadowedCliNames", () => {
  it("flattens to bare CLI names", () => {
    expect(shadowedCliNames({ namespace: "postgres" }).sort()).toEqual(["pg_dump", "psql"]);
    expect(shadowedCliNames({ namespace: "linear" })).toEqual([]);
  });
});

describe("formatShadowLine", () => {
  it("formats a simple shadow", () => {
    expect(formatShadowLine({ namespace: "tailscale" })).toBe("prefer over local CLI: `tailscale`");
  });

  it("includes subcommand hints when restricted", () => {
    const line = formatShadowLine({ namespace: "npmjs" });
    expect(line).toContain("`npm` (");
    expect(line).toContain("deprecate");
  });

  it("returns null for servers that shadow nothing", () => {
    expect(formatShadowLine({ namespace: "linear" })).toBeNull();
    expect(formatShadowLine({ namespace: "unknown-xyz" })).toBeNull();
  });
});

describe("cliToNamespaces", () => {
  it("maps npm back to the npmjs + npm namespaces", () => {
    const reverse = cliToNamespaces();
    const namespaces = reverse.get("npm") ?? [];
    expect(namespaces).toContain("npmjs");
    expect(namespaces).toContain("npm");
  });

  it("maps kubectl back to every namespace that shadows it", () => {
    const reverse = cliToNamespaces();
    const namespaces = reverse.get("kubectl") ?? [];
    expect(namespaces.sort()).toEqual(["k8s", "kubectl", "kubernetes"]);
  });

  it("returns the same Map instance on repeat calls (cached)", () => {
    expect(cliToNamespaces()).toBe(cliToNamespaces());
  });
});
