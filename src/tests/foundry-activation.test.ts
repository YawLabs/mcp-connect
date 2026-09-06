import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFoundryTrace, FOUNDRY_FILENAME, redactIntent } from "../foundry.js";
import { DEFAULT_OUT, runFoundryExport } from "../foundry-cmd.js";
import {
  FOUNDRY_CORPUS_VERSION,
  FOUNDRY_TOP3_FLOOR,
  loadFoundryCorpus,
  parseTraceLines,
  scoreCorpus,
} from "../foundry-corpus.js";
import { userConfigDir } from "../paths.js";
import { type RankableServer, rankServers } from "../relevance.js";

// ═══════════════════════════════════════════════════════════════════════
// Foundry ACTIVATION path: harvest -> export -> load, end to end.
//
// THIS FILE IS A MECHANISM TEST. It is NOT harvested data, NOT a routing
// corpus, and NOT a second copy of the routing gate. Everything it feeds the
// pipeline is synthetic: five invented intent strings and a five-server
// catalog that exist only in this file, written to a TEMP home and a TEMP
// --out that are deleted in afterEach. Nothing here ever touches
// src/tests/fixtures/foundry-corpus.json -- a guard test at the bottom
// asserts that -- and no assertion here measures routing quality. Read
// src/tests/fixtures/README.md ("Do not hand-write this file") for why a
// synthetic corpus at the fixture path would be worse than the honest skip;
// the same reasoning is why the numbers asserted below are plumbing numbers
// (does the count survive the disk round-trip, does the loader accept what
// the writer wrote) and never accuracy numbers.
//
// WHAT IT COVERS THAT NOTHING ELSE DID: the seam between the two halves of
// the maintainer procedure. foundry.test.ts drives appendFoundryTrace and
// stops at the .jsonl. foundry-cmd.test.ts drives runFoundryExport with
// INJECTED traces and stops at "a file was written". foundry-corpus.test.ts
// only ever calls loadFoundryCorpus on a MISSING path. So nothing asserted
// that what the export WRITES is something loadFoundryCorpus ACCEPTS -- and
// if that seam is broken, the maintainer harvests real, privacy-sensitive,
// non-repeatable traffic, exports, commits, and lands in foundry-routing's
// hard-fail state 2 ("a fixture exists but does not validate") instead of the
// live state 3, with no way to re-run the traffic that produced it.
//
// Both halves run for real here: appendFoundryTrace with YAW_MCP_FOUNDRY=1
// (the actual harvest writer, actual fs), then runFoundryExport with NO
// readTraces hook, so it reads the .jsonl back off disk exactly as
// `yaw-mcp foundry export` does. Only the server catalog is injected via
// loadServers, because the production loader wants a real bundles.json plus
// state.json -- defaultLoadServers has its own coverage in foundry-cmd.test.ts.
// ═══════════════════════════════════════════════════════════════════════

// The catalog the export snapshots into the corpus. Five servers with
// deliberately disjoint vocabularies, which makes the top-3 slice DEGENERATE
// here and that is worth saying out loud: each invented bag below hits exactly
// one of these servers, rankServers drops every server that scored zero, so
// each corpus entry ranks exactly ONE candidate and top-1 and top-3 both come
// back 1.0 on every run. "Top-3" is not an actual cut over this catalog -- it
// is "the one server that scored at all".
//
// That is fine, because nothing in this file asserts accuracy. What is pinned
// is round-trip arithmetic: the counts and weights survive the disk trip, and
// the numbers the export PUBLISHES are the numbers scoreCorpus MEASURES on the
// file it wrote. Do not "fix" the degeneracy by giving these servers
// overlapping vocabulary so the ranker has to choose: the moment a bag can
// plausibly score two servers, an assertion about where `chosen` lands becomes
// a routing expectation, and this file's subject is the export -> load
// contract, not routing. Routing quality is routing-quality.test.ts's job over
// an authored catalog, and the real corpus gate's job over real traffic.
const SERVERS: RankableServer[] = [
  {
    namespace: "github",
    name: "GitHub",
    description: "issues pull requests repositories",
    tools: [{ name: "create_issue" }, { name: "list_pull_requests" }],
  },
  { namespace: "slack", name: "Slack", description: "channels messages threads", tools: [{ name: "post_message" }] },
  {
    namespace: "stripe",
    name: "Stripe",
    description: "charges customers subscriptions invoices",
    tools: [{ name: "create_charge" }],
  },
  {
    namespace: "postgres",
    name: "Postgres",
    description: "tables rows queries schema",
    tools: [{ name: "run_query" }],
  },
  { namespace: "linear", name: "Linear", description: "tickets sprints backlog", tools: [{ name: "create_ticket" }] },
];

