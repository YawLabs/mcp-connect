import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURATED_BUNDLES } from "../bundles.js";
import { parseBundlesArgs, runBundlesCommand } from "../bundles-cmd.js";
import { CONFIG_DIRNAME } from "../paths.js";
import { grantTrust } from "../trust.js";
import type { UpstreamServerConfig } from "../types.js";

function makeServer(over: Partial<UpstreamServerConfig>): Partial<UpstreamServerConfig> {
  return {
    id: "srv-1",
    name: "Example",
    namespace: "ex",
    type: "local",
    command: "npx",
    isActive: true,
    ...over,
  };
}

function captureIO(): { out: string[]; err: string[]; push: (s: string) => void; pushErr: (s: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    push: (s: string) => {
      out.push(s);
    },
    pushErr: (s: string) => {
      err.push(s);
    },
  };
}

describe("parseBundlesArgs", () => {
  it("defaults to action=list, json=false", () => {
    expect(parseBundlesArgs([])).toEqual({ ok: true, options: { action: "list", json: false } });
  });

  it("accepts action=list explicitly", () => {
    expect(parseBundlesArgs(["list"])).toEqual({ ok: true, options: { action: "list", json: false } });
  });

  it("accepts action=match", () => {
    expect(parseBundlesArgs(["match"])).toEqual({ ok: true, options: { action: "match", json: false } });
  });

  it("accepts --json combined with an action", () => {
    expect(parseBundlesArgs(["match", "--json"])).toEqual({ ok: true, options: { action: "match", json: true } });
    expect(parseBundlesArgs(["--json", "list"])).toEqual({ ok: true, options: { action: "list", json: true } });
  });

  it("rejects a second action arg", () => {
    const r = parseBundlesArgs(["list", "match"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("action already set");
  });

  it("rejects unknown args", () => {
    const r = parseBundlesArgs(["--wat"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown argument "--wat"');
  });

  it("--help returns the usage string", () => {
    const r = parseBundlesArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Usage: yaw-mcp bundles");
  });
});

describe("runBundlesCommand — list", () => {
  it("prints every curated bundle grouped by category", async () => {
    const io = captureIO();
    const r = await runBundlesCommand({ action: "list", out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    const combined = io.out.join("\n");
    expect(combined).toContain(`${CURATED_BUNDLES.length} curated bundles`);
    // Every bundle id should show up in the list output.
    for (const b of CURATED_BUNDLES) {
      expect(combined).toContain(b.id);
      expect(combined).toContain(b.name);
    }
    // Category headers are rendered in bracket form.
    const categories = new Set(CURATED_BUNDLES.map((b) => b.category));
    for (const cat of categories) {
      expect(combined).toContain(`[${cat}]`);
    }
  });

  it("emits JSON when --json is set", async () => {
    const io = captureIO();
    const r = await runBundlesCommand({ action: "list", json: true, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.bundles).toHaveLength(CURATED_BUNDLES.length);
    expect(parsed.bundles[0]).toHaveProperty("id");
  });

  it("is fully static -- reads no config file at all", async () => {
    // Point home AND cwd at a sandbox whose bundles.json and config.json are
    // both unparseable. `match` on exactly this seed warns "invalid JSON" on
    // stderr (see the malformed cases below), so a SILENT stderr here is
    // evidence `list` opened neither file. Asserting an empty stderr against
    // the developer's real home -- what this test used to do -- proved nothing:
    // it passed whether or not `list` read config, and would have gone red for
    // an unrelated reason the day the real ~/.yaw-mcp/bundles.json went bad.
    const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "yaw-mcp-bundles-list-")));
    try {
      mkdirSync(join(sandbox, CONFIG_DIRNAME), { recursive: true });
      writeFileSync(join(sandbox, CONFIG_DIRNAME, "bundles.json"), "{ not json", "utf8");
      writeFileSync(join(sandbox, CONFIG_DIRNAME, "config.json"), "{ not json", "utf8");
      const io = captureIO();
      const r = await runBundlesCommand({
        action: "list",
        home: sandbox,
        cwd: sandbox,
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(0);
      expect(io.err).toEqual([]);
      expect(r.stderr).toEqual([]);
      // ...and the catalog still rendered in full, so "no warnings" is not
      // just "no output".
      expect(io.out.join("\n")).toContain(`${CURATED_BUNDLES.length} curated bundles`);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe("runBundlesCommand — match", () => {
  let home: string;

  /** Write a user-global ~/.yaw-mcp/bundles.json with the given servers. */
  function seedBundles(servers: Array<Partial<UpstreamServerConfig>>): void {
    writeFileSync(join(home, CONFIG_DIRNAME, "bundles.json"), JSON.stringify({ version: 1, servers }, null, 2), "utf8");
  }

  /** `cwd: home` keeps findProjectConfigDir from walking into a real project
   *  `.yaw-mcp/` (it only considers dirs strictly UNDER home), so every case
   *  below resolves to the user-global file we just seeded. */
  const run = (opts: Parameters<typeof runBundlesCommand>[0] = {}) =>
    runBundlesCommand({ home, cwd: home, action: "match", ...opts });

  beforeEach(() => {
    // realpathSync: the loader resolves paths physically and grantTrust keys on
    // the real path, so where tmpdir() is a symlink (macOS /var -> /private/var)
    // a raw mkdtemp path makes the trust grant miss and the project file read as
    // untrusted. Same convention as config-loader.test.ts / paths.test.ts.
    home = realpathSync(mkdtempSync(join(tmpdir(), "yaw-mcp-bundles-")));
    mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("needs no token and no network -- an empty config still exits 0", async () => {
    const io = captureIO();
    const r = await run({ out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(io.out.join("\n")).toContain("No curated bundles match");
  });

  it("reports ready + partial bundles based on local namespaces", async () => {
    // github + linear + slack → pr-review ready, product-release ready,
    // devops-incident partial (missing pagerduty), support-ops partial (missing zendesk, hubspot).
    seedBundles([
      makeServer({ namespace: "github", name: "GitHub" }),
      makeServer({ namespace: "linear", name: "Linear" }),
      makeServer({ namespace: "slack", name: "Slack" }),
    ]);
    const io = captureIO();
    const r = await run({ out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    const combined = io.out.join("\n");
    expect(combined).toContain("Ready to activate");
    expect(combined).toContain("pr-review");
    expect(combined).toContain("product-release");
    expect(combined).toContain("Partially installed");
    expect(combined).toContain("devops-incident");
    expect(combined).toContain("missing: pagerduty");
  });

  it("only counts enabled servers when matching", async () => {
    // github enabled; linear disabled → pr-review should NOT be ready.
    seedBundles([
      makeServer({ namespace: "github", name: "GitHub", isActive: true }),
      makeServer({ namespace: "linear", name: "Linear", isActive: false }),
    ]);
    const io = captureIO();
    await run({ out: io.push, err: io.pushErr });
    const combined = io.out.join("\n");
    expect(combined).not.toContain("Ready to activate");
    // But linear should NOT appear in the header count either. Singular
    // "server" -- the header pluralizes on the count. ("available", not
    // "enabled": the count is enabled MINUS anything the config.json profile
    // excludes, and calling an excluded-but-enabled server "enabled" while
    // leaving it out of the list reads as a matcher bug.)
    expect(combined).toContain("1 available server: github");
  });

  it("prints the no-match message when nothing overlaps", async () => {
    seedBundles([makeServer({ namespace: "weirdnamespace", name: "Weird" })]);
    const io = captureIO();
    const r = await run({ out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(io.out.join("\n")).toContain("No curated bundles match");
  });

  it("emits JSON with installed + ready + partial when --json is set", async () => {
    seedBundles([makeServer({ namespace: "github" }), makeServer({ namespace: "linear" })]);
    const io = captureIO();
    const r = await run({ json: true, out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.installed).toContain("github");
    expect(parsed.installed).toContain("linear");
    expect(Array.isArray(parsed.ready)).toBe(true);
    expect(Array.isArray(parsed.partial)).toBe(true);
    // pr-review should be in `ready` (both github + linear installed).
    expect(parsed.ready.some((b: { id: string }) => b.id === "pr-review")).toBe(true);
  });

  it("reads an APPROVED project-local bundles.json over the user-global one", async () => {
    seedBundles([makeServer({ namespace: "weirdnamespace", name: "Weird" })]);
    const project = join(home, "proj");
    mkdirSync(join(project, CONFIG_DIRNAME), { recursive: true });
    const projectBundles = join(project, CONFIG_DIRNAME, "bundles.json");
    writeFileSync(
      projectBundles,
      JSON.stringify({
        version: 1,
        servers: [makeServer({ namespace: "github" }), makeServer({ namespace: "linear" })],
      }),
      "utf8",
    );
    // A project bundles.json only wins once the user has approved it via
    // `yaw-mcp trust` -- see the consent gate in src/trust.ts.
    await grantTrust(projectBundles, readFileSync(projectBundles), { home });
    const io = captureIO();
    const r = await runBundlesCommand({
      home,
      cwd: project,
      action: "match",
      json: true,
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.installed).toEqual(expect.arrayContaining(["github", "linear"]));
    expect(parsed.installed).not.toContain("weirdnamespace");
  });

  // `match` used to call both loaders with no env at all, so the project-trust
  // bypass an embedded or test caller injected was ignored while `add`,
  // `remove` and `list` honoured theirs -- same repo, same options, and two
  // commands disagreeing about which bundles.json is in effect.
  it("reads the INJECTED env for the project-trust bypass, not process.env", async () => {
    seedBundles([makeServer({ namespace: "github" })]);
    const project = join(home, "proj");
    mkdirSync(join(project, CONFIG_DIRNAME), { recursive: true });
    // UNAPPROVED (no grantTrust): only the env bypass can make it win.
    writeFileSync(
      join(project, CONFIG_DIRNAME, "bundles.json"),
      JSON.stringify({ version: 1, servers: [makeServer({ namespace: "linear" })] }),
      "utf8",
    );
    const plain = captureIO();
    await runBundlesCommand({
      home,
      cwd: project,
      action: "match",
      json: true,
      env: {},
      out: plain.push,
      err: plain.pushErr,
    });
    expect(JSON.parse(plain.out.join("\n")).installed).toEqual(["github"]);

    const bypassed = captureIO();
    await runBundlesCommand({
      home,
      cwd: project,
      action: "match",
      json: true,
      env: { YAW_MCP_TRUST_PROJECT: "1" },
      out: bypassed.push,
      err: bypassed.pushErr,
    });
    expect(JSON.parse(bypassed.out.join("\n")).installed).toEqual(["linear"]);
  });

  it("warns on stderr (still exit 0) when bundles.json is malformed", async () => {
    writeFileSync(join(home, CONFIG_DIRNAME, "bundles.json"), "{ not json", "utf8");
    const io = captureIO();
    const r = await run({ out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(io.err.join("\n")).toMatch(/invalid JSON/);
    // Diagnostic must not leak into the stdout a --json consumer parses.
    expect(io.out.join("\n")).not.toMatch(/invalid JSON/);
  });

  it("keeps stdout parseable under --json even when the file is malformed", async () => {
    writeFileSync(join(home, CONFIG_DIRNAME, "bundles.json"), "{ not json", "utf8");
    const io = captureIO();
    await run({ json: true, out: io.push, err: io.pushErr });
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.installed).toEqual([]);
  });

  // The RETURNED transcript has to make the same split the printed output
  // does. `lines` interleaves both streams, so a programmatic caller holding
  // only the result could not tell the JSON body from a warning line without
  // re-parsing it -- exactly what routing warnings to stderr already avoids
  // for the printed copy.
  it("returns stdout and stderr separately, not just the interleaved transcript", async () => {
    writeFileSync(join(home, CONFIG_DIRNAME, "bundles.json"), "{ not json", "utf8");
    const io = captureIO();
    const r = await run({ json: true, out: io.push, err: io.pushErr });
    // The JSON body parses straight off the stdout array -- no filtering.
    const parsed = JSON.parse(r.stdout.join("\n"));
    expect(parsed.installed).toEqual([]);
    expect(r.stderr.join("\n")).toMatch(/invalid JSON/);
    expect(r.stdout.join("\n")).not.toMatch(/invalid JSON/);
    // Both streams still land in `lines`, in emission order, for callers that
    // want the transcript as printed.
    expect(r.lines).toEqual([...r.stderr, ...r.stdout]);
    // Each returned line is the printed one without the writer's newline.
    expect(r.stdout).toEqual(io.out.map((s) => s.replace(/\n$/, "")));
    expect(r.stderr).toEqual(io.err.map((s) => s.replace(/\n$/, "")));
  });

  // The config.json allow/deny profile is what actually gates activation
  // (server.ts refuses `mcp_connect_activate` on a blocked namespace), so a
  // match that ignored it printed bundles as "Ready to activate" with an
  // activate snippet the server hard-refuses.
  describe("config.json allow/deny profile", () => {
    /** Write a user-global ~/.yaw-mcp/config.json. */
    function seedConfig(config: Record<string, unknown>): void {
      writeFileSync(join(home, CONFIG_DIRNAME, "config.json"), JSON.stringify(config), "utf8");
    }

    const seedThree = (): void =>
      seedBundles([
        makeServer({ namespace: "github", name: "GitHub" }),
        makeServer({ namespace: "linear", name: "Linear" }),
        makeServer({ namespace: "slack", name: "Slack" }),
      ]);

    it("drops a denied namespace from the match and reports it as excluded", async () => {
      seedThree();
      seedConfig({ blocked: ["slack"] });
      const io = captureIO();
      const r = await run({ json: true, out: io.push, err: io.pushErr });
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(io.out.join("\n"));
      expect(parsed.installed).toEqual(expect.arrayContaining(["github", "linear"]));
      expect(parsed.installed).not.toContain("slack");
      expect(parsed.excluded).toEqual(["slack"]);
      // product-release is github+linear+slack: it must NOT be ready now.
      expect(parsed.ready.some((b: { id: string }) => b.id === "product-release")).toBe(false);
      expect(parsed.partial.some((p: { bundle: { id: string } }) => p.bundle.id === "product-release")).toBe(true);
      // pr-review (github+linear) is untouched by the deny-list.
      expect(parsed.ready.some((b: { id: string }) => b.id === "pr-review")).toBe(true);
    });

    it("names the excluded namespace in the text output", async () => {
      seedThree();
      seedConfig({ blocked: ["slack"] });
      const io = captureIO();
      await run({ out: io.push, err: io.pushErr });
      const combined = io.out.join("\n");
      expect(combined).toContain("2 available servers: github, linear");
      expect(combined).toMatch(/Excluded by your config\.json allow\/deny profile: slack/);
      expect(combined).toContain("missing: slack");
    });

    it("honours an allow-list, not just the deny-list", async () => {
      seedThree();
      seedConfig({ servers: ["github", "linear"] });
      const io = captureIO();
      const r = await run({ json: true, out: io.push, err: io.pushErr });
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(io.out.join("\n"));
      expect(parsed.installed).toEqual(expect.arrayContaining(["github", "linear"]));
      expect(parsed.excluded).toEqual(["slack"]);
    });

    it("stays quiet (no excluded line) when no profile is configured", async () => {
      seedThree();
      const io = captureIO();
      const r = await run({ out: io.push, err: io.pushErr });
      expect(r.exitCode).toBe(0);
      expect(io.out.join("\n")).not.toMatch(/Excluded by your config\.json/);
      expect(io.out.join("\n")).toContain("3 available servers");
    });
  });

  it("sorts partial bundles by fewest-missing first", async () => {
    // github → devops-incident missing 2, pr-review missing 1 (linear).
    seedBundles([makeServer({ namespace: "github" })]);
    const io = captureIO();
    await run({ out: io.push, err: io.pushErr });
    const combined = io.out.join("\n");
    const prAt = combined.indexOf("pr-review");
    const devopsAt = combined.indexOf("devops-incident");
    expect(prAt).toBeGreaterThan(-1);
    expect(devopsAt).toBeGreaterThan(-1);
    expect(prAt).toBeLessThan(devopsAt);
  });
});
