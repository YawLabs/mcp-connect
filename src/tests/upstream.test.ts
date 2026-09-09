import { EventEmitter } from "node:events";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActivationError,
  clearSessionVaultPassphrase,
  connectToUpstream,
  type DownstreamClientBridge,
  disconnectFromUpstream,
  fetchPromptsFromUpstream,
  fetchResourcesFromUpstream,
  fetchToolsFromUpstream,
  MAX_LIST_PAGES,
  MAX_PROMPTS_PER_SERVER,
  MAX_RESOURCES_PER_SERVER,
  MAX_TIMEOUT_MS,
  MAX_TOOLS_PER_SERVER,
  resetOamDowngrades,
  resolveTimeoutEnv,
  scrubInternalSecretsFromProcessEnv,
  setSessionVaultPassphrase,
  stripInternalSecretsFromEnv,
  VaultPassphraseRequiredError,
  vaultPassphrase,
  verifyVaultPassphrase,
} from "../upstream.js";

// ---------------------------------------------------------------------------
// Module-level mocks -- hoisted before imports by vitest
// ---------------------------------------------------------------------------

// Mock secrets-vault so resolveServerEnv tests never touch the filesystem.
vi.mock("../secrets-vault.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets-vault.js")>();
  return {
    hasSecretRefs: vi.fn(),
    loadVault: vi.fn(),
    resolveSecretRefs: vi.fn(),
    unlock: vi.fn(),
    vaultPath: vi.fn().mockReturnValue("/tmp/fake-vault.json"),
    // Real values, re-exported from the module itself rather than hand-copied.
    // The spawn audit scans the env with collectSecretRefNames (secrets-vault's
    // single source of truth for the `${secret:NAME}` shape, built on
    // SECRET_REF_RE), and resolveServerEnv / verifyVaultPassphrase both compare
    // an unlock failure's message against VAULT_CHECK_CORRUPT_ERROR to tell
    // "the vault is damaged, the passphrase is fine" from "wrong passphrase".
    // Stubs would make those branches indistinguishable -- and a literal COPY
    // of any of them would silently go stale the day secrets-vault changes the
    // ref charset or the corrupt-check wording, leaving these suites green
    // against a value the shipped code no longer uses.
    collectSecretRefNames: actual.collectSecretRefNames,
    SECRET_REF_RE: actual.SECRET_REF_RE,
    VAULT_CHECK_CORRUPT_ERROR: actual.VAULT_CHECK_CORRUPT_ERROR,
  };
});

// Mock the audit appender: the real one writes to ~/.yaw-mcp/secrets-audit.log,
// and resolveServerEnv records events on BOTH the success and the missing-refs
// path -- unit tests must not touch the developer's (or CI's) home dir.
vi.mock("../secrets-audit.js", () => ({
  appendAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

// Stub logger to silence output in tests that don't test logging,
// but still write warn-level entries to stderr so the existing
// truncation tests (which capture process.stderr.write) keep working.
vi.mock("../logger.js", () => ({
  log: vi.fn((level: string, msg: string, data?: unknown) => {
    if (level === "warn") {
      process.stderr.write(`${JSON.stringify({ level, msg, ...(data ?? {}) })}\n`);
    }
  }),
}));

// Stub uv-bootstrap -- we never want real UV resolution in unit tests.
vi.mock("../uv-bootstrap.js", () => ({
  resolveUvSpawn: vi.fn().mockImplementation((cmd: string, args: string[]) => Promise.resolve({ command: cmd, args })),
}));

// ---------------------------------------------------------------------------
// MCP SDK mocks
// ---------------------------------------------------------------------------
// vi.mock factories are hoisted to the top of the file by vitest, which means
// they run BEFORE module-level variable initialisers. To work around this,
// we use an indirection object whose properties are mutated by test code
// after the module loads. The factory closes over the object reference, which
// is stable across the hoist boundary.

const _sdkBehavior = {
  clientConnect: (): Promise<void> => Promise.reject(new Error("connect not configured")),
  clientClose: (): Promise<void> => Promise.resolve(),
  // listResources/listPrompts route through these hooks so a test can override
  // one to fire client.onclose mid-fetch (the closedBeforeReady path). Both
  // default to the empty-inventory shape the connect-flow tests rely on; the
  // MockClient instance is passed so an override can reach its onclose handler.
  clientListResources: (_client: any): Promise<any> => Promise.resolve({ resources: [] }),
  clientListPrompts: (_client: any): Promise<any> => Promise.resolve({ prompts: [] }),
  // listTools routes through the same indirection so the list-changed chain
  // tests can hand out deferred promises per call and control resolution
  // order. Default is the empty-inventory shape every other suite relies on.
  clientListTools: (_client: any): Promise<any> => Promise.resolve({ tools: [] }),
  // Every (schema, handler) pair passed to client.setNotificationHandler, in
  // registration order -- the list-changed chain tests invoke the captured
  // handler directly rather than driving a real transport.
  notificationHandlers: [] as Array<{ schema: unknown; handler: (notification: any) => unknown }>,
  // Every (schema, handler) pair passed to client.setRequestHandler, in
  // registration order -- the capability-bridge tests invoke the captured
  // handler directly to drive an upstream-originated request.
  requestHandlers: [] as Array<{ schema: unknown; handler: (request: any, extra: any) => unknown }>,
  // The `{ capabilities }` options each Client was constructed with, in
  // order -- lets the bridge tests assert what the upstream handshake would
  // declare.
  clientConstructions: [] as Array<{ capabilities: Record<string, unknown> }>,
  // Remote transport constructions (SSE vs streamable HTTP), in order.
  // `opts` is captured as well as the url because a remote server's ONLY
  // credential channel is `requestInit.headers` -- asserting the transport was
  // selected says nothing about whether the token reached it.
  remoteConstructions: [] as Array<{
    kind: "sse" | "http";
    url: string;
    opts?: { requestInit?: { headers?: Record<string, string> } };
  }>,
  stderrEmitter: null as EventEmitter | null,
  // The {command,args,env} the stdio transport was last constructed with --
  // lets a test assert what actually gets spawned (e.g. the oam-rewritten cmd).
  lastStdioArgs: null as { command: string; args: string[]; env?: Record<string, string> } | null,
  // EVERY stdio construction, in order -- the boot-probe fallback respawns,
  // so a single "last" slot can't show the oam -> node downgrade sequence.
  stdioConstructions: [] as Array<{ command: string; args: string[]; env?: Record<string, string> }>,
};

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  function MockClient(_info: unknown, options?: { capabilities?: Record<string, unknown> }) {
    _sdkBehavior.clientConstructions.push({ capabilities: options?.capabilities ?? {} });
    const client: any = {
      connect: () => _sdkBehavior.clientConnect(),
      close: () => _sdkBehavior.clientClose(),
      // listTools succeeds with an empty set so tests can drive the connect
      // flow to a SUCCESSFUL completion (the boot-probe fallback tests need
      // the second attempt to come up healthy).
      listTools: () => _sdkBehavior.clientListTools(client),
      // listResources/listPrompts go through _sdkBehavior so a test can make
      // one fire client.onclose before resolving (closedBeforeReady path).
      // The captured `client` is the same object connectToUpstream assigns
      // onclose to, so the override can reach the live handler.
      listResources: () => _sdkBehavior.clientListResources(client),
      listPrompts: () => _sdkBehavior.clientListPrompts(client),
      onclose: undefined as (() => void) | undefined,
      setNotificationHandler: (schema: unknown, handler: (notification: any) => unknown) => {
        _sdkBehavior.notificationHandlers.push({ schema, handler });
      },
      setRequestHandler: (schema: unknown, handler: (request: any, extra: any) => unknown) => {
        _sdkBehavior.requestHandlers.push({ schema, handler });
      },
    };
    return client;
  }
  return { Client: MockClient };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  function MockStdioClientTransport(opts: { command: string; args: string[]; env?: Record<string, string> }) {
    _sdkBehavior.lastStdioArgs = opts;
    _sdkBehavior.stdioConstructions.push(opts);
    const emitter = new EventEmitter();
    _sdkBehavior.stderrEmitter = emitter;
    return { stderr: emitter };
  }
  return { StdioClientTransport: MockStdioClientTransport };
});

// resolveOamSpawn is the spawn-rewrite chokepoint (upstream.ts gates it on
// the effective runtime being "oam"). Mock it so the WIRING -- "does the
// runtime gate actually reach + apply the rewrite?" -- is tested
// independently of an installed oam. probeOam feeds the oamVersion field of
// the connect/downgrade log lines; a fixed probe keeps that deterministic.
// Spread the REAL module and override only the two spawn/probe entry points.
// A bare factory listing just those two silently breaks every test in this file
// the moment upstream.ts imports one more thing from oam-spawn -- vitest throws
// "No <name> export is defined on the mock" from inside connectToUpstream, so
// the failure surfaces as "err is not an ActivationError" in unrelated redaction
// tests rather than as a missing mock. Keeping the pure helpers real also means
// the OOM-hint branch below is exercised against the shipped wording.
vi.mock("../oam-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../oam-spawn.js")>();
  return {
    ...actual,
    resolveOamSpawn: vi.fn((command: string, args: string[]) => ({ command, args })),
    // belowMin:false paired with a version AT the floor. upstream.ts reads only
    // belowMin, so any version would pass -- but a fixture that contradicts
    // MIN_OAM_VERSION reads as a bug to whoever bumps the floor next.
    probeOam: vi.fn(() => ({ bin: "/usr/bin/oam", version: actual.MIN_OAM_VERSION, belowMin: false })),
  };
});

// Config-level default runtime (feature knob) -- mocked so connectToUpstream
// never reads the developer machine's real ~/.yaw-mcp/bundles.json, and so
// tests can flip the default per-case.
vi.mock("../default-runtime.js", () => ({
  defaultRuntime: vi.fn().mockResolvedValue(null),
}));

// Remote transports -- not needed for env/redact tests but must not throw.
// Each construction is recorded so the remote-config tests can assert WHICH
// transport the `transport: "sse"` switch selected.
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: function MockSSE(url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) {
    _sdkBehavior.remoteConstructions.push({ kind: "sse", url: String(url), opts });
    return {};
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: function MockHTTP(
    url: URL,
    opts?: { requestInit?: { headers?: Record<string, string> } },
  ) {
    _sdkBehavior.remoteConstructions.push({ kind: "http", url: String(url), opts });
    return {};
  },
}));

// Import the mocked modules so the wiring tests can configure/assert them.
import { defaultRuntime } from "../default-runtime.js";
import { log } from "../logger.js";
import { MIN_OAM_VERSION, resolveOamSpawn } from "../oam-spawn.js";
import { appendAuditEvent } from "../secrets-audit.js";
// Import the mocked secrets-vault module so individual tests can configure it.
import { hasSecretRefs, loadVault, resolveSecretRefs, unlock, VAULT_CHECK_CORRUPT_ERROR } from "../secrets-vault.js";
// Mocked uv resolver -- a test makes it THROW to exercise the resolver-failure
// wrap (a checksum/download failure inside ensureUv reaches connectToUpstream
// this way).
import { resolveUvSpawn } from "../uv-bootstrap.js";

// Minimal stand-in for the MCP SDK Client — only the listTools/listResources/
// listPrompts methods we call. `as any` covers the type shape mismatch.
function makeClient(overrides: Record<string, any>): any {
  return overrides;
}

// Capture stderr so we can assert the warn log fires on truncation.
function captureStderr(): { restore: () => void; writes: string[] } {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  return {
    writes,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

describe("fetchToolsFromUpstream size cap", () => {
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
  });

  it("returns all tools when under the cap", async () => {
    const tools = Array.from({ length: 5 }, (_, i) => ({
      name: `t${i}`,
      inputSchema: { type: "object" },
    }));
    const client = makeClient({ listTools: vi.fn().mockResolvedValue({ tools }) });

    const out = await fetchToolsFromUpstream(client, "ns");
    expect(out).toHaveLength(5);
    expect(stderr.writes.some((w) => w.includes("truncating"))).toBe(false);
  });

  it("truncates to the cap and logs a warning when over", async () => {
    const reported = MAX_TOOLS_PER_SERVER + 25;
    const tools = Array.from({ length: reported }, (_, i) => ({
      name: `t${i}`,
      inputSchema: { type: "object" },
    }));
    const client = makeClient({ listTools: vi.fn().mockResolvedValue({ tools }) });

    const out = await fetchToolsFromUpstream(client, "ns");
    expect(out).toHaveLength(MAX_TOOLS_PER_SERVER);
    // First tool preserved, last one is index MAX-1 (the tail is dropped).
    expect(out[0].name).toBe("t0");
    expect(out[MAX_TOOLS_PER_SERVER - 1].name).toBe(`t${MAX_TOOLS_PER_SERVER - 1}`);
    // Derived from the cap, not a literal: moving MAX_TOOLS_PER_SERVER must
    // not break this test for a reason unrelated to truncation.
    expect(stderr.writes.some((w) => w.includes("truncating") && w.includes(`"reported":${reported}`))).toBe(true);
  });
});

describe("fetchResourcesFromUpstream size cap", () => {
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
  });

  it("truncates to the cap and logs a warning when over", async () => {
    const resources = Array.from({ length: MAX_RESOURCES_PER_SERVER + 10 }, (_, i) => ({
      uri: `file:///r${i}`,
      name: `r${i}`,
    }));
    const client = makeClient({ listResources: vi.fn().mockResolvedValue({ resources }) });

    const out = await fetchResourcesFromUpstream(client, "ns");
    expect(out).toHaveLength(MAX_RESOURCES_PER_SERVER);
    expect(stderr.writes.some((w) => w.includes("truncating"))).toBe(true);
  });

  it("swallows listResources errors (server may not support them)", async () => {
    const client = makeClient({ listResources: vi.fn().mockRejectedValue(new Error("not supported")) });
    const out = await fetchResourcesFromUpstream(client, "ns");
    expect(out).toEqual([]);
  });
});

describe("fetchPromptsFromUpstream size cap", () => {
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
  });

  it("truncates to the cap and logs a warning when over", async () => {
    const prompts = Array.from({ length: MAX_PROMPTS_PER_SERVER + 7 }, (_, i) => ({
      name: `p${i}`,
    }));
    const client = makeClient({ listPrompts: vi.fn().mockResolvedValue({ prompts }) });

    const out = await fetchPromptsFromUpstream(client, "ns");
    expect(out).toHaveLength(MAX_PROMPTS_PER_SERVER);
    expect(stderr.writes.some((w) => w.includes("truncating"))).toBe(true);
  });

  it("swallows listPrompts errors (server may not support them)", async () => {
    const client = makeClient({ listPrompts: vi.fn().mockRejectedValue(new Error("not supported")) });
    const out = await fetchPromptsFromUpstream(client, "ns");
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// stripInternalSecretsFromEnv -- the child-env secret strip. Case-INSENSITIVE
// on purpose: Windows env lookups are case-insensitive, so process.env reads
// a `yaw_mcp_vault_passphrase=` set in PowerShell/Git Bash just fine, and a
// byte-exact strip would hand that passphrase to every spawned upstream.
// ---------------------------------------------------------------------------

describe("stripInternalSecretsFromEnv", () => {
  it("strips the internal secret keys and keeps everything else", () => {
    const out = stripInternalSecretsFromEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      YAW_MCP_TOKEN: "tok",
      YAW_MCP_VAULT_PASSPHRASE: "hunter2",
      YAW_MCP_VAULT_PASSPHRASE_NEW: "hunter3",
    });
    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
  });

  it("strips case-variant twins (Windows env lookups are case-insensitive)", () => {
    const out = stripInternalSecretsFromEnv({
      yaw_mcp_vault_passphrase: "hunter2",
      Yaw_Mcp_Token: "tok",
      yaw_mcp_vault_passphrase_new: "hunter3",
      HOME: "/home/u",
    });
    expect(out).toEqual({ HOME: "/home/u" });
  });

  it("keeps unrelated YAW_MCP_* keys (only the secret trio is internal)", () => {
    const out = stripInternalSecretsFromEnv({
      YAW_MCP_PRUNE_RESPONSES: "0",
      YAW_MCP_TOKEN_TTL: "60",
    });
    expect(out).toEqual({ YAW_MCP_PRUNE_RESPONSES: "0", YAW_MCP_TOKEN_TTL: "60" });
  });
});

