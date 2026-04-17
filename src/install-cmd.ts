// `mcph install <client> [flags]` — auto-edits the chosen MCP client's
// config file so the user doesn't have to hand-write JSON or hunt for
// per-OS file paths. Also ensures ~/.mcph/config.json carries the token so
// subsequent `install` invocations on other clients don't re-prompt.
//
// Two files are touched per run:
//   1. The client's config file (e.g., ~/.claude.json for Claude Code
//      user scope) — the "mcp.hosting" launch entry is merged in,
//      preserving any other `mcpServers` / `servers` keys the user
//      already has, plus every sibling along the container key path
//      (Claude Code local scope nests under projects[<absDir>].mcpServers).
//   2. ~/.mcph/config.json (user-global) — created if missing, the token is
//      written here so the launch entry stays env-free. Single source
//      of truth for token rotation across all clients.
//
// Failure semantics:
//   - Existing client file with malformed JSON  → refuse, point at the file.
//   - Existing `mcp.hosting` entry              → prompt (TTY) or refuse
//                                                  with --force/--skip flag.
//   - No token anywhere + non-TTY               → refuse with usage hint.
//   - --dry-run                                  → print the would-be diff
//                                                  and exit 0 without writing.

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { CONFIG_FILENAME, CURRENT_SCHEMA_VERSION, loadMcphConfig } from "./config-loader.js";
import {
  CURRENT_OS,
  ENTRY_NAME,
  INSTALL_TARGETS,
  type InstallClientId,
  type InstallOS,
  type InstallScope,
  buildLaunchEntry,
  resolveInstallPath,
} from "./install-targets.js";
import { parseJsonc } from "./jsonc.js";
import { CONFIG_DIRNAME } from "./paths.js";

export interface InstallCommandOptions {
  clientId: InstallClientId;
  scope?: InstallScope;
  os?: InstallOS;
  projectDir?: string;
  /** Token to write to ~/.mcph/config.json. If absent, uses existing token there. */
  token?: string;
  /** Overwrite an existing mcp.hosting entry without prompting. */
  force?: boolean;
  /** Leave an existing mcp.hosting entry untouched (exit 0). */
  skip?: boolean;
  /** Print the changes that would be made and exit without writing. */
  dryRun?: boolean;
  /** When true, do not write/update ~/.mcph/config.json — only the client config. */
  skipMcphConfig?: boolean;
  /** Override for tests; defaults to homedir(). */
  home?: string;
  /** Override for tests; defaults to process.stdin/stdout. */
  io?: {
    stdin: NodeJS.ReadableStream;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
    isTTY: boolean;
  };
  /** Override for tests; replaces an interactive prompt with a fixed answer. */
  promptAnswer?: "overwrite" | "skip" | "abort";
}

export interface InstallResult {
  /** Files that were written (empty in --dry-run). */
  written: string[];
  /** Files that would have been written (only populated in --dry-run). */
  wouldWrite: string[];
  /** Diagnostic messages already printed to the chosen stdout. */
  messages: string[];
  /** Process exit code. 0 = success, non-zero = refused/error. */
  exitCode: number;
}

const USAGE =
  "Usage: mcph install <claude-code|claude-desktop|cursor|vscode> [--scope user|project|local]\n" +
  "                       [--token <mcp_pat_…>] [--project-dir <path>] [--os macos|linux|windows]\n" +
  "                       [--force | --skip] [--dry-run] [--no-mcph-config]";

