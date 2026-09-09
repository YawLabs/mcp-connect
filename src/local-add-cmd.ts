// `yaw-mcp add <slug>` / `remove <slug>` / `list`
//
// These manage the LOCAL server set in ~/.yaw-mcp/bundles.json -- the file
// yaw-mcp loads in no-account (Free) mode. This is deliberately distinct from
// `yaw-mcp install <client>`, which wires the yaw-mcp aggregator INTO an AI
// client's config. "install" connects a client; "add" adds a server.
//
//   add <slug>     resolve <slug> from the yaw.sh/mcp catalog and write it
//                  into ~/.yaw-mcp/bundles.json
//   remove <slug>  drop a server (by slug or namespace) from bundles.json
//   list           show the servers yaw-mcp would load locally, each with the
//                  compliance grade `yaw-mcp audit` last cached for it
//
// `add` resolves through the same static catalog the website and the Yaw
// Terminal app use (catalog.ts), so a slug that works as an "Add to Yaw MCP"
// button works here too.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { CATALOG_SLUG_RE, type FetchCatalog, resolveCatalogSlug, tokenizeCommand } from "./catalog.js";
import { type GradesCache, readGradesCache } from "./grades-cache.js";
// The removal gate must see the same files the WRITE path can modify, so it
// parses with the loader's JSONC parser (comments + trailing commas) rather
// than a stricter JSON.parse. See findRemovalTarget.
import { parseJsonc } from "./jsonc.js";
import {
  BundleCollisionError,
  deriveNamespace,
  findShadowingProjectBundles,
  formatBundleCollision,
  type LaunchChange,
  loadLocalBundles,
  localBundlesPath,
  previewUpsertUserBundle,
  removeUserBundle,
  upsertUserBundle,
} from "./local-bundles.js";
import { userConfigDir } from "./paths.js";
import { QUESTION_CANCELLED, type QuestionCancelled, questionOrEmpty } from "./readline-question.js";
// The removal preview renders command / args / url / name straight out of
// bundles.json immediately above a [y/N] prompt, so it needs the same
// control-byte neutering the `trust` gate uses. IMPORTED, never re-spelled:
// a second hand-rolled copy of that escape logic would drift from the one
// trust-cmd's tests actually cover.
import { displayArg, displaySafe } from "./trust-cmd.js";
import type { UpstreamServerConfig } from "./types.js";

// --- add --------------------------------------------------------------------

export const ADD_USAGE = `Usage: yaw-mcp add <slug> [flags]
       yaw-mcp add <name> --command "<launch line>" [flags]
       yaw-mcp add <name> --url <https://...> [flags]

  Add an MCP server to your local ~/.yaw-mcp/bundles.json so yaw-mcp loads it
  (no account needed). With neither --command nor --url, <slug> is resolved
  from the yaw.sh/mcp catalog; with either, you are defining the server
  yourself and no catalog is fetched -- so this also works offline.

  This is NOT the same as \`yaw-mcp install\` -- install wires the yaw-mcp
  aggregator into an AI client; add adds an MCP server to yaw-mcp itself.

  Defining a server directly:

  --command <line>  Launch line for a LOCAL (stdio) server, quoted as one
                    argument: --command "npx -y @scope/my-mcp@latest". Split
                    with the same tokenizer the catalog's launch lines use.
  --url <url>       Endpoint for a REMOTE (http) server. http or https only.
  --header "K: V"   Send an HTTP header on every request to a remote server.
                    Repeatable. This is how a remote server gets a credential
                    -- it spawns no process, so --env cannot reach it. Use a
                    vault reference for a real one:
                    --header 'Authorization: Bearer \${secret:NAME}'
  --transport <t>   streamable-http (default) or sse, for --url.
  --description <s> Free text describing what the server is for. Worth
                    setting: dispatch ranks servers on it.

  --env KEY=value   Provide a required env var's value. Repeatable. Required
                    vars not given here AND not in your shell block the add.
                    The value lands in your shell history and process argv
                    like any argument, and is stored in plain text (file mode
                    0600) in bundles.json. For a real credential, store it
                    with \`yaw-mcp secrets set NAME\` and pass
                    --env KEY='\${secret:NAME}' instead: the vault resolves it
                    at launch and only the reference is written. The single
                    quotes stop bash/zsh/PowerShell expanding it to nothing;
                    in cmd.exe use no quotes ($ is not special there --
                    cmd.exe keeps single quotes as part of the value, and the
                    server would receive a quoted token). Or leave it
                    out to keep a shell-resident secret off disk entirely --
                    the server inherits it at launch.
  --dry-run         Print what would be written without writing.
  --json            Emit the written entry as JSON (implies success on stdout).
                    Env vars appear as \`envKeys\` -- key NAMES only, never the
                    stored values.
  --catalog <url>   Override the catalog URL. Precedence: --catalog, then
                    $YAW_MCP_CATALOG_URL, then the public catalog.`;

