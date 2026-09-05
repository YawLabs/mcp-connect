// YAW-MCP.md loader + formatter.
//
// The guide is a pair of human-authored markdown files — one at
// `~/.yaw-mcp/YAW-MCP.md` (user-global) and one at `<project>/.yaw-mcp/YAW-MCP.md`
// (project-local, discovered via walk-up from cwd). Clients fetch the
// rendered text via the `yaw-mcp://guide` resource; hosts like Claude
// Code surface that text to the model so it picks up project-specific
// routing conventions ("use the `gh` server for GitHub, not bash") and
// credential guidance ("keys go in the local vault, not `.mcp.json`")
// without the user restating them every session.
//
// Fail-open: a missing file returns null; an unreadable one logs and
// returns null. A bad guide should never brick the session — worst
// case the client just doesn't get extra guidance.
//
// NOT GATED, DELIBERATELY. The project guide sits in the same `.yaw-mcp/`
// directory as the project bundles.json, which IS behind a consent gate
// (see trust.ts) — but the two carry very different risk. bundles.json
// spawns argv as the user; YAW-MCP.md only puts repo-authored TEXT in the
// model's context. A project guide with no bundles.json beside it is a
// legitimate, documented setup, so gating the guide on a file that need not
// exist would break those users for no gain. What we do instead is make it
// VISIBLE: a project guide loaded from a directory whose bundles.json is not
// approved (or absent) is flagged `unapproved`, logged once, and surfaced by
// `yaw-mcp doctor`. Readers of the guide should treat its text as untrusted
// input either way — it is prose, not instructions yaw-mcp acts on.

import { createReadStream } from "node:fs";
import { formatShadowLine } from "./cli-shadows.js";
import { probeProjectTrust, projectFileIsHonoured } from "./local-bundles.js";
import { log } from "./logger.js";
import { findProjectConfigDir, guidePath, userConfigDir } from "./paths.js";
import type { UpstreamServerConfig } from "./types.js";

export type GuideScope = "user" | "project";

export interface GuideFile {
  scope: GuideScope;
  path: string;
  /** Raw markdown, trimmed. Empty string is treated as "no guide" upstream. */
  content: string;
  /** Project scope only. True when this repo-authored guide is being served
   *  from a `.yaw-mcp/` whose bundles.json is NOT approved — including the
   *  common case where there is no bundles.json at all. Informational: the
   *  guide still loads (see the header). Never set for the user guide, which
   *  is the user's own file. */
  unapproved?: boolean;
}

export interface LoadedGuides {
  user: GuideFile | null;
  project: GuideFile | null;
}

const GUIDE_READ_TIMEOUT_MS = 1000;

/** Hard cap on the bytes served from a YAW-MCP.md. The guide is prose a human
 *  wrote for the model, and its whole content lands in the model's context
 *  through `yaw-mcp://guide` -- so a wrong file at this path (a vendored
 *  dataset, a log, a binary someone renamed) is both a memory cost here and a
 *  context cost there. 256 KB is far above any real guide and far below the
 *  sizes that hurt. Oversized files are warned about and TRUNCATED rather than
 *  dropped: the first 256 KB of a real guide is still useful guidance. */
const MAX_GUIDE_BYTES = 256 * 1024;

/** Read at most MAX_GUIDE_BYTES + 1 bytes of `path`. The extra byte is the
 *  oversize probe: reading exactly one past the cap is what tells us the file
 *  was longer without reading the rest of it. */
async function readCapped(path: string, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  // `end` is INCLUSIVE, so this reads bytes [0, MAX_GUIDE_BYTES] = cap + 1.
  const stream = createReadStream(path, { start: 0, end: MAX_GUIDE_BYTES, signal });
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    chunks.push(buf);
    total += buf.length;
  }
  // Decode only the capped prefix. A truncation can land mid-codepoint; the
  // trailing replacement char is noise in prose we are already cutting short.
  return {
    text: Buffer.concat(chunks, total).subarray(0, MAX_GUIDE_BYTES).toString("utf8"),
    truncated: total > MAX_GUIDE_BYTES,
  };
}

