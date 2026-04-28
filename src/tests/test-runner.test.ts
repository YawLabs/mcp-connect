import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// Test runner — pulls dashboard-initiated probe requests off the queue,
// runs a quick activate-then-disconnect, posts results back. Coverage:
//
//   1. Skips silently when not initialized (no apiUrl/token).
//   2. Stops polling on 404 (older mcp.hosting deploy without endpoint).
//   3. Failed activation produces failed result with category + message.
//   4. Successful activation produces passed result with toolCount.
//   5. Server missing from current config produces typed not_in_config.
//   6. Disabled server produces typed `disabled` result without spawning.
// ═══════════════════════════════════════════════════════════════════════

vi.mock("undici", () => ({
  request: vi.fn(),
}));

vi.mock("../upstream.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    connectToUpstream: vi.fn(),
    disconnectFromUpstream: vi.fn().mockResolvedValue(undefined),
  };
});

import { request } from "undici";
import { __testRunnerConsecutive404, initTestRunner, startTestRunner, stopTestRunner } from "../test-runner.js";
import type { ConnectConfig, UpstreamConnection, UpstreamServerConfig } from "../types.js";
import { ActivationError, connectToUpstream } from "../upstream.js";

function mockListResponse(requests: Array<{ requestId: string; serverId: string }>) {
  return {
    statusCode: 200,
    body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({ requests }) },
  };
}

function mockEmptyResponse() {
  return mockListResponse([]);
}

function mockStatusResponse(statusCode: number) {
  return {
    statusCode,
    body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
  };
}

function mockOkPost() {
  return {
    statusCode: 200,
    body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({ ok: true }) },
  };
}

function makeServerConfig(overrides: Partial<UpstreamServerConfig> = {}): UpstreamServerConfig {
  return {
    id: "srv-id",
    name: "Test",
    namespace: "test",
    type: "local",
    command: "echo",
    isActive: true,
    ...overrides,
  };
}

function makeConnection(tools: string[] = []): UpstreamConnection {
  return {
    config: makeServerConfig(),
    client: { close: vi.fn() } as any,
    transport: {} as any,
    tools: tools.map((name) => ({ name, namespacedName: `t_${name}`, inputSchema: { type: "object" } })),
    resources: [],
    prompts: [],
    health: { totalCalls: 0, errorCount: 0, totalLatencyMs: 0 },
    status: "connected",
  } as UpstreamConnection;
}

// Helper to surface the internal poller for assertions.
async function tickPoll(): Promise<void> {
  // The runner schedules its first poll via setTimeout(POLL_INTERVAL_MS).
  // We advance the timers until the first poll completes, so tests
  // don't block on a real 30-second clock.
  await vi.advanceTimersByTimeAsync(31_000);
  // Settle any pending microtasks the poll spawned.
  await Promise.resolve();
}

