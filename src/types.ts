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

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface UpstreamConnection {
  config: UpstreamServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: UpstreamToolDef[];
  status: ConnectionStatus;
  error?: string;
}
