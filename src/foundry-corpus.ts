// Foundry corpus: turn harvested dispatch traces (foundry.jsonl, written by
// foundry.ts when YAW_MCP_FOUNDRY is on) into a checked-in regression corpus,
// and score the BM25 ranker against it.
//
// What this gate measures (and what it does NOT):
//   It is a BM25-FLOOR REGRESSION gate, not a correctness oracle. Each entry
//   is a real (redacted token bag -> chosen server) pair, where `chosen` is
//   the server the FULL pipeline (BM25 + rerank + health + learning + sampling)
//   actually routed to. The gate asserts that the BM25-only floor still ranks
//   `chosen` in its top-K on those real intents -- i.e. a change to BM25
//   weights/tokenization doesn't drop real-world choices out of contention.
//   It does NOT claim `chosen` was the objectively correct server; richer
//   ground-truth labels (re-dispatch / graded-reward / thumbs) are a future
//   enrichment. Because it scores the BM25 floor (no semantic stage), it
//   runs in CI exactly like routing-quality.test.ts.
//
// The corpus is a checked-in fixture, not live data. A maintainer runs
// `yaw-mcp foundry export` to fold ~/.yaw-mcp/foundry.jsonl into the fixture;
// the gate consumes it. Until a fixture exists the gate cleanly skips.

import { readFileSync } from "node:fs";
import { type RankableServer, type RankableTool, rankServers } from "./relevance.js";

export const FOUNDRY_CORPUS_VERSION = 1 as const;

// Default cap on corpus entries. Keeps the checked-in fixture bounded; the
// export stratifies by `chosen` so rare servers survive the cap.
export const DEFAULT_CORPUS_CAP = 500;

// Minimum weighted top-3 accuracy the gate requires. Starts conservative;
// ratchet UP toward the last green measurement as the corpus matures so the
// gate tightens with the data instead of rubber-stamping a regression.
export const FOUNDRY_TOP3_FLOOR = 0.7;

// One harvested trace as written by foundry.ts/appendFoundryTrace.
//
// No `candidates` field: appendFoundryTrace used to persist the ranker's
// shortlist ns-only (scores stripped, because a score reflects the ranker's
// live health/learning state and would bias an eval replay against that same
// state), but nothing ever read it back, so it was dropped from the write.
// A line left over from an older harvest may still carry the key -- parsing
// ignores unknown keys, so such a file folds into a corpus unchanged.
export interface HarvestedTrace {
  tokens: string[];
  chosen: string;
  redactedCount?: number;
}

export interface FoundryCorpusEntry {
  // Redacted, sorted token bag (order already destroyed at harvest time).
  tokens: string[];
  // The namespace the full pipeline routed this intent to.
  chosen: string;
  // How many harvested traces collapsed into this entry (same tokens+chosen).
  weight: number;
}

export interface FoundryCorpus {
  version: typeof FOUNDRY_CORPUS_VERSION;
  // Server catalog snapshot to re-rank against, captured at export time.
  servers: RankableServer[];
  entries: FoundryCorpusEntry[];
}

// Parse a foundry.jsonl blob into traces. Skips blank/garbage lines (the file
// is append-only telemetry; a torn final line must not abort the whole parse).
export function parseTraceLines(text: string): HarvestedTrace[] {
  const out: HarvestedTrace[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && Array.isArray(obj.tokens) && typeof obj.chosen === "string") {
        out.push(obj as HarvestedTrace);
      }
    } catch {
      // Skip an unparseable line rather than fail the export.
    }
  }
  return out;
}

// Dedup key for an entry: tokens are [a-z0-9] runs and a namespace has no
// spaces or colons, so "<space-joined tokens>::<chosen>" is unambiguous.
function entryKey(tokens: string[], chosen: string): string {
  return `${tokens.join(" ")}::${chosen}`;
}

