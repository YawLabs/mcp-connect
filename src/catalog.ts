// Shared catalog resolver. Resolves a catalog slug to a concrete launch
// shape (command + args + required env keys) from the SAME static catalog
// the yaw.sh website and the Yaw Terminal app read:
//
//     https://yaw.sh/data/mcp-catalog.json
//
// Why one source: the website catalog page emits "Add to Yaw MCP" buttons
// carrying a `slug`, and both the Yaw Terminal app (yaw-install-handler.ts
// resolveSlug) and this CLI must accept the EXACT same slug set, or a button
// that works in the app silently fails in the CLI fallback. Keeping all three
// pointed at one static file is what guarantees slug parity.
//
// Both `yaw-mcp add <slug>` and `yaw-mcp try <slug>` resolve through here, so
// a catalog shape change is fixed in one place.

const DEFAULT_CATALOG_URL = "https://yaw.sh/data/mcp-catalog.json";
/** Exported so the timeout test advances its fake clock by THIS value rather
 *  than a literal that silently desyncs the day the constant moves. */
export const FETCH_TIMEOUT_MS = 10_000;
/** The slug shape `add` and `try` gate on BEFORE touching the catalog:
 *  lowercase letters, digits and dashes, leading alphanumeric, 64 chars at
 *  most. One exported definition, because each verb used to carry a private
 *  copy and the two could only stay identical by accident; the catalog is
 *  the thing a slug names, so its resolver owns the shape. */
export const CATALOG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A single required-env descriptor as the catalog stores it. */
export interface CatalogRequiredEnv {
  key: string;
  label?: string;
  placeholder?: string;
  docsUrl?: string;
}

/** A raw catalog server entry (only the fields this resolver reads). */
export interface CatalogServer {
  slug: string;
  name?: string;
  description?: string;
  install?: { command?: string; runtime?: string; url?: string; type?: string };
  requiredEnv?: CatalogRequiredEnv[];
  repo?: string;
  homepage?: string;
  /** Published A-F grade from the Yaw MCP compliance suite. Typed as a bare
   *  string because this is remote data: normalizeCatalogGrade decides what
   *  is acceptable, rather than a cast asserting the wire was well-formed. */
  complianceGrade?: string;
}

/** The resolved launch shape `add`/`try` consume. command + args are split
 *  from the catalog's single `install.command` launch line via tokenizeCommand. */
export interface ResolvedCatalogServer {
  slug: string;
  name: string;
  command: string;
  args: string[];
  /** Names (not values) of env vars the server needs. */
  requiredEnvKeys: string[];
  description?: string;
  source?: string;
  docUrl?: string;
  /** The catalog's published grade, A-F, or undefined when the catalog has
   *  none or the value did not survive normalizeCatalogGrade. `add` writes it
   *  into bundles.json so YAW_MCP_MIN_COMPLIANCE has something to gate on
   *  before the user has run `yaw-mcp audit` on the server themselves. */
  complianceGrade?: "A" | "B" | "C" | "D" | "F";
}

export type FetchCatalog = (url: string) => Promise<CatalogServer[]>;

/**
 * Quote-aware split of a catalog `install.command` launch line into
 * command + argv. The catalog stores the whole line as one string
 * (e.g. `npx -y @yawlabs/aws-mcp`, or `docker run -i --rm -e FOO ghcr.io/...`),
 * but a bundles.json entry needs command and args separate. Mirror of the
 * app's tokenizeCommand (yaw-install-handler.ts) and the website's
 * (catalog/index.html), so all three produce identical splits for every
 * BALANCED line -- which is every line a healthy catalog carries.
 *
 * ONE deliberate divergence: the unbalanced-quote throw below. Neither the
 * app's copy nor the website's has it -- there an unterminated quote simply
 * runs to end-of-line and the mangled token is kept -- so a quote-broken
 * install line is silently accepted by the app and hard-fails here. That is
 * an app-works/CLI-fails split of the kind the module header says this file
 * exists to prevent, and it is accepted anyway: writing the mangled argv into
 * bundles.json only moves the failure to spawn time, where it reads as a
 * missing binary rather than as a bad catalog entry. A line that trips this
 * is a CATALOG bug -- fix the install line rather than matching the app by
 * dropping the check.
 */
