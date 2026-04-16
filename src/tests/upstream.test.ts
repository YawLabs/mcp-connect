import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROMPTS_PER_SERVER,
  MAX_RESOURCES_PER_SERVER,
  MAX_TOOLS_PER_SERVER,
  fetchPromptsFromUpstream,
  fetchResourcesFromUpstream,
  fetchToolsFromUpstream,
} from "../upstream.js";

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
    const tools = Array.from({ length: MAX_TOOLS_PER_SERVER + 25 }, (_, i) => ({
      name: `t${i}`,
      inputSchema: { type: "object" },
    }));
    const client = makeClient({ listTools: vi.fn().mockResolvedValue({ tools }) });

    const out = await fetchToolsFromUpstream(client, "ns");
    expect(out).toHaveLength(MAX_TOOLS_PER_SERVER);
    // First tool preserved, last one is index MAX-1 (the tail is dropped).
    expect(out[0].name).toBe("t0");
    expect(out[MAX_TOOLS_PER_SERVER - 1].name).toBe(`t${MAX_TOOLS_PER_SERVER - 1}`);
    expect(stderr.writes.some((w) => w.includes("truncating") && w.includes('"reported":1025'))).toBe(true);
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