// ---------------------------------------------------------------------------
// scrubInternalSecretsFromProcessEnv -- the in-place sibling, for the one-shot
// CLI paths that hand `process.env` itself to a third party that spawns with it
// (`yaw-mcp audit` -> @yawlabs/mcp-compliance). Its uppercase path is covered
// by audit-cmd.test.ts; the case-insensitive twin -- the whole reason the match
// runs through toUpperCase -- had no coverage anywhere.
// ---------------------------------------------------------------------------

describe("scrubInternalSecretsFromProcessEnv", () => {
  afterEach(() => {
    delete process.env.yaw_mcp_vault_passphrase;
    delete process.env.Yaw_Mcp_Token;
    delete process.env.YAW_MCP_SCRUB_KEEPER;
  });

  it("deletes case-variant twins in place and leaves everything else alone", () => {
    process.env.yaw_mcp_vault_passphrase = "hunter2";
    process.env.Yaw_Mcp_Token = "tok";
    process.env.YAW_MCP_SCRUB_KEEPER = "keep-me";

    scrubInternalSecretsFromProcessEnv();

    expect(process.env.yaw_mcp_vault_passphrase).toBeUndefined();
    expect(process.env.Yaw_Mcp_Token).toBeUndefined();
    // Only the internal trio goes -- a neighbouring YAW_MCP_* key survives.
    expect(process.env.YAW_MCP_SCRUB_KEEPER).toBe("keep-me");
  });
});

// ---------------------------------------------------------------------------
// nextCursor pagination -- the MCP spec defines cursors for all three list
// endpoints; a paginating upstream must not have pages past the first
// silently dropped.
// ---------------------------------------------------------------------------

