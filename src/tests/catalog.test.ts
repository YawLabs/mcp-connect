import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_SLUG_RE,
  CATALOG_STALE_AFTER_DAYS,
  type CatalogServer,
  DEFAULT_CATALOG_URL,
  defaultFetchCatalog,
  FETCH_TIMEOUT_MS,
  type FetchCatalog,
  resolveCatalogSlug,
  tokenizeCommand,
} from "../catalog.js";

// The one slug gate `add` and `try` share. Each verb used to carry a private
// copy of this regex; the exit-2 behaviour at each gate is pinned in the
// verbs' own suites, this pins the SHAPE so a drift shows up here first.
describe("CATALOG_SLUG_RE", () => {
  it("accepts lowercase letters, digits and dashes with a leading alphanumeric, up to 64 chars", () => {
    for (const slug of ["fetch", "brave-search", "a", "0", "a1-b2", "a".repeat(64)]) {
      expect(CATALOG_SLUG_RE.test(slug), slug).toBe(true);
    }
  });

  it("rejects an empty, uppercase, leading-dash, underscore, whitespace or over-long slug", () => {
    for (const slug of ["", "Fetch", "-leading", "under_score", "has space", "dot.slug", "a".repeat(65)]) {
      expect(CATALOG_SLUG_RE.test(slug), JSON.stringify(slug)).toBe(false);
    }
  });
});

describe("tokenizeCommand", () => {
  it("parses a simple command with no quotes", () => {
    expect(tokenizeCommand("npx -y server")).toEqual(["npx", "-y", "server"]);
  });

  it("handles single-quoted args", () => {
    expect(tokenizeCommand("cmd 'hello world'")).toEqual(["cmd", "hello world"]);
  });

  it("handles double-quoted args", () => {
    expect(tokenizeCommand('cmd "hello world"')).toEqual(["cmd", "hello world"]);
  });

  it("throws on unterminated single quote", () => {
    expect(() => tokenizeCommand("cmd 'hello")).toThrow("Unbalanced quote");
  });

  it("throws on unterminated double quote", () => {
    expect(() => tokenizeCommand('cmd "hello')).toThrow("Unbalanced quote");
  });

  it("trims leading and trailing whitespace between tokens", () => {
    expect(tokenizeCommand("  npx   -y   server  ")).toEqual(["npx", "-y", "server"]);
  });
});

