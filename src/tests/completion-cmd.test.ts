import { describe, expect, it } from "vitest";
import { parseAuditArgs } from "../audit-cmd.js";
import { parseBundlesArgs } from "../bundles-cmd.js";
import {
  COMPLETION_USAGE,
  parseCompletionArgs,
  renderScript,
  runCompletion,
  SUBCOMMAND_SPEC,
} from "../completion-cmd.js";
import { parseDoctorArgs } from "../doctor-cmd.js";
import { parseFoundryArgs } from "../foundry-cmd.js";
import { parseInstallArgs } from "../install-cmd.js";
import { parseAddArgs, parseListArgs, parseRemoveArgs } from "../local-add-cmd.js";
import { parseResetLearningArgs } from "../reset-learning-cmd.js";
import { parseSecretsArgs } from "../secrets-cmd.js";
import { parseSidecarsArgs } from "../sidecars-cmd.js";
import { FLAG_ALIASES, KNOWN_SUBCOMMANDS } from "../subcommands.js";
import { parseTrustArgs } from "../trust-cmd.js";
import { parseTryArgs, parseTryCleanupArgs } from "../try-cmd.js";
import { parseUpgradeArgs } from "../upgrade-cmd.js";

const SUBCOMMAND_NAMES = SUBCOMMAND_SPEC.map((s) => s.name);

// Ground truth comes straight from the real dispatch table
// (src/subcommands.ts), which index.ts imports. Drop the leading-dash
// flag aliases and `help` (which has no per-subcommand completion of its
// own) to get the set the completion spec must cover. Importing the live
// table -- not a hand-maintained mirror -- makes the drift guard REAL: a
// new dispatched subcommand that forgets a SUBCOMMAND_SPEC entry fails
// this test.
// `servers` is the one DELIBERATE exemption: still dispatched (Yaw Terminal
// shells out to `yaw-mcp servers --json` and reads signedIn:false from its
// always-non-zero exit), but a deprecation stub, and completing a deprecated
// thing teaches it -- the rule that already hides `--token`. The dedicated
// test below pins that it stays dispatched AND stays uncompleted.
const DISPATCHED_SUBCOMMANDS = KNOWN_SUBCOMMANDS.filter(
  (s) => !(FLAG_ALIASES as readonly string[]).includes(s) && s !== "help" && s !== "servers",
);

function capture(): { out: string[]; err: string[]; push: (s: string) => void; pushErr: (s: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    push: (s: string) => {
      out.push(s);
    },
    pushErr: (s: string) => {
      err.push(s);
    },
  };
}

