import { beforeEach, describe, expect, it } from "vitest";
import { rankServers, relevanceCacheKeyBytes, relevanceCacheStats, resetRelevanceCache } from "../relevance.js";

// Single-server score. A `scoreRelevance` export used to do exactly this,
// documented as being "kept for legacy callers" that never existed outside
// these tests; ranking a one-element array is the same computation, so the
// wrapper lives here now instead of in the production module.
function score1(
  context: string,
  server: { name: string; namespace: string; description?: string },
  tools: Array<{ name: string; description?: string }> = [],
): number {
  return rankServers(context, [{ ...server, tools }])[0]?.score ?? 0;
}

describe("single-server scoring", () => {
  const server = { name: "GitHub", namespace: "gh", description: "Repos, issues, pull requests" };

  it("returns 0 for empty context", () => {
    expect(score1("", server)).toBe(0);
  });

  it("returns 0 for short query words that match nothing in the corpus", () => {
    expect(score1("go do it", server)).toBe(0);
  });

  it("scores server name matches", () => {
    const score = score1("use github", server);
    expect(score).toBeGreaterThan(0);
  });

  it("scores namespace matches on multi-char namespaces", () => {
    const slackServer = { name: "Slack", namespace: "slack", description: "Team chat" };
    const score = score1("check slack messages", slackServer);
    expect(score).toBeGreaterThan(0);
  });

  it("scores namespace matches on short namespaces too", () => {
    // The 3-char prose floor used to delete `gh` from the index entirely, so
    // the namespace field -- the second-heaviest weight -- was permanently
    // empty for this server and naming it in the intent contributed nothing.
    const nameless = { name: "Untitled", namespace: "gh", description: "Repos" };
    expect(score1("gh", nameless)).toBeGreaterThan(0);
  });

  it("matches snake_case tool names from space-separated query", () => {
    const tools = [{ name: "create_issue", description: "Create a new issue" }];
    const score = score1("create issue on github", server, tools);
    expect(score).toBeGreaterThan(0);
  });

  it("scores tool description matches", () => {
    const tools = [{ name: "run_query", description: "Execute a database query" }];
    const score = score1("database query needed", { name: "DB", namespace: "db", description: "SQL access" }, tools);
    expect(score).toBeGreaterThan(0);
  });

  it("deduplicates query terms so repeats don't inflate score", () => {
    const singleScore = score1("github tools", server);
    const repeatedScore = score1("github github github tools", server);
    expect(repeatedScore).toBe(singleScore);
  });

  it("is case-insensitive", () => {
    const lower = score1("github", server);
    const upper = score1("GITHUB", server);
    expect(lower).toBe(upper);
  });

  it("returns 0 when no words match", () => {
    const score = score1("completely unrelated query", server);
    expect(score).toBe(0);
  });

  it("strips punctuation from query tokens", () => {
    const score = score1("use (github)!", server);
    expect(score).toBeGreaterThan(0);
  });
});

