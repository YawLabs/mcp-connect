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
  /**
   * HTTP headers sent on every request to a REMOTE server. Values may carry
   * `${secret:NAME}` references, resolved from the local vault at connect
   * time by the same fail-closed path that resolves a local server's `env` --
   * so a missing or malformed reference refuses the connection rather than
   * putting the literal on the wire.
   *
   * This is how a remote upstream gets a credential. `env` cannot do it: a
   * remote entry spawns no process, so there is no environment to put one in,
   * and upstream.ts warns and ignores `env` on a remote entry for exactly
   * that reason. Before this field existed the only remote servers reachable
   * were the ones that take their credential in the URL, which is why the
   * public catalog wraps fifteen HTTPS endpoints in the `mcp-remote` npx shim
   * instead of configuring them as remote entries.
   *
   * Ignored on a local server, where `env` is the right channel.
   */
  headers?: Record<string, string>;
  isActive: boolean;
  /**
   * Per-server connect timeout in milliseconds, as set in bundles.json.
   * Overrides the global MCP_CONNECT_TIMEOUT env var for this specific server.
   * Absent means "use the global default".
   */
  connectTimeoutMs?: number;
  // Free-text summary used by the BM25 ranker for dispatch + context-aware
  // discover. Optional in bundles.json; absent on most entries.
  description?: string;
  // Tools yaw-mcp reported back after the first activation in some earlier
  // session — used to rank servers that aren't currently connected, so
  // the ranker doesn't need to cold-start every dispatch by activating
  // every candidate.
  toolCache?: Array<{ name: string; description?: string }>;
  /**
   * A–F grade for this server. Two suppliers, and the order between them
   * matters: `yaw-mcp add` records the catalog's published grade into
   * bundles.json (validateEntry carries it through), and the LOCAL grades
   * cache that `yaw-mcp audit <namespace>` writes to ~/.yaw-mcp/grades.json
   * is then overlaid ON TOP by hydrateComplianceGrades (server.ts) and
   * runList (local-add-cmd.ts). A locally-measured letter therefore beats a
   * published claim, which is the right way round: the cached one was
   * produced by running the suite against the bytes on this machine.
   *
   * Absent means "ungraded", which passes filters by default (we don't
   * punish unknown) -- so when NEITHER supplier has one,
   * YAW_MCP_MIN_COMPLIANCE cannot refuse that server. See compliance.ts.
   */
  complianceGrade?: "A" | "B" | "C" | "D" | "F";
  /**
   * Opt this server into being hosted on the oam runtime (`oam run <entry>`)
   * instead of node/npx. "oam" = prefer oam when it's installed, falling back
   * to node/npx if oam is absent, below the minimum supported version, or the
   * package can't be resolved on disk.
   *
   * Absent = oam when it is installed and meets MIN_OAM_VERSION, else node (see
   * default-runtime.ts for the full resolution order). An explicit "node" is
   * the escape hatch that keeps a server off oam.
   *
   * Per-server -- set in bundles.json. See oam-spawn.ts.
   */
  runtime?: "oam" | "node";
}

export interface ConnectConfig {
  servers: UpstreamServerConfig[];
  configVersion: string;
}

export interface UpstreamToolDef {
  name: string;
  namespacedName: string;
  // Human-readable display name (MCP 2025-06-18). Forwarded downstream so
  // proxied tools keep their intended presentation.
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  // Structured-output contract (MCP 2025-06-18). Forwarding it is what lets
  // a downstream client validate the structuredContent that routeToolCall
  // already passes through verbatim; dropping it would hand clients
  // structured payloads for tools they were told have no output schema.
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface UpstreamResourceDef {
  uri: string;
  namespacedUri: string;
  name?: string;
  // Human-readable display name (MCP 2025-06-18), carried for the same
  // reason UpstreamToolDef carries it: a client rendering the proxied
  // resource must see the presentation the upstream intended. Dropping it
  // silently downgraded every titled upstream resource to its raw `name`.
  title?: string;
  description?: string;
  mimeType?: string;
  // Passthrough metadata (MCP 2025-06-18). Opaque to yaw-mcp -- forwarded
  // verbatim so an upstream/client pair that agrees on a _meta convention
  // keeps working through the proxy.
  _meta?: Record<string, unknown>;
}

export interface UpstreamPromptDef {
  name: string;
  namespacedName: string;
  // Same MCP 2025-06-18 display-name / metadata passthrough as
  // UpstreamResourceDef above -- prompts carry both fields too.
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  _meta?: Record<string, unknown>;
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