export interface AddCommandOptions {
  slug?: string;
  envOverrides?: Record<string, string>;
  dryRun?: boolean;
  json?: boolean;
  catalogUrl?: string;
  /** `--command "npx -y foo"`: define a LOCAL server directly, no catalog. */
  command?: string;
  /** `--url https://...`: define a REMOTE server directly, no catalog. */
  url?: string;
  /** `--header "K: V"`, repeatable. Remote entries only. */
  headers?: Record<string, string>;
  /** `--transport sse` for a remote entry; defaults to streamable-http. */
  transport?: "streamable-http" | "sse";
  /** `--description`: free text the BM25 ranker indexes for dispatch. */
  description?: string;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchCatalog?: FetchCatalog;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export interface AddCommandResult {
  exitCode: number;
  written: string[];
}

function parseEnvFlag(v: string | undefined, bag: Record<string, string>): string | null {
  if (!v?.includes("=")) return "--env requires KEY=value";
  const eq = v.indexOf("=");
  const key = v.slice(0, eq);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `--env: invalid KEY "${key}"`;
  bag[key] = v.slice(eq + 1);
  return null;
}

/** RFC 7230 field-name: no spaces, no colon, no control bytes. Enforced so a
 *  typo cannot produce an entry that fails opaquely at connect time, and so a
 *  newline can never be smuggled into a header name. */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** `--header "Authorization: Bearer x"`. Split on the FIRST colon only: a
 *  value legitimately contains colons (a URL, a `Bearer` blob), and splitting
 *  greedily would truncate them. */
function parseHeaderFlag(v: string | undefined, bag: Record<string, string>): string | null {
  if (v === undefined) return '--header requires "Name: value"';
  const colon = v.indexOf(":");
  if (colon <= 0) return `--header: expected "Name: value", got ${JSON.stringify(v)}`;
  const name = v.slice(0, colon).trim();
  const value = v.slice(colon + 1).trim();
  if (!HEADER_NAME_RE.test(name)) return `--header: invalid header name ${JSON.stringify(name)}`;
  // A blank value is refused rather than dropped: silently omitting the header
  // the user just asked for would send an unauthenticated request and leave
  // them reading a 401 with no sign their flag did nothing.
  if (value === "") return `--header: ${name} has no value`;
  // A CR, LF or NUL cannot be sent as a header value -- Node's Headers throws
  // on one. upstream.ts refuses it at connect time too (bundles.json is
  // hand-editable, so that is the load-bearing guard); catching it here means
  // the typo is refused while the user is still looking at the command that
  // made it, rather than at their next session.
  if (/[\r\n\0]/.test(value)) {
    return `--header: ${name} value contains a newline or NUL`;
  }
  bag[name] = value;
  return null;
}

export function parseAddArgs(
  argv: string[],
): { ok: true; options: AddCommandOptions } | { ok: false; error: string; help?: boolean } {
  if (argv.length === 0) return { ok: false, error: ADD_USAGE };
  const positional: string[] = [];
  const opts: AddCommandOptions = {};
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--env": {
        const e = parseEnvFlag(next(), env);
        if (e) return { ok: false, error: e };
        break;
      }
      case "--command": {
        const v = next();
        // Reject a following flag for the same reason --catalog does: a
        // launch line never starts with "-", and swallowing the next flag
        // would drop it silently.
        if (!v || v.startsWith("-")) return { ok: false, error: "--command requires a launch line" };
        opts.command = v;
        break;
      }
      case "--url": {
        const v = next();
        if (!v || v.startsWith("-")) return { ok: false, error: "--url requires a URL" };
        opts.url = v;
        break;
      }
      case "--header": {
        const e = parseHeaderFlag(next(), headers);
        if (e) return { ok: false, error: e };
        break;
      }
      case "--transport": {
        const v = next();
        if (v !== "streamable-http" && v !== "sse") {
          return { ok: false, error: "--transport must be streamable-http or sse" };
        }
        opts.transport = v;
        break;
      }
      case "--description": {
        const v = next();
        if (v === undefined || v.startsWith("-")) return { ok: false, error: "--description requires text" };
        opts.description = v;
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--catalog": {
        const v = next();
        // Reject a following flag (e.g. `add slug --catalog --dry-run`, which
        // would otherwise set catalogUrl="--dry-run" and drop the flag). Single
        // dash included, for the same reason the default case below rejects it:
        // a URL never starts with "-".
        if (!v || v.startsWith("-")) return { ok: false, error: "--catalog requires a URL" };
        opts.catalogUrl = v;
        break;
      }
      case "-h":
      case "--help":
        return { ok: false, error: ADD_USAGE, help: true };
      default:
        // Single dash included, not just "--": a mistyped SHORT flag (`add
        // fetch -y`, `add -f fetch`) must be reported as an unknown flag
        // instead of becoming a positional and failing later with the
        // misleading "invalid slug" / "Expected exactly one server slug". Same
        // posture parseRemoveArgs already takes, and no valid slug starts with
        // "-" (CATALOG_SLUG_RE requires a leading alphanumeric).
        if (a.startsWith("-")) return { ok: false, error: `Unknown flag: ${a}\n${ADD_USAGE}` };
        positional.push(a);
    }
  }
  const custom = opts.command !== undefined || opts.url !== undefined;
  if (positional.length !== 1) {
    // The positional means different things in the two modes -- a catalog
    // slug, or the name for a server you are defining -- so the message says
    // which one is missing rather than always saying "slug".
    const what = custom ? "server name" : "server slug";
    return { ok: false, error: `Expected exactly one ${what}, got ${positional.length}.\n${ADD_USAGE}` };
  }
  if (opts.command !== undefined && opts.url !== undefined) {
    return { ok: false, error: "--command and --url are mutually exclusive: a server is local or remote, not both." };
  }
  // Flags that only mean something on the mode they belong to are refused
  // rather than ignored. Accepting-and-dropping is how you get a user who
  // passed --header to a stdio server and cannot work out why their token is
  // not being sent -- the same failure `install` was fixed for in 0.79.2.
  if (Object.keys(headers).length > 0) {
    if (opts.url === undefined) {
      return {
        ok: false,
        error: "--header applies to a remote server: pass --url, or set env vars with --env for a local one.",
      };
    }
    opts.headers = headers;
  }
  if (opts.transport !== undefined && opts.url === undefined) {
    return { ok: false, error: "--transport applies to a remote server: pass --url." };
  }
  if (Object.keys(env).length > 0) {
    if (opts.url !== undefined) {
      // Not a style preference: upstream.ts ignores `env` on a remote entry
      // outright, because there is no child process to put it in.
      return {
        ok: false,
        error: "--env does not apply to a remote server: it spawns no process. Use --header to send a credential.",
      };
    }
    opts.envOverrides = env;
  }
  opts.slug = positional[0];
  return { ok: true, options: opts };
}

/** Shape an entry for the `add --json` envelope: env KEY NAMES only, never
 *  values.
 *
 *  `add --json` reports the entry AS WRITTEN, and an update folds whatever was
 *  already on disk back into that object (upsertUserBundle -> mergeServerEntry
 *  copies the stored env), so printing `env` verbatim would put a token some
 *  EARLIER run persisted onto stdout for an invocation that passed no --env at
 *  all -- into CI logs, scrollback, and anything consuming the envelope.
 *
 *  `env` is REPLACED by `envKeys` rather than blanked to "": an empty value
 *  means "nothing persisted, the server depends on the ambient shell var"
 *  everywhere else here (see the ambient-env note in runAdd), so blanking would
 *  claim a stored secret is not on disk. Names only, never values -- the same
 *  posture printRemovalPreview, the dry-run text output and trust-cmd's env
 *  line already take. Read the values from bundles.json if you need them. */
function jsonEntry(entry: Partial<UpstreamServerConfig>): Record<string, unknown> {
  const { env, ...rest } = entry;
  const out: Record<string, unknown> = { ...rest };
  const keys = Object.keys(env ?? {});
  if (keys.length > 0) out.envKeys = keys;
  return out;
}

/** Required keys with no stored value while the shell HAS one: the value
 *  came from the ambient env, not --env, and was deliberately not persisted
 *  (see the seeding note in runAdd). Computed from the entry as written -- or
 *  as the dry run would write it -- never from the flags, so a re-add over an
 *  entry that already carries a stored value stays quiet instead of claiming
 *  nothing was persisted. */
function ambientOnlyRequiredKeys(
  requiredKeys: string[],
  entry: Partial<UpstreamServerConfig>,
  env: NodeJS.ProcessEnv,
): string[] {
  const stored = (entry.env ?? {}) as Record<string, string>;
  return requiredKeys.filter((k) => (stored[k] ?? "").trim() === "" && (env[k] ?? "").trim() !== "");
}

/** The two stderr notes that follow a write -- in the conditional voice for a
 *  dry run. The preview's stated purpose is to describe the run it previews,
 *  and it used to return before either note, so `add --dry-run` said nothing
 *  about the ambient var the server would depend on, nor about the project
 *  file that would shadow the write. stderr so both survive --json. */