// The prose token floor (3 chars) is right for descriptions and wrong for
// identifiers: a server may legitimately be called `pg`, `gh`, or `db`
// (NAMESPACE_RE in local-bundles.ts allows one character), and tool names
// routinely embed `s3` / `ec2`. Applying the prose floor to those fields
// dropped them from the index without a trace.
describe("short identifiers below the prose token floor", () => {
  const corpus = [
    {
      namespace: "pg",
      name: "Postgres",
      description: "SQL access",
      tools: [
        { name: "run_query", description: "Execute a statement" },
        // Deliberately carries a closed-class word as a whole identifier
        // segment: tokenizeIdent splits this into export / to / csv, so `to`
        // is a real corpus term with a real IDF entry. Without this, the
        // stopword guard below passes for the wrong reason -- the term simply
        // wasn't in the corpus.
        { name: "export_to_csv", description: "Write rows out" },
      ],
    },
    {
      namespace: "slack",
      name: "Slack",
      description: "Team chat",
      tools: [{ name: "send_message", description: "Post a message" }],
    },
  ];

  it("ranks a 2-char namespace named in the intent", () => {
    // Previously "pg" was dropped from the query AND from the index, so this
    // returned nothing and dispatch answered "No installed server matches".
    expect(rankServers("use pg", corpus).map((r) => r.namespace)).toEqual(["pg"]);
  });

  it("lets a short namespace contribute alongside prose terms", () => {
    expect(rankServers("get the pg schema", corpus).map((r) => r.namespace)).toContain("pg");
  });

  it("keeps short fragments inside tool names searchable", () => {
    const withAws = [
      {
        namespace: "aws",
        name: "AWS",
        description: "Amazon Web Services",
        tools: [{ name: "s3_list_buckets", description: "List buckets" }],
      },
      ...corpus,
    ];
    expect(rankServers("list s3 buckets", withAws)[0]?.namespace).toBe("aws");
  });

  it("still ignores short closed-class words the corpus DOES contain", () => {
    // This used to pass for the wrong reason -- "no IDF entry, so skipped
    // outright" only holds while the corpus happens to lack the term. `pg`
    // now owns `export_to_csv`, so `to` has a real IDF entry (and a high one,
    // being rare), and the only thing keeping this at [] is the query-side
    // stopword filter.
    expect(rankServers("of a to", corpus)).toEqual([]);
  });

  it("keeps short NON-stopword segments of a tool name matchable", () => {
    // The filter has to be stopword-specific, not another length floor:
    // `csv` sits in the same tool name as the stripped `to` and must still
    // rank pg.
    expect(rankServers("csv", corpus).map((r) => r.namespace)).toEqual(["pg"]);
  });
});

