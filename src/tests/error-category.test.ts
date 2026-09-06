import { describe, expect, it } from "vitest";
import { classifyError, ERROR_CATEGORIES } from "../error-category.js";

describe("classifyError", () => {
  // Test cases sourced from real failures observed in session
  // transcripts on 2026-05-19 .. 2026-05-21 (an investigation of the
  // since-retired hosted backend's "Recent failures" dashboard; the
  // failure shapes outlived the dashboard).
  const cases: Array<[string, string, (typeof ERROR_CATEGORIES)[number]]> = [
    ["ssh_exec timeout", "Error calling ssh_ssh_exec [code=-32001]: MCP error -32001: Request timed out", "timeout"],
    ["bare 'timed out' phrasing", "upstream: connection timed out after 30s", "timeout"],
    // axios's canonical message -- "timeout" is the FIRST word, so the old
    // " timeout" (leading-space) test missed it and it fell through to
    // upstream_error, which reward.ts scores as a full-credit call.
    ["axios timeout shape (start of string)", "timeout of 5000ms exceeded", "timeout"],
    ["axios timeout shape wrapped by a client", "Error: timeout of 30000ms exceeded", "timeout"],
    ["timeout followed by punctuation", "Request failed (timeout: 10s)", "timeout"],
    // Word-boundary discipline: identifier-shaped text must NOT read as a
    // timeout. `_` is a word char in JS regex, so \btimeout\b skips both.
    [
      "identifier-shaped 'connectTimeoutMs' is not a timeout",
      "Error: invalid value for connectTimeoutMs in server config",
      "upstream_error",
    ],
    ["identifier-shaped 'set_timeout' is not a timeout", "Error thrown inside set_timeout handler", "upstream_error"],
    // A quote-delimited `timeout` token is DATA, not a failure report.
    // server.ts scores EVERY proxied result, so a successful get_config that
    // echoes a timeout setting used to classify as "timeout" and bank 0.2
    // reward instead of full credit.
    ["json config key named timeout is not a timeout", '{"timeout":5000,"retries":3}', "upstream_error"],
    ["python-repr config key named timeout is not a timeout", "{'timeout': 5000, 'retries': 3}", "upstream_error"],
    // Same guard on the read side: a zod path segment named "timeout" must not
    // steal a -32602 reply from validation_error (server.ts's inputShaped
    // check depends on that classification).
    [
      "zod path segment named timeout stays a validation error",
      'MCP error -32602: Input validation error: Invalid arguments for tool http_get: [{"expected":"number","code":"invalid_type","path":["timeout"]}]',
      "validation_error",
    ],
    // ...and the tightening must not lose an unquoted prose timeout.
    ["unquoted prose timeout still classifies", "Error: gateway timeout while contacting upstream", "timeout"],
    [
      "zod validation -32602 with missing array",
      'MCP error -32602: Input validation error: Invalid arguments for tool aws_metrics_query: [{"expected":"array","code":"invalid_type","path":["queries"]}]',
      "validation_error",
    ],
    [
      "zod -32602 with missing string field",
      'MCP error -32602: Input validation error: Invalid arguments for tool aws_call: [{"expected":"string","code":"invalid_type","path":["operation"],"message":"Invalid input: expected string, received undefined"}]',
      "validation_error",
    ],
    // Every validation case above carries -32602, which is the first
    // sub-pattern tested -- so the other three ("invalid input",
    // "invalid_type", "invalid arguments") could each be deleted with the
    // suite still green. These pin one apiece as the SOLE deciding
    // condition: an upstream that reports zod issues without the JSON-RPC
    // code (a raw validator throw, a re-wrapped SDK message) still has to
    // classify as validation_error rather than falling through to
    // upstream_error, which reward.ts grants full credit.
    ["'invalid input' alone, no -32602", "Invalid input: expected string, received undefined", "validation_error"],
    [
      "'invalid_type' zod issue alone, no -32602",
      '[{"code":"invalid_type","expected":"number","path":["limit"]}]',
      "validation_error",
    ],
    [
      "'invalid arguments' alone, no -32602",
      "Invalid arguments for tool gh_search: missing required property",
      "validation_error",
    ],
    [
      "dispatcher unknown tool",
      "Unknown tool: npmjs_npm_trusted_publishers. Use mcp_connect_discover to see available servers, then mcp_connect_activate to load tools.",
      "unknown_tool",
    ],
    ["JSON-RPC method not found", "MCP error -32601: Method not found", "unknown_tool"],
    [
      "missing token (npm shape)",
      "Error: No NPM_TOKEN configured. Set the NPM_TOKEN environment variable to use authenticated endpoints.",
      "unauthorized",
    ],
    [
      "missing token (github shape)",
      "No GITHUB_TOKEN configured. Set it to use authenticated endpoints.",
      "unauthorized",
    ],
    ["HTTP 401", "Request failed: 401 Unauthorized", "unauthorized"],
    ["HTTP 403", "Forbidden (403)", "unauthorized"],
    ["permission denied phrasing", "Permission denied: cannot access resource", "unauthorized"],
    ["HTTP 429", "429 Too Many Requests", "rate_limited"],
    ["rate limit phrasing", "API rate limit exceeded for user", "rate_limited"],
    ["rate-limit beats auth when both appear", "auth-rate-limit: too many requests", "rate_limited"],
    ["HTTP 404", "Resource returned 404", "not_found"],
    ["bare not found", "Subscription not found in store", "not_found"],
    [
      "yaw-mcp auto-reconnect failed",
      'Server "ssh" disconnected and auto-reconnect failed: ECONNREFUSED. Use mcp_connect_activate with server "ssh" to reload it manually.',
      "connection_lost",
    ],
    [
      "unknown upstream falls through to upstream_error",
      "TypeError: Cannot read properties of undefined (reading 'foo')",
      "upstream_error",
    ],
    // Bare status-code tokens inside SUCCESSFUL reply text must NOT
    // classify as errors: reward.ts runs classifyError over every proxied
    // result, so a false positive here banks a healthy call at 0.2 credit
    // and feeds the flaky list. The regexes require a status-ish intro
    // word (status/code/http/error/failed/response/returned/received/
    // rejected) before the digits -- see httpStatusRe in error-category.ts.
    ["issue number is not a rate limit", "#429 fix flaky build", "upstream_error"],
    ["stack-trace line/column is not a 404", "at handler (server.js:404:12)", "upstream_error"],
    ["JSON payload number is not a 401", '{"number":401,"title":"Fix login flow"}', "upstream_error"],
    ["byte count is not a 429", "rx 429 bytes in 12ms", "upstream_error"],
    ["spelled-out byte count is not a 429", "received 429 bytes in 12ms", "upstream_error"],
    ["result count is not a 403", "search returned 403 results", "upstream_error"],
    ["PID is not a 403", "PID 403 running", "upstream_error"],
    // ...while codes INTRODUCED by a status-ish word still classify.
    ["status-code phrasing", "Request failed with status code 429", "rate_limited"],
    ["http-prefixed code", "HTTP 404", "not_found"],
    ["error-prefixed code", "upstream error: 401", "unauthorized"],
    ["returned-prefixed code", "the API returned 403", "unauthorized"],
    // Real MCP error-body spellings: Node/AWS/Hapi statusCode, Python
    // requests/httpx status_code, raw HTTP/1.1 status lines, and
    // post-positioned phrasings the intro-word shape cannot see.
    ["Node-style statusCode JSON", '{"statusCode":429,"retryAfter":30}', "rate_limited"],
    ["Python-style status_code", "status_code: 401", "unauthorized"],
    ["status_code with intro", "request failed with status_code 404", "not_found"],
    ["HTTP/1.1 status line", "HTTP/1.1 429", "rate_limited"],
    ["post-positioned response", "got a 429 response", "rate_limited"],
    ["post-positioned error", "404 error from server", "not_found"],
    // Counts the first unit-noun guard missed: nouns outside the original
    // list, an adjective between count and noun, a table row with the noun
    // BEFORE the intro word, and a test-runner summary.
    ["request count is not a rate limit", "received 429 requests in the last hour", "upstream_error"],
    ["message count is not a 401", "received 401 unread messages", "upstream_error"],
    ["item count with adjective is not a 429", "received 429 new items", "upstream_error"],
    ["row count with adjective is not a 403", "query returned 403 matching rows", "upstream_error"],
    ["table row with leading noun is not a 429", "| bytes received | 429 |", "upstream_error"],
    ["test-runner summary is not a 429", "0 failed, 429 passed", "upstream_error"],
    // Real errors with a function-word bridge between intro and code, and
    // the "responded" / "access denied" spellings.
    ["bridge word: failed with", "request failed with 429", "rate_limited"],
    ["bridge word: returned a", "the API returned a 429", "rate_limited"],
    ["responded with + access denied", "GitHub API responded with 403: access denied to repo", "unauthorized"],
    ["responded with a status of", "the server responded with a status of 429", "rate_limited"],
    ["bare access denied", "Access denied.", "unauthorized"],
    // A ":" or "," right after the code introduces a MESSAGE, never a unit,
    // and token/user/request/... are the ordinary objects of a real failure
    // message after a STATUS intro -- neither may veto the code.
    ["colon then message clause", "HTTP 401: the token has expired", "unauthorized"],
    ["comma then message field", "status: 429, message: quota exceeded", "rate_limited"],
    ["colon then request clause", "Error: status 429: the request could not be completed", "rate_limited"],
    ["colon then user clause", "HTTP 403: user lacks the required scope", "unauthorized"],
    ["comma then not-found message", "status: 404, message: no such workspace", "not_found"],
    ["domain noun after status intro", "status 401 token expired", "unauthorized"],
    ["domain noun after status-code intro", "Request failed with status code 401: token invalid", "unauthorized"],
    ["domain noun after error intro", "error 429 requests exhausted, retry later", "rate_limited"],
    // ...while the same domain noun after a COUNT verb is a count.
    ["domain noun after count verb", "received 429 requests in the last hour", "upstream_error"],
    // Punctuation after a bridge word.
    ["bridge then parenthesised code", "Request failed with (429)", "rate_limited"],
    ["bridge then bracketed code", "responded with [429]", "rate_limited"],
    ["bridge then colon", "failed with: 429", "rate_limited"],
    // Bodies that BEGIN with the code (Anthropic / OpenAI SDK convention)
    // and go-github's "<METHOD> <url>: <code> <reason> []" reason phrases.
    [
      "Anthropic SDK body",
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      "unauthorized",
    ],
    [
      "OpenAI SDK quota body",
      "429 You exceeded your current quota, please check your plan and billing details.",
      "rate_limited",
    ],
    [
      "go-github bad credentials",
      "failed to get issue: GET https://api.github.com/repos/o/r/issues/1: 401 Bad credentials []",
      "unauthorized",
    ],
    [
      "go-github not accessible",
      "GET https://api.github.com/repos/o/r: 403 Resource not accessible by personal access token []",
      "unauthorized",
    ],
    // ...but a body that opens with a COUNT is not an error.
    ["leading count of users", "429 users match the filter", "upstream_error"],
    ["leading count of issues", "404 issues found", "upstream_error"],
    ["leading count of rows", "401 rows returned", "upstream_error"],
    // CamelCase-glued class names and the JSON key spellings beyond
    // statusCode/status_code (incl. AWS SDK v3's $metadata.httpStatusCode).
    ["python requests HTTPError", "HTTPError: 404 Client Error: No such resource for url: https://x", "not_found"],
    ["HttpException class name", "HttpException: 429", "rate_limited"],
    ["bare Exception class name", "Exception: 429", "rate_limited"],
    ["StatusCodeError class name", "StatusCodeError: 429 - {}", "rate_limited"],
    ["errorCode JSON key", '{"errorCode":401,"errorMessage":"Invalid token"}', "unauthorized"],
    ["error_code JSON key", '{"error_code":429,"detail":"slow down"}', "rate_limited"],
    ["AWS SDK v3 metadata", '{"$metadata":{"httpStatusCode":403}}', "unauthorized"],
    ["http_status assignment", "http_status=429", "rate_limited"],
    // The fetch-wrapper template ("Failed to fetch <url>: <status>") whose
    // HTTP/2 statusText is empty, so no reason phrase can rescue it.
    ["fetch wrapper with URL", "Failed to fetch https://api.example.com/v1/x: 401", "unauthorized"],
    ["fetch wrapper with path", "Failed to fetch robots.txt: 404", "not_found"],
    ["fetching prose with URL", "error fetching url https://example.com: 429", "rate_limited"],
    // Singular domain nouns are the OBJECTS of a reason phrase; only the
    // plural forms are counts.
    ["singular token after count verb", "Server returned 401 invalid token", "unauthorized"],
    ["singular user after count verb", "returned 403 user lacks scope", "unauthorized"],
    ["leading code, singular token", "401 Token expired", "unauthorized"],
    ["leading code, singular request", "429 Request rate exceeded", "rate_limited"],
    // Quoted/bracketed SDK bodies.
    ["re-quoted SDK body", '"401 {\\"type\\":\\"error\\"}"', "unauthorized"],
    ["bracketed code", '[401] {"type":"error"}', "unauthorized"],
    ["parenthesised leading code", "(401) invalid x-api-key", "unauthorized"],
    // A count noun BEFORE a status intro must not veto the failure...
    ["count noun before failed", "3 files failed with 429", "rate_limited"],
    ["count noun before failed colon", "2 files failed: 401", "unauthorized"],
    // ...while issue refs and table count columns stay out.
    ["issue ref after error", "fixed error #429 in the build", "upstream_error"],
    ["table count column", "| errors | 429 |", "upstream_error"],
    // The URL token is captured UNCAPPED: a {1,300} cap made presigned
    // S3/Azure/GCS URLs (routinely 400-1500 chars) fall out of the
    // fetch-wrapper shape -- atomicity forbade retrying a shorter capture.
    [
      "fetch wrapper with a presigned URL",
      `Failed to fetch https://bucket.s3.amazonaws.com/key?X-Amz-Signature=${"a".repeat(400)}: 403`,
      "unauthorized",
    ],
    // The count-verb shape shares the URL bridge; a numbered backreference
    // was silently renumbered by the second interpolation, leaving this
    // branch dead -- the named groups pin it alive.
    ["count verb with URL", "returned https://api.example.com/v1: 429", "rate_limited"],
    // Glued identifiers must not match: every real error spelling has at
    // least one separator between intro and code (the gaps are {1,10}).
    ["glued key spelling in a filename", "wrote errorcode429.log", "upstream_error"],
    ["glued http_status in a filename", "saved http_status429.json", "upstream_error"],
    ["glued camel suffix in a filename", "see typeerror429.md", "upstream_error"],
    // The uncapped token still refuses a non-colon-terminated one.
    ["stack trace after error intro", "error at handler (server.js:404:12)", "upstream_error"],
  ];

  it("does not backtrack quadratically on a long run of intro/bridge tokens", () => {
    // "status" used to sit in BOTH the intro and the bridge alternation, so
    // a whitespace-separated run of it re-entered the bridge from every
    // intro position: 11 s on a 98 KB reply (measured). Every proxied
    // result is classified by reward.ts, so this must stay linear-ish.
    //
    // The suffix keeps the tripwire honest: classifyError now short-circuits
    // each status regex on `t.includes("<code>")`, so a digit-free body
    // never reaches the regexes at all -- without this suffix the test would
    // measure the guard rejecting the input (0-58 ms) instead of the regexes
    // running, and would pass no matter how badly they backtracked. Each
    // token glues the digits to word chars ("x429x"), so the guard opens but
    // no shape can match (`429\b` needs a boundary after the 9): all four
    // regexes full-scan the 98 KB. Every case below must therefore come back
    // `upstream_error` -- an earlier branch returning would mean the scans
    // never happened, so the assertion below checks that too.
    const digitBait = "x401x x403x x404x x429x";
    // Warm-up: the first .test() of each regex pays V8's lazy compile of a
    // very large pattern; that cost is real but is not the backtracking
    // this test guards, so pull it out of the timed runs.
    classifyError(digitBait);
    for (const word of ["status", "with", "a", "error", "status with a status of", "failed with a"]) {
      const big = `${word} `.repeat(Math.ceil(98_000 / (word.length + 1))) + digitBait;
      const t0 = performance.now();
      const category = classifyError(big);
      const elapsed = performance.now() - t0;
      // Budget. Measured on a Windows ARM64 box: the linear scans take
      // 26-250 ms standalone, and the 500 ms budget this replaces still
      // failed a release run at 822 ms -- the suite runs in parallel (394 s
      // of test time inside 88 s of wall clock), so a timing assertion here
      // is competing for CPU with ~4x oversubscription. Re-introducing the
      // quadratic bug costs 4.3 s in ONE of the four regexes, so ~17 s in
      // this call. 3000 ms clears the contended worst case by ~3x and sits
      // ~6x under the regression: wide enough not to flake a release,
      // narrow enough that the catastrophic shape cannot slip through.
      expect(elapsed, `run of ${JSON.stringify(word)}`).toBeLessThan(3000);
      // Guards against a vacuous timing: had an earlier branch returned,
      // the four status regexes would never have run.
      expect(category, `run of ${JSON.stringify(word)} must reach the status regexes`).toBe("upstream_error");
    }
  });

  for (const [name, input, expected] of cases) {
    it(`classifies: ${name} -> ${expected}`, () => {
      expect(classifyError(input)).toBe(expected);
    });
  }

  it("returns upstream_error for empty / null / undefined text", () => {
    expect(classifyError(null)).toBe("upstream_error");
    expect(classifyError(undefined)).toBe("upstream_error");
    expect(classifyError("")).toBe("upstream_error");
  });

  it("only ever returns values in the ERROR_CATEGORIES allowlist", () => {
    // Deliberately NOT sourced from `cases` (nor from the empty/null test
    // above): every one of those inputs already has an assertion pinning its
    // exact category, so re-classifying them here cannot fail unless that
    // assertion has already failed -- the check was true by construction.
    // These are shapes nothing else covers: whitespace, control bytes, an
    // ordinary success body, every category's trigger word crammed into one
    // string, a run of status intros, and bodies long enough to reach past
    // the substring pre-checks in both directions (digit-free and not).
    const probes: string[] = [
      "   ",
      `${String.fromCharCode(0, 27, 9)}[31m NUL + ESC + tab`,
      "OK",
      '{"ok":true,"rows":[1,2,3]}',
      "-32602 -32601 -32001 429 401 404 timed out unknown tool not found",
      "status 429 status 401 status 404 status 403",
      "a".repeat(20_000),
      `${"lorem ipsum ".repeat(2_000)}401`,
    ];
    for (const probe of probes) {
      const label = probe.length > 60 ? `${probe.slice(0, 60)}... (${probe.length} chars)` : probe;
      expect(ERROR_CATEGORIES, `probe: ${JSON.stringify(label)}`).toContain(classifyError(probe));
    }
  });

  // Drift tripwire for the one surviving consumer of these strings.
  // reward.ts's ERROR_SHAPED_CATEGORIES names seven of the eight by literal
  // (everything but upstream_error) to decide which soft failures score
  // REWARD_ERROR_SHAPED. That set is typed ReadonlySet<ErrorCategory>, so a
  // RENAMED or REMOVED member fails tsc over there -- but an ADDED member
  // does not: it silently lands in the "not error-shaped" bucket, and a 200
  // reply carrying the new category grades as a clean full-credit success.
  // Pin the literal contents here so widening the enum is a deliberate
  // two-file change (this test fails -> reward.ts's set has to decide
  // whether the newcomer is error-shaped). The hosted backend that once kept
  // its own copy of this list is retired; there is no second repo to update.
  it("ERROR_CATEGORIES is the exact pinned list (reward.ts coupling tripwire)", () => {
    expect([...ERROR_CATEGORIES]).toEqual([
      "validation_error",
      "timeout",
      "unauthorized",
      "unknown_tool",
      "connection_lost",
      "rate_limited",
      "not_found",
      "upstream_error",
    ]);
  });
});