export function tokenizeCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      has = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote !== null) {
    throw new Error(`Unbalanced quote in command: ${cmd}`);
  }
  if (has) out.push(cur);
  return out;
}

/** Age past which the catalog's own `generated_at` stamp earns a staleness
 *  note. The catalog is a static file regenerated by the yaw.sh site build,
 *  so a gap of weeks is normal cadence -- but a quarter-old snapshot handing
 *  out install lines deserves a heads-up: package names, launch commands and
 *  required env drift on that timescale. Advisory only; a stale catalog
 *  still resolves. */
export const CATALOG_STALE_AFTER_DAYS = 90;

/** Surface the catalog's `generated_at` stamp when it is old enough to
 *  matter. The parser used to read only `body.servers` and drop the one
 *  field that distinguishes a frozen catalog from a fresh one -- `add` and
 *  `try` would keep handing out an old snapshot's install lines forever with
 *  nothing anywhere able to say the source went stale. A missing, non-string
 *  or unparsable stamp stays silent (the field is optional), as does a
 *  future-dated one (clock skew is not staleness). Warns on stderr so the
 *  note never contaminates machine-read stdout, and never throws. */
function warnIfCatalogStale(body: unknown, opts: CatalogFetchDeps): void {
  const stamp = (body as { generated_at?: unknown } | null)?.generated_at;
  if (typeof stamp !== "string") return;
  const generated = Date.parse(stamp);
  if (Number.isNaN(generated)) return;
  const ageDays = Math.floor(((opts.now?.() ?? Date.now()) - generated) / 86_400_000);
  if (ageDays < CATALOG_STALE_AFTER_DAYS) return;
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  warn(
    `yaw-mcp: note: the Yaw MCP catalog was generated ${stamp.slice(0, 10)} (${ageDays} days ago); its entries may be out of date.`,
  );
}

/** Test seams for defaultFetchCatalog's staleness note. Optional second
 *  parameter so the function stays assignable to FetchCatalog. */
export interface CatalogFetchDeps {
  /** Sink for the staleness note. Defaults to process.stderr. */
  warn?: (line: string) => void;
  /** Clock for the age computation. Defaults to Date.now. */
  now?: () => number;
}

/**
 * An EMPTY catalog URL means "not configured", not "fetch the empty string".
 * `YAW_MCP_CATALOG_URL=""` -- a CI variable declared with no value, an
 * `export YAW_MCP_CATALOG_URL=` line, a blank .env entry -- is not nullish, so
 * every `??` fallback upstream of here (add, try) handed "" straight through.
 * fetch("") then throws a bare `TypeError: Failed to parse URL from`, AND the
 * message-based rethrow gate defaultFetchCatalog used to carry
 * (`err.message.includes(url)`) was trivially TRUE for the empty string, so
 * the raw TypeError came back without even the friendly "could not reach the
 * Yaw MCP catalog" wrapper. That gate is a marker CLASS now (CatalogError), so
 * the wrapper holds even for a URL fetch itself refuses to parse -- but the
 * normalization still belongs here: "" is not a URL to attempt at all.
 *
 * Normalizing at this boundary (rather than at each call site) is what makes
 * the rule hold for every caller, including ones outside this repo's CLI.
 * Whitespace-only is treated the same way: it can never be a URL.
 */
function normalizeCatalogUrl(url: string | undefined): string {
  return url !== undefined && url.trim() !== "" ? url : DEFAULT_CATALOG_URL;
}

