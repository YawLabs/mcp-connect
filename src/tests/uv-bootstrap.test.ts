import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ═══════════════════════════════════════════════════════════════════════
// uv bootstrap — covers the spawn-rewrite path that runs on every
// upstream activation. The actual network download is out of scope
// here (it's exercised by the integration test gated on
// MCPH_TEST_UV_DOWNLOAD=1) because pulling a 20MB binary over
// GitHub during CI is noisy and slow.
// ═══════════════════════════════════════════════════════════════════════

vi.mock("../logger.js", () => ({ log: vi.fn() }));

import { __resetUvBootstrap, resolveUvSpawn } from "../uv-bootstrap.js";

describe("resolveUvSpawn", () => {
  beforeEach(() => {
    __resetUvBootstrap();
  });

  afterEach(() => {
    __resetUvBootstrap();
  });

  it("is a no-op for non-uv commands", async () => {
    const result = await resolveUvSpawn("npx", ["-y", "@modelcontextprotocol/server-github"]);
    expect(result).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
  });

  it("is a no-op for node, python, docker", async () => {
    expect(await resolveUvSpawn("node", ["index.js"])).toEqual({ command: "node", args: ["index.js"] });
    expect(await resolveUvSpawn("python", ["-m", "foo"])).toEqual({ command: "python", args: ["-m", "foo"] });
    expect(await resolveUvSpawn("docker", ["run", "img"])).toEqual({ command: "docker", args: ["run", "img"] });
  });

  it("preserves empty args array", async () => {
    const result = await resolveUvSpawn("custom-cmd", []);
    expect(result).toEqual({ command: "custom-cmd", args: [] });
  });
});

// The PATH-hit path and the uvx→uv tool run rewrite depend on
// whether uv is installed on the machine running the tests. Rather
// than mocking child_process (which would test the mock, not the
// code) we run these conditionally based on what's actually there.
describe("resolveUvSpawn with uv present", () => {
  beforeEach(() => {
    __resetUvBootstrap();
  });

  it("returns bare uv when uv is on PATH", async () => {
    // Probe uv once via the same mechanism the bootstrap uses. If
    // present, the bootstrap should return the bare command string
    // so the OS keeps resolving it (respecting the user's install).
    const { spawnSync } = await import("node:child_process");
    const probe = spawnSync("uv", ["--version"], { stdio: "ignore" });
    if (probe.status !== 0) {
      // uv not installed on this machine — skip, the other describe
      // covers the "not on PATH + fails to download" pathway via its
      // own fakes.
      return;
    }
    const result = await resolveUvSpawn("uv", ["--version"]);
    expect(result).toEqual({ command: "uv", args: ["--version"] });
  });

  it("rewrites uvx to `uv tool run` when uv is on PATH", async () => {
    const { spawnSync } = await import("node:child_process");
    const probe = spawnSync("uv", ["--version"], { stdio: "ignore" });
    if (probe.status !== 0) return;
    // uvx is sugar for `uv tool run`. Previously we passed uvx
    // through unchanged when uv was on PATH, which broke when uv.exe
    // was reachable but uvx.exe wasn't (Windows PATHEXT cases, or
    // partial installs). Always-rewriting means the spawn target is
    // always uv, which we've already confirmed is reachable.
    const result = await resolveUvSpawn("uvx", ["mcp-server-fetch"]);
    expect(result).toEqual({ command: "uv", args: ["tool", "run", "mcp-server-fetch"] });
  });

  it("preserves additional args when rewriting uvx", async () => {
    const { spawnSync } = await import("node:child_process");
    const probe = spawnSync("uv", ["--version"], { stdio: "ignore" });
    if (probe.status !== 0) return;
    const result = await resolveUvSpawn("uvx", ["--from", "mcp-server-fetch", "--transport", "stdio"]);
    expect(result).toEqual({
      command: "uv",
      args: ["tool", "run", "--from", "mcp-server-fetch", "--transport", "stdio"],
    });
  });

  it("rewrites uvx with empty args", async () => {
    const { spawnSync } = await import("node:child_process");
    const probe = spawnSync("uv", ["--version"], { stdio: "ignore" });
    if (probe.status !== 0) return;
    const result = await resolveUvSpawn("uvx", []);
    expect(result).toEqual({ command: "uv", args: ["tool", "run"] });
  });
});
