import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIRNAME } from "../paths.js";
import { parseServersArgs, runServersCommand } from "../servers-cmd.js";
import type { ConnectConfig, UpstreamServerConfig } from "../types.js";

function makeServer(over: Partial<UpstreamServerConfig> = {}): UpstreamServerConfig {
  return {
    id: "srv-1",
    name: "Example",
    namespace: "ex",
    type: "remote",
    isActive: true,
    ...over,
  };
}

function captureIO(): { out: string[]; err: string[]; push: (s: string) => void; pushErr: (s: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    push: (s: string) => {
      out.push(s);
    },
    pushErr: (s: string) => {
      err.push(s);
    },
  };
}

describe("parseServersArgs", () => {
  it("defaults to json=false with no args", () => {
    expect(parseServersArgs([])).toEqual({ ok: true, options: { json: false } });
  });

  it("accepts --json", () => {
    expect(parseServersArgs(["--json"])).toEqual({ ok: true, options: { json: true } });
  });

  it("rejects unknown flags", () => {
    const r = parseServersArgs(["--wat"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown argument "--wat"');
  });

  it("--help returns the usage string as an error", () => {
    const r = parseServersArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Usage: mcph servers");
  });
});

describe("runServersCommand", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mcph-servers-"));
    mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
    // Seed a global config with a token so the fetcher branch is reached.
    writeFileSync(
      join(home, CONFIG_DIRNAME, "config.json"),
      JSON.stringify({ version: 1, token: "mcp_pat_test" }),
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("exits 1 with a usage hint when no token is resolvable", async () => {
    rmSync(join(home, CONFIG_DIRNAME, "config.json"));
    const io = captureIO();
    const r = await runServersCommand({
      home,
      env: {},
      out: io.push,
      err: io.pushErr,
      fetcher: async () => {
        throw new Error("fetcher should not run");
      },
    });
    expect(r.exitCode).toBe(1);
    expect(io.err.join("")).toContain("no token resolved");
  });

  it("renders a table when servers are returned", async () => {
    const io = captureIO();
    const cfg: ConnectConfig = {
      configVersion: "abcdef12345",
      servers: [
        makeServer({ namespace: "linear", name: "Linear", type: "remote", isActive: true, complianceGrade: "A" }),
        makeServer({
          namespace: "gh",
          name: "GitHub",
          type: "local",
          isActive: true,
          toolCache: Array(42).fill({ name: "t" }),
        }),
        makeServer({ namespace: "slack", name: "Slack", type: "remote", isActive: false, complianceGrade: "B" }),
      ],
    };
    const r = await runServersCommand({
      home,
      env: {},
      out: io.push,
      err: io.pushErr,
      fetcher: async () => cfg,
    });
    expect(r.exitCode).toBe(0);
    const combined = io.out.join("\n");
    expect(combined).toContain("3 servers (2 enabled, 1 disabled)");
    expect(combined).toContain("config abcdef12"); // 8-char slug
    expect(combined).toContain("NAMESPACE");
    expect(combined).toContain("GitHub");
    expect(combined).toContain("Linear");
    expect(combined).toContain("enabled");
    expect(combined).toContain("disabled");
    // Tools is the last column, so "42" is right-aligned with no trailing space.
    expect(combined).toMatch(/ +42$/m);
  });

  it("sorts rows alphabetically by namespace for determinism", async () => {
    const io = captureIO();
    const cfg: ConnectConfig = {
      configVersion: "v1",
      servers: [
        makeServer({ namespace: "zeta", name: "Zeta" }),
        makeServer({ namespace: "alpha", name: "Alpha" }),
        makeServer({ namespace: "mu", name: "Mu" }),
      ],
    };
    await runServersCommand({
      home,
      env: {},
      out: io.push,
      err: io.pushErr,
      fetcher: async () => cfg,
    });
    const rendered = io.out.join("\n");
    const alphaAt = rendered.indexOf("alpha");
    const muAt = rendered.indexOf("mu");
    const zetaAt = rendered.indexOf("zeta");
    expect(alphaAt).toBeGreaterThan(-1);
    expect(muAt).toBeGreaterThan(alphaAt);
    expect(zetaAt).toBeGreaterThan(muAt);
  });

  it("prints a friendly message when the account has zero servers", async () => {
    const io = captureIO();
    const r = await runServersCommand({
      home,
      env: {},
      out: io.push,
      err: io.pushErr,
      fetcher: async () => ({ configVersion: "v0", servers: [] }),
    });
    expect(r.exitCode).toBe(0);
    expect(io.out.join("")).toContain("No servers configured yet");
  });

  it("emits JSON when --json is set", async () => {
    const io = captureIO();
    const cfg: ConnectConfig = {
      configVersion: "v1",
      servers: [makeServer({ namespace: "gh", name: "GitHub" })],
    };
    const r = await runServersCommand({
      home,
      env: {},
      json: true,
      out: io.push,
      err: io.pushErr,
      fetcher: async () => cfg,
    });
    expect(r.exitCode).toBe(0);
    const combined = io.out.join("\n");
    // Should be parseable JSON.
    const parsed = JSON.parse(combined);
    expect(parsed.configVersion).toBe("v1");
    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0].namespace).toBe("gh");
    // Should NOT contain the human-readable header.
    expect(combined).not.toContain("NAMESPACE");
  });

  it("treats --json + empty servers as `{servers: []}` JSON, not the friendly message", async () => {
    const io = captureIO();
    const r = await runServersCommand({
      home,
      env: {},
      json: true,
      out: io.push,
      err: io.pushErr,
      fetcher: async () => ({ configVersion: "v0", servers: [] }),
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.servers).toEqual([]);
    expect(io.out.join("\n")).not.toContain("No servers configured yet");
  });

  it("exits 2 on fetch error and pipes the message to stderr", async () => {
    const io = captureIO();
    const r = await runServersCommand({
      home,
      env: {},
      out: io.push,
      err: io.pushErr,
      fetcher: async () => {
        throw new Error("Invalid MCPH_TOKEN — check your token at mcp.hosting");
      },
    });
    expect(r.exitCode).toBe(2);
    expect(io.err.join("")).toContain("Invalid MCPH_TOKEN");
  });

  it("exits 2 on an unexpected 304 (null response)", async () => {
    const io = captureIO();
    const r = await runServersCommand({
      home,
      env: {},
      out: io.push,
      err: io.pushErr,
      fetcher: async () => null,
    });
    expect(r.exitCode).toBe(2);
    expect(io.err.join("")).toContain("unexpected 304");
  });

  it("shows `-` in the grade column for ungraded servers", async () => {
    const io = captureIO();
    await runServersCommand({
      home,
      env: {},
      out: io.push,
      err: io.pushErr,
      fetcher: async () => ({
        configVersion: "v1",
        servers: [makeServer({ namespace: "x", name: "X" })],
      }),
    });
    // grade column shows "-" when complianceGrade is undefined
    expect(io.out.join("\n")).toMatch(/-\s+\?$/m);
  });
});