describe("parseCompletionArgs", () => {
  it("accepts each supported shell", () => {
    for (const shell of ["bash", "zsh", "fish", "powershell"] as const) {
      const r = parseCompletionArgs([shell]);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.options.shell).toBe(shell);
    }
  });

  it("rejects missing shell argument", () => {
    const r = parseCompletionArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("missing shell argument");
  });

  it("rejects unknown shell", () => {
    const r = parseCompletionArgs(["tcsh"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown shell "tcsh"');
  });

  it("rejects multiple positional args", () => {
    const r = parseCompletionArgs(["bash", "zsh"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("too many arguments");
  });

  it("--help returns usage string", () => {
    const r = parseCompletionArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(COMPLETION_USAGE);
  });

  it("rejects unknown flags instead of silently ignoring them", () => {
    const r = parseCompletionArgs(["bash", "--verbose"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown flag "--verbose"');
  });
});

describe("renderScript — bash", () => {
  it("contains the complete -F registration", () => {
    const s = renderScript("bash");
    expect(s).toContain("complete -F _yaw-mcp yaw-mcp");
    expect(s).toContain("_yaw-mcp()");
  });

  it("includes every spec'd subcommand in the top-level compgen", () => {
    const s = renderScript("bash");
    // Scope the assertion to the `$cword -eq 1` word list it names. A whole-
    // script `toContain(sub)` could not fail for that reason: every subcommand
    // also appears as its own bash `case` label further down, so the check
    // passed even when the top-level list was missing entries.
    const topLevel = s.match(/COMPREPLY=\( \$\(compgen -W "([^"]*)" -- "\$cur"\) \)/);
    expect(topLevel, "no compgen word list in the generated bash script").not.toBeNull();
    const words = (topLevel as RegExpMatchArray)[1].split(" ");
    for (const sub of SUBCOMMAND_NAMES) {
      expect(words, `subcommand missing from the top-level compgen: ${sub}`).toContain(sub);
    }
    // The top-level list carries the global flags too, which is how we know the
    // match above is the `$cword -eq 1` line and not a per-subcommand one.
    expect(words).toEqual(expect.arrayContaining(["--help", "-h", "--version", "-V"]));
  });

  it("branches on install client choices", () => {
    const s = renderScript("bash");
    expect(s).toContain("claude-code");
    expect(s).toContain("claude-desktop");
    expect(s).toContain("cursor");
    expect(s).toContain("vscode");
  });

  it("offers positional alternatives at the SAME argument position (one compgen word list)", () => {
    const s = renderScript("bash");
    // All four install clients complete at `install <TAB>`, not one per slot.
    expect(s).toContain('compgen -W "claude-code claude-desktop cursor vscode"');
    // Same for bundles actions and completion shells.
    expect(s).toContain('compgen -W "list match"');
    expect(s).toContain('compgen -W "bash zsh fish powershell"');
  });

  it("includes install flags", () => {
    const s = renderScript("bash");
    for (const flag of ["--scope", "--force", "--dry-run"]) {
      expect(s).toContain(flag);
    }
  });

  it("guards every positional clause so a dash word falls through to the flag compgen", () => {
    // Regression: each positional clause ends in an unconditional `return 0`,
    // so without the `$cur != -*` guard a flag typed AT the slot
    // (`install --<TAB>`) compgen'd against the client list and returned an
    // EMPTY COMPREPLY -- zero candidates, and (`complete -F` without
    // `-o default`) no fallback. `install --list`/`--all` forbid a client
    // argument, so slot 0 is the only position those flags can occupy.
    const s = renderScript("bash");
    const posClauses = s.split("\n").filter((l) => l.includes("$cword -eq $(("));
    expect(posClauses.length).toBeGreaterThan(0);
    for (const clause of posClauses) {
      expect(clause).toContain("$cur != -*");
    }
  });
});

describe("renderScript — zsh", () => {
  it("starts with #compdef directive", () => {
    const s = renderScript("zsh");
    expect(s.startsWith("#compdef yaw-mcp")).toBe(true);
  });

  it("declares the _yaw-mcp function", () => {
    const s = renderScript("zsh");
    expect(s).toContain("_yaw-mcp()");
  });

  it("lists every subcommand as a _values candidate with a non-blank description", () => {
    const s = renderScript("zsh");
    for (const spec of SUBCOMMAND_SPEC) {
      // Each entry renders as 'name[description]' -- `_values` takes specs in
      // `_arguments` form minus the option name, so the description belongs in
      // BRACKETS. The old 'name:description' form is `_describe` syntax: zsh
      // parses everything after the ':' as an argument spec and the candidate
      // shows up with no description at all.
      expect(s).toContain(`'${spec.name}[${spec.description}]'`);
      expect(spec.description.length).toBeGreaterThan(0);
      // A '[' / ']' / '(' / ')' inside a description would close the bracket
      // early or open an action group, silently mangling the candidate.
      expect(spec.description).not.toMatch(/[[\]()]/);
    }
    // The colon form must be gone entirely -- no spec may render as 'name:...'.
    expect(s).not.toMatch(/'[a-z-]+:[^']*'/);
  });

  it("continues the _values invocation on every spec line but the last", () => {
    // REGRESSION: the spec lines used to be joined on a bare newline, so only
    // the FIRST of the 19 continued the `_values` call. The other 18 were
    // emitted as standalone zsh simple commands whose command word was the
    // quoted string -- a user pressing TAB after `yaw-mcp ` got `install` as
    // the sole candidate plus 18 `command not found: add[...]` errors.
    const s = renderScript("zsh");
    const block = s.match(/_values 'yaw-mcp subcommand' \\\n([\s\S]*?)\n {6};;/);
    expect(block, "no _values block in the generated zsh script").not.toBeNull();
    const specLines = (block as RegExpMatchArray)[1].split("\n");
    expect(specLines).toHaveLength(SUBCOMMAND_SPEC.length);
    for (const line of specLines.slice(0, -1)) {
      expect(line, `spec line does not continue _values: ${line}`).toMatch(/' \\$/);
    }
    // Only the final spec line terminates the command.
    expect(specLines[specLines.length - 1]).toMatch(/'\s*$/);
    expect(specLines[specLines.length - 1]).not.toMatch(/\\$/);
  });

  it("offers positional alternatives at the same _arguments slot", () => {
    const s = renderScript("zsh");
    expect(s).toContain("'1: :(claude-code claude-desktop cursor vscode)'");
    expect(s).toContain("'1: :(bash zsh fish powershell)'");
    expect(s).toContain("'1: :(list match)'");
  });

  it("emits flags as real option specs, so a dash word completes at slot 1", () => {
    // REGRESSION: flags used to live ONLY in a `'*: :(...)'` rest group, which
    // zsh consults after the numbered slots -- so at the FIRST argument slot
    // `yaw-mcp install --<TAB>` offered nothing at all, and `--list` / `--all`
    // (which forbid a client argument, making slot 1 the only position they can
    // occupy) were untabbable. bash, fish and powershell all offer flags there.
    // As option specs zsh offers them at every position.
    const s = renderScript("zsh");
    const installLine = s.split("\n").find((l) => l.includes("'1: :(claude-code claude-desktop cursor vscode)'"));
    expect(installLine, "no install _arguments line in the generated zsh script").toBeDefined();
    for (const flag of ["--list", "--all", "--scope", "--dry-run", "--help"]) {
      expect(installLine, `install flag missing from the zsh option specs: ${flag}`).toContain(`'${flag}'`);
    }
    // Every flag-carrying subcommand gets the same treatment, and no flag is
    // left hiding in a rest group.
    for (const spec of SUBCOMMAND_SPEC) {
      for (const flag of spec.flags) {
        expect(s).toContain(`'${flag}'`);
      }
    }
    expect(s).not.toContain("'*: :(--");
  });
});

describe("renderScript — fish", () => {
  it("uses complete -c yaw-mcp lines", () => {
    const s = renderScript("fish");
    expect(s).toMatch(/complete -c yaw-mcp/);
  });

  it("registers every spec'd subcommand under __fish_use_subcommand", () => {
    const s = renderScript("fish");
    for (const sub of SUBCOMMAND_NAMES) {
      expect(s).toContain(`-a ${sub}`);
    }
  });

  it("scopes flags to the ACTIVE subcommand, not to any token on the line", () => {
    // REGRESSION: the flag lines were guarded by __fish_seen_subcommand_from,
    // which matches a token ANYWHERE on the line. `install` is a positional
    // VALUE of `sidecars`, so `yaw-mcp sidecars install --<TAB>` offered
    // --scope / --project-dir / --os / --force / --skip / --dry-run / --list /
    // --all, none of which sidecars accepts -- picking one exits non-zero with
    // `unknown argument`. The emitted helper resolves the FIRST token that is a
    // real subcommand instead, so `sidecars` wins there.
    const s = renderScript("fish");
    expect(s).toContain("function __yaw_mcp_using_subcommand");
    // The helper's known-subcommand set is generated from the spec, so it can't
    // drift away from the subcommands it has to recognize.
    const knownLine = s.split("\n").find((l) => l.trimStart().startsWith("set -l known "));
    expect(knownLine, "no known-subcommand set in the generated fish helper").toBeDefined();
    const known = (knownLine as string).trim().slice("set -l known ".length).split(" ");
    expect(known).toEqual(SUBCOMMAND_NAMES);

    const flagLines = s.split("\n").filter((l) => / -l [a-z0-9-]+$/.test(l));
    expect(flagLines.length).toBeGreaterThan(0);
    for (const line of flagLines) {
      expect(line, `flag line is not scoped to the active subcommand: ${line}`).toMatch(
        /-n "__yaw_mcp_using_subcommand [a-z-]+"/,
      );
      expect(line).not.toContain("__fish_seen_subcommand_from");
    }
    // `--scope` belongs to install alone: no other subcommand's guard offers it.
    expect(flagLines.filter((l) => l.endsWith(" -l scope"))).toEqual([
      'complete -c yaw-mcp -n "__yaw_mcp_using_subcommand install" -l scope',
    ]);
  });

  it("offers positional alternatives at the same argument position", () => {
    const s = renderScript("fish");
    expect(s).toContain('-a "claude-code claude-desktop cursor vscode"');
    expect(s).toContain('-a "list match"');
  });

  it("scopes positional candidates to the ACTIVE subcommand too", () => {
    // Same defect as the flag lines, one release later: the positional lines
    // kept `__fish_seen_subcommand_from`, so once a positional VALUE is also
    // a subcommand name (`sidecars install`) the token count alone decided
    // whose candidates fish offered. Nothing in the generated script may use
    // the anywhere-on-the-line guard any more.
    const s = renderScript("fish");
    const positionalLines = s.split("\n").filter((l) => l.includes(" -a ") && l.includes("count (commandline -opc)"));
    expect(positionalLines.length).toBeGreaterThan(0);
    for (const line of positionalLines) {
      expect(line, `positional line is not scoped to the active subcommand: ${line}`).toMatch(
        /-n "__yaw_mcp_using_subcommand [a-z-]+; and test \(count \(commandline -opc\)\) -eq [0-9]+"/,
      );
    }
    expect(s).not.toContain("__fish_seen_subcommand_from");
  });
});

describe("renderScript — powershell", () => {
  it("registers ArgumentCompleter for yaw-mcp", () => {
    const s = renderScript("powershell");
    expect(s).toContain("Register-ArgumentCompleter");
    expect(s).toContain("-CommandName yaw-mcp");
  });

  it("covers every spec'd subcommand in the switch block", () => {
    const s = renderScript("powershell");
    for (const sub of SUBCOMMAND_NAMES) {
      expect(s).toContain(`'${sub}'`);
    }
  });

  it("offers positional alternatives at the same token position", () => {
    const s = renderScript("powershell");
    expect(s).toContain("@('claude-code', 'claude-desktop', 'cursor', 'vscode')");
    expect(s).toContain("@('list', 'match')");
  });

  it("guards positional slots on a normalized $argIndex, never on a raw token count", () => {
    const s = renderScript("powershell");
    // The per-subcommand switch only runs once at least one argument follows
    // the subcommand, so a raw `$tokens.Count -eq N` slot guard is dead code:
    // slot 0's `-eq 2` can never be true inside that branch and NO positional
    // candidate was ever offered (install clients, secrets actions, bundles
    // list/match, completion shells, foundry export).
    expect(s).not.toMatch(/\$tokens\.Count -eq \d+/);
    expect(s).toContain("$argIndex = $tokens.Count - 2");
    expect(s).toContain("if ($wordToComplete -ne '') { $argIndex-- }");
    expect(s).toContain("if ($argIndex -lt 0) {");
    // Slot 0 candidates are emitted under the normalized index.
    expect(s).toContain(
      "if ($argIndex -eq 0) { $completions += @('claude-code', 'claude-desktop', 'cursor', 'vscode') }",
    );
    expect(s).toContain("if ($argIndex -eq 0) { $completions += @('bash', 'zsh', 'fish', 'powershell') }");
    expect(s).toContain("if ($argIndex -eq 0) { $completions += @('list', 'match') }");
    expect(s).toContain("if ($argIndex -eq 0) { $completions += @('export') }");
    expect(s).toContain(
      "if ($argIndex -eq 0) { $completions += @('set', 'get', 'list', 'remove', 'lock', 'rotate', 'audit') }",
    );
  });

  it("resolves the real completion cases (subcommand, slot 0, slot 1, flags)", () => {
    const s = renderScript("powershell");
    const complete = (tokens: string[], word: string) => simulatePowershell(s, tokens, word);

    // Still on the subcommand itself -- with or without a partial word.
    expect(complete(["yaw-mcp"], "")).toContain("install");
    expect(complete(["yaw-mcp", "ins"], "ins")).toEqual(["install"]);

    // `yaw-mcp install <TAB>` and `yaw-mcp install cl<TAB>` both land on slot 0.
    const installEmpty = complete(["yaw-mcp", "install"], "");
    expect(installEmpty).toEqual(expect.arrayContaining([...INSTALL_CLIENTS]));
    // Flags must still be offered alongside the positional candidates.
    expect(installEmpty).toEqual(expect.arrayContaining(["--scope", "--dry-run"]));
    // deprecated flags still work but are no longer suggested
    expect(installEmpty).not.toContain("--token");
    expect(complete(["yaw-mcp", "install", "cl"], "cl")).toEqual(["claude-code", "claude-desktop"]);

    // Slot 1: `yaw-mcp secrets set <TAB>` is past the action list, so only the
    // free-form <name> slot (no candidates) plus flags remain.
    expect(complete(["yaw-mcp", "secrets"], "")).toEqual(expect.arrayContaining(["set", "rotate", "audit"]));
    const secretsSlot1 = complete(["yaw-mcp", "secrets", "set"], "");
    expect(secretsSlot1).not.toContain("set");
    expect(secretsSlot1).toEqual(expect.arrayContaining(["--value", "--stdin"]));

    // A subcommand with no positionals falls straight through to its flags.
    expect(complete(["yaw-mcp", "doctor"], "")).toEqual(["--json", "--help"]);
  });
});

const INSTALL_CLIENTS = ["claude-code", "claude-desktop", "cursor", "vscode"];

/**
 * Minimal interpreter for the exact shape `renderPowershell` emits, so the
 * cases above assert BEHAVIOR (what a user sees on TAB) rather than just the
 * presence of a substring. Mirrors PowerShell semantics for this script:
 * $tokens is CommandElements (a partially typed word is already one of them),
 * a negative normalized index means the subcommand list, otherwise the branch
 * for $tokens[1] contributes its matching slot candidates plus its flags, and
 * the whole set is prefix-filtered by $wordToComplete.
 */
function simulatePowershell(script: string, tokens: string[], wordToComplete: string): string[] {
  const parseList = (list: string): string[] => Array.from(list.matchAll(/'([^']*)'/g), (m) => m[1]);

  const subcommandLine = script.match(/if \(\$argIndex -lt 0\) \{\n\s*\$completions = @\((.*)\)\n/);
  if (!subcommandLine) throw new Error("no normalized subcommand branch in the generated script");

  let argIndex = tokens.length - 2;
  if (wordToComplete !== "") argIndex--;

  let candidates: string[];
  if (argIndex < 0) {
    candidates = parseList(subcommandLine[1]);
  } else {
    const sub = tokens[1];
    const branch = script.match(new RegExp(`\\n    '${sub}' \\{\\n([\\s\\S]*?)\\n    \\}`));
    if (!branch) throw new Error(`no switch branch for "${sub}"`);
    candidates = [];
    for (const line of branch[1].split("\n")) {
      const guarded = line.match(/if \(\$argIndex -eq (\d+)\) \{ \$completions \+= @\((.*)\) \}/);
      if (guarded) {
        if (Number(guarded[1]) === argIndex) candidates.push(...parseList(guarded[2]));
        continue;
      }
      const plain = line.match(/^\s*\$completions \+= @\((.*)\)\s*$/);
      if (plain) candidates.push(...parseList(plain[1]));
    }
  }
  return candidates.filter((c) => c.startsWith(wordToComplete));
}

/**
 * The live argv parser behind each spec entry, so `spec.flags` can be checked
 * against what the CLI really accepts instead of against a hand-copied literal.
 * Same posture as DISPATCHED_SUBCOMMANDS above: the ground truth is imported,
 * not mirrored.
 *
 * The check is behavioral (feed the parser the flag, assert it is not rejected
 * as unknown) rather than a comparison against an exported flag list: the
 * parsers are switch/if chains with no such list to export, and probing them is
 * the same evidence a user gets when they tab a flag and run it.
 */
type ProbeResult = { ok: true } | { ok: false; error: string };
const FLAG_PARSERS: Record<string, (argv: string[]) => ProbeResult> = {
  install: parseInstallArgs,
  add: parseAddArgs,
  remove: parseRemoveArgs,
  list: parseListArgs,
  sidecars: parseSidecarsArgs,
  trust: parseTrustArgs,
  try: parseTryArgs,
  "try-cleanup": parseTryCleanupArgs,
  doctor: parseDoctorArgs,
  bundles: parseBundlesArgs,
  upgrade: parseUpgradeArgs,
  completion: parseCompletionArgs,
  secrets: parseSecretsArgs,
  audit: parseAuditArgs,
  foundry: parseFoundryArgs,
  // Signals help/error with a `kind` discriminant instead of `ok`.
  "reset-learning": (argv) => {
    const r = parseResetLearningArgs(argv);
    return r.kind === "error" ? { ok: false, error: r.error } : { ok: true };
  },
};

// `compliance` has no local parser -- --strict / --min-grade are forwarded
// verbatim to the mcp-compliance child (npxArgs in compliance-cmd.ts), so there
// is nothing in this repo to check them against. `help` carries no flags.
const NO_LOCAL_PARSER = new Set(["compliance", "help"]);

describe("SUBCOMMAND_SPEC coverage", () => {
  it("covers every dispatched subcommand (no drift vs the real KNOWN_SUBCOMMANDS table)", () => {
    // Every non-flag, non-`help` subcommand the dispatcher knows MUST have a
    // SUBCOMMAND_SPEC entry, or the shell completions silently omit it. This
    // compares against the live table imported from src/subcommands.ts, so a
    // new dispatched subcommand without a spec entry fails here.
    const missing = DISPATCHED_SUBCOMMANDS.filter((s) => !SUBCOMMAND_NAMES.includes(s));
    expect(missing).toEqual([]);
  });

  it("does not spec any name that is not dispatched (no stale completion entries)", () => {
    // The only legitimate spec entry without a bare KNOWN_SUBCOMMANDS slot is
    // `help` (it has its own completion candidate but no per-subcommand args).
    const known = new Set<string>(KNOWN_SUBCOMMANDS);
    const stale = SUBCOMMAND_NAMES.filter((s) => s !== "help" && !known.has(s));
    expect(stale).toEqual([]);
  });

  it("does not complete the deprecated `servers` stub, which stays dispatched for Yaw Terminal", () => {
    // Completing a deprecated thing teaches it (the rule that hides --token).
    // The subcommand itself must NOT go: Yaw Terminal shells out to
    // `yaw-mcp servers --json` and derives signedIn:false from its exit code.
    expect(SUBCOMMAND_NAMES).not.toContain("servers");
    expect([...KNOWN_SUBCOMMANDS]).toContain("servers");
  });

  it("specs foundry (previously dispatched but absent from the completion spec)", () => {
    expect(SUBCOMMAND_NAMES).toContain("foundry");
  });

  it("includes the local-server commands that were previously missing", () => {
    for (const sub of ["add", "remove", "list", "try", "try-cleanup", "secrets"]) {
      expect(SUBCOMMAND_NAMES).toContain(sub);
    }
  });

  it("does not advertise the subcommands removed with the Yaw Team surface (45a3462)", () => {
    for (const dead of ["login", "logout", "sync", "stats", "token", "set-active"]) {
      expect(SUBCOMMAND_NAMES).not.toContain(dead);
      expect([...KNOWN_SUBCOMMANDS]).not.toContain(dead);
    }
  });

  it("keeps the secrets entry in sync with parseSecretsArgs (rotate/audit/--force in, push/pull out)", () => {
    const secrets = SUBCOMMAND_SPEC.find((s) => s.name === "secrets");
    expect(secrets).toBeDefined();
    expect(secrets?.positional?.[0]).toEqual(["set", "get", "list", "remove", "lock", "rotate", "audit"]);
    // --force gates the destructive paths (`remove`, and a `set` that
    // overwrites an existing name), so it MUST be completable -- a user who
    // cannot tab it will not discover the only way to script a remove.
    expect(secrets?.flags).toEqual(
      expect.arrayContaining(["--value", "--stdin", "--force", "--secret", "--server", "--json"]),
    );
    // The Yaw Team surface's sync flags stay gone.
    expect(secrets?.flags).not.toContain("--replace");
    expect(secrets?.flags).not.toContain("--push");
  });

  it("offers --help on every subcommand that carries flags", () => {
    // `install` was the lone flag-carrying entry without --help even though
    // parseInstallArgs accepts it (install-cmd.ts returns helpRequested), so
    // `yaw-mcp install --<TAB>` was the only one that hid it.
    const missing = SUBCOMMAND_SPEC.filter((s) => s.flags.length > 0 && !s.flags.includes("--help")).map((s) => s.name);
    expect(missing).toEqual([]);
  });

  it("only advertises flags the real parser accepts", () => {
    // The four "keep them in sync" comments in SUBCOMMAND_SPEC (remove, trust,
    // secrets, compliance) were the ONLY thing holding parser and completion
    // together: subcommand NAMES are drift-guarded against KNOWN_SUBCOMMANDS,
    // but flags were a three-way hand-maintained mirror (parser /
    // SUBCOMMAND_SPEC / test literal). Tabbing a flag the parser rejects exits
    // non-zero with `unknown flag` and a usage dump.
    //
    // SUBSET, not equality: the spec deliberately omits flags that are still
    // accepted but no longer suggested (install's --token and
    // --no-yaw-mcp-config), so a parser flag with no spec entry is fine.
    for (const spec of SUBCOMMAND_SPEC) {
      if (spec.flags.length === 0 || NO_LOCAL_PARSER.has(spec.name)) continue;
      const parse = FLAG_PARSERS[spec.name];
      expect(parse, `no parser wired for "${spec.name}" -- add one or list it in NO_LOCAL_PARSER`).toBeDefined();
      for (const flag of spec.flags) {
        const r = parse([flag]);
        // A value-taking flag ("--scope requires user|project|local") or a
        // missing positional ("Expected exactly one server slug") is fine --
        // both prove the flag itself was recognized. Only "unknown" is a bug.
        const error = r.ok ? "" : r.error;
        expect(error, `\`yaw-mcp ${spec.name} ${flag}\` is completable but its parser rejects the flag`).not.toMatch(
          /unknown (flag|argument|option)/i,
        );
      }
    }
  });

  it("keeps the compliance entry in sync with the flags that drive its exit code", () => {
    // --strict and --min-grade are forwarded verbatim to the mcp-compliance
    // child, and their ONLY effect is turning a failing grade into a non-zero
    // exit -- they are the whole reason to script this subcommand. Completing
    // --help alone meant `yaw-mcp compliance --<TAB>` hid the CI gate.
    const compliance = SUBCOMMAND_SPEC.find((s) => s.name === "compliance");
    expect(compliance).toBeDefined();
    expect(compliance?.flags).toEqual(expect.arrayContaining(["--strict", "--min-grade", "--help"]));
  });

  it("surfaces the compliance flags in every generated script", () => {
    // The spec is only useful if the generators pick it up -- assert through
    // the rendered output, not just the table.
    for (const shell of ["bash", "zsh", "fish", "powershell"] as const) {
      const s = renderScript(shell);
      // fish spells a long flag as `-l min-grade` (leading dashes stripped),
      // so match the flag NAME rather than the dashed form.
      expect(s).toContain("min-grade");
      expect(s).toContain("strict");
    }
  });

  it("keeps the remove entry in sync with parseRemoveArgs (--force / --yes completable)", () => {
    const remove = SUBCOMMAND_SPEC.find((s) => s.name === "remove");
    expect(remove).toBeDefined();
    // `remove` confirms on a TTY and REFUSES off one, so --force is the only
    // way to script it -- a user who cannot tab it will not discover it.
    expect(remove?.flags).toEqual(expect.arrayContaining(["--force", "--yes", "--help"]));
  });
});

describe("runCompletion", () => {
  it("prints the bash script to stdout and exits 0", async () => {
    const io = capture();
    const r = await runCompletion({ shell: "bash", out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(0);
    expect(io.out.join("\n")).toContain("complete -F _yaw-mcp yaw-mcp");
    expect(io.err).toEqual([]);
  });

  // There is no "exits 2 when shell is missing" case any more: `shell` is a
  // REQUIRED option, and parseCompletionArgs rejects an absent shell with exit
  // 2 before index.ts ever dispatches (covered by "rejects missing shell
  // argument" above). The old test could only reach that branch by calling
  // runCompletion in a shape no user input produces.

  it("writes the script byte-for-byte, without appending a second newline", async () => {
    // Every renderScript branch already terminates its last line, so routing
    // the script through a println-style helper appended a second newline and
    // the generated script ended with a blank line. Harmless when eval'd, but
    // `yaw-mcp completion bash >> ~/.bashrc` accumulates one blank line per
    // regeneration and a byte-comparison against a checked-in copy never
    // matches.
    for (const shell of ["bash", "zsh", "fish", "powershell"] as const) {
      const io = capture();
      const r = await runCompletion({ shell, out: io.push, err: io.pushErr });
      const script = renderScript(shell);
      expect(r.exitCode).toBe(0);
      // Precondition: the script really does end in exactly one newline, so
      // the assertion below is about the writer and not about renderScript.
      expect(script.endsWith("\n")).toBe(true);
      expect(script.endsWith("\n\n")).toBe(false);
      expect(io.out.join("")).toBe(script);
      expect(io.out.join("").endsWith("\n\n")).toBe(false);
      // The transcript keeps the un-suffixed script for callers that assert
      // on `lines` rather than on the sink.
      expect(r.lines).toEqual([script]);
    }
  });

  it("writes distinct scripts for each shell", async () => {
    const bash = await runCompletion({ shell: "bash", out: capture().push });
    const zsh = await runCompletion({ shell: "zsh", out: capture().push });
    const fish = await runCompletion({ shell: "fish", out: capture().push });
    const ps = await runCompletion({ shell: "powershell", out: capture().push });
    expect(bash.lines[0]).not.toBe(zsh.lines[0]);
    expect(fish.lines[0]).not.toBe(ps.lines[0]);
  });
});