async function printPostWriteNotes(
  printErr: (s: string) => void,
  opts: { ambientOnly: string[]; cwd: string; home: string; env: NodeJS.ProcessEnv; dryRun: boolean },
): Promise<void> {
  const { ambientOnly, dryRun } = opts;
  if (ambientOnly.length > 0) {
    const one = ambientOnly.length === 1;
    const verb = dryRun ? "would be" : one ? "was" : "were";
    printErr(
      `Note: ${ambientOnly.join(", ")} ${verb} read from your shell env and NOT persisted; the server depends on ${
        one ? "that var" : "those vars"
      } being present wherever yaw-mcp launches. Pass --env ${ambientOnly[0]}=... to persist a value.`,
    );
  }
  // Honest warning: a project-local bundles.json shadows the user-global file.
  //
  // `env` is passed explicitly: the shadow verdict is trust-aware, and
  // YAW_MCP_TRUST_PROJECT is the documented opt-out. Defaulting it to
  // process.env read a DIFFERENT environment than the one this command was
  // told to run under, so an embedded/test caller that injected the bypass got
  // the un-bypassed answer.
  const shadow = await findShadowingProjectBundles(opts.cwd, opts.home, opts.env).catch(() => null);
  if (shadow) {
    printErr(
      `Note: ${displaySafe(shadow)} overrides your user-global bundles.json, so this entry ${
        dryRun ? "would not" : "won't"
      } load until you add it there or remove that file.`,
    );
  }
}

/** Both halves of a launch swap, rendered like the removal preview: through
 *  renderLaunch, so a stored url-only entry reads as `HTTP <url>` instead of
 *  nothing, and control bytes or whitespace in a stored arg are neutered the
 *  same way every other bundles.json field this file prints is. */
function renderLaunchChange(change: LaunchChange): string {
  return `  from: ${renderLaunch(change.from)}\n    to: ${renderLaunch(change.to)}`;
}

