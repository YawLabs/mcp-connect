// `yaw-mcp trust` -- approve a project-local .yaw-mcp/bundles.json.
//
// The consent half of the gate in local-bundles.ts. yaw-mcp itself runs as
// an MCP *stdio* server with no TTY, so it can never ask "do you trust this
// repo?" at load time -- it can only consult a store. This command is where
// the asking happens, because the CLI DOES have a TTY.
//
// The central rule of this file: the user must SEE THE ARGV before they
// approve it. A consent prompt that only shows a path teaches the user to
// hit `y`, which is worse than no prompt at all -- so the grant path always
// renders every command + args (and env KEY NAMES, never values) that the
// file would spawn, derived through the SAME parse + validation the loader
// uses, and only then asks.
//
//   yaw-mcp trust                approve the project found from cwd
//   yaw-mcp trust --list         show approved projects (+ stale ones)
//   yaw-mcp trust --revoke [p]   withdraw approval
//
// Exit codes: 0 success, 1 refused / aborted / nothing to approve,
// 2 argv error (matching the sibling subcommands).

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { localBundlesPath, previewBundlesContent, probeProjectTrust } from "./local-bundles.js";
import { isRegistrySpec, specConstraint } from "./oam-spawn.js";
import { ALLOW_UNOWNED_ENV, CONFIG_DIRNAME } from "./paths.js";
// One prompt reader for the whole product -- see askYesNo at the bottom of
// this file for why this crosses a command boundary.
import { readAnswerFromTTY } from "./secrets-cmd.js";
import {
  grantTrust,
  hashTrustContent,
  isTrustBypassEnabled,
  readTrustStore,
  revokeTrust,
  TRUST_BYPASS_ENV,
  TrustStoreUnreadableError,
  trustedRecords,
  trustStorePath,
} from "./trust.js";
import type { UpstreamServerConfig } from "./types.js";

export const TRUST_USAGE = `Usage: yaw-mcp trust [--yes]
       yaw-mcp trust --list [--json]
       yaw-mcp trust --revoke [<path>] [--json]

  Approve the project-local .yaw-mcp/bundles.json found by walking up from
  the current directory, so yaw-mcp will load it.

  A project bundles.json is normally committed to the repo, and every server
  in it is a command yaw-mcp SPAWNS AS YOU at startup. yaw-mcp therefore
  ignores an unapproved one (your user-global ~/.yaw-mcp/bundles.json still
  loads) until you approve it here. Approval is pinned to the file's exact
  contents: if the file changes, it needs approving again. The pin does NOT
  cover the code those commands run -- a script in the repo or an
  unversioned package can change without any edit to bundles.json.

  Your own ~/.yaw-mcp/bundles.json is never gated by this command.

  --yes, -y         Skip the confirmation prompt. Required when stdin or
                    stdout is not a TTY (there is nothing to ask on).
  --list            List approved project files. Any whose contents changed
                    since approval are flagged \`stale (content changed)\`.
  --revoke [<path>] Withdraw approval for <path>, or for the project found
                    from the current directory when <path> is omitted.
  --json            Machine-readable output for --list and --revoke.

  ${TRUST_BYPASS_ENV}=1 in the environment skips the check entirely
  (CI/automation only -- it lets any repo you run inside spawn commands
  as you).`;

export interface TrustCommandOptions {
  /** Defaults to "grant". */
  mode?: "grant" | "list" | "revoke";
  /** --revoke target; defaults to the project found from cwd. */
  path?: string;
  yes?: boolean;
  json?: boolean;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Test hook: override the TTY verdict instead of reading process.std*. */
  isTTY?: boolean;
  /** Test hook: answer the confirmation without a real TTY read. */
  promptAnswer?: string;
  /** Test hook: fixed clock for the grantedAt stamp. */
  now?: () => number;
  /** Test hook: replaces process.stdin/stdout for the interactive prompt. */
  io?: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream };
}

export interface TrustCommandResult {
  exitCode: number;
}