/** Marks an error defaultFetchCatalog worded ITSELF -- every one of them
 *  already names the catalog and the URL, so the transport wrapper must
 *  rethrow them untouched rather than describing them a second time.
 *
 *  A marker class, not a message test. The old gate asked whether the message
 *  contained the url, which is also true of fetch's OWN URL-parse failure
 *  (`TypeError: Failed to parse URL from <url>`) -- so a malformed
 *  YAW_MCP_CATALOG_URL was rethrown raw, skipping the friendly wrapper and the
 *  `cause` detail this module promises for EVERY failure mode. The class
 *  cannot false-positive that way: only throws written here carry it. */
class CatalogError extends Error {}

/** Fetch + shape-validate the catalog. Bounded by FETCH_TIMEOUT_MS. Throws a
 *  friendly Error on network / parse / shape failure. Injectable for tests. */
export async function defaultFetchCatalog(
  catalogUrl: string = DEFAULT_CATALOG_URL,
  deps: CatalogFetchDeps = {},
): Promise<CatalogServer[]> {
  // Every message below names `url`, so normalize before the first use -- an
  // empty string would otherwise produce "the catalog at  returned HTTP 404".
  const url = normalizeCatalogUrl(catalogUrl);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let body: unknown;
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new CatalogError(`the Yaw MCP catalog at ${url} returned HTTP ${res.status}.`);
    }
    // A 200 whose body isn't JSON is the captive-portal / corporate-proxy
    // shape: the request "succeeded" and returned an HTML login page. Left
    // unwrapped, the raw SyntaxError reaches the user as `yaw-mcp add:
    // Unexpected token '<', "<!DOCTYPE "... is not valid JSON` -- naming
    // neither the catalog nor the URL that produced it. Wrap it here so every
    // failure mode of this function carries the same "catalog at <url>" prefix
    // its docstring promises. An abort that lands while the BODY is streaming
    // also rejects here; rethrow that untouched so the outer catch keeps
    // reporting it as the timeout it is.
    try {
      body = await res.json();
    } catch (parseErr) {
      if (parseErr instanceof Error && parseErr.name === "AbortError") throw parseErr;
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      throw new CatalogError(`the Yaw MCP catalog at ${url} did not return valid JSON (${msg}).`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new CatalogError(`timed out fetching the Yaw MCP catalog at ${url}.`);
    }
    // Anything thrown ABOVE already carries the "catalog at <url>" prefix, so
    // rethrow those untouched -- the marker CLASS is what tells them apart. A
    // message test (`err.message.includes(url)`) also matched fetch's own
    // `Failed to parse URL from <url>`, which is precisely a failure that
    // needs the wrapper below rather than a raw rethrow.
    if (err instanceof CatalogError) throw err;
    // Everything else is a TRANSPORT failure raised by fetch itself: offline,
    // DNS, connection refused, TLS, a proxy that drops the connection. undici
    // reports every one of them as a bare `TypeError: fetch failed`, which
    // names neither the catalog nor the URL -- so `yaw-mcp add <slug>` on a
    // laptop with no network printed exactly "yaw-mcp add: fetch failed".
    // That is the most common failure this function has, and it was the one
    // mode the wrapping above did not cover. The real reason lives on
    // `cause` (ECONNREFUSED, ENOTFOUND, ...); surface it.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null;
    const detail = cause ?? (err instanceof Error ? err.message : String(err));
    throw new CatalogError(
      `could not reach the Yaw MCP catalog at ${url} (${detail}). Check your network, then retry.`,
    );
  } finally {
    clearTimeout(timer);
  }
  const servers = (body as { servers?: unknown } | null)?.servers;
  if (!Array.isArray(servers)) {
    throw new CatalogError(`the Yaw MCP catalog at ${url} was not in the expected shape.`);
  }
  warnIfCatalogStale(body, deps);
  return servers.filter(
    (s): s is CatalogServer => typeof s === "object" && s !== null && typeof (s as CatalogServer).slug === "string",
  );
}

/**
 * Resolve a catalog slug to a concrete launch shape. Refuses remote/HTTP
 * servers (they have no stdio spawn command) the same way the app's
 * resolveSlug does. Throws a friendly Error on miss / remote / empty command.
 */
