import { describe, expect, it } from "vitest";
import {
  ACTIVATION_FAILURE_TTL_MS,
  activationFailureFactor,
  errorRateFactor,
  formatHealthWarning,
  healthFactor,
  scrubForWarning,
} from "../health-score.js";

describe("errorRateFactor", () => {
  it("returns 1.0 when health is undefined", () => {
    expect(errorRateFactor(undefined)).toBe(1.0);
  });

  it("returns 1.0 below the observation floor", () => {
    expect(errorRateFactor({ totalCalls: 2, errorCount: 2, totalLatencyMs: 0 })).toBe(1.0);
  });

  it("returns 1.0 for perfect reliability", () => {
    expect(errorRateFactor({ totalCalls: 10, errorCount: 0, totalLatencyMs: 0 })).toBe(1.0);
  });

  it("applies linear penalty for low error rates", () => {
    expect(errorRateFactor({ totalCalls: 10, errorCount: 1, totalLatencyMs: 0 })).toBeCloseTo(0.9);
  });

  it("floors at 0.5 for high error rates", () => {
    expect(errorRateFactor({ totalCalls: 10, errorCount: 8, totalLatencyMs: 0 })).toBe(0.5);
    expect(errorRateFactor({ totalCalls: 10, errorCount: 10, totalLatencyMs: 0 })).toBe(0.5);
  });
});

describe("activationFailureFactor", () => {
  it("returns 1.0 when no failure", () => {
    expect(activationFailureFactor(undefined)).toBe(1.0);
  });

  it("returns 0.5 for a recent failure", () => {
    const now = 1_000_000;
    expect(activationFailureFactor({ at: now - 1000, message: "boom" }, now)).toBe(0.5);
  });

  it("returns 1.0 for a stale failure past the TTL", () => {
    const now = 1_000_000;
    expect(activationFailureFactor({ at: now - ACTIVATION_FAILURE_TTL_MS - 1, message: "boom" }, now)).toBe(1.0);
  });

  it("returns 1.0 for a FUTURE-dated failure (backwards clock step)", () => {
    const now = 1_000_000;
    // A backwards wall-clock step (NTP correction, VM resume) leaves `at` in
    // the future, so (now - at) is negative -- which an upper-bound-only TTL
    // check reads as "younger than the TTL" and pins at 0.5 until the clock
    // catches back up to the stamp. Skew is not evidence.
    expect(activationFailureFactor({ at: now + 60_000, message: "boom" }, now)).toBe(1.0);
    expect(activationFailureFactor({ at: now + 60 * 60_000, message: "boom" }, now)).toBe(1.0);
  });
});

describe("healthFactor", () => {
  it("returns 1.0 when both signals are clean", () => {
    expect(healthFactor({ totalCalls: 5, errorCount: 0, totalLatencyMs: 10 }, undefined)).toBe(1.0);
  });

  it("takes the strictest penalty", () => {
    const now = 1_000_000;
    // 50% error rate = 0.5 factor; recent activation failure also 0.5.
    expect(healthFactor({ totalCalls: 10, errorCount: 5, totalLatencyMs: 10 }, { at: now, message: "x" }, now)).toBe(
      0.5,
    );
  });

  it("picks the worse of two signals", () => {
    const now = 1_000_000;
    // Healthy history but recent activation failure should still penalize.
    expect(healthFactor({ totalCalls: 10, errorCount: 0, totalLatencyMs: 10 }, { at: now, message: "x" }, now)).toBe(
      0.5,
    );
  });
});