export function parseTrustArgs(
  argv: string[],
): { ok: true; options: TrustCommandOptions } | { ok: false; error: string; help?: boolean } {
  const opts: TrustCommandOptions = {};
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "-h" || a === "--help") return { ok: false, error: TRUST_USAGE, help: true };
    if (a === "--json") {
      opts.json = true;
      continue;
    }
    if (a === "--yes" || a === "-y") {
      opts.yes = true;
      continue;
    }
    if (a === "--list") {
      if (opts.mode && opts.mode !== "list") {
        return { ok: false, error: `yaw-mcp trust: --list and --revoke are mutually exclusive\n\n${TRUST_USAGE}` };
      }
      opts.mode = "list";
      continue;
    }
    if (a === "--revoke") {
      if (opts.mode && opts.mode !== "revoke") {
        return { ok: false, error: `yaw-mcp trust: --list and --revoke are mutually exclusive\n\n${TRUST_USAGE}` };
      }
      opts.mode = "revoke";
      continue;
    }
    if (a.startsWith("-")) {
      return { ok: false, error: `yaw-mcp trust: unknown flag "${a}"\n\n${TRUST_USAGE}` };
    }
    positional.push(a);
  }
  if (positional.length > 1) {
    return { ok: false, error: `yaw-mcp trust: expected at most one path\n\n${TRUST_USAGE}` };
  }
  if (positional.length === 1) {
    // An EMPTY operand is an argv error, not a path. `yaw-mcp trust --revoke
    // "$REPO"` with $REPO unset expands to one empty argument, which used to
    // parse as a path, fail the truthiness test in runTrustRevoke, and silently
    // revoke the project found from CWD instead -- a different file than the
    // command names, reported as a success.
    if (positional[0].length === 0) {
      return { ok: false, error: `yaw-mcp trust: empty path argument\n\n${TRUST_USAGE}` };
    }
    // A bare path only means something for --revoke. Grant deliberately has
    // no path argument: you approve the project you are standing in, after
    // reading its commands -- not one named from memory.
    if (opts.mode !== "revoke") {
      return {
        ok: false,
        error: `yaw-mcp trust: unexpected argument "${positional[0]}" (a path is only accepted with --revoke)\n\n${TRUST_USAGE}`,
      };
    }
    opts.path = positional[0];
  }
  opts.mode = opts.mode ?? "grant";
  // Cross-action flags are REFUSED, not silently dropped (the discipline
  // secrets-cmd already applies to --value/--stdin/--secret/--server).
  // runTrustGrant never reads opts.json and runTrustList/Revoke never read
  // opts.yes, so `trust --yes --json` used to promise machine-readable output
  // and print prose at a script that was parsing it.
  if (opts.json && opts.mode === "grant") {
    return { ok: false, error: `yaw-mcp trust: --json applies to --list and --revoke only\n\n${TRUST_USAGE}` };
  }
  if (opts.yes && opts.mode !== "grant") {
    return {
      ok: false,
      error: `yaw-mcp trust: --yes applies to the approval prompt only, not --${opts.mode}\n\n${TRUST_USAGE}`,
    };
  }
  return { ok: true, options: opts };
}

export async function runTrust(opts: TrustCommandOptions = {}): Promise<TrustCommandResult> {
  const mode = opts.mode ?? "grant";
  if (mode === "list") return runTrustList(opts);
  if (mode === "revoke") return runTrustRevoke(opts);
  return runTrustGrant(opts);
}

// --- grant ------------------------------------------------------------------

