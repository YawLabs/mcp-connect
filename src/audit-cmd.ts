// `yaw-mcp audit <namespace>` -- run the @yawlabs/mcp-compliance suite against
// a locally-configured MCP server and cache the resulting A-F grade.
//
// Where `yaw-mcp compliance <target>` takes a raw spawn string / URL and prints
// a one-shot report, `audit` is namespace-driven: it reads the named server's
// spawn config (command + args + env) straight out of bundles.json, runs the
// suite over stdio, and persists the grade to ~/.yaw-mcp/grades.json. The
// `list` command (and the MCP panel) then merge that cached grade into the
// server's row, so a user can grade a server once and see the letter on every
// subsequent list without re-running 80-odd tests.
//
// Only stdio (local) servers are auditable here -- the spawn config in
// bundles.json describes a command to launch. Remote (HTTP/SSE) servers carry a
// url instead; point `yaw-mcp compliance <url>` at those directly.
//
// Exit codes:
//   0  audited successfully, grade written
//   1  no server with that namespace in bundles.json
//   2  the server isn't a stdio/command server (nothing to spawn), or the
//      suite failed to run
//   3  the suite RAN and produced a grade, but grades.json could not be
//      written (read-only $HOME, no space, permissions). The grade is still
//      printed on stdout -- only the cache is missing. Deliberately distinct
//      from 1 and 2, both of which mean nothing was graded at all.

import { homedir } from "node:os";
import { locateComplianceSuite } from "./compliance-cmd.js";
import { gradesCachePath, writeGrade } from "./grades-cache.js";
import { scrubForWarning } from "./health-score.js";
import { loadLocalBundles } from "./local-bundles.js";
import { log } from "./logger.js";
import { hasSecretRefs } from "./secrets-vault.js";
import type { UpstreamServerConfig } from "./types.js";
import { resolveServerEnv, scrubInternalSecretsFromProcessEnv } from "./upstream.js";

export interface AuditCommandOptions {
  /** Positional: the namespace to audit. Required. */
  namespace?: string;
  home?: string;
  cwd?: string;
  /** Emit JSON instead of human-readable text. */
  json?: boolean;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /**
   * Test hook: skip the real compliance suite. Receives the resolved
   * stdio target and returns the report fields we persist. Defaults to the
   * real @yawlabs/mcp-compliance runner (loaded lazily so unit tests that
   * inject a runner never spin up a child process).
   */
  runner?: (target: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }) => Promise<{ grade: "A" | "B" | "C" | "D" | "F"; score: number; suiteVersion?: string }>;
  /**
   * Test hook: which platform's spawn semantics to apply. Only the cmd.exe
   * metacharacter gate reads it (the compliance runner uses `shell: true` on
   * Windows and nowhere else), so pinning it lets that branch be exercised from
   * a Linux runner. Defaults to the real host.
   */
  platform?: NodeJS.Platform;
}

/** Only the exit code. index.ts reads nothing else, and tests capture output
 *  through the out/err hooks -- a `lines` transcript used to ride along here
 *  with no consumer at all. */
export interface AuditCommandResult {
  exitCode: number;
}

/** cmd.exe metacharacters that split or redirect an UNQUOTED command line:
 *  `&` (chain), `|` (pipe), `<` `>` (redirect), `^` (escape), `(` `)`
 *  (grouping). Same set install-targets.ts refuses/escapes for the `cmd /c`
 *  launcher entries, and for the same reason -- `%` is excluded there and here
 *  because cmd expands `%VAR%` BEFORE any escape processing (so nothing short
 *  of refusing every literal `%` helps) while a bare `%NAME%` for an unset
 *  variable is passed through literally, which is the common case: refusing it
 *  would reject ordinary percent-encoded URL args for no gain. */
const CMD_METACHAR_RE = /[&|<>^()]/;

