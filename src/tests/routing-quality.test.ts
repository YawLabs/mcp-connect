import { describe, expect, it } from "vitest";
import { type RankableServer, rankServers } from "../relevance.js";

// ═══════════════════════════════════════════════════════════════════════
// Smart-routing quality gate. Pre-launch exercise from the launch TODO:
// "run mcp_connect_dispatch with varied English intents against a
// seeded 15-server config; verify the top-ranked server is correct or
// within top-3 in all cases."
//
// BM25 (relevance.ts) is the WHOLE ranker. This file used to call itself
// the "floor" beneath a Voyage rerank and tolerate misses on that basis;
// the rerank ran on the hosted backend, which is retired, and nothing in
// the repo reranks today. The only thing downstream of BM25 is dispatch's
// optional LLM sampling tiebreak, which reorders ranked.slice(0, 3) when
// the top candidates are close AND the budget resolves to one server AND
// the client advertises sampling — it can promote a top-3 result to #1,
// but it is skipped silently when any of those does not hold, and it can
// never rescue a server BM25 left out of the list. So a miss here is a
// production mis-route.
//
// Hence the two gates below are graded differently:
//   BENCHMARK — one intent per server, all 15 of them, so the number
//     measures 15 INDEPENDENT routing decisions. Held to 100% top-1:
//     with no second ranking stage there is nothing for a tolerance to
//     defer to, and every intent here passes today.
//   SUBTOOL_COVERAGE — several intents aimed at one server's separate
//     sub-tools. Held to top-3 only, and kept OUT of the accuracy gate:
//     five fetch intents inside a 14-intent >=80% gate meant one server's
//     ranking behavior, not routing breadth, consumed most of the
//     tolerance budget.
//
// Both are deliberately unit tests, not live-backend integration tests.
// ═══════════════════════════════════════════════════════════════════════

