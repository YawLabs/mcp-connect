// `yaw-mcp foundry export` -- fold the opt-in harvest (~/.yaw-mcp/foundry.jsonl,
// written when YAW_MCP_FOUNDRY is on) into a checked-in routing-regression
// corpus that the foundry-routing.test.ts gate consumes.
//
// This is a MAINTAINER command: it snapshots the local server catalog (from
// bundles.json) so the corpus is self-contained and the BM25 floor can be
// replayed in CI without a live config. See foundry-corpus.ts for what the
// gate measures (a BM25-floor regression check on real intents, NOT a
// correctness oracle).
//
// Exit codes. These follow the CLI-wide convention stated in index.ts: 2 is
// reserved for an argv/usage error (emitted by the shared parse-then-dispatch
// tail, never by the runner below), 1 is any runtime failure.
//   0  corpus written
//   1  nothing to export -- no harvest file, no parseable traces, or no usable
//      entries after folding (every trace's `chosen` is unknown to the local
//      server catalog, or all tokens were empty)
//   2  bad argv (from parseFoundryArgs, via index.ts)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { FOUNDRY_FILENAME } from "./foundry.js";
import {
  buildCorpusFromTraces,
  DEFAULT_CORPUS_CAP,
  FOUNDRY_TOP3_FLOOR,
  parseTraceLines,
  scoreCorpus,
  traceDropReason,
} from "./foundry-corpus.js";
import { loadLocalBundles } from "./local-bundles.js";
import { userConfigDir } from "./paths.js";
import { loadState, statePath } from "./persistence.js";
import type { RankableServer } from "./relevance.js";

/** Default corpus destination. Exported because three files independently
 *  depend on this exact path -- the parser's default, the usage text, and the
 *  routing gate that loads the fixture -- so a change here has to move all of
 *  them together instead of silently un-gating routing. */
export const DEFAULT_OUT = path.join("src", "tests", "fixtures", "foundry-corpus.json");

export interface ParsedFoundryArgs {
  action: "export";
  out: string;
  cap: number;
  json: boolean;
}

export const FOUNDRY_USAGE = `Usage: yaw-mcp foundry export [--out <path>] [--cap <n>] [--json]

  Fold the opt-in dispatch harvest (~/.yaw-mcp/foundry.jsonl) into a routing
  regression corpus consumed by the foundry-routing test gate. Maintainer
  command: requires a local bundles.json for the server-catalog snapshot.

  --out <path>   Where to write the corpus (default: ${DEFAULT_OUT}).
  --cap <n>      Max entries, stratified by chosen server (default: ${DEFAULT_CORPUS_CAP}).
  --json         Emit a machine-readable summary instead of text.`;

// `help: true` is the ONLY signal that `error` carries the usage text rather
// than a real argv complaint, and index.ts's shared run() tail branches on
// exactly that flag (stdout, exit 0) as it does for every sibling parser. It
// used to re-derive help by comparing `error === FOUNDRY_USAGE` -- and kept
// doing so after this flag existed, spreading its verdict OVER the flag -- so
// `foundry --help` became a usage ERROR (stderr, exit 2) the moment any site
// appended so much as a newline to the help body. Branch on the flag, never
// on string identity; cli-dispatch.test.ts runs the built CLI to pin it.
export function parseFoundryArgs(
  argv: string[],
): { ok: true; options: ParsedFoundryArgs } | { ok: false; error: string; help?: boolean } {
  let action: "export" | undefined;
  let out = DEFAULT_OUT;
  let cap = DEFAULT_CORPUS_CAP;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { ok: false, error: FOUNDRY_USAGE, help: true };
    if (a === "--json") {
      json = true;
    } else if (a === "--out") {
      const v = argv[++i];
      if (!v) return { ok: false, error: `yaw-mcp foundry: --out needs a path\n\n${FOUNDRY_USAGE}` };
      out = v;
    } else if (a === "--cap") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0)
        return { ok: false, error: `yaw-mcp foundry: --cap needs a positive number\n\n${FOUNDRY_USAGE}` };
      cap = Math.floor(v);
    } else if (a.startsWith("-")) {
      return { ok: false, error: `yaw-mcp foundry: unknown argument "${a}"\n\n${FOUNDRY_USAGE}` };
    } else if (action === undefined) {
      if (a !== "export")
        return { ok: false, error: `yaw-mcp foundry: unknown action "${a}" (only "export")\n\n${FOUNDRY_USAGE}` };
      action = a;
    } else {
      return { ok: false, error: `yaw-mcp foundry: unexpected extra argument "${a}"\n\n${FOUNDRY_USAGE}` };
    }
  }
  if (action === undefined) return { ok: false, error: `yaw-mcp foundry: missing action.\n\n${FOUNDRY_USAGE}` };
  return { ok: true, options: { action, out, cap, json } };
}