describe("list pagination (nextCursor)", () => {
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
  });

  it("fetchResourcesFromUpstream follows nextCursor across pages", async () => {
    const listResources = vi
      .fn()
      .mockResolvedValueOnce({ resources: [{ uri: "file:///a" }, { uri: "file:///b" }], nextCursor: "c1" })
      .mockResolvedValueOnce({ resources: [{ uri: "file:///c" }], nextCursor: "c2" })
      .mockResolvedValueOnce({ resources: [{ uri: "file:///d" }] });
    const client = makeClient({ listResources });

    const out = await fetchResourcesFromUpstream(client, "ns");
    expect(out.map((r) => r.uri)).toEqual(["file:///a", "file:///b", "file:///c", "file:///d"]);
    expect(listResources).toHaveBeenCalledTimes(3);
    expect(listResources.mock.calls[0][0]).toEqual({});
    expect(listResources.mock.calls[1][0]).toEqual({ cursor: "c1" });
    expect(listResources.mock.calls[2][0]).toEqual({ cursor: "c2" });
    // The per-page request options are the ONLY thing bounding a server that
    // completes connect and then hangs on inventory, so pin them: LIST_TIMEOUT
    // is module-private, hence the shape rather than the exact value.
    expect(listResources.mock.calls[0][1]).toEqual({ timeout: expect.any(Number) });
  });

  it("resolves the per-page bound from MCP_LIST_TIMEOUT, falling back on junk and on out-of-range", async () => {
    // LIST_TIMEOUT is read once at module load, so each case needs a fresh
    // module rather than a plain stubEnv. All three inventory calls share the
    // constant, so all three are asserted -- the shape-only assertions above
    // would pass on any number, including the broken one.
    //
    // The "3e9" and "30s" rows are the ones Number.parseInt's PREFIX parsing
    // let through as 3 and 30: a millisecond-scale bound that times out every
    // inventory call instantly, which is how activation dies on tools/list.
    // The "3000000000" row is the out-of-range one, and the default is the
    // right answer rather than MAX_TIMEOUT_MS -- clamping there would hand the
    // SDK an effectively infinite bound (~24.8 days) instead of the instant
    // failure, which is not an improvement. The last two rows pin the edges of
    // the accepted range, and the leading/trailing space is the cmd.exe
    // `set VAR= && ...` shape.
    try {
      for (const [env, expected] of [
        ["5000", 5000],
        [" 5000 ", 5000],
        ["nonsense", 15_000],
        ["0", 15_000],
        ["3e9", 15_000],
        ["30s", 15_000],
        ["3000000000", 15_000],
        ["2147483647", 2_147_483_647],
        ["2147483648", 15_000],
      ] as const) {
        vi.stubEnv("MCP_LIST_TIMEOUT", env);
        vi.resetModules();
        const fresh = await import("../upstream.js");
        const client = makeClient({
          listResources: vi.fn().mockResolvedValue({ resources: [] }),
          listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
          listTools: vi.fn().mockResolvedValue({ tools: [] }),
        });
        await fresh.fetchResourcesFromUpstream(client, "ns");
        await fresh.fetchPromptsFromUpstream(client, "ns");
        await fresh.fetchToolsFromUpstream(client, "ns");
        for (const fn of [client.listResources, client.listPrompts, client.listTools]) {
          expect(fn.mock.calls[0][1], `MCP_LIST_TIMEOUT=${env}`).toEqual({ timeout: expected });
        }
      }
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("fetchPromptsFromUpstream follows nextCursor across pages", async () => {
    const listPrompts = vi
      .fn()
      .mockResolvedValueOnce({ prompts: [{ name: "p0" }], nextCursor: "c1" })
      .mockResolvedValueOnce({ prompts: [{ name: "p1" }] });
    const client = makeClient({ listPrompts });

    const out = await fetchPromptsFromUpstream(client, "ns");
    expect(out.map((p) => p.name)).toEqual(["p0", "p1"]);
    expect(listPrompts.mock.calls[1][0]).toEqual({ cursor: "c1" });
    // Every page carries its own bound -- see the resources test above.
    expect(listPrompts.mock.calls[0][1]).toEqual({ timeout: expect.any(Number) });
  });

  it("fetchToolsFromUpstream follows nextCursor across pages", async () => {
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({ tools: [{ name: "t0", inputSchema: { type: "object" } }], nextCursor: "c1" })
      .mockResolvedValueOnce({ tools: [{ name: "t1", inputSchema: { type: "object" } }] });
    const client = makeClient({ listTools });

    const out = await fetchToolsFromUpstream(client, "ns");
    expect(out.map((t) => t.name)).toEqual(["t0", "t1"]);
    expect(listTools.mock.calls[1][0]).toEqual({ cursor: "c1" });
    // Every page carries its own bound -- see the resources test above.
    expect(listTools.mock.calls[0][1]).toEqual({ timeout: expect.any(Number) });
  });

  it("a failure on a later page still surfaces as ActivationError (tools)", async () => {
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({ tools: [{ name: "t0", inputSchema: { type: "object" } }], nextCursor: "c1" })
      .mockRejectedValueOnce(new Error("boom on page 2"));
    const client = makeClient({ listTools });

    await expect(fetchToolsFromUpstream(client, "ns")).rejects.toThrow(ActivationError);
  });

  it("terminates at the page cap against a server that hands out a cursor forever", async () => {
    // 1 item per page, always a nextCursor: each page carries its own
    // LIST_TIMEOUT, so the page cap (MAX_LIST_PAGES, far below the item
    // cap) has to stop the loop -- bounding pages by the item cap would
    // let a slow dribble hold activation for 1000 sequential requests.
    // Every page hands back a DISTINCT cursor: a server that echoes the one it
    // was just sent is stopped earlier by the repeat guard (own test below),
    // which would otherwise mask the page cap this test is here to pin.
    let n = 0;
    const listResources = vi.fn().mockImplementation(() => {
      n += 1;
      return Promise.resolve({ resources: [{ uri: `file:///r${n}` }], nextCursor: `c${n}` });
    });
    const client = makeClient({ listResources });

    const out = await fetchResourcesFromUpstream(client, "ns");
    expect(out).toHaveLength(MAX_LIST_PAGES);
    expect(listResources).toHaveBeenCalledTimes(MAX_LIST_PAGES);
    expect(stderr.writes.some((w) => w.includes("exceeded page cap"))).toBe(true);
  });

  it("terminates at the page cap on the tools path too", async () => {
    let n = 0;
    const listTools = vi.fn().mockImplementation(() => {
      n += 1;
      return Promise.resolve({ tools: [{ name: `t${n}`, inputSchema: { type: "object" } }], nextCursor: `c${n}` });
    });
    const client = makeClient({ listTools });

    const out = await fetchToolsFromUpstream(client, "ns");
    expect(out).toHaveLength(MAX_LIST_PAGES);
    expect(listTools).toHaveBeenCalledTimes(MAX_LIST_PAGES);
    expect(stderr.writes.some((w) => w.includes("exceeded page cap"))).toBe(true);
  });

  it("stops when the server echoes back the cursor it was just sent", async () => {
    // The same cursor every time means the next request re-fetches the page
    // just read: every further round trip is a duplicate, and MAX_LIST_PAGES
    // of them would concatenate one page into the inventory 50 times over.
    const listResources = vi
      .fn()
      .mockImplementation(() => Promise.resolve({ resources: [{ uri: "file:///same" }], nextCursor: "again" }));
    const client = makeClient({ listResources });

    const out = await fetchResourcesFromUpstream(client, "ns");
    // Page 1 sent no cursor, so the repeat is only visible on page 2.
    expect(out).toHaveLength(2);
    expect(listResources).toHaveBeenCalledTimes(2);
    expect(stderr.writes.some((w) => w.includes("repeated its pagination cursor"))).toBe(true);
  });

  it("treats an EMPTY nextCursor as the end, not as a cursor to send back", async () => {
    // `nextCursor: ""` is the other arm of the same guard: re-requesting with
    // an empty cursor is either the first page again or a protocol error, so
    // neither answer is worth another LIST_TIMEOUT-bounded round trip.
    const listPrompts = vi
      .fn()
      .mockResolvedValueOnce({ prompts: [{ name: "p0" }], nextCursor: "" })
      .mockResolvedValueOnce({ prompts: [{ name: "never" }] });
    const client = makeClient({ listPrompts });

    const out = await fetchPromptsFromUpstream(client, "ns");
    expect(out.map((p) => p.name)).toEqual(["p0"]);
    expect(listPrompts).toHaveBeenCalledTimes(1);
    expect(stderr.writes.some((w) => w.includes("repeated its pagination cursor"))).toBe(true);
  });

  it("breaks out of an empty-page dribble (zero items but a cursor)", async () => {
    const listResources = vi
      .fn()
      .mockResolvedValueOnce({ resources: [{ uri: "file:///a" }], nextCursor: "c1" })
      .mockResolvedValueOnce({ resources: [], nextCursor: "c2" })
      .mockResolvedValueOnce({ resources: [{ uri: "file:///never" }] });
    const client = makeClient({ listResources });

    const out = await fetchResourcesFromUpstream(client, "ns");
    // The empty cursor'd page ends the loop; the third page is never fetched.
    expect(out.map((r) => r.uri)).toEqual(["file:///a"]);
    expect(listResources).toHaveBeenCalledTimes(2);
    expect(stderr.writes.some((w) => w.includes("empty page"))).toBe(true);
  });

  it("an empty final page WITHOUT a cursor is a normal end, not a warning", async () => {
    const listPrompts = vi
      .fn()
      .mockResolvedValueOnce({ prompts: [{ name: "p0" }], nextCursor: "c1" })
      .mockResolvedValueOnce({ prompts: [] });
    const client = makeClient({ listPrompts });

    const out = await fetchPromptsFromUpstream(client, "ns");
    expect(out.map((p) => p.name)).toEqual(["p0"]);
    expect(listPrompts).toHaveBeenCalledTimes(2);
    expect(stderr.writes.some((w) => w.includes("empty page") || w.includes("page cap"))).toBe(false);
  });

  it("stops one page past the cap and truncates with a warning", async () => {
    const page1 = Array.from({ length: MAX_RESOURCES_PER_SERVER }, (_, i) => ({ uri: `file:///r${i}` }));
    const listResources = vi
      .fn()
      .mockResolvedValueOnce({ resources: page1, nextCursor: "c1" })
      .mockResolvedValueOnce({ resources: [{ uri: "file:///extra" }], nextCursor: "c2" });
    const client = makeClient({ listResources });

    const out = await fetchResourcesFromUpstream(client, "ns");
    expect(out).toHaveLength(MAX_RESOURCES_PER_SERVER);
    // The overshoot page proved there was more than the cap; no third fetch.
    expect(listResources).toHaveBeenCalledTimes(2);
    expect(stderr.writes.some((w) => w.includes("truncating"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shared timeout env parser
// ---------------------------------------------------------------------------

// One parser backs all three operator-facing timeout knobs -- MCP_CONNECT_TIMEOUT
// and MCP_LIST_TIMEOUT here, MCP_CALL_TIMEOUT in proxy.ts. It is shared because
// the previous round hardened ONE site and left the other two prefix-parsing;
// the per-site tests pin the wiring, these pin the contract.
describe("resolveTimeoutEnv", () => {
  beforeEach(() => {
    vi.mocked(log).mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a whole-number millisecond value inside the range, trimmed", () => {
    for (const [raw, expected] of [
      ["5000", 5000],
      ["  5000  ", 5000],
      ["1", 1],
      [String(MAX_TIMEOUT_MS), MAX_TIMEOUT_MS],
    ] as const) {
      vi.stubEnv("MCP_CONNECT_TIMEOUT", raw);
      expect(resolveTimeoutEnv("MCP_CONNECT_TIMEOUT", 15_000), raw).toBe(expected);
    }
    expect(vi.mocked(log)).not.toHaveBeenCalled();
  });

  it("takes the default silently when the var is unset or empty once trimmed", () => {
    // cmd.exe's `set VAR= && ...` idiom leaves a whitespace-only value behind,
    // which reads as "unset" -- warning about it would be noise on a shape the
    // other resolvers in this repo already document.
    expect(resolveTimeoutEnv("YAW_MCP_TIMEOUT_FIXTURE_UNSET", 15_000)).toBe(15_000);
    for (const raw of ["", " "]) {
      vi.stubEnv("MCP_CONNECT_TIMEOUT", raw);
      expect(resolveTimeoutEnv("MCP_CONNECT_TIMEOUT", 15_000), JSON.stringify(raw)).toBe(15_000);
    }
    expect(vi.mocked(log)).not.toHaveBeenCalled();
  });

  it("rejects a prefix-parseable value instead of taking the prefix", () => {
    // The defect the clamp did not close: Number.parseInt("3e9", 10) is 3,
    // "30s" is 30, "1_000" is 1. Each is a millisecond-scale ceiling produced
    // by a value that reads generous, so every call on that leg fails instantly
    // -- and a timeout is not branded a routing fault, so server.ts books each
    // one against the upstream's health and error rate.
    for (const raw of ["3e9", "30s", "1_000", "0x10", "5.5", "-1", "nonsense", "0"]) {
      vi.stubEnv("MCP_CALL_TIMEOUT", raw);
      expect(resolveTimeoutEnv("MCP_CALL_TIMEOUT", 60_000), raw).toBe(60_000);
    }
  });

  it("rejects an out-of-range value instead of clamping it to MAX_TIMEOUT_MS", () => {
    // Clamping is strictly worse than the overflow it replaced: an overflowed
    // delay at least SETTLES after ~1ms, so the inflightCalls marker gets
    // cleared. MAX_TIMEOUT_MS pends for ~24.8 days with no AbortSignal, which
    // leaves the namespace neither deactivatable nor idle-reapable.
    for (const raw of [String(MAX_TIMEOUT_MS + 1), "3000000000", "999999999999999999999"]) {
      vi.stubEnv("MCP_LIST_TIMEOUT", raw);
      expect(resolveTimeoutEnv("MCP_LIST_TIMEOUT", 15_000), raw).toBe(15_000);
    }
  });

  it("warns on a rejected value, naming it, the ceiling, and the default in effect", () => {
    // Neither the pre- nor the post-clamp code gave the operator any signal
    // that the knob they set was being ignored.
    vi.stubEnv("MCP_CALL_TIMEOUT", "3e9");
    expect(resolveTimeoutEnv("MCP_CALL_TIMEOUT", 60_000)).toBe(60_000);
    expect(vi.mocked(log)).toHaveBeenCalledTimes(1);
    const [level, msg, data] = vi.mocked(log).mock.calls[0];
    expect(level).toBe("warn");
    expect(msg).toContain("MCP_CALL_TIMEOUT");
    expect(msg).toContain(String(MAX_TIMEOUT_MS));
    expect(data).toEqual({ value: "3e9", maxMs: MAX_TIMEOUT_MS, usingMs: 60_000 });
  });
});

// ---------------------------------------------------------------------------
// Tool metadata forwarding + task-required withholding
// ---------------------------------------------------------------------------

describe("fetchToolsFromUpstream metadata and task-required tools", () => {
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
  });

  it("forwards title, outputSchema and _meta; withholds taskSupport=required tools", async () => {
    const tools = [
      {
        name: "plain",
        title: "Plain Tool",
        inputSchema: { type: "object" },
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        _meta: { "example.com/flag": true },
      },
      { name: "tasky", inputSchema: { type: "object" }, execution: { taskSupport: "required" } },
      { name: "opt", inputSchema: { type: "object" }, execution: { taskSupport: "optional" } },
    ];
    const client = makeClient({ listTools: vi.fn().mockResolvedValue({ tools }) });

    const out = await fetchToolsFromUpstream(client, "ns");
    // "tasky" can never succeed through the proxy (the SDK client refuses a
    // plain tools/call for it), so it must not be republished.
    expect(out.map((t) => t.name)).toEqual(["plain", "opt"]);
    expect(out[0].title).toBe("Plain Tool");
    expect(out[0].outputSchema).toEqual({ type: "object", properties: { ok: { type: "boolean" } } });
    expect(out[0]._meta).toEqual({ "example.com/flag": true });
    // The proxy always calls upstream in plain mode; task support must not
    // be re-advertised downstream even for taskSupport=optional tools.
    expect((out[1] as unknown as Record<string, unknown>).execution).toBeUndefined();
    expect(stderr.writes.some((w) => w.includes("task-based") && w.includes("tasky"))).toBe(true);
  });
});

describe("fetchResourcesFromUpstream / fetchPromptsFromUpstream metadata", () => {
  // MCP 2025-06-18 gives resources and prompts the same `title` + `_meta`
  // fields tools already had. Both fetchers used to build their defs field
  // by field WITHOUT them, so an upstream display name was replaced by the
  // raw name downstream and _meta never survived the proxy.
  it("forwards a resource's title and _meta alongside the namespaced URI", async () => {
    const resources = [
      { uri: "file:///a", name: "a", title: "Alpha", _meta: { "example.com/kind": "doc" } },
      { uri: "file:///b", name: "b" },
    ];
    const client = makeClient({ listResources: vi.fn().mockResolvedValue({ resources }) });

    const out = await fetchResourcesFromUpstream(client, "ns");
    expect(out[0].title).toBe("Alpha");
    expect(out[0]._meta).toEqual({ "example.com/kind": "doc" });
    expect(out[0].namespacedUri).toBe("connect://ns/file:///a");
    // Absent upstream fields stay absent -- no title synthesized from `name`.
    expect(out[1].title).toBeUndefined();
    expect(out[1]._meta).toBeUndefined();
  });

  it("forwards a prompt's title and _meta alongside the namespaced name", async () => {
    const prompts = [{ name: "p", title: "Pretty Prompt", _meta: { "example.com/kind": "helper" } }, { name: "q" }];
    const client = makeClient({ listPrompts: vi.fn().mockResolvedValue({ prompts }) });

    const out = await fetchPromptsFromUpstream(client, "ns");
    expect(out[0].title).toBe("Pretty Prompt");
    expect(out[0]._meta).toEqual({ "example.com/kind": "helper" });
    expect(out[0].namespacedName).toBe("ns_p");
    expect(out[1].title).toBeUndefined();
    expect(out[1]._meta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Helpers for connectToUpstream-based tests
// ---------------------------------------------------------------------------

/** Minimal local server config that does NOT require a vault. */
function makeLocalConfig(overrides: Record<string, unknown> = {}): any {
  return {
    id: "test-srv",
    name: "Test Server",
    namespace: "test",
    type: "local",
    command: "node",
    args: [],
    env: {},
    isActive: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// redactSecretsInOutput -- tested via connectToUpstream ActivationError tail
// ---------------------------------------------------------------------------

describe("redactSecretsInOutput", () => {
  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("handshake failed"));
    _sdkBehavior.clientClose = () => Promise.resolve();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("replaces secret values found in resolved env with ***KEY*** in ActivationError tail", async () => {
    // Simulate a resolved env where MY_TOKEN has a high-entropy value.
    const secretValue = "ghp_AbCdEfGhIjKlMnOpQrStUvWx12345678";
    // hasSecretRefs returns false so resolveServerEnv passes through immediately,
    // returning the env unchanged. resolvedServerEnv is populated with MY_TOKEN.
    // We then fail the connect so the error handler runs and calls redactSecretsInOutput.
    //
    // Stderr is emitted synchronously inside the connect call, BEFORE the rejection
    // promise resolves, so the stderrRing is populated when the catch block runs.
    const config = makeLocalConfig({ env: { MY_TOKEN: secretValue } });

    _sdkBehavior.clientConnect = () => {
      // Emit synchronously so the data listener (attached before connect is called)
      // populates the ring before the rejection is caught.
      _sdkBehavior.stderrEmitter?.emit("data", Buffer.from(`authentication failed: ${secretValue}`));
      return Promise.reject(new Error("handshake failed"));
    };

    let err: ActivationError | undefined;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e as ActivationError;
    }

    expect(err).toBeInstanceOf(ActivationError);
    // The raw secret value must NOT appear in the error message or stderrTail.
    expect(err!.message).not.toContain(secretValue);
    expect(err!.stderrTail).not.toContain(secretValue);
    // It should be replaced with the ***KEY*** pattern.
    expect(err!.stderrTail).toContain("***MY_TOKEN***");
  });

  it("is a no-op when env is empty -- output passes through unchanged", async () => {
    const config = makeLocalConfig({ env: {} });

    _sdkBehavior.clientConnect = () => {
      _sdkBehavior.stderrEmitter?.emit("data", Buffer.from("some plain error output"));
      return Promise.reject(new Error("handshake failed"));
    };

    let err: ActivationError | undefined;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e as ActivationError;
    }

    expect(err).toBeInstanceOf(ActivationError);
    expect(err!.stderrTail).toContain("some plain error output");
  });

  it("does not redact short env values (< 8 chars) -- boundary guard", async () => {
    // The redactor skips values shorter than 8 characters to avoid mangling
    // common substrings. Verify a 7-char value is left in place.
    const shortVal = "abc1234"; // 7 chars
    const config = makeLocalConfig({ env: { SHORT: shortVal } });

    _sdkBehavior.clientConnect = () => {
      _sdkBehavior.stderrEmitter?.emit("data", Buffer.from(`error: ${shortVal} is invalid`));
      return Promise.reject(new Error("handshake failed"));
    };

    let err: ActivationError | undefined;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e as ActivationError;
    }

    expect(err).toBeInstanceOf(ActivationError);
    // Short value should NOT have been redacted.
    expect(err!.stderrTail).toContain(shortVal);
    expect(err!.stderrTail).not.toContain("***SHORT***");
  });

  it("redacts the longest secret whole when one value is a substring of another", async () => {
    // INNER is a prefix of OUTER. If the redactor replaced values in
    // insertion order (short-first), INNER would be redacted inside OUTER
    // first, leaving OUTER's real "_SUFFIX_9999" tail exposed. Longest-first
    // ordering must redact OUTER whole instead.
    const innerValue = "ghp_AbCdEfGh12345678";
    const outerValue = `${innerValue}_SUFFIX_9999`;
    const config = makeLocalConfig({ env: { INNER_TOKEN: innerValue, OUTER_TOKEN: outerValue } });

    _sdkBehavior.clientConnect = () => {
      _sdkBehavior.stderrEmitter?.emit("data", Buffer.from(`authentication failed: ${outerValue}`));
      return Promise.reject(new Error("handshake failed"));
    };

    let err: ActivationError | undefined;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e as ActivationError;
    }

    expect(err).toBeInstanceOf(ActivationError);
    // Neither raw value, nor OUTER's tail, may survive.
    expect(err!.stderrTail).not.toContain(outerValue);
    expect(err!.stderrTail).not.toContain("_SUFFIX_9999");
    expect(err!.stderrTail).toContain("***OUTER_TOKEN***");
  });

  it("rewrites an UNRESOLVED ${secret:NAME} literal to ${secret:***} rather than naming the env key", async () => {
    // Defense in depth: a ref that reached the child unresolved (or was echoed
    // back by it) still names a vault entry, which is not something to publish
    // in an error message. Two branches at once -- the value loop SKIPS a value
    // that is itself a `${secret:...}` literal, so the catch-all rewrite is what
    // has to fire. If the skip went away the value loop would replace the whole
    // literal with ***TOKEN***, and the rewrite would never see it.
    const config = makeLocalConfig({ env: { TOKEN: "${secret:MY_TOKEN}" } });

    _sdkBehavior.clientConnect = () => {
      _sdkBehavior.stderrEmitter?.emit("data", Buffer.from("config error: ${secret:MY_TOKEN} was rejected"));
      return Promise.reject(new Error("handshake failed"));
    };

    let err: ActivationError | undefined;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e as ActivationError;
    }

    expect(err).toBeInstanceOf(ActivationError);
    expect(err!.stderrTail).toContain("${secret:***}");
    // The vault entry's NAME is gone from both surfaces ...
    expect(err!.stderrTail).not.toContain("MY_TOKEN");
    expect(err!.message).not.toContain("MY_TOKEN");
    // ... and the literal took the rewrite, not the value-substitution path.
    expect(err!.stderrTail).not.toContain("***TOKEN***");
  });
});

// ---------------------------------------------------------------------------
// resolveServerEnv -- tested via connectToUpstream error path
// ---------------------------------------------------------------------------

describe("resolveServerEnv", () => {
  beforeEach(() => {
    // Cleared so the child-env assertions below can never read a slot left
    // behind by an earlier suite if a case fails before the transport is built.
    _sdkBehavior.lastStdioArgs = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    // The session passphrase is module state: one case's value would silently
    // unlock the next case's vault and hide a regression in the env path.
    clearSessionVaultPassphrase();
  });

  it("returns env unchanged when it contains no ${secret:} refs", async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    // connect will fail immediately -- we only care that no vault call was made
    // and that the error is NOT a vault-related throw.
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("transport error"));

    const config = makeLocalConfig({ env: { PLAIN: "hello" } });

    let err: unknown;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e;
    }

    // loadVault must not have been called because there were no secret refs.
    expect(vi.mocked(loadVault)).not.toHaveBeenCalled();
    // The error should be an ActivationError (transport/connect failure), not
    // a vault error, confirming resolveServerEnv returned early.
    expect(err).toBeInstanceOf(ActivationError);
    // "unchanged" means it actually reached the child that way -- the value
    // the config declared, spawned verbatim.
    expect(_sdkBehavior.lastStdioArgs?.env?.PLAIN).toBe("hello");
  });

  it("substitutes ${secret:NAME} with vault value when vault is loaded", async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "test-passphrase";

    const fakeVault = { version: 1, salt: "abc", entries: { MY_SECRET: {} } } as any;
    vi.mocked(loadVault).mockResolvedValue(fakeVault);

    const fakeKey = Buffer.from("fakekey");
    vi.mocked(unlock).mockResolvedValue(fakeKey);

    const resolvedValue = "resolved-cleartext-value";
    vi.mocked(resolveSecretRefs).mockReturnValue({
      resolved: { API_KEY: resolvedValue },
      missing: [],
      malformed: [],
    });

    // Connect will fail -- we only need resolveServerEnv to complete without throwing.
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("transport error"));

    const config = makeLocalConfig({ env: { API_KEY: "${secret:MY_SECRET}" } });

    let err: unknown;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e;
    }

    // resolveSecretRefs was called (vault path exercised).
    expect(vi.mocked(resolveSecretRefs)).toHaveBeenCalledWith({ API_KEY: "${secret:MY_SECRET}" }, fakeVault, fakeKey);
    // The failure is a transport ActivationError, not a vault error --
    // confirming resolveServerEnv succeeded and did not throw.
    expect(err).toBeInstanceOf(ActivationError);
    const ae = err as ActivationError;
    // The error must NOT be a vault error -- it is a transport-level failure.
    expect(ae.message).not.toMatch(/vault/i);
    // The spawn boundary itself: this is the only suite that mocks the stdio
    // transport AND resolves a vault ref, so it is the only place the three
    // parts of `env: { ...stripInternalSecretsFromEnv(process.env), ...serverEnv }`
    // can be checked together. toMatchObject, not toEqual -- the child env
    // carries the whole (stripped) parent env alongside the server's own keys.
    expect(_sdkBehavior.lastStdioArgs?.env).toMatchObject({ API_KEY: resolvedValue });
    // The broker's own passphrase (set above) is stripped, so no third-party
    // upstream can read the vault it unlocks.
    expect(_sdkBehavior.lastStdioArgs?.env).not.toHaveProperty("YAW_MCP_VAULT_PASSPHRASE");
    // ... and the ref was RESOLVED on the way in, not passed through literal.
    expect(_sdkBehavior.lastStdioArgs?.env?.API_KEY).not.toContain("${secret:");
  });

  it("throws when secret NAME is missing from vault", async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "test-passphrase";

    const fakeVault = { version: 1, salt: "abc", entries: {} } as any;
    vi.mocked(loadVault).mockResolvedValue(fakeVault);

    const fakeKey = Buffer.from("fakekey");
    vi.mocked(unlock).mockResolvedValue(fakeKey);

    // resolveSecretRefs reports the name as missing.
    vi.mocked(resolveSecretRefs).mockReturnValue({
      resolved: { API_KEY: "${secret:MISSING_NAME}" },
      missing: ["MISSING_NAME"],
      malformed: [],
    });

    const config = makeLocalConfig({ env: { API_KEY: "${secret:MISSING_NAME}" } });

    await expect(connectToUpstream(config)).rejects.toThrow(
      /vault: missing or undecryptable secret refs: MISSING_NAME/,
    );
  });

  it("records 'missing' but NOT 'injected' when a refused spawn had one resolvable ref", async () => {
    // The refusal is the case an operator goes looking for in
    // `yaw-mcp secrets audit`; recording only on the success path left the
    // "missing" event kind dead even though the CLI renders it.
    //
    // Two refs -- one resolvable (OK_NAME), one missing -- because
    // resolution is all-or-nothing: the missing ref refuses the spawn, so
    // the resolvable one never reaches a child env either. Recording it as
    // "injected" answered "did this server ever receive OK_NAME?" with a
    // false yes. "injected" must keep meaning "went into a spawn env".
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "test-passphrase";
    vi.mocked(loadVault).mockResolvedValue({ version: 1, salt: "abc", entries: { OK_NAME: {} } } as any);
    vi.mocked(unlock).mockResolvedValue(Buffer.from("fakekey"));
    vi.mocked(resolveSecretRefs).mockReturnValue({
      resolved: { API_KEY: "${secret:MISSING_NAME}", OTHER: "resolved-cleartext" },
      missing: ["MISSING_NAME"],
      malformed: [],
    });

    const config = makeLocalConfig({
      env: { API_KEY: "${secret:MISSING_NAME}", OTHER: "${secret:OK_NAME}" },
    });
    await expect(connectToUpstream(config)).rejects.toThrow(/missing or undecryptable/);

    expect(vi.mocked(appendAuditEvent)).toHaveBeenCalledWith({
      server: "test",
      secret: "MISSING_NAME",
      event: "missing",
    });
    // The ref that DID resolve must not be logged as injected -- the spawn
    // was refused, so nothing was injected at all.
    expect(vi.mocked(appendAuditEvent)).not.toHaveBeenCalledWith(expect.objectContaining({ event: "injected" }));
    expect(vi.mocked(appendAuditEvent)).toHaveBeenCalledTimes(1);
  });

  it("refuses the spawn over a MALFORMED ref, keeps the span out of the audit log and bounds it in the error", async () => {
    // Through the REAL resolveSecretRefs: the point is what upstream does
    // with what it returns. A malformed span used to be folded into
    // `missing`, so recordResolveAudit wrote it as the `secret` NAME of a
    // "missing" event -- and an unterminated ref runs to the end of the env
    // value, so `${secret:DB_PASS@db.internal:5432/prod?x=y` put the host,
    // port and query string into a log whose contract is names only, and the
    // thrown error quoted the whole value with no bound.
    const actual = await vi.importActual<typeof import("../secrets-vault.js")>("../secrets-vault.js");
    vi.mocked(resolveSecretRefs).mockImplementation(actual.resolveSecretRefs);
    try {
      vi.mocked(hasSecretRefs).mockReturnValue(true);
      process.env.YAW_MCP_VAULT_PASSPHRASE = "test-passphrase";
      // No entries at all: nothing decrypts, so the run exercises only the
      // malformed path (a well-formed ref would be reported missing instead).
      vi.mocked(loadVault).mockResolvedValue({ version: 2, salt: "abc", entries: {} } as any);
      vi.mocked(unlock).mockResolvedValue(Buffer.from("fakekey"));

      const tail = `DB_PASS@db.internal:5432/prod?x=y&pw=${"z".repeat(300)}`;
      const config = makeLocalConfig({ env: { GH: "${secret:gh token}", DB: `\${secret:${tail}` } });
      let err: unknown;
      try {
        await connectToUpstream(config);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).toContain("vault: malformed secret refs: <malformed ref> ${secret:gh ...");
      // Bounded: each span is capped by secrets-vault, so the 300-char tail
      // never reaches the message (an MCP error payload and a log line).
      expect(message).not.toContain("pw=");
      expect(message.length).toBeLessThan(300);
      // Nothing was spawned.
      expect(_sdkBehavior.lastStdioArgs).toBeNull();

      // The audit trail got a "missing" event per malformed ref under its
      // names-only form -- the marker plus the legal-name prefix -- and never
      // the host, the port or the query string.
      expect(vi.mocked(appendAuditEvent)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(appendAuditEvent)).toHaveBeenCalledWith({
        server: "test",
        secret: "<malformed ref> gh",
        event: "missing",
      });
      expect(vi.mocked(appendAuditEvent)).toHaveBeenCalledWith({
        server: "test",
        secret: "<malformed ref> DB_PASS",
        event: "missing",
      });
      for (const [input] of vi.mocked(appendAuditEvent).mock.calls) {
        expect(input.secret).not.toContain("@db.internal");
        expect(input.secret).not.toContain("gh token");
        expect(input.event).toBe("missing");
      }
    } finally {
      // Back to the bare vi.fn() the rest of the suite configures per case.
      vi.mocked(resolveSecretRefs).mockReset();
    }
  });

  it("keeps the missing-only refusal message unchanged and adds a malformed clause after it", async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "test-passphrase";
    vi.mocked(loadVault).mockResolvedValue({ version: 2, salt: "abc", entries: {} } as any);
    vi.mocked(unlock).mockResolvedValue(Buffer.from("fakekey"));
    vi.mocked(resolveSecretRefs).mockReturnValue({
      resolved: { A: "${secret:MISSING_NAME}", B: "${secret:gh token}" },
      missing: ["MISSING_NAME"],
      malformed: [{ display: "<malformed ref> ${secret:gh ...", auditName: "<malformed ref> gh" }],
    });
    const config = makeLocalConfig({ env: { A: "${secret:MISSING_NAME}", B: "${secret:gh token}" } });
    await expect(connectToUpstream(config)).rejects.toThrow(
      "vault: missing or undecryptable secret refs: MISSING_NAME; malformed secret refs: <malformed ref> ${secret:gh ...",
    );
    // Both kinds land in the trail as "missing" -- the malformed one under
    // its names-only form -- and nothing as "injected": the spawn was refused.
    expect(vi.mocked(appendAuditEvent)).toHaveBeenCalledWith({
      server: "test",
      secret: "MISSING_NAME",
      event: "missing",
    });
    expect(vi.mocked(appendAuditEvent)).toHaveBeenCalledWith({
      server: "test",
      secret: "<malformed ref> gh",
      event: "missing",
    });
    expect(vi.mocked(appendAuditEvent)).not.toHaveBeenCalledWith(expect.objectContaining({ event: "injected" }));
  });

  it("records an 'injected' audit event per resolved secret NAME (never a value)", async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "test-passphrase";
    vi.mocked(loadVault).mockResolvedValue({ version: 1, salt: "abc", entries: { MY_SECRET: {} } } as any);
    vi.mocked(unlock).mockResolvedValue(Buffer.from("fakekey"));
    vi.mocked(resolveSecretRefs).mockReturnValue({ resolved: { API_KEY: "cleartext" }, missing: [], malformed: [] });
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("transport error"));

    const config = makeLocalConfig({ env: { API_KEY: "${secret:MY_SECRET}" } });
    await expect(connectToUpstream(config)).rejects.toBeInstanceOf(ActivationError);

    expect(vi.mocked(appendAuditEvent)).toHaveBeenCalledWith({
      server: "test",
      secret: "MY_SECRET",
      event: "injected",
    });
  });

  it("throws when YAW_MCP_VAULT_PASSPHRASE is not set and secret refs are present", async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;

    const config = makeLocalConfig({ env: { TOKEN: "${secret:MY_TOKEN}" } });

    await expect(connectToUpstream(config)).rejects.toThrow(/vault locked.*YAW_MCP_VAULT_PASSPHRASE/);
  });

  it("throws a TYPED VaultPassphraseRequiredError carrying the namespace and ref keys", async () => {
    // The type is what lets the activation path tell "yaw-mcp needs its vault
    // passphrase" apart from "the child says a credential is missing". Matching
    // on message text instead would let any upstream induce the vault prompt by
    // printing the right words to stderr.
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;

    const config = makeLocalConfig({ env: { TOKEN: "${secret:MY_TOKEN}", PLAIN: "literal" } });

    let err: unknown;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(VaultPassphraseRequiredError);
    const vaultErr = err as VaultPassphraseRequiredError;
    expect(vaultErr.namespace).toBe("test");
    // Only the env keys that actually carry a ref -- PLAIN is a literal.
    expect(vaultErr.refKeys).toEqual(["TOKEN"]);
    // NOT an ActivationError: no child ever ran, and the oam boot-probe
    // downgrade keys off that type to decide what is worth retrying.
    expect(err).not.toBeInstanceOf(ActivationError);
  });

  it("unlocks with a session passphrase when the env var is absent", async () => {
    // The elicitation path's whole point: a user who answered the prompt gets
    // a working spawn without YAW_MCP_VAULT_PASSPHRASE ever being set.
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    setSessionVaultPassphrase("from-elicitation");

    const fakeVault = { version: 1, salt: "abc", entries: { MY_TOKEN: {} } } as any;
    const fakeKey = Buffer.from("fakekey");
    vi.mocked(loadVault).mockResolvedValue(fakeVault);
    vi.mocked(unlock).mockResolvedValue(fakeKey);
    vi.mocked(resolveSecretRefs).mockReturnValue({ resolved: { TOKEN: "cleartext" }, missing: [], malformed: [] });

    const config = makeLocalConfig({ env: { TOKEN: "${secret:MY_TOKEN}" } });
    await connectToUpstream(config).catch(() => {});

    expect(vi.mocked(unlock)).toHaveBeenCalledWith(fakeVault, "from-elicitation");
  });

  it("prefers the session passphrase over a stale env var", async () => {
    // Ordering matters in exactly one case -- the env var is set but WRONG.
    // Preferring it would make the correction the user just typed unreachable
    // for the rest of the session.
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "stale-and-wrong";
    setSessionVaultPassphrase("the-real-one");

    const fakeVault = { version: 1, salt: "abc", entries: { MY_TOKEN: {} } } as any;
    vi.mocked(loadVault).mockResolvedValue(fakeVault);
    vi.mocked(unlock).mockResolvedValue(Buffer.from("fakekey"));
    vi.mocked(resolveSecretRefs).mockReturnValue({ resolved: { TOKEN: "cleartext" }, missing: [], malformed: [] });

    const config = makeLocalConfig({ env: { TOKEN: "${secret:MY_TOKEN}" } });
    await connectToUpstream(config).catch(() => {});

    expect(vi.mocked(unlock)).toHaveBeenCalledWith(fakeVault, "the-real-one");
  });

  it("keeps the session passphrase OUT of process.env, so no child can inherit it", async () => {
    // Every local spawn builds its child env from
    // stripInternalSecretsFromEnv(process.env). Parking the passphrase in
    // process.env would put it one strip-list bug away from every upstream;
    // keeping it in module state means the child env physically cannot carry
    // it, whatever the strip list says.
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    setSessionVaultPassphrase("never-in-the-environment");

    expect(process.env.YAW_MCP_VAULT_PASSPHRASE).toBeUndefined();
    expect(vaultPassphrase()).toBe("never-in-the-environment");
    // Scan the VALUES, not the one key: asserting that key's absence would be
    // tautological (it was deleted two lines up, so the strip cannot produce
    // it whatever the strip list says). The invariant worth pinning is that
    // the session passphrase reaches no child env under ANY key.
    expect(Object.values(stripInternalSecretsFromEnv(process.env))).not.toContain("never-in-the-environment");
  });

  it('treats an empty session passphrase as absent rather than installing ""', async () => {
    // A declined or blank elicitation must not become the passphrase: deriving
    // a key from "" is precisely what secrets-cmd refuses on the CLI side.
    process.env.YAW_MCP_VAULT_PASSPHRASE = "from-env";
    setSessionVaultPassphrase("");

    expect(vaultPassphrase()).toBe("from-env");
  });
});