async function runTrustGrant(opts: TrustCommandOptions): Promise<TrustCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  const probe = await probeProjectTrust({ cwd, home, env });

  if (probe.status === "none") {
    // A flat "no .yaw-mcp/ directory found" is a LIE in the case the user is
    // most likely to hit it: findProjectConfigDir REJECTS a `.yaw-mcp/` outside
    // $HOME whose ownership it cannot verify -- the default for every win32
    // checkout on a second drive -- and reports that exactly like a tree with
    // no `.yaw-mcp/` in it at all. Naming the skip is the difference between
    // "there is nothing here" and "I am looking straight at one".
    printErr(
      probe.path === null
        ? `yaw-mcp trust: no .yaw-mcp/ directory that yaw-mcp can use was found by walking up from ${displaySafe(cwd)}. One OUTSIDE your home directory is SKIPPED unless yaw-mcp can verify you own it -- set ${ALLOW_UNOWNED_ENV}=1 to trust this checkout, then re-run. Otherwise there is no project bundles.json to approve; your user-global ~/.yaw-mcp/bundles.json is always loaded.`
        : `yaw-mcp trust: no project bundles.json at ${displaySafe(probe.path)}. Nothing to approve.`,
    );
    return { exitCode: 1 };
  }
  if (probe.status === "unreadable") {
    printErr(
      `yaw-mcp trust: cannot read ${displaySafe(probe.path ?? "")} (${probe.error}). Fix the permissions, then re-run.`,
    );
    return { exitCode: 1 };
  }

  const path = probe.path as string;
  const raw = probe.raw as Buffer;

  if (probe.status === "trusted") {
    print(`Already approved: ${displaySafe(path)}`);
    print(`  contents unchanged since approval (sha256 ${probe.sha256}) -- nothing to do.`);
    return { exitCode: 0 };
  }

  // A store this build must not write over is refused HERE, next to the
  // already-approved short-circuit, rather than after the review. grantTrust
  // throws for the "io" and "schema" kinds no matter what the user answers, so
  // rendering every argv line and asking them to confirm only collects a
  // decision we are about to discard -- and it teaches them the prompt is
  // theatre. The "parse" kind is deliberately NOT short-circuited: grantTrust
  // rebuilds over an unparseable store, so that grant can still succeed and
  // the review is still the thing being approved. probe.status collapses all
  // three into "store-unreadable", so the kind has to come from the store.
  if (probe.status === "store-unreadable") {
    const store = await readTrustStore(home);
    if (store.malformedKind === "io" || store.malformedKind === "schema") {
      printStoreRefusal(printErr, {
        storePath: probe.storePath,
        reason: store.malformedReason ?? `could not use ${probe.storePath}`,
        code: store.errorCode,
        kind: store.malformedKind,
      });
      return { exitCode: 1 };
    }
  }

  // Refuse to approve a file we cannot show the user. Trusting an
  // unparseable file is the worst of both worlds: it spawns nothing, but it
  // DOES commit the loader to the project location and shadow the
  // user-global file (see loadLocalBundles), so it silently deletes the
  // user's real server list.
  const preview = previewBundlesContent(path, raw);
  if (!preview.ok) {
    printErr(`yaw-mcp trust: ${displaySafe(path)} is not a usable bundles.json, so there is nothing to review:`);
    for (const w of preview.warnings) printErr(`  ! ${displaySafe(w)}`);
    printErr("Fix the file, then re-run `yaw-mcp trust`.");
    return { exitCode: 1 };
  }

  // The COUNT belongs in the header, not just implicitly in the list below.
  // The list is unbounded -- a repo can commit 2,000 valid entries -- and at
  // the [y/N] prompt the viewport holds only the last screenful, so an entry
  // near the top is off-screen with nothing on the visible page hinting that
  // there was more to read. Same defence as the control-byte neutering
  // further down: whatever the user is attesting to has to be legible AT the
  // decision point.
  const serverCount = preview.servers.length;
  print("");
  print(`  Project file: ${displaySafe(path)}`);
  print(`  SHA-256:      ${probe.sha256}`);
  print(
    `  Status:       ${probe.status === "changed" ? "CHANGED since you approved it" : probe.status === "store-unreadable" ? `trust store unreadable (${displaySafe(probe.storePath)})` : "never approved"}`,
  );
  print(`  Servers:      ${serverCount}`);
  if (probe.bypassed) {
    // The user reviewing argv deserves to know the gate they are feeding is
    // currently switched off -- what they approve here only starts to matter
    // once the escape hatch is unset.
    print(
      `  ! ${TRUST_BYPASS_ENV} is set: this file (like every project bundles.json) loads WITHOUT approval right now. This approval takes effect once it is unset.`,
    );
  }
  print("");
  if (serverCount === 0) {
    print("  This file defines no servers, so approving it spawns nothing. It");
    print("  WILL still take precedence over your user-global bundles.json,");
    print("  which means yaw-mcp would load no servers at all in this project.");
  } else {
    print("  Approving this file lets yaw-mcp SPAWN the following as you, every");
    print("  time an MCP client starts in this project:");
    print("");
    let n = 0;
    for (const s of preview.servers) {
      n += 1;
      print(`    ${n}. ${s.namespace}${s.isActive ? "" : "  (inactive)"}`);
      const launch = renderLaunch(s);
      print(`       ${launch}`);
      const envKeys = Object.keys(s.env ?? {});
      // Names only, never values -- bundles.json env can hold secrets, and
      // this output is meant to be pasted into a support thread.
      if (envKeys.length > 0) print(`       env: ${envKeys.map(displayArg).join(", ")}`);
      for (const gap of pinGaps(s)) print(`       ! ${gap}`);
    }
  }
  for (const w of preview.warnings) print(`    ! ${displaySafe(w)}`);
  print("");

  if (!opts.yes) {
    if (!isInteractive(opts)) {
      printErr(
        "yaw-mcp trust: refusing to approve without a confirmation -- stdin/stdout is not a TTY. Review the commands above, then re-run with --yes.",
      );
      return { exitCode: 1 };
    }
    // Repeat the count in the question itself: this line is the one thing
    // guaranteed to be on screen, so it is where "there were N of them"
    // has to appear.
    const question =
      serverCount === 0
        ? "  Approve this file? It defines no servers. [y/N] "
        : `  Read ${serverCount === 1 ? "the 1 command" : `all ${serverCount} commands`} above. Approve this file? [y/N] `;
    const answer = await askYesNo(opts, question);
    if (answer !== "y" && answer !== "yes") {
      printErr("yaw-mcp trust: Aborted. Nothing was approved.");
      return { exitCode: 1 };
    }
  }

  // Re-read the file and confirm it is byte-identical to what we just
  // showed. A prompt is an unbounded pause: without this, a repo could swap
  // bundles.json between the render and the grant and get a hash approved
  // for argv the user never saw.
  let confirmBytes: Buffer;
  try {
    confirmBytes = await readFile(path);
  } catch (e) {
    printErr(
      `yaw-mcp trust: ${displaySafe(path)} could not be re-read before approving (${(e as Error).message}). Nothing approved.`,
    );
    return { exitCode: 1 };
  }
  if (hashTrustContent(confirmBytes) !== probe.sha256) {
    printErr(
      `yaw-mcp trust: ${displaySafe(path)} changed while you were reviewing it. Nothing approved -- re-run \`yaw-mcp trust\` to see the new contents.`,
    );
    return { exitCode: 1 };
  }

  // A store we could not READ is refused rather than replaced -- the other
  // projects the user approved are still in that file (see trust.ts). Only a
  // store that would not PARSE gets rebuilt, and that is reported below.
  let granted: Awaited<ReturnType<typeof grantTrust>>;
  try {
    granted = await grantTrust(path, raw, { home, now: opts.now });
  } catch (e) {
    if (e instanceof TrustStoreUnreadableError) {
      // The store can also become unusable BETWEEN the pre-review check above
      // and this write, so both sites render the refusal through one helper.
      printStoreRefusal(printErr, { storePath: e.storePath, reason: e.reason, code: e.code, kind: e.kind });
      return { exitCode: 1 };
    }
    throw e;
  }
  if (granted.storeWasMalformed) {
    printErr(
      `Note: the previous trust store at ${displaySafe(granted.storePath)} was not valid JSON and has been replaced -- any other project you had approved must be approved again.`,
    );
  }
  print(`Approved ${displaySafe(path)}`);
  print(`  pinned to sha256 ${granted.record.sha256}`);
  print(`  recorded in ${displaySafe(granted.storePath)}`);
  print("  PINNED: the exact bytes of that file -- any later edit to it re-requires approval.");
  print("  NOT PINNED: the code those commands actually run. Files inside this repo and");
  print("  packages fetched at spawn time can change with no edit to bundles.json, and so");
  print("  with no new prompt. Approving is trusting the repo, not just this one file.");
  if (probe.bypassed) {
    // "Restart to load it" would credit the approval for something the
    // escape hatch is doing: with the env var set the file was loading
    // all along, approved or not.
    print(
      `NOTE: ${TRUST_BYPASS_ENV} is set, so this file was ALREADY loading without approval. This approval takes effect once the variable is unset.`,
    );
  } else {
    print("Restart your MCP client (or yaw-mcp) to load it.");
  }
  return { exitCode: 0 };
}