export async function resolveCatalogSlug(
  slug: string,
  opts: { catalogUrl?: string; fetchCatalog?: FetchCatalog } = {},
): Promise<ResolvedCatalogServer> {
  // normalizeCatalogUrl, not `??`: an override that is set-but-empty (the
  // YAW_MCP_CATALOG_URL="" shape the CLI reads into this option) must fall
  // back to the default instead of being fetched.
  const url = normalizeCatalogUrl(opts.catalogUrl);
  const fetchCatalog = opts.fetchCatalog ?? defaultFetchCatalog;
  const servers = await fetchCatalog(url);
  const entry = servers.find((s) => s.slug === slug);
  if (!entry) {
    throw new Error(
      `no server with slug "${slug}" in the Yaw MCP catalog. Browse https://yaw.sh/mcp/catalog/ for the list.`,
    );
  }

  const install = entry.install ?? {};
  const runtime = typeof install.runtime === "string" ? install.runtime.toLowerCase() : "";
  // A remote/HTTP server has no stdio spawn command; refuse rather than
  // tokenize a URL into a broken entry. Matches the app's resolveSlug.
  if (install.url || install.type === "remote" || /^(remote|https?|sse|url)$/.test(runtime)) {
    throw new Error(
      `"${slug}" is a remote (HTTP) server, which has no stdio command to spawn. Add it by hand to ~/.yaw-mcp/bundles.json with "type": "remote" and its "url".`,
    );
  }
  const cmdStr = typeof install.command === "string" ? install.command.trim() : "";
  if (!cmdStr) {
    throw new Error(`catalog entry "${slug}" has no install command.`);
  }
  const tokens = tokenizeCommand(cmdStr);
  const [command, ...args] = tokens;
  // Guard the COMMAND token, not the token count. `tokens.length === 0` cannot
  // happen here -- cmdStr is already non-blank, and every non-blank line yields
  // at least one token -- while the degenerate case that CAN happen slipped
  // through it: a quoted-empty launch line (`"" -y foo`, or a bare `""`)
  // tokenizes to a first token of "", which was written into bundles.json as a
  // server with no command at all and then failed opaquely at spawn time.
  if (!command) {
    throw new Error(`catalog entry "${slug}" install command was empty.`);
  }

  const requiredEnvKeys = Array.isArray(entry.requiredEnv)
    ? entry.requiredEnv
        .map((e) => (e && typeof e === "object" ? e.key : undefined))
        .filter((k): k is string => typeof k === "string" && ENV_KEY_RE.test(k))
    : [];

  const source =
    typeof entry.repo === "string" ? entry.repo : typeof entry.homepage === "string" ? entry.homepage : undefined;
  return {
    slug,
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : slug,
    command,
    args,
    requiredEnvKeys,
    description: typeof entry.description === "string" ? entry.description : undefined,
    source,
    docUrl: source,
    complianceGrade: normalizeCatalogGrade(entry.complianceGrade),
  };
}

/** Accept a catalog grade only when it is exactly one of the A-F letters.
 *
 *  Deliberately STRICTER than compliance.ts's classifyGrade, which keeps an
 *  unrecognized letter as a distinct "unrecognized" signal rather than
 *  collapsing it to ungraded. That signal is worth having for a value in the
 *  user's OWN bundles.json, where a garbled grade plausibly means tampering
 *  or a bad hand-edit and the user should be told. It is not worth having
 *  here: this value arrives over the network and is about to be written into
 *  that same file, so anything unexpected is catalog corruption, and copying
 *  it in would manufacture the very tamper signal the other path exists to
 *  report. Unknown becomes ungraded, and ungraded passes. */
function normalizeCatalogGrade(raw: unknown): "A" | "B" | "C" | "D" | "F" | undefined {
  if (typeof raw !== "string") return undefined;
  const up = raw.trim().toUpperCase();
  return up === "A" || up === "B" || up === "C" || up === "D" || up === "F" ? up : undefined;
}

export { DEFAULT_CATALOG_URL };