export async function runAdd(opts: AddCommandOptions): Promise<AddCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  if (!opts.slug) {
    printErr(ADD_USAGE);
    return { exitCode: 2, written: [] };
  }
  const slug = opts.slug;
  // The same shape gates both modes: it is a catalog slug in one and the name
  // of a server you are defining in the other, and lowercase-dashes suits both.
  const custom = opts.command !== undefined || opts.url !== undefined;
  if (!CATALOG_SLUG_RE.test(slug)) {
    const what = custom ? "name" : "slug";
    printErr(`yaw-mcp add: invalid ${what} "${slug}" (lowercase letters, digits, and dashes only).`);
    return { exitCode: 2, written: [] };
  }

  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();

  // Resolve the launch shape -- from the flags when the user supplied one, and
  // from the catalog otherwise.
  //
  // `--command` / `--url` make NO network call: the point of them is that the
  // 80-entry catalog is a curated front door rather than the only door, so a
  // server it does not list must not depend on reaching it. That also makes
  // this the one add path that works offline.
  let server: Awaited<ReturnType<typeof resolveCatalogSlug>>;
  if (custom) {
    if (opts.url !== undefined) {
      // Parse here rather than at connect time. upstream.ts already classifies
      // a malformed url as a permanent config error, but that is a failure the
      // user meets on their next session; refusing at add time keeps an entry
      // that can never connect out of bundles.json in the first place.
      let parsed: URL;
      try {
        parsed = new URL(opts.url);
      } catch {
        printErr(`yaw-mcp add: invalid url ${JSON.stringify(opts.url)} -- include the scheme, e.g. https://host/mcp`);
        return { exitCode: 2, written: [] };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        printErr(`yaw-mcp add: url must be http or https, got ${JSON.stringify(parsed.protocol)}`);
        return { exitCode: 2, written: [] };
      }
    }
    let command = "";
    let args: string[] = [];
    if (opts.command !== undefined) {
      // Same tokenizer the catalog's single-string launch lines go through, so
      // a quoted argument behaves identically however the entry was added.
      let tokens: string[];
      try {
        tokens = tokenizeCommand(opts.command);
      } catch (e) {
        printErr(`yaw-mcp add: ${(e as Error).message}`);
        return { exitCode: 2, written: [] };
      }
      [command = "", ...args] = tokens;
      if (!command) {
        printErr(`yaw-mcp add: --command had no executable in it.`);
        return { exitCode: 2, written: [] };
      }
    }
    server = {
      slug,
      name: slug,
      command,
      args,
      // Nothing declares a requirement for a hand-defined server, so there is
      // no required-env gate to fail: whatever --env carries is all there is.
      requiredEnvKeys: [],
      description: opts.description,
    };
  } else {
    try {
      server = await resolveCatalogSlug(slug, {
        // A set-but-EMPTY YAW_MCP_CATALOG_URL survives this `??` (it is not
        // nullish) -- resolveCatalogSlug normalizes empty/whitespace-only back to
        // the default catalog so it can never reach fetch(""). See
        // normalizeCatalogUrl in catalog.ts for why that guard lives there.
        catalogUrl: opts.catalogUrl ?? env.YAW_MCP_CATALOG_URL,
        fetchCatalog: opts.fetchCatalog,
      });
    } catch (e) {
      printErr(`yaw-mcp add: ${(e as Error).message}`);
      return { exitCode: 1, written: [] };
    }
  }

  // Derive the namespace from the resolved catalog NAME via the same algorithm
  // the Yaw Terminal app uses, NOT from the slug -- so the same server lands
  // under the same namespace whether added here or via the app's one-click /
  // "Add to Yaw MCP" badge. (deriveNamespace always returns a valid namespace.)
  const namespace = deriveNamespace(server.name);

  // Required-env gate: refuse with a re-run hint when a required var has no
  // value in --env or the shell. Same posture as `yaw-mcp try` so the two
  // commands behave alike. (The GUI provides the richer fill-in-the-blank UX.)
  const supplied = { ...env, ...(opts.envOverrides ?? {}) } as Record<string, string | undefined>;
  // Trim before the emptiness test so a whitespace-only value (FOO=" ") counts
  // as missing instead of slipping through and persisting a blank-ish secret to
  // bundles.json -- matching the required-env gate in runTry (try-cmd.ts).
  // Named by FUNCTION, not line: the line number this used to cite drifted into
  // an unrelated helper two refactors later.
  const missing = server.requiredEnvKeys.filter((k) => (supplied[k] ?? "").trim() === "");
  if (missing.length > 0) {
    printErr(`yaw-mcp add: ${server.name} needs the following env var(s) before it can run:`);
    for (const k of missing) printErr(`  - ${k}`);
    printErr("");
    printErr("Provide them with --env KEY=value (repeatable) or your shell, then re-run:");
    printErr(`  yaw-mcp add ${slug} ${missing.map((k) => `--env ${k}=...`).join(" ")}`);
    if (server.docUrl) printErr(`Docs: ${server.docUrl}`);
    return { exitCode: 1, written: [] };
  }

  // Seed required keys EMPTY and persist a VALUE only when the user passed it
  // explicitly via --env. yaw-mcp inherits the ambient shell env when it spawns
  // the upstream (upstream.ts), so a shell-resident secret reaches the server
  // at runtime WITHOUT being copied to disk -- matching the app's one-click
  // posture ("env values are not pulled from your shell") and avoiding writing
  // an ambient secret into bundles.json the user never asked to persist.
  const entryEnv: Record<string, string> = {};
  for (const k of server.requiredEnvKeys) entryEnv[k] = "";
  // Trim each --env value before persisting: a whitespace-only value is treated
  // as missing (a required key stays seeded EMPTY; a non-required key is skipped
  // entirely) so it never lands as a blank-ish secret in bundles.json --
  // consistent with the trimmed required-env gate above.
  for (const [k, v] of Object.entries(opts.envOverrides ?? {})) {
    const trimmed = v.trim();
    if (trimmed === "") continue;
    entryEnv[k] = trimmed;
  }

  // `slug` records the CATALOG slug this entry was added with. It is not part
  // of UpstreamServerConfig (validateEntry drops it at load time, and nothing
  // at runtime reads it) -- it exists so `yaw-mcp remove <slug>` can map the
  // slug back to the namespace when the two derive differently: the namespace
  // comes from the display NAME, so `add ga` ("Google Analytics") lands as
  // namespace "googleanalytics" and neither the literal target nor
  // deriveNamespace("ga") could ever find it again. The write path round-trips
  // unknown per-server fields, so the slug survives later add/remove writes.
  const remote = opts.url !== undefined;
  const entry: Partial<UpstreamServerConfig> & { slug: string } = {
    id: `local-${namespace}`,
    name: server.name,
    namespace,
    slug: server.slug,
    // A remote entry carries url + headers and NO command/args: the two shapes
    // are exclusive, and leaving a stray `command: ""` on a remote entry would
    // read to the loader as a stdio server with no executable.
    ...(remote
      ? {
          type: "remote" as const,
          transport: opts.transport ?? ("streamable-http" as const),
          url: opts.url,
          headers: opts.headers,
        }
      : {
          type: "local" as const,
          transport: "stdio" as const,
          command: server.command,
          args: server.args,
          env: Object.keys(entryEnv).length > 0 ? entryEnv : undefined,
        }),
    isActive: true,
    description: server.description,
    // The catalog's published grade, recorded at add time so the
    // YAW_MCP_MIN_COMPLIANCE gate has something to read on a fresh install.
    // Without it the gate was inert for every catalog server: grades.json is
    // written only by `yaw-mcp audit`, which the user has to run per server
    // by hand, so until they did, every server was ungraded and ungraded
    // always passes -- a floor nothing could fall below.
    //
    // It is a CLAIM recorded at a moment in time, not a measurement of the
    // bytes on this machine, and it does not go stale gracefully. A local
    // `audit` supersedes it: hydrateComplianceGrades (server.ts) and runList
    // both overlay grades.json ON TOP of the config value, so the letter the
    // user measured here always wins over the one the catalog published.
    complianceGrade: server.complianceGrade,
  };

  if (opts.dryRun) {
    // The preview must describe the run it previews: the real run can
    // REFUSE (a namespace collision with a different server) or KEEP an
    // existing entry's namespace (a name-matched legacy entry), and both
    // outcomes depend on the file on disk. previewUpsertUserBundle shares
    // the real write path's resolution logic, so the two cannot drift.
    let preview: Awaited<ReturnType<typeof previewUpsertUserBundle>>;
    try {
      preview = await previewUpsertUserBundle(entry, { home });
    } catch (e) {
      // Same unreadable-file failure the real run surfaces.
      printErr(`yaw-mcp add: ${(e as Error).message}`);
      return { exitCode: 1, written: [] };
    }
    // The same read diagnostics the real run prints (see readRawUserBundles):
    // a preview that hid them described a quieter run than the real one.
    for (const w of preview.warnings) printErr(`warning: ${w}`);
    if (preview.refusal) {
      // stderr text under --json too: that is what the REAL refusal (the
      // catch around upsertUserBundle below) emits, and every other error
      // exit in this command. A {ok:false} body on stdout here would be the
      // one place the preview's channel differed from the run it previews.
      // Rendered through displaySafe: the stored half of the collision (name,
      // slug) comes straight out of bundles.json.
      printErr(`yaw-mcp add (dry-run): would refuse: ${formatBundleCollision(preview.refusal, displaySafe)}`);
      return { exitCode: 1, written: [] };
    }
    const previewNamespace = preview.namespace ?? namespace;
    // Render the entry the run would WRITE, never the pre-merge object built
    // above: an update folds onto whatever is already on disk (see
    // mergeServerEntry), so the two differ on exactly the entries a user
    // hand-edited -- a stored env value, a per-server override, and an
    // explicit `"isActive": false` the add does NOT re-enable. Previewing the
    // input described a file the run would never produce.
    const previewEntry = preview.entry;
    const previewPath = localBundlesPath(userConfigDir(home));
    if (preview.launchChanged) {
      printErr(
        `Note: this would CHANGE the entry's launch command:\n${renderLaunchChange(preview.launchChanged)}\nIf the existing entry is a different server you meant to keep, remove/re-add via the app or edit bundles.json instead.`,
      );
    }
    if (opts.json) {
      // Same wrapper shape as the real add below, with dryRun:true, so a
      // script parsing `add --json` sees one consistent shape either way --
      // including the env redaction (see jsonEntry). `path` and `replaced`
      // are part of that shape: the claim used to be made while the dry-run
      // omitted both, so a consumer reading `replaced` to decide "new install
      // vs update" silently saw undefined on every dry run. previewUpsert-
      // UserBundle already computes `replaced` from the same resolution the
      // real write uses, and the target path is the user-global file the write
      // would touch (a dry run never writes it, so naming it costs nothing).
      print(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            namespace: previewNamespace,
            path: previewPath,
            replaced: preview.replaced,
            entry: jsonEntry(previewEntry),
          },
          null,
          2,
        ),
      );
    } else {
      const nsNote =
        previewNamespace === namespace
          ? `as namespace "${previewNamespace}"`
          : `keeping existing namespace "${previewNamespace}"`;
      print(`yaw-mcp add (dry-run): would ${preview.replaced ? "update" : "write"} ${server.name} ${nsNote}`);
      print(`  command: ${previewEntry.command} ${(previewEntry.args ?? []).join(" ")}`);
      if (previewEntry.env) print(`  env keys: ${Object.keys(previewEntry.env).join(", ")}`);
      // Same note the real run prints, in the conditional voice -- an add over
      // a hand-disabled entry keeps it disabled (mergeServerEntry rule 3), so
      // a preview that ended on the usual success line told the user this
      // would make the server loadable when it would not.
      if (previewEntry.isActive === false) {
        print(
          `Note: this entry is "isActive": false in ${previewPath}, so it would stay disabled and NOT load. Set it to true there to enable it.`,
        );
      }
    }
    await printPostWriteNotes(printErr, {
      ambientOnly: ambientOnlyRequiredKeys(server.requiredEnvKeys, previewEntry, env),
      cwd,
      home,
      env,
      dryRun: true,
    });
    return { exitCode: 0, written: [] };
  }

  let res: Awaited<ReturnType<typeof upsertUserBundle>>;
  try {
    res = await upsertUserBundle(entry, { home });
  } catch (e) {
    // The collision refusal quotes the STORED entry's name and slug -- fields
    // out of bundles.json -- so it is re-rendered through displaySafe rather
    // than printed as the Error's verbatim message.
    // Read diagnostics FIRST, exactly as the success path and the dry run
    // print them: the user is about to open bundles.json to resolve the
    // collision, and a malformed entry the loader skipped is what they most
    // need to know about before they do.
    if (e instanceof BundleCollisionError) for (const w of e.warnings) printErr(`warning: ${w}`);
    const msg =
      e instanceof BundleCollisionError ? formatBundleCollision(e.collision, displaySafe) : (e as Error).message;
    printErr(`yaw-mcp add: ${msg}`);
    return { exitCode: 1, written: [] };
  }
  // Read diagnostics first, before the success line they qualify -- an
  // invalid `defaultRuntime` this write just dropped from the file is the
  // usual one (see readRawUserBundles).
  for (const w of res.warnings) printErr(`warning: ${w}`);

  // Report the entry AS WRITTEN, not the one built above: an update folds onto
  // whatever was already on disk (env values, an explicit isActive:false, a
  // per-server runtime override, a name-matched entry's KEPT namespace -- see
  // mergeServerEntry / upsertUserBundle), so the pre-merge object would
  // describe a file that doesn't exist.
  const written = res.entry;
  const finalNamespace = typeof written.namespace === "string" ? written.namespace : namespace;

  // A slug-less stored entry (app-written, pre-0.76 CLI) merges even when
  // the launch command differs -- identity is unknowable without the slug,
  // and refusing would break re-add-to-refresh. The swap must never be
  // SILENT though: name what changed, on stderr so it survives --json.
  if (res.launchChanged) {
    printErr(
      `Note: the entry's launch command changed:\n${renderLaunchChange(res.launchChanged)}\nIf the previous entry was a different server you meant to keep, restore it from the app or edit bundles.json.`,
    );
  }

  if (opts.json) {
    print(
      JSON.stringify(
        { ok: true, namespace: finalNamespace, path: res.path, replaced: res.replaced, entry: jsonEntry(written) },
        null,
        2,
      ),
    );
  } else {
    // Name the namespace the file actually holds -- and say so explicitly
    // when the merge kept an existing one instead of the catalog-derived
    // spelling, so the user is never told a namespace that does not exist.
    const nsNote =
      finalNamespace === namespace ? `namespace "${finalNamespace}"` : `kept existing namespace "${finalNamespace}"`;
    print(`${res.replaced ? "Updated" : "Added"} ${server.name} (${nsNote}) in ${res.path}`);
    // A re-add folds onto a stored `"isActive": false` instead of silently
    // re-enabling it (mergeServerEntry rule 3). That is deliberate, but it
    // makes the usual "restart to pick it up" line WRONG: a disabled entry
    // never loads, so the user restarts, sees nothing, and has no reason to
    // suspect the file. There is no `enable` verb to point at, so name the
    // edit that actually turns it on.
    if (written.isActive === false) {
      print(
        `Note: this entry is "isActive": false in ${res.path}, so it stays disabled and will NOT load. Set it to true there to enable it.`,
      );
    } else {
      print("Restart your MCP client (or yaw-mcp) to pick it up.");
    }
  }

  // Required keys that passed the gate but landed on disk EMPTY (the value
  // came from the ambient shell, not --env), and the project file that would
  // shadow this write -- see printPostWriteNotes. Computed from the WRITTEN
  // entry, never the pre-merge input.
  await printPostWriteNotes(printErr, {
    ambientOnly: ambientOnlyRequiredKeys(server.requiredEnvKeys, written, env),
    cwd,
    home,
    env,
    dryRun: false,
  });
  return { exitCode: 0, written: [res.path] };
}

