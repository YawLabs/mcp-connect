import { request } from "undici";
import { log } from "./logger.js";

export interface ConnectAnalyticsEvent {
  namespace: string | null;
  toolName: string | null;
  action:
    | "discover"
    | "activate"
    | "deactivate"
    | "tool_call"
    | "import"
    | "install"
    | "health"
    | "suggest"
    | "read_tool"
    | "exec"
    | "bundles";
  latencyMs: number | null;
  success: boolean;
  error?: string;
  timestamp: string;
}

export interface DispatchAnalyticsEvent {
  scope: "connect";
  serverId: string | null;
  toolName: string | null;
  requestBytes: number;
  responseBytesRaw: number;
  responseBytesPruned?: number;
}

const FLUSH_INTERVAL = 30_000;
const FLUSH_SIZE = 50;
const MAX_BUFFER = 5000;

const buffer: ConnectAnalyticsEvent[] = [];
const dispatchBuffer: DispatchAnalyticsEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let apiUrl = "";
let token = "";

export function recordConnectEvent(event: Omit<ConnectAnalyticsEvent, "timestamp">): void {
  if (buffer.length >= MAX_BUFFER) return;
  buffer.push({ ...event, timestamp: new Date().toISOString() });
  if (buffer.length >= FLUSH_SIZE) {
    flush().catch(() => {});
  }
}

export function recordDispatchEvent(event: DispatchAnalyticsEvent): void {
  if (dispatchBuffer.length >= MAX_BUFFER) return;
  dispatchBuffer.push(event);
  if (dispatchBuffer.length >= FLUSH_SIZE) {
    flushDispatch().catch(() => {});
  }
}

async function flush(): Promise<void> {
  if (buffer.length === 0 || !apiUrl || !token) return;

  const events = buffer.splice(0, FLUSH_SIZE);
  try {
    const res = await request(`${apiUrl.replace(/\/$/, "")}/api/connect/analytics`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events }),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    if (res.statusCode >= 400) {
      // Re-insert at front for retry (up to buffer limit)
      const room = MAX_BUFFER - buffer.length;
      if (room > 0) buffer.push(...events.slice(0, room));
      log("warn", "Analytics flush failed", { status: res.statusCode });
    }
    // Drain response body
    await res.body.text().catch(() => {});
  } catch (err: any) {
    // Re-insert for retry
    const room = MAX_BUFFER - buffer.length;
    if (room > 0) buffer.push(...events.slice(0, room));
    log("warn", "Analytics flush error", { error: err.message });
  }
}

async function flushDispatch(): Promise<void> {
  if (dispatchBuffer.length === 0 || !apiUrl || !token) return;

  const events = dispatchBuffer.splice(0, FLUSH_SIZE);
  try {
    const res = await request(`${apiUrl.replace(/\/$/, "")}/api/connect/dispatch-events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events }),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    if (res.statusCode >= 400 && res.statusCode !== 204) {
      const room = MAX_BUFFER - dispatchBuffer.length;
      if (room > 0) dispatchBuffer.push(...events.slice(0, room));
      log("warn", "Dispatch-events flush failed", { status: res.statusCode });
    }
    await res.body.text().catch(() => {});
  } catch (err: any) {
    const room = MAX_BUFFER - dispatchBuffer.length;
    if (room > 0) dispatchBuffer.push(...events.slice(0, room));
    log("warn", "Dispatch-events flush error", { error: err.message });
  }
}

export function initAnalytics(url: string, tok: string): void {
  apiUrl = url;
  token = tok;
  flushTimer = setInterval(() => {
    flush().catch(() => {});
    flushDispatch().catch(() => {});
  }, FLUSH_INTERVAL);
  if (flushTimer.unref) flushTimer.unref();
}

export async function shutdownAnalytics(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  for (let i = 0; i < 3 && buffer.length > 0; i++) {
    await flush();
  }
  for (let i = 0; i < 3 && dispatchBuffer.length > 0; i++) {
    await flushDispatch();
  }
  buffer.length = 0;
  dispatchBuffer.length = 0;
}
