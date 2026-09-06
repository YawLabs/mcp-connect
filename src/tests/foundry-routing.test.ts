import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FOUNDRY_TOP3_FLOOR, type FoundryCorpus, loadFoundryCorpus, scoreCorpus } from "../foundry-corpus.js";
import { type RankableServer, rankServers } from "../relevance.js";

// ═══════════════════════════════════════════════════════════════════════
// Foundry routing regression gate (BM25 floor on REAL harvested dispatches).
//
// Sibling to routing-quality.test.ts (which gates the BM25 floor on 14
// hand-written intents). This one consumes the checked-in corpus produced by
// `yaw-mcp foundry export` from the opt-in harvest. It is a REGRESSION gate,
// not a correctness oracle: it asserts the BM25 floor keeps each real intent's
// chosen server in the top-3 (see foundry-corpus.ts for the full framing).
//
// STATE TODAY: no corpus has ever been committed, so the gate has never run.
// That is recorded here rather than papered over. This file has three states:
//
//   1. fixture ABSENT  -> DORMANT. Reported as a `todo` row plus a stderr
//      banner plus a test annotation, and named so a CI summary cannot read
//      it as coverage. Does not fail: harvesting is a maintainer opt-in
//      (YAW_MCP_FOUNDRY=1), not something CI can do for itself.
//   2. fixture PRESENT but not valid -> HARD FAIL. Previously this collapsed
//      into state 1 (loadFoundryCorpus returns null for missing AND for
//      malformed/empty/wrong-version), which meant a bumped
//      FOUNDRY_CORPUS_VERSION or a truncated file would silently un-gate
//      routing while the log claimed no fixture was ever committed.
//   3. fixture PRESENT and valid -> the real gate runs. No code change needed
//      to get here; commit the fixture and it activates. The path that gets
//      you here -- harvest with appendFoundryTrace, export off disk with
//      runFoundryExport, load the result with loadFoundryCorpus -- is proven
//      end to end in foundry-activation.test.ts, so a maintainer who harvests
//      real (and non-repeatable) traffic is not also betting that the two
//      halves of the procedure agree about the file between them.
//
// Deliberately NOT satisfied with a synthetic fixture. The gate's premise is
// real (tokens -> chosen) pairs from the full pipeline; hand-written entries
// would score whatever BM25 already does (circular, and already covered by
// routing-quality.test.ts), would be indistinguishable from harvested data to
// a future reader, and would be silently clobbered by the first real export --
// this path is the default --out of `yaw-mcp foundry export`. The harvest
// procedure lives in src/tests/fixtures/README.md.
//
// BM25-only, so it runs with no Voyage key, exactly like routing-quality.
// ═══════════════════════════════════════════════════════════════════════

// Resolved from THIS module's URL, not process.cwd(): a run started anywhere
// but the repo root (an editor's test runner, a monorepo-wide invocation) would
// otherwise miss a committed fixture and drop the gate into exactly the dormant
// state this file exists to make loud. Matches the sibling test files.
const FIXTURE = fileURLToPath(new URL("./fixtures/foundry-corpus.json", import.meta.url));
const HARVEST_DOC = join("src", "tests", "fixtures", "README.md");

// Existence and validity are separate questions -- conflating them is what
// let state 2 hide inside state 1. Both are read once at module scope.
const fixturePresent = existsSync(FIXTURE);
const corpus = loadFoundryCorpus(FIXTURE);

interface GateReport {
  top1: number;
  top3: number;
  totalWeight: number;
  // Entries the BM25 floor ranks NOTHING for -- an empty result means the
  // intent matches no server in the snapshot at all, which is a broken
  // tokenizer or a broken catalog snapshot rather than a routing miss.
  zeroCandidate: Array<{ tokens: string[]; chosen: string }>;
}

// The two measurements the gate asserts on, factored out of the assertions so
// the self-check at the bottom can prove they actually fire. Pure: no I/O, no
// fixture -- takes any corpus, including the inline probe one.
function gateReport(c: FoundryCorpus): GateReport {
  const score = scoreCorpus(c);
  const zeroCandidate: Array<{ tokens: string[]; chosen: string }> = [];
  for (const e of c.entries) {
    if (rankServers(e.tokens.join(" "), c.servers).length === 0) {
      zeroCandidate.push({ tokens: e.tokens, chosen: e.chosen });
    }
  }
  return { top1: score.top1, top3: score.top3, totalWeight: score.totalWeight, zeroCandidate };
}