// --- remove -----------------------------------------------------------------

export const REMOVE_USAGE = `Usage: yaw-mcp remove <slug-or-namespace> [--force]

  Remove a server from your local ~/.yaw-mcp/bundles.json. Accepts either the
  catalog slug it was added with (e.g. "brave-search") or its namespace as
  shown by \`yaw-mcp list\` (e.g. "bravesearch"). No-op if it isn't present.

  Dropping an entry also drops any env value stored on it, so when there IS
  something to remove you are shown the server -- namespace, name, and the
  command or url it launches -- and asked to confirm. A bare Enter is NO.

  --force, -y, --yes  Skip the confirmation. Required when stdin or stdout
                      is not a TTY (there is nothing to ask on).`;

// slug (dashes) or namespace (underscores) shape -- the two forms a user might
// pass to remove.
//
// Deliberately NOT case-insensitive. Both lookups downstream are exact and
// case-sensitive (namespacesForStoredSlug compares `slug === target`,
// removeUserBundle filters on the exact namespace) and both stored forms are
// lowercase by construction (CATALOG_SLUG_RE is lowercase-only; deriveNamespace
// lowercases). An /i here therefore accepted `remove GA`, matched nothing, and
// exited 0 with "nothing to do" -- while `add GA` is rejected at the gate. Same
// input, opposite verdicts. Reject it here so the two verbs agree.
const REMOVE_TARGET_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface RemoveCommandOptions {
  target?: string;
  /** Skip the destructive-action confirmation. Required off a TTY. */
  force?: boolean;
  home?: string;
  cwd?: string;
  /** Environment the command runs under. Only the project-shadow check reads
   *  it (YAW_MCP_TRUST_PROJECT decides whether a project bundles.json is
   *  honoured at all), but it must be threaded rather than defaulted inside
   *  findShadowingProjectBundles: an embedded or test caller that injects an
   *  env expects THAT env to decide, not the real process's. */
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Test hook: override the TTY verdict instead of reading process.std*. */
  isTTY?: boolean;
  /** Test hook: answer the confirmation without a real TTY read. */
  promptAnswer?: string;
  /** Test hook: replaces process.stdin/stdout for the interactive prompt.
   *  `terminal` forces readline's keypress mode (what a real TTY gets), so a
   *  test can deliver Ctrl+C the way a terminal does. */
  io?: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; terminal?: boolean };
}

export function parseRemoveArgs(
  argv: string[],
): { ok: true; options: RemoveCommandOptions } | { ok: false; error: string; help?: boolean } {
  if (argv.length === 0) return { ok: false, error: REMOVE_USAGE };
  const positional: string[] = [];
  const opts: RemoveCommandOptions = {};
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { ok: false, error: REMOVE_USAGE, help: true };
    // --force is the name `secrets remove` uses; -y / --yes is the name `trust`
    // uses. Both siblings gate a destructive write, so both spellings are
    // accepted here rather than making the user remember which verb took which.
    if (a === "--force" || a === "--yes" || a === "-y") {
      opts.force = true;
      continue;
    }
    // Single dash included, not just "--": now that -y is a real flag, a
    // mistyped short flag must be reported as an unknown flag instead of
    // becoming the removal TARGET. (No valid target starts with "-";
    // REMOVE_TARGET_RE requires a leading alphanumeric.)
    if (a.startsWith("-")) return { ok: false, error: `Unknown flag: ${a}\n${REMOVE_USAGE}` };
    positional.push(a);
  }
  if (positional.length !== 1) {
    return { ok: false, error: `Expected exactly one slug or namespace.\n${REMOVE_USAGE}` };
  }
  opts.target = positional[0];
  return { ok: true, options: opts };
}

// --- removal confirmation ---------------------------------------------------
//
// `remove` was the only destructive verb in the CLI with no gate: it deleted
// the entry on a TTY and off it alike. It now follows the idiom its siblings
// already set -- `secrets remove` (confirm on a TTY, refuse off one without
// --force) and `trust` (isTTY + promptAnswer test hooks, bare Enter = NO).
//
// The gate fires ONLY when something is actually going to be deleted. A target
// that isn't in the file, or no file at all, stays the exit-0 "nothing to do"
// no-op it has always been -- refusing to no-op off a TTY would break cleanup
// scripts for no safety gain.

/** Enough of the doomed entry to show the user WHAT they are dropping. A slug
 *  alone would teach them to hit `y` without reading. */
interface RemovalTarget {
  namespace: string;
  name: string;
  /** Rendered launch line ("$ npx -y pkg" / "HTTP https://...") . */
  launch: string;
  /** env KEY names only -- never values; bundles.json env can hold secrets. */
  envKeys: string[];
}