/**
 * First token of a stdio spawn config that carries a cmd.exe metacharacter, or
 * undefined when every token is safe to hand to a `shell: true` spawn on
 * Windows. The command itself is checked alongside the args: it is joined into
 * the same command line, so a metacharacter there splits it just as readily.
 *
 * Exported for tests -- the caller's branch is win32-only, and this is the part
 * whose character set has to be asserted directly.
 */
export function findCmdMetacharToken(command: string, args: readonly string[]): string | undefined {
  return [command, ...args].find((t) => CMD_METACHAR_RE.test(t));
}

// Flags whose VALUE (the very next arg) carries a credential / secret.
// We only redact the value, never the flag name -- the operator still needs
// to see WHICH flag was passed, just not what was passed to it. Matches the
// `--flag value` shape; the `--flag=value` shape is handled separately below.
//
// Stored lowercase and matched case-insensitively: flag casing is a style
// choice, not a semantic one, and a case-sensitive Set printed `--Token abc`
// (or `--API-KEY=...`) with the secret fully in the clear.
//
// The exact set carries the short forms (`-p`) and the canonical spellings;
// SECRET_FLAG_RE below is what covers everything else.
const SECRET_FLAG_NAMES = new Set<string>([
  "--api-key",
  "--apikey",
  "--token",
  "--auth",
  "--auth-token",
  "--password",
  "--secret",
  "-p",
]);

/** Name-pattern fallback for secret-bearing flags outside the exact set.
 *  An exact 8-name denylist is a leak-prevention control that fails open on
 *  the first spelling nobody enumerated -- `--access-token`, `--client-secret`,
 *  `--api_key`, `--bearer`, `--passwd`, `--credential` all printed their values
 *  in the clear in the interactive preamble.
 *
 *  ANCHORED AT BOTH ENDS, and that is load-bearing: without the trailing
 *  `[a-z0-9_-]*$` the pattern also matches `--token=abc` (the `=value` shape),
 *  which sends it down the `--flag value` branch -- echoing the whole
 *  `--token=abc` verbatim and redacting the innocent NEXT arg instead. The
 *  anchor keeps `=` out, so the `=value` shape stays with the splitter below.
 *
 *  Deliberately over-matches (`--author`, `--credentials-file` redact too):
 *  redaction is display-only -- the runner still receives the unredacted args
 *  -- so a false positive costs one line of visibility while a false negative
 *  prints a live credential. */
const SECRET_FLAG_RE = /^--?[a-z0-9_-]*(token|secret|passw|apikey|api[-_]?key|auth|cred|bearer)[a-z0-9_-]*$/i;

/**
 * Return a copy of `args` with the VALUE following any secret-bearing flag
 * replaced by "<redacted>". Two shapes are handled:
 *   ["--token", "abc"]    -> ["--token", "<redacted>"]
 *   ["--token=abc"]       -> ["--token=<redacted>"]
 * Bare flags with no following value are left alone (the redaction target
 * is the value, not the presence of the flag).
 * Flag matching is CASE-INSENSITIVE: `--Token` / `--API-KEY` redact exactly
 * like `--token` / `--api-key`. The flag name itself is echoed back with the
 * operator's original casing. A flag outside the exact set still redacts when
 * its NAME matches SECRET_FLAG_RE (`--access-token`, `--client_secret`, ...).
 *
 * This is the FIRST of two passes over the preamble. It knows only the two
 * flag shapes above; a credential anywhere else -- inside a URL's query
 * string, an `Authorization: Bearer ...` header arg, an inline JSON body --
 * is not a flag value and printed in the clear. The joined line therefore
 * also goes through health-score's scrubForWarning (see runAudit), which
 * covers exactly those shapes; keeping this pass is what preserves the
 * `--flag <redacted>` rendering the operator reads the argv by.
 *
 * Exported for tests -- the redaction is a leak-prevention control, so it is
 * asserted directly as well as through the `audit` preamble.
 */
