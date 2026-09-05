// Property test for the BM25 ranking cache -- issue #90.
//
// PR #84 replaced a per-call index rebuild with a content-keyed cache. Its
// strongest evidence was a differential run against the pre-cache scorer over
// 4000 randomized corpora, but that harness lived only in the PR description,
// and the implementation it diffed against left the tree when #84 merged.
//
// Retargeted here to the invariant that survives: a CACHED rank must equal a
// FRESHLY BUILT rank, exactly, for the same corpus and query. That catches the
// same class of regression -- a wrong index served to the wrong corpus, a stale
// doc, a key collision -- without needing a frozen copy of the old scorer, and
// it keeps guarding bm25Score, the DF/IDF loops, and the signature/key encoding
// indefinitely.
//
// Exact float equality is deliberate. The cached and uncached paths run the
// same arithmetic in the same order, so any difference at all is a defect, not
// a rounding artifact.

import { describe, expect, it } from "vitest";
import { rankServers, resetRelevanceCache } from "../relevance.js";

// ---------------------------------------------------------------------------
// Seeded RNG -- mulberry32. Deterministic so a red run reproduces; the seed is
// surfaced in every failure message so a counterexample can be replayed.
// ---------------------------------------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "github",
  "issue",
  "pull",
  "request",
  "slack",
  "message",
  "channel",
  "postgres",
  "query",
  "database",
  "deploy",
  "kubernetes",
  "widget",
  "alpha",
  "beta",
  "gamma",
];

// Control characters belong in the corpus on purpose: the cache key encoding
// is the least-covered part of the cache, and it is where a collision produces
// a wrong-but-plausible ranking rather than an obvious crash. Tool names and
// descriptions come from third-party upstream servers over JSON-RPC, where
// these are legal string content.
const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);

function makeCorpus(rand: () => number): Array<{
  namespace: string;
  name: string;
  description?: string;
  tools: Array<{ name: string; description?: string }>;
}> {
  const pick = () => WORDS[Math.floor(rand() * WORDS.length)];
  const phrase = (n: number) =>
    Array.from({ length: n }, pick)
      .join(" ")
      // Sprinkle control characters into ~8% of generated text.
      .concat(rand() < 0.08 ? (rand() < 0.5 ? NUL : SOH) + pick() : "");

  const serverCount = 1 + Math.floor(rand() * 8);
  return Array.from({ length: serverCount }, (_, i) => {
    const toolCount = Math.floor(rand() * 5);
    return {
      namespace: `ns${i}${rand() < 0.1 ? ` ${pick()}` : ""}`,
      name: phrase(1 + Math.floor(rand() * 3)),
      // Absent descriptions are a real shape (a server with no description).
      description: rand() < 0.2 ? undefined : phrase(1 + Math.floor(rand() * 6)),
      tools: Array.from({ length: toolCount }, (_, j) => ({
        name: `${pick()}_${pick()}_${j}`,
        description: rand() < 0.25 ? undefined : phrase(1 + Math.floor(rand() * 5)),
      })),
    };
  });
}

function makeQuery(rand: () => number): string {
  const pick = () => WORDS[Math.floor(rand() * WORDS.length)];
  const roll = rand();
  if (roll < 0.08) return ""; // empty query -- must return []
  if (roll < 0.16) return "zzzznomatch qqqqnothing"; // matches nothing
  if (roll < 0.24) {
    const w = pick(); // repeated terms -- exercises k1 saturation
    return `${w} ${w} ${w}`;
  }
  return Array.from({ length: 1 + Math.floor(rand() * 4) }, pick).join(" ");
}

/** Rank with a guaranteed-cold cache. */
function rankCold(query: string, corpus: ReturnType<typeof makeCorpus>) {
  resetRelevanceCache();
  return rankServers(query, corpus);
}

// Default keeps `npm test` fast; raise for a deeper sweep without editing code.
//
// Parsed defensively: Number("abc") is NaN and `i < NaN` is false, so a typo'd
// value used to run every loop below ZERO times and pass all four properties
// vacuously under a title reading "across NaN randomized corpora". Anything
// that does not floor to a positive integer falls back to the default.
function resolveIterations(raw: string | undefined, fallback = 400): number {
  if (raw === undefined) return fallback;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}
const ITERATIONS = resolveIterations(process.env.YAW_RELEVANCE_PROPERTY_ITERATIONS);

describe("resolveIterations", () => {
  it("falls back to the default instead of running zero iterations on a bad value", () => {
    expect(resolveIterations(undefined)).toBe(400);
    expect(resolveIterations("abc")).toBe(400);
    expect(resolveIterations("")).toBe(400);
    expect(resolveIterations("0")).toBe(400);
    expect(resolveIterations("-5")).toBe(400);
    expect(resolveIterations("0.5")).toBe(400);
    expect(resolveIterations("Infinity")).toBe(400);
    expect(resolveIterations("12.7")).toBe(12);
    expect(resolveIterations("50")).toBe(50);
  });

  it("never lets the property suite below run vacuously", () => {
    expect(Number.isInteger(ITERATIONS) && ITERATIONS >= 1).toBe(true);
  });
});