/**
 * The RAW `servers` array of a bundles.json, or null when this read cannot
 * say: no file, an unreadable file, a parse failure, or a root / `servers`
 * field that isn't the expected shape. Every raw lookup in this file goes
 * through here -- three copies of this preamble is how they drifted apart.
 *
 * PARSE WITH THE WRITE PATH'S PARSER. parseJsonc is what readBundlesAt (and so
 * removeUserBundle) uses, and it accepts `//` comments and trailing commas.
 * Gating on the stricter JSON.parse instead meant a bundles.json carrying one
 * hand-added `// prod token lives in 1Password` line looked malformed HERE
 * while the write path parsed and deleted from it happily -- so the removal
 * preview, the off-TTY refusal AND the [y/N] prompt were all skipped on
 * exactly the hand-edited files most likely to hold a stored secret. The two
 * parsers must see the same set of files or the gate does not cover the write.
 *
 * RAW, deliberately NOT through previewBundlesContent: that runs validateEntry,
 * which DROPS malformed entries, while removeUserBundle filters raw entries by
 * namespace string. An entry validateEntry rejects is still one
 * removeUserBundle deletes, so a validated lookup would let it be deleted with
 * no confirmation at all.
 */
async function readRawServers(path: string): Promise<unknown[] | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const servers = (parsed as { servers?: unknown }).servers;
  return Array.isArray(servers) ? servers : null;
}

/**
 * Which candidate namespace is really present in the user-global bundles.json,
 * plus the fields the preview renders. Null when there is nothing to confirm:
 * no match, or a file readRawServers could not read or parse (null `servers`).
 *
 * A null return skips the gate, which is safe because the two shapes behind it
 * end differently in runRemove: a genuine miss stays the exit-0 "nothing to do"
 * no-op it has always been, while an unreadable / malformed file reaches
 * removeUserBundle, whose readRawUserBundles THROWS rather than clobber a file
 * it could not parse -- surfacing the same error `remove` has always printed
 * instead of a bogus "nothing to remove". There is deliberately no
 * found/uncertain distinction in the return value: nothing ever consumed it,
 * and a flag no caller reads documents an invariant nothing enforces.
 */
function findRemovalTarget(candidates: string[], servers: unknown[] | null): RemovalTarget | null {
  if (servers === null) return null;
  for (const ns of candidates) {
    // Same predicate as doRemoveUserBundle's filter (s?.namespace !== ns), so
    // the preview can never disagree with what the write actually deletes.
    const hit = servers.find((s) => (s as { namespace?: unknown } | null)?.namespace === ns) as Record<
      string,
      unknown
    > | null;
    if (!hit) continue;
    const name = typeof hit.name === "string" && hit.name.length > 0 ? hit.name : "(unnamed)";
    const env = typeof hit.env === "object" && hit.env !== null ? (hit.env as Record<string, unknown>) : {};
    return { namespace: ns, name, launch: renderLaunch(hit), envKeys: Object.keys(env) };
  }
  return null;
}

/**
 * Namespaces recorded for a catalog slug at add time. `add` persists the
 * resolved slug on the entry (see runAdd) precisely because the namespace
 * derives from the catalog display NAME, not the slug -- "ga" ("Google
 * Analytics") lands as namespace "googleanalytics", so neither the literal
 * target nor deriveNamespace(target) can reach it. Reads the same raw servers
 * array the removal preview does (readRawServers); an absent, unreadable, or
 * malformed file yields [] and leaves the existing miss / parse-error paths to
 * report themselves. Entries written before the slug was recorded simply never
 * match here (their namespace, as shown by `yaw-mcp list`, still works as the
 * removal target).
 */
function namespacesForStoredSlug(target: string, servers: unknown[] | null): string[] {
  if (servers === null) return [];
  const out: string[] = [];
  for (const s of servers) {
    const e = s as { slug?: unknown; namespace?: unknown } | null;
    if (e?.slug === target && typeof e?.namespace === "string") out.push(e.namespace);
  }
  return out;
}

/** How the entry would be launched, as one reviewable line. Mirrors
 *  trust-cmd's renderLaunch, but reads an UNVALIDATED raw entry (see
 *  findRemovalTarget) so every field is type-checked before use. The
 *  parameter is typed loosely so a raw bundles.json record and a LaunchShape
 *  (see renderLaunchChange) both fit; the checks below are the contract. */
function renderLaunch(entry: { command?: unknown; args?: unknown; url?: unknown }): string {
  const command = typeof entry.command === "string" ? entry.command : "";
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
  const parts = [command, ...args].filter((p) => p.length > 0);
  // Args containing whitespace or quotes are quoted, so `sh -c "curl ... | sh"`
  // reads as the single argument it really is instead of blending into the line.
  if (parts.length > 0) return `$ ${parts.map(displayArg).join(" ")}`;
  const url = typeof entry.url === "string" ? entry.url : "";
  return url.length > 0 ? `HTTP ${displaySafe(url)}` : "(no command)";
}

/** Render the doomed entry. Shared by the TTY prompt and the off-TTY refusal:
 *  a scripted run gets to see what it WOULD have removed before being told
 *  which flag to re-run with (same courtesy as `yaw-mcp trust`). */
function printRemovalPreview(print: (s?: string) => void, path: string, t: RemovalTarget): void {
  print("");
  print(`  Remove from ${displaySafe(path)}:`);
  print("");
  print(`    namespace: ${t.namespace}`);
  print(`    name:      ${displaySafe(t.name)}`);
  print(`    launch:    ${t.launch}`);
  if (t.envKeys.length > 0) print(`    env keys:  ${t.envKeys.map(displayArg).join(", ")}`);
  print("");
  print("  yaw-mcp will stop loading it. Any env value stored on the entry goes");
  print("  with it -- re-adding the server will not bring those values back.");
  print("");
}

/** Both ends must be a TTY: stdin to read the answer, stdout to show the
 *  question. Mirrors trust-cmd.ts:isInteractive. */