describe("formatHealthWarning", () => {
  it("returns null when both signals are clean", () => {
    expect(formatHealthWarning(undefined, undefined)).toBeNull();
    expect(formatHealthWarning({ totalCalls: 0, errorCount: 0, totalLatencyMs: 0 }, undefined)).toBeNull();
    expect(formatHealthWarning({ totalCalls: 10, errorCount: 0, totalLatencyMs: 5 }, undefined)).toBeNull();
  });

  it("hides low-sample error rates to avoid over-fitting to one flake", () => {
    // 2/2 is 100% fail -- but below the 3-call observation floor. Silent.
    expect(formatHealthWarning({ totalCalls: 2, errorCount: 2, totalLatencyMs: 5 }, undefined)).toBeNull();
  });

  it("surfaces a sub-30% nonzero error rate so the ranking penalty isn't silent", () => {
    // 1 of 5 = 20% error, above the observation floor. errorRateFactor
    // down-ranks this (factor 0.8), so the health block must show it rather
    // than staying silent below the old 30% warn threshold.
    const w = formatHealthWarning({ totalCalls: 5, errorCount: 1, totalLatencyMs: 5 }, undefined);
    expect(w).toBe("warn: 1 of 5 calls failed");
  });

  it("stays silent for a nonzero error rate below WARN_RATE_FLOOR", () => {
    // 1 of 100 = 1% error, above the 3-call observation floor but below the
    // 10% WARN_RATE_FLOOR. Because totalCalls/errorCount never decay, a lone
    // old error in a large sample must NOT emit a permanent "N of M failed"
    // line at a negligible penalty -- that would train the model to skip a
    // fine server. Reverting the WARN_RATE_FLOOR gate in formatHealthWarning
    // to rate>0 would surface this line and fail the assertion.
    expect(formatHealthWarning({ totalCalls: 100, errorCount: 1, totalLatencyMs: 5 }, undefined)).toBeNull();
  });

  it("appends the last error message once the rate clears WARN_RATE_FLOOR", () => {
    const w = formatHealthWarning(
      { totalCalls: 10, errorCount: 3, totalLatencyMs: 5, lastErrorMessage: "503 Service Unavailable" },
      undefined,
    );
    expect(w).toBe("warn: 3 of 10 calls failed: 503 Service Unavailable");
  });

  it("omits the tail message when there is no lastErrorMessage", () => {
    const w = formatHealthWarning({ totalCalls: 10, errorCount: 4, totalLatencyMs: 5 }, undefined);
    expect(w).toBe("warn: 4 of 10 calls failed");
  });

  // The counters never decay, so totalCalls is the all-time total for the
  // process, not a rolling window. The line must not say "of the last M".
  it("does not claim a recency window the counters do not carry", () => {
    const w = formatHealthWarning({ totalCalls: 10, errorCount: 4, totalLatencyMs: 5 }, undefined);
    expect(w).not.toContain("of last");
  });

  it("reports a recent activation failure in preference to error rate", () => {
    const now = 1_000_000;
    const w = formatHealthWarning(
      { totalCalls: 10, errorCount: 5, totalLatencyMs: 5, lastErrorMessage: "bad call" },
      { at: now - 90_000, message: "spawn ENOENT npx" },
      now,
    );
    // Activation failure (~2m old) takes priority over per-call rate.
    expect(w).toBe("warn: last activation failed 2m ago: spawn ENOENT npx");
  });

  it("skips a stale activation failure past the TTL", () => {
    const now = 1_000_000;
    const w = formatHealthWarning(undefined, { at: now - ACTIVATION_FAILURE_TTL_MS - 1, message: "boom" }, now);
    expect(w).toBeNull();
  });

  it("skips a FUTURE-dated activation failure instead of reporting it as '1m ago'", () => {
    const now = 1_000_000;
    // Clock skew, not a fresh failure: the age is negative, and
    // Math.max(1, Math.round(negative / 60_000)) floors it to 1, so the line
    // claimed "last activation failed 1m ago" on every discover() until the
    // clock caught up.
    const w = formatHealthWarning(
      { totalCalls: 10, errorCount: 0, totalLatencyMs: 5 },
      { at: now + 5 * 60_000, message: "spawn ENOENT npx" },
      now,
    );
    expect(w).toBeNull();
  });

  it("collapses whitespace and truncates very long error messages", () => {
    const long = "x".repeat(500);
    const w = formatHealthWarning(
      { totalCalls: 10, errorCount: 5, totalLatencyMs: 5, lastErrorMessage: long },
      undefined,
    );
    // 120-char cap (117 + "...") on the tail, not on the warning prefix.
    expect(w).toContain("5 of 10 calls failed");
    expect(w!.endsWith("...")).toBe(true);
    expect(w!.length).toBeLessThan("warn: 5 of 10 calls failed: ".length + 125);
  });
});