// A closed-class function word ("to", "in", "of", "up", "on", "by") is not a
// content term, but it IS a routine whole segment of a snake_case tool name,
// so the widened query floor made every one of them a scoring term against a
// field weighted 2.0 -- and because such a word is rare in a corpus of
// identifiers, its IDF is HIGH. That combination invented matches out of
// nothing: dispatch has no score floor and discover's auto-warm gate is 1.0,
// so a query with no relevant server spawned one anyway.
describe("closed-class stopwords in the query", () => {
  const corpus = [
    {
      namespace: "gh",
      name: "GitHub",
      description: "Repos, issues, and pull requests",
      tools: [{ name: "create_issue", description: "Create a new issue in a repo" }],
    },
    {
      namespace: "pg",
      name: "Postgres",
      description: "SQL queries against a Postgres database",
      tools: [
        { name: "run_query", description: "Execute a SQL query" },
        { name: "export_to_csv", description: "Write query rows out as CSV" },
      ],
    },
    {
      namespace: "slack",
      name: "Slack",
      description: "Team chat and direct messages",
      tools: [{ name: "send_message", description: "Post a message to a channel" }],
    },
  ];

  it("returns no match for a query whose only corpus hit is a stopword", () => {
    // The reported regression, verbatim: this scored pg ~1.7 purely from `to`
    // matching the `to` segment of export_to_csv, which cleared both the
    // dispatch path (no floor) and the auto-warm gate (min 1.0, no runner-up).
    // Nothing here is about Postgres.
    expect(rankServers("convert the spreadsheet to a chart", corpus)).toEqual([]);
  });

  it("gives every short closed-class word zero score against an identifier segment", () => {
    const withPrepositionTools = [
      {
        namespace: "misc",
        name: "Misc",
        description: "Assorted helpers",
        tools: [
          { name: "export_to_csv", description: "Write rows" },
          { name: "search_in_files", description: "Grep" },
          { name: "list_of_users", description: "Roster" },
          { name: "scale_up_nodes", description: "Resize" },
          { name: "turn_on_alerts", description: "Enable" },
          { name: "order_by_date", description: "Sort" },
          { name: "run_as_admin", description: "Elevate" },
          { name: "look_at_logs", description: "Tail" },
          { name: "list_my_issues", description: "Mine" },
          { name: "notify_me_on_reply", description: "Ping" },
        ],
      },
      ...corpus,
    ];
    // Every non-fragment entry of SUB_FLOOR_STOPWORDS, not a sample of them:
    // a word left out of this list is a word whose stripping nothing pins.
    const words = "a an as at by in of on to up if or so i he it me my us we am be is no".split(" ");
    for (const word of words) {
      expect(rankServers(word, withPrepositionTools), `"${word}" must not score`).toEqual([]);
    }
  });

  it("strips the fragments an apostrophe leaves behind", () => {
    // splitTokens breaks on the apostrophe, so a contraction never reaches the
    // ranker whole: don't -> don/t, it's -> it/s, we're -> we/re, I've -> i/ve,
    // I'll -> i/ll, I'm -> i/m, I'd -> i/d. Those fragments clear the 1-char
    // identifier floor, and in a corpus of identifiers a stray `s` or `re` is
    // RARE, so its IDF is HIGH -- the exact shape of the `to` regression above.
    const withFragmentTools = [
      {
        namespace: "misc",
        name: "Misc",
        description: "Assorted helpers",
        tools: [
          // One- and two-letter segments are ordinary in upstream tool names
          // (seconds, date parts, lat/long, regex, trim, targets). The
          // fragments have to be IN the corpus or this passes for the wrong
          // reason: a term with no IDF entry is skipped before the stopword
          // filter is ever consulted.
          { name: "timeout_s_seconds", description: "Deadline" },
          { name: "format_d_m_y", description: "Date parts" },
          { name: "set_ll_position", description: "Latitude and longitude" },
          { name: "search_re_pattern", description: "Regex" },
          { name: "trim_t_prefix", description: "Trim" },
          { name: "list_ve_targets", description: "Targets" },
        ],
      },
      ...corpus,
    ];
    for (const fragment of ["d", "ll", "m", "re", "s", "t", "ve"]) {
      expect(rankServers(fragment, withFragmentTools), `"${fragment}" must not score`).toEqual([]);
    }
    // End to end: the contractions those fragments come from are inert too.
    // Every token here is a fragment or a stopword except the `don` of `don't`,
    // which is absent from the corpus and so cannot score either.
    for (const contraction of ["don't", "it's", "we're", "I've", "I'll", "I'm", "I'd"]) {
      expect(rankServers(contraction, withFragmentTools), `"${contraction}" must not score`).toEqual([]);
    }
  });

  it("does not strip short words that are plausible identifiers", () => {
    // `go` (Go toolchain) and `do` (DigitalOcean) are short and function-word
    // adjacent but are real namespaces, so the filter must leave them alone --
    // that is the whole reason the query floor was widened.
    const shortNamespaces = [
      { namespace: "go", name: "Go", description: "Toolchain", tools: [] },
      { namespace: "do", name: "DigitalOcean", description: "Droplets", tools: [] },
      ...corpus,
    ];
    expect(rankServers("go", shortNamespaces).map((r) => r.namespace)).toEqual(["go"]);
    expect(rankServers("do", shortNamespaces).map((r) => r.namespace)).toEqual(["do"]);
  });

  it("still ranks a short namespace named alongside a stopword", () => {
    // The stopword goes, the identifier stays: stripping must not take the
    // short-identifier recall the widened floor exists to provide.
    expect(rankServers("export to csv in pg", corpus)[0]?.namespace).toBe("pg");
    expect(rankServers("talk to slack", corpus).map((r) => r.namespace)).toEqual(["slack"]);
  });

  it("leaves a query of nothing but stopwords with no terms at all", () => {
    // Every token here is stripped, so the query reduces to zero terms and
    // takes the same path as an empty context.
    expect(rankServers("is it up to me or to us", corpus)).toEqual([]);
  });
});

