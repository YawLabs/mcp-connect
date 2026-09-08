import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The broker used to register SIGTERM and SIGINT and nothing else. That is a
// POSIX assumption: on Windows an MCP client ends the broker by closing the
// pipe it holds on the child's stdin, and StdioServerTransport binds only
// 'data' and 'error', so nothing anywhere noticed EOF.
//
// The symptom was NOT simply "exits without cleaning up". Measured against
// the pre-fix build with one upstream server loaded, closing stdin left the
// broker running indefinitely -- the upstream child's pipes keep the event
// loop alive, so the process never drained and never exited, and the upstream
// it had spawned stayed alive with it. Both processes survived the client
// that started them.
//
// (With NO upstream loaded the pre-fix broker did exit, because nothing held
// the loop open. That is why this test insists on activating a real upstream:
// a version of it that skipped activation passed against the bug.)
//
// This is a wall-clock budget on a real subprocess settling, so the file is
// listed in TIMING_SENSITIVE in vitest.config.ts and runs in the sequential
// project rather than against a 4x-oversubscribed box.

const INDEX_SRC = fileURLToPath(new URL("../index.ts", import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Generous: the broker tears down each upstream in turn, and the box may be
 *  loaded. Standalone the whole settle is ~2s; the budget is for contention,
 *  not for the work. It still has to be a BUDGET rather than "eventually",
 *  because "never exits" is precisely the regression. */
const SETTLE_BUDGET_MS = 20_000;

let workDir: string;
let bundlePath: string;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `check` is true or the budget runs out. Returns whether it
 *  became true, so callers assert on a boolean rather than on a race. */
async function waitFor(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

/** A minimal stdio MCP server that answers the three inventory calls the
 *  broker makes on connect, records its own pid, and then deliberately
 *  outlives its own stdin. Staying alive on EOF is the point: the assertion
 *  is that the BROKER tears it down, not that it noticed its pipe closing. */
const UPSTREAM_SOURCE = (pidFile: string): string => `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
let buf = "";
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      reply(msg.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "probe-upstream", version: "1" },
      });
    } else if (msg.method === "tools/list") {
      reply(msg.id, {
        tools: [{ name: "ping", description: "probe tool", inputSchema: { type: "object", properties: {} } }],
      });
    } else if (msg.method === "resources/list" || msg.method === "prompts/list") {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } }) + "\\n",
      );
    } else if (msg.id !== undefined) {
      reply(msg.id, {});
    }
  }
});
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`;

describe("closing stdin shuts the broker down and reaps its upstreams", () => {
  beforeAll(async () => {
    const { build } = await import("esbuild");
    workDir = await mkdtemp(join(tmpdir(), "yaw-mcp-shutdown-"));
    bundlePath = join(workDir, "entry.mjs");
    await build({
      entryPoints: [INDEX_SRC],
      absWorkingDir: PROJECT_ROOT,
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      mainFields: ["module", "main"],
      banner: {
        js: 'import { createRequire as __yawCreateRequire } from "node:module";\nconst require = __yawCreateRequire(import.meta.url);',
      },
      define: { __VERSION__: JSON.stringify("0.0.0-test") },
      logLevel: "silent",
    });
    // Same reasoning as index-dispatch.test.ts: bundling the whole dependency
    // graph is ~1s standalone but shares the box with every other file.
  }, 180_000);

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("runs shutdown(), exits, and takes the upstream server with it", async () => {
    const home = await mkdtemp(join(tmpdir(), "yaw-mcp-shutdown-home-"));
    const pidFile = join(home, "upstream.pid");
    const upstreamPath = join(home, "upstream.mjs");
    await writeFile(upstreamPath, UPSTREAM_SOURCE(pidFile), "utf8");
    await mkdir(join(home, ".yaw-mcp"), { recursive: true });
    await writeFile(
      join(home, ".yaw-mcp", "bundles.json"),
      JSON.stringify({
        servers: [
          {
            id: "probe",
            name: "probe",
            namespace: "probe",
            type: "local",
            command: process.execPath,
            args: [upstreamPath],
            isActive: true,
            description: "probe upstream",
          },
        ],
      }),
      "utf8",
    );

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(childEnv)) {
      if (k.startsWith("YAW_MCP_")) delete childEnv[k];
    }

    const child = spawn(process.execPath, [bundlePath], {
      cwd: home,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...childEnv,
        HOME: home,
        USERPROFILE: home,
        YAW_MCP_AUTO_UPGRADE: "0",
        YAW_MCP_SIDECAR_REFRESH: "0",
        YAW_MCP_DISABLE_PERSISTENCE: "1",
        LOG_LEVEL: "info",
      },
    });

    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });

    const send = (o: unknown): void => {
      child.stdin.write(`${JSON.stringify(o)}\n`);
    };

    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
      });
      await sleep(500);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await sleep(300);
      // Force a real upstream spawn. Without a live child holding the event
      // loop open, the pre-fix broker exits on its own and the test cannot
      // tell the fix from the bug.
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "mcp_connect_activate", arguments: { server: "probe" } },
      });

      const upstreamPid = await (async (): Promise<number> => {
        const deadline = Date.now() + SETTLE_BUDGET_MS;
        while (Date.now() < deadline) {
          try {
            const raw = (await readFile(pidFile, "utf8")).trim();
            if (raw) return Number(raw);
          } catch {
            // not spawned yet
          }
          await sleep(100);
        }
        throw new Error(`upstream never started; broker stderr tail:\n${stderr.slice(-800)}`);
      })();

      expect(isAlive(upstreamPid)).toBe(true);
      expect(exited).toBe(false);

      // Wait for the ACTIVATION to finish, not merely for the upstream
      // process to exist. The pid file is written the moment the child
      // starts, which is well before the broker has finished its handshake
      // and inventory calls -- and a shutdown that lands mid-activation
      // takes a different path (the in-flight drain budget) that never logs
      // "Disconnected from upstream". Closing stdin on the pid file alone
      // made this test fail under full-suite contention while the fix was
      // working correctly, which is a flaky test, not a caught regression.
      const activated = await waitFor(() => /"id"\s*:\s*2\b/.test(stdout), SETTLE_BUDGET_MS);
      expect(activated, `activation never completed; broker stderr tail:\n${stderr.slice(-800)}`).toBe(true);

      // The event under test.
      child.stdin.end();

      const brokerExited = await waitFor(() => exited, SETTLE_BUDGET_MS);
      expect(brokerExited, `broker still running ${SETTLE_BUDGET_MS}ms after stdin close`).toBe(true);

      // The graceful path specifically -- a process that merely drained its
      // event loop would exit 0 too, and that is the shape the bug had when
      // no upstream was loaded.
      expect(stderr).toContain("yaw-mcp shutdown complete");
      expect(stderr).toContain("Disconnected from upstream");

      const upstreamReaped = await waitFor(() => !isAlive(upstreamPid), SETTLE_BUDGET_MS);
      expect(upstreamReaped, `upstream pid ${upstreamPid} outlived the broker`).toBe(true);
    } finally {
      // Cleanup must never throw. When this test fails it fails BECAUSE two
      // processes are still alive holding `home` open, so an unguarded rm
      // raises EBUSY on Windows and replaces the real assertion error with
      // "EBUSY: rmdir" -- which says nothing about the broker not exiting.
      // Observed exactly that on the first pre-fix run of this test.
      if (!exited) child.kill("SIGKILL");
      try {
        const raw = await readFile(pidFile, "utf8");
        const pid = Number(raw.trim());
        if (Number.isFinite(pid) && isAlive(pid)) process.kill(pid, "SIGKILL");
      } catch {
        // never started, or already gone
      }
      // Give the OS a moment to release handles on `home` before removing it.
      await sleep(250);
      await rm(home, { recursive: true, force: true }).catch(() => {
        // A leftover temp dir is noise; a masked assertion is a lie.
      });
    }
  }, 120_000);
});