// Invented dispatch intents. These are RAW strings, the shape server.ts hands
// to redactIntent at the dispatch call site (server.ts:3735), and they go
// through the real redactor below rather than being hand-written as token
// bags -- so the traces on disk carry whatever redactIntent actually emits
// today (sorted, lowercased, bare alphanumeric runs, structured PII scrubbed)
// instead of a guess at that shape that would drift the moment it changes.
//
// The last two are the same word multiset in a different order: redactIntent
// sorts, so both fold into ONE corpus entry with weight 2. That is the dedup
// key surviving the disk round-trip, not a claim about routing.
//
// Each intent is phrased in vocabulary the catalog above actually indexes, so
// the zero-candidate check further down measures the ROUND TRIP (bags and
// snapshot survived JSON intact) rather than the ranker. That is a property
// of these invented sentences, not evidence about real intents: BM25 does no
// stemming, so an off-by-a-plural bag ("channel" against a catalog that only
// says "channels") ranks nothing at all, which is a fine thing for a real
// corpus to contain and a useless thing for a plumbing test to trip on.
const INTENTS: Array<{ intent: string; chosen: string }> = [
  { intent: "open a github issue about the failing build", chosen: "github" },
  { intent: "list the pull requests waiting on review", chosen: "github" },
  // Carries an email, so the harvest on disk can be checked for raw intent.
  { intent: "notify alice@example.com in the slack channels", chosen: "slack" },
  { intent: "post a message to the deploys channel", chosen: "slack" },
  { intent: "to the deploys channel post a message", chosen: "slack" },
];

// The real fixture path, resolved from THIS module's URL exactly as
// foundry-routing.test.ts resolves it (not from process.cwd()). Nothing in
// this file may write here; the guard test at the bottom asserts every --out
// this file uses is somewhere else entirely.
const REAL_FIXTURE = fileURLToPath(new URL("./fixtures/foundry-corpus.json", import.meta.url));

interface ExportSummary {
  entries: number;
  servers: number;
  toollessServers: number;
  fromTraces: number;
  top1: number;
  top3: number;
  floor: number;
  belowFloor: boolean;
}

interface Exported {
  outPath: string;
  harvestPath: string;
  exitCode: number;
  /** The export's own --json summary, so the numbers it publishes to the
   *  maintainer can be compared against what the gate later measures on the
   *  file it wrote. */
  summary: ExportSummary;
  stderr: string;
}

/** Steps 1 and 2 of the maintainer procedure, for real: harvest through the
 *  opt-in writer into `home`, then export from that home into a temp --out.
 *  Passes NO readTraces hook on purpose -- reading the .jsonl back off disk
 *  is half of the contract under test. */
async function harvestAndExport(home: string): Promise<Exported> {
  for (const { intent, chosen } of INTENTS) {
    const redacted = redactIntent(intent);
    // Exactly the shape server.ts writes: tokens + redactedCount + chosen.
    await appendFoundryTrace({ tokens: redacted.tokens, redactedCount: redacted.redactedCount, chosen }, home);
  }
  const outPath = join(home, "out", "corpus.json");
  const stdout: string[] = [];
  const stderr: string[] = [];
  const r = await runFoundryExport({
    out: outPath,
    cap: 500,
    json: true,
    home,
    loadServers: async () => SERVERS,
    write: (s) => stdout.push(s),
    writeErr: (s) => stderr.push(s),
  });
  return {
    outPath,
    harvestPath: join(userConfigDir(home), FOUNDRY_FILENAME),
    exitCode: r.exitCode,
    summary: r.exitCode === 0 ? JSON.parse(stdout.join("")) : ({} as ExportSummary),
    stderr: stderr.join("\n"),
  };
}