/** The refusal for a trust store this build must not write over. Two callers:
 *  the pre-review short-circuit (so the user is never asked to confirm a grant
 *  that cannot land) and the grantTrust catch (the store can go unreadable
 *  while the prompt is open). The remedy differs by kind -- "fix the
 *  permissions" would send a user with a newer-schema store to chmod a file
 *  that reads perfectly. */
function printStoreRefusal(
  printErr: (s: string) => void,
  e: { storePath: string; reason: string; code: string | null; kind: "io" | "schema" },
): void {
  if (e.kind === "schema") {
    printErr(`yaw-mcp trust: ${displaySafe(e.reason)}.`);
    printErr(
      "Nothing was approved and the store was NOT touched: your existing approvals are still in that file, in a format this build would have to guess at. Upgrade with `npm i -g @yawlabs/mcp@latest`, then re-run `yaw-mcp trust`.",
    );
    return;
  }
  printErr(
    `yaw-mcp trust: cannot read the trust store at ${displaySafe(e.storePath)}${e.code ? ` (${e.code})` : ""} -- ${e.reason}.`,
  );
  printErr(
    "Nothing was approved and the store was NOT touched: your existing approvals are still in that file. Fix its permissions (or close whatever is holding it open), then re-run `yaw-mcp trust`.",
  );
}

/** How a server would be launched, as one reviewable line. Args containing
 *  whitespace or quotes are JSON-quoted so `sh -c "curl ... | sh"` reads as
 *  the single argument it really is instead of blending into the line. */
function renderLaunch(s: UpstreamServerConfig): string {
  if (s.type === "remote" || (!s.command && s.url)) return `HTTP ${displaySafe(s.url ?? "(no url)")}`;
  const command = s.command ?? "";
  const args = s.args ?? [];
  // EVERY arg is rendered, empty strings included -- displayArg quotes one as
  // `""` so it is visible rather than a run of spaces. Dropping them made the
  // line something other than the argv that will be spawned, which is this
  // file's whole contract: `{"command":"sh","args":["-c",""]}` rendered as
  // `$ sh -c`, and `sh -c` is a different command than `sh -c ""`. Only an
  // ABSENT command is dropped -- there is no argv[0] to show.
  const parts = command.length > 0 ? [command, ...args] : args;
  if (parts.length === 0) return "(no command)";
  return `$ ${parts.map((p) => displayArg(p)).join(" ")}`;
}

// --- making the file's own strings safe to print ----------------------------
//
// Everything rendered above (command, args, env KEY names, url, the project
// path, the parser's warnings) comes out of a file a hostile repo controls,
// and it is written straight to a terminal immediately above a [y/N] prompt.
// Control bytes there are not cosmetic:
//
//   ESC [8m   turns the pen invisible, so `args: ["-c<ESC>[8m", "curl ...
//             | sh<ESC>[0m"]` renders as a bare `$ sh -c` with the payload
//             concealed in the same colour as the background;
//   ESC [3A ESC [J  moves the cursor up and erases -- the argv block the
//             user was told to read is gone before the prompt paints;
//   BS / CR   rewrite the line in place, so what is on screen is not what
//             is in the file.
//
// The gate's whole value is that the user SEES the argv being authorized, so
// anything the terminal ACTS on instead of PRINTING has to be turned into
// visible text first.

/**
 * Everything a terminal may act on rather than print: C0 (incl. ESC, BEL,
 * BS, CR), DEL, the C1 block (0x9b is CSI in its 8-bit form), and the bidi
 * overrides / isolates, which can visually reorder an argv without changing
 * a byte of it.
 */
const DISPLAY_CONTROL_SOURCE =
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]";
const DISPLAY_CONTROL_RE = new RegExp(DISPLAY_CONTROL_SOURCE);
const DISPLAY_CONTROL_RE_G = new RegExp(DISPLAY_CONTROL_SOURCE, "g");

/** JSON-quote, then escape by hand what JSON.stringify leaves raw. It only
 *  escapes code units below 0x20 (plus `"` and `\`), so DEL, the whole C1
 *  block and the bidi controls survive a JSON.stringify untouched and would
 *  reach the terminal intact. */
