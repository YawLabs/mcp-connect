import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFoundryTrace, FOUNDRY_FILENAME, isFoundryEnabled, MAX_FOUNDRY_BYTES, redactIntent } from "../foundry.js";
import { userConfigDir } from "../paths.js";

// Passthrough spies over the two fs calls appendFoundryTrace makes, so a test
// can read the MODE it asked for. Asserting the bits on disk instead pins
// nothing on Windows (stat reports a synthetic 0o666) -- the only place this
// suite runs -- and on POSIX would only measure the runner's umask. The real
// fs still runs underneath, so every other case here behaves as before.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), appendFile: vi.fn(actual.appendFile) };
});

describe("isFoundryEnabled", () => {
  const orig = process.env.YAW_MCP_FOUNDRY;

  afterEach(() => {
    if (orig === undefined) delete process.env.YAW_MCP_FOUNDRY;
    else process.env.YAW_MCP_FOUNDRY = orig;
  });

  it("is disabled by default (unset)", () => {
    delete process.env.YAW_MCP_FOUNDRY;
    expect(isFoundryEnabled()).toBe(false);
  });

  it('is enabled when "1"', () => {
    process.env.YAW_MCP_FOUNDRY = "1";
    expect(isFoundryEnabled()).toBe(true);
  });

  it('is enabled when "true" (case-insensitive, trimmed)', () => {
    process.env.YAW_MCP_FOUNDRY = " TRUE ";
    expect(isFoundryEnabled()).toBe(true);
  });

  it('is disabled for "0" / "false" / garbage', () => {
    for (const v of ["0", "false", "yes", "on", "nope"]) {
      process.env.YAW_MCP_FOUNDRY = v;
      expect(isFoundryEnabled()).toBe(false);
    }
  });
});