// Realistic seed of 15 MCP servers drawn from the public catalog
// (yaw.sh/mcp/catalog). Descriptions + tool metadata match what a
// representative install carries, which is what the ranker actually sees
// in production.
const CORPUS: RankableServer[] = [
  {
    namespace: "github",
    name: "GitHub",
    description: "GitHub API — issues, pull requests, repos, commits, branches, files, workflows",
    tools: [
      { name: "create_issue", description: "Open a new issue" },
      { name: "list_pull_requests" },
      { name: "merge_pull_request" },
      { name: "get_file_contents" },
      { name: "create_branch" },
      { name: "search_code" },
    ],
  },
  {
    namespace: "slack",
    name: "Slack",
    description: "Slack workspace — channels, messages, DMs, threads, reactions, users",
    tools: [
      { name: "post_message", description: "Send a message to a Slack channel" },
      { name: "list_channels" },
      { name: "reply_in_thread" },
      { name: "search_messages" },
    ],
  },
  {
    namespace: "stripe",
    name: "Stripe",
    description: "Stripe payments — charges, customers, subscriptions, invoices, refunds",
    tools: [
      { name: "create_charge", description: "Charge a customer's card" },
      { name: "create_customer" },
      { name: "create_subscription" },
      { name: "refund_charge" },
      { name: "list_invoices" },
    ],
  },
  {
    namespace: "postgres",
    name: "Postgres",
    description: "Postgres read-only SQL queries against the connected database",
    tools: [
      { name: "query", description: "Run a SELECT statement" },
      { name: "list_tables" },
      { name: "describe_table" },
    ],
  },
  {
    namespace: "linear",
    name: "Linear",
    description: "Linear project management — issues, projects, teams, comments, cycles",
    tools: [
      { name: "create_issue", description: "Create a Linear ticket" },
      { name: "list_issues" },
      { name: "add_comment" },
      { name: "update_issue_status" },
    ],
  },
  {
    namespace: "fetch",
    name: "Fetch",
    description:
      "HTTP fetch for agents — GET/POST/PUT/PATCH/DELETE, HTML to markdown, reader-mode article extraction, page metadata (opengraph, twitter cards, JSON-LD), outbound link extraction, XML sitemap parsing, RSS and Atom feed parsing, robots.txt verdicts. SSRF-protected.",
    tools: [
      { name: "http_get", description: "GET a URL and return the response body" },
      { name: "http_post", description: "POST a JSON or raw body to a URL" },
      { name: "http_put" },
      { name: "http_patch" },
      { name: "http_delete" },
      { name: "http_head" },
      { name: "http_options" },
      { name: "fetch_html_to_markdown", description: "Download a web page and convert to clean markdown" },
      { name: "fetch_html_to_text" },
      { name: "fetch_reader", description: "Reader-mode: isolate the main article body from a page" },
      { name: "fetch_meta", description: "Extract opengraph, twitter, JSON-LD metadata from a URL" },
      { name: "fetch_links", description: "Extract every outbound link from a page" },
      { name: "fetch_sitemap", description: "Parse an XML sitemap (gzipped and sitemap-index supported)" },
      { name: "fetch_feed", description: "Parse an RSS 2.0 or Atom 1.0 feed" },
      { name: "fetch_robots", description: "Parse robots.txt and return allow/disallow verdict for a path" },
    ],
  },
  {
    namespace: "filesystem",
    name: "Filesystem",
    description: "Read and write files on the local filesystem under an allowed root directory",
    tools: [{ name: "read_file" }, { name: "write_file" }, { name: "list_directory" }, { name: "search_files" }],
  },
  {
    namespace: "brave_search",
    name: "Brave Search",
    description: "Web search via Brave — query and return ranked results",
    tools: [{ name: "web_search", description: "Search the web" }],
  },
  {
    namespace: "time",
    name: "Time",
    description: "Current time, timezones, date arithmetic",
    tools: [{ name: "get_current_time" }, { name: "convert_timezone" }],
  },
  {
    namespace: "sentry",
    name: "Sentry",
    description: "Sentry error tracking — issues, events, releases, stack traces",
    tools: [{ name: "get_issue" }, { name: "list_project_issues" }, { name: "resolve_issue" }],
  },
  {
    namespace: "notion",
    name: "Notion",
    description: "Notion workspace — pages, databases, blocks, comments",
    tools: [{ name: "create_page" }, { name: "query_database" }, { name: "append_block_children" }, { name: "search" }],
  },
  {
    namespace: "gdrive",
    name: "Google Drive",
    description: "Google Drive files — list, read, upload, search documents and sheets",
    tools: [{ name: "list_files" }, { name: "read_file" }, { name: "search_files" }],
  },
  {
    namespace: "memory",
    name: "Memory",
    description: "Persistent knowledge graph for remembering entities and relations across sessions",
    tools: [
      { name: "create_entities" },
      { name: "create_relations" },
      { name: "search_nodes" },
      { name: "read_graph" },
    ],
  },
  {
    namespace: "sequential_thinking",
    name: "Sequential Thinking",
    description: "Step-by-step structured reasoning — break a hard problem into numbered thoughts",
    tools: [{ name: "sequentialthinking", description: "Add a structured reasoning step" }],
  },
  {
    namespace: "sqlite",
    name: "SQLite",
    description: "SQLite local database queries — SELECT, INSERT, schema inspection",
    tools: [{ name: "read_query" }, { name: "write_query" }, { name: "list_tables" }],
  },
];