export async function runInstall(opts: InstallCommandOptions): Promise<InstallResult> {
  const stdout = opts.io?.stdout ?? process.stdout;
  const stderr = opts.io?.stderr ?? process.stderr;
  const messages: string[] = [];
  const log = (s: string): void => {
    messages.push(s);
    stdout.write(`${s}\n`);
  };
  const err = (s: string): void => {
    messages.push(s);
    stderr.write(`${s}\n`);
  };

  if (opts.force && opts.skip) {
    err("mcph install: --force and --skip are mutually exclusive");
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  const target = INSTALL_TARGETS.find((t) => t.clientId === opts.clientId);
  if (!target) {
    err(`mcph install: unknown client ${opts.clientId}\n${USAGE}`);
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  const os = opts.os ?? CURRENT_OS;
  if (!target.availableOn.includes(os)) {
    const fix =
      target.clientId === "claude-desktop" && os === "linux"
        ? "Anthropic ships Claude Desktop on macOS and Windows only. Install Claude Code or Cursor instead."
        : "Pick a different client or pass --os to override.";
    err(`mcph install: ${target.label} is not available on ${os}.\n  ${fix}`);
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  // Pick a default scope sensibly: prefer user-global where supported,
  // else fall back to the first scope the client supports (vscode → project).
  const scope: InstallScope =
    opts.scope ?? (target.scopes.find((s) => s.scope === "user") ? "user" : target.scopes[0].scope);
  const scopeSpec = target.scopes.find((s) => s.scope === scope);
  if (!scopeSpec) {
    err(
      `mcph install: ${target.label} does not support scope "${scope}". Available: ${target.scopes.map((s) => s.scope).join(", ")}`,
    );
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  const projectDir = scopeSpec.requiresProjectDir ? resolve(opts.projectDir ?? process.cwd()) : undefined;
  let resolved: ReturnType<typeof resolveInstallPath>;
  try {
    resolved = resolveInstallPath({
      clientId: opts.clientId,
      scope,
      os,
      home: opts.home,
      projectDir,
    });
  } catch (e) {
    err(`mcph install: ${(e as Error).message}`);
    return { written: [], wouldWrite: [], messages, exitCode: 2 };
  }

  log(`Target: ${target.label} (${scope})`);
  log(`File:   ${resolved.absolute}`);

  // Resolve the token. Source precedence (highest first):
  //   --token flag > existing ~/.mcph/config.json token > error.
  let token: string | null = opts.token ?? null;
  if (!token) {
    const cfg = await loadMcphConfig({ home: opts.home, cwd: process.cwd(), env: {} });
    token = cfg.token;
  }
  if (!token) {
    err(
      "\nmcph install: no token available.\n" +
        "  Pass one with --token mcp_pat_…, or run `mcph install` with --token once to seed ~/.mcph/config.json,\n" +
        "  or create the token at https://mcp.hosting → Settings → API Tokens.",
    );
    return { written: [], wouldWrite: [], messages, exitCode: 1 };
  }

  // Read + merge existing client config.
  const newEntry = buildLaunchEntry({ os });
  const containerPath = resolved.containerPath;
  let existing: Record<string, unknown> = {};
  let existingHasEntry = false;
  if (existsSync(resolved.absolute)) {
    let raw: string;
    try {
      raw = await readFile(resolved.absolute, "utf8");
    } catch (e) {
      err(`mcph install: cannot read ${resolved.absolute}: ${(e as Error).message}`);
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
    if (raw.trim().length > 0) {
      try {
        const parsed = parseJsonc(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          err(
            `mcph install: ${resolved.absolute} is not a JSON object — refusing to overwrite. Edit by hand or rename the file and re-run.`,
          );
          return { written: [], wouldWrite: [], messages, exitCode: 1 };
        }
        existing = parsed as Record<string, unknown>;
      } catch (e) {
        err(
          `mcph install: ${resolved.absolute} is not valid JSON (${(e as Error).message}). Refusing to overwrite. Fix the file or rename it and re-run.`,
        );
        return { written: [], wouldWrite: [], messages, exitCode: 1 };
      }
    }
    const container = readNested(existing, containerPath);
    if (typeof container === "object" && container !== null && !Array.isArray(container)) {
      existingHasEntry = ENTRY_NAME in (container as Record<string, unknown>);
    }
  }

  if (existingHasEntry) {
    let decision: "overwrite" | "skip" | "abort";
    if (opts.force) decision = "overwrite";
    else if (opts.skip) decision = "skip";
    else if (opts.promptAnswer) decision = opts.promptAnswer;
    else if (opts.io?.isTTY ?? process.stdout.isTTY) {
      decision = await promptCollision(resolved.absolute, opts.io);
    } else {
      err(
        `mcph install: ${resolved.absolute} already has a "${ENTRY_NAME}" entry and stdin is not a TTY.\n  Re-run with --force to overwrite, --skip to leave it, or --dry-run to preview.`,
      );
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
    if (decision === "skip") {
      log(`Existing "${ENTRY_NAME}" entry left untouched. Nothing to do.`);
      return { written: [], wouldWrite: [], messages, exitCode: 0 };
    }
    if (decision === "abort") {
      err("Aborted.");
      return { written: [], wouldWrite: [], messages, exitCode: 1 };
    }
    log(`Overwriting existing "${ENTRY_NAME}" entry.`);
  }

  const merged = mergeClientConfig(existing, containerPath, newEntry);
  const clientJson = `${JSON.stringify(merged, null, 2)}\n`;

  const writeMcphConfig = !opts.skipMcphConfig;
  const home = opts.home ?? homedir();
  const mcphConfigPath = join(home, CONFIG_DIRNAME, CONFIG_FILENAME);
  const mcphConfigJson = await composeMcphConfig(mcphConfigPath, token);

  if (opts.dryRun) {
    log("\n--- dry run: would write the following ---");
    log(`\n# ${resolved.absolute}\n${clientJson}`);
    if (writeMcphConfig) log(`# ${mcphConfigPath}\n${mcphConfigJson}`);
    return {
      written: [],
      wouldWrite: writeMcphConfig ? [resolved.absolute, mcphConfigPath] : [resolved.absolute],
      messages,
      exitCode: 0,
    };
  }

  // Write client config (creating parent dirs if missing).
  try {
    await mkdir(dirname(resolved.absolute), { recursive: true });
    await writeFile(resolved.absolute, clientJson, "utf8");
  } catch (e) {
    err(`mcph install: failed to write ${resolved.absolute}: ${(e as Error).message}`);
    return { written: [], wouldWrite: [], messages, exitCode: 1 };
  }
  log(`Wrote ${resolved.absolute}`);
  const written = [resolved.absolute];

  // Write ~/.mcph/config.json with the token.
  if (writeMcphConfig) {
    try {
      await mkdir(dirname(mcphConfigPath), { recursive: true });
      await writeFile(mcphConfigPath, mcphConfigJson, "utf8");
      // Best-effort POSIX permissions tighten — ignored on Windows.
      if (process.platform !== "win32") {
        try {
          await chmod(mcphConfigPath, 0o600);
        } catch {
          // chmod not supported on this filesystem; not fatal.
        }
      }
    } catch (e) {
      err(`mcph install: failed to write ${mcphConfigPath}: ${(e as Error).message}`);
      return { written, wouldWrite: [], messages, exitCode: 1 };
    }
    log(`Wrote ${mcphConfigPath}`);
    written.push(mcphConfigPath);
  }

  if (target.notes) log(`Note: ${target.notes}`);
  log(`\n✓ ${target.label} is configured. Restart it to pick up the new MCP server.`);
  return { written, wouldWrite: [], messages, exitCode: 0 };
}

async function promptCollision(path: string, io: InstallCommandOptions["io"]): Promise<"overwrite" | "skip" | "abort"> {
  const stdin = io?.stdin ?? process.stdin;
  const stdout = io?.stdout ?? process.stdout;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (
      await rl.question(
        `${path} already has an "${ENTRY_NAME}" entry.\n  [o]verwrite, [s]kip, or [a]bort? (default: skip) `,
      )
    )
      .trim()
      .toLowerCase();
    if (answer.startsWith("o")) return "overwrite";
    if (answer.startsWith("a")) return "abort";
    return "skip";
  } finally {
    rl.close();
  }
}

/** Walk `containerPath` to find the existing mcpServers/servers container.
 *  Returns the value at the path, or undefined if any segment is missing
 *  or non-object. Does not mutate. */
export function readNested(root: Record<string, unknown>, containerPath: string[]): unknown {
  let cur: unknown = root;
  for (const key of containerPath) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Merge `entry` into the container at `existing[...containerPath][ENTRY_NAME]`,
 *  preserving every sibling at every level of the path. Returns a new object;
 *  does not mutate. For Claude Code local scope, containerPath is
 *  ["projects", <absDir>, "mcpServers"] and this preserves every other
 *  project's settings + every other top-level key in ~/.claude.json. */
export function mergeClientConfig(
  existing: Record<string, unknown>,
  containerPath: string[],
  entry: Record<string, unknown> | { command: string; args: string[]; env?: Record<string, string> },
): Record<string, unknown> {
  if (containerPath.length === 0) throw new Error("mergeClientConfig: containerPath cannot be empty");
  const out: Record<string, unknown> = { ...existing };
  let parent: Record<string, unknown> = out;
  for (let i = 0; i < containerPath.length - 1; i++) {
    const key = containerPath[i];
    const child = parent[key];
    const cloned: Record<string, unknown> =
      typeof child === "object" && child !== null && !Array.isArray(child)
        ? { ...(child as Record<string, unknown>) }
        : {};
    parent[key] = cloned;
    parent = cloned;
  }
  const leafKey = containerPath[containerPath.length - 1];
  const prev = parent[leafKey];
  const container: Record<string, unknown> =
    typeof prev === "object" && prev !== null && !Array.isArray(prev) ? { ...(prev as Record<string, unknown>) } : {};
  container[ENTRY_NAME] = entry;
  parent[leafKey] = container;
  return out;
}

/** Compose the ~/.mcph/config.json contents — preserves any existing fields,
 *  upserts the token, ensures `version` is set. */
async function composeMcphConfig(path: string, token: string): Promise<string> {
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = parseJsonc(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Existing file is malformed; we'll overwrite with a fresh one
      // rather than refuse, because the user explicitly asked to install.
      // (The malformed file is presumably their own typo, not ours.)
    }
  }
  const next: Record<string, unknown> = { version: CURRENT_SCHEMA_VERSION, ...existing };
  next.token = token;
  if (typeof next.version !== "number") next.version = CURRENT_SCHEMA_VERSION;
  return `${JSON.stringify(next, null, 2)}\n`;
}

/** CLI argv parser used by index.ts dispatcher. Exported so tests can
 *  exercise flag parsing without spawning a subprocess. */
export function parseInstallArgs(argv: string[]):
  | {
      ok: true;
      options: InstallCommandOptions;
    }
  | { ok: false; error: string } {
  if (argv.length === 0) return { ok: false, error: USAGE };
  const positional: string[] = [];
  const opts: Partial<InstallCommandOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--scope": {
        const v = next();
        if (!v || !["user", "project", "local"].includes(v))
          return { ok: false, error: "--scope requires user|project|local" };
        opts.scope = v as InstallScope;
        break;
      }
      case "--os": {
        const v = next();
        if (!v || !["macos", "linux", "windows"].includes(v))
          return { ok: false, error: "--os requires macos|linux|windows" };
        opts.os = v as InstallOS;
        break;
      }
      case "--token": {
        const v = next();
        if (!v) return { ok: false, error: "--token requires a value" };
        opts.token = v;
        break;
      }
      case "--project-dir": {
        const v = next();
        if (!v) return { ok: false, error: "--project-dir requires a value" };
        opts.projectDir = v;
        break;
      }
      case "--force":
        opts.force = true;
        break;
      case "--skip":
        opts.skip = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--no-mcph-config":
        opts.skipMcphConfig = true;
        break;
      case "-h":
      case "--help":
        return { ok: false, error: USAGE };
      default:
        if (a.startsWith("--")) return { ok: false, error: `Unknown flag: ${a}\n${USAGE}` };
        positional.push(a);
    }
  }
  if (positional.length !== 1)
    return { ok: false, error: `Expected exactly one client argument, got ${positional.length}.\n${USAGE}` };
  const clientId = positional[0] as InstallClientId;
  if (!INSTALL_TARGETS.some((t) => t.clientId === clientId)) {
    return {
      ok: false,
      error: `Unknown client: ${clientId}. Choose: ${INSTALL_TARGETS.map((t) => t.clientId).join(", ")}`,
    };
  }
  opts.clientId = clientId;
  return { ok: true, options: opts as InstallCommandOptions };
}

export const INSTALL_USAGE = USAGE;