describe("resolveCatalogSlug", () => {
  const makeFetch =
    (servers: CatalogServer[]): FetchCatalog =>
    async () =>
      servers;

  it("returns the matching resolved server for a known slug", async () => {
    const servers: CatalogServer[] = [
      {
        slug: "my-server",
        name: "My Server",
        install: { command: "npx -y my-server" },
        requiredEnv: [{ key: "MY_API_KEY", label: "API key" }],
        repo: "https://github.com/example/my-server",
      },
    ];
    const result = await resolveCatalogSlug("my-server", { fetchCatalog: makeFetch(servers) });
    expect(result.slug).toBe("my-server");
    expect(result.name).toBe("My Server");
    expect(result.command).toBe("npx");
    expect(result.args).toEqual(["-y", "my-server"]);
    expect(result.requiredEnvKeys).toEqual(["MY_API_KEY"]);
  });

  it("throws for an unknown slug", async () => {
    const servers: CatalogServer[] = [{ slug: "existing-server", install: { command: "npx existing-server" } }];
    await expect(resolveCatalogSlug("no-such-slug", { fetchCatalog: makeFetch(servers) })).rejects.toThrow(
      'no server with slug "no-such-slug"',
    );
  });

  // The catalog publishes an A-F grade per server, and until it was carried
  // through here nothing did: `add` wrote no grade, validateEntry dropped one
  // if hand-written, and grades.json (which only `yaw-mcp audit` writes) was
  // the sole supplier -- so on a fresh install every server was ungraded, and
  // ungraded always passes, which left YAW_MCP_MIN_COMPLIANCE gating nothing.
  it("carries an A-F compliance grade through to the resolved server", async () => {
    for (const grade of ["A", "B", "C", "D", "F"]) {
      const servers: CatalogServer[] = [{ slug: "g", install: { command: "npx -y g" }, complianceGrade: grade }];
      const result = await resolveCatalogSlug("g", { fetchCatalog: makeFetch(servers) });
      expect(result.complianceGrade, grade).toBe(grade);
    }
  });

  it("normalizes case, since the grades cache uppercases and the two must rank alike", async () => {
    const servers: CatalogServer[] = [{ slug: "g", install: { command: "npx -y g" }, complianceGrade: " b " }];
    const result = await resolveCatalogSlug("g", { fetchCatalog: makeFetch(servers) });
    expect(result.complianceGrade).toBe("B");
  });

  it("drops a grade that is not A-F rather than copying it into the user's file", async () => {
    // Stricter here than compliance.ts's classifyGrade on purpose. An
    // unrecognized letter in the user's OWN bundles.json is worth surfacing as
    // possible tampering, so validateEntry passes those through. This value
    // arrives over the network and is about to be written INTO that file, so
    // anything unexpected is catalog corruption -- copying it in would
    // manufacture the very tamper signal the other path exists to report.
    for (const bad of ["ZZZ", "A+", "", "   ", "1", 4, null, {}]) {
      const servers: CatalogServer[] = [
        { slug: "g", install: { command: "npx -y g" }, complianceGrade: bad as unknown as string },
      ];
      const result = await resolveCatalogSlug("g", { fetchCatalog: makeFetch(servers) });
      expect(result.complianceGrade, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("leaves the grade undefined when the catalog entry has none", async () => {
    const servers: CatalogServer[] = [{ slug: "g", install: { command: "npx -y g" } }];
    const result = await resolveCatalogSlug("g", { fetchCatalog: makeFetch(servers) });
    expect(result.complianceGrade).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Remote-server refusal. A remote/HTTP entry has no stdio spawn command, so
  // tokenizing its URL would write a broken bundles.json entry that fails at
  // spawn time with a far less obvious error. Mirrors the app's resolveSlug.
  // -------------------------------------------------------------------------

  it.each([
    ["install.url set", { url: "https://mcp.example.com/sse" }],
    ["install.type remote", { type: "remote", command: "npx -y ignored" }],
    ["runtime remote", { runtime: "remote", command: "npx -y ignored" }],
    ["runtime http", { runtime: "http", command: "npx -y ignored" }],
    ["runtime https", { runtime: "HTTPS", command: "npx -y ignored" }],
    ["runtime sse", { runtime: "sse", command: "npx -y ignored" }],
    ["runtime url", { runtime: "url", command: "npx -y ignored" }],
  ])("refuses a remote server (%s)", async (_label, install) => {
    const servers: CatalogServer[] = [{ slug: "remote-one", install }];
    await expect(resolveCatalogSlug("remote-one", { fetchCatalog: makeFetch(servers) })).rejects.toThrow(
      /is a remote \(HTTP\) server.*bundles\.json/,
    );
  });

  it("does not treat a runtime that merely contains 'http' as remote", async () => {
    // The refusal regex is anchored, so `httpie`-style runtimes stay local.
    const servers: CatalogServer[] = [{ slug: "local-one", install: { runtime: "httpie", command: "npx -y local" } }];
    const result = await resolveCatalogSlug("local-one", { fetchCatalog: makeFetch(servers) });
    expect(result.command).toBe("npx");
  });

  // -------------------------------------------------------------------------
  // Missing / empty install command.
  // -------------------------------------------------------------------------

  it.each([
    ["no install block at all", undefined],
    ["install with no command", {}],
    ["empty command string", { command: "" }],
    ["whitespace-only command", { command: "   \t  " }],
    ["non-string command", { command: 42 as unknown as string }],
  ])("throws when the entry has no usable install command (%s)", async (_label, install) => {
    const servers: CatalogServer[] = [{ slug: "broken", install }];
    await expect(resolveCatalogSlug("broken", { fetchCatalog: makeFetch(servers) })).rejects.toThrow(
      'catalog entry "broken" has no install command.',
    );
  });

  it("propagates an unbalanced-quote tokenize failure rather than swallowing it", async () => {
    const servers: CatalogServer[] = [{ slug: "quoted", install: { command: `npx -y "unterminated` } }];
    await expect(resolveCatalogSlug("quoted", { fetchCatalog: makeFetch(servers) })).rejects.toThrow(
      "Unbalanced quote",
    );
  });

  // -------------------------------------------------------------------------
  // requiredEnv key filtering. Only well-formed shell identifiers survive:
  // the keys go on to be written into a config and exported into a spawned
  // process env, so a key with a dash / leading digit / whitespace is dropped
  // rather than propagated into a launch that would fail opaquely.
  // -------------------------------------------------------------------------

  it("keeps only valid env identifiers and drops malformed requiredEnv entries", async () => {
    const servers: CatalogServer[] = [
      {
        slug: "envy",
        install: { command: "npx envy" },
        requiredEnv: [
          { key: "GOOD_KEY" },
          { key: "_LEADING_UNDERSCORE" },
          { key: "Mixed9Case" },
          { key: "HAS-DASH" },
          { key: "1LEADING_DIGIT" },
          { key: "HAS SPACE" },
          { key: "" },
          { key: 5 as unknown as string },
          {} as never,
          null as never,
          "GOOD_KEY_BUT_A_STRING" as never,
        ],
      },
    ];
    const result = await resolveCatalogSlug("envy", { fetchCatalog: makeFetch(servers) });
    expect(result.requiredEnvKeys).toEqual(["GOOD_KEY", "_LEADING_UNDERSCORE", "Mixed9Case"]);
  });

  it("returns an empty requiredEnvKeys list when requiredEnv is absent or not an array", async () => {
    const servers: CatalogServer[] = [
      { slug: "none", install: { command: "npx none" } },
      { slug: "bogus", install: { command: "npx bogus" }, requiredEnv: "NOT_AN_ARRAY" as never },
    ];
    const fetchCatalog = makeFetch(servers);
    expect((await resolveCatalogSlug("none", { fetchCatalog })).requiredEnvKeys).toEqual([]);
    expect((await resolveCatalogSlug("bogus", { fetchCatalog })).requiredEnvKeys).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Name / source fallbacks.
  // -------------------------------------------------------------------------

  it("falls back to the slug when name is missing or blank, and to homepage when repo is absent", async () => {
    const servers: CatalogServer[] = [
      { slug: "no-name", install: { command: "npx x" }, homepage: "https://example.com/home" },
      { slug: "blank-name", name: "   ", install: { command: "npx x" } },
    ];
    const fetchCatalog = makeFetch(servers);
    const noName = await resolveCatalogSlug("no-name", { fetchCatalog });
    expect(noName.name).toBe("no-name");
    expect(noName.source).toBe("https://example.com/home");
    expect(noName.docUrl).toBe("https://example.com/home");
    expect((await resolveCatalogSlug("blank-name", { fetchCatalog })).name).toBe("blank-name");
  });

  it("passes the catalog URL through to the injected fetcher", async () => {
    const fetchCatalog = vi.fn<FetchCatalog>().mockResolvedValue([{ slug: "s", install: { command: "npx s" } }]);
    await resolveCatalogSlug("s", { fetchCatalog, catalogUrl: "https://mirror.example/catalog.json" });
    expect(fetchCatalog).toHaveBeenCalledWith("https://mirror.example/catalog.json");
    await resolveCatalogSlug("s", { fetchCatalog });
    expect(fetchCatalog).toHaveBeenLastCalledWith(DEFAULT_CATALOG_URL);
  });

  // A SET-BUT-EMPTY override is the YAW_MCP_CATALOG_URL="" shape (a CI
  // variable declared with no value, a bare `export`), and "" is not nullish
  // -- so the `??` fallbacks in `add` / `try` handed it straight through to
  // fetch(""). That throws a bare TypeError, and the message-based rethrow
  // gate defaultFetchCatalog used to carry (`err.message.includes(url)`) was
  // trivially true for the empty string, so even the friendly wrapper was
  // skipped.
  it("treats a set-but-empty (or whitespace-only) catalogUrl as unset", async () => {
    const fetchCatalog = vi.fn<FetchCatalog>().mockResolvedValue([{ slug: "s", install: { command: "npx s" } }]);
    await resolveCatalogSlug("s", { fetchCatalog, catalogUrl: "" });
    expect(fetchCatalog).toHaveBeenLastCalledWith(DEFAULT_CATALOG_URL);
    await resolveCatalogSlug("s", { fetchCatalog, catalogUrl: "   " });
    expect(fetchCatalog).toHaveBeenLastCalledWith(DEFAULT_CATALOG_URL);
  });
});

describe("defaultFetchCatalog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(impl: (...args: unknown[]) => unknown): ReturnType<typeof vi.fn> {
    const f = vi.fn(impl);
    vi.stubGlobal("fetch", f);
    return f;
  }

  it("returns the servers array and requests JSON from the default URL", async () => {
    const f = stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ servers: [{ slug: "a" }, { slug: "b", name: "B" }] }),
    }));
    const servers = await defaultFetchCatalog();
    expect(servers.map((s) => s.slug)).toEqual(["a", "b"]);
    const [url, init] = f.mock.calls[0] as [string, { headers: Record<string, string>; signal: AbortSignal }];
    expect(url).toBe(DEFAULT_CATALOG_URL);
    expect(init.headers.accept).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // Same empty-is-unset rule at the fetch boundary: the `url` parameter has a
  // default, but a DEFAULT only fills in for undefined -- an explicit "" would
  // otherwise be fetched.
  it("fetches the default catalog when handed an empty URL", async () => {
    const f = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ servers: [{ slug: "a" }] }) }));
    const servers = await defaultFetchCatalog("");
    expect(servers.map((s) => s.slug)).toEqual(["a"]);
    expect((f.mock.calls[0] as [string])[0]).toBe(DEFAULT_CATALOG_URL);
  });

  it("drops entries that are not objects or carry no string slug", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ servers: [{ slug: "keep" }, null, "nope", 7, { name: "no slug" }, { slug: 12 }] }),
    }));
    expect((await defaultFetchCatalog()).map((s) => s.slug)).toEqual(["keep"]);
  });

  it("throws a friendly error on a non-2xx response", async () => {
    stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(defaultFetchCatalog("https://cat.example/c.json")).rejects.toThrow(
      "the Yaw MCP catalog at https://cat.example/c.json returned HTTP 503.",
    );
  });

  it.each([
    ["a bare array", []],
    ["an object with no servers key", { data: [] }],
    ["servers as a non-array", { servers: { a: 1 } }],
    ["null", null],
  ])("throws a shape error when the payload is %s", async (_label, payload) => {
    stubFetch(async () => ({ ok: true, status: 200, json: async () => payload }));
    await expect(defaultFetchCatalog("https://cat.example/c.json")).rejects.toThrow(
      "the Yaw MCP catalog at https://cat.example/c.json was not in the expected shape.",
    );
  });

  it("names the catalog and the URL when a 200 body is not JSON", async () => {
    // Captive portal / corporate proxy: HTTP 200 with an HTML login page.
    // The raw SyntaxError names neither the catalog nor the URL, so `yaw-mcp
    // add fetch` used to print `Unexpected token '<' ...` with no hint that
    // the CATALOG FETCH was what failed.
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`);
      },
    }));
    await expect(defaultFetchCatalog("https://cat.example/c.json")).rejects.toThrow(
      /the Yaw MCP catalog at https:\/\/cat\.example\/c\.json did not return valid JSON \(Unexpected token/,
    );
  });

  it("names the catalog, the URL and the cause when the fetch itself cannot connect", async () => {
    // The most common failure this function has -- offline, DNS, connection
    // refused, TLS, a proxy that drops the connection -- and the one mode the
    // wrapping above did not cover. undici reports every one as a bare
    // `TypeError: fetch failed` with the real reason on `cause`, so `yaw-mcp
    // add fetch` on a laptop with no network printed exactly
    // "yaw-mcp add: fetch failed": no URL, no catalog, no next step.
    const transport = new TypeError("fetch failed");
    (transport as Error & { cause?: unknown }).cause = new Error("connect ECONNREFUSED 127.0.0.1:9");
    stubFetch(async () => {
      throw transport;
    });
    await expect(defaultFetchCatalog("https://cat.example/c.json")).rejects.toThrow(
      /could not reach the Yaw MCP catalog at https:\/\/cat\.example\/c\.json \(connect ECONNREFUSED/,
    );
  });

  it("does not re-wrap an error it already prefixed", async () => {
    // The transport branch is discriminated by the marker class the module's
    // own throws carry, so an HTTP-status failure must pass through untouched
    // rather than coming back as "could not reach ... (the Yaw MCP catalog
    // at ... returned HTTP 500.)".
    stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(defaultFetchCatalog("https://cat.example/c.json")).rejects.toThrow(
      /^the Yaw MCP catalog at https:\/\/cat\.example\/c\.json returned HTTP 500\.$/,
    );
  });

  it("still reports an abort DURING the body read as a timeout, not a parse failure", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      },
    }));
    await expect(defaultFetchCatalog("https://cat.example/c.json")).rejects.toThrow(
      "timed out fetching the Yaw MCP catalog at https://cat.example/c.json.",
    );
  });

  it("reports an abort as a timeout, not as a raw AbortError", async () => {
    stubFetch(async () => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    await expect(defaultFetchCatalog("https://cat.example/c.json")).rejects.toThrow(
      "timed out fetching the Yaw MCP catalog at https://cat.example/c.json.",
    );
  });

  it("aborts the request once FETCH_TIMEOUT_MS elapses", async () => {
    vi.useFakeTimers();
    try {
      let captured: AbortSignal | undefined;
      stubFetch(
        (_url: unknown, init: unknown) =>
          new Promise((_resolve, reject) => {
            captured = (init as { signal: AbortSignal }).signal;
            captured.addEventListener("abort", () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
      const p = defaultFetchCatalog("https://cat.example/c.json");
      const assertion = expect(p).rejects.toThrow("timed out fetching");
      // Derived from the constant, not a literal: a change to the timeout
      // used to leave this clock silently out of step with it.
      await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
      await assertion;
      expect(captured?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("wraps a causeless transport failure, still naming the catalog and the URL", async () => {
    // undici usually hangs the real reason on `cause`; when it doesn't, the
    // bare message is all there is to report -- but the WRAPPER still has to
    // be there. Asserting only "fetch failed" passed whether the error came
    // back wrapped or raw, so it could not fail for the thing it is about.
    stubFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(defaultFetchCatalog()).rejects.toThrow(
      `could not reach the Yaw MCP catalog at ${DEFAULT_CATALOG_URL} (fetch failed). Check your network, then retry.`,
    );
  });

  it("wraps fetch's OWN url-parse failure, even though its message names the url", async () => {
    // A malformed YAW_MCP_CATALOG_URL (scheme-less, a typo'd protocol) never
    // reaches the network: fetch rejects with `TypeError: Failed to parse URL
    // from <url>`. That message CONTAINS the url, so the old message-based
    // rethrow gate (`err.message.includes(url)`) read it as an error this
    // module had already worded and handed it straight back -- no "could not
    // reach the Yaw MCP catalog" prefix and no cause detail, for a failure the
    // user's own config caused. A marker class cannot mistake it that way.
    stubFetch(async () => {
      throw new TypeError("Failed to parse URL from cat.example/c.json");
    });
    await expect(defaultFetchCatalog("cat.example/c.json")).rejects.toThrow(
      "could not reach the Yaw MCP catalog at cat.example/c.json (Failed to parse URL from cat.example/c.json).",
    );
  });

  it("wraps a non-Error rejection in an Error", async () => {
    stubFetch(async () => {
      throw "string rejection";
    });
    await expect(defaultFetchCatalog()).rejects.toThrow("string rejection");
  });

  // generated_at staleness note -- the parser used to read only body.servers
  // and drop the one field that distinguishes a frozen catalog from a fresh
  // one, so `add`/`try` handed out an old snapshot's install lines forever
  // with nothing anywhere able to say the source went stale.
  describe("generated_at staleness note", () => {
    const GENERATED = "2026-01-01T00:00:00.000Z";
    const DAY_MS = 86_400_000;

    function stubCatalog(extra: Record<string, unknown>): void {
      stubFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ servers: [{ slug: "a" }], ...extra }),
      }));
    }

    it("warns at EXACTLY CATALOG_STALE_AFTER_DAYS, naming the date and the age", async () => {
      // The mark itself, not a day past it. The comparison is `ageDays <
      // CATALOG_STALE_AFTER_DAYS`, so N days old is the first age that warns
      // -- and a `<=` typo silences exactly that age and nothing else, which
      // an assertion a day late cannot see.
      stubCatalog({ generated_at: GENERATED });
      const warned: string[] = [];
      const now = () => Date.parse(GENERATED) + CATALOG_STALE_AFTER_DAYS * DAY_MS;
      const servers = await defaultFetchCatalog(DEFAULT_CATALOG_URL, { warn: (l) => warned.push(l), now });
      // The note is advisory: the servers still resolve.
      expect(servers.map((s) => s.slug)).toEqual(["a"]);
      expect(warned).toEqual([
        `yaw-mcp: note: the Yaw MCP catalog was generated 2026-01-01 (${CATALOG_STALE_AFTER_DAYS} days ago); its entries may be out of date.`,
      ]);
    });

    it("stays silent one millisecond below the mark", async () => {
      // The other side of the same boundary: a tick short of N days floors to
      // N-1 and must stay quiet. With the two together the comparison is
      // pinned in both directions rather than only somewhere near it.
      stubCatalog({ generated_at: GENERATED });
      const warned: string[] = [];
      const now = () => Date.parse(GENERATED) + CATALOG_STALE_AFTER_DAYS * DAY_MS - 1;
      await defaultFetchCatalog(DEFAULT_CATALOG_URL, { warn: (l) => warned.push(l), now });
      expect(warned).toEqual([]);
    });

    it("stays silent below the floor", async () => {
      stubCatalog({ generated_at: GENERATED });
      const warned: string[] = [];
      const now = () => Date.parse(GENERATED) + (CATALOG_STALE_AFTER_DAYS - 1) * DAY_MS;
      await defaultFetchCatalog(DEFAULT_CATALOG_URL, { warn: (l) => warned.push(l), now });
      expect(warned).toEqual([]);
    });

    it.each([
      ["missing", {}],
      ["not a string", { generated_at: 1735689600000 }],
      ["unparsable", { generated_at: "not-a-date" }],
      // Clock skew is not staleness -- a future stamp must not warn (or wrap
      // into a huge negative age).
      ["in the future", { generated_at: "2999-01-01T00:00:00.000Z" }],
    ])("stays silent when generated_at is %s", async (_label, extra) => {
      stubCatalog(extra as Record<string, unknown>);
      const warned: string[] = [];
      const servers = await defaultFetchCatalog(DEFAULT_CATALOG_URL, { warn: (l) => warned.push(l) });
      expect(servers.map((s) => s.slug)).toEqual(["a"]);
      expect(warned).toEqual([]);
    });

    it("defaults the sink to process.stderr so machine-read stdout stays clean", async () => {
      stubCatalog({ generated_at: GENERATED });
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const now = () => Date.parse(GENERATED) + (CATALOG_STALE_AFTER_DAYS + 5) * DAY_MS;
        await defaultFetchCatalog(DEFAULT_CATALOG_URL, { now });
        const written = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
        expect(written).toContain("the Yaw MCP catalog was generated 2026-01-01");
        expect(written.endsWith("\n")).toBe(true);
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});
