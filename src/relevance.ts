// BM25 ranking for dispatch + context-aware discover.
//
// The old scoreRelevance was substring-only: a query for "file a PR" would
// never match a GitHub server whose description didn't literally contain
// the word "PR". BM25 fixes that by treating every configured server as a
// document, computing proper IDF across the corpus, and summing per-term
// scores over weighted fields. The corpus is tiny (<100s of servers per
// account), so the O(N*M) prep cost is negligible.
//
// We deliberately skip stemming / synonyms / embeddings here — BM25 with
// good field weights captures the 80% case, and Stage 2 (Voyage rerank on
// the server side) will handle semantic matches when it lands.

export interface RankableTool {
  name: string;
  description?: string;
}

export interface RankableServer {
  namespace: string;
  name: string;
  description?: string;
  tools: RankableTool[];
}

export interface RankedResult {
  namespace: string;
  score: number;
}

// Default BM25 constants. k1 controls term-frequency saturation; b controls
// length normalization. 1.2 / 0.75 are the canonical defaults — tuning them
// for our corpus would be premature given we have no usage data yet.
const K1 = 1.2;
const B = 0.75;

// Field weights — tuned by intuition, not data. Name is the strongest
// signal (users often include the server name in the query), tool names
// are next, then descriptions. Adjust if real-world ranking quality
// disappoints.
const FIELD_WEIGHTS = {
  name: 3.0,
  namespace: 2.0,
  description: 1.5,
  toolName: 2.0,
  toolDescription: 1.0,
} as const;

// Drop tokens shorter than 3 chars — kills most noise words (a, an, of,
// the, to, is) without needing a stopword list. Matches the old relevance
// behavior so we don't change recall silently.
const MIN_TOKEN_LEN = 3;

function tokenize(text: string | undefined): string[] {
  if (!text) return [];
  // Split on any non-alphanumeric run so snake_case, kebab-case, and
  // mixed punctuation all produce the same tokens. This is what lets
  // "create issue" match a tool named `create_issue` — critical because
  // MCP tool names are overwhelmingly snake_case.
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= MIN_TOKEN_LEN);
}

interface DocFields {
  namespace: string[];
  name: string[];
  description: string[];
  toolName: string[];
  toolDescription: string[];
}

function buildDocFields(server: RankableServer): DocFields {
  const toolNameTokens: string[] = [];
  const toolDescriptionTokens: string[] = [];
  for (const tool of server.tools) {
    toolNameTokens.push(...tokenize(tool.name));
    toolDescriptionTokens.push(...tokenize(tool.description));
  }
  return {
    namespace: tokenize(server.namespace),
    name: tokenize(server.name),
    description: tokenize(server.description),
    toolName: toolNameTokens,
    toolDescription: toolDescriptionTokens,
  };
}

function termFreq(tokens: string[], term: string): number {
  let count = 0;
  for (const t of tokens) {
    if (t === term) count++;
  }
  return count;
}

// Weighted BM25 across multiple fields — treats each field as its own
// "document" with its own length, then sums contributions weighted by the
// field's importance. This is the "BM25F" variant (Robertson et al. 2004),
// simplified: we use the same k1/b for every field rather than per-field
// tuning, which would be overfitting at this corpus size.
function bm25Score(
  queryTerms: string[],
  fields: DocFields,
  idf: Map<string, string>,
  avgFieldLen: Record<keyof DocFields, number>,
  idfValues: Map<string, number>,
): number {
  let score = 0;
  const seen = new Set<string>(); // dedupe query terms — "github github" shouldn't double-count

  for (const term of queryTerms) {
    if (seen.has(term)) continue;
    seen.add(term);

    const termIdf = idfValues.get(term);
    if (termIdf === undefined || termIdf <= 0) continue; // term missing or appears in every doc

    for (const [fieldName, weight] of Object.entries(FIELD_WEIGHTS) as Array<[keyof DocFields, number]>) {
      const fieldTokens = fields[fieldName];
      if (fieldTokens.length === 0) continue;
      const tf = termFreq(fieldTokens, term);
      if (tf === 0) continue;
      const avg = avgFieldLen[fieldName] || 1;
      const normLen = 1 - B + B * (fieldTokens.length / avg);
      const numerator = tf * (K1 + 1);
      const denominator = tf + K1 * normLen;
      score += weight * termIdf * (numerator / denominator);
    }
  }

  // Use the idf map only to let tests assert corpus properties — unused in
  // scoring itself, suppress the unused-parameter lint.
  void idf;
  return score;
}