// ---------------------------------------------------------------------------
// oam runtime wiring -- connectToUpstream must apply resolveOamSpawn to the
// launch command iff config.runtime === "oam". This is the integration link
// between local-bundles (which propagates `runtime`) and oam-spawn (which does
// the rewrite); a regression here (e.g. the 0.66.2 bug where `runtime` was
// dropped before reaching this gate) would silently host opted-in servers on
// node instead of oam.
// ---------------------------------------------------------------------------

describe("connectToUpstream oam runtime wiring", () => {
  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    // The transport is constructed before the client connects; reject connect so
    // the call returns fast -- lastStdioArgs is already captured by then.
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("stop after spawn"));
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.lastStdioArgs = null;
    _sdkBehavior.stdioConstructions = [];
    vi.mocked(resolveOamSpawn).mockReset();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("applies resolveOamSpawn to the spawn command when runtime is 'oam'", async () => {
    vi.mocked(resolveOamSpawn).mockResolvedValue({
      command: "/usr/bin/oam",
      args: ["run", "/cache/fetch/dist/index.js"],
    });
    const config = makeLocalConfig({
      runtime: "oam",
      command: "npx",
      args: ["-y", "@yawlabs/fetch-mcp@latest"],
    });
    try {
      await connectToUpstream(config);
    } catch {
      // connect rejects in the mock; we only assert the spawn was rewritten.
    }
    // The gate fired with the (uv-resolved) command/args, exactly once -- the
    // boot-probe downgrade retry deliberately skips the rewrite ...
    expect(vi.mocked(resolveOamSpawn)).toHaveBeenCalledOnce();
    expect(vi.mocked(resolveOamSpawn)).toHaveBeenCalledWith("npx", ["-y", "@yawlabs/fetch-mcp@latest"], true);
    // ... and the REWRITTEN command/args are what actually get spawned first.
    expect(_sdkBehavior.stdioConstructions[0]?.command).toBe("/usr/bin/oam");
    expect(_sdkBehavior.stdioConstructions[0]?.args).toEqual(["run", "/cache/fetch/dist/index.js"]);
  });

  it("still routes through oam when runtime is unset, but marked as not opted in", async () => {
    // Unset now means oam-when-available, so the rewrite IS attempted. The
    // third argument is what keeps that quiet: `false` says nothing was
    // configured, so an absent oam must not warn -- otherwise every node-only
    // install starts logging about a runtime its owner never asked for.
    const config = makeLocalConfig({ command: "npx", args: ["-y", "@yawlabs/fetch-mcp@latest"] });
    try {
      await connectToUpstream(config);
    } catch {
      /* connect rejects; assertions below */
    }
    expect(vi.mocked(resolveOamSpawn)).toHaveBeenCalledWith("npx", ["-y", "@yawlabs/fetch-mcp@latest"], false);
  });

  it("does NOT touch the spawn command when runtime is 'node'", async () => {
    const config = makeLocalConfig({ runtime: "node", command: "npx", args: ["-y", "x"] });
    try {
      await connectToUpstream(config);
    } catch {
      /* same */
    }
    expect(vi.mocked(resolveOamSpawn)).not.toHaveBeenCalled();
    expect(_sdkBehavior.lastStdioArgs?.command).toBe("npx");
  });
});

// ---------------------------------------------------------------------------
// Config-level default runtime -- connectToUpstream must apply the oam rewrite
// when defaultRuntime() says "oam" and the server carries no per-server
// runtime; per-server "node" stays an escape hatch. Backend server defs never
// carry `runtime`, so this gate is what makes the knob work in account mode.
// ---------------------------------------------------------------------------

describe("connectToUpstream config-level default runtime", () => {
  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("stop after spawn"));
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.lastStdioArgs = null;
    _sdkBehavior.stdioConstructions = [];
    vi.mocked(resolveOamSpawn).mockReset();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("applies the oam rewrite when the default is 'oam' and runtime is unset", async () => {
    vi.mocked(defaultRuntime).mockResolvedValue("oam");
    vi.mocked(resolveOamSpawn).mockResolvedValue({ command: "/usr/bin/oam", args: ["run", "/e.js"] });
    const config = makeLocalConfig({ command: "npx", args: ["-y", "@yawlabs/fetch-mcp@latest"] });
    try {
      await connectToUpstream(config);
    } catch {
      /* connect rejects; assertions below */
    }
    expect(vi.mocked(resolveOamSpawn)).toHaveBeenCalledWith("npx", ["-y", "@yawlabs/fetch-mcp@latest"], true);
    expect(_sdkBehavior.stdioConstructions[0]?.command).toBe("/usr/bin/oam");
  });

  it("per-server runtime:'node' opts out of a default of 'oam'", async () => {
    vi.mocked(defaultRuntime).mockResolvedValue("oam");
    const config = makeLocalConfig({ runtime: "node", command: "npx", args: ["-y", "x"] });
    try {
      await connectToUpstream(config);
    } catch {
      /* same */
    }
    expect(vi.mocked(resolveOamSpawn)).not.toHaveBeenCalled();
    expect(_sdkBehavior.stdioConstructions.map((c) => c.command)).toEqual(["npx"]);
  });

  it("stays on node when the default is 'node'", async () => {
    vi.mocked(defaultRuntime).mockResolvedValue("node");
    const config = makeLocalConfig({ command: "npx", args: ["-y", "x"] });
    try {
      await connectToUpstream(config);
    } catch {
      /* same */
    }
    expect(vi.mocked(resolveOamSpawn)).not.toHaveBeenCalled();
    expect(_sdkBehavior.lastStdioArgs?.command).toBe("npx");
  });
});

// ---------------------------------------------------------------------------
// Boot-probe fallback -- when the spawn was ACTUALLY oam-rewritten and the
// boot fails (handshake failure / early child exit, both surfacing as an
// ActivationError), connectToUpstream respawns ONCE with the original
// pre-rewrite command. No retry ladder beyond that single downgrade, and
// non-oam spawns keep the existing single-attempt behavior.
// ---------------------------------------------------------------------------