describe("rankServers (corpus-wide BM25)", () => {
  const gh = {
    namespace: "gh",
    name: "GitHub",
    description: "Repos, issues, and pull requests",
    tools: [
      { name: "create_issue", description: "Create a new issue in a repo" },
      { name: "list_pull_requests", description: "List open pull requests" },
    ],
  };
  const slack = {
    namespace: "slack",
    name: "Slack",
    description: "Team chat and direct messages",
    tools: [{ name: "send_message", description: "Post a message to a channel" }],
  };
  const postgres = {
    namespace: "pg",
    name: "Postgres",
    description: "SQL queries against a Postgres database",
    tools: [{ name: "run_query", description: "Execute a SQL query" }],
  };
  const corpus = [gh, slack, postgres];

  it("returns empty array for empty query", () => {
    expect(rankServers("", corpus)).toEqual([]);
  });

  it("returns empty array for empty corpus", () => {
    expect(rankServers("github issues", [])).toEqual([]);
  });

  it("ranks the obvious winner first", () => {
    const ranked = rankServers("create a github issue", corpus);
    expect(ranked[0]?.namespace).toBe("gh");
  });

  it("ranks slack first for messaging queries", () => {
    const ranked = rankServers("send a message to the team", corpus);
    expect(ranked[0]?.namespace).toBe("slack");
  });

  it("ranks postgres first for database queries", () => {
    const ranked = rankServers("run a sql query against the database", corpus);
    expect(ranked[0]?.namespace).toBe("pg");
  });

  it("omits servers with zero score", () => {
    const ranked = rankServers("pull request review", corpus);
    // gh should match; slack and postgres shouldn't have any matching terms
    expect(ranked.map((r) => r.namespace)).toEqual(["gh"]);
  });

  it("boosts servers whose name exactly matches the query", () => {
    const ranked = rankServers("slack", corpus);
    expect(ranked[0]?.namespace).toBe("slack");
    // IDF is high because "slack" appears in only one server
    expect(ranked[0]?.score).toBeGreaterThan(0);
  });

  it("returns a stable order when scores tie", () => {
    // Query that matches no server should give empty result (not flaky)
    const a = rankServers("", corpus);
    const b = rankServers("", corpus);
    expect(a).toEqual(b);

    // ...and a corpus that GENUINELY ties, which is what the namespace
    // tie-break in scoreAgainstIndex exists for. Both servers carry the same
    // name field, the same field lengths and the same document frequency, so
    // the scores are equal by construction; only the tie-break decides the
    // order, and it must not be the order the caller happened to pass them in
    // (config / install order, which changes on a reinstall).
    const tied = rankServers("widget", [
      { namespace: "zzz", name: "Widget", description: "", tools: [] },
      { namespace: "aaa", name: "Widget", description: "", tools: [] },
    ]);
    expect(tied.map((r) => r.namespace)).toEqual(["aaa", "zzz"]);
    expect(tied[0].score).toBe(tied[1].score);
  });

  it("does not rank a server that lacks both description and tools when query misses name", () => {
    const mystery = { namespace: "mystery", name: "Thing", description: undefined, tools: [] };
    const ranked = rankServers("database query", [...corpus, mystery]);
    expect(ranked.find((r) => r.namespace === "mystery")).toBeUndefined();
  });

  it("scores common terms lower than rare terms (IDF signal)", () => {
    // Every server in this mini-corpus mentions "server" in description
    const big = [
      { namespace: "a", name: "A", description: "server server server", tools: [] },
      { namespace: "b", name: "B", description: "server server server", tools: [] },
      { namespace: "c", name: "C", description: "unique rarely-used thing server", tools: [] },
    ];
    const commonQuery = rankServers("server", big);
    const rareQuery = rankServers("unique", big);
    // "unique" appears in 1/3 servers → higher IDF → higher top score
    expect(rareQuery[0]?.score).toBeGreaterThan(commonQuery[0]?.score ?? 0);
  });

  // The two tests below started life as regression guards for the removal of
  // a dead `idf` parameter from bm25Score. That parameter is long gone and
  // there is nothing left to regress on, so they are named for what they
  // actually assert.
  it("returns a finite positive score for every server it ranks", () => {
    const servers = [
      {
        namespace: "gh",
        name: "GitHub",
        description: "Repos and issues",
        tools: [{ name: "create_issue", description: "Create an issue" }],
      },
      {
        namespace: "slack",
        name: "Slack",
        description: "Team messaging",
        tools: [{ name: "send_message", description: "Post a message" }],
      },
    ];
    const ranked = rankServers("create github issue", servers);
    // gh should rank first — create/issue both match gh fields.
    expect(ranked[0]?.namespace).toBe("gh");
    // Every ranked score must be a finite positive number: rankServers drops
    // zero-scored servers, so a NaN or Infinity here is arithmetic gone wrong,
    // not a legitimate "no match".
    expect(ranked.length).toBeGreaterThan(0);
    for (const r of ranked) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("a term unique to one server ranks only its owner", () => {
    // Unlike "omits servers with zero score" above, this pins the single-match
    // shape on a two-server corpus: the owner is the ONLY entry, and its score
    // is positive rather than merely first.
    const servers = [
      { namespace: "only", name: "OnlyMatch", description: "xyzplonk unique term", tools: [] },
      { namespace: "other", name: "Other", description: "completely different", tools: [] },
    ];
    const ranked = rankServers("xyzplonk", servers);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].namespace).toBe("only");
    expect(ranked[0].score).toBeGreaterThan(0);
  });
});