describe("test runner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopTestRunner();
    vi.useRealTimers();
  });

  it("does nothing when not initialized", async () => {
    startTestRunner();
    await tickPoll();
    expect(vi.mocked(request)).not.toHaveBeenCalled();
  });

  it("polls the pending-requests endpoint at the configured interval", async () => {
    initTestRunner("https://mcp.hosting", "tok", () => null);
    vi.mocked(request).mockResolvedValue(mockEmptyResponse() as any);
    startTestRunner();
    await tickPoll();
    expect(vi.mocked(request)).toHaveBeenCalledTimes(1);
    const callUrl = String(vi.mocked(request).mock.calls[0][0]);
    expect(callUrl).toContain("/api/connect/test-requests");
  });

  it("keeps polling on a single 404 (transient deploy / CDN edge cache miss)", async () => {
    initTestRunner("https://mcp.hosting", "tok", () => null);
    vi.mocked(request).mockResolvedValue(mockStatusResponse(404) as any);
    startTestRunner();
    await tickPoll();
    expect(__testRunnerConsecutive404()).toBe(1);
    // A second tick should still fire a fetch -- the runner has not stopped.
    await tickPoll();
    expect(vi.mocked(request)).toHaveBeenCalledTimes(2);
    expect(__testRunnerConsecutive404()).toBe(2);
    stopTestRunner();
  });

  it("stops polling after a sustained 404 streak (endpoint genuinely gone)", async () => {
    initTestRunner("https://mcp.hosting", "tok", () => null);
    vi.mocked(request).mockResolvedValue(mockStatusResponse(404) as any);
    startTestRunner();
    // 10 consecutive 404s should trip the limit.
    for (let i = 0; i < 10; i++) await tickPoll();
    const callsAtLimit = vi.mocked(request).mock.calls.length;
    // After the limit fires, stopTestRunner has run; further ticks don't fetch.
    await tickPoll();
    await tickPoll();
    expect(vi.mocked(request).mock.calls.length).toBe(callsAtLimit);
  });

  it("a successful 200 resets the consecutive-404 counter", async () => {
    initTestRunner("https://mcp.hosting", "tok", () => null);
    let callCount = 0;
    vi.mocked(request).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return mockStatusResponse(404) as any;
      if (callCount === 2) return mockEmptyResponse() as any; // 200 with no work
      return mockStatusResponse(404) as any;
    });
    startTestRunner();
    await tickPoll();
    expect(__testRunnerConsecutive404()).toBe(1);
    await tickPoll();
    expect(__testRunnerConsecutive404()).toBe(0);
    await tickPoll();
    expect(__testRunnerConsecutive404()).toBe(1);
    stopTestRunner();
  });

  it("posts not_in_config when the server isn't in the current config", async () => {
    const config: ConnectConfig = { servers: [], configVersion: "v1" };
    initTestRunner("https://mcp.hosting", "tok", () => config);
    vi.mocked(request).mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.endsWith("/api/connect/test-requests")) {
        return mockListResponse([{ requestId: "req-1", serverId: "missing-id" }]) as any;
      }
      if (u.includes("/result")) return mockOkPost() as any;
      return mockEmptyResponse() as any;
    });
    startTestRunner();
    await tickPoll();
    const postCall = vi.mocked(request).mock.calls.find((c) => String(c[0]).includes("/result"));
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as any).body);
    expect(body.status).toBe("failed");
    expect(body.errorCategory).toBe("not_in_config");
  });

  it("posts disabled without spawning when the server is disabled", async () => {
    const config: ConnectConfig = {
      servers: [makeServerConfig({ id: "off-id", isActive: false })],
      configVersion: "v1",
    };
    initTestRunner("https://mcp.hosting", "tok", () => config);
    vi.mocked(request).mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.endsWith("/api/connect/test-requests")) {
        return mockListResponse([{ requestId: "req-1", serverId: "off-id" }]) as any;
      }
      return mockOkPost() as any;
    });
    startTestRunner();
    await tickPoll();
    expect(vi.mocked(connectToUpstream)).not.toHaveBeenCalled();
    const postCall = vi.mocked(request).mock.calls.find((c) => String(c[0]).includes("/result"));
    const body = JSON.parse((postCall![1] as any).body);
    expect(body.status).toBe("failed");
    expect(body.errorCategory).toBe("disabled");
  });

  it("posts passed + toolCount when activation succeeds", async () => {
    const config: ConnectConfig = {
      servers: [makeServerConfig({ id: "ok-id" })],
      configVersion: "v1",
    };
    initTestRunner("https://mcp.hosting", "tok", () => config);
    vi.mocked(connectToUpstream).mockResolvedValue(makeConnection(["a", "b", "c"]));
    vi.mocked(request).mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.endsWith("/api/connect/test-requests")) {
        return mockListResponse([{ requestId: "req-1", serverId: "ok-id" }]) as any;
      }
      return mockOkPost() as any;
    });
    startTestRunner();
    await tickPoll();
    const postCall = vi.mocked(request).mock.calls.find((c) => String(c[0]).includes("/result"));
    const body = JSON.parse((postCall![1] as any).body);
    expect(body.status).toBe("passed");
    expect(body.toolCount).toBe(3);
  });

  it("posts failed + category when activation throws ActivationError", async () => {
    const config: ConnectConfig = {
      servers: [makeServerConfig({ id: "bad-id" })],
      configVersion: "v1",
    };
    initTestRunner("https://mcp.hosting", "tok", () => config);
    vi.mocked(connectToUpstream).mockRejectedValue(
      new ActivationError("Server failed: stderr: Error: missing env", "install_failure", "Error: missing env"),
    );
    vi.mocked(request).mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.endsWith("/api/connect/test-requests")) {
        return mockListResponse([{ requestId: "req-1", serverId: "bad-id" }]) as any;
      }
      return mockOkPost() as any;
    });
    startTestRunner();
    await tickPoll();
    const postCall = vi.mocked(request).mock.calls.find((c) => String(c[0]).includes("/result"));
    const body = JSON.parse((postCall![1] as any).body);
    expect(body.status).toBe("failed");
    expect(body.errorCategory).toBe("install_failure");
    expect(body.message).toContain("missing env");
  });
});