function quoteVisible(s: string): string {
  return JSON.stringify(s).replace(DISPLAY_CONTROL_RE_G, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * A string that is NOT argv -- a path, a url, a parser warning. Quoted only
 * when it carries something the terminal would act on. Whitespace alone does
 * not trigger it: `C:\Program Files\...` is an ordinary path, and quoting it
 * would double every backslash for no security gain.
 */
export function displaySafe(s: string): string {
  return DISPLAY_CONTROL_RE.test(s) ? quoteVisible(s) : s;
}

/**
 * One argv token or env key name. Quoted on whitespace and quote characters
 * too, so `sh -c "curl ... | sh"` reads as the single argument it really is
 * instead of blending into the rest of the line. An EMPTY token is quoted for
 * the same reason: rendered bare it is invisible, so the line would show fewer
 * arguments than the spawn actually passes.
 */
export function displayArg(s: string): string {
  return s.length === 0 || /[\s"']/.test(s) || DISPLAY_CONTROL_RE.test(s) ? quoteVisible(s) : s;
}

// --- what the pin does NOT cover --------------------------------------------
//
// The SHA-256 pins bundles.json's bytes. It does not pin what those bytes
// POINT AT. Spawns inherit yaw-mcp's cwd, so an approved
// `{"command":"node","args":["scripts/mcp-server.js"]}` re-executes whatever
// that script contains TODAY -- a later commit rewriting it leaves
// bundles.json untouched, the hash still matches, and nothing re-prompts.
// Same for `npx -y pkg` with no version: the registry decides what runs.
//
// This is a heads-up line next to the entry, deliberately NOT a static
// analyzer. It fires on the two shapes that are unambiguous and stays quiet
// otherwise -- a false negative here costs nothing (the closing text already
// says the pin does not cover executed code), a false positive would train
// the user to ignore the line.

/** Extensions that mean "this token is a script the interpreter will read
 *  from disk", as opposed to a package name or a subcommand. */
const SCRIPT_EXT_RE = /\.(?:js|mjs|cjs|ts|mts|cts|py|rb|sh|bash|zsh|pl|php|lua|jar|bat|cmd|ps1|exe)$/i;

/** Tokens that resolve against the cwd -- i.e. inside the repo -- at spawn. */
function inRepoTokens(s: UpstreamServerConfig): string[] {
  const hits: string[] = [];
  const isLocalish = (t: string): boolean =>
    t.length > 0 && !/\s/.test(t) && !isAbsolute(t) && !t.includes("://") && !t.startsWith("-");
  const command = s.command ?? "";
  // A bare `node` resolves off PATH; `scripts/serve` or `./run.sh` does not.
  if (isLocalish(command) && (/^\.{1,2}[\\/]/.test(command) || /[\\/]/.test(command))) hits.push(command);
  for (const a of s.args ?? []) {
    // An explicit ./ or ../ is unambiguous; otherwise require a script
    // extension, so `@scope/pkg` and `owner/repo` are left alone.
    if (isLocalish(a) && (/^\.{1,2}[\\/]/.test(a) || SCRIPT_EXT_RE.test(a))) hits.push(a);
  }
  return hits;
}

/** Package runners whose first non-flag operand names something fetched at
 *  spawn time. `sub` is the subcommand that has to be present first; `python`
 *  marks the runners that resolve a PEP 440 spec instead of an npm one. */
const REGISTRY_RUNNERS: Array<{ cmd: string; sub?: string; python?: true }> = [
  { cmd: "npx" },
  { cmd: "bunx" },
  { cmd: "uvx", python: true },
  { cmd: "pnpm", sub: "dlx" },
  { cmd: "npm", sub: "exec" },
  { cmd: "pipx", sub: "run", python: true },
];

/** Flags that take no value, so the token after them is still the operand.
 *  Any OTHER flag makes us give up rather than guess which token is the
 *  package (`npx -p a -c b` must not report `b`). */
const VALUELESS_RUNNER_FLAGS = new Set([
  "-y",
  "--yes",
  "-q",
  "--quiet",
  "--silent",
  "--offline",
  "--prefer-offline",
  "--prefer-online",
  "--no-install",
  "--ignore-existing",
]);

/**
 * The spec with a leading `v` stripped from its version suffix, so
 * specConstraint can judge what npm will actually install. npm's semver
 * parser drops the `v`, so `pkg@v1.2.3` pins exactly 1.2.3 forever --
 * telling the user it "resolves to whatever the registry serves at spawn
 * time" would be false. oam-spawn's specConstraint deliberately buckets a
 * v-prefixed version as "range" because ITS caller compares the suffix
 * VERBATIM against a package.json version (which never carries the `v`) and
 * npx is the safe fallback there; the preview asks a different question, so
 * the strip lives here in the caller, never in specConstraint itself. Only
 * a `v` followed by a digit is stripped: a dist-tag may legally start with
 * `v` (`vnext`), and npm forbids tags that parse as semver, so `v<digit>`
 * can only be a version expression.
 */
function stripVersionPrefixV(spec: string): string {
  // The version separator is the "@" after the (possibly scoped) name --
  // same cut as oam-spawn.ts:packageName.
  const start = spec.startsWith("@") ? 1 : 0;
  const at = spec.indexOf("@", start);
  if (at === -1) return spec;
  const suffix = spec.slice(at + 1);
  return /^v\d/.test(suffix) ? spec.slice(0, at + 1) + suffix.slice(1) : spec;
}

/** The `@suffix` of a package spec, or null when it carries none. Same cut as
 *  stripVersionPrefixV above (and oam-spawn.ts:packageName): the "@" after the
 *  possibly-scoped name. */
function specVersionSuffix(spec: string): string | null {
  const start = spec.startsWith("@") ? 1 : 0;
  const at = spec.indexOf("@", start);
  return at === -1 ? null : spec.slice(at + 1);
}

/** One complete PEP 440 release, as uv/pipx would resolve it. Deliberately
 *  looser than npm's x.y.z: a two-component release (`1.0`) is COMPLETE in PEP
 *  440, so `uvx pkg@1.0` names exactly one version even though npm's parser
 *  calls the same suffix a partial range. Anything carrying a range operator
 *  (`>=1`, `1.*`, `~=1.2`) fails to match and is reported as unpinned. */
const PEP440_EXACT_RE = /^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/;

/** The registry spec this entry would fetch, when it has no version pin. */
function unversionedRegistrySpec(s: UpstreamServerConfig): string | null {
  const base =
    (s.command ?? "")
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(?:exe|cmd|bat)$/i, "") ?? "";
  const runner = REGISTRY_RUNNERS.find((r) => r.cmd === base);
  if (!runner) return null;
  let rest = s.args ?? [];
  if (runner.sub) {
    if (rest[0] !== runner.sub) return null;
    rest = rest.slice(1);
  }
  let spec: string | null = null;
  for (const a of rest) {
    if (a.startsWith("-")) {
      if (VALUELESS_RUNNER_FLAGS.has(a)) continue;
      return null; // an unrecognised flag may consume the next token
    }
    spec = a;
    break;
  }
  if (spec === null || spec.length === 0) return null;
  // A local path / url / git ref is not a registry lookup at all (inRepoTokens
  // or the closing text covers those). This is oam-spawn's OWN test rather than
  // a second, weaker copy of it: the hand-rolled `://` + isAbsolute check let
  // every protocol form through, so `github:owner/repo#<sha>` -- pinned to a
  // COMMIT, a harder pin than any registry version -- was reported as
  // "resolves to whatever the registry serves at spawn time".
  if (!isRegistrySpec(spec)) return null;
  // uvx / pipx pin: `pkg==0.4.1` names one exact version (PEP 440 form).
  // A scope-free substring test is enough -- npm specs never carry `==`.
  if (spec.includes("==")) return null;
  // The rest of the version rules below are npm's, and a PYTHON runner does not
  // use them: `uvx pkg@1.0` is one exact release under PEP 440, while npm's
  // x.y.z-or-nothing parser buckets `1.0` as a partial range -- so a pinned uv
  // spec was reported as unpinned on the entries where the pin is real.
  if (runner.python) return PEP440_EXACT_RE.test(specVersionSuffix(spec) ?? "") ? null : spec;
  // npm-style suffix: only an EXACT version is a pin. A dist-tag
  // (`@latest`, `@next`) or a range (`@^1.2.3`, `@*`) re-resolves against
  // the registry at spawn time exactly like a bare spec -- and `@latest`
  // is the shape every catalog install writes into bundles.json, so
  // counting any `@` as a pin silenced this line on the entries that most
  // needed it. Same classification as oam-spawn.ts:specConstraint (which
  // already treats dist-tags as "any" and ranges as unpinned), with one
  // deliberate divergence: a leading `v` on the version is stripped first,
  // because `pkg@v1.2.3` installs exactly 1.2.3 -- see stripVersionPrefixV.
  if (specConstraint(stripVersionPrefixV(spec)).kind === "exact") return null;
  return spec;
}

/** At most two lines naming content the SHA-256 does not cover. */
function pinGaps(s: UpstreamServerConfig): string[] {
  if (s.type === "remote" || (!s.command && s.url)) return [];
  const lines: string[] = [];
  const repo = inRepoTokens(s);
  if (repo.length > 0) {
    lines.push(
      `NOT covered by the pin: ${repo.slice(0, 3).map(displayArg).join(" ")} runs from inside this repo -- a later commit rewrites it with no re-approval.`,
    );
  }
  const spec = unversionedRegistrySpec(s);
  if (spec !== null) {
    lines.push(
      `NOT covered by the pin: ${displayArg(spec)} is not pinned to an exact version -- it resolves to whatever the registry serves at spawn time.`,
    );
  }
  return lines;
}

// --- list -------------------------------------------------------------------

type ListStatus = "ok" | "stale (content changed)" | "missing (file not found)" | "unreadable";

async function runTrustList(opts: TrustCommandOptions): Promise<TrustCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;

  // The escape hatch changes what every line below MEANS: with it set, the
  // loader honours every project file regardless of the approvals this
  // command reports. An audit surface that hides that reports a state the
  // loader is not in -- same warning doctor prints, on stderr so a piped
  // `trust --list` still parses.
  const bypassed = isTrustBypassEnabled(env);
  if (bypassed && !opts.json) {
    err(
      `yaw-mcp trust: warning -- ${TRUST_BYPASS_ENV} is set, so EVERY project bundles.json loads WITHOUT approval right now, regardless of what is listed here. Unset it to restore the approval gate.\n`,
    );
  }

  const store = await readTrustStore(home);
  if (store.malformed) {
    // An unreadable store still HOLDS the grants -- telling the user to
    // delete it would throw away exactly what they are trying to inspect.
    const fix =
      store.malformedKind === "io"
        ? "fix its permissions (do NOT delete it -- your approvals are still in there)"
        : store.malformedKind === "schema"
          ? "you upgrade with `npm i -g @yawlabs/mcp@latest` (do NOT delete it -- your approvals are still in there)"
          : "it is fixed or deleted";
    const msg = `trust store unusable: ${store.malformedReason ?? "unknown"} -- NOTHING is trusted until ${fix}`;
    if (opts.json) {
      out(
        `${JSON.stringify({ storePath: trustStorePath(home), malformed: true, bypassed, error: msg, trusted: [] }, null, 2)}\n`,
      );
    } else {
      err(`yaw-mcp trust: ${msg}\n`);
    }
    return { exitCode: opts.json ? 0 : 1 };
  }

  // The rows come from the store already in hand. listTrusted would read the
  // file again -- and a store that went unreadable between the two reads would
  // then list NOTHING under a header that just said it was fine.
  const records = trustedRecords(store);
  const rows: Array<{ path: string; sha256: string; grantedAt: string; status: ListStatus }> = [];
  for (const r of records) {
    rows.push({ ...r, status: await classifyRecord(r.path, r.sha256) });
  }

  if (opts.json) {
    out(`${JSON.stringify({ storePath: trustStorePath(home), malformed: false, bypassed, trusted: rows }, null, 2)}\n`);
    return { exitCode: 0 };
  }

  if (rows.length === 0) {
    print("No project bundles.json files are approved.");
    print("Run `yaw-mcp trust` from inside a project to approve its file.");
    return { exitCode: 0 };
  }

  const cols: Array<[string, (r: (typeof rows)[number]) => string]> = [
    // displaySafe, not the raw path: a repo directory name can legally carry
    // ESC on POSIX, and `trust --list` is the surface a user audits to decide
    // what to revoke -- rewriting it with cursor control defeats that. Column
    // widths stay consistent because they are measured from this same getter.
    // The --json branch above stays raw; its consumers want the real path and
    // JSON.stringify handles its own quoting.
    ["PATH", (r) => displaySafe(r.path)],
    ["APPROVED", (r) => (r.grantedAt.length > 0 ? r.grantedAt : "-")],
    ["STATUS", (r) => r.status],
  ];
  const widths = cols.map(([h, get]) => Math.max(h.length, ...rows.map((r) => get(r).length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  print(fmt(cols.map(([h]) => h)));
  for (const r of rows) print(fmt(cols.map(([, get]) => get(r))));
  print("");
  print(`${rows.length} approved in ${trustStorePath(home)}`);
  // One footer line PER STATUS, because the loader treats the three differently
  // and a single "not loaded -- re-approve" line was wrong for two of them. An
  // UNREADABLE approved file is still honoured (projectFileIsHonoured: the path
  // is in the store, so it is authoritative even when broken) -- it shadows the
  // user-global file and yields no servers, which is the opposite of "not
  // loaded" and is not fixed by re-approving. A MISSING one is honoured by
  // nobody; the row is just stale bookkeeping.
  const hasStatus = (s: ListStatus): boolean => rows.some((r) => r.status === s);
  if (hasStatus("stale (content changed)")) {
    print("A stale entry is NOT loaded -- re-run `yaw-mcp trust` from that project to re-approve.");
  }
  if (hasStatus("missing (file not found)")) {
    print("A missing entry loads nothing -- drop the row with `yaw-mcp trust --revoke <path>`.");
  }
  if (hasStatus("unreadable")) {
    print(
      "An unreadable entry is STILL honoured by the loader: an approved path yaw-mcp cannot read shadows your user-global ~/.yaw-mcp/bundles.json, so that project loads NO servers. Fix its permissions, or drop it with `yaw-mcp trust --revoke <path>`.",
    );
  }
  return { exitCode: 0 };
}

async function classifyRecord(path: string, sha256: string): Promise<ListStatus> {
  try {
    const raw = await readFile(path);
    return hashTrustContent(raw) === sha256 ? "ok" : "stale (content changed)";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ENOENT only. EISDIR is what the LOADER classifies as a read failure
    // (readBundlesRawAt), and it honours an approved path that fails that way
    // -- so calling it "missing (file not found)" here told the user the
    // opposite of what the loader does with it, and pointed them at a remedy
    // for a file that is very much present.
    return code === "ENOENT" ? "missing (file not found)" : "unreadable";
  }
}

// --- revoke -----------------------------------------------------------------

/** Map a user-supplied `--revoke` target onto the key the store actually
 *  holds -- the project's `.yaw-mcp/bundles.json`.
 *
 *  `yaw-mcp trust --revoke .` is the spelling a user reaches for (it mirrors
 *  the grant, which takes no path at all and works on the project you are
 *  standing in), but the store is keyed by the FILE. Resolving the directory
 *  verbatim therefore matched nothing and exited 0 with "was not approved
 *  (nothing to do)" -- a silent no-op that reads as a successful revoke.
 *
 *  A path that does not exist is passed through unchanged: there is nothing to
 *  probe, and revokeTrust's not-approved branch is the right answer for it. */
async function resolveRevokeTarget(target: string): Promise<string> {
  let isDir: boolean;
  try {
    isDir = (await stat(target)).isDirectory();
  } catch {
    return target;
  }
  if (!isDir) return target;
  // <project>/.yaw-mcp -> that directory's bundles.json; anything else is
  // treated as the project root, which owns a .yaw-mcp/ of its own.
  return basename(target) === CONFIG_DIRNAME
    ? localBundlesPath(target)
    : localBundlesPath(join(target, CONFIG_DIRNAME));
}

async function runTrustRevoke(opts: TrustCommandOptions): Promise<TrustCommandResult> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const err = opts.err ?? ((s: string) => process.stderr.write(s));
  const print = (s = ""): void => out(`${s}\n`);
  const printErr = (s: string): void => err(`${s}\n`);

  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  // The escape hatch outranks the store here exactly as it does on the grant
  // and list paths: with it set the loader honours every project file, so a
  // revoke changes nothing until the variable is unset.
  const bypassed = isTrustBypassEnabled(env);

  let target: string;
  // `!== undefined`, not truthiness: an empty string is a PATH the caller
  // named, not an absent one, and falling through to the cwd probe for it
  // revoked a different file than the command asked about. parseTrustArgs
  // rejects an empty operand outright; this is the same rule for the
  // programmatic entry point.
  if (opts.path !== undefined) {
    target = await resolveRevokeTarget(resolve(cwd, opts.path));
  } else {
    const probe = await probeProjectTrust({ cwd, home, env });
    if (probe.path === null) {
      const msg = `no .yaw-mcp/ directory found by walking up from ${displaySafe(cwd)}; pass an explicit path (see \`yaw-mcp trust --list\`)`;
      if (opts.json) out(`${JSON.stringify({ ok: false, error: msg }, null, 2)}\n`);
      else printErr(`yaw-mcp trust --revoke: ${msg}`);
      return { exitCode: 1 };
    }
    target = probe.path;
  }

  const res = await revokeTrust(target, { home });
  if (res.storeWasMalformed) {
    // The same three kinds --list and the grant path distinguish, with the same
    // remedies. Collapsing them into "is unreadable, so nothing is trusted and
    // there was nothing to revoke" was wrong for a NEWER-SCHEMA store -- the
    // grants are real and still there, for the build that wrote them -- and it
    // contradicted the "do NOT delete it" the other two surfaces print. The
    // kind comes back on the result: re-reading the store here to learn it
    // could classify a DIFFERENT failure than the one that refused the revoke.
    const fix =
      res.malformedKind === "io"
        ? "fix its permissions (do NOT delete it -- your approvals are still in there)"
        : res.malformedKind === "schema"
          ? "upgrade with `npm i -g @yawlabs/mcp@latest` (do NOT delete it -- your approvals are still in there)"
          : "fix or delete it";
    const msg = `trust store unusable: ${res.malformedReason ?? "unknown"} -- nothing was revoked; ${fix}, then re-run`;
    if (opts.json) out(`${JSON.stringify({ ok: false, path: target, removed: false, error: msg }, null, 2)}\n`);
    else printErr(`yaw-mcp trust --revoke: ${msg}`);
    return { exitCode: 1 };
  }
  if (opts.json) {
    out(
      `${JSON.stringify({ ok: true, path: target, removed: res.removed, storePath: res.storePath, bypassed }, null, 2)}\n`,
    );
    return { exitCode: 0 };
  }
  // A no-op revoke exits 0: "make it not approved" is satisfied either way
  // (same posture as `yaw-mcp remove` and `try-cleanup`).
  if (!res.removed) {
    print(`yaw-mcp trust --revoke: ${displaySafe(target)} was not approved (nothing to do).`);
    return { exitCode: 0 };
  }
  // displaySafe on the human path only -- the --json branch above keeps the
  // raw target for consumers. A revoke target can come from an attacker-named
  // repo directory just like a grant target can.
  print(`Revoked ${displaySafe(target)}`);
  print(`  removed from ${res.storePath}`);
  if (bypassed) {
    // "Restart to stop loading it" would credit the revoke for something the
    // escape hatch overrides: with the env var set the file keeps loading,
    // approved or not. Same wording the grant path uses for the same reason.
    print(
      `NOTE: ${TRUST_BYPASS_ENV} is set, so this file KEEPS loading without approval. This revocation takes effect once the variable is unset.`,
    );
  } else {
    print("Restart your MCP client (or yaw-mcp) to stop loading it.");
  }
  return { exitCode: 0 };
}

// --- prompt -----------------------------------------------------------------

/** Both ends must be a TTY: stdin to read the answer, stdout to show the
 *  question. Mirrors secrets-cmd.ts:isInteractiveTTY. */
function isInteractive(opts: TrustCommandOptions): boolean {
  if (opts.isTTY !== undefined) return opts.isTTY;
  if (opts.promptAnswer !== undefined) return true;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/** Ask the confirmation. Defaults to NO -- only an explicit y/yes proceeds,
 *  so a bare Enter (or ^D, or a stray keystroke) leaves the file unapproved.
 *
 *  Routed through secrets-cmd's reader rather than node:readline so both of
 *  the product's confirmation prompts behave identically: control bytes are
 *  dropped instead of buffered and echoed, which is what stops an arrow key
 *  at this prompt from repainting the screen AND leaving an invisible byte in
 *  the answer ("\x1by" is not "y", so the approval silently flipped to a
 *  decline). Two implementations of "read one confirmation" drift; there is
 *  now one. */
async function askYesNo(opts: TrustCommandOptions, question: string): Promise<string> {
  if (opts.promptAnswer !== undefined) return opts.promptAnswer.trim().toLowerCase();
  const input = opts.io?.stdin ?? process.stdin;
  const output = opts.io?.stdout ?? process.stdout;
  // null = ^C. The prompt already defaults to NO, so a cancel lands on the
  // same "Aborted. Nothing was approved." path as any other non-y answer.
  const answer = await readAnswerFromTTY(input, output, question);
  return (answer ?? "").trim().toLowerCase();
}