export function redactSecretArgs(args: readonly string[]): string[] {
  const isSecretFlag = (s: string): boolean => SECRET_FLAG_NAMES.has(s.toLowerCase()) || SECRET_FLAG_RE.test(s);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (isSecretFlag(a)) {
      out.push(a);
      if (i + 1 < args.length) {
        out.push("<redacted>");
        i += 1;
      }
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0 && isSecretFlag(a.slice(0, eq))) {
      out.push(`${a.slice(0, eq)}=<redacted>`);
      continue;
    }
    out.push(a);
  }
  return out;
}

export interface ParsedAuditArgs {
  namespace: string;
  json: boolean;
}

export const AUDIT_USAGE = `Usage: yaw-mcp audit <namespace> [--json]

  Run the MCP compliance suite against a server configured in your local
  bundles.json and cache its A-F grade in ~/.yaw-mcp/grades.json. The cached
  grade then shows up in the GRADE column of \`yaw-mcp list\` and the Yaw
  Terminal MCP panel.

  <namespace>   The namespace of a stdio server in bundles.json (see
                \`yaw-mcp list\`).
  --json        Emit machine-readable JSON instead of text.

  To grade an arbitrary target (a URL, or a command not in bundles.json),
  use \`yaw-mcp compliance <target>\` instead.`;

// Split out so index.ts can validate args early and surface a usage error
// instead of falling through to runServer on a typo.
export function parseAuditArgs(
  argv: string[],
): { ok: true; options: ParsedAuditArgs } | { ok: false; error: string; help?: boolean } {
  let json = false;
  let namespace: string | undefined;
  for (const a of argv) {
    if (a === "--json") {
      json = true;
    } else if (a === "--help" || a === "-h") {
      // Flag --help so the dispatcher routes it to stdout + exit 0, matching
      // every sibling subcommand instead of stderr + exit 2.
      return { ok: false, error: AUDIT_USAGE, help: true };
    } else if (a.startsWith("-")) {
      return { ok: false, error: `yaw-mcp audit: unknown argument "${a}"\n\n${AUDIT_USAGE}` };
    } else if (namespace === undefined) {
      namespace = a;
    } else {
      return { ok: false, error: `yaw-mcp audit: unexpected extra argument "${a}"\n\n${AUDIT_USAGE}` };
    }
  }
  if (namespace === undefined) {
    return { ok: false, error: `yaw-mcp audit: missing <namespace>.\n\n${AUDIT_USAGE}` };
  }
  return { ok: true, options: { namespace, json } };
}

/** Look up a server by namespace in the loaded local bundles. */
function findServer(servers: UpstreamServerConfig[], namespace: string): UpstreamServerConfig | undefined {
  return servers.find((s) => s.namespace === namespace);
}

/**
 * Resolve the INSTALLED @yawlabs/mcp-compliance PACKAGE version -- the rubric
 * identifier defaultRunner records as `suiteVersion`. Rubric changes ship as
 * package releases (0.17.x -> 0.18.0), so the package version is what tells a
 * letter graded under an older rubric from a current one. The package's
 * exported SPEC_VERSION is NOT that: it is the MCP protocol revision date
 * ("2025-11-25"), identical across compliance releases, so persisting it made
 * every rubric's letters indistinguishable.
 *
 * The lookup itself (an ancestor walk over node_modules, read off the manifest
 * because the package's `exports` map hides it from the module system) lives
 * in compliance-cmd.ts as locateComplianceSuite: `compliance` needs the same
 * install to spawn its bin script, and keeping the walk there means that
 * command no longer imports this module -- and with it upstream.ts and the
 * vault -- just to read a version string.
 *
 * `fromUrl` is injectable for tests; it defaults to this module's own URL.
 * Returns undefined (never throws) when nothing resolvable is found -- the
 * cache entry then simply omits `suiteVersion`, same as a pre-field entry.
 */
export async function resolveComplianceSuiteVersion(fromUrl: string = import.meta.url): Promise<string | undefined> {
  return (await locateComplianceSuite(fromUrl))?.version;
}

