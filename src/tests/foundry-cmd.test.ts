import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOUNDRY_FILENAME } from "../foundry.js";
import { DEFAULT_OUT, defaultLoadServers, FOUNDRY_USAGE, parseFoundryArgs, runFoundryExport } from "../foundry-cmd.js";
import { DEFAULT_CORPUS_CAP } from "../foundry-corpus.js";
import { localBundlesPath } from "../local-bundles.js";
import { userConfigDir } from "../paths.js";
import { STATE_SCHEMA_VERSION, statePath } from "../persistence.js";
import type { RankableServer } from "../relevance.js";

const SERVERS: RankableServer[] = [
  { namespace: "github", name: "GitHub", description: "issues pull requests", tools: [{ name: "create_issue" }] },
  { namespace: "slack", name: "Slack", description: "channels messages", tools: [{ name: "post_message" }] },
];

describe("parseFoundryArgs", () => {
  it("parses `export` with defaults", () => {
    const p = parseFoundryArgs(["export"]);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.options.action).toBe("export");
      // PIN the defaults, don't just prove cap is positive. `out` is the path
      // the routing gate loads its fixture from, so a silent change here
      // un-gates routing with the whole suite still green.
      expect(p.options.cap).toBe(DEFAULT_CORPUS_CAP);
      expect(p.options.out).toBe(DEFAULT_OUT);
      expect(p.options.json).toBe(false);
    }
  });

  it("flags --help with a `help` discriminant rather than by the error string", () => {
    // index.ts used to recover the help case by `error === FOUNDRY_USAGE`, so
    // appending anything to the usage body at one site turned `foundry --help`
    // into a stderr dump at exit 2. The flag is the signal.
    for (const flag of ["--help", "-h"]) {
      const p = parseFoundryArgs([flag]);
      expect(p.ok).toBe(false);
      if (!p.ok) {
        expect(p.help).toBe(true);
        expect(p.error).toBe(FOUNDRY_USAGE);
      }
    }
    // A genuine argv error must never read as help, even though it embeds the
    // same usage text.
    const bad = parseFoundryArgs(["export", "--nope"]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.help).toBeUndefined();
  });

  it("parses --out / --cap / --json", () => {
    const p = parseFoundryArgs(["export", "--out", "x.json", "--cap", "50", "--json"]);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.options.out).toBe("x.json");
      expect(p.options.cap).toBe(50);
      expect(p.options.json).toBe(true);
    }
  });

  it("rejects an unknown action, a bad cap, and a missing action", () => {
    expect(parseFoundryArgs(["wat"]).ok).toBe(false);
    expect(parseFoundryArgs(["export", "--cap", "-1"]).ok).toBe(false);
    expect(parseFoundryArgs([]).ok).toBe(false);
  });
});