// Stratified cap: keep up to `cap` entries, sampling round-robin across the
// distinct `chosen` namespaces (highest-weight first within each) so rare
// servers are not evicted wholesale when one namespace dominates. Deterministic
// (no randomness) so the fixture is reproducible.
function capStratified(entries: FoundryCorpusEntry[], cap: number): FoundryCorpusEntry[] {
  if (entries.length <= cap) return entries;
  const byChosen = new Map<string, FoundryCorpusEntry[]>();
  for (const e of entries) {
    const g = byChosen.get(e.chosen);
    if (g) g.push(e);
    else byChosen.set(e.chosen, [e]);
  }
  // Highest-weight first within each group; stable group order by name.
  const groups = [...byChosen.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([, g]) => g.sort((x, y) => y.weight - x.weight));
  const out: FoundryCorpusEntry[] = [];
  let i = 0;
  while (out.length < cap) {
    let took = false;
    for (const g of groups) {
      if (i < g.length) {
        out.push(g[i]);
        took = true;
        if (out.length >= cap) break;
      }
    }
    if (!took) break; // all groups exhausted
    i++;
  }
  return out;
}

/** Why buildCorpusFromTraces drops a trace, or null when it folds in. The
 *  export's zero-entries message counts these so it can name both causes
 *  instead of blaming the catalog for a harvest of empty token bags, and the
 *  fold below consults the same function so the two can never disagree. A
 *  trace failing both tests reports the unknown `chosen`: a catalog mismatch
 *  is the one the maintainer can act on. "empty-tokens" covers a bag with no
 *  string in it at all, which the fold would otherwise sort down to nothing. */
export function traceDropReason(
  t: HarvestedTrace,
  known: ReadonlySet<string>,
): "unknown-chosen" | "empty-tokens" | null {
  if (!t || typeof t.chosen !== "string" || !known.has(t.chosen)) return "unknown-chosen";
  if (!Array.isArray(t.tokens) || !t.tokens.some((x) => typeof x === "string")) return "empty-tokens";
  return null;
}

// Fold harvested traces into a corpus: drop traces whose `chosen` is not in the
// snapshot server set (unscorable) or that carry no tokens (traceDropReason),
// dedup by (sorted-tokens, chosen) accumulating weight, then stratify-cap.
// Pure.
export function buildCorpusFromTraces(
  traces: HarvestedTrace[],
  servers: RankableServer[],
  opts: { cap?: number } = {},
): FoundryCorpus {
  const known = new Set(servers.map((s) => s.namespace));
  const byKey = new Map<string, FoundryCorpusEntry>();
  for (const t of traces) {
    if (traceDropReason(t, known) !== null) continue;
    const tokens = [...t.tokens].filter((x) => typeof x === "string").sort();
    const key = entryKey(tokens, t.chosen);
    const prev = byKey.get(key);
    if (prev) prev.weight += 1;
    else byKey.set(key, { tokens, chosen: t.chosen, weight: 1 });
  }
  const entries = capStratified([...byKey.values()], opts.cap ?? DEFAULT_CORPUS_CAP);
  return { version: FOUNDRY_CORPUS_VERSION, servers, entries };
}

export interface CorpusScore {
  totalWeight: number;
  top1Weight: number;
  top3Weight: number;
  top1: number;
  top3: number;
}

// Weighted top-1 / top-3 accuracy of the BM25 floor over the corpus: for each
// entry, re-rank the snapshot servers against the entry's tokens and check
// whether `chosen` lands at #1 / within the top 3. Weights count repeated
// intents once per occurrence. Pure (uses rankServers, no I/O).
export function scoreCorpus(corpus: FoundryCorpus): CorpusScore {
  let totalWeight = 0;
  let top1Weight = 0;
  let top3Weight = 0;
  for (const e of corpus.entries) {
    totalWeight += e.weight;
    const top3 = rankServers(e.tokens.join(" "), corpus.servers)
      .slice(0, 3)
      .map((r) => r.namespace);
    if (top3[0] === e.chosen) top1Weight += e.weight;
    if (top3.includes(e.chosen)) top3Weight += e.weight;
  }
  return {
    totalWeight,
    top1Weight,
    top3Weight,
    top1: totalWeight > 0 ? top1Weight / totalWeight : 0,
    top3: totalWeight > 0 ? top3Weight / totalWeight : 0,
  };
}