function isInteractive(opts: RemoveCommandOptions): boolean {
  if (opts.isTTY !== undefined) return opts.isTTY;
  if (opts.promptAnswer !== undefined) return true;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Ask the confirmation. Defaults to NO -- only an explicit y/yes proceeds, so
 *  a bare Enter, a stray keystroke, or EOF (^D, a piped stdin running dry)
 *  leaves bundles.json untouched. EOF is questionOrEmpty's job: a bare
 *  rl.question() never settles once its input closes, which left this promise
 *  pending forever -- no "Aborted", no exit 1, the process ending by
 *  event-loop drain at status 0 with a wrapper reading the decline as
 *  success. */
async function askYesNo(opts: RemoveCommandOptions, question: string): Promise<string | QuestionCancelled> {
  if (opts.promptAnswer !== undefined) return opts.promptAnswer.trim().toLowerCase();
  const input = opts.io?.stdin ?? process.stdin;
  const output = opts.io?.stdout ?? process.stdout;
  // `terminal` is readline's own default (output.isTTY) unless a test forces
  // it; on a real TTY that is what makes readline own the Ctrl+C keypress.
  const rl = createInterface({ input, output, terminal: opts.io?.terminal });
  try {
    const raw = await questionOrEmpty(rl, question);
    // Ctrl+C is not "no": it is the user leaving, and the exit code says so.
    return raw === QUESTION_CANCELLED ? raw : raw.trim().toLowerCase();
  } finally {
    rl.close();
  }
}

export async function runRemove(opts: RemoveCommandOptions): Promise<AddCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  if (!opts.target) {
    printErr(REMOVE_USAGE);
    return { exitCode: 2, written: [] };
  }
  if (!REMOVE_TARGET_RE.test(opts.target)) {
    printErr(
      `yaw-mcp remove: "${opts.target}" isn't a valid slug or namespace (lowercase letters, digits, dashes and underscores only).`,
    );
    return { exitCode: 2, written: [] };
  }
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  // Try the literal target first -- covers a namespace copied from `list`
  // (including legacy underscore namespaces from older `add` versions). Then
  // any namespace whose entry RECORDS this slug (add persists it; "ga" ->
  // "googleanalytics" is unreachable any other way). Then the derived form so
  // passing the catalog SLUG also works for the common case where slug and
  // name agree ("brave-search" -> "bravesearch"). deriveNamespace strips
  // non-alphanumerics, so it would mangle an underscore namespace; that's why
  // the literal goes first.
  //
  // ONE read for both raw lookups (the slug map and the removal preview).
  // They used to read and parse the same file independently, before
  // removeUserBundle read it a third time -- and two reads of one file are two
  // chances to disagree about its contents. A concurrent edit can still land
  // between this read and the write, which is why the write path re-reads and
  // re-matches; this snapshot only decides what to SHOW and which namespaces
  // to try.
  const path = localBundlesPath(userConfigDir(home));
  const rawServers = await readRawServers(path);
  const bySlug = namespacesForStoredSlug(opts.target, rawServers);
  const candidates = [...new Set([opts.target, ...bySlug, deriveNamespace(opts.target)])];

  // ----- destructive-action confirmation --------------------------------
  // Gated on there being something to delete (see findRemovalTarget): a miss
  // or an unreadable/malformed file skips straight to the loop below, which
  // keeps the exit-0 no-op and the existing parse-error message intact.
  //
  // The preview is not re-checked after the answer the way `trust` re-hashes
  // the file it is approving. That check exists there because approval grants
  // EXECUTION authority to content a repo controls; here the file is the
  // user's own, the write below re-reads it anyway, and the worst case of a
  // concurrent edit is an entry `yaw-mcp add` puts straight back.
  if (!opts.force) {
    const doomed = findRemovalTarget(candidates, rawServers);
    if (doomed) {
      printRemovalPreview(print, path, doomed);
      if (!isInteractive(opts)) {
        // Exit 2, matching `secrets remove`'s off-TTY refusal: a required flag
        // is missing, which is this CLI's usage-error code. (A DECLINED prompt
        // is exit 1 below -- the argv was fine, the user said no.)
        printErr(
          `yaw-mcp remove: refusing to remove "${doomed.namespace}" without a confirmation -- stdin/stdout is not a TTY.`,
        );
        printErr("  Re-run with --force (or -y) to remove it.");
        return { exitCode: 2, written: [] };
      }
      const answer = await askYesNo(opts, `  Remove "${doomed.namespace}"? [y/N] `);
      if (answer === QUESTION_CANCELLED) {
        // Ctrl+C at the prompt: exit 130, like every other prompt in the
        // product, rather than the decline's exit 1.
        printErr("yaw-mcp remove: Cancelled. Nothing was removed.");
        return { exitCode: 130, written: [] };
      }
      if (answer !== "y" && answer !== "yes") {
        printErr("yaw-mcp remove: Aborted. Nothing was removed.");
        return { exitCode: 1, written: [] };
      }
    }
  }

  let res: Awaited<ReturnType<typeof removeUserBundle>> | null = null;
  let matched = "";
  // One file, several candidate namespaces: every attempt re-reads it and
  // reports the same diagnostics, so they are deduped before printing.
  const warnings = new Set<string>();
  try {
    for (const ns of candidates) {
      res = await removeUserBundle(ns, { home });
      for (const w of res.warnings) warnings.add(w);
      if (res.removed) {
        matched = ns;
        break;
      }
    }
  } catch (e) {
    printErr(`yaw-mcp remove: ${(e as Error).message}`);
    return { exitCode: 1, written: [] };
  }
  for (const w of warnings) printErr(`warning: ${w}`);

  if (!res?.removed) {
    // No-op exits 0 (like try-cleanup): "make it absent" succeeded. The file is
    // named from `path` above rather than off `res`: `candidates` is never
    // empty, so the loop always ran and `res` is only nullable to the type
    // checker -- and removeUserBundle derives the very same path from `home`,
    // so a `res?.path ?? "bundles.json"` fallback could never fire and only
    // documented an outcome that does not exist.
    print(`yaw-mcp remove: no server matching "${opts.target}" in ${path} (nothing to do).`);
    // `list` reads the project-local bundles.json when present (it overrides
    // user-global), but `remove` only manages user-global -- so a server the
    // user just saw in `list` can be "not found" here. Explain when that's why.
    const shadow = await findShadowingProjectBundles(cwd, home, env).catch(() => null);
    if (shadow) {
      printErr(
        `Note: a project-local ${shadow} is in effect; \`remove\` only manages your user-global bundles.json, so a server defined there must be removed from that file directly.`,
      );
    }
    return { exitCode: 0, written: [] };
  }
  print(`Removed "${matched}" from ${res.path}. Restart your MCP client to apply.`);

  // Honest warning: a project-local bundles.json shadows the user-global file,
  // so the server may keep loading from there even after this removal.
  const shadow = await findShadowingProjectBundles(cwd, home, env).catch(() => null);
  if (shadow) {
    printErr(
      `Note: ${shadow} shadows your user-global bundles.json; a server defined there is unaffected by this removal.`,
    );
  }
  return { exitCode: 0, written: [res.path] };
}

// --- list -------------------------------------------------------------------

export const LIST_USAGE = `Usage: yaw-mcp list [--json]

  List the MCP servers yaw-mcp loads locally from bundles.json (the
  project-local file wins over user-global), with the compliance grade
  \`yaw-mcp audit\` last cached for each. --json for machine output.
  Env vars appear as \`envKeys\` -- key NAMES only, never the stored
  values (same posture as \`add --json\`).`;

export interface ListCommandOptions {
  json?: boolean;
  home?: string;
  cwd?: string;
  /** Environment the command runs under. Only the project-trust gate inside
   *  loadLocalBundles reads it (YAW_MCP_TRUST_PROJECT decides whether a project
   *  bundles.json is honoured at all), but it must be threaded rather than left
   *  to default inside the loader: `add` and `remove` deliberately inject theirs,
   *  and an embedded or test caller that supplies an env expects THAT env to
   *  decide which file `list` reads, not the real process's. */
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Test hook: supply a grade cache instead of reading ~/.yaw-mcp/grades.json. */
  gradesReader?: (home?: string) => Promise<GradesCache>;
}

