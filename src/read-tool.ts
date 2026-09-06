import type { UpstreamServerConfig, UpstreamToolDef } from "./types.js";

// Signature-on-demand: render one tool's full schema in a shape the
// LLM can read *before* paying the context cost of loading its whole
// server. Cheaper than `activate` when the caller is comparison-
// shopping between tools, and reversible — the transient connect used
// on a not-loaded server tears down the upstream as soon as the schema
// is read. Pure formatting here; the transient-connect orchestration
// lives in server.ts so all SDK I/O stays in one place.

export interface ReadToolResult {
  tool: UpstreamToolDef;
  server: UpstreamServerConfig;
  loaded: boolean;
}

// Accept either the bare tool name ("create_issue") or the namespaced
// form ("gh_create_issue"). We strip a leading "<namespace>_" when it
// matches so callers can paste whichever form they already have in
// context. The namespace-aware check (rather than a blind split on
// "_") keeps an underscore-containing namespace safe. The catalog never
// derives one (deriveNamespace strips punctuation), but bundles.json's
// `namespace` is user-set and NAMESPACE_RE allows "_", so a user who names
// the catalog's google-maps server "google_maps" gets exactly this shape.
//
// When `tools` is provided, try an exact-match against the list first.
// Only strip the namespace prefix when no tool in the list has the
// exact raw name — this prevents false-positive stripping for tools
// whose bare name happens to start with the namespace prefix string.
export function normalizeToolName(namespace: string, raw: string, tools?: Array<{ name: string }>): string {
  if (tools?.some((t) => t.name === raw)) return raw;
  const prefix = `${namespace}_`;
  if (raw.startsWith(prefix) && raw.length > prefix.length) return raw.slice(prefix.length);
  return raw;
}

export function findTool(tools: UpstreamToolDef[], toolName: string): UpstreamToolDef | undefined {
  return tools.find((t) => t.name === toolName);
}

// Render the schema as pretty JSON. Two-space indent keeps line width
// tolerable for nested property trees; no maxDepth — schema shapes
// are bounded in practice and truncating mid-schema would be worse
// than a long response.
//
// Everything UpstreamToolDef carries is rendered, not just inputSchema:
// `outputSchema` is exactly what an exec caller needs to write correct
// `$ref` paths into a step's output, and `title` / `annotations` are what
// the tool would present with once loaded. Dropping them made this surface
// answer a narrower question than the one the caller asked.
export function formatReadToolOutput(result: ReadToolResult): string {
  const { tool, server, loaded } = result;
  const lines: string[] = [];
  // The namespaced name comes off the tool def rather than being rebuilt
  // from `${namespace}_${name}` here: upstream.ts already derives it once,
  // and a second copy of that rule drifts the moment the derivation changes.
  lines.push(`Tool: ${tool.namespacedName}`);
  lines.push(`Server: ${server.name} (${server.namespace})`);
  if (tool.title) {
    lines.push(`Title: ${tool.title}`);
  }
  if (tool.description) {
    lines.push(`Description: ${tool.description}`);
  }
  if (tool.annotations) {
    lines.push(`Annotations: ${JSON.stringify(tool.annotations)}`);
  }
  lines.push("");
  lines.push("Input schema:");
  lines.push(JSON.stringify(tool.inputSchema ?? {}, null, 2));
  if (tool.outputSchema) {
    lines.push("");
    lines.push("Output schema:");
    lines.push(JSON.stringify(tool.outputSchema, null, 2));
  }
  if (!loaded) {
    lines.push("");
    lines.push(
      `Note: "${server.namespace}" is not currently loaded. Call mcp_connect_activate({ server: "${server.namespace}" }) before invoking this tool.`,
    );
  }
  return lines.join("\n");
}

// Formats the error when the tool name is valid but the server
// doesn't expose it. Listing the available tools on the server gives
// the caller a fast retry target without a second `discover` round.
export function formatToolNotFound(
  server: UpstreamServerConfig,
  toolName: string,
  availableTools: Array<{ name: string }>,
): string {
  if (availableTools.length === 0) {
    return `"${server.namespace}" exposes no tools. The server may be misconfigured or currently down.`;
  }
  const names = availableTools
    .map((t) => t.name)
    .sort()
    .join(", ");
  return `"${toolName}" not found on "${server.namespace}". Available tools: ${names}`;
}
