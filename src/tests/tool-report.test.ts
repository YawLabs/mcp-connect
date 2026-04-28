import { request } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must mock undici before importing tool-report.
vi.mock("undici", () => ({
  request: vi.fn().mockResolvedValue({
    statusCode: 200,
    body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
  }),
}));

import { getLastReportFailure, initToolReport, reportTools } from "../tool-report.js";

const mockedRequest = vi.mocked(request);

describe("tool-report failure latch", () => {
  beforeEach(() => {
    mockedRequest.mockResolvedValue({
      statusCode: 200,
      body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
    } as never);
  });

  afterEach(() => {
    mockedRequest.mockReset();
  });

  it("captures a 401 with statusCode/url/at and exposes it via the getter", async () => {
    mockedRequest.mockResolvedValueOnce({
      statusCode: 401,
      body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
    } as never);

    initToolReport("https://example.com", "test-token");
    await reportTools("srv-abc", [{ name: "ping" }]);

    const latch = getLastReportFailure();
    expect(latch).not.toBeNull();
    expect(latch?.statusCode).toBe(401);
    expect(latch?.url).toBe("https://example.com/api/connect/servers/srv-abc/tools");
    expect(typeof latch?.at).toBe("number");
  });

  it("clears the latch on a subsequent 2xx", async () => {
    // Set the latch via a 401.
    mockedRequest.mockResolvedValueOnce({
      statusCode: 401,
      body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
    } as never);
    initToolReport("https://example.com", "test-token");
    await reportTools("srv-abc", [{ name: "ping" }]);
    expect(getLastReportFailure()).not.toBeNull();

    // Next call returns 200; latch should clear.
    mockedRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
    } as never);
    await reportTools("srv-abc", [{ name: "ping" }]);
    expect(getLastReportFailure()).toBeNull();
  });

  it("does NOT set the latch on a 404 (legacy backend)", async () => {
    // 404 is treated as expected on older mcp.hosting deployments. It
    // must not pollute doctor output -- existing fail-silent behavior
    // preserved. We seed a known-clear state via a 200, then issue a
    // 404, then assert the latch did not flip.
    mockedRequest.mockResolvedValueOnce({
      statusCode: 200,
      body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
    } as never);
    initToolReport("https://example.com", "test-token");
    await reportTools("srv-abc", [{ name: "ping" }]);
    expect(getLastReportFailure()).toBeNull();

    mockedRequest.mockResolvedValueOnce({
      statusCode: 404,
      body: { text: vi.fn().mockResolvedValue(""), json: vi.fn().mockResolvedValue({}) },
    } as never);
    await reportTools("srv-abc", [{ name: "ping" }]);
    expect(getLastReportFailure()).toBeNull();
  });
});