describe("redactIntent", () => {
  it("drops a sk_live_...-style secret token but keeps normal words", () => {
    // Two layers can catch this now: the raw-string prefix scrub eats
    // `sk_...` whole before tokenize sees it, and even if it did not, the
    // long mixed letter+digit run left behind trips the entropy rule. Either
    // way no fragment of the key material reaches the bag.
    const r = redactIntent("please use sk_live4242aaaa9999bbbb8888cccc to authenticate");
    expect(r.tokens).toContain("please");
    expect(r.tokens).toContain("use");
    expect(r.tokens).toContain("authenticate");
    // The long mixed alphanumeric run must be gone.
    expect(r.tokens.some((t) => t.includes("4242aaaa9999bbbb"))).toBe(false);
    expect(r.redactedCount).toBeGreaterThanOrEqual(1);
  });

  it("drops a known secret prefix token (xox)", () => {
    // xox has no underscore in the prefix, so the Slack-token run survives
    // tokenize as one piece and is dropped by the prefix rule.
    const r = redactIntent("token xoxbabcdef0123456789 here");
    expect(r.tokens).toContain("token");
    expect(r.tokens).toContain("here");
    expect(r.tokens.some((t) => t.startsWith("xox"))).toBe(false);
    expect(r.redactedCount).toBe(1);
  });

  it("drops a long pure-hex token (>= 16 chars)", () => {
    const r = redactIntent("commit deadbeefcafef00d1234 and move on");
    expect(r.tokens).toContain("commit");
    expect(r.tokens).toContain("and");
    expect(r.tokens).toContain("move");
    expect(r.tokens).not.toContain("deadbeefcafef00d1234");
    expect(r.redactedCount).toBe(1);
  });

  it("keeps ordinary words (sorted, order destroyed) and reports redactedCount 0", () => {
    const r = redactIntent("create a github pull request for the docs");
    // Tokens are SORTED so word order can't reconstruct the sentence.
    expect(r.tokens).toEqual(["create", "docs", "for", "github", "pull", "request", "the"]);
    expect(r.redactedCount).toBe(0);
  });

  it("drops a long pure-alpha passphrase-style secret", () => {
    const r = redactIntent("login with correcthorsebatterystaple please");
    expect(r.tokens).not.toContain("correcthorsebatterystaple");
    expect(r.tokens).toContain("login");
    expect(r.tokens).toContain("with");
    expect(r.tokens).toContain("please");
    expect(r.redactedCount).toBe(1);
  });

  it("drops a 12-19 char mixed letter+digit key (below the old 20 floor)", () => {
    const r = redactIntent("key a1b2c3d4e5f6g7 here");
    expect(r.tokens).not.toContain("a1b2c3d4e5f6g7");
    expect(r.tokens).toContain("key");
    expect(r.tokens).toContain("here");
    expect(r.redactedCount).toBe(1);
  });

  it("counts every dropped token", () => {
    // AKIA-prefixed (AWS key id) + a long pure-hex digest both drop; the
    // ordinary words survive.
    const r = redactIntent("AKIAIOSFODNN7EXAMPLE and deadbeefcafef00d0011 plus normalword");
    expect(r.redactedCount).toBe(2);
    expect(r.tokens).toContain("and");
    expect(r.tokens).toContain("plus");
    expect(r.tokens).toContain("normalword");
  });

  it("strips punctuated secret prefixes on the RAW intent, before tokenize splits them", () => {
    // REGRESSION: every SECRET_PREFIXES entry containing '_' or '-' was dead
    // code. looksSensitive only ever sees tokenize() output, which is always a
    // bare [a-z0-9]+ run, so `token.startsWith("ghp_")` could never be true.
    // These now match on the raw string, where the punctuation still exists.
    for (const secret of [
      "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
      "gho_16C7e42F292c6912E7710c838347Ae178B4a",
      "sk-proj-AbCd1234EfGh5678",
      "sk_test_51H8xTestKeyMaterial",
      "tok_1JKlmNOpQrStUvWx",
      "pk_live_ZZTopKeyMaterial",
    ]) {
      const r = redactIntent(`deploy with ${secret} now`);
      expect(r.tokens).toEqual(["deploy", "now", "with"]);
      expect(r.redactedCount).toBe(1);
    }
  });

  it("does not scrub an ordinary hyphenated word that merely contains a prefix", () => {
    // The `(?<![A-Za-z0-9])` boundary keeps the raw pattern off the "sk-" in
    // "task-list"; only a prefix at a real token boundary counts.
    const r = redactIntent("update the task-list and risk-report");
    expect(r.redactedCount).toBe(0);
    expect(r.tokens).toEqual(expect.arrayContaining(["task", "list", "risk", "report"]));
  });

  it("strips an email address before tokenize and increments redactedCount", () => {
    // The RAW_PII_RULES email regex fires on the raw string before tokenize()
    // shreds it. The whole address is replaced with a space, so "user",
    // "example", and "com" never reach the token bag.
    const r = redactIntent("send email to user@example.com");
    expect(r.redactedCount).toBe(1);
    expect(r.tokens).not.toContain("user");
    expect(r.tokens).not.toContain("example");
    expect(r.tokens).not.toContain("com");
    // Ordinary words from the rest of the intent survive.
    expect(r.tokens).toContain("send");
    expect(r.tokens).toContain("email");
  });

  it("keeps ordinary tech tokens the loose phone / ticket shapes used to swallow", () => {
    // REGRESSION: the phone shape (`\+?[0-9][0-9\s().-]{8,}`) and the ticket
    // shape (`[A-Z]+-\d+`) matched dates, IP literals, dotted versions and
    // standards names, so a routing corpus lost exactly the vocabulary it
    // exists to score. Each of these must survive with redactedCount 0.
    const r = redactIntent("on 2024-01-15 ping 192.168.1.100 with 1.2.3.4.5 using UTF-8 GPT-4 SHA-256");
    expect(r.redactedCount).toBe(0);
    expect(r.tokens).toEqual(expect.arrayContaining(["2024", "192", "168", "100", "utf", "gpt", "sha", "256"]));
  });

  it("still redacts a real phone number and a real ticket ref", () => {
    // The other side of the gate above: 9+ actual digits is a phone, and a
    // multi-digit suffix on a non-standards prefix is a ticket key.
    const phone = redactIntent("call +1 (555) 123-4567 today");
    expect(phone.redactedCount).toBe(1);
    expect(phone.tokens).toEqual(["call", "today"]);

    const ticket = redactIntent("fix PROJ-1234 before the demo");
    expect(ticket.redactedCount).toBe(1);
    expect(ticket.tokens).not.toContain("proj");
    expect(ticket.tokens).toContain("demo");
  });

  it("redacts a DOT-separated phone number without re-swallowing dotted IPs and versions", () => {
    // The IPv4/version exclusion is written as "three or more dots" but the
    // regex quantifier said {2,}, so a 2-dot 10-digit run -- the ordinary
    // 555.123.4567 phone format -- matched the exclusion and was persisted
    // verbatim into the harvest. Digit count alone does not save it: at 10
    // digits it clears the 9+ phone floor, so the exclusion was the only
    // thing deciding, and it decided wrong.
    const phone = redactIntent("call me at 555.123.4567 tomorrow");
    expect(phone.redactedCount).toBe(1);
    // Assert on the DIGIT GROUPS, not the joined literal: tokenize splits on
    // the dots, so no implementation can ever emit "555.123.4567" as a token
    // and asserting its absence proves nothing. These are what the pre-fix
    // code actually persisted.
    expect(phone.tokens).toEqual(["call", "tomorrow"]);

    // The shapes the exclusion exists for must still survive it. tokenize()
    // splits on the dots, so the surviving evidence is the digit groups plus
    // a redactedCount of 0 -- same shape the sibling case above asserts.
    const kept = redactIntent("ping 192.168.1.100 running 1.2.3.4.5");
    expect(kept.redactedCount).toBe(0);
    expect(kept.tokens).toEqual(expect.arrayContaining(["192", "168", "100"]));
  });

  it("keeps TWO whitespace-adjacent IP literals, which arrive as one phone-shape match", () => {
    // Whitespace is inside the nominating character class, so the pair is ONE
    // match -- and the exclusion, anchored on the whole match, recognized
    // neither literal. Their digits also sum past the 9-digit phone floor
    // that a single IP never reaches, so nothing else caught it: two IPs in a
    // row were redacted while one was kept.
    const r = redactIntent("route 192.168.1.100 10.0.0.1 both ways");
    expect(r.redactedCount).toBe(0);
    expect(r.tokens).toEqual(expect.arrayContaining(["192", "168", "100", "10"]));
  });

  it("applies the same 2-digit floor to #N that the ticket rule applies to PROJ-N", () => {
    // "#1" is a priority marker or a list index, not an issue ref, and the
    // sibling rule already keeps "PROJ-1" for exactly that reason. The two
    // rules disagreeing about one digit cost the corpus ordinary vocabulary.
    const kept = redactIntent("bump the docs task to priority #1");
    expect(kept.redactedCount).toBe(0);
    expect(kept.tokens).toEqual(expect.arrayContaining(["priority", "1"]));

    // A real issue ref still goes.
    const dropped = redactIntent("close issue #1234 after the release");
    expect(dropped.redactedCount).toBe(1);
    expect(dropped.tokens).not.toContain("1234");
    expect(dropped.tokens).toContain("issue");
  });

  it("keeps short identifiers (pg, gh, s3) -- harvest tokenizes at the ranker's 1-char floor", () => {
    // Harvesting with the 3-char prose tokenizer deleted every short
    // identifier from the corpus, so rankServers (which tokenizes queries at
    // the 1-char floor) could never be scored on the very tokens that matter.
    const r = redactIntent("use pg and gh to check the s3 bucket");
    expect(r.tokens).toEqual(expect.arrayContaining(["pg", "gh", "s3"]));
    // Closed-class sub-floor words still stay out of the bag.
    expect(r.tokens).not.toContain("to");
  });
});

