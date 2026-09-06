import { describe, expect, it } from "vitest";
import { MAX_EXEC_STEPS } from "../exec-engine.js";
import { PENALTY_RATE_THRESHOLD } from "../learning.js";
import { computeSecretsReport, META_TOOL_NAMES, META_TOOLS } from "../meta-tools.js";
import { MALFORMED_REF_MARKER, MALFORMED_REF_MAX_CHARS, SECRET_REF_RE } from "../secrets-vault.js";

describe("mcp_connect_secrets meta-tool definition", () => {
  it("is registered with values-free annotations", () => {
    expect(META_TOOLS.secrets.name).toBe("mcp_connect_secrets");
    expect(META_TOOLS.secrets.annotations.readOnlyHint).toBe(true);
    expect(META_TOOLS.secrets.annotations.openWorldHint).toBe(false);
  });

  it("is included in META_TOOL_NAMES", () => {
    expect(META_TOOL_NAMES.has("mcp_connect_secrets")).toBe(true);
  });
});

describe("mcp_connect_dispatch inputSchema", () => {
  it("declares routeEffort so the advertised schema matches what the handler reads", () => {
    // server.ts reads args.routeEffort ahead of YAW_MCP_ROUTE_EFFORT; a
    // client that filters arguments against the advertised schema strips
    // undeclared params, so the per-call dial was dead code until declared.
    const props = META_TOOLS.dispatch.inputSchema.properties;
    expect(props.routeEffort).toBeDefined();
    expect(props.routeEffort.enum).toEqual(["off", "auto", "aggressive"]);
    // It stays optional -- omitting it falls back to the env var.
    expect(META_TOOLS.dispatch.inputSchema.required).toEqual(["intent"]);
  });
});

describe("META_TOOL_NAMES", () => {
  // server.ts gates exec steps on this set: a name missing from it is a
  // meta-tool that becomes callable from inside an exec pipeline. It used to
  // be a hand-maintained re-list of META_TOOLS, so an 11th meta-tool added
  // without touching it silently opened that hole. Derived now -- these pin
  // the derivation so it can't regress to a copy.
  it("covers EVERY meta-tool, with no gap and no extras", () => {
    const declared = Object.values(META_TOOLS).map((m) => m.name);
    expect(META_TOOL_NAMES.size).toBe(declared.length);
    expect([...META_TOOL_NAMES].sort()).toEqual([...declared].sort());
  });
});

describe("meta-tool descriptions quote the constants that enforce them", () => {
  it("renders exec's step cap from MAX_EXEC_STEPS", () => {
    // The description sells a hard cap to the model; validateExecRequest is
    // what actually enforces it. A hardcoded number here goes stale silently
    // the first time the cap moves.
    expect(META_TOOLS.exec.description).toContain(`Max ${MAX_EXEC_STEPS} steps per exec.`);
  });

  it("renders health's reliability floor from PENALTY_RATE_THRESHOLD", () => {
    // learning.ts promises that moving this threshold moves every surface
    // that renders it -- this description is one of those surfaces.
    expect(META_TOOLS.health.description).toContain(`<${Math.round(PENALTY_RATE_THRESHOLD * 100)}%`);
  });

  it("does not retype the idle-unload threshold in deactivate's description", () => {
    // The real threshold is adaptive (ADAPTIVE_MIN..ADAPTIVE_MAX around a
    // YAW_MCP_IDLE_THRESHOLD baseline, idle-ttl.ts), so any literal here is
    // wrong for most servers most of the time. Name the knob, never a number.
    const d = META_TOOLS.deactivate.description;
    expect(d).not.toMatch(/\d+\+? tool calls/);
    expect(d).toContain("YAW_MCP_IDLE_THRESHOLD");
  });
});

describe("mcp_connect_exec description matches what handleExec does", () => {
  it("no longer claims exec never auto-activates", () => {
    // Tripwire, not coverage: handleExec routes each step through
    // handleToolCall, which lazy-loads a deferred (cached-but-not-connected)
    // server on first use exactly as a direct tools/call would. The old
    // parenthetical told the model to spend an mcp_connect_activate
    // round-trip first -- the very round-trip exec exists to save.
    expect(META_TOOLS.exec.description).not.toContain("does not auto-activate");
    expect(META_TOOLS.exec.inputSchema.properties.steps.items.properties.tool.description).not.toContain(
      "currently loaded",
    );
  });

  it("declares the step item schema closed so a misspelled `arguments` key is not silently legal", () => {
    // Without this a step written as {tool, arguments:{...}} reads as a legal
    // extension and dispatches the tool with no arguments at all.
    expect(META_TOOLS.exec.inputSchema.properties.steps.items.additionalProperties).toBe(false);
  });
});

