import { request } from "undici";
import { log } from "./logger.js";
import type { ConnectConfig } from "./types.js";

export async function fetchConfig(apiUrl: string, token: string): Promise<ConnectConfig> {
  const url = `${apiUrl.replace(/\/$/, "")}/api/connect/config`;

  const res = await request(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });

  if (res.statusCode === 401) {
    await res.body.text().catch(() => {});
    throw new ConfigError("Invalid MCP_HOSTING_TOKEN — check your token at mcp.hosting", true);
  }

  if (res.statusCode === 403) {
    await res.body.text().catch(() => {});
    throw new ConfigError("Access denied — your token may have expired", true);
  }

  if (res.statusCode !== 200) {
    const body = await res.body.text().catch(() => "");
    throw new ConfigError(`Config fetch failed (HTTP ${res.statusCode}): ${body}`, false);
  }

  const data = (await res.body.json()) as ConnectConfig;

  if (!data.servers || !Array.isArray(data.servers)) {
    throw new ConfigError("Invalid config response from server", false);
  }

  // Filter out servers missing required fields
  data.servers = data.servers.filter((s) => {
    if (!s.id || !s.name || !s.namespace || !s.type) {
      log("warn", "Skipping server with missing required fields", { id: s.id, name: s.name, namespace: s.namespace });
      return false;
    }
    return true;
  });

  // Filter out servers with invalid namespaces
  const NAMESPACE_RE = /^[a-z][a-z0-9_]{0,29}$/;
  data.servers = data.servers.filter((s) => {
    if (!s.namespace || !NAMESPACE_RE.test(s.namespace)) {
      log("warn", "Skipping server with invalid namespace", { namespace: s.namespace, name: s.name });
      return false;
    }
    return true;
  });

  log("info", "Config loaded", { serverCount: data.servers.length, version: data.configVersion });

  return data;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly fatal: boolean,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}
