import { request } from "undici";
import { log } from "./logger.js";

// Reports the tool list a server exposed on first activation back to
// mcp.hosting so the BM25 ranker can score inactive servers on cold
// starts. Fire-and-forget: failures are logged and swallowed because
// missing cache data only degrades ranking quality, it doesn't break
// any user-visible flow.
//
// Tolerates a 404 from the backend so older mcp.hosting deployments
// that don't ship this endpoint stay usable with the new mcph client.

let apiUrl = "";
let token = "";

// Single-slot latch capturing the most recent rejection from the
// dashboard so `mcph doctor` can surface lost-write-scope (e.g., a
// rotated token) instead of letting the failure rot silently in the
// logger. Cleared on the next successful (2xx) post -- a transient 4xx
// must not pollute doctor output forever. Diagnostic-only: never POSTed
// back to the dashboard.
export interface ReportFailure {
  statusCode: number;
  url: string;
  at: number;
}
let lastFailure: ReportFailure | null = null;

export function getLastReportFailure(): ReportFailure | null {
  return lastFailure;
}

export function initToolReport(url: string, tok: string): void {
  apiUrl = url;
  token = tok;
}

export async function reportTools(
  serverId: string,
  tools: Array<{ name: string; description?: string }>,
): Promise<void> {
  if (!apiUrl || !token || !serverId) return;
  const url = `${apiUrl.replace(/\/$/, "")}/api/connect/servers/${serverId}/tools`;
  try {
    const res = await request(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tools }),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    // Drain body so the connection can be reused
    await res.body.text().catch(() => {});
    // 404 is expected on mcp.hosting deployments predating this endpoint —
    // skip the warn to keep logs clean. Any other non-2xx is genuine.
    if (res.statusCode >= 400 && res.statusCode !== 404) {
      log("warn", "Tool report failed", { serverId, status: res.statusCode });
      lastFailure = { statusCode: res.statusCode, url, at: Date.now() };
    } else if (res.statusCode < 400) {
      // Clear the latch on a real 2xx so an old failure doesn't linger
      // after the dashboard recovers (e.g., user re-issued the token).
      lastFailure = null;
    }
  } catch (err: any) {
    log("warn", "Tool report error", { serverId, error: err?.message });
  }
}