describe("runFoundryExport", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yaw-foundry-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const silent = { write: () => {}, writeErr: () => {} };

  it("writes a corpus from injected traces + server catalog", async () => {
    const out = join(dir, "corpus.json");
    const blob = [
      JSON.stringify({ tokens: ["issue", "pull"], chosen: "github" }),
      JSON.stringify({ tokens: ["pull", "issue"], chosen: "github" }), // dedups -> weight 2
      JSON.stringify({ tokens: ["message", "channels"], chosen: "slack" }),
    ].join("\n");
    const r = await runFoundryExport({
      out,
      cap: 500,
      json: true,
      readTraces: () => blob,
      loadServers: async () => SERVERS,
      ...silent,
    });
    expect(r.exitCode).toBe(0);
    const corpus = JSON.parse(readFileSync(out, "utf8"));
    expect(corpus.version).toBe(1);
    expect(corpus.servers).toHaveLength(2);
    const gh = corpus.entries.find((e: { chosen: string }) => e.chosen === "github");
    expect(gh.weight).toBe(2);
  });

  it("warns at export time when the corpus scores below the routing-gate floor", async () => {
    // foundry-routing.test.ts fails on a committed fixture below
    // FOUNDRY_TOP3_FLOOR; the fixture README only says to ratchet the floor
    // UP, so an export could land below it with no warning until `npm test`
    // went red. Traces whose tokens name NEITHER server's vocabulary rank
    // both near-zero, so top-3 for these two chosen servers is well under 0.7.
    const out = join(dir, "corpus.json");
    const blob = [
      JSON.stringify({ tokens: ["zzz", "qqq"], chosen: "github" }),
      JSON.stringify({ tokens: ["yyy", "www"], chosen: "slack" }),
    ].join("\n");
    const errs: string[] = [];
    const r = await runFoundryExport({
      out,
      cap: 500,
      json: false,
      readTraces: () => blob,
      loadServers: async () => SERVERS,
      write: () => {},
      writeErr: (s) => errs.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(errs.join("")).toContain("BELOW the routing gate floor");
    // --json carries the floor and the verdict so a script can gate on it.
    const jsonLines: string[] = [];
    await runFoundryExport({
      out,
      cap: 500,
      json: true,
      readTraces: () => blob,
      loadServers: async () => SERVERS,
      write: (s) => jsonLines.push(s),
      writeErr: () => {},
    });
    const summary = JSON.parse(jsonLines.join(""));
    expect(summary.floor).toBe(0.7);
    expect(summary.belowFloor).toBe(true);
  });

  it("exits 1 when there is no harvest file", async () => {
    const r = await runFoundryExport({
      out: join(dir, "c.json"),
      cap: 500,
      json: false,
      readTraces: () => null,
      loadServers: async () => SERVERS,
      ...silent,
    });
    expect(r.exitCode).toBe(1);
  });

  it("exits 1 (runtime failure, not a usage error) when no chosen server is in the local catalog", async () => {
    // Used to be 2, which the rest of the CLI reserves for an argv error --
    // a well-formed invocation must never claim the user mistyped it.
    const r = await runFoundryExport({
      out: join(dir, "c.json"),
      cap: 500,
      json: false,
      readTraces: () => JSON.stringify({ tokens: ["a", "b", "c"], chosen: "unknown" }),
      loadServers: async () => SERVERS,
      ...silent,
    });
    expect(r.exitCode).toBe(1);
  });

  it("names both drop reasons in the zero-entries message, not just the catalog mismatch", async () => {
    // buildCorpusFromTraces also drops every trace with an empty token bag
    // (the header lists both causes), but the message blamed the catalog
    // alone -- a harvest of empty bags read as "none of the chosen servers
    // are in the local catalog".
    const errs: string[] = [];
    const r = await runFoundryExport({
      out: join(dir, "c.json"),
      cap: 500,
      json: false,
      readTraces: () =>
        [
          JSON.stringify({ tokens: ["a", "b"], chosen: "unknown" }),
          JSON.stringify({ tokens: [], chosen: "github" }),
          JSON.stringify({ tokens: [], chosen: "slack" }),
        ].join("\n"),
      loadServers: async () => SERVERS,
      write: () => {},
      writeErr: (s) => {
        errs.push(s);
      },
    });
    expect(r.exitCode).toBe(1);
    const msg = errs.join("");
    expect(msg).toContain("3 traces but 0 usable entries");
    expect(msg).toContain("1 chose a server that is not in the local catalog (2 servers)");
    expect(msg).toContain("2 carried no tokens");
  });

  it("reads the harvest off disk when no readTraces hook is injected", async () => {
    // The PRODUCTION path. Every other case here injects readTraces, so the
    // readFileSync fallback -- the only thing a maintainer actually runs --
    // had no coverage at all.
    mkdirSync(userConfigDir(dir), { recursive: true });
    writeFileSync(
      join(userConfigDir(dir), FOUNDRY_FILENAME),
      `${JSON.stringify({ tokens: ["issue", "pull"], chosen: "github" })}\n`,
      "utf8",
    );
    const out = join(dir, "corpus.json");
    const r = await runFoundryExport({
      out,
      cap: 500,
      json: false,
      home: dir,
      loadServers: async () => SERVERS,
      ...silent,
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).entries).toHaveLength(1);
  });

  it("resolves a relative --out against opts.cwd, not process.cwd()", async () => {
    // `cwd` used to steer only the bundles.json lookup: the file the export
    // produced still landed relative to process.cwd(), so the one knob that
    // could redirect the command moved half of it.
    const r = await runFoundryExport({
      out: join("nested", "corpus.json"),
      cap: 500,
      json: false,
      cwd: dir,
      readTraces: () => JSON.stringify({ tokens: ["issue", "pull"], chosen: "github" }),
      loadServers: async () => SERVERS,
      ...silent,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(dir, "nested", "corpus.json"))).toBe(true);
  });

  it("warns when snapshot servers carry no tools", async () => {
    // A tool-less snapshot ranks on name + namespace only, so the printed
    // accuracy measures a catalog that cannot be the one that produced
    // `chosen`. Silence there reads as a bad corpus instead of a bad snapshot.
    const errs: string[] = [];
    const jsonLines: string[] = [];
    const r = await runFoundryExport({
      out: join(dir, "corpus.json"),
      cap: 500,
      json: true,
      readTraces: () => JSON.stringify({ tokens: ["issue", "pull"], chosen: "github" }),
      loadServers: async () => [{ namespace: "github", name: "GitHub", description: "issues", tools: [] }],
      write: (s) => jsonLines.push(s),
      writeErr: (s) => errs.push(s),
    });
    expect(r.exitCode).toBe(0);
    expect(errs.join("")).toContain("1/1 snapshot servers carry no tools");
    // The same count rides the machine-readable summary so a script can gate.
    expect(JSON.parse(jsonLines.join("")).toollessServers).toBe(1);
  });
});

describe("defaultLoadServers", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-foundry-home-"));
    // cwd lives INSIDE home so loadLocalBundles' project-trust walk-up stops
    // at the synthetic home boundary and never reaches the developer's real
    // ~/.yaw-mcp -- same isolation pattern as local-bundles.test.ts.
    cwd = mkdtempSync(join(home, "cwd-"));
    mkdirSync(userConfigDir(home), { recursive: true });
    writeFileSync(
      localBundlesPath(userConfigDir(home)),
      JSON.stringify({
        version: 1,
        servers: [{ namespace: "github", name: "GitHub", description: "issues and pulls", command: "npx" }],
      }),
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("hydrates each snapshot server's tools from the persisted tool cache", async () => {
    // bundles.json's loader drops `toolCache` on the way in, so a snapshot
    // built from the config alone gave EVERY server tools: [] -- and toolName
    // is tied with namespace for the heaviest BM25 field weight. The exported
    // corpus then replayed the floor against a catalog that could not be the
    // one that produced `chosen`.
    writeFileSync(
      statePath(userConfigDir(home)),
      JSON.stringify({
        // Derived, not retyped: a schema bump would otherwise turn this into
        // a version-mismatch test that still reads as "hydrates the tools".
        version: STATE_SCHEMA_VERSION,
        savedAt: Date.now(),
        learning: {},
        packHistory: [],
        toolCache: {
          github: { tools: [{ name: "create_issue", description: "open an issue" }], learnedAt: Date.now() },
        },
      }),
      "utf8",
    );
    const servers = await defaultLoadServers(cwd, home);
    expect(servers).toHaveLength(1);
    expect(servers[0].tools).toEqual([{ name: "create_issue", description: "open an issue" }]);
  });

  it("leaves tools empty when state.json has no entry for the namespace", async () => {
    // The honest degraded case the export's tool-less warning exists to name:
    // no state file (or an entry aged past the tool-cache TTL) means the
    // snapshot really does rank on name + namespace only.
    const servers = await defaultLoadServers(cwd, home);
    expect(servers).toHaveLength(1);
    expect(servers[0].tools).toEqual([]);
  });
});