describe("connectToUpstream oam boot-probe fallback", () => {
  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("boot failed"));
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.lastStdioArgs = null;
    _sdkBehavior.stdioConstructions = [];
    vi.mocked(resolveOamSpawn).mockReset();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("respawns once on the ORIGINAL command and succeeds when node boots", async () => {
    vi.mocked(resolveOamSpawn).mockResolvedValue({ command: "/usr/bin/oam", args: ["run", "/e.js"] });
    let connects = 0;
    _sdkBehavior.clientConnect = () => {
      connects++;
      return connects === 1 ? Promise.reject(new Error("oam crashed on boot")) : Promise.resolve();
    };
    const config = makeLocalConfig({ runtime: "oam", command: "npx", args: ["-y", "@yawlabs/fetch-mcp@latest"] });

    const connection = await connectToUpstream(config);

    expect(connection.status).toBe("connected");
    // First spawn = oam-rewritten, second = the original pre-rewrite command.
    expect(_sdkBehavior.stdioConstructions.map((c) => c.command)).toEqual(["/usr/bin/oam", "npx"]);
    expect(_sdkBehavior.stdioConstructions[1]?.args).toEqual(["-y", "@yawlabs/fetch-mcp@latest"]);
    // The downgrade attempt skips the rewrite entirely.
    expect(vi.mocked(resolveOamSpawn)).toHaveBeenCalledOnce();
  });

  it("downgrades exactly once: a second failure propagates (no retry ladder)", async () => {
    vi.mocked(resolveOamSpawn).mockResolvedValue({ command: "/usr/bin/oam", args: ["run", "/e.js"] });
    const config = makeLocalConfig({ runtime: "oam", command: "npx", args: ["-y", "x"] });

    await expect(connectToUpstream(config)).rejects.toBeInstanceOf(ActivationError);
    expect(_sdkBehavior.stdioConstructions.map((c) => c.command)).toEqual(["/usr/bin/oam", "npx"]);
  });

  it("does NOT respawn when the spawn was never oam-rewritten", async () => {
    const config = makeLocalConfig({ command: "npx", args: ["-y", "x"] });
    await expect(connectToUpstream(config)).rejects.toBeInstanceOf(ActivationError);
    expect(_sdkBehavior.stdioConstructions).toHaveLength(1);
  });

  it("does NOT respawn when resolveOamSpawn already fell back internally (command unchanged)", async () => {
    // oam absent / package unresolvable: resolveOamSpawn returns the command
    // untouched, so a boot failure is a NODE failure -- no downgrade retry.
    vi.mocked(resolveOamSpawn).mockImplementation(async (command: string, args: string[]) => ({ command, args }));
    const config = makeLocalConfig({ runtime: "oam", command: "npx", args: ["-y", "x"] });
    await expect(connectToUpstream(config)).rejects.toBeInstanceOf(ActivationError);
    expect(_sdkBehavior.stdioConstructions).toHaveLength(1);
    expect(_sdkBehavior.stdioConstructions[0]?.command).toBe("npx");
  });

  it("does NOT downgrade on non-activation failures (vault refusals rethrow untouched)", async () => {
    // Secret refs present but no passphrase -> resolveServerEnv throws the
    // typed VaultPassphraseRequiredError AFTER the rewrite gate, which is not
    // an ActivationError. Downgrading would just fail identically on node, so
    // the wrapper must rethrow without a respawn.
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    vi.mocked(resolveOamSpawn).mockResolvedValue({ command: "/usr/bin/oam", args: ["run", "/e.js"] });
    const config = makeLocalConfig({
      runtime: "oam",
      command: "npx",
      args: ["-y", "x"],
      env: { TOKEN: "${secret:MY_TOKEN}" },
    });
    await expect(connectToUpstream(config)).rejects.toThrow(/vault locked/);
    // The env is resolved before the transport is built -> no spawn at all.
    expect(_sdkBehavior.stdioConstructions).toHaveLength(0);
    // ... and the spawn count alone cannot see the respawn, because the retry
    // refuses at the same point with the same zero spawns. resolveServerEnv
    // calls hasSecretRefs exactly once per connectToUpstreamOnce, so a second
    // call is the fingerprint of a downgrade attempt: without the
    // `err instanceof ActivationError` guard this reads 2.
    expect(vi.mocked(hasSecretRefs)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log)).not.toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("downgrading to node"),
      expect.anything(),
    );
  });

  it("the downgrade STICKS for the session once node proves oam was the cause", async () => {
    // Callers (activation retry, auto-reconnect, the transient read_tool
    // connect) call connectToUpstream repeatedly; without the namespace memo
    // they'd re-pay the oam boot failure on every outer attempt.
    vi.mocked(resolveOamSpawn).mockResolvedValue({ command: "/usr/bin/oam", args: ["run", "/e.js"] });
    let connects = 0;
    _sdkBehavior.clientConnect = () => {
      connects++;
      // ONLY the oam-hosted boot fails. node coming up healthy is the evidence
      // that oam was the cause -- which is what earns the memo.
      return connects === 1 ? Promise.reject(new Error("oam crashed on boot")) : Promise.resolve();
    };
    const config = makeLocalConfig({ runtime: "oam", command: "npx", args: ["-y", "x"] });

    expect((await connectToUpstream(config)).status).toBe("connected");
    expect(_sdkBehavior.stdioConstructions.map((c) => c.command)).toEqual(["/usr/bin/oam", "npx"]);

    // Second call for the same namespace: straight to node, single spawn,
    // rewrite never consulted again.
    _sdkBehavior.stdioConstructions = [];
    vi.mocked(resolveOamSpawn).mockClear();
    expect((await connectToUpstream(config)).status).toBe("connected");
    expect(_sdkBehavior.stdioConstructions.map((c) => c.command)).toEqual(["npx"]);
    expect(vi.mocked(resolveOamSpawn)).not.toHaveBeenCalled();
  });

  it("does NOT pin the namespace to node when the node respawn fails the SAME way", async () => {
    // An identical failure on both runtimes is evidence oam was never the
    // cause -- a server missing GITHUB_TOKEN fails the same on node. The memo
    // is process-wide and nothing clears it, so writing it here would leave
    // oam hosting off for the rest of the session the moment server.ts's
    // maybeElicitAndRetry supplies the credential and reconnects IN-PROCESS,
    // while doctor still reports "oam".
    vi.mocked(resolveOamSpawn).mockResolvedValue({ command: "/usr/bin/oam", args: ["run", "/e.js"] });
    const config = makeLocalConfig({ runtime: "oam", command: "npx", args: ["-y", "x"] });

    // Both attempts fail identically (no stderr, no ENOENT wording -> the same
    // "unknown" category on each).
    await expect(connectToUpstream(config)).rejects.toBeInstanceOf(ActivationError);
    expect(_sdkBehavior.stdioConstructions.map((c) => c.command)).toEqual(["/usr/bin/oam", "npx"]);

    // The next connect must try oam AGAIN -- no memo was written -- and a
    // genuine oam-only failure still downgrades cleanly.
    _sdkBehavior.stdioConstructions = [];
    let connects = 0;
    _sdkBehavior.clientConnect = () => {
      connects++;
      return connects === 1 ? Promise.reject(new Error("oam crashed on boot")) : Promise.resolve();
    };
    expect((await connectToUpstream(config)).status).toBe("connected");
    expect(_sdkBehavior.stdioConstructions.map((c) => c.command)).toEqual(["/usr/bin/oam", "npx"]);
  });

  it("pins the namespace to node when the node respawn fails a DIFFERENT way", async () => {
    // A different category still points at something oam-specific, so the cost
    // saving is kept: later connects skip the oam boot entirely.
    vi.mocked(resolveOamSpawn).mockResolvedValue({ command: "/usr/bin/oam", args: ["run", "/e.js"] });
    let connects = 0;
    _sdkBehavior.clientConnect = () => {
      connects++;
      // 1st (oam): unclassifiable -> "unknown". 2nd (node): ENOENT -> "spawn_failure".
      return Promise.reject(new Error(connects === 1 ? "boot failed" : "spawn npx ENOENT"));
    };
    const config = makeLocalConfig({ runtime: "oam", command: "npx", args: ["-y", "x"] });

    await expect(connectToUpstream(config)).rejects.toMatchObject({ category: "spawn_failure" });
    expect(_sdkBehavior.stdioConstructions.map((c) => c.command)).toEqual(["/usr/bin/oam", "npx"]);

    _sdkBehavior.stdioConstructions = [];
    vi.mocked(resolveOamSpawn).mockClear();
    await expect(connectToUpstream(config)).rejects.toBeInstanceOf(ActivationError);
    expect(_sdkBehavior.stdioConstructions.map((c) => c.command)).toEqual(["npx"]);
    expect(vi.mocked(resolveOamSpawn)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Runtime reporting -- the "Connected to upstream" line is how an operator
// tells WHICH runtime actually won, and the downgrade warn is the only record
// that a server left oam. Both are pure logging: nothing else in the process
// notices if the runtimeFields ternary inverts, so without these assertions a
// swap that reports `runtime: "oam"` for a connection that actually respawned
// on node passes the whole suite.
// ---------------------------------------------------------------------------

describe("connectToUpstream runtime reporting", () => {
  // Installed purely to keep the runner quiet: the downgrade case below really
  // does emit a warn, and the logger stub forwards warns to the process's own
  // stderr. Assertions here read the log mock, not these writes.
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientConnect = () => Promise.resolve();
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.stdioConstructions = [];
    _sdkBehavior.lastStdioArgs = null;
    _sdkBehavior.notificationHandlers = [];
    resetListHooks();
    vi.mocked(resolveOamSpawn).mockReset();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
    vi.clearAllMocks();
    resetListHooks();
    _sdkBehavior.notificationHandlers = [];
  });

  it("names runtime 'oam' with the probed version when the rewrite applied", async () => {
    vi.mocked(resolveOamSpawn).mockResolvedValue({ command: "/usr/bin/oam", args: ["run", "/e.js"] });

    await connectToUpstream(makeLocalConfig({ runtime: "oam", command: "npx", args: ["-y", "x"] }));

    expect(vi.mocked(log)).toHaveBeenCalledWith("info", "Connected to upstream", {
      name: "Test Server",
      namespace: "test",
      type: "local",
      runtime: "oam",
      oamVersion: MIN_OAM_VERSION,
    });
  });

  it("names runtime 'node' + downgradedFromOam after the boot-probe downgrade", async () => {
    vi.mocked(resolveOamSpawn).mockResolvedValue({ command: "/usr/bin/oam", args: ["run", "/e.js"] });
    let connects = 0;
    _sdkBehavior.clientConnect = () => {
      connects++;
      return connects === 1 ? Promise.reject(new Error("oam crashed on boot")) : Promise.resolve();
    };

    await connectToUpstream(makeLocalConfig({ runtime: "oam", command: "npx", args: ["-y", "x"] }));

    // The warn is the only trace that a server left oam -- pin its fields.
    expect(vi.mocked(log)).toHaveBeenCalledWith(
      "warn",
      "oam-hosted server failed to boot; downgrading to node for this session",
      {
        namespace: "test",
        oamVersion: MIN_OAM_VERSION,
        category: "unknown",
        error: expect.stringContaining("oam crashed on boot"),
      },
    );
    // The success line must name the runtime that ACTUALLY won, not the one
    // that was attempted first.
    expect(vi.mocked(log)).toHaveBeenCalledWith("info", "Connected to upstream", {
      name: "Test Server",
      namespace: "test",
      type: "local",
      runtime: "node",
      downgradedFromOam: true,
    });
    expect(vi.mocked(log)).not.toHaveBeenCalledWith(
      "info",
      "Connected to upstream",
      expect.objectContaining({ runtime: "oam" }),
    );
  });

  it("adds no runtime keys at all for a plain node spawn", async () => {
    // oam absent / package unresolvable: resolveOamSpawn hands the command back
    // untouched, so the connection is node-hosted and the log must not imply a
    // runtime decision was made.
    vi.mocked(resolveOamSpawn).mockImplementation(async (command: string, args: string[]) => ({ command, args }));

    await connectToUpstream(makeLocalConfig({ command: "npx", args: ["-y", "x"] }));

    expect(vi.mocked(log)).toHaveBeenCalledWith("info", "Connected to upstream", {
      name: "Test Server",
      namespace: "test",
      type: "local",
    });
  });
});

// ---------------------------------------------------------------------------
// closedBeforeReady -- the child dies mid-init. initialize + tools/list
// succeed, then client.onclose fires DURING the resources/prompts fetch
// window while connection.status is still "disconnected". The post-fetch
// guard must reject with an ActivationError ("disconnected during
// initialization", protocol_error) rather than return a dead "connected"
// connection over an already-closed client (fetchResources/Prompts swallow
// errors, so without the closedBeforeReady flag the dead child would slip
// through). See the `client.onclose` handler and the `if (closedBeforeReady)`
// guard in connectToUpstreamOnce (upstream.ts) -- named rather than cited by
// line, because every line number in this file's headers had drifted ~400
// lines and pointed readers at unrelated code.
// ---------------------------------------------------------------------------

describe("connectToUpstream closedBeforeReady", () => {
  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    // Handshake succeeds so the flow reaches the capability-fetch window.
    _sdkBehavior.clientConnect = () => Promise.resolve();
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.stdioConstructions = [];
    _sdkBehavior.lastStdioArgs = null;
    vi.mocked(resolveOamSpawn).mockReset();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.clearAllMocks();
    // Restore the default empty-inventory resolvers so a mid-fetch onclose
    // override can never leak into another suite.
    _sdkBehavior.clientListResources = (_client: any) => Promise.resolve({ resources: [] });
    _sdkBehavior.clientListPrompts = (_client: any) => Promise.resolve({ prompts: [] });
  });

  it("rejects with protocol_error when onclose fires during the resources fetch (status still 'disconnected')", async () => {
    // The child dies while listResources is in flight. onclose runs with
    // connection.status still "disconnected", so closedBeforeReady flips true
    // and the guard after the three fetches rejects.
    _sdkBehavior.clientListResources = (client: any) => {
      client.onclose?.();
      return Promise.resolve({ resources: [] });
    };

    const config = makeLocalConfig();

    let err: ActivationError | undefined;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e as ActivationError;
    }

    expect(err).toBeInstanceOf(ActivationError);
    expect(err!.message).toContain("disconnected during initialization");
    expect(err!.message).toContain("test"); // namespaced in the message
    expect(err!.category).toBe("protocol_error");
  });

  it("rejects with protocol_error when onclose fires during the prompts fetch (last fetch in the window)", async () => {
    // Same failure mode, but the close lands on the final fetch of the
    // initialization window rather than the first.
    _sdkBehavior.clientListPrompts = (client: any) => {
      client.onclose?.();
      return Promise.resolve({ prompts: [] });
    };

    const config = makeLocalConfig();

    let err: ActivationError | undefined;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e as ActivationError;
    }

    expect(err).toBeInstanceOf(ActivationError);
    expect(err!.message).toContain("disconnected during initialization");
    expect(err!.category).toBe("protocol_error");
  });
});

// ---------------------------------------------------------------------------
// Shared helpers for the chain / disconnect / activation-error suites below.
// ---------------------------------------------------------------------------

/** Explicit deferred. The chain tests decide resolution ORDER themselves --
 *  never a setTimeout race, which would make the assertions timing-dependent. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Drain the microtask queue (and anything it queues in turn). setImmediate
 *  fires in the check phase, which runs only after microtasks are exhausted --
 *  so "nothing further happened" after a flush() is a real assertion, not a
 *  bet on a timer. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** The handler connectToUpstream registered for a given notification schema
 *  (most recent registration wins -- a suite may connect more than once). */
function handlerFor(schema: unknown): (notification: unknown) => Promise<void> {
  const entry = [..._sdkBehavior.notificationHandlers].reverse().find((h) => h.schema === schema);
  if (!entry) throw new Error("no notification handler was registered for that schema");
  return entry.handler as (notification: unknown) => Promise<void>;
}

/** Restore the default empty-inventory list hooks so an override can never
 *  leak out of the suite that installed it. */
function resetListHooks(): void {
  _sdkBehavior.clientListTools = (_client: any) => Promise.resolve({ tools: [] });
  _sdkBehavior.clientListResources = (_client: any) => Promise.resolve({ resources: [] });
  _sdkBehavior.clientListPrompts = (_client: any) => Promise.resolve({ prompts: [] });
}

// ---------------------------------------------------------------------------
// list-changed notification chains (the three setNotificationHandler blocks in
// connectToUpstreamOnce, upstream.ts)
//
// Each category (tools/resources/prompts) serializes its refreshes onto its
// own promise chain. Two back-to-back notifications from one upstream must
// produce SEQUENTIAL fetches, not concurrent ones: with concurrency, whichever
// listX() happens to resolve last wins connection.<category>, so a slow fetch
// from an EARLIER notification silently clobbers the newer inventory, and
// onListChanged fires twice in the wrong order (each rebuilding routes).
// ---------------------------------------------------------------------------

interface ListChangedCategory {
  label: string;
  method: string;
  schema: unknown;
  /** Install a per-call fetch implementation for this category. */
  install: (impl: () => Promise<unknown>) => void;
  /** A listX() result carrying a single entry with the given name. */
  result: (name: string) => unknown;
  /** The names currently stored on the connection for this category. */
  read: (connection: any) => (string | undefined)[];
}

const LIST_CHANGED_CATEGORIES: ListChangedCategory[] = [
  {
    label: "tools",
    method: "notifications/tools/list_changed",
    schema: ToolListChangedNotificationSchema,
    install: (impl) => {
      _sdkBehavior.clientListTools = impl;
    },
    result: (name) => ({ tools: [{ name, inputSchema: { type: "object" } }] }),
    read: (connection) => connection.tools.map((t: any) => t.name),
  },
  {
    label: "resources",
    method: "notifications/resources/list_changed",
    schema: ResourceListChangedNotificationSchema,
    install: (impl) => {
      _sdkBehavior.clientListResources = impl;
    },
    result: (name) => ({ resources: [{ uri: `file:///${name}`, name }] }),
    read: (connection) => connection.resources.map((r: any) => r.name),
  },
  {
    label: "prompts",
    method: "notifications/prompts/list_changed",
    schema: PromptListChangedNotificationSchema,
    install: (impl) => {
      _sdkBehavior.clientListPrompts = impl;
    },
    result: (name) => ({ prompts: [{ name }] }),
    read: (connection) => connection.prompts.map((p: any) => p.name),
  },
];