// Varied intents a real user might give Claude, one per server in CORPUS.
// Each names the expected top-match namespace. Intents deliberately avoid
// including the namespace string itself in the query (that would be
// trivial) — they lean on the description/tools metadata instead.
//
// One intent per server is the point: duplicates would let a single
// server's ranking behavior move the accuracy number more than a whole
// other server going unrouted. Sub-tool variants belong in
// SUBTOOL_COVERAGE below.
const BENCHMARK: Array<{ intent: string; expected: string }> = [
  { intent: "open a new issue about a login bug on our repo", expected: "github" },
  { intent: "post a message to the #launch channel", expected: "slack" },
  { intent: "charge a customer's credit card for the invoice", expected: "stripe" },
  { intent: "run a SELECT query against the users table in the database", expected: "postgres" },
  { intent: "create a ticket for the mobile team to track a regression", expected: "linear" },
  { intent: "download the html of https://example.com/pricing", expected: "fetch" },
  { intent: "read the contents of a file from disk", expected: "filesystem" },
  { intent: "search the web for recent news about llms", expected: "brave_search" },
  { intent: "what time is it in Tokyo right now", expected: "time" },
  { intent: "look up the latest unresolved error events in our project", expected: "sentry" },
  { intent: "add a page to our team workspace and append some blocks", expected: "notion" },
  { intent: "upload a spreadsheet and list the shared documents in my cloud folder", expected: "gdrive" },
  { intent: "remember the entities and relations from this session for later", expected: "memory" },
  { intent: "break this hard problem into numbered steps of structured reasoning", expected: "sequential_thinking" },
  { intent: "insert a row into the local db file and inspect its schema", expected: "sqlite" },
];

// fetch-mcp v0.2.0's expanded surface — each intent targets a different
// sub-tool of the SAME server, so these measure sub-tool recall inside one
// document rather than routing between servers. Top-3 only, and excluded
// from the accuracy gate for the reason in the header.
const SUBTOOL_COVERAGE: Array<{ intent: string; expected: string }> = [
  { intent: "parse the xml sitemap for example.com", expected: "fetch" },
  { intent: "extract the main article body from this blog post url", expected: "fetch" },
  { intent: "get the opengraph metadata from this page url", expected: "fetch" },
  { intent: "parse the rss feed at blog.example.com/feed.xml", expected: "fetch" },
];

function topN(intent: string, n: number): string[] {
  return rankServers(intent, CORPUS)
    .slice(0, n)
    .map((r) => r.namespace);
}

describe("smart-routing quality gate (BM25 is the whole ranker)", () => {
  // Primary gate from the launch TODO: top-3 must contain expected. This
  // is where the sub-tool intents are graded too — dispatch's sampling
  // tiebreak only ever reorders the top 3, so falling out of it is
  // unrecoverable no matter what the client supports.
  it.each([...BENCHMARK, ...SUBTOOL_COVERAGE])("top-3 contains expected namespace for: $intent", ({
    intent,
    expected,
  }) => {
    const top3 = topN(intent, 3);
    expect(top3, `top-3 was: ${top3.join(", ")}`).toContain(expected);
  });

  // Stronger gate, and the one that matters: with one intent per server
  // and no second ranking stage, every intent must rank its server #1.
  // A miss is a user typing an intent and getting the wrong server
  // spawned, so it is fixed (or the intent deleted as unrealistic) rather
  // than absorbed by a tolerance. Sub-tool intents are excluded so one
  // server cannot dominate the number.
  it("routes every benchmark intent to its own server at rank 1", () => {
    const misses = BENCHMARK.filter(({ intent, expected }) => topN(intent, 1)[0] !== expected).map(
      ({ intent, expected }) => `${expected} != ${topN(intent, 3).join(", ")} for ${JSON.stringify(intent)}`,
    );
    expect(misses, `top-1 misses (${misses.length}/${BENCHMARK.length}):\n  ${misses.join("\n  ")}`).toEqual([]);
  });

  // Coverage guard on the benchmark itself: every server in CORPUS is
  // routed to by exactly one intent. Adding a server without an intent
  // (the state notion / gdrive / memory / sequential_thinking / sqlite
  // were in) leaves it silently unexercised.
  it("carries exactly one benchmark intent per server in the corpus", () => {
    const expected = BENCHMARK.map((b) => b.expected).sort();
    expect(expected).toEqual(CORPUS.map((s) => s.namespace).sort());
  });
});
