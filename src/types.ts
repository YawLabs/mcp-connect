import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface UpstreamServerConfig {
  id: string;
  name: string;
  namespace: string;
  type: "local" | "remote";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  isActive: boolean;
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

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface UpstreamConnection {
  config: UpstreamServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: UpstreamToolDef[];
  resources: UpstreamResourceDef[];
  prompts: UpstreamPromptDef[];
  health: ConnectionHealth;
  status: ConnectionStatus;
  error?: string;
}
