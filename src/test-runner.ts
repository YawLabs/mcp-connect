import { request } from "undici";
import { log } from "./logger.js";
import type { ConnectConfig } from "./types.js";
import { ActivationError, connectToUpstream, disconnectFromUpstream } from "./upstream.js";

// Background poller that picks up dashboard "Test connection" requests
// from /api/connect/test-requests and runs a short-lived activate-then-
// disconnect probe against the targeted server. Result (passed / failed
// + category + tail of stderr + tool count) is POSTed back so the
// dashboard's polling loop can render it.
//
// Polling interval is intentionally generous (30s) — a Test click is
// rare in absolute terms and we don't want to add a hot loop to mcph
// just for this. Worst-case latency: ~30s for the first poll to pick
// up the request + a few seconds of activation = ~35s. Documented in
// the dashboard as "may take up to 30 seconds."

const POLL_INTERVAL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
// Tolerate a transient 404 storm (e.g. a CDN edge cache miss during
// deploy) before giving up on the endpoint. 10 polls @ 30s each = 5
// minutes of leeway. A successful 200 anywhere in that window resets
// the counter, so we only stop when the endpoint is genuinely gone.
const CONSECUTIVE_404_LIMIT = 10;

let apiUrl = "";
let token = "";
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let consecutive404 = 0;
// Resolved at start() time so we can pass it to the test runner without
// the runner needing to know about ConnectServer's internals.
let configRef: () => ConnectConfig | null = () => null;

export function initTestRunner(url: string, tok: string, getConfig: () => ConnectConfig | null): void {
  apiUrl = url;
  token = tok;
  configRef = getConfig;
}

export function startTestRunner(): void {
  if (running) return;
  running = true;
  consecutive404 = 0;
  schedule();
}

export function stopTestRunner(): void {
  running = false;
  consecutive404 = 0;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// Test hook -- expose the consecutive-404 counter so tests can assert
// the recovery semantics without poking module internals.
export function __testRunnerConsecutive404(): number {
  return consecutive404;
}

function schedule(): void {
  pollTimer = setTimeout(async () => {
    try {
      await pollOnce();
    } catch (err: any) {
      log("warn", "Test runner poll failed", { error: err?.message });
    }
    if (running) schedule();
  }, POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

interface PendingRequest {
  requestId: string;
  serverId: string;
}

async function pollOnce(): Promise<void> {
  if (!apiUrl || !token) return;
  const list = await fetchPending();
  if (list.length === 0) return;

  // Run pending tests sequentially. Parallelism would let a flood of
  // requests pin all the user's CPU cores spawning child processes —
  // not worth the latency win for an interactive feature that's
  // rate-limited at 30/min anyway.
  for (const pending of list) {
    if (!running) return;
    await runOne(pending).catch((err: any) => {
      log("warn", "Test execution failed", { requestId: pending.requestId, error: err?.message });
    });
  }
}

async function fetchPending(): Promise<PendingRequest[]> {
  try {
    const res = await request(`${apiUrl.replace(/\/$/, "")}/api/connect/test-requests`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    });
    if (res.statusCode === 404) {
      await res.body.text().catch(() => {});
      consecutive404++;
      // Log on the first 404 of a streak, then stay quiet. Stop polling
      // only after a sustained outage -- a transient 404 during a deploy
      // shouldn't permanently disable the runner.
      if (consecutive404 === 1) {
        log("warn", "Test runner endpoint returned 404; will retry", { url: `${apiUrl}/api/connect/test-requests` });
      }
      if (consecutive404 >= CONSECUTIVE_404_LIMIT) {
        log("warn", "Test runner endpoint persistently 404; stopping poller", {
          consecutive: consecutive404,
        });
        stopTestRunner();
      }
      return [];
    }
    if (res.statusCode !== 200) {
      await res.body.text().catch(() => {});
      consecutive404 = 0;
      return [];
    }
    consecutive404 = 0;
    const body = (await res.body.json()) as { requests?: PendingRequest[] };
    return Array.isArray(body?.requests) ? body.requests : [];
  } catch {
    return [];
  }
}

async function runOne(pending: PendingRequest): Promise<void> {
  const config = configRef();
  const serverConfig = config?.servers.find((s) => s.id === pending.serverId);

  if (!serverConfig) {
    await postResult(pending.requestId, {
      status: "failed",
      message: `Server "${pending.serverId}" is not in this mcph's current config — restart mcph or refresh the dashboard.`,
      errorCategory: "not_in_config",
    });
    return;
  }
  if (!serverConfig.isActive) {
    await postResult(pending.requestId, {
      status: "failed",
      message: `Server "${serverConfig.namespace}" is disabled in the dashboard — re-enable it before testing.`,
      errorCategory: "disabled",
    });
    return;
  }

  // Probe = full activation, then immediate disconnect. Mirrors what
  // mcp_connect_activate does so a passing test means a real activation
  // would also succeed. Using a clean Client per test means we don't
  // accidentally leave the test connection in the regular pool.
  let connection: Awaited<ReturnType<typeof connectToUpstream>> | null = null;
  try {
    connection = await connectToUpstream(serverConfig);
    await postResult(pending.requestId, {
      status: "passed",
      toolCount: connection.tools.length,
      message: `Connected — ${connection.tools.length} tool${connection.tools.length === 1 ? "" : "s"} available.`,
    });
  } catch (err) {
    if (err instanceof ActivationError) {
      await postResult(pending.requestId, {
        status: "failed",
        message: err.message,
        errorCategory: err.category,
      });
    } else {
      await postResult(pending.requestId, {
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
        errorCategory: "unknown",
      });
    }
  } finally {
    if (connection) {
      await disconnectFromUpstream(connection).catch(() => {});
    }
  }
}

async function postResult(
  requestId: string,
  result: {
    status: "passed" | "failed";
    message?: string;
    errorCategory?: string;
    toolCount?: number;
  },
): Promise<void> {
  try {
    const res = await request(
      `${apiUrl.replace(/\/$/, "")}/api/connect/test-requests/${encodeURIComponent(requestId)}/result`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(result),
        headersTimeout: REQUEST_TIMEOUT_MS,
        bodyTimeout: REQUEST_TIMEOUT_MS,
      },
    );
    await res.body.text().catch(() => {});
  } catch (err: any) {
    log("warn", "Posting test result failed", { requestId, error: err?.message });
  }
}