describe("connectToUpstream list-changed chains", () => {
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientConnect = () => Promise.resolve();
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.notificationHandlers = [];
    _sdkBehavior.stdioConstructions = [];
    resetListHooks();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
    vi.clearAllMocks();
    resetListHooks();
    _sdkBehavior.notificationHandlers = [];
  });

  it("registers one handler per category when onListChanged is provided", async () => {
    await connectToUpstream(makeLocalConfig(), undefined, vi.fn());
    expect(_sdkBehavior.notificationHandlers.map((h) => h.schema)).toEqual([
      ToolListChangedNotificationSchema,
      ResourceListChangedNotificationSchema,
      PromptListChangedNotificationSchema,
    ]);
  });

  it("registers no handlers at all when onListChanged is omitted", async () => {
    await connectToUpstream(makeLocalConfig());
    expect(_sdkBehavior.notificationHandlers).toEqual([]);
  });

  it("queues a list_changed that arrives DURING the initial fetch instead of dropping it", async () => {
    // The handlers used to be registered AFTER the three initial fetches, so
    // a notification landing in the connect->fetch window hit the SDK with no
    // handler and was discarded: the inventory then stayed at whatever the
    // initial fetch saw until some later list_changed that may never come.
    const onListChanged = vi.fn();
    const firstFetch = deferred();
    let calls = 0;
    _sdkBehavior.clientListTools = () => {
      calls += 1;
      return calls === 1
        ? firstFetch.promise.then(() => ({ tools: [{ name: "initial", inputSchema: { type: "object" } }] }))
        : Promise.resolve({ tools: [{ name: "after-notification", inputSchema: { type: "object" } }] });
    };

    const connectP = connectToUpstream(makeLocalConfig(), undefined, onListChanged);
    await flush();
    // Registered already, with the initial fetch still in flight: pre-fix this
    // line threw "no notification handler was registered for that schema".
    const refresh = handlerFor(ToolListChangedNotificationSchema)({ method: "notifications/tools/list_changed" });

    // Queued, not raced: the gate holds the refresh until the initial fetch
    // has landed and the connection object exists.
    await flush();
    expect(calls).toBe(1);
    expect(onListChanged).not.toHaveBeenCalled();

    firstFetch.resolve();
    const connection = await connectP;
    await refresh;

    expect(calls).toBe(2);
    expect(connection.tools.map((t) => t.name)).toEqual(["after-notification"]);
    expect(onListChanged).toHaveBeenCalledWith("test");
  });

  it("never runs a queued refresh when the connect ultimately FAILS", async () => {
    // The gate is only released on the success path, so a notification that
    // queued during a doomed connect must not fire a fetch against the client
    // the catch block just closed.
    const onListChanged = vi.fn();
    let calls = 0;
    _sdkBehavior.clientListTools = () => {
      calls += 1;
      return Promise.reject(new Error("tools/list exploded"));
    };

    const connectP = connectToUpstream(makeLocalConfig(), undefined, onListChanged).catch((e) => e);
    await flush();
    const refresh = handlerFor(ToolListChangedNotificationSchema)({ method: "notifications/tools/list_changed" });

    const err = await connectP;
    await flush();

    expect(err).toBeInstanceOf(ActivationError);
    // Exactly the one initial (failed) fetch -- the queued refresh stayed put.
    expect(calls).toBe(1);
    expect(onListChanged).not.toHaveBeenCalled();
    // The queued chain is deliberately never settled; nothing awaits it.
    void refresh;
  });

  for (const category of LIST_CHANGED_CATEGORIES) {
    it(`serializes back-to-back ${category.label} notifications so the LAST one wins`, async () => {
      const onListChanged = vi.fn();
      const connection = await connectToUpstream(makeLocalConfig(), undefined, onListChanged);
      expect(category.read(connection)).toEqual([]);

      // Fetch #1 (notification #1) is deliberately the SLOW one -- it does not
      // settle until the test resolves `slowFirst`. Fetch #2 settles
      // immediately. Serialized, #2 runs last and its result is the final
      // state. Run concurrently, #1's late result would clobber #2's.
      const slowFirst = deferred();
      const started: number[] = [];
      let calls = 0;
      category.install(() => {
        calls += 1;
        const nth = calls;
        started.push(nth);
        return nth === 1
          ? slowFirst.promise.then(() => category.result("from-first-notification"))
          : Promise.resolve(category.result("from-second-notification"));
      });

      const handler = handlerFor(category.schema);
      const first = handler({ method: category.method });
      const second = handler({ method: category.method });

      // Both notifications have been delivered and every microtask has run,
      // yet only ONE fetch has been issued: the second is queued behind the
      // first rather than racing it. Nothing has been published downstream.
      await flush();
      expect(started).toEqual([1]);
      expect(onListChanged).not.toHaveBeenCalled();

      slowFirst.resolve();
      await Promise.all([first, second]);

      // The second fetch only STARTED once the first finished ...
      expect(started).toEqual([1, 2]);
      // ... and the newest notification's inventory is what stuck.
      expect(category.read(connection)).toEqual(["from-second-notification"]);
      // One route rebuild per notification, no double-fire on either.
      expect(onListChanged).toHaveBeenCalledTimes(2);
      expect(onListChanged).toHaveBeenNthCalledWith(1, "test");
      expect(onListChanged).toHaveBeenNthCalledWith(2, "test");
    });
  }

  it("keeps the three chains independent -- a wedged tools fetch does not block resources", async () => {
    const onListChanged = vi.fn();
    const connection = await connectToUpstream(makeLocalConfig(), undefined, onListChanged);

    const wedged = deferred();
    _sdkBehavior.clientListTools = () => wedged.promise.then(() => ({ tools: [] }));
    _sdkBehavior.clientListResources = () => Promise.resolve({ resources: [{ uri: "file:///r", name: "r" }] });

    const toolsPending = handlerFor(ToolListChangedNotificationSchema)({ method: "notifications/tools/list_changed" });
    await handlerFor(ResourceListChangedNotificationSchema)({ method: "notifications/resources/list_changed" });

    expect(connection.resources.map((r) => r.name)).toEqual(["r"]);
    expect(onListChanged).toHaveBeenCalledTimes(1);

    // Unwedge so the pending tools chain settles before the test ends.
    wedged.resolve();
    await toolsPending;
    expect(onListChanged).toHaveBeenCalledTimes(2);
  });

  it("catches a throwing tools refresh, logs it, and leaves the chain usable", async () => {
    const onListChanged = vi.fn();
    const connection = await connectToUpstream(makeLocalConfig(), undefined, onListChanged);

    let calls = 0;
    _sdkBehavior.clientListTools = () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("tools/list exploded"))
        : Promise.resolve({ tools: [{ name: "recovered", inputSchema: { type: "object" } }] });
    };

    const handler = handlerFor(ToolListChangedNotificationSchema);

    // fetchToolsFromUpstream RETHROWS as an ActivationError (unlike the
    // resources/prompts fetchers, which swallow). The chain link must still
    // RESOLVE -- a rejected link would poison every later notification.
    await expect(handler({ method: "notifications/tools/list_changed" })).resolves.toBeUndefined();
    // Nothing was published off the failed fetch. The baseline here is the
    // EMPTY initial inventory, so this pair cannot tell "left alone" from
    // "reset to []" -- that distinction is the seeded-baseline loop below,
    // which now covers tools too.
    expect(connection.tools).toEqual([]);
    expect(onListChanged).not.toHaveBeenCalled();
    expect(
      stderr.writes.some(
        (w) => w.includes("Failed to refresh tools from upstream") && w.includes("tools/list exploded"),
      ),
    ).toBe(true);

    // The next notification on the SAME chain still runs.
    await handler({ method: "notifications/tools/list_changed" });
    expect(connection.tools.map((t) => t.name)).toEqual(["recovered"]);
    expect(onListChanged).toHaveBeenCalledTimes(1);
  });

  // A failed REFRESH must leave the previous inventory standing, for all three
  // categories -- so all three run here, against a SEEDED (non-empty) baseline.
  // A baseline of [] cannot fail: an implementation that reset the category to
  // [] on a failed fetch would pass every assertion.
  //
  // The tools branch gets the invariant for free (fetchToolsFromUpstream
  // rethrows); resources/prompts only get it because the refresh handlers pass
  // throwOnError. Without it those two fetchers return [] on any transport
  // error or LIST_TIMEOUT, so one blip mid-session wiped a healthy server's
  // entire resource/prompt inventory from the client -- silently, until some
  // future list_changed that may never arrive. "For free" is still worth
  // pinning: it is a property of a fetcher this suite does not own.
  for (const category of LIST_CHANGED_CATEGORIES) {
    it(`keeps the previous ${category.label} inventory when the refresh fetch fails`, async () => {
      const onListChanged = vi.fn();
      const connection = await connectToUpstream(makeLocalConfig(), undefined, onListChanged);

      // Seed a real inventory via one good refresh ...
      category.install(() => Promise.resolve(category.result("kept")));
      const handler = handlerFor(category.schema);
      await handler({ method: category.method });
      expect(category.read(connection)).toEqual(["kept"]);
      expect(onListChanged).toHaveBeenCalledTimes(1);

      // ... then a transient failure on the next one.
      category.install(() => Promise.reject(new Error("transport blip")));
      await expect(handler({ method: category.method })).resolves.toBeUndefined();

      // Nothing was published: the seeded inventory stands and no route
      // rebuild fired off a failed fetch.
      expect(category.read(connection)).toEqual(["kept"]);
      expect(onListChanged).toHaveBeenCalledTimes(1);
      expect(
        stderr.writes.some(
          (w) => w.includes(`Failed to refresh ${category.label} from upstream`) && w.includes("transport blip"),
        ),
      ).toBe(true);

      // The chain survives the failure: the next notification still refreshes.
      category.install(() => Promise.resolve(category.result("recovered")));
      await handler({ method: category.method });
      expect(category.read(connection)).toEqual(["recovered"]);
      expect(onListChanged).toHaveBeenCalledTimes(2);
    });
  }

  // A throwing onListChanged is a real risk on EVERY chain -- the callback
  // rebuilds routes in server.ts -- and each category's catch arm is the only
  // thing keeping one bad rebuild from wedging every later notification for
  // that category. So all three run here, tools included: its catch arm is
  // otherwise reachable only through a failing fetch, which is a different
  // entry point. (For resources/prompts it is doubly worth pinning: those
  // fetchers still SWALLOW at connect time -- a server that doesn't implement
  // the capability answers with an error, and that is not a boot failure -- so
  // a throwing callback is the distinct way into their catch arms.)
  for (const category of LIST_CHANGED_CATEGORIES) {
    it(`catches a throwing onListChanged without breaking the ${category.label} chain`, async () => {
      const onListChanged = vi.fn().mockImplementationOnce(() => {
        throw new Error("route rebuild failed");
      });
      const connection = await connectToUpstream(makeLocalConfig(), undefined, onListChanged);

      category.install(() => Promise.resolve(category.result("a")));
      const handler = handlerFor(category.schema);
      await expect(handler({ method: category.method })).resolves.toBeUndefined();

      // The fetch result landed before the callback threw.
      expect(category.read(connection)).toEqual(["a"]);
      expect(
        stderr.writes.some(
          (w) => w.includes(`Failed to refresh ${category.label} from upstream`) && w.includes("route rebuild failed"),
        ),
      ).toBe(true);

      // The chain survives: the next notification still refreshes.
      category.install(() => Promise.resolve(category.result("b")));
      await handler({ method: category.method });
      expect(category.read(connection)).toEqual(["b"]);
      expect(onListChanged).toHaveBeenCalledTimes(2);
    });
  }
});

// ---------------------------------------------------------------------------
// disconnectFromUpstream (upstream.ts) -- a wedged upstream failing to
// close cleanly is the NORMAL case (the child is already gone / the pipe is
// broken), so the catch arm must swallow it and the function must still run to
// completion. A throw here would abort whatever teardown loop called it.
// ---------------------------------------------------------------------------