describe("relevance cache property: cached rank === freshly built rank", () => {
  it(`agrees exactly across ${ITERATIONS} randomized corpora`, () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = 0x9e3779b9 ^ i;
      const rand = rng(seed);
      const corpus = makeCorpus(rand);
      const query = makeQuery(rand);
      const ctx = `seed=${seed} i=${i} query=${JSON.stringify(query)} servers=${corpus.length}`;

      const cold = rankCold(query, corpus);
      // Same corpus, cache now warm -- must be byte-identical, not merely similar.
      const warm = rankServers(query, corpus);

      expect(warm.length, `length differs; ${ctx}`).toBe(cold.length);
      for (let k = 0; k < cold.length; k++) {
        // Ordering matters as much as the scores: the tie-break in rankServers
        // exists precisely so callers can rely on a stable order.
        expect(warm[k].namespace, `order differs at ${k}; ${ctx}`).toBe(cold[k].namespace);
        expect(warm[k].score, `score differs at ${k}; ${ctx}`).toBe(cold[k].score);
      }
    }
  });

  it("survives interleaving a second corpus between two ranks of the first", () => {
    // The shape that actually exercises key collisions: A, then B, then A
    // again. If B's index is ever served to A, this is what catches it -- a
    // plain warm/cold pair never would, because nothing else entered the cache.
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = 0x85ebca6b ^ i;
      const rand = rng(seed);
      const corpusA = makeCorpus(rand);
      const corpusB = makeCorpus(rand);
      const query = makeQuery(rand);
      const ctx = `seed=${seed} i=${i} query=${JSON.stringify(query)}`;

      const baseline = rankCold(query, corpusA);
      rankServers(query, corpusB); // pollute the cache with a different corpus
      const afterB = rankServers(query, corpusA);

      expect(afterB.length, `length changed after interleave; ${ctx}`).toBe(baseline.length);
      for (let k = 0; k < baseline.length; k++) {
        expect(afterB[k].namespace, `order changed after interleave at ${k}; ${ctx}`).toBe(baseline[k].namespace);
        expect(afterB[k].score, `score changed after interleave at ${k}; ${ctx}`).toBe(baseline[k].score);
      }
    }
  });

  it("keeps boundary-shifted and control-character-bearing corpora on separate indexes", () => {
    // Independently-random corpora almost never collide by chance, so the
    // tests above would not notice if the key stopped being injective. These
    // pairs are built to collide: same concatenated text, different field
    // split. Under a bare separator, `ns "a b" + name "c"` signs identically
    // to `ns "a" + name "b c"` -- and the text that triggers it can come from
    // an upstream server, since a control character is legal in a tool name.
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = 0x27d4eb2f ^ i;
      const rand = rng(seed);
      const pick = () => WORDS[Math.floor(rand() * WORDS.length)];
      const [a, b, c] = [pick(), pick(), pick()];
      // Rotate the joiner so the pair is adversarial against a space separator
      // AND against either control character.
      const join = [" ", NUL, SOH][i % 3];
      const ctx = `seed=${seed} i=${i} join=${JSON.stringify(join)}`;

      const left = [{ namespace: `${a}${join}${b}`, name: c, description: "", tools: [] }];
      const right = [{ namespace: a, name: `${b}${join}${c}`, description: "", tools: [] }];
      const query = [a, b, c][i % 3];

      const leftCold = rankCold(query, left);
      const rightCold = rankCold(query, right);

      // Now interleave through one warm cache: each must still reproduce its
      // own cold result. A shared key shows up here as one serving the other's
      // index -- and since namespace and name carry different field weights
      // (2.0 vs 3.0), a collision changes the score, not just the identity.
      resetRelevanceCache();
      const leftWarm = rankServers(query, left);
      const rightWarm = rankServers(query, right);
      const leftAgain = rankServers(query, left);

      expect(
        leftWarm.map((r) => r.score),
        `left drifted; ${ctx}`,
      ).toEqual(leftCold.map((r) => r.score));
      expect(
        rightWarm.map((r) => r.score),
        `right served left's index; ${ctx}`,
      ).toEqual(rightCold.map((r) => r.score));
      expect(
        leftAgain.map((r) => r.score),
        `left drifted after right; ${ctx}`,
      ).toEqual(leftCold.map((r) => r.score));
    }
  });

  it("never lets a corpus be scored against another corpus's document set", () => {
    // A key collision would not only change scores, it could return a
    // namespace the caller never passed in -- the loudest possible symptom,
    // and cheap to assert.
    for (let i = 0; i < ITERATIONS; i++) {
      const rand = rng(0xc2b2ae35 ^ i);
      const corpus = makeCorpus(rand);
      const known = new Set(corpus.map((s) => s.namespace));
      resetRelevanceCache();
      rankServers(makeQuery(rng(i)), makeCorpus(rng(i + 7))); // unrelated corpus first
      for (const r of rankServers(makeQuery(rand), corpus)) {
        expect(known.has(r.namespace), `foreign namespace ${JSON.stringify(r.namespace)} at i=${i}`).toBe(true);
      }
    }
  });
});