describe("formatHealthWarning -- credential scrubbing", () => {
  // error-category.ts refuses to print raw upstream text next to a category
  // because third-party MCP servers echo secrets in errors. This surface used
  // to contradict that by pasting up to 120 raw chars into discover output.
  it("redacts a query-string api_key but keeps the actionable rest", () => {
    const w = formatHealthWarning(
      {
        totalCalls: 10,
        errorCount: 3,
        totalLatencyMs: 5,
        lastErrorMessage: "GET https://api.example.com/v1/x?api_key=abc123secretvalue&page=2 failed",
      },
      undefined,
    );
    expect(w).not.toContain("abc123secretvalue");
    expect(w).toContain("<redacted>");
    expect(w).toContain("api.example.com");
    expect(w).toContain("3 of 10 calls failed");
  });

  it("redacts an Authorization header value, scheme word and all", () => {
    // Scheme-first ordering matters: with the name/value rule running first,
    // "Authorization" + ":" + "Bearer" matched, so the WORD Bearer was
    // redacted and the token itself survived.
    const w = formatHealthWarning(
      {
        totalCalls: 10,
        errorCount: 5,
        totalLatencyMs: 5,
        lastErrorMessage: "401 rejected Authorization: Bearer eyJhbGciOiJIUzI1NiJ9dEADbEEF",
      },
      undefined,
    );
    expect(w).not.toContain("eyJhbGciOiJIUzI1NiJ9dEADbEEF");
    expect(w).toContain("401 rejected");
  });

  it("redacts a bare vendor-prefixed key that carries no name", () => {
    const w = formatHealthWarning(
      {
        totalCalls: 10,
        errorCount: 5,
        totalLatencyMs: 5,
        lastErrorMessage: "config error: ghp_AbCdEf0123456789zzzz is not valid",
      },
      undefined,
    );
    expect(w).not.toContain("ghp_AbCdEf0123456789zzzz");
    expect(w).toContain("is not valid");
  });

  it("scrubs the ACTIVATION-failure excerpt on the same terms", () => {
    const now = 1_000_000;
    const w = formatHealthWarning(undefined, { at: now - 60_000, message: "spawn failed: token=hunter2hunter2" }, now);
    expect(w).not.toContain("hunter2hunter2");
    expect(w).toContain("last activation failed");
    expect(w).toContain("<redacted>");
  });

  it("leaves an ordinary status/errno excerpt untouched", () => {
    // The excerpt earns its place -- "502 bad gateway" tells the model to try
    // elsewhere where a bare category would not. Over-scrubbing would be as
    // bad a regression as leaking.
    const w = formatHealthWarning(
      { totalCalls: 10, errorCount: 5, totalLatencyMs: 5, lastErrorMessage: "502 bad gateway (upstream unreachable)" },
      undefined,
    );
    expect(w).toBe("warn: 5 of 10 calls failed: 502 bad gateway (upstream unreachable)");
  });

  it("does not mistake 'unauthorized' for a credential name", () => {
    // "auth" is a redacted key name, and "unauthorized: 401" would be gutted
    // by a rule that ignored word boundaries.
    expect(scrubForWarning("unauthorized: 401")).toBe("unauthorized: 401");
  });

  it("redacts a value whose key carries an underscore-joined prefix", () => {
    // `_` is a word character, so a \b anchored directly on the name token
    // never fires inside NOTION_API_KEY -- and env-var spellings are the
    // dominant shape in MCP spawn/config errors. This value carries no vendor
    // prefix, so neither the Bearer rule nor the vendor-prefix rule covers it.
    const w = formatHealthWarning(
      {
        totalCalls: 10,
        errorCount: 5,
        totalLatencyMs: 5,
        lastErrorMessage: "401 rejected NOTION_API_KEY=abc123def456",
      },
      undefined,
    );
    expect(w).not.toContain("abc123def456");
    expect(w).toContain("NOTION_API_KEY=<redacted>");
    expect(w).toContain("401 rejected");
  });

  it("keeps the FULL prefixed name and blanks only the value", () => {
    expect(scrubForWarning("auth_token=abc123def456")).toBe("auth_token=<redacted>");
    expect(scrubForWarning("MY_SECRET=hunter2hunter2")).toBe("MY_SECRET=<redacted>");
    expect(scrubForWarning("GITHUB_API_KEY: zzzz9999zzzz")).toBe("GITHUB_API_KEY: <redacted>");
  });

  it("does not over-scrub a prefixed name that is not a credential", () => {
    // Over-scrubbing is as bad a regression as leaking (see the 502 case
    // above). The prefix run has to END in a secret name that is itself
    // followed by = or :, so SSH_AUTH_SOCK -- `_SOCK` sits after `AUTH` --
    // keeps its benign path.
    const line = "SSH_AUTH_SOCK=/tmp/ssh-XXXX/agent.123 is not set";
    expect(scrubForWarning(line)).toBe(line);
  });

  it("does not invert a missing-credential diagnostic into a present-but-rejected one", () => {
    // The name side of rule 2 matches these (the prefix run ends in TOKEN /
    // API_KEY, followed by ':'), but the VALUE is a bare absence word ENDING
    // the clause, not a credential. Redacting it consumed only the first
    // whitespace-delimited token, so "GITHUB_TOKEN: not set" came out as
    // "GITHUB_TOKEN: <redacted> set" -- the surviving "set" flips the reading
    // from "credential absent" to "credential present but rejected".
    // Reachable: upstream stderr tail -> activationFailures -> the discover()
    // warn line.
    expect(scrubForWarning("Error: GITHUB_TOKEN: not set")).toBe("Error: GITHUB_TOKEN: not set");
    expect(scrubForWarning("env var NOTION_API_KEY: missing")).toBe("env var NOTION_API_KEY: missing");
    expect(scrubForWarning("AUTH_TOKEN: undefined")).toBe("AUTH_TOKEN: undefined");
    // "nil" / "n/a" end a clause the same way, so they belong on the same
    // fast path -- without them "GITHUB_TOKEN: nil" redacted to
    // "GITHUB_TOKEN: <redacted>", hiding the diagnostic outright.
    expect(scrubForWarning("GITHUB_TOKEN: nil")).toBe("GITHUB_TOKEN: nil");
    expect(scrubForWarning("SLACK_BOT_TOKEN: n/a")).toBe("SLACK_BOT_TOKEN: n/a");
  });

  it("hides rather than inverts a diagnostic, whatever its phrasing", () => {
    // The invariant is that no output ever reads as "credential present but
    // rejected". A first token on the ABSENCE_VALUE safe-list keeps its clause,
    // so the common phrasings still read; anything else is redacted WHOLE.
    // Hidden is the accepted cost -- inverted is the bug.
    expect(scrubForWarning("SLACK_BOT_TOKEN: must be provided")).toBe("SLACK_BOT_TOKEN: must be provided");
    expect(scrubForWarning("Config error: GITHUB_TOKEN: Invalid input: expected string, received undefined")).toBe(
      "Config error: GITHUB_TOKEN: Invalid input: expected string, received undefined",
    );
    // Not on the safe-list, so the clause goes in full. The point is what does
    // NOT happen: no "<redacted> variable not found" tail asserting a value.
    expect(scrubForWarning("API_KEY: environment variable not found")).toBe("API_KEY: <redacted>");
    expect(scrubForWarning("api_key: value is empty")).toBe("api_key: <redacted>");
    // The property that actually matters, over every phrasing above.
    for (const line of [
      "SLACK_BOT_TOKEN: must be provided",
      "API_KEY: environment variable not found",
      "api_key: value is empty",
      "GITHUB_TOKEN: not set",
      "Config error: GITHUB_TOKEN: Invalid input: expected string, received undefined",
    ]) {
      expect(scrubForWarning(line)).not.toMatch(/<redacted>\s+\S/);
    }
  });

  it("cannot be used to smuggle a value past the scrubber", () => {
    // ABSENCE_VALUE is anchored, so prefixing a real value with "not" / "none"
    // does not satisfy it, and nothing about the value's SHAPE buys an
    // exemption any more -- length, alphabet and position are all irrelevant.
    expect(scrubForWarning("GITHUB_TOKEN=notasecret123")).toBe("GITHUB_TOKEN=<redacted>");
    expect(scrubForWarning("api_key=noneofyourbusiness42")).toBe("api_key=<redacted>");
    expect(scrubForWarning("api_key=correcthorsebatterystaple then 502")).toBe("api_key=<redacted> then 502");
    expect(scrubForWarning("token=hunter")).toBe("token=<redacted>");
    // Machine config formats put whitespace after the separator too, which is
    // what attempt 3 read as prose -- these all leaked at 7b72e4a.
    expect(scrubForWarning("api_key: abcdef")).toBe("api_key: <redacted>");
    expect(scrubForWarning("MYSQL_PASSWORD: swordfish")).toBe("MYSQL_PASSWORD: <redacted>");
    expect(scrubForWarning("X-Api-Key: abcdefghijkl")).toBe("X-Api-Key: <redacted>");
    expect(scrubForWarning("API_KEY = supersecret")).toBe("API_KEY = <redacted>");
    // The separator's whitespace comes out collapsed to one space: the scrubber
    // normalizes whitespace before the patterns run (see the newline-split
    // cases below), so a tab or a run of spaces is not preserved verbatim.
    expect(scrubForWarning("api_key:\tabcdef")).toBe("api_key: <redacted>");
    expect(scrubForWarning("token:   hunterxx")).toBe("token: <redacted>");
  });

  it("redacts a pair whose key and value are split by a newline", () => {
    // Rule 2's separator admits only spaces and tabs, so a value that sat on
    // the NEXT line escaped it -- and the whitespace collapse that used to run
    // AFTER the scrub then joined the two halves into a clear-text
    // "NAME: value" line in discover() output. The collapse now runs inside
    // scrubForWarning, before the patterns, so the export is safe on its own.
    expect(scrubForWarning("GITHUB_TOKEN:\nabc123def456")).toBe("GITHUB_TOKEN: <redacted>");
    expect(scrubForWarning("GITHUB_TOKEN:\r\n  abc123def456")).toBe("GITHUB_TOKEN: <redacted>");
    expect(scrubForWarning("GITHUB_TOKEN:\nabc123def456")).not.toContain("abc123def456");
  });

  it("redacts a pretty-printed JSON body, not just a compact one", () => {
    // server.ts stores result.content[0].text verbatim as lastErrorMessage, and
    // an upstream that echoes its request body pretty-printed puts the key,
    // the colon and the value on three separate lines.
    const body = '{\n  "token":\n    "abc123secret"\n}';
    expect(scrubForWarning(body)).toBe('{ "token": "<redacted>" }');
    expect(scrubForWarning(body)).not.toContain("abc123secret");
  });

  it("keeps a newline-split value out of BOTH warning lines", () => {
    // The two production paths into truncateForWarning: the per-call error
    // rate line (health.lastErrorMessage) and the activation-failure line
    // (upstream stderr tail). Both used to emit the value in the clear.
    const now = 1_000_000;
    const split = "GITHUB_TOKEN:\nabc123def456";
    const pretty = '{\n  "token":\n    "abc123secret"\n}';
    for (const msg of [split, pretty]) {
      const viaRate = formatHealthWarning(
        { totalCalls: 10, errorCount: 5, totalLatencyMs: 5, lastErrorMessage: msg },
        undefined,
      );
      expect(viaRate).toContain("5 of 10 calls failed");
      expect(viaRate).not.toContain("abc123");
      expect(viaRate).toContain("<redacted>");
      const viaActivation = formatHealthWarning(undefined, { at: now - 60_000, message: msg }, now);
      expect(viaActivation).toContain("last activation failed");
      expect(viaActivation).not.toContain("abc123");
      expect(viaActivation).toContain("<redacted>");
    }
    expect(
      formatHealthWarning({ totalCalls: 10, errorCount: 5, totalLatencyMs: 5, lastErrorMessage: split }, undefined),
    ).toBe("warn: 5 of 10 calls failed: GITHUB_TOKEN: <redacted>");
    expect(formatHealthWarning(undefined, { at: now - 60_000, message: pretty }, now)).toBe(
      'warn: last activation failed 1m ago: { "token": "<redacted>" }',
    );
  });

  it("leaves an ordinary diagnostic alone when a scheme word is just an English word", () => {
    // Rule 1's scheme list is mostly ordinary English (key, token, basic,
    // digest), and it used to take ANY 8+ letter word after one of them as the
    // credential: "API key required" -> "API <redacted>", which throws away the
    // one word the model can act on. The blob now has to LOOK like a
    // credential -- a digit, or 16+ chars -- which no English word after those
    // schemes does.
    for (const line of [
      "API key required",
      "api-key required",
      "basic authentication failed",
      "digest mismatch",
      "token authentication required",
      "invalid token supplied",
    ]) {
      expect(scrubForWarning(line)).toBe(line);
    }
    const w = formatHealthWarning(
      { totalCalls: 10, errorCount: 5, totalLatencyMs: 5, lastErrorMessage: "API key required" },
      undefined,
    );
    expect(w).toBe("warn: 5 of 10 calls failed: API key required");
  });

  it("drops the shape gate in header position: any blob after `Authorization: Basic` is a credential", () => {
    // The shape gate exists for PROSE ("basic authentication failed"). Right
    // after `Authorization:` the word after the scheme is a credential by
    // construction, so a short letters-only Basic blob -- which the gate let
    // through and HEAD redacted -- is redacted there regardless of shape,
    // while the same blob in prose stays the accepted miss.
    expect(scrubForWarning("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: <redacted>");
    expect(scrubForWarning("authorization:basic dXNlcjpwYXNz -- 401")).toBe("authorization:<redacted> -- 401");
    expect(scrubForWarning("401 invalid credentials for basic dXNlcjpwYXNz")).toBe(
      "401 invalid credentials for basic dXNlcjpwYXNz",
    );
  });

  it("still redacts a credential-shaped blob after a bare-word scheme", () => {
    // The shape gate must not reopen the scheme-word leak rule 1 exists for.
    expect(scrubForWarning("Authorization: Token abc123def456")).toBe("Authorization: <redacted>");
    expect(scrubForWarning("key abcdefghijklmnopqrstuvwx")).toBe("<redacted>");
    expect(scrubForWarning("token 12345678")).toBe("<redacted>");
    expect(scrubForWarning("Basic YWxhZGRpbjpvcGVuc2VzYW1l")).toBe("<redacted>");
    // bearer and hmac are scheme names, not prose, so they stay unanchored: a
    // short all-letter bearer token is still caught.
    expect(scrubForWarning("Bearer abcdefghij")).toBe("<redacted>");
    expect(scrubForWarning("HMAC abcdefghij")).toBe("<redacted>");
    // A short, letters-only Basic blob is below the shape gate, but in its
    // natural header position rule 2 still redacts the whole clause.
    expect(scrubForWarning("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: <redacted>");
  });

  it("redacts a quoted value in either quote style, body only", () => {
    // The old separator knew only the double quote, so a single-quoted value
    // never matched at all and leaked whole -- Python reprs, shell export,
    // single-quoted YAML. Quotes are explicit bounds: redact the body, keep
    // the quotes, and never spill into the neighbouring key.
    expect(scrubForWarning('{"token":"abcdef","x":1}')).toBe('{"token":"<redacted>","x":1}');
    expect(scrubForWarning("{'token': 'abc123secret'}")).toBe("{'token': '<redacted>'}");
    expect(scrubForWarning("export API_KEY='s3cr3t'")).toBe("export API_KEY='<redacted>'");
  });

  it("redacts every pair on a line, not just the first", () => {
    // remoteFailureDetail collapses an error to ONE line, so a tail that runs
    // past the next NAME= swallows it. Each pair has to stand on its own.
    expect(scrubForWarning("PASSWORD=letmein API_KEY=zzzzzzzzzz")).toBe("PASSWORD=<redacted> API_KEY=<redacted>");
    expect(scrubForWarning("PASSWORD=letmein API_KEY=zzzzzzzzzz HOME=/root")).toBe(
      "PASSWORD=<redacted> API_KEY=<redacted> HOME=/root",
    );
    expect(scrubForWarning("spawn failed: password=hunter, api_key=abcdef123456")).toBe(
      "spawn failed: password=<redacted>, api_key=<redacted>",
    );
    // A whole-clause redaction still stops at a dash-run, so the actionable
    // half of the message survives.
    expect(scrubForWarning("api_key: abcdef -- upstream returned 502")).toBe(
      "api_key: <redacted> -- upstream returned 502",
    );
  });

  it("names a non-bearer auth scheme instead of redacting the scheme word", () => {
    // Rule 1 knew only bearer/basic, so any other scheme fell through to rule
    // 2, which captured the SCHEME WORD as the value and left the token.
    expect(scrubForWarning("Authorization: Token abc123def456")).toBe("Authorization: <redacted>");
    expect(scrubForWarning("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9")).toBe("Authorization: <redacted>");
  });

  it("stays linear on a long collapsed line", () => {
    // The unbounded prefix group was O(n^2) against a hyphen-joined run: 784 ms
    // on 64 KB, and the message is stored, so it recurred on every discover().
    const kebab = `token=${"a-".repeat(32_000)}`;
    const pairs = "token=abc123 ".repeat(20_000);
    for (const input of [kebab, pairs]) {
      const t0 = performance.now();
      scrubForWarning(input);
      expect(performance.now() - t0, `${input.length} bytes`).toBeLessThan(2000);
    }
  });

  it("redacts a machine-written pair even when more text follows on the line", () => {
    // The gate discriminates on the SEPARATOR, not on whether text follows.
    // An earlier revision asked "does a letter appear later on this line?",
    // which exempted a value whenever ANYTHING word-shaped came after it -- a
    // second pair, a JSON sibling, a query parameter, even the <redacted>
    // marker rule 1 had just inserted. Each of these was left fully in the
    // clear by that revision, so they are the regression this pins.
    expect(scrubForWarning("password=hunter host=db")).toBe("password=<redacted> host=db");
    expect(scrubForWarning("?api_key=deadbeef&user=bob")).toBe("?api_key=<redacted>&user=bob");
    expect(scrubForWarning('{"token": "abcdef", "x":1}')).toBe('{"token": "<redacted>", "x":1}');
    // Two secrets on one line: BOTH go, not just the last.
    expect(scrubForWarning("PASSWORD=letmein API_KEY=zzzzzzzzzz")).toBe("PASSWORD=<redacted> API_KEY=<redacted>");
    // Worst case in production: remoteFailureDetail collapses an error to ONE
    // line, so under the old gate every pair but the last had a tail.
    expect(scrubForWarning("401: token=hunter Authorization: Bearer eyJhbGciOiJIUzI1NiJ9")).toBe(
      "401: token=<redacted> Authorization: <redacted>",
    );
  });

  it("never emits a PARTIAL redaction that leaves surviving words of the value", () => {
    // A partial redaction is the inversion itself -- the surviving tail reads
    // as if the credential were present. This has to be asserted on lines that
    // ARE redacted: a line the scrubber leaves untouched cannot exhibit it, so
    // asserting output === input on prose fixtures proves nothing here.
    for (const [input, expected] of [
      ["api_key=correcthorsebatterystaple then 502", "api_key=<redacted> then 502"],
      ["NOTION_API_KEY=abc123def456", "NOTION_API_KEY=<redacted>"],
      ["token=hunter", "token=<redacted>"],
      ["password=hunter host=db", "password=<redacted> host=db"],
    ]) {
      const out = scrubForWarning(input);
      expect(out).toBe(expected);
      // No surviving word butted up against the marker.
      expect(out).not.toMatch(/<redacted>[A-Za-z]/);
    }
  });

  it("still reports the absence-word case through the activation-failure line", () => {
    const now = 1_000_000;
    const w = formatHealthWarning(undefined, { at: now - 60_000, message: "Error: GITHUB_TOKEN: not set" }, now);
    expect(w).toBe("warn: last activation failed 1m ago: Error: GITHUB_TOKEN: not set");
  });

  it("scrubs BEFORE truncating, so the 120-char budget is spent on actionable text", () => {
    // The ordering inside truncateForWarning is load-bearing, and every other
    // credential fixture here is short enough that either order would pass.
    // Truncate-first spends the whole 117-char budget on the value and cuts the
    // actionable tail; scrub-first collapses the value to <redacted> first, so
    // "502 bad gateway" -- the part the model can act on -- survives the cap.
    const w = formatHealthWarning(
      {
        totalCalls: 10,
        errorCount: 5,
        totalLatencyMs: 5,
        lastErrorMessage: `api_key=${"S".repeat(200)} then 502 bad gateway`,
      },
      undefined,
    );
    expect(w).not.toContain("SSSSSSSSSS");
    expect(w).toContain("api_key=<redacted>");
    expect(w).toContain("502 bad gateway");
  });

  it("applies the 120-char cap to the SCRUBBED text, not the raw text", () => {
    // `token=x` (7 chars) expands to `token=<redacted>` (16), so a message that
    // fits under the cap raw exceeds it once redacted. The cut runs last, so
    // the emitted excerpt still honours the cap and ends in the ellipsis.
    const w = formatHealthWarning(
      { totalCalls: 10, errorCount: 5, totalLatencyMs: 5, lastErrorMessage: `${"y".repeat(110)} token=x` },
      undefined,
    );
    expect(w!.endsWith("...")).toBe(true);
    expect(w).not.toContain("token=x");
  });
});