describe("foundry activation path (mechanism only -- synthetic traces, temp home, gates NO routing)", () => {
  let home: string;
  const origEnv = process.env.YAW_MCP_FOUNDRY;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-foundry-activation-"));
    // The harvest is opt-in and silently no-ops when unset; every test here
    // depends on the writer actually writing.
    process.env.YAW_MCP_FOUNDRY = "1";
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.YAW_MCP_FOUNDRY;
    else process.env.YAW_MCP_FOUNDRY = origEnv;
  });

  it("the real harvest writer produces a .jsonl the real export reads off disk", async () => {
    const e = await harvestAndExport(home);
    expect(e.exitCode, e.stderr).toBe(0);

    // The harvest landed where the export went looking for it, one line per
    // dispatch, and every line parses back through the export's own parser.
    const blob = readFileSync(e.harvestPath, "utf8");
    expect(blob.trim().split("\n")).toHaveLength(INTENTS.length);
    expect(parseTraceLines(blob)).toHaveLength(INTENTS.length);
    // ...and the export folded all of them rather than reading a stale or
    // partial file: fromTraces is what parseTraceLines handed runFoundryExport.
    expect(e.summary.fromTraces).toBe(INTENTS.length);

    // The writer under test is the privacy-safe one, so no raw intent reaches
    // disk. redactIntent's own rules are covered in foundry.test.ts; what is
    // pinned here is that the REDACTED result is what got written.
    expect(blob).not.toContain("alice@example.com");
    expect(blob).not.toContain("alice");
    expect(blob).not.toContain("@");
  });

  it("loadFoundryCorpus ACCEPTS what runFoundryExport wrote (the uncovered seam)", async () => {
    const e = await harvestAndExport(home);
    expect(e.exitCode, e.stderr).toBe(0);

    // These are the two reads foundry-routing.test.ts makes at module scope,
    // and together they pick its state: present + valid is state 3 (the gate
    // runs), present + invalid is state 2 (hard fail, "a fixture exists but
    // does not validate"). Running them against the file the export just
    // wrote is what proves the maintainer path lands in 3 and not 2 -- a
    // failure that would otherwise surface only AFTER real, non-repeatable
    // traffic had been harvested and committed.
    expect(existsSync(e.outPath)).toBe(true);
    const corpus = loadFoundryCorpus(e.outPath);
    expect(
      corpus,
      "runFoundryExport wrote a corpus loadFoundryCorpus rejects -- the maintainer path lands in foundry-routing state 2 (hard fail), not state 3 (gate live)",
    ).not.toBeNull();
    if (!corpus) return; // Narrowing only; the assertion above has already failed.

    expect(corpus.version).toBe(FOUNDRY_CORPUS_VERSION);

    // The catalog snapshot survived JSON serialization WITH its tools. Tools
    // are the field defaultLoadServers exists to hydrate (toolName ties with
    // namespace for the heaviest BM25 weight), so a snapshot that round-trips
    // tool-less would replay the floor against a catalog that could not be
    // the one that produced `chosen`.
    expect(corpus.servers).toHaveLength(SERVERS.length);
    expect(corpus.servers).toEqual(SERVERS);

    // Every harvested trace is accounted for on the far side of the disk: the
    // entry count is the number of DISTINCT (sorted tokens, chosen) keys and
    // the weights sum back to the number of dispatches. Derived through
    // redactIntent rather than hardcoded, so a redactor change moves both
    // sides together instead of leaving a stale constant behind.
    const expectedKeys = new Set(
      INTENTS.map(({ intent, chosen }) => `${redactIntent(intent).tokens.join(" ")}::${chosen}`),
    );
    expect(corpus.entries).toHaveLength(expectedKeys.size);
    expect(corpus.entries.reduce((n, x) => n + x.weight, 0)).toBe(INTENTS.length);
    expect(
      corpus.entries.some((x) => x.weight === 2),
      "the reordered intent pair should have folded into one weight-2 entry",
    ).toBe(true);

    // Token bags come out the way redactIntent emits them: sorted, lowercase,
    // bare alphanumeric runs. The gate joins these back into a query string,
    // so a bag carrying separators or case would be scored against a
    // different tokenization than the one that produced it.
    for (const entry of corpus.entries) {
      expect(entry.tokens.length).toBeGreaterThan(0);
      expect(entry.tokens).toEqual([...entry.tokens].sort());
      for (const t of entry.tokens) expect(t).toMatch(/^[a-z0-9]+$/);
    }
  });

  it("the gate machinery scores the exported corpus, and scores it the way the export reported", async () => {
    const e = await harvestAndExport(home);
    expect(e.exitCode, e.stderr).toBe(0);
    const corpus = loadFoundryCorpus(e.outPath);
    expect(corpus).not.toBeNull();
    if (!corpus) return;

    const score = scoreCorpus(corpus);

    // Sane numbers, and nothing more than that. Over this catalog every entry
    // ranks exactly one candidate (see the SERVERS note above), so top1 and
    // top3 are both 1.0 every run and the `top3 >= top1` line below is 1 >= 1.
    // It does not pin that top-3 is a wider cut than top-1; it pins that
    // scoreCorpus consumed an exported corpus at all and handed back two
    // in-range, comparable numbers rather than NaN, undefined, or the 0/0 a
    // corpus that folded to nothing would produce. NOT a routing claim -- both
    // the intents and the catalog are invented above.
    expect(score.totalWeight).toBe(INTENTS.length);
    expect(score.top1).toBeGreaterThanOrEqual(0);
    expect(score.top3).toBeLessThanOrEqual(1);
    expect(score.top3).toBeGreaterThanOrEqual(score.top1);

    // The measurement the maintainer READS at export time has to be the
    // measurement the gate MAKES on the committed file. If those ever
    // disagree, the export's below-floor warning (foundry-cmd.ts) is advice
    // about a different corpus than the one on disk -- exactly the class of
    // surprise this file exists to rule out.
    expect(score.top1).toBeCloseTo(e.summary.top1, 12);
    expect(score.top3).toBeCloseTo(e.summary.top3, 12);
    expect(e.summary.entries).toBe(corpus.entries.length);
    expect(e.summary.servers).toBe(corpus.servers.length);
    expect(e.summary.toollessServers).toBe(0);
    // Deliberately NOT `expect(score.top3).toBeGreaterThanOrEqual(FOUNDRY_TOP3_FLOOR)`:
    // over invented intents that is a routing assertion, green by
    // construction, and a second gate the fixtures README says must not
    // exist. What is checked instead is the floor VERDICT the export
    // publishes -- but only the ABOVE-floor side of it runs here. top3 is 1.0
    // over this corpus (again, one candidate per entry), so this pins
    // `belowFloor === false`: it catches an inverted or wrong-sided comparison
    // in foundry-cmd.ts, and it catches the export publishing a floor constant
    // that has drifted from FOUNDRY_TOP3_FLOOR. It would NOT catch the
    // computation being dropped entirely -- a production `belowFloor` pinned
    // to a constant false leaves this file green.
    //
    // The below-floor side is covered next door, in foundry-cmd.test.ts:103
    // ("warns at export time when the corpus scores below the routing-gate
    // floor"), which feeds traces whose tokens name neither server's
    // vocabulary and asserts both the stderr warning and `belowFloor === true`
    // in the --json summary. It stays there on purpose: engineering intents
    // that MISS on this catalog would make the miss itself the thing under
    // test, which is the routing assertion the paragraph above refuses to
    // make.
    expect(e.summary.floor).toBe(FOUNDRY_TOP3_FLOOR);
    expect(e.summary.belowFloor).toBe(score.top3 < FOUNDRY_TOP3_FLOOR);

    // The gate's other assertion, run against real exported output: every
    // entry ranks at least one candidate. rankServers drops zero-scoring
    // servers, so an empty result means the bag matches nothing in the
    // snapshot at all -- a bag or a catalog that did not survive the trip.
    const zeroCandidate = corpus.entries.filter((x) => rankServers(x.tokens.join(" "), corpus.servers).length === 0);
    expect(zeroCandidate, `${zeroCandidate.length} exported entries ranked zero candidates`).toEqual([]);
  });

  it("never harvests from the real home or writes to the real corpus fixture", async () => {
    // The standing guard over this whole file. src/tests/fixtures/README.md is
    // explicit that a synthetic corpus at the fixture path would be worse than
    // the honest skip, and DEFAULT_OUT puts that path one careless default
    // away: runFoundryExport resolves a relative `out` against cwd, so an
    // `out` left unset here would land ON the fixture the routing gate loads.
    const e = await harvestAndExport(home);
    expect(e.exitCode, e.stderr).toBe(0);
    expect(resolve(e.outPath)).not.toBe(resolve(REAL_FIXTURE));
    expect(resolve(e.outPath)).not.toBe(resolve(DEFAULT_OUT));
    expect(resolve(e.outPath).startsWith(resolve(tmpdir()))).toBe(true);
    expect(resolve(e.harvestPath).startsWith(resolve(tmpdir()))).toBe(true);
    expect(resolve(home)).not.toBe(resolve(homedir()));
  });
});