/** Lazily load the real compliance runner. Kept behind a dynamic import so a
 *  test that injects `opts.runner` never resolves @yawlabs/mcp-compliance and
 *  never spawns a child. */
async function defaultRunner(target: {
  command: string;
  args: string[];
  env?: Record<string, string>;
}): Promise<{ grade: "A" | "B" | "C" | "D" | "F"; score: number; suiteVersion?: string }> {
  // The compliance PACKAGE version rides along so the cached grade records
  // WHICH rubric produced the letter (see resolveComplianceSuiteVersion for
  // why it is the package version, not the exported SPEC_VERSION) -- read here
  // (not at writeGrade) so runner-injecting tests keep never resolving
  // @yawlabs/mcp-compliance.
  const { runComplianceSuite } = await import("@yawlabs/mcp-compliance");
  const suiteVersion = await resolveComplianceSuiteVersion();
  const report = await runComplianceSuite({
    type: "stdio",
    command: target.command,
    args: target.args,
    env: target.env,
  });
  return suiteVersion
    ? { grade: report.grade, score: report.score, suiteVersion }
    : { grade: report.grade, score: report.score };
}

export async function runAudit(opts: AuditCommandOptions = {}): Promise<AuditCommandResult> {
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => write(`${s}\n`);
  const printErr = (s: string): void => writeErr(`${s}\n`);

  const namespace = opts.namespace;
  if (!namespace) {
    // Unreachable from the CLI: parseAuditArgs requires a <namespace> and
    // index.ts exits 2 on a parse error before runAudit is ever called. Only
    // a direct test/programmatic caller that omits `namespace` lands here.
    // Exit 2 matches the parse-layer usage-error convention (index.ts), not
    // the exit-1 "namespace not found" case below.
    printErr("yaw-mcp audit: missing <namespace>.");
    return { exitCode: 2 };
  }

  const home = opts.home ?? homedir();
  const { config, path, warnings } = await loadLocalBundles({ cwd: opts.cwd, home });
  // Surface loader diagnostics the way the sibling commands do (list,
  // sidecars, bundles). Without this, a malformed or unreadable bundles.json
  // loads as zero servers and gets reported below as `no server named "X"` --
  // with exit 1, the code the header reserves for a typo'd namespace -- while
  // the real problem never surfaces. stderr keeps --json stdout pure.
  for (const w of warnings) printErr(`warning: ${w}`);
  const servers = config?.servers ?? [];
  const server = findServer(servers, namespace);

  if (!server) {
    const where = path ? ` (${path})` : "";
    printErr(
      `yaw-mcp audit: no server named "${namespace}" in bundles.json${where}. Run \`yaw-mcp list\` to see configured servers.`,
    );
    return { exitCode: 1 };
  }

  // Only stdio/command servers are auditable here. A remote server carries a
  // url, not a command -- there's nothing to spawn, so point the user at
  // `yaw-mcp compliance <url>` instead.
  if (!server.command) {
    if (server.url) {
      printErr(
        `yaw-mcp audit: "${namespace}" is a remote server (${server.url}). Audit grades stdio servers; run \`yaw-mcp compliance ${server.url}\` to grade a remote target.`,
      );
    } else {
      printErr(`yaw-mcp audit: "${namespace}" has no command to spawn -- it can't be audited as a stdio server.`);
    }
    return { exitCode: 2 };
  }

  // Windows only: the compliance runner spawns the audited server with
  // `shell: true` on win32 (@yawlabs/mcp-compliance, so that `.cmd`/`.bat`
  // launcher shims resolve). Node's shell path JOINS command + args into one
  // string with plain spaces and hands it to `cmd.exe /d /s /c`, so an
  // unquoted `&` / `|` / `<` / `>` / `^` / `(` / `)` anywhere in the spawn
  // config is parsed by cmd rather than passed through: at best the audited
  // command is truncated and graded F for a failure yaw-mcp caused, at worst
  // the tail after an `&` runs as a second command. Refuse BEFORE resolving
  // vault refs below, so a target we will not spawn never unlocks the vault.
  //
  // Refuse rather than escape. install-targets' escapeCmdArg solves the
  // sibling problem for the `cmd /c` entries yaw-mcp WRITES, but its rules are
  // calibrated to libuv's argv quoting (an arg containing a space or a quote is
  // left verbatim because libuv wraps it) -- and the shell:true path does no
  // such wrapping, so reusing it here would leave the metacharacter live in
  // exactly the space-plus-metachar case. Nothing is graded, so exit 2 with the
  // other "nothing to spawn" outcomes.
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    const offender = findCmdMetacharToken(server.command, server.args ?? []);
    if (offender !== undefined) {
      printErr(
        `yaw-mcp audit: "${namespace}" cannot be audited on Windows -- its spawn config contains a cmd.exe metacharacter (& | < > ^ parentheses) in ${JSON.stringify(offender)}. The compliance suite spawns stdio targets through cmd.exe here, which would split the command line at that character. Rework the server's command/args in bundles.json to drop it, or audit this server on macOS/Linux.`,
      );
      return { exitCode: 2 };
    }
  }

  // Resolve ${secret:NAME} vault refs the same way the real spawn does
  // (upstream.ts resolveServerEnv: fail CLOSED on a locked/missing vault or
  // a missing secret). Handing the compliance suite the raw bundles.json env
  // graded a vault-backed server with the literal placeholder in its
  // environment -- it auth-failed, the wrong letter was cached, and `list`
  // and the MCP panel then showed it. Now the audited env IS the env the
  // server actually runs with.
  let auditEnv: Record<string, string> | undefined = server.env;
  if (server.env && hasSecretRefs(server.env)) {
    try {
      auditEnv = await resolveServerEnv(server.env, namespace);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const refNames = Object.entries(server.env)
        .filter(([, v]) => typeof v === "string" && v.includes("${secret:"))
        .map(([k]) => k);
      printErr(
        `yaw-mcp audit: "${namespace}" references vault secrets (${refNames.join(", ")}) that could not be resolved: ${msg}. Set YAW_MCP_VAULT_PASSPHRASE (and store the secrets with \`yaw-mcp secrets set\`) so the audit runs with the server's real environment.`,
      );
      return { exitCode: 2 };
    }
  }
  // The compliance runner spawns the audited server with `{ ...process.env,
  // ...env }`. The broker's real spawn strips yaw-mcp's own secrets from the
  // child env (upstream.ts stripInternalSecretsFromEnv); this path must too,
  // and it matters MORE here: resolving the refs above requires
  // YAW_MCP_VAULT_PASSPHRASE to be set, so without the scrub the documented
  // way to audit a vault-backed server hands the vault passphrase to a
  // third-party server. One-shot CLI, so mutating process.env is safe.
  scrubInternalSecretsFromProcessEnv();
  const target = {
    command: server.command,
    args: server.args ?? [],
    env: auditEnv,
  };

  // In --json mode stdout must be pure JSON (the Yaw MCP panel parses it), so
  // skip the human preamble; print it only for interactive use. (A server arg
  // containing a brace would otherwise corrupt brace-based JSON extraction.)
  //
  // Two redaction passes over the args, both display-only (the runner gets
  // the raw argv). redactSecretArgs handles the `--flag value` shapes and keeps
  // the flag name legible; scrubForWarning then covers everything that is not
  // a flag value -- `?api_key=` in a URL, `Authorization: Bearer ...` in a
  // header arg, a `"token":"..."` JSON body, a vendor-prefixed key -- which the
  // first pass printed in the clear. Each ARG goes through it on its own, then
  // they are joined: the scrubber's whole-clause tail runs to the next
  // NAME=/NAME: pair or a dash-run, so on a space-joined line a
  // `X-Api-Key: abc` arg swallowed every positional arg after it (a path, a
  // port) and the closing paren; per-arg scrubbing bounds the tail at the
  // argument. It also collapses runs of whitespace inside an arg to one
  // space, which is fine for a preamble.
  if (!opts.json) {
    const printableArgs = redactSecretArgs(target.args)
      .map((a) => scrubForWarning(a))
      .join(" ");
    print(`Auditing "${namespace}" (${target.command}${printableArgs.length ? ` ${printableArgs}` : ""})...`);
  }

  const runner = opts.runner ?? defaultRunner;
  let report: { grade: "A" | "B" | "C" | "D" | "F"; score: number; suiteVersion?: string };
  try {
    report = await runner(target);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // DEBUG, not error: the prose line below carries the same facts and goes to
    // the same stderr, so logging at error too put a raw JSON envelope directly
    // in front of the human version of itself. Same double-report shape
    // local-bundles.ts downgraded for its untrusted-project probe.
    log("debug", "audit: compliance suite failed", { namespace, error: msg });
    printErr(`yaw-mcp audit: compliance suite failed for "${namespace}": ${msg}`);
    return { exitCode: 2 };
  }

  const gradedAt = new Date().toISOString();
  // writeGrade re-throws its own errors on purpose, and atomicWriteFile throws
  // on EROFS / EACCES / ENOSPC -- a read-only $HOME (containers, locked-down
  // CI images) is the common shape. Unguarded, that threw straight out of
  // runAudit: index.ts's dispatch catch printed a raw errno line, the grade the
  // 80-test suite just spent minutes computing was never printed at all, and
  // the process exited 1 -- the code this file documents as "no server with
  // that namespace", so a caller branching on exit codes misread a cache-write
  // failure as a typo'd namespace. Print the grade regardless and use the
  // dedicated exit 3 (see the header): the audit DID produce a result, so this
  // must not collide with 1 (nothing found) or 2 (nothing graded).
  let cachePath: string | null = null;
  let cacheError: string | null = null;
  try {
    cachePath = await writeGrade(
      namespace,
      report.suiteVersion
        ? { grade: report.grade, score: report.score, gradedAt, suiteVersion: report.suiteVersion }
        : { grade: report.grade, score: report.score, gradedAt },
      home,
    );
  } catch (err) {
    cacheError = err instanceof Error ? err.message : String(err);
    // DEBUG for the same reason as the runner failure above: `cacheError` is
    // reported in prose on stderr at the end of this function (and in the
    // --json payload), so an error-level envelope here only doubles it.
    log("debug", "audit: grade cache write failed", { namespace, error: cacheError });
  }

  if (opts.json) {
    // `cache` stays present and becomes null on failure (rather than being
    // omitted) so the Yaw MCP panel's parse keeps working; `cacheError` names
    // what went wrong. The grade itself is reported either way.
    const payload: Record<string, unknown> = {
      namespace,
      grade: report.grade,
      score: report.score,
      gradedAt,
      // The rubric that produced the letter. It is persisted to grades.json, so
      // a --json consumer that omitted it could not tell an "A" graded under an
      // older rubric from a current one -- the whole reason the field exists.
      // OMITTED rather than null when the runner reported none, matching the
      // cache entry (a pre-field entry simply has no key).
      ...(report.suiteVersion !== undefined ? { suiteVersion: report.suiteVersion } : {}),
      cache: cachePath,
    };
    if (cacheError !== null) payload.cacheError = cacheError;
    print(JSON.stringify(payload, null, 2));
  } else {
    print(`Grade: ${report.grade} (${report.score.toFixed(1)}%)`);
    if (cachePath !== null) print(`Cached to ${cachePath}`);
  }

  if (cacheError !== null) {
    printErr(
      `yaw-mcp audit: computed grade ${report.grade} but could not write ${gradesCachePath(home)}: ${cacheError}`,
    );
    return { exitCode: 3 };
  }
  return { exitCode: 0 };
}