/**
 * Env KEY names per namespace, read from the RAW winning bundles.json -- keys
 * only, never values. `list --json` cannot derive envKeys from the
 * loader-validated entries: validateEntry DROPS blank env values ("" is the
 * "required key, nothing stored" seed `add` writes -- see the blank-drop note
 * in local-bundles.ts), which is right for the spawn env but silently erased
 * exactly the required-key documentation `add --json` reports. Reading the raw
 * entry is the same posture printRemovalPreview already takes, and for the
 * same reason: describe what is ON DISK, not what the loader would spawn with.
 *
 * Best-effort: an unreadable or unparseable file yields an empty map and the
 * caller keeps the validated-entry derivation as its fallback.
 *
 * One QUEUE of key lists per namespace, in file order, because a namespace
 * can be duplicated and each entry must report its OWN keys. The pairing is
 * exact: validateEntry rejects only non-object entries and invalid
 * namespaces, and a namespace either passes NAMESPACE_RE for every entry
 * that carries it or for none, so the n-th validated entry under a namespace
 * is the n-th raw object entry under it. The caller shifts the queue as it
 * walks the validated list in order. (First-entry-wins used to copy the first
 * duplicate's keys onto the second, misreporting the second's.)
 */
async function rawEnvKeysByNamespace(path: string | null): Promise<Map<string, string[][]>> {
  const out = new Map<string, string[][]>();
  if (!path) return out;
  // Note the path is whichever file the LOADER won with (project-local can
  // beat user-global), unlike the removal lookups which are user-global only.
  const servers = await readRawServers(path);
  if (servers === null) return out;
  for (const s of servers) {
    const e = s as { namespace?: unknown; env?: unknown } | null;
    if (!e || typeof e.namespace !== "string") continue;
    const env = e.env && typeof e.env === "object" && !Array.isArray(e.env) ? (e.env as Record<string, unknown>) : {};
    const queue = out.get(e.namespace) ?? [];
    queue.push(Object.keys(env));
    out.set(e.namespace, queue);
  }
  return out;
}

export function parseListArgs(
  argv: string[],
): { ok: true; options: ListCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: ListCommandOptions = {};
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { ok: false, error: LIST_USAGE, help: true };
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    return { ok: false, error: `Unknown argument: ${a}\n${LIST_USAGE}` };
  }
  return { ok: true, options: opts };
}

export async function runList(opts: ListCommandOptions): Promise<AddCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const loaded = await loadLocalBundles({ home, cwd, env: opts.env ?? process.env });
  const servers = loaded.config?.servers ?? [];

  // Always surface load warnings so malformed-file problems aren't silently
  // swallowed. They go to stderr in BOTH modes, before the listing / empty
  // state, so a script can still parse stdout cleanly while a human sees the
  // diagnostic; --json ALSO embeds them in the response body, for a consumer
  // that captured stdout alone.
  for (const w of loaded.warnings) printErr(`warning: ${w}`);

  // Overlay the compliance grades `yaw-mcp audit` cached in ~/.yaw-mcp/
  // grades.json. This is the ONLY reader of that cache in local mode -- without
  // it, `audit` would be write-only and the grade would never reach a human.
  // A bundles.json entry can also carry a grade now (`yaw-mcp add` records the
  // catalog's published one), so the map below is a genuine precedence
  // decision rather than a fill-in: a cache hit REPLACES the config value,
  // because that letter was measured against the bytes on this machine while
  // the config one is what the catalog claimed at add time. A miss leaves
  // `s.complianceGrade` standing rather than blanking it. Applied to BOTH
  // --json and the table so the two surfaces agree. readGradesCache never
  // throws -- a missing or garbled cache just means no overlay.
  const gradesReader = opts.gradesReader ?? readGradesCache;
  const grades = await gradesReader(home).catch(() => ({}) as GradesCache);
  const graded: UpstreamServerConfig[] = servers.map((s) => {
    const cached = grades[s.namespace];
    return cached ? { ...s, complianceGrade: cached.grade } : s;
  });

  if (opts.json) {
    // Same env redaction as `add --json` (jsonEntry): a bundles.json entry can
    // carry a `--env` secret, and `list --json` gets piped into CI logs and
    // bug reports -- so servers are reported with `envKeys` (key NAMES only),
    // never the stored values. The keys come from the RAW on-disk entry (see
    // rawEnvKeysByNamespace): the validated entry has already had `add`'s ""
    // required-key seeds dropped, so deriving from it hid those keys from the
    // one machine surface that documents them. `complianceGradedAt` and (when
    // the cache entry carries it) `complianceSuiteVersion` ride along with the
    // grade, so a consumer can tell a letter graded under an older rubric from
    // a current one; entries audited before suiteVersion existed surface
    // timestamp only.
    const rawEnvKeys = await rawEnvKeysByNamespace(loaded.path);
    const jsonServers = graded.map((s) => {
      const entry = jsonEntry(s);
      // `graded` is the validated list in file order, so shifting pairs each
      // entry with its own raw keys even when the namespace is duplicated.
      const keys = rawEnvKeys.get(s.namespace)?.shift();
      if (keys !== undefined && keys.length > 0) entry.envKeys = keys;
      const cached = grades[s.namespace];
      if (cached) {
        entry.complianceGradedAt = cached.gradedAt;
        if (cached.suiteVersion) entry.complianceSuiteVersion = cached.suiteVersion;
      }
      return entry;
    });
    print(JSON.stringify({ path: loaded.path, servers: jsonServers, warnings: loaded.warnings }, null, 2));
    return { exitCode: 0, written: [] };
  }

  if (servers.length === 0) {
    print("No local servers configured. Add one with `yaw-mcp add <slug>`");
    print("(browse the catalog at https://yaw.sh/mcp/catalog/).");
    return { exitCode: 0, written: [] };
  }

  const rows = [...graded].sort((a, b) => a.namespace.localeCompare(b.namespace));
  // NAME and LAUNCH come STRAIGHT out of bundles.json, which is a file a repo
  // can ship (project-local) or a badge can write -- so they get the same
  // control-byte neutering the removal preview and the trust gate already
  // apply. Without it, an entry whose name carries ANSI or a bidi override
  // repainted this table in the user's terminal, and a `sh -c "a | b"` arg
  // joined by a bare space read as separate tokens. NAMESPACE is skipped on
  // purpose: NAMESPACE_RE (local-bundles.ts) already restricts it to
  // [a-z0-9_], and GRADE is a validated A-F letter from grades.json.
  const cols: Array<[string, (s: UpstreamServerConfig) => string]> = [
    ["NAMESPACE", (s) => s.namespace],
    ["NAME", (s) => displaySafe(s.name)],
    ["STATUS", (s) => (s.isActive ? "active" : "disabled")],
    // "-" for never-audited, matching the GRADE column this ported from.
    // LAUNCH stays last: it's the only variable-width cell, so anything after
    // it would be ragged.
    ["GRADE", (s) => s.complianceGrade ?? "-"],
    [
      "LAUNCH",
      (s) =>
        [s.command, ...(s.args ?? [])]
          .filter((t): t is string => typeof t === "string" && t.length > 0)
          .map((t) => displayArg(t))
          .join(" ") || (s.url ? displaySafe(s.url) : ""),
    ],
  ];
  const widths = cols.map(([h, get]) => Math.max(h.length, ...rows.map((r) => get(r).length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  print(fmt(cols.map(([h]) => h)));
  for (const r of rows) print(fmt(cols.map(([, get]) => get(r))));
  if (loaded.path) print(`\n${servers.length} server${servers.length === 1 ? "" : "s"} in ${loaded.path}`);
  return { exitCode: 0, written: [] };
}