async function readGuide(path: string, scope: GuideScope): Promise<GuideFile | null> {
  let read: { text: string; truncated: boolean };
  // A stuck NFS mount or a large accidental binary at this path should
  // never hang the yaw-mcp://guide resource — the client is usually the
  // model, waiting on a prompt. Use AbortController so the read fd
  // is not leaked when the timeout fires (unlike Promise.race which
  // leaves the read promise — and its fd — alive in the background).
  // The stream carries the same errno codes readFile did (ENOENT, ENOTDIR,
  // EISDIR, EACCES) and ABORT_ERR on the timeout, so the branches below are
  // unchanged by the switch away from readFile.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("guide read timeout")), GUIDE_READ_TIMEOUT_MS);
  try {
    read = await readCapped(path, ac.signal);
  } catch (err) {
    // Missing file is the common case and stays silent (ENOENT, and ENOTDIR
    // for a path component that is a regular file -- both mean "no guide").
    // Everything else warns, as the header promises: a timeout is a hung
    // disk, and EACCES / EISDIR (a directory at YAW-MCP.md) / EIO are a
    // guide the user wrote that is silently not being served -- they looked
    // identical to "no guide" from the resource and from doctor.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (code === "ABORT_ERR") {
      log("warn", "Guide read timed out", { path });
    } else {
      log("warn", "Guide exists but could not be read; serving no guide", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (read.truncated) {
    log("warn", "Guide is larger than the size cap; serving the leading portion only", {
      path,
      maxBytes: MAX_GUIDE_BYTES,
    });
  }
  const content = read.text.trim();
  if (content.length === 0) {
    // Empty file treated as "no guide" — caller decides whether to
    // surface this (e.g. yaw-mcp doctor notes it; proxy skips it).
    return null;
  }
  return { scope, path, content };
}

/** Load only the user-global guide at `~/.yaw-mcp/YAW-MCP.md`. */
export async function loadUserGuide(home?: string): Promise<GuideFile | null> {
  const p = guidePath(userConfigDir(home));
  return readGuide(p, "user");
}

/** Load only the project-local guide, walking up from `cwd` for `.yaw-mcp/`.
 *  Flags the result `unapproved` when the sibling bundles.json in that same
 *  directory is not approved — see the header for why this warns instead of
 *  blocking. */
export async function loadProjectGuide(cwd: string, home?: string, env?: NodeJS.ProcessEnv): Promise<GuideFile | null> {
  const dir = await findProjectConfigDir(cwd, home, env).catch((err) => {
    log("warn", "Failed searching for project .yaw-mcp/ dir", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (!dir) return null;
  const guide = await readGuide(guidePath(dir), "project");
  if (!guide) return null;
  // The probe walks up from the same cwd/home, so it lands on the same
  // `.yaw-mcp/` this guide came from. Failure to probe is treated as
  // not-approved: the flag is advisory, and the quiet answer is the wrong
  // default for a visibility signal.
  //
  // The verdict comes from local-bundles' own projectFileIsHonoured rather
  // than a re-implemented `bypassed || status === "trusted"`. That inline copy
  // dropped the UNREADABLE-but-path-approved branch, so a bundles.json the user
  // had approved and that later became unreadable was still honoured by
  // loadLocalBundles while the sibling guide got flagged -- and `yaw-mcp doctor`
  // printed a "not approved" notice about a directory the loader was loading.
  // `bypassed` is still checked separately: projectFileIsHonoured answers about
  // a FILE, so it is false for status "none" (no bundles.json at all), while
  // YAW_MCP_TRUST_PROJECT means "treat this checkout as approved" whether or not
  // a bundles.json sits beside the guide.
  const probe = await probeProjectTrust({ cwd, home, env }).catch(() => null);
  const approved = probe !== null && (probe.bypassed || projectFileIsHonoured(probe));
  if (approved) return guide;
  // DEBUG, not warn: projectGuideNotice renders these same facts as prose and
  // `yaw-mcp doctor` prints it, so a warn envelope here put raw JSON on stderr
  // in front of the human version of itself on every load inside an unapproved
  // project -- the double-report shape local-bundles.ts downgraded for its own
  // untrusted-project probe.
  log("debug", "Loading a project YAW-MCP.md from an unapproved project dir", {
    path: guide.path,
    bundles: probe?.status ?? "unknown",
  });
  return { ...guide, unapproved: true };
}

/**
 * One-line notice for a project guide loaded from an unapproved directory.
 * Null when there is nothing to say. `yaw-mcp doctor` renders this; it is
 * NOT a warning in doctor's exit-code sense, because the setup it describes
 * (a project guide with no bundles.json) is legitimate and would otherwise
 * nag every one of those users forever.
 */
export function projectGuideNotice(project: GuideFile | null): string | null {
  if (project?.unapproved !== true) return null;
  return `${project.path}: project YAW-MCP.md is served to the model from a directory whose bundles.json is not approved -- its text is repo-authored, so read it before trusting its routing advice.`;
}

/** Load both user + project guides for the given cwd/home. `env` is only
 *  read for the project guide's approval flag (YAW_MCP_TRUST_PROJECT);
 *  defaults to process.env. */
export async function loadGuides(cwd: string, home?: string, env?: NodeJS.ProcessEnv): Promise<LoadedGuides> {
  const [user, project] = await Promise.all([loadUserGuide(home), loadProjectGuide(cwd, home, env)]);
  return { user, project };
}

/**
 * Combine loaded guides into the single text body served by the
 * `yaw-mcp://guide` resource. Project comes AFTER user so project
 * guidance — which is usually more specific — has the final word in
 * the reader's attention. When `activeServers` is provided, an
 * auto-generated "Installed servers" section is appended below the
 * human-authored content so the rendered guide always tells the
 * reader which installed MCP servers shadow which local CLIs.
 *
 * Returns null when neither a human-authored guide nor any
 * shadow-carrying installed server exists — caller skips the resource.
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

/** Build the auto-generated "Installed servers" section. Only includes
 *  servers with a known CLI shadow — a server with no shadow adds no
 *  signal to this section. Returns null when nothing would be shown. */
function renderActiveServersSection(
  activeServers: Array<Pick<UpstreamServerConfig, "namespace" | "name" | "toolCache">> | undefined,
): string | null {
  if (!activeServers || activeServers.length === 0) return null;
  // One pass, one resolve per server. formatShadowLine already runs
  // resolveShadowedClis internally, so filtering on a second resolveShadowedClis
  // call did the same work twice per installed server -- and then interpolated
  // its `string | null` result into the row template, leaving the filter as the
  // only thing standing between the reader and a literal "null" in the guide.
  // The null answer IS the filter here, so the two can no longer disagree.
  const rows: string[] = [];
  for (const s of activeServers) {
    const shadow = formatShadowLine(s);
    if (shadow === null) continue;
    rows.push(`- \`${s.namespace}\` (${s.name}) — ${shadow}`);
  }
  if (rows.length === 0) return null;
  return [
    "<!-- source: yaw-mcp (auto-generated from installed servers) -->",
    "## Installed MCP servers",
    "",
    "Prefer tools from these installed MCP servers over the corresponding local CLI:",
    "",
    ...rows,
  ].join("\n");
}