describe("computeSecretsReport (names only, never values)", () => {
  it("partitions referenced names into injected vs missing", () => {
    const servers = [
      {
        namespace: "gh",
        env: { GITHUB_TOKEN: "${secret:gh}", AUTH: "Bearer ${secret:missing_one}" },
      },
    ];
    const rows = computeSecretsReport(servers, new Set(["gh"]));
    expect(rows).toEqual([{ server: "gh", injectedSecrets: ["gh"], missing: ["missing_one"], malformed: [] }]);
  });

  it("names a reference the strict regex cannot parse in its own `malformed` column", () => {
    // resolveServerEnv refuses the spawn over a malformed ref exactly as over
    // a missing name, but the report scans with the strict regex, so until
    // this column it said "gh: injected, nothing missing" about a server that
    // will not start -- and a server whose ONLY ref is the typo got no row at
    // all, reading as "needs no secrets".
    const servers: Array<{ namespace: string; env?: Record<string, string> }> = [
      { namespace: "typo-only", env: { T: "${secret:gh token}" } },
      { namespace: "mixed", env: { A: "${secret:gh}", B: "${secret:absent}", C: "${secret:gh" } },
    ];
    const rows = computeSecretsReport(servers, new Set(["gh"]));
    expect(rows).toEqual([
      {
        server: "typo-only",
        injectedSecrets: [],
        missing: [],
        malformed: [`${MALFORMED_REF_MARKER} \${secret:gh ...`],
      },
      {
        server: "mixed",
        injectedSecrets: ["gh"],
        missing: ["absent"],
        malformed: [`${MALFORMED_REF_MARKER} \${secret:gh`],
      },
    ]);
  });

  it("quotes a malformed reference in secrets-vault's bounded display form, never the raw env value", () => {
    // An unterminated ref runs to the end of the env value, which can carry
    // anything the user put after the typo. This report goes to the model,
    // so it gets the same control-stripped, capped form the refusal uses.
    const servers = [
      { namespace: "db", env: { URL: `\${secret:DB_PASS@db.internal:5432/prod?x=y&pw=${"z".repeat(200)}` } },
    ];
    const rows = computeSecretsReport(servers, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0].malformed).toHaveLength(1);
    const [quoted] = rows[0].malformed;
    expect(quoted.startsWith(`${MALFORMED_REF_MARKER} \${secret:DB_PASS`)).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(MALFORMED_REF_MARKER.length + 1 + MALFORMED_REF_MAX_CHARS + 3);
    expect(JSON.stringify(rows)).not.toContain("pw=");
  });

  it("reports only the vault keys this server references, never the whole key list", () => {
    // injectedSecrets is referenced ∩ vaultKeys, in that direction. Leaking
    // the vault's other key NAMES here would turn a per-server preview into
    // an inventory of every credential the user holds.
    const servers = [{ namespace: "gh", env: { T: "${secret:gh}" } }];
    const rows = computeSecretsReport(servers, new Set(["gh", "aws", "slack"]));
    expect(rows).toEqual([{ server: "gh", injectedSecrets: ["gh"], missing: [], malformed: [] }]);
    expect(JSON.stringify(rows)).not.toContain("aws");
    expect(JSON.stringify(rows)).not.toContain("slack");
  });

  it("omits servers with no ${secret:...} references", () => {
    const servers: Array<{ namespace: string; env?: Record<string, string> }> = [
      { namespace: "plain", env: { FOO: "bar" } },
      { namespace: "none", env: undefined },
      { namespace: "gh", env: { T: "${secret:gh}" } },
    ];
    const rows = computeSecretsReport(servers, new Set(["gh"]));
    expect(rows.map((r) => r.server)).toEqual(["gh"]);
  });

  it("dedupes multiple references to the same name within one server", () => {
    const servers = [{ namespace: "x", env: { A: "${secret:tok}", B: "pre-${secret:tok}-post" } }];
    const rows = computeSecretsReport(servers, new Set(["tok"]));
    expect(rows[0].injectedSecrets).toEqual(["tok"]);
    expect(rows[0].missing).toEqual([]);
  });

  it("everything missing when the vault is empty", () => {
    const servers = [{ namespace: "gh", env: { T: "${secret:gh}", U: "${secret:aws}" } }];
    const rows = computeSecretsReport(servers, new Set());
    expect(rows[0].injectedSecrets).toEqual([]);
    expect(rows[0].missing).toEqual(["aws", "gh"]); // sorted
  });

  it("is immune to a stale lastIndex on the shared SECRET_REF_RE", () => {
    // SECRET_REF_RE is /g and module-shared. matchAll seeds its internal
    // clone from the SOURCE's lastIndex, so scanning with the shared object
    // would skip leading matches once any other caller left lastIndex behind
    // (a `.exec()`/`.test()` anywhere) -- and a skipped reference drops the
    // server's row entirely, reading as "needs no secrets".
    const saved = SECRET_REF_RE.lastIndex;
    SECRET_REF_RE.lastIndex = 5;
    try {
      const rows = computeSecretsReport([{ namespace: "gh", env: { T: "${secret:gh}" } }], new Set(["gh"]));
      expect(rows).toEqual([{ server: "gh", injectedSecrets: ["gh"], missing: [], malformed: [] }]);
    } finally {
      SECRET_REF_RE.lastIndex = saved;
    }
  });

  it("returns no value anywhere in the output -- only names", () => {
    const servers = [{ namespace: "gh", env: { T: "${secret:gh}" } }];
    const rows = computeSecretsReport(servers, new Set(["gh"]));
    const serialized = JSON.stringify(rows);
    // The only string that should appear is the NAME "gh", never a value.
    expect(serialized).toContain("gh");
    // No env value content (the literal placeholder) leaks into the report
    // for a WELL-FORMED ref. (The `malformed` column is the deliberate
    // exception: it quotes the unparseable span, bounded, because the typo
    // IS the diagnostic -- see the malformed cases above.)
    expect(serialized).not.toContain("${secret:");
  });
});