// Rank a list of servers against a free-text query. Returns results sorted
// descending by score, only including entries with score > 0 (matches at
// least one query term in some field). Zero-score servers are omitted so
// the caller can cleanly tell "no match" from "weak match".
export function rankServers(context: string, servers: RankableServer[]): RankedResult[] {
  const queryTerms = tokenize(context);
  if (queryTerms.length === 0 || servers.length === 0) return [];

  const docsWithFields = servers.map((s) => ({ server: s, fields: buildDocFields(s) }));
  const N = docsWithFields.length;

  // Document frequency — how many servers contain the term in ANY field.
  // Treating all fields as a single bag for DF is a deliberate simplification;
  // "contains the term somewhere" is what matters for IDF, not where.
  const df = new Map<string, number>();
  for (const { fields } of docsWithFields) {
    const bag = new Set<string>([
      ...fields.namespace,
      ...fields.name,
      ...fields.description,
      ...fields.toolName,
      ...fields.toolDescription,
    ]);
    for (const term of bag) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  // Per-term IDF using the standard BM25 formula with +1 so that terms
  // appearing in every document still get a tiny positive weight rather
  // than contributing a negative score.
  const idfValues = new Map<string, number>();
  for (const [term, d] of df) {
    idfValues.set(term, Math.log((N - d + 0.5) / (d + 0.5) + 1));
  }

  // Average length per field across the corpus — used by length
  // normalization so longer fields don't inherently outscore shorter ones
  // just by having more chances to match.
  const totalLen: Record<keyof DocFields, number> = {
    namespace: 0,
    name: 0,
    description: 0,
    toolName: 0,
    toolDescription: 0,
  };
  for (const { fields } of docsWithFields) {
    totalLen.namespace += fields.namespace.length;
    totalLen.name += fields.name.length;
    totalLen.description += fields.description.length;
    totalLen.toolName += fields.toolName.length;
    totalLen.toolDescription += fields.toolDescription.length;
  }
  const avgFieldLen: Record<keyof DocFields, number> = {
    namespace: totalLen.namespace / N,
    name: totalLen.name / N,
    description: totalLen.description / N,
    toolName: totalLen.toolName / N,
    toolDescription: totalLen.toolDescription / N,
  };

  const results: RankedResult[] = [];
  for (const { server, fields } of docsWithFields) {
    const score = bm25Score(queryTerms, fields, new Map(), avgFieldLen, idfValues);
    if (score > 0) {
      results.push({ namespace: server.namespace, score });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable tie-break by namespace so test assertions don't flake
    return a.namespace < b.namespace ? -1 : 1;
  });

  return results;
}

// Single-server convenience — kept for legacy callers that score one
// candidate at a time. Internally wraps the BM25 ranker with a trivial
// one-document corpus, so scores aren't comparable across different calls
// but a return of 0 still means "no term matched". Prefer rankServers
// wherever you're ranking a list.
export function scoreRelevance(
  context: string,
  server: { name: string; namespace: string; description?: string },
  tools: RankableTool[],
): number {
  const ranked = rankServers(context, [
    {
      namespace: server.namespace,
      name: server.name,
      description: server.description,
      tools,
    },
  ]);
  return ranked[0]?.score ?? 0;
}