export interface FoundryExportOptions {
  out: string;
  cap: number;
  json: boolean;
  home?: string;
  /** Directory both the bundles.json lookup and a RELATIVE `out` resolve
   *  against. Defaults to process.cwd(); `out` used to resolve against
   *  process.cwd() unconditionally, so this knob moved the catalog lookup
   *  without moving the file it produced. */
  cwd?: string;
  // Test hooks: inject the harvested blob + server catalog to bypass fs/bundles.
  readTraces?: () => string | null;
  loadServers?: () => Promise<RankableServer[]>;
  write?: (s: string) => void;
  writeErr?: (s: string) => void;
}

// The production catalog snapshot. Exported for tests: every runFoundryExport
// test injects `loadServers`, so this -- the path a maintainer actually runs --
// had no coverage at all, which is how the empty-tools snapshot the hydration
// below fixes went unnoticed.
export async function defaultLoadServers(cwd: string | undefined, home: string): Promise<RankableServer[]> {
  const { config } = await loadLocalBundles({ cwd, home });
  // Hydrate the PERSISTED tool cache, mirroring ConnectServer.rankableFor.
  // bundles.json's loader does not carry `toolCache` through its field
  // whitelist, so a snapshot built from the config alone gives every server
  // `tools: []` -- and FIELD_WEIGHTS (relevance.ts) scores toolName at 2.0
  // (tied with namespace) and toolDescription at 1.0, while `description` is
  // absent on most entries. Without this the corpus replays the BM25 floor
  // against a catalog missing its two heaviest fields, i.e. NOT the catalog
  // that produced `chosen`, which is the corpus's whole premise.
  //
  // state.json is keyed by namespace, and loadState drops entries older than
  // TOOLCACHE_TTL_MS on the way in -- so a renamed server, or a stale state
  // file, still snapshots empty. runFoundryExport counts the tool-less
  // servers so that is visible instead of silent. `s.toolCache` stays as the
  // fallback in case a future bundles.json does carry the field.
  const state = await loadState(statePath(userConfigDir(home)));
  return (config?.servers ?? []).map((s) => ({
    namespace: s.namespace,
    name: s.name,
    description: s.description,
    tools: state.toolCache[s.namespace]?.tools ?? s.toolCache ?? [],
  }));
}