// A server the BM25 floor can consume without crashing: buildDocFields
// (relevance.ts) iterates `tools` unguarded and tokenizes namespace / name /
// description plus each tool's name / description, so each must carry the
// declared type or be absent. Element-level, because a truncated or
// hand-edited fixture is exactly what the gate's hard-fail state exists to
// name -- an Array.isArray check alone let such a fixture pass validation and
// then crash scoreCorpus with an opaque TypeError instead.
function isRankableServerShape(s: unknown): s is RankableServer {
  if (!s || typeof s !== "object") return false;
  const x = s as Partial<RankableServer>;
  if (typeof x.namespace !== "string" || typeof x.name !== "string") return false;
  if (x.description !== undefined && typeof x.description !== "string") return false;
  if (!Array.isArray(x.tools)) return false;
  for (const t of x.tools) {
    if (!t || typeof t !== "object") return false;
    const tool = t as Partial<RankableTool>;
    if (typeof tool.name !== "string") return false;
    if (tool.description !== undefined && typeof tool.description !== "string") return false;
  }
  return true;
}

// An entry scoreCorpus can score: a non-empty all-string token bag, a chosen
// namespace, and a finite positive weight (buildCorpusFromTraces never writes
// anything else; a 0/negative/NaN weight would silently corrupt the weighted
// accuracy rather than crash, which is worse).
function isCorpusEntryShape(e: unknown): e is FoundryCorpusEntry {
  if (!e || typeof e !== "object") return false;
  const x = e as Partial<FoundryCorpusEntry>;
  return (
    Array.isArray(x.tokens) &&
    x.tokens.length > 0 &&
    x.tokens.every((t) => typeof t === "string") &&
    typeof x.chosen === "string" &&
    typeof x.weight === "number" &&
    Number.isFinite(x.weight) &&
    x.weight > 0
  );
}

// Validate a parsed object as a FoundryCorpus. Returns the typed corpus or null
// (used by the gate to skip cleanly on a missing/garbage/empty fixture).
export function validateCorpus(obj: unknown): FoundryCorpus | null {
  if (!obj || typeof obj !== "object") return null;
  const c = obj as Partial<FoundryCorpus>;
  if (c.version !== FOUNDRY_CORPUS_VERSION) return null;
  if (!Array.isArray(c.servers) || !Array.isArray(c.entries)) return null;
  if (c.entries.length === 0) return null;
  if (!c.servers.every(isRankableServerShape)) return null;
  if (!c.entries.every(isCorpusEntryShape)) return null;
  // Cross-check `chosen` against the snapshot catalog. buildCorpusFromTraces
  // already drops an unknown `chosen` at export time, so one here means the
  // fixture was hand-edited or the servers array was trimmed. Left unchecked
  // it is INVISIBLE: rankServers can never return a namespace it was not
  // given, so the entry scores as a silent top-3 miss and drags the gate
  // toward FOUNDRY_TOP3_FLOOR as if the ranker had regressed.
  const known = new Set(c.servers.map((s) => s.namespace));
  if (!c.entries.every((e) => known.has(e.chosen))) return null;
  return c as FoundryCorpus;
}

// Load + validate a corpus fixture from disk. Returns null when the file is
// absent, unreadable, malformed, or empty -- the gate treats null as "no
// corpus committed yet, skip".
export function loadFoundryCorpus(path: string): FoundryCorpus | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return validateCorpus(JSON.parse(text));
  } catch {
    return null;
  }
}