// The BM25 index (per-field token counts, document frequency, IDF, average
// field lengths) is a pure function of the corpus, but it used to be rebuilt
// on every call. Profiling put that rebuild at ~90% of the cost of a single
// rankServers() call, and it is paid on every discover and every dispatch.
//
// These tests assert the caching behaviour via build counters rather than
// wall-clock timings, so they fail deterministically on a regression instead
// of flaking on a loaded CI box.
describe("ranking index cache", () => {
  beforeEach(() => {
    resetRelevanceCache();
  });

  const corpus = () => [
    {
      namespace: "gh",
      name: "GitHub",
      description: "Repos, issues, pull requests",
      tools: [
        { name: "create_issue", description: "Open a new issue" },
        { name: "list_pull_requests", description: "List open pull requests" },
      ],
    },
    {
      namespace: "slack",
      name: "Slack",
      description: "Team messaging",
      tools: [{ name: "send_message", description: "Post a message to a channel" }],
    },
  ];

  it("builds the index once across repeated ranking of the same corpus", () => {
    for (let i = 0; i < 25; i++) {
      rankServers("create an issue", corpus());
    }
    // One build total -- not one per call -- even though every call passes a
    // freshly constructed array (which is what ConnectServer.rankableFor does).
    expect(relevanceCacheStats().indexBuilds).toBe(1);
    expect(relevanceCacheStats().docBuilds).toBe(2);
  });

  it("returns identical rankings on cached and uncached calls", () => {
    const first = rankServers("create an issue", corpus());
    const second = rankServers("create an issue", corpus());
    expect(second).toEqual(first);
    expect(relevanceCacheStats().indexBuilds).toBe(1);
  });

  it("varies scoring by query while reusing one index", () => {
    const issues = rankServers("create an issue", corpus());
    const chat = rankServers("post a message to the channel", corpus());
    expect(issues[0]?.namespace).toBe("gh");
    expect(chat[0]?.namespace).toBe("slack");
    expect(relevanceCacheStats().indexBuilds).toBe(1);
  });

  it("rebuilds when a server description changes", () => {
    rankServers("kubernetes deploys", corpus());
    const edited = corpus();
    edited[1].description = "Team messaging and kubernetes deploy alerts";
    const after = rankServers("kubernetes deploys", edited);
    // The edit must be visible -- a stale index would still score slack at 0.
    expect(after.map((r) => r.namespace)).toContain("slack");
    expect(relevanceCacheStats().indexBuilds).toBe(2);
  });

  it("rebuilds when a tool is added", () => {
    rankServers("upload attachment", corpus());
    const edited = corpus();
    edited[1].tools.push({ name: "upload_attachment", description: "Upload a file" });
    const after = rankServers("upload attachment", edited);
    expect(after.map((r) => r.namespace)).toContain("slack");
    expect(relevanceCacheStats().indexBuilds).toBe(2);
  });

  it("reuses per-server fields for the servers that did not change", () => {
    rankServers("create an issue", corpus());
    expect(relevanceCacheStats().docBuilds).toBe(2);
    const edited = corpus();
    edited[1].description = "Team messaging, now with threads";
    rankServers("create an issue", edited);
    // Only the edited server is re-tokenized; gh's fields come from the cache.
    expect(relevanceCacheStats().docBuilds).toBe(3);
  });

  it("does not collide corpora that differ only in where a field boundary falls", () => {
    // Guards the signature separator: joining fields with a printable
    // character would sign these two corpora identically, silently serving
    // one the other's index. Namespace and name carry different BM25 weights,
    // so a collision would also produce a wrong score.
    const a = [{ namespace: "alpha beta", name: "gamma", description: "", tools: [] }];
    const b = [{ namespace: "alpha", name: "beta gamma", description: "", tools: [] }];
    const rankedA = rankServers("beta", a);
    const rankedB = rankServers("beta", b);
    expect(relevanceCacheStats().indexBuilds).toBe(2);
    // beta sits in `namespace` (weight 2.0) for a, and in `name` (weight 3.0)
    // for b, so the scores must differ.
    expect(rankedA[0]?.score).not.toBe(rankedB[0]?.score);
  });

  it("bounds the index cache instead of growing without limit", () => {
    for (let i = 0; i < 40; i++) {
      rankServers("create an issue", [
        { namespace: `ns${i}`, name: `Server ${i}`, description: "unique corpus", tools: [] },
      ]);
    }
    // Every corpus is distinct, so every call builds -- the point is that the
    // cache evicts rather than retaining all 40.
    expect(relevanceCacheStats().indexBuilds).toBe(40);
    // Re-ranking the FIRST corpus must miss (it was evicted), proving the cap.
    rankServers("create an issue", [{ namespace: "ns0", name: "Server 0", description: "unique corpus", tools: [] }]);
    expect(relevanceCacheStats().indexBuilds).toBe(41);
  });

  it("evicts least-recently-used, so a churning server cannot flush its stable neighbours", () => {
    // FIFO eviction would let one server whose content changes every call
    // push out the neighbours that never change -- exactly the reuse the doc
    // cache exists to provide, since a stable entry is inserted once and then
    // stays permanently "oldest". Measured before the fix on a 100-server
    // corpus: 798 doc builds over 600 calls against an ideal of 699.
    const STABLE = 20;
    const CALLS = 600; // STABLE + CALLS must exceed MAX_CACHED_DOCS (512)
    const withChurn = (v: number) => [
      ...Array.from({ length: STABLE }, (_, i) => ({
        namespace: `stable${i}`,
        name: `Stable ${i}`,
        description: `unchanging server ${i}`,
        tools: [{ name: `tool_${i}`, description: `does thing ${i}` }],
      })),
      { namespace: "churn", name: "Churn", description: `version ${v}`, tools: [] },
    ];
    for (let v = 0; v < CALLS; v++) rankServers("thing", withChurn(v));
    // One build per stable server plus the churner, then one per new version:
    // the stable 20 are re-tokenized zero times.
    expect(relevanceCacheStats().docBuilds).toBe(STABLE + 1 + (CALLS - 1));
  });

  it("cannot be made to collide by control characters inside a field", () => {
    // Tool names and descriptions come from third-party upstream servers over
    // JSON-RPC, where NUL and SOH are legal string content -- so any
    // "this character cannot occur" assumption in a delimiter scheme is
    // supplied by the untrusted side. serverSignature removes the assumption by
    // escaping both bytes out of every field (ESC -> ESC ESC, SEP -> ESC SEP),
    // so a bare separator in the signature is always a field boundary.
    const embedded = [{ namespace: "ns", name: "Name", description: "alpha\u0000beta\u0000", tools: [] }];
    const split = [{ namespace: "ns", name: "Name", description: "alpha", tools: [{ name: "beta", description: "" }] }];
    const a = rankServers("beta", embedded);
    const b = rankServers("beta", split);
    expect(relevanceCacheStats().indexBuilds).toBe(2);
    // "beta" lands in `description` (weight 1.5) for one and `toolName`
    // (weight 2.0) for the other, so a collision would also misscore.
    expect(a[0]?.score).not.toBe(b[0]?.score);
  });

  it("cannot be made to collide across the server boundary of the index key", () => {
    const two = [
      { namespace: "alpha", name: "Alpha", description: "widget", tools: [] },
      { namespace: "bravo", name: "Bravo", description: "widget", tools: [] },
    ];
    // This single server carries the two-server corpus's signature text,
    // separators included, inside one description: under an index key that
    // joined the RAW signatures it signs identically to the pair above and gets
    // served their 2-doc index -- wrong N, wrong IDF, and a ranked namespace the
    // caller never passed in. It cannot collide under the current key (a digest
    // of the per-server digests, every element the same fixed width), so this is
    // a canary against a regression back to a raw-signature join rather than a
    // reproduction of a live bug.
    const forged = [
      {
        namespace: "alpha",
        name: "Alpha",
        description: "widget\u0001bravo\u0000Bravo\u0000widget",
        tools: [],
      },
    ];
    rankServers("widget", two);
    expect(rankServers("widget", forged).map((r) => r.namespace)).toEqual(["alpha"]);
    // A shared key would have reused the 2-doc index instead of building one,
    // so asserting the build is what keeps the canary able to fail at all.
    expect(relevanceCacheStats().indexBuilds).toBe(2);
  });

  it("still saturates term frequency after the counts refactor", () => {
    // FieldStats stores per-term counts instead of a token array; BM25's k1
    // saturation must still apply, so 5 repeats scores below 5x a single hit.
    const once = rankServers("widget", [{ namespace: "one", name: "One", description: "widget", tools: [] }]);
    const many = rankServers("widget", [
      { namespace: "one", name: "One", description: "widget widget widget widget widget", tools: [] },
    ]);
    expect(many[0].score).toBeGreaterThan(once[0].score);
    expect(many[0].score).toBeLessThan(once[0].score * 5);
  });

  it("keys both caches on a fixed-size digest, not on the corpus text", () => {
    // A large upstream's signature is every tool name and description it
    // publishes. Keyed on that raw text, MAX_CACHED_DOCS (512) doc entries
    // pin 512 multi-KB strings plus whole-corpus index keys, resident for the
    // life of the process purely as Map keys nothing reads back.
    const bulky = (ns: string) => ({
      namespace: ns,
      name: `${ns} server`,
      description: "x".repeat(4000),
      tools: Array.from({ length: 40 }, (_, i) => ({
        name: `${ns}_tool_${i}`,
        description: `y${i} `.repeat(200),
      })),
    });
    const corpus = [bulky("alpha"), bulky("bravo")];
    rankServers("alpha tool", corpus);

    const bytes = relevanceCacheKeyBytes();
    // Every key is one base64url sha256 digest (43 chars). Keyed on the raw
    // signature the longest key here would be tens of thousands of chars.
    expect(bytes.longestKey).toBeLessThanOrEqual(64);
    expect(bytes.docKeyBytes).toBeLessThanOrEqual(2 * 64);
    expect(bytes.indexKeyBytes).toBeLessThanOrEqual(64);
    // Digesting must not cost the staleness-proofing the content key exists
    // for: edit one description and the index has to rebuild.
    const edited = [bulky("alpha"), bulky("bravo")];
    edited[1].description = `${edited[1].description}z`;
    rankServers("alpha tool", edited);
    expect(relevanceCacheStats().indexBuilds).toBe(2);
    // ...and the untouched server's fields still come from the cache.
    expect(relevanceCacheStats().docBuilds).toBe(3);
  });
});