describe("appendFoundryTrace", () => {
  let home: string;
  const orig = process.env.YAW_MCP_FOUNDRY;

  const trace = {
    tokens: ["create", "issue"],
    chosen: "gh",
    redactedCount: 1,
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-foundry-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (orig === undefined) delete process.env.YAW_MCP_FOUNDRY;
    else process.env.YAW_MCP_FOUNDRY = orig;
  });

  it("is a no-op when disabled (no file written)", async () => {
    delete process.env.YAW_MCP_FOUNDRY;
    await expect(appendFoundryTrace(trace, home)).resolves.toBeUndefined();
    // Path derived from the SOURCE (userConfigDir + FOUNDRY_FILENAME) and
    // asserted ABSENT. A hardcoded ".yaw-mcp" plus a throwing read passes for
    // the wrong reason the moment the config dirname moves: the read throws
    // at a path nothing would ever have written to either.
    expect(existsSync(join(userConfigDir(home), FOUNDRY_FILENAME))).toBe(false);
  });

  it("writes one JSON line when enabled, with no raw intent", async () => {
    process.env.YAW_MCP_FOUNDRY = "1";
    await appendFoundryTrace(trace, home);
    const file = join(userConfigDir(home), FOUNDRY_FILENAME);
    const contents = readFileSync(file, "utf8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    // The candidate shortlist is accepted from the caller but NOT persisted:
    // nothing ever read it back, and it only ate into the 5 MiB cap. The
    // written line is the redacted bag plus the routing decision, nothing else.
    expect(parsed).toEqual({
      tokens: trace.tokens,
      chosen: trace.chosen,
      redactedCount: trace.redactedCount,
    });
    expect(contents).not.toContain("gitlab");
  });

  it("appends additional lines on repeat calls", async () => {
    process.env.YAW_MCP_FOUNDRY = "1";
    await appendFoundryTrace(trace, home);
    await appendFoundryTrace(trace, home);
    const file = join(userConfigDir(home), FOUNDRY_FILENAME);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("creates the harvest owner-only: 0o700 on the dir it makes, 0o600 on the file", async () => {
    // Names, company names and ticket text survive redaction (see the file
    // header), so on a multi-user host a harvest born at the umask default
    // handed every token bag to any local user. The MODE handed to fs is the
    // decision under test; whether the OS honours it is the OS's business.
    process.env.YAW_MCP_FOUNDRY = "1";
    await appendFoundryTrace(trace, home);
    const dir = userConfigDir(home);
    const file = join(dir, FOUNDRY_FILENAME);
    const mk = vi.mocked(mkdir).mock.calls.find((c) => c[0] === dir);
    expect(mk, "mkdir was never asked for the harvest dir").toBeDefined();
    expect(mk?.[1]).toEqual({ recursive: true, mode: 0o700 });
    const ap = vi.mocked(appendFile).mock.calls.find((c) => c[0] === file);
    expect(ap, "appendFile was never asked for the harvest file").toBeDefined();
    expect(ap?.[2]).toEqual({ encoding: "utf8", mode: 0o600 });
    // And the line still landed through the passthrough.
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("never throws even when the home path is invalid", async () => {
    process.env.YAW_MCP_FOUNDRY = "1";
    // A path with a NUL byte cannot be created; the helper must swallow it.
    await expect(appendFoundryTrace(trace, "\0bad")).resolves.toBeUndefined();
  });

  it("does not append when foundry.jsonl is already at the 5 MiB cap", async () => {
    process.env.YAW_MCP_FOUNDRY = "1";
    const dir = userConfigDir(home);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, FOUNDRY_FILENAME);
    // Grow the file to exactly MAX_FOUNDRY_BYTES with truncate (sparse on most
    // filesystems) instead of allocating and writing 5 MiB of real bytes, and
    // measure with stat so the cap's worth of content is never pulled into the
    // heap. The cap is IMPORTED, not re-declared: a local copy meant lowering
    // MAX_FOUNDRY_BYTES in the source left this test staging a file at the old
    // size and passing vacuously.
    writeFileSync(file, "");
    truncateSync(file, MAX_FOUNDRY_BYTES);
    expect(statSync(file).size).toBe(MAX_FOUNDRY_BYTES);
    await appendFoundryTrace(trace, home);
    expect(statSync(file).size).toBe(MAX_FOUNDRY_BYTES);
  });
});