describe("disconnectFromUpstream", () => {
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientConnect = () => Promise.resolve();
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.notificationHandlers = [];
    _sdkBehavior.stdioConstructions = [];
    resetListHooks();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
    vi.clearAllMocks();
    _sdkBehavior.clientClose = () => Promise.resolve();
  });

  it("marks the connection disconnected and closes the client", async () => {
    const connection = await connectToUpstream(makeLocalConfig());
    expect(connection.status).toBe("connected");

    const close = vi.fn().mockResolvedValue(undefined);
    _sdkBehavior.clientClose = close;

    await expect(disconnectFromUpstream(connection)).resolves.toBeUndefined();
    expect(connection.status).toBe("disconnected");
    expect(close).toHaveBeenCalledOnce();
    expect(vi.mocked(log)).toHaveBeenCalledWith("info", "Disconnected from upstream", { namespace: "test" });
  });

  it("does not throw when close() rejects -- logs the failure and finishes the teardown", async () => {
    const connection = await connectToUpstream(makeLocalConfig());
    _sdkBehavior.clientClose = () => Promise.reject(new Error("EPIPE: broken pipe"));

    await expect(disconnectFromUpstream(connection)).resolves.toBeUndefined();

    // Status is set BEFORE the close attempt, so a failed close still leaves
    // the connection marked dead rather than stuck on "connected".
    expect(connection.status).toBe("disconnected");
    expect(
      stderr.writes.some((w) => w.includes("Error disconnecting from upstream") && w.includes("EPIPE: broken pipe")),
    ).toBe(true);
    // The tail of the function still runs -- a failed close is not a short circuit.
    expect(vi.mocked(log)).toHaveBeenCalledWith("info", "Disconnected from upstream", { namespace: "test" });
  });

  it("sets status BEFORE closing, so a close-driven onclose is not read as an unexpected drop", async () => {
    // A real transport fires onclose from INSIDE close(). The status write
    // ordering is the only thing keeping an intentional teardown out of the
    // onclose handler's live-connection arm; close-then-status would leave the
    // connection "error" with a bogus "Upstream disconnected unexpectedly" and
    // hand the namespace to the reconnect callback for a shutdown the caller
    // asked for. Nothing else in the suite notices a reorder, because the
    // default mock close() never fires the handler.
    const onDisconnect = vi.fn();
    const connection = await connectToUpstream(makeLocalConfig(), onDisconnect);
    expect(connection.status).toBe("connected");

    _sdkBehavior.clientClose = () => {
      connection.client.onclose?.();
      return Promise.resolve();
    };

    await expect(disconnectFromUpstream(connection)).resolves.toBeUndefined();

    expect(connection.status).toBe("disconnected");
    expect(connection.error).toBeUndefined();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(stderr.writes.some((w) => w.includes("Upstream disconnected unexpectedly"))).toBe(false);
  });

  it("does not throw when close() throws synchronously", async () => {
    const connection = await connectToUpstream(makeLocalConfig());
    _sdkBehavior.clientClose = () => {
      throw new Error("transport already destroyed");
    };

    await expect(disconnectFromUpstream(connection)).resolves.toBeUndefined();
    expect(connection.status).toBe("disconnected");
    expect(stderr.writes.some((w) => w.includes("transport already destroyed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unexpected disconnect AFTER the connection went live (the `client.onclose`
// handler in connectToUpstreamOnce, upstream.ts).
// Distinct from closedBeforeReady: here status is already "connected", so the
// handler must mark the connection errored and hand the namespace to the
// reconnect callback instead of silently leaving a dead "connected" entry.
// ---------------------------------------------------------------------------

describe("connectToUpstream onclose after ready", () => {
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientConnect = () => Promise.resolve();
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.notificationHandlers = [];
    _sdkBehavior.stdioConstructions = [];
    resetListHooks();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
    vi.clearAllMocks();
  });

  it("flips the live connection to error and notifies onDisconnect", async () => {
    const onDisconnect = vi.fn();
    const connection = await connectToUpstream(makeLocalConfig(), onDisconnect);
    expect(connection.status).toBe("connected");

    connection.client.onclose?.();

    expect(connection.status).toBe("error");
    expect(connection.error).toBe("Upstream disconnected unexpectedly");
    expect(onDisconnect).toHaveBeenCalledWith("test");
    expect(stderr.writes.some((w) => w.includes("Upstream disconnected unexpectedly"))).toBe(true);
  });

  it("still marks the connection errored when no onDisconnect callback was supplied", async () => {
    const connection = await connectToUpstream(makeLocalConfig());
    expect(() => connection.client.onclose?.()).not.toThrow();
    expect(connection.status).toBe("error");
    expect(connection.error).toBe("Upstream disconnected unexpectedly");
  });
});

// ---------------------------------------------------------------------------
// Downstream capability bridge (upstream.ts connectToUpstreamOnce head). The
// upstream Client must declare EXACTLY the capabilities the downstream client
// declared at initialize, and register a forwarding handler for each declared
// one -- declaring without a handler would turn the SDK's clean "client does
// not support X" refusal into a MethodNotFound at call time.
// ---------------------------------------------------------------------------

describe("connectToUpstream downstream capability bridge", () => {
  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientConnect = () => Promise.resolve();
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.requestHandlers = [];
    _sdkBehavior.clientConstructions = [];
    _sdkBehavior.stdioConstructions = [];
    resetListHooks();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
    _sdkBehavior.requestHandlers = [];
    _sdkBehavior.clientConstructions = [];
  });

  /** Bridge whose forwarders resolve canned results, so a captured request
   *  handler can be driven directly and its round-trip asserted. */
  function makeBridge(caps: Record<string, unknown> | undefined): DownstreamClientBridge {
    return {
      getClientCapabilities: vi.fn(() => caps as any),
      elicitInput: vi.fn(async () => ({ action: "accept", content: { TOKEN: "abc" } }) as any),
      createMessage: vi.fn(
        async () => ({ model: "m", role: "assistant", content: { type: "text", text: "hi" } }) as any,
      ),
      listRoots: vi.fn(async () => ({ roots: [{ uri: "file:///w" }] }) as any),
    };
  }

  /** The `capabilities` the most recent Client was constructed with -- i.e.
   *  what the upstream handshake would declare. */
  function declaredCapabilities(): Record<string, unknown> {
    const last = _sdkBehavior.clientConstructions[_sdkBehavior.clientConstructions.length - 1];
    if (!last) throw new Error("no Client was constructed");
    return last.capabilities;
  }

  function requestHandlerFor(schema: unknown): (request: any, extra: any) => unknown {
    const entry = _sdkBehavior.requestHandlers.find((h) => h.schema === schema);
    if (!entry) throw new Error("no request handler was registered for that schema");
    return entry.handler;
  }

  it("declares elicitation (sub-capabilities verbatim) and round-trips elicitation/create through the bridge", async () => {
    const bridge = makeBridge({ elicitation: { form: {} } });
    await connectToUpstream(makeLocalConfig(), undefined, undefined, bridge);

    expect(declaredCapabilities()).toEqual({ elicitation: { form: {} } });
    const handler = requestHandlerFor(ElicitRequestSchema);

    const params = {
      message: "need TOKEN",
      requestedSchema: { type: "object", properties: { TOKEN: { type: "string" } } },
    };
    const controller = new AbortController();
    const result = await handler({ method: "elicitation/create", params }, { signal: controller.signal });
    expect(bridge.elicitInput).toHaveBeenCalledWith(params, { signal: controller.signal });
    expect(result).toEqual({ action: "accept", content: { TOKEN: "abc" } });
  });

  it("declares nothing and registers no handlers when the downstream client declared nothing", async () => {
    const bridge = makeBridge({});
    await connectToUpstream(makeLocalConfig(), undefined, undefined, bridge);

    expect(declaredCapabilities()).toEqual({});
    expect(_sdkBehavior.requestHandlers).toEqual([]);
  });

  it("declares {} and registers no handlers when no bridge is supplied", async () => {
    await connectToUpstream(makeLocalConfig());

    expect(declaredCapabilities()).toEqual({});
    expect(_sdkBehavior.requestHandlers).toEqual([]);
  });

  it("declares sampling verbatim, forwards sampling/createMessage, and passes rejections through untouched", async () => {
    const bridge = makeBridge({ sampling: { tools: {} } });
    await connectToUpstream(makeLocalConfig(), undefined, undefined, bridge);

    expect(declaredCapabilities()).toEqual({ sampling: { tools: {} } });
    // Only the declared capability got a handler -- no elicitation, no roots.
    expect(_sdkBehavior.requestHandlers.map((h) => h.schema)).toEqual([CreateMessageRequestSchema]);

    const handler = requestHandlerFor(CreateMessageRequestSchema);
    const params = { messages: [], maxTokens: 8 };
    const controller = new AbortController();
    const result = await handler({ method: "sampling/createMessage", params }, { signal: controller.signal });
    expect(bridge.createMessage).toHaveBeenCalledWith(params, { signal: controller.signal });
    expect(result).toEqual({ model: "m", role: "assistant", content: { type: "text", text: "hi" } });

    // A downstream refusal must surface to the upstream as the SAME error,
    // not an invented default result.
    vi.mocked(bridge.createMessage).mockRejectedValueOnce(new Error("downstream refused"));
    await expect(
      handler({ method: "sampling/createMessage", params }, { signal: controller.signal }) as Promise<unknown>,
    ).rejects.toThrow("downstream refused");
  });

  it("declares roots WITHOUT listChanged and forwards roots/list", async () => {
    const bridge = makeBridge({ roots: { listChanged: true } });
    await connectToUpstream(makeLocalConfig(), undefined, undefined, bridge);

    // listChanged is deliberately stripped: yaw-mcp does not forward
    // notifications/roots/list_changed, so it must not advertise them.
    expect(declaredCapabilities()).toEqual({ roots: {} });

    const handler = requestHandlerFor(ListRootsRequestSchema);
    const controller = new AbortController();
    const result = await handler({ method: "roots/list", params: undefined }, { signal: controller.signal });
    expect(bridge.listRoots).toHaveBeenCalledWith(undefined, { signal: controller.signal });
    expect(result).toEqual({ roots: [{ uri: "file:///w" }] });
  });

  it("declares and registers all three when the downstream client declared all three", async () => {
    const bridge = makeBridge({ elicitation: {}, sampling: {}, roots: {} });
    await connectToUpstream(makeLocalConfig(), undefined, undefined, bridge);

    expect(declaredCapabilities()).toEqual({ elicitation: {}, sampling: {}, roots: {} });
    expect(_sdkBehavior.requestHandlers.map((h) => h.schema)).toEqual([
      ElicitRequestSchema,
      CreateMessageRequestSchema,
      ListRootsRequestSchema,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Activation failure categorization (categorizeSpawnError plus the connect
// catch block in connectToUpstreamOnce, upstream.ts). The dispatch and
// activate handlers compose their user-facing messages off `category`, so a
// mis-bucketed failure produces advice that points at the wrong thing ("check
// your PATH" for a server that actually refused the handshake).
// ---------------------------------------------------------------------------

/** Minimal remote server config (no command, no vault involvement). */
function makeRemoteConfig(overrides: Record<string, unknown> = {}): any {
  return {
    id: "remote-srv",
    name: "Remote Server",
    namespace: "test",
    type: "remote",
    url: "https://mcp.example.test/mcp",
    isActive: true,
    ...overrides,
  };
}

describe("connectToUpstream activation failure categories", () => {
  // Kept only so any warn the failure paths emit stays out of the runner's
  // output -- the logger stub forwards warns to the real stderr.
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientClose = () => Promise.resolve();
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("not configured"));
    _sdkBehavior.stdioConstructions = [];
    _sdkBehavior.lastStdioArgs = null;
    _sdkBehavior.remoteConstructions = [];
    _sdkBehavior.notificationHandlers = [];
    resetListHooks();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
    vi.clearAllMocks();
  });

  /** Drive a connect that is expected to fail and hand back the error. */
  async function failedConnect(config: any): Promise<ActivationError> {
    try {
      await connectToUpstream(config);
    } catch (err) {
      return err as ActivationError;
    }
    throw new Error("expected connectToUpstream to reject");
  }

  it("buckets ENOENT as spawn_failure with a PATH-oriented message", async () => {
    // resolveUvSpawn is stubbed to a passthrough for this file, so the command
    // that fails here IS config.command. Production rewrites uvx to a managed
    // binary first -- see the next test for that (messier) shape.
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("spawn uvx ENOENT"));

    const err = await failedConnect(makeLocalConfig({ command: "uvx" }));

    expect(err).toBeInstanceOf(ActivationError);
    expect(err.category).toBe("spawn_failure");
    expect(err.message).toContain("Command 'uvx' is not on PATH or is not executable.");
    expect(err.message).toContain('Fix in ~/.yaw-mcp/bundles.json under "test"');
    // The child never wrote to stderr, so there is no tail to attach.
    expect(err.stderrTail).toBeUndefined();
    expect((err.cause as Error).message).toBe("spawn uvx ENOENT");
  });

  it("names config.command even when the ENOENT is on the MANAGED uv binary", async () => {
    // The production shape: uvx is rewritten to yaw-mcp's own managed uv before
    // the spawn, so an ENOENT/EACCES there is about a binary the user never
    // typed. The message leads with the CONFIG command -- that is the line the
    // operator has to edit -- and then names the path that actually failed,
    // because stopping at "install Python for uvx" advises installing a runtime
    // that is not the missing thing. Both halves are pinned: dropping either
    // sends the reader somewhere they cannot fix.
    const managed = "/home/u/.yaw-mcp/uv/uvx";
    vi.mocked(resolveUvSpawn).mockResolvedValueOnce({ command: managed, args: ["mcp-server-git"] });
    _sdkBehavior.clientConnect = () => Promise.reject(new Error(`spawn ${managed} ENOENT`));

    const err = await failedConnect(makeLocalConfig({ command: "uvx", args: ["mcp-server-git"] }));

    expect(err.category).toBe("spawn_failure");
    expect(_sdkBehavior.stdioConstructions[0]?.command).toBe(managed);
    // The message names the CONFIG command first...
    expect(err.message).toContain("Command 'uvx' is not on PATH or is not executable.");
    expect(err.message).toContain("Python for uvx");
    // ...and then the binary the OS could not actually find.
    expect(err.message).toContain(`The binary that actually failed to spawn was '${managed}'.`);
    // `cause` still carries the raw spawn error with that same path.
    expect((err.cause as Error).message).toContain(managed);
  });

  it("buckets EACCES as spawn_failure too (second categorizer arm)", async () => {
    // Deliberately avoids the ENOENT/"not found" wording so this exercises the
    // permissions arm rather than the first regex.
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("spawn EACCES"));

    const err = await failedConnect(makeLocalConfig({ command: "./server.sh" }));

    expect(err.category).toBe("spawn_failure");
    expect(err.message).toContain("Command './server.sh' is not on PATH or is not executable.");
  });

  it("falls through to 'unknown' and surfaces the raw error when nothing matches", async () => {
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("Error POSTing to endpoint (HTTP 500)"));

    const err = await failedConnect(makeLocalConfig());

    expect(err.category).toBe("unknown");
    // Unknown failures keep the underlying message rather than inventing PATH
    // advice for a server that clearly started.
    expect(err.message).toContain("Error POSTing to endpoint (HTTP 500)");
    expect(err.message).not.toContain("is not on PATH");
    expect(err.message).toContain('Fix in ~/.yaw-mcp/bundles.json under "test"');
  });

  it("buckets a local handshake timeout as init_timeout and attaches the stderr tail", async () => {
    _sdkBehavior.clientConnect = () => {
      // Something WAS written before the child wedged -- that tail is the part
      // that usually explains the hang, so it must survive into the message.
      _sdkBehavior.stderrEmitter?.emit("data", Buffer.from("waiting for database..."));
      // Never settles: the only way out is the connect timer.
      return new Promise<void>(() => {});
    };

    const err = await failedConnect(makeLocalConfig({ connectTimeoutMs: 5 }));

    expect(err.category).toBe("init_timeout");
    expect(err.message).toContain(`Server "test" started but didn't complete the MCP handshake within 0.005s.`);
    expect(err.message).toContain("stderr tail: waiting for database...");
    expect(err.stderrTail).toBe("waiting for database...");
  });

  it("buckets a stderr-producing early exit as install_failure", async () => {
    _sdkBehavior.clientConnect = () => {
      _sdkBehavior.stderrEmitter?.emit("data", Buffer.from("npm ERR! 404 Not Found - @acme/nope"));
      return Promise.reject(new Error("connection closed"));
    };

    const err = await failedConnect(makeLocalConfig());

    expect(err.category).toBe("install_failure");
    expect(err.message).toContain(`Server "test" failed to start. stderr: npm ERR! 404 Not Found - @acme/nope`);
    // The generic wording, specifically: an OOM death must NOT read like this.
    expect(err.message).not.toContain("OAM_MAX_HEAP_MB");
  });

  it("names OAM_MAX_HEAP_MB when an oam-hosted child dies on its heap cap", async () => {
    // oam exits 134 with error[OAM-RT-OOM] instead of node's ungraceful
    // "Ineffective mark-compacts" abort. The category is unchanged -- it really
    // is "exited non-zero before handshake" -- but a bare "failed to start"
    // buries the one lever that fixes it inside a 500-char stderr tail.
    _sdkBehavior.clientConnect = () => {
      _sdkBehavior.stderrEmitter?.emit(
        "data",
        Buffer.from("error[OAM-RT-OOM]: JavaScript heap out of memory -- reached the 4096 MB cap (default 4 GiB)"),
      );
      return Promise.reject(new Error("connection closed"));
    };

    const err = await failedConnect(makeLocalConfig());

    expect(err.category).toBe("install_failure");
    expect(err.message).toContain(`Server "test" ran out of memory.`);
    expect(err.message).toContain("OAM_MAX_HEAP_MB");
    // Both escape hatches, and the raw banner is still carried for diagnosis.
    expect(err.message).toContain("bundles.json");
    expect(err.message).toContain("OAM-RT-OOM");
  });

  it("wraps a resolver failure as an ActivationError carrying the config pointer", async () => {
    // The connect try/catch wraps client.connect() ONLY, so a throw out of
    // resolveUvSpawn (ensureUv: unsupported platform, download or checksum
    // failure) or out of the oam machinery used to escape as a bare Error --
    // no category, no stderr tail, and none of the "Fix in ..." pointer every
    // other local spawn failure carries. Callers branching on
    // `err instanceof ActivationError` then treated it as a transport error.
    vi.mocked(resolveUvSpawn).mockRejectedValueOnce(
      new Error("uv archive checksum mismatch (expected abc123, got def456)"),
    );

    const err = await failedConnect(makeLocalConfig({ command: "uvx", args: ["mcp-server-git"] }));

    expect(err).toBeInstanceOf(ActivationError);
    expect(err.category).toBe("unknown");
    expect(err.message).toContain("uv archive checksum mismatch (expected abc123, got def456)");
    expect(err.message).toContain('Fix in ~/.yaw-mcp/bundles.json under "test"');
    // The resolver threw before any transport was constructed.
    expect(_sdkBehavior.stdioConstructions).toHaveLength(0);
  });

  it("rejects a local config with no command before anything is spawned", async () => {
    const err = await connectToUpstream(makeLocalConfig({ command: undefined })).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ActivationError);
    expect((err as Error).message).toBe("command is required for local servers");
    expect(_sdkBehavior.stdioConstructions).toHaveLength(0);
  });

  it("rejects a remote config with no url before any transport is built", async () => {
    const err = await connectToUpstream(makeRemoteConfig({ url: undefined })).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ActivationError);
    expect((err as Error).message).toBe("url is required for remote servers");
    expect(_sdkBehavior.remoteConstructions).toHaveLength(0);
  });

  it("buckets a remote timeout as init_timeout naming the URL, not the command", async () => {
    _sdkBehavior.clientConnect = () => new Promise<void>(() => {});

    const err = await failedConnect(makeRemoteConfig({ connectTimeoutMs: 5 }));

    expect(err.category).toBe("init_timeout");
    expect(err.message).toContain(
      "Remote server at https://mcp.example.test/mcp did not respond within 0.005s. Verify the URL is reachable.",
    );
    // Remote failures never carry a child stderr tail.
    expect(err.stderrTail).toBeUndefined();
  });

  it("buckets a remote connection refusal as protocol_error", async () => {
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("fetch failed"));

    const err = await failedConnect(makeRemoteConfig());

    expect(err.category).toBe("protocol_error");
    expect(err.message).toContain("Remote server at https://mcp.example.test/mcp refused the connection.");
  });

  it("selects the SSE transport only when transport is 'sse'", async () => {
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("fetch failed"));

    await failedConnect(makeRemoteConfig({ transport: "sse", url: "https://mcp.example.test/sse" }));
    await failedConnect(makeRemoteConfig());

    // `opts` is always passed now (carrying requestInit, undefined when the
    // entry has no headers), so assert on the fields this test is about
    // rather than on whole-object equality.
    expect(_sdkBehavior.remoteConstructions.map(({ kind, url }) => ({ kind, url }))).toEqual([
      { kind: "sse", url: "https://mcp.example.test/sse" },
      { kind: "http", url: "https://mcp.example.test/mcp" },
    ]);
    // No headers on these entries, so nothing is put on the wire.
    for (const c of _sdkBehavior.remoteConstructions) {
      expect(c.opts?.requestInit).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Remote-entry diagnostics. bundles.json validation is looser than the remote
// branch of connectToUpstream: it accepts an `env` map and a "stdio" transport
// on a remote entry, neither of which the branch can honour. Both used to be
// dropped in silence, so the operator saw only an unexplained 401 or an
// HTTP-shaped failure against a URL they thought spoke stdio.
// ---------------------------------------------------------------------------

describe("connectToUpstream remote-entry diagnostics", () => {
  // Every case here deliberately trips a warn, and the logger stub forwards
  // warns to the real stderr; capture them so the runner's output stays clean.
  // The assertions read the log mock (see warnings()), not these writes.
  let stderr: { restore: () => void; writes: string[] };

  beforeEach(() => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);
    _sdkBehavior.clientClose = () => Promise.resolve();
    // Fail the connect: the diagnostics all fire in the transport-selection
    // branch, well before the handshake, so the reject keeps the test short.
    _sdkBehavior.clientConnect = () => Promise.reject(new Error("fetch failed"));
    _sdkBehavior.remoteConstructions = [];
    resetListHooks();
    resetOamDowngrades();
    vi.mocked(defaultRuntime).mockResolvedValue(null);
    vi.mocked(log).mockClear();
    stderr = captureStderr();
  });

  afterEach(() => {
    stderr.restore();
    vi.clearAllMocks();
  });

  /** Warn-level messages emitted during the call, in order. */
  function warnings(): string[] {
    return vi
      .mocked(log)
      .mock.calls.filter((c) => c[0] === "warn")
      .map((c) => String(c[1]));
  }

  it("warns that a remote entry's env (and its ${secret:...} refs) is never sent", async () => {
    await connectToUpstream(makeRemoteConfig({ env: { TOKEN: "${secret:TOKEN}" } })).catch(() => {});

    const warned = warnings().filter((m) => m.includes("Ignoring env on a remote server"));
    expect(warned).toHaveLength(1);
    // The key names go in the structured field so the operator can see WHICH
    // vars were dropped without the value ever being logged.
    const call = vi.mocked(log).mock.calls.find((c) => String(c[1]).includes("Ignoring env on a remote server"));
    expect(call?.[2]).toMatchObject({ namespace: "test", keys: ["TOKEN"] });
  });

  it("stays quiet for a remote entry with no env, or an empty one", async () => {
    await connectToUpstream(makeRemoteConfig()).catch(() => {});
    await connectToUpstream(makeRemoteConfig({ env: {} })).catch(() => {});
    expect(warnings().filter((m) => m.includes("Ignoring env on a remote server"))).toHaveLength(0);
  });

  // `headers` is the ONLY credential channel a remote upstream has: it spawns
  // no process, so there is no env to put one in. Before it existed, the only
  // remote servers reachable were the ones taking their credential in the URL
  // -- which is why the public catalog wraps fifteen HTTPS endpoints in the
  // `mcp-remote` npx shim rather than configuring them as remote entries.

  it("puts resolved headers on the transport's requestInit, for both transports", async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(false);

    await connectToUpstream(makeRemoteConfig({ headers: { Authorization: "Bearer tok", "X-Trace": "1" } })).catch(
      () => {},
    );
    await connectToUpstream(
      makeRemoteConfig({
        transport: "sse",
        url: "https://mcp.example.test/sse",
        headers: { Authorization: "Bearer tok" },
      }),
    ).catch(() => {});

    const [http, sse] = _sdkBehavior.remoteConstructions;
    expect(http.kind).toBe("http");
    expect(http.opts?.requestInit?.headers).toEqual({ Authorization: "Bearer tok", "X-Trace": "1" });
    // SSE matters as much as HTTP here: its GET stream applies requestInit
    // headers inside the custom fetch it hands EventSource, so an
    // http-only wiring would leave every sse entry unauthenticated.
    expect(sse.kind).toBe("sse");
    expect(sse.opts?.requestInit?.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("resolves ${secret:...} in a header value through the vault", async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    vi.mocked(loadVault).mockResolvedValue({} as never);
    vi.mocked(unlock).mockResolvedValue(Buffer.alloc(32));
    vi.mocked(resolveSecretRefs).mockReturnValue({
      resolved: { Authorization: "Bearer real-token" },
      missing: [],
      malformed: [],
    } as never);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "pw";

    try {
      await connectToUpstream(makeRemoteConfig({ headers: { Authorization: "Bearer ${secret:tok}" } })).catch(() => {});
      const [c] = _sdkBehavior.remoteConstructions;
      expect(c.opts?.requestInit?.headers).toEqual({ Authorization: "Bearer real-token" });
      // The literal must never be what goes out: some servers would treat the
      // placeholder as a real credential, and this one reaches a third party
      // rather than a child process.
      expect(JSON.stringify(c.opts)).not.toContain("${secret:");
    } finally {
      process.env.YAW_MCP_VAULT_PASSPHRASE = undefined;
    }
  });

  it("refuses the connect when a header secret cannot be resolved, building no transport at all", async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "";

    try {
      await expect(
        connectToUpstream(makeRemoteConfig({ headers: { Authorization: "Bearer ${secret:tok}" } })),
      ).rejects.toThrow(/vault locked: server headers references/);
      // Fail-closed means the request never leaves: no transport is
      // constructed, so nothing reaches the remote host -- not even a
      // connection attempt it could log.
      expect(_sdkBehavior.remoteConstructions).toHaveLength(0);
    } finally {
      process.env.YAW_MCP_VAULT_PASSPHRASE = undefined;
    }
  });

  it("says `headers` when it refuses, not `env`", async () => {
    // The wording is the whole fix for someone staring at the refusal: the
    // two maps fail identically, and pointing at the wrong one sends them to
    // edit a block that is ignored on a remote entry anyway.
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "";
    try {
      await connectToUpstream(makeRemoteConfig({ headers: { Authorization: "${secret:tok}" } })).catch((e: Error) => {
        expect(e.message).toContain("server headers references");
        expect(e.message).not.toContain("server env references");
      });
    } finally {
      process.env.YAW_MCP_VAULT_PASSPHRASE = undefined;
    }
  });

  it("refuses a header value carrying CR/LF/NUL, naming the header but never the value", async () => {
    // Node's Headers throws a raw TypeError on these, from inside the SDK
    // constructor -- outside the try that classifies a malformed url. Before
    // this guard the user was told `Remote server at <url> refused the
    // connection`, which is a lie: nothing was ever sent, and it points them
    // at the remote server instead of their own config.
    vi.mocked(hasSecretRefs).mockReturnValue(false);

    for (const bad of ["v\r\nX-Injected: 1", "v\nx", "v\0x"]) {
      _sdkBehavior.remoteConstructions = [];
      await expect(
        connectToUpstream(makeRemoteConfig({ headers: { "X-Bad": bad, Authorization: "Bearer fine" } })),
      ).rejects.toThrow(/header "X-Bad" has a value containing a newline or NUL/);
      // Refused BEFORE the transport exists, so nothing reaches the wire.
      expect(_sdkBehavior.remoteConstructions).toHaveLength(0);
    }
  });

  it("keeps the offending header VALUE out of the error, because it may be a decrypted secret", async () => {
    // The check runs after vault resolution, so the bad value can be a secret
    // the vault just decrypted. Reporting it would undo the point of the vault.
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    vi.mocked(loadVault).mockResolvedValue({} as never);
    vi.mocked(unlock).mockResolvedValue(Buffer.alloc(32));
    vi.mocked(resolveSecretRefs).mockReturnValue({
      resolved: { Authorization: "Bearer sup3r-s3cret\nX-Injected: 1" },
      missing: [],
      malformed: [],
    } as never);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "pw";
    try {
      await connectToUpstream(makeRemoteConfig({ headers: { Authorization: "Bearer ${secret:tok}" } })).catch(
        (e: Error) => {
          expect(e.message).toContain('header "Authorization"');
          expect(e.message).not.toContain("sup3r-s3cret");
        },
      );
    } finally {
      process.env.YAW_MCP_VAULT_PASSPHRASE = undefined;
    }
  });

  it("passes no requestInit for a remote entry with no headers", async () => {
    await connectToUpstream(makeRemoteConfig()).catch(() => {});
    await connectToUpstream(makeRemoteConfig({ headers: {} })).catch(() => {});
    for (const c of _sdkBehavior.remoteConstructions) {
      expect(c.opts?.requestInit).toBeUndefined();
    }
  });

  it('warns that transport "stdio" on a remote entry falls through to streamable-http', async () => {
    await connectToUpstream(makeRemoteConfig({ transport: "stdio" })).catch(() => {});

    expect(warnings().some((m) => m.includes('transport "stdio"') && m.includes("streamable-http"))).toBe(true);
    // ...and the fallthrough itself is unchanged: still streamable-http.
    expect(_sdkBehavior.remoteConstructions.map(({ kind, url }) => ({ kind, url }))).toEqual([
      { kind: "http", url: "https://mcp.example.test/mcp" },
    ]);
  });

  it('stays quiet for the honoured remote transports ("sse" and the default)', async () => {
    await connectToUpstream(makeRemoteConfig({ transport: "sse" })).catch(() => {});
    await connectToUpstream(makeRemoteConfig({ transport: "streamable-http" })).catch(() => {});
    await connectToUpstream(makeRemoteConfig()).catch(() => {});
    expect(warnings().some((m) => m.includes('transport "stdio"'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyVaultPassphrase -- the pre-flight check that keeps an unverified
// passphrase out of module-global state. Storing first and discovering the
// typo later is not equivalent: by then the bad value already shadows a
// possibly-correct YAW_MCP_VAULT_PASSPHRASE for every later resolve.
// ---------------------------------------------------------------------------

describe("verifyVaultPassphrase", () => {
  afterEach(() => {
    vi.clearAllMocks();
    clearSessionVaultPassphrase();
  });

  it("returns true when the passphrase unlocks the vault", async () => {
    const fakeVault = { version: 1, salt: "abc", entries: { A: {} } } as any;
    vi.mocked(loadVault).mockResolvedValue(fakeVault);
    vi.mocked(unlock).mockResolvedValue(Buffer.from("k"));

    await expect(verifyVaultPassphrase("right")).resolves.toBe(true);
    expect(vi.mocked(unlock)).toHaveBeenCalledWith(fakeVault, "right");
  });

  it("returns false when the passphrase does not unlock the vault", async () => {
    vi.mocked(loadVault).mockResolvedValue({ version: 1, salt: "abc", entries: { A: {} } } as any);
    vi.mocked(unlock).mockRejectedValue(new Error("wrong passphrase for this vault (decryption failed)"));

    await expect(verifyVaultPassphrase("wrong")).resolves.toBe(false);
  });

  it("returns false for an empty passphrase without touching the vault", async () => {
    await expect(verifyVaultPassphrase("")).resolves.toBe(false);
    expect(vi.mocked(loadVault)).not.toHaveBeenCalled();
  });

  it("accepts the passphrase when the vault's CHECK MARKER is corrupt", async () => {
    // That error means the passphrase is RIGHT and the marker is damaged.
    // Rejecting it would ask the user to re-type something that was never
    // wrong, and the retype would fail identically.
    vi.mocked(loadVault).mockResolvedValue({ version: 1, salt: "abc", entries: { A: {} } } as any);
    vi.mocked(unlock).mockRejectedValue(new Error(VAULT_CHECK_CORRUPT_ERROR));

    await expect(verifyVaultPassphrase("actually-correct")).resolves.toBe(true);
  });

  it("does not reject a passphrase when there is no vault to verify against", async () => {
    // unlock() accepts anything for an absent/empty vault, and the real
    // refusal for that case ("no vault exists yet") is resolveServerEnv's to
    // report -- with wording that tells the user to create one.
    vi.mocked(loadVault).mockResolvedValue(null);

    await expect(verifyVaultPassphrase("anything")).resolves.toBe(true);
  });

  it("does not blame the passphrase for an unreadable vault", async () => {
    vi.mocked(loadVault).mockRejectedValue(new Error("EACCES: permission denied"));

    await expect(verifyVaultPassphrase("fine")).resolves.toBe(true);
  });

  it("commits nothing to module state on a passphrase that verifies TRUE", async () => {
    // The whole reason this function exists: it CHECKS. Installing the value it
    // just verified would make "verify, then decide" impossible and quietly
    // displace whatever the session (or the env var) already holds.
    setSessionVaultPassphrase("already-committed");
    vi.mocked(loadVault).mockResolvedValue({ version: 1, salt: "abc", entries: { A: {} } } as any);
    vi.mocked(unlock).mockResolvedValue(Buffer.from("k"));

    await expect(verifyVaultPassphrase("a-different-one")).resolves.toBe(true);
    expect(vaultPassphrase()).toBe("already-committed");
  });

  it("commits nothing to module state on a passphrase that verifies FALSE", async () => {
    // The failure direction matters more: a typo that displaced a working
    // passphrase would break every later resolve in the session.
    setSessionVaultPassphrase("already-committed");
    vi.mocked(loadVault).mockResolvedValue({ version: 1, salt: "abc", entries: { A: {} } } as any);
    vi.mocked(unlock).mockRejectedValue(new Error("wrong passphrase for this vault (decryption failed)"));

    await expect(verifyVaultPassphrase("typo")).resolves.toBe(false);
    expect(vaultPassphrase()).toBe("already-committed");
  });
});

// ---------------------------------------------------------------------------
// A WRONG passphrase has to be answerable, not a dead end. Before this it
// threw a raw unlock error, which reached the generic missing-credential path
// where the internal-key filter (correctly) refuses to elicit yaw-mcp's own
// secrets -- so nothing could offer a correction and every vault-backed
// server failed for the life of the process.
// ---------------------------------------------------------------------------

describe("resolveServerEnv -- wrong passphrase", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    clearSessionVaultPassphrase();
  });

  it('throws VaultPassphraseRequiredError with reason "invalid" when unlock fails', async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "wrong";
    vi.mocked(loadVault).mockResolvedValue({ version: 1, salt: "abc", entries: { MY_TOKEN: {} } } as any);
    vi.mocked(unlock).mockRejectedValue(new Error("wrong passphrase for this vault (decryption failed)"));

    const config = makeLocalConfig({ env: { TOKEN: "${secret:MY_TOKEN}" } });

    let err: unknown;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(VaultPassphraseRequiredError);
    const vaultErr = err as VaultPassphraseRequiredError;
    expect(vaultErr.reason).toBe("invalid");
    expect(vaultErr.refKeys).toEqual(["TOKEN"]);
    // Must not claim the var is unset -- it is set, and wrong.
    expect(vaultErr.message).toContain("does not unlock the vault");
  });

  it("re-throws a CORRUPT CHECK MARKER untouched rather than blaming the passphrase", async () => {
    // Here the passphrase is correct and the vault is damaged. Turning this
    // into a prompt would ask for a passphrase that was never wrong.
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    process.env.YAW_MCP_VAULT_PASSPHRASE = "correct";
    vi.mocked(loadVault).mockResolvedValue({ version: 1, salt: "abc", entries: { MY_TOKEN: {} } } as any);
    vi.mocked(unlock).mockRejectedValue(new Error(VAULT_CHECK_CORRUPT_ERROR));

    const config = makeLocalConfig({ env: { TOKEN: "${secret:MY_TOKEN}" } });

    let err: unknown;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e;
    }

    expect(err).not.toBeInstanceOf(VaultPassphraseRequiredError);
    expect((err as Error).message).toContain(VAULT_CHECK_CORRUPT_ERROR);
  });

  it('still reports reason "missing" when no passphrase exists at all', async () => {
    vi.mocked(hasSecretRefs).mockReturnValue(true);
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;

    const config = makeLocalConfig({ env: { TOKEN: "${secret:MY_TOKEN}" } });

    let err: unknown;
    try {
      await connectToUpstream(config);
    } catch (e) {
      err = e;
    }

    expect((err as VaultPassphraseRequiredError).reason).toBe("missing");
  });
});