describe("foundry routing regression gate", () => {
  if (!corpus) {
    if (fixturePresent) {
      // ---- State 2: present but unusable. The loudest state there is. ----
      // A fixture on disk that loadFoundryCorpus rejects means someone
      // exported one and the gate is NOT running anyway. Failing is correct:
      // the alternative is the silent dormancy this whole file exists to
      // prevent, and unlike "never harvested", this one is fixable in-repo.
      it("FAILS -- a corpus fixture exists but does not validate (gate silently un-gated)", () => {
        expect(
          corpus,
          [
            `A corpus fixture exists at ${FIXTURE} but validateCorpus rejected it,`,
            "so BM25 routing regressions are NOT gated despite a fixture being committed.",
            "Likely causes: FOUNDRY_CORPUS_VERSION was bumped (re-run `yaw-mcp foundry export`),",
            "the file was truncated or hand-edited, or `entries` is empty.",
            `See ${HARVEST_DOC}.`,
          ].join("\n"),
        ).not.toBeNull();
      });
      return;
    }

    // ---- State 1: no corpus harvested yet. Dormant, loudly. ----
    // This gate reported a quiet "skipped" from the day it landed because
    // src/tests/fixtures/ never existed, and a quiet skip reads like coverage
    // in a CI summary. Three surfaces, because no single one survives every
    // way the suite gets run (all three verified against vitest 4.1):
    //   - a `todo` row: counted in the default reporter's summary line
    //     ("N todo") and carried as status "todo" by --reporter=json,
    //   - a test annotation: rendered under the test by --reporter=verbose,
    //   - a raw stderr banner: printed by the DEFAULT reporter, which shows
    //     neither the annotation nor the todo's name.
    // The stderr write rides on a REAL, running test on purpose: vitest drops
    // console output for a file whose tests are ALL skipped, and routes
    // console.* through a per-test buffer -- both of which made the earlier
    // quiet skip invisible in exactly the summary that needed to see it.
    const banner = [
      "[foundry routing gate] DORMANT -- no corpus fixture at:",
      `  ${FIXTURE}`,
      "  BM25-floor routing regressions on REAL harvested dispatches are NOT gated.",
      "  This gate has never run. It is not a synthetic-corpus placeholder:",
      "  fabricating one would be green by construction and would read as real",
      "  traffic to every future reader.",
      `  To activate: harvest with YAW_MCP_FOUNDRY=1, then \`yaw-mcp foundry export\`.`,
      `  Full procedure: ${HARVEST_DOC}`,
    ].join("\n");

    it("reports that the foundry corpus gate is INACTIVE (no harvested corpus committed)", async ({ annotate }) => {
      process.stderr.write(`${banner}\n`);
      await annotate(
        "foundry routing gate is DORMANT: no harvested corpus committed, so BM25 routing " +
          `regressions over real dispatches are NOT gated. Activate per ${HARVEST_DOC}.`,
        "warning",
      );
      // Assert the state this branch claims, so the banner can never go stale.
      // Both checks re-read DISK at test time. Re-asserting the `fixturePresent`
      // const would be tautological -- it is the very condition this branch
      // switched on, so it cannot be anything but false here -- while a fresh
      // existsSync can still catch a fixture that landed after module load
      // (a --watch rerun, a concurrent export) and would make the banner a lie.
      expect(existsSync(FIXTURE), `${FIXTURE} exists -- the dormant branch should not have been taken`).toBe(false);
      expect(loadFoundryCorpus(FIXTURE)).toBeNull();
    });

    // A `todo` (not `skip`): reporters count and print todos as outstanding
    // work rather than as an intentionally-disabled test, and the name is
    // written to be read cold out of a CI log.
    it.todo(
      "BM25 routing regressions over REAL harvested dispatches -- NOT gated until a corpus is exported " +
        `(YAW_MCP_FOUNDRY=1 + \`yaw-mcp foundry export\`; see ${HARVEST_DOC})`,
    );
    return;
  }

  // ---- State 3: a real corpus is committed. The gate is live. ----
  it(`BM25 floor keeps chosen servers in the top-3 (>= ${FOUNDRY_TOP3_FLOOR})`, async ({ annotate }) => {
    const r = gateReport(corpus);
    // Surface the measured numbers on the GREEN path too (visible under
    // --reporter=verbose): FOUNDRY_TOP3_FLOOR is meant to be ratcheted up
    // toward the last green measurement, and that is hard to do if the only
    // way to see the measurement is to make the gate fail.
    await annotate(
      `BM25 floor over ${r.totalWeight} weighted real dispatches: top-1 ${(r.top1 * 100).toFixed(1)}%, ` +
        `top-3 ${(r.top3 * 100).toFixed(1)}% (floor ${FOUNDRY_TOP3_FLOOR}). Ratchet the floor toward top-3.`,
      "notice",
    );
    expect(
      r.top3,
      `top-3 ${(r.top3 * 100).toFixed(1)}% over ${r.totalWeight} weighted real dispatches; if this dropped, a BM25/tokenization change regressed real-world routing`,
    ).toBeGreaterThanOrEqual(FOUNDRY_TOP3_FLOOR);
  });

  it("every corpus entry resolves to at least one ranked candidate", () => {
    // A zero-candidate entry means the tokenizer or the server snapshot
    // broke: rankServers drops every server whose score is 0, so an empty
    // result is "this intent matches nothing in the catalog at all".
    // Asserting totalWeight > 0 would NOT catch that -- totalWeight is just
    // the sum of entry weights and is positive for any validated corpus,
    // even one where every single entry ranks nothing.
    const { zeroCandidate } = gateReport(corpus);
    expect(
      zeroCandidate,
      `${zeroCandidate.length}/${corpus.entries.length} corpus entries ranked zero candidates, e.g. ${JSON.stringify(
        zeroCandidate.slice(0, 3),
      )}`,
    ).toEqual([]);
    // Deliberately NOT asserted here: that `chosen` itself is ranked. The
    // BM25 floor is not a correctness oracle (see foundry-corpus.ts), and
    // the FOUNDRY_TOP3_FLOOR gate above already tolerates a fraction of
    // real dispatches the lexical floor misses. Requiring every `chosen`
    // to score > 0 would fail on legitimate learning/health-driven routes.
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Self-check: proves the gate above CAN fail.
//
// The gate has never executed against a corpus, so its assertions are
// unexercised code -- "it passes" today is indistinguishable from "it cannot
// fail". This block runs gateReport against a deliberately-broken inline
// probe and asserts it reports the breakage, so whenever a real corpus does
// land, the machinery consuming it is known to work.
//
// Sibling coverage, deliberately in another file: this block proves the gate
// can go RED on a corpus handed to it in memory, while
// foundry-activation.test.ts proves an EXPORTED corpus reaches it at all
// (harvest -> `foundry export` off disk -> loadFoundryCorpus -> scoreCorpus,
// against a temp home and a temp --out). Neither is a routing corpus; both
// exist so the only missing ingredient here is real traffic.
//
// The probe below is NOT a routing corpus and is NOT harvested data: two
// nonsense servers, two entries constructed to miss on purpose, never written
// to disk, and asserted on for the OPPOSITE of routing quality (it asserts
// the gate goes red). It measures nothing about real-world routing and must
// never be mistaken for the fixture -- see src/tests/fixtures/README.md.
// ═══════════════════════════════════════════════════════════════════════

const PROBE_SERVERS: RankableServer[] = [
  { namespace: "probe_alpha", name: "Probe Alpha", description: "alphaword", tools: [] },
  { namespace: "probe_beta", name: "Probe Beta", description: "betaword", tools: [] },
];

// Entry 1 lexically points at probe_alpha but claims probe_beta -> a top-3
// MISS (probe_beta scores 0 and is dropped entirely, so it cannot be in any
// top-K). Entry 2's token matches nothing at all -> a ZERO-CANDIDATE entry.
const PROBE_CORPUS: FoundryCorpus = {
  version: 1,
  servers: PROBE_SERVERS,
  entries: [
    { tokens: ["alphaword"], chosen: "probe_beta", weight: 1 },
    { tokens: ["qqzzxxnomatch"], chosen: "probe_alpha", weight: 1 },
  ],
};

describe("foundry routing gate self-check (mechanism only -- gates NO routing)", () => {
  it("gateReport reports a top-3 miss, so the floor assertion can go red", () => {
    const r = gateReport(PROBE_CORPUS);
    expect(r.totalWeight).toBe(2);
    expect(r.top1).toBe(0);
    expect(r.top3).toBe(0);
    // The exact thing the live gate asserts, inverted: a corpus the floor
    // misses must fall BELOW the floor rather than sneak past it.
    expect(r.top3).toBeLessThan(FOUNDRY_TOP3_FLOOR);
  });

  it("gateReport flags an entry that ranks zero candidates", () => {
    const r = gateReport(PROBE_CORPUS);
    expect(r.zeroCandidate).toEqual([{ tokens: ["qqzzxxnomatch"], chosen: "probe_alpha" }]);
    // ...and does NOT flag an entry that ranks something but ranks it wrong:
    // a routing miss and a dead tokenizer are different failures.
    expect(rankServers("alphaword", PROBE_SERVERS).length).toBeGreaterThan(0);
  });

  it("the floor is a real threshold (a zeroed floor would gate nothing)", () => {
    // Guards the other silent-dormancy route: shipping FOUNDRY_TOP3_FLOOR = 0
    // to quiet a red gate would leave every assertion above trivially true.
    expect(FOUNDRY_TOP3_FLOOR).toBeGreaterThan(0);
    expect(FOUNDRY_TOP3_FLOOR).toBeLessThanOrEqual(1);
  });
});
