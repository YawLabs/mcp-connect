import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface UpstreamServerConfig {
  id: string;
  name: string;
  namespace: string;
  type: "local" | "remote";
  transport?: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  isActive: boolean;
  // Free-text summary used by the BM25 ranker for dispatch + context-aware
  // discover. Set in the mcp.hosting dashboard; absent on older deployments.
  description?: string;
  // Tools mcph reported back after the first activation in some earlier
  // session — used to rank servers that aren't currently connected, so
  // the ranker doesn't need to cold-start every dispatch by activating
  // every candidate.
  toolCache?: Array<{ name: string; description?: string }>;
  /**
   * A–F grade reported by the mcp.hosting compliance pipeline. Absent
   * on older backends or servers that haven't been scored yet. When
   * absent, the server is treated as "ungraded" and passes filters by
   * default (we don't punish unknown).
   */
  complianceGrade?: "A" | "B" | "C" | "D" | "F";
}

export interface ConnectConfig {
  servers: UpstreamServerConfig[];
  configVersion: string;
}

export interface UpstreamToolDef {
  name: string;
  namespacedName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface UpstreamResourceDef {
  uri: string;
  namespacedUri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface UpstreamPromptDef {
  name: string;
  namespacedName: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface ConnectionHealth {
  totalCalls: number;
  errorCount: number;
  totalLatencyMs: number;
  lastErrorMessage?: string;
  lastErrorAt?: string;
}

export type ConnectionStatus = "disconnected" | "connected" | "error";

export interface UpstreamConnection {
  config: UpstreamServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  tools: UpstreamToolDef[];
  resources: UpstreamResourceDef[];
  prompts: UpstreamPromptDef[];
  health: ConnectionHealth;
  status: ConnectionStatus;
  error?: string;
}
