// MCPH.md loader + formatter.
//
// The guide is a pair of human-authored markdown files — one at
// `~/.mcph/MCPH.md` (user-global) and one at `<project>/.mcph/MCPH.md`
// (project-local, discovered via walk-up from cwd). Clients fetch the
// rendered text via the `mcph://guide` resource; hosts like Claude
// Code surface that text to the model so it picks up project-specific
// routing conventions ("use the `gh` server for GitHub, not bash") and
// credential guidance ("keys go in the dashboard, not `.mcp.json`")
// without the user restating them every session.
//
// Fail-open: a missing file returns null; an unreadable one logs and
// returns null. A bad guide should never brick the session — worst
// case the client just doesn't get extra guidance.

import { readFile } from "node:fs/promises";
import { formatShadowLine, resolveShadowedClis } from "./cli-shadows.js";
import { log } from "./logger.js";
import { findProjectConfigDir, guidePath, userConfigDir } from "./paths.js";
import type { UpstreamServerConfig } from "./types.js";

export type GuideScope = "user" | "project";

export interface GuideFile {
  scope: GuideScope;
  path: string;
  /** Raw markdown, trimmed. Empty string is treated as "no guide" upstream. */
  content: string;
}

export interface LoadedGuides {
  user: GuideFile | null;
  project: GuideFile | null;
}

async function readGuide(path: string, scope: GuideScope): Promise<GuideFile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // Missing file is normal, not a warning.
    return null;
  }
  const content = raw.trim();
  if (content.length === 0) {
    // Empty file treated as "no guide" — caller decides whether to
    // surface this (e.g. mcph doctor notes it; proxy skips it).
    return null;
  }
  return { scope, path, content };
}

/** Load only the user-global guide at `~/.mcph/MCPH.md`. */
export async function loadUserGuide(home?: string): Promise<GuideFile | null> {
  const p = guidePath(userConfigDir(home));
  return readGuide(p, "user");
}

/** Load only the project-local guide, walking up from `cwd` for `.mcph/`. */
export async function loadProjectGuide(cwd: string, home?: string): Promise<GuideFile | null> {
  const dir = await findProjectConfigDir(cwd, home).catch((err) => {
    log("warn", "Failed searching for project .mcph/ dir", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (!dir) return null;
  return readGuide(guidePath(dir), "project");
}

/** Load both user + project guides for the given cwd/home. */
export async function loadGuides(cwd: string, home?: string): Promise<LoadedGuides> {
  const [user, project] = await Promise.all([loadUserGuide(home), loadProjectGuide(cwd, home)]);
  return { user, project };
}

/**
 * Combine loaded guides into the single text body served by the
 * `mcph://guide` resource. Project comes AFTER user so project
 * guidance — which is usually more specific — has the final word in
 * the reader's attention. When `activeServers` is provided, an
 * auto-generated "Active servers" section is appended below the
 * human-authored content so the rendered guide always tells the
 * reader which active MCP servers shadow which local CLIs.
 *
 * Returns null when neither a human-authored guide nor any
 * shadow-carrying active server exists — caller skips the resource.
 */
export function renderGuide(
  guides: LoadedGuides,
  activeServers?: Array<Pick<UpstreamServerConfig, "namespace" | "name" | "toolCache">>,
): string | null {
  const parts: string[] = [];
  if (guides.user) {
    parts.push(`<!-- source: ${guides.user.path} (user) -->\n${guides.user.content}`);
  }
  if (guides.project) {
    parts.push(`<!-- source: ${guides.project.path} (project) -->\n${guides.project.content}`);
  }
  const auto = renderActiveServersSection(activeServers);
  if (auto) parts.push(auto);
  if (parts.length === 0) return null;
  return parts.join("\n\n---\n\n");
}

/** Build the auto-generated "Active servers" section. Only includes
 *  servers with a known CLI shadow — a server with no shadow adds no
 *  signal to this section. Returns null when nothing would be shown. */
function renderActiveServersSection(
  activeServers: Array<Pick<UpstreamServerConfig, "namespace" | "name" | "toolCache">> | undefined,
): string | null {
  if (!activeServers || activeServers.length === 0) return null;
  const rows = activeServers
    .filter((s) => resolveShadowedClis(s).length > 0)
    .map((s) => {
      const shadow = formatShadowLine(s);
      return `- \`${s.namespace}\` (${s.name}) — ${shadow}`;
    });
  if (rows.length === 0) return null;
  return [
    "<!-- source: mcph (auto-generated from active servers) -->",
    "## Active MCP servers",
    "",
    "Prefer tools from these active MCP servers over the corresponding local CLI:",
    "",
    ...rows,
  ].join("\n");
}