export async function runFoundryExport(opts: FoundryExportOptions): Promise<{ exitCode: number; lines: string[] }> {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.writeErr ?? ((s: string) => process.stderr.write(s));
  const lines: string[] = [];
  const print = (s = ""): void => {
    lines.push(s);
    write(`${s}\n`);
  };
  const printErr = (s: string): void => {
    lines.push(s);
    writeErr(`${s}\n`);
  };

  const home = opts.home ?? homedir();
  const harvestPath = path.join(userConfigDir(home), FOUNDRY_FILENAME);

  const blob = opts.readTraces
    ? opts.readTraces()
    : (() => {
        try {
          return readFileSync(harvestPath, "utf8");
        } catch {
          return null;
        }
      })();

  if (blob === null) {
    printErr(`yaw-mcp foundry: no harvest at ${harvestPath}. Set YAW_MCP_FOUNDRY=1 and dispatch first.`);
    return { exitCode: 1, lines };
  }

  const traces = parseTraceLines(blob);
  if (traces.length === 0) {
    printErr(`yaw-mcp foundry: ${harvestPath} has no parseable traces.`);
    return { exitCode: 1, lines };
  }

  const servers = opts.loadServers ? await opts.loadServers() : await defaultLoadServers(opts.cwd, home);
  const corpus = buildCorpusFromTraces(traces, servers, { cap: opts.cap });

  if (corpus.entries.length === 0) {
    // Name BOTH ways a trace folds to nothing (the header lists both), counted
    // by the same rule buildCorpusFromTraces applied. This used to blame the
    // catalog alone, so a harvest of empty token bags read as "none of the
    // chosen servers are in the local catalog".
    const known = new Set(servers.map((s) => s.namespace));
    let unknownChosen = 0;
    let emptyTokens = 0;
    for (const t of traces) {
      const reason = traceDropReason(t, known);
      if (reason === "unknown-chosen") unknownChosen++;
      else if (reason === "empty-tokens") emptyTokens++;
    }
    printErr(
      `yaw-mcp foundry: ${traces.length} traces but 0 usable entries -- ${unknownChosen} chose a server that is not in the local catalog (${servers.length} servers) and ${emptyTokens} carried no tokens.`,
    );
    // 1, not 2: this is a runtime outcome (the harvest and the catalog do not
    // overlap), and 2 means "you typed the command wrong" everywhere else in
    // the CLI. A wrapper script keying on 2 to re-print usage was being told
    // to do that for a perfectly well-formed invocation.
    return { exitCode: 1, lines };
  }

  // A snapshot server with no tools is indexed on name+namespace only, so any
  // intent phrased in tool vocabulary ("create issue") scores near zero
  // against it and drags the measured floor down for reasons that have
  // nothing to do with the ranker. Say so rather than letting the maintainer
  // read it as a bad corpus.
  const toolless = servers.filter((s) => s.tools.length === 0).length;
  if (toolless > 0) {
    printErr(
      `yaw-mcp foundry: warning -- ${toolless}/${servers.length} snapshot servers carry no tools (no entry in ~/.yaw-mcp/state.json, or it aged past the tool-cache TTL). Those rank on name + namespace only, which depresses the accuracy printed below; activate them once and re-export.`,
    );
  }

  const outPath = path.resolve(opts.cwd ?? process.cwd(), opts.out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  // Indent 2 for a reviewable diff when the fixture is committed. Verified
  // against biome 2.4.16: `biome check` WOULD reformat this (it collapses the
  // short `tokens` arrays onto one line), which would red the lint gate the
  // moment a real corpus lands under src/. biome.json therefore excludes
  // src/tests/fixtures/*.json -- keep the two in step if either moves.
  writeFileSync(outPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");

  const score = scoreCorpus(corpus);
  // The routing gate (foundry-routing.test.ts) fails when top-3 is below
  // FOUNDRY_TOP3_FLOOR. Say so HERE, at export time, rather than letting a
  // maintainer commit a corpus that reds `npm test` with no warning --
  // the fixtures README only tells them to ratchet the floor UP.
  const belowFloor = score.top3 < FOUNDRY_TOP3_FLOOR;
  if (opts.json) {
    print(
      JSON.stringify(
        {
          out: outPath,
          entries: corpus.entries.length,
          servers: corpus.servers.length,
          toollessServers: toolless,
          fromTraces: traces.length,
          top1: score.top1,
          top3: score.top3,
          floor: FOUNDRY_TOP3_FLOOR,
          belowFloor,
        },
        null,
        2,
      ),
    );
    return { exitCode: 0, lines };
  }

  print(`Wrote ${corpus.entries.length} entries (from ${traces.length} traces) to ${outPath}`);
  print(
    `BM25-floor accuracy on this corpus: top-1 ${(score.top1 * 100).toFixed(1)}%, top-3 ${(score.top3 * 100).toFixed(1)}%`,
  );
  if (belowFloor) {
    printErr(
      `yaw-mcp foundry: warning -- top-3 ${(score.top3 * 100).toFixed(1)}% is BELOW the routing gate floor (${(FOUNDRY_TOP3_FLOOR * 100).toFixed(0)}%, FOUNDRY_TOP3_FLOOR in foundry-corpus.ts). Committing this fixture will fail foundry-routing.test.ts; harvest more traces or lower the floor deliberately.`,
    );
  }
  return { exitCode: 0, lines };
}
