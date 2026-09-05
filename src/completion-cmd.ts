// `yaw-mcp completion <shell>` — prints a shell completion script to
// stdout. Every decent CLI has this; surfacing it as a first-class
// subcommand means a user can one-line it into their completions dir
// (the install instructions render right below the script for each
// shell, commented out so they're preserved but don't pollute the
// sourced file).
//
// Supported shells:
//   bash        Writes to ~/.local/share/bash-completion/completions/yaw-mcp
//   zsh         Writes to a path on $fpath (e.g., ~/.zsh/completions/_yaw-mcp)
//   fish        Writes to ~/.config/fish/completions/yaw-mcp.fish
//   powershell  Sourced from $PROFILE
//
// The completion surface is derived from a single SUBCOMMAND_SPEC table
// so that adding a new subcommand or flag updates every shell template
// at once. Static strings would drift on a codebase that's been
// shipping a subcommand a day.

export type CompletionShell = "bash" | "zsh" | "fish" | "powershell";

export interface CompletionCommandOptions {
  /** Required. parseCompletionArgs resolves and validates the shell before
   *  index.ts dispatches, so there is no runtime "missing shell" path left to
   *  guard -- the type is what keeps it that way. */
  shell: CompletionShell;
  out?: (s: string) => void;
  /** Accepted for symmetry with the sibling command options, and never
   *  written to: with `shell` required there is no error this command can
   *  report. Tests pass it to assert exactly that (stdout only, stderr empty). */
  err?: (s: string) => void;
}

export interface CompletionCommandResult {
  exitCode: number;
  lines: string[];
}

export const COMPLETION_USAGE = `Usage: yaw-mcp completion <bash|zsh|fish|powershell>

  Print a shell completion script to stdout. Redirect it to the right
  location for your shell:

    bash        yaw-mcp completion bash       > ~/.local/share/bash-completion/completions/yaw-mcp
    zsh         yaw-mcp completion zsh        > "\${fpath[1]}/_yaw-mcp"    (must be on $fpath)
    fish        yaw-mcp completion fish       > ~/.config/fish/completions/yaw-mcp.fish
    powershell  yaw-mcp completion powershell >> $PROFILE`;

// Central spec for every user-facing subcommand. One source of truth —
// every shell template derives from this so a new subcommand added
// elsewhere shows up in all four completions without hand-edits.
interface SubcommandSpec {
  name: string;
  /** One-line description. Used by the zsh generator (and kept here as the
   *  single source so descriptions can't drift from the spec). zsh `_values`
   *  takes each spec in `_arguments` form minus the leading option name --
   *  `name[description]:message:action` -- so the description is rendered
   *  INSIDE brackets, not after a colon (`name:description` is `_describe`
   *  syntax and `_values` would read the text after ':' as an argument spec).
   *  Keep it free of '[' / ']' (they close the description early) and of
   *  parentheses (they open an action group). */
  description: string;
  /** Positional argument POSITIONS, in order. Each inner array is the set of
   *  one-of-N alternative candidates that complete at that single position
   *  (`install` takes ONE client chosen from four, so all four clients live
   *  together in position 0 -- NOT one candidate per position). An entry like
   *  "<slug>" is a documentation placeholder for a free-form argument;
   *  placeholders are filtered out of the generated scripts but keep their
   *  slot so later positions still line up. */
  positional?: string[][];
  flags: string[];
}

const INSTALL_CLIENTS = ["claude-code", "claude-desktop", "cursor", "vscode"] as const;

// Single source of truth for shell completion across bash/zsh/fish/powershell.
// MUST cover every dispatched subcommand in KNOWN_SUBCOMMANDS (src/subcommands.ts)
// -- the completion test imports that table directly and asserts every non-flag,
// non-`help` dispatched subcommand appears here, so drift fails the build.
export const SUBCOMMAND_SPEC: SubcommandSpec[] = [
  // Setup -- connect a client to yaw-mcp.
  {
    name: "install",
    description: "Connect an MCP client to yaw-mcp",
    positional: [[...INSTALL_CLIENTS]],
    flags: [
      // --token and --no-yaw-mcp-config are still ACCEPTED (they warn and are
      // ignored) but are no longer suggested -- completing a deprecated flag
      // teaches it to new users.
      "--scope",
      "--project-dir",
      "--os",
      "--force",
      "--skip",
      "--dry-run",
      "--list",
      "--all",
      // parseInstallArgs accepts --help/-h (install-cmd.ts returns
      // helpRequested), so it completes here like every other subcommand.
      "--help",
    ],
  },
  // Local servers -- manage ~/.yaw-mcp/bundles.json (no account).
  {
    name: "add",
    description: "Add a catalog server to bundles.json",
    positional: [["<slug>"]],
    flags: ["--env", "--dry-run", "--json", "--catalog", "--help"],
  },
  // --force / --yes gate the destructive removal (confirm on a TTY, refuse off
  // one), so they MUST be completable -- a user who cannot tab --force will not
  // discover the only way to script a remove. Mirrors parseRemoveArgs in
  // src/local-add-cmd.ts -- keep them in sync.
  {
    name: "remove",
    description: "Remove a local server",
    positional: [["<slug-or-namespace>"]],
    flags: ["--force", "--yes", "--help"],
  },
  { name: "list", description: "List the servers yaw-mcp loads locally", flags: ["--json", "--help"] },
  // Positional is the literal subcommand, not a placeholder -- `install` is
  // the only verb, and requiring it keeps room for later ones (list, prune)
  // without a bare `yaw-mcp sidecars` having ever meant something else.
  {
    name: "sidecars",
    description: "Install configured MCP servers into a managed directory",
    positional: [["install"]],
    flags: ["--json", "--help"],
  },
  // Consent gate for a project-local .yaw-mcp/bundles.json. Flags mirror
  // parseTrustArgs in src/trust-cmd.ts -- keep them in sync.
  {
    name: "trust",
    description: "Approve a project-local bundles.json",
    flags: ["--yes", "--list", "--revoke", "--json", "--help"],
  },
  {
    name: "try",
    description: "Wire a one-off trial of a catalog server",
    positional: [["<slug>"]],
    flags: ["--client", "--ttl", "--env", "--dry-run", "--yes", "--help"],
  },
  { name: "try-cleanup", description: "Remove a wired trial", positional: [["<slug>"]], flags: ["--help"] },
  // Inspection.
  { name: "doctor", description: "Print diagnostic of yaw-mcp setup", flags: ["--json", "--help"] },
  // `servers` is deliberately NOT here. It is still dispatched -- Yaw Terminal
  // shells out to `yaw-mcp servers --json` and reads signedIn:false from its
  // always-non-zero exit -- but it is a deprecation stub, and completing a
  // deprecated thing teaches it to new users: the same rule that hides
  // --token above. completion-cmd.test.ts's drift guard carries the matching
  // exemption.
  {
    name: "bundles",
    description: "Browse curated multi-server bundles",
    positional: [["list", "match"]],
    flags: ["--json", "--help"],
  },
  // Maintenance.
  { name: "upgrade", description: "Upgrade @yawlabs/mcp to the latest version", flags: ["--run", "--json", "--help"] },
  { name: "reset-learning", description: "Clear cross-session learning history", flags: ["--help"] },
  {
    name: "completion",
    description: "Print a shell completion script",
    positional: [["bash", "zsh", "fish", "powershell"]],
    flags: ["--help"],
  },
  // Secrets vault (local, encrypted). Actions/flags mirror parseSecretsArgs
  // in src/secrets-cmd.ts -- keep them in sync.
  {
    name: "secrets",
    description: "Manage stored secrets",
    positional: [["set", "get", "list", "remove", "lock", "rotate", "audit"], ["<name>"]],
    flags: ["--value", "--stdin", "--force", "--secret", "--server", "--json", "--help"],
  },
  // Other.
  {
    name: "audit",
    description: "Grade a stdio server against the compliance suite",
    positional: [["<namespace>"]],
    flags: ["--json", "--help"],
  },
  // --strict / --min-grade are forwarded verbatim to the mcp-compliance child
  // (see npxArgs in compliance-cmd.ts) and are what turn a failing grade into a
  // non-zero exit, so they are the flags a CI gate is written around -- they
  // belong in completion even though this command's own parser only inspects
  // --help/--publish.
  {
    name: "compliance",
    description: "Run the compliance suite against a server",
    flags: ["--strict", "--min-grade", "--help"],
  },
  {
    name: "foundry",
    description: "Export the opt-in dispatch-trace corpus",
    positional: [["export"]],
    flags: ["--out", "--cap", "--json", "--help"],
  },
  { name: "help", description: "Show usage", flags: [] },
];

export function parseCompletionArgs(
  argv: string[],
): { ok: true; options: { shell: CompletionShell } } | { ok: false; error: string; help?: boolean } {
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      return { ok: false, error: COMPLETION_USAGE, help: true };
    }
    // Reject unknown flags loudly (same shape as the sibling parsers, e.g.
    // parseSecretsArgs) instead of silently dropping them.
    if (a.startsWith("-")) {
      return { ok: false, error: `yaw-mcp completion: unknown flag "${a}"\n\n${COMPLETION_USAGE}` };
    }
    positional.push(a);
  }
  if (positional.length === 0) {
    return { ok: false, error: `yaw-mcp completion: missing shell argument\n\n${COMPLETION_USAGE}` };
  }
  if (positional.length > 1) {
    return { ok: false, error: `yaw-mcp completion: too many arguments\n\n${COMPLETION_USAGE}` };
  }
  const shell = positional[0];
  if (shell !== "bash" && shell !== "zsh" && shell !== "fish" && shell !== "powershell") {
    return { ok: false, error: `yaw-mcp completion: unknown shell "${shell}"\n\n${COMPLETION_USAGE}` };
  }
  return { ok: true, options: { shell } };
}

export async function runCompletion(opts: CompletionCommandOptions): Promise<CompletionCommandResult> {
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const lines: string[] = [];

  // No missing-shell guard: parseCompletionArgs (above) rejects an absent or
  // unknown shell with exit 2 BEFORE index.ts dispatches, so the branch that
  // used to live here could not fire from any user input -- and the only test
  // that reached it had to call runCompletion directly. `shell` is required by
  // the options type instead, which moves the check to compile time.
  const script = renderScript(opts.shell);
  // Write the script WITHOUT print's trailing newline: every renderScript
  // branch already ends its last line with "\n", so routing it through print
  // appended a second one and every generated script ended with a blank line.
  // Harmless when the script is eval'd, but `completion bash >> ~/.bashrc`
  // accumulates a blank line per regeneration, and a byte-comparison against a
  // checked-in copy never matches. `lines` keeps the un-suffixed script so the
  // transcript callers assert on is unchanged.
  lines.push(script);
  write(script);
  return { exitCode: 0, lines };
}

export function renderScript(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return renderBash();
    case "zsh":
      return renderZsh();
    case "fish":
      return renderFish();
    case "powershell":
      return renderPowershell();
  }
}

/** True when a positional value is a documentation placeholder, not a real
 *  completion candidate. Placeholders look like "<slug>" or "<name>". */
function isPlaceholder(s: string): boolean {
  return s.startsWith("<") && s.endsWith(">");
}

/** Completable candidates per positional slot. Filters placeholders out of
 *  each slot's alternatives and drops slots left empty (free-form args),
 *  while preserving each slot's ORIGINAL index so the generators' position
 *  math (cword / token count / zsh slot number) stays aligned with the
 *  argument the user is actually typing. */
function realPositionals(spec: SubcommandSpec): Array<{ candidates: string[]; index: number }> {
  return (spec.positional ?? [])
    .map((alternatives, index) => ({ candidates: alternatives.filter((a) => !isPlaceholder(a)), index }))
    .filter(({ candidates }) => candidates.length > 0);
}

function renderBash(): string {
  const subcommandList = SUBCOMMAND_SPEC.map((s) => s.name).join(" ");
  const topLevelFlags = "--help -h --version -V";
  const cases = SUBCOMMAND_SPEC.map((spec) => {
    // Emit one if-block per positional SLOT, offering every alternative for
    // that slot in a single compgen word list (so `install <TAB>` shows all
    // four clients at once). The slot's original index computes the cword
    // position (cword == slotIndex + 2 because COMP_WORDS[0] is "yaw-mcp",
    // COMP_WORDS[1] is the subcommand).
    //
    // The `$cur != -*` guard is load-bearing: each clause ends in an
    // unconditional `return 0`, so without it a flag typed AT the slot
    // (`install --<TAB>`) matched the positional clause, compgen'd against
    // the positional word list, and returned an empty COMPREPLY -- zero
    // candidates, and (`complete -F` without `-o default`) no fallback.
    // `install --list` / `--all` forbid a client argument, so slot 0 is the
    // ONLY position those flags can occupy; fish and powershell both offer
    // flags there. A dash word now falls through to the flag compgen below.
    const posClauses = realPositionals(spec).map(
      ({ candidates, index }) =>
        `    if [[ $cword -eq $((${index} + 2)) && $cur != -* ]]; then\n      COMPREPLY=( $(compgen -W "${candidates.join(" ")}" -- "$cur") )\n      return 0\n    fi`,
    );
    // No `.filter(p => p !== "")` here: every posClause is a non-empty
    // multi-line if-block and the two tail lines are literals, so the filter
    // could never drop an element.
    const parts = [
      ...posClauses,
      `    COMPREPLY=( $(compgen -W "${spec.flags.join(" ")}" -- "$cur") )`,
      "    return 0",
    ];
    return `  ${spec.name})\n${parts.join("\n")}\n    ;;`;
  }).join("\n");

  return `# bash completion for yaw-mcp — generated by \`yaw-mcp completion bash\`
# Install: save this to ~/.local/share/bash-completion/completions/yaw-mcp
#          or source it from your .bashrc.
_yaw-mcp() {
  local cur cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cword=$COMP_CWORD

  if [[ $cword -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${subcommandList} ${topLevelFlags}" -- "$cur") )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
${cases}
  esac
}
complete -F _yaw-mcp yaw-mcp
`;
}

function renderZsh(): string {
  // Descriptions come straight from the spec (single source of truth), so a
  // newly-added subcommand can never render with a blank zsh description.
  //
  // Two things this line has to get right, both of which were wrong before:
  //   1. `name[description]`, NOT `name:description`. `_values` takes each
  //      spec in `_arguments` form without the leading option name, so the
  //      description belongs in brackets; with a ':' zsh reads the text after
  //      it as an argument spec and the subcommand renders with no
  //      description at all. (`name:description` is `_describe` syntax.)
  //   2. Join with " \\\n" -- every spec line but the last must end in a
  //      line-continuation. Joining on a bare newline continued only the
  //      FIRST spec onto the `_values` call; the other 18 were emitted as
  //      standalone commands, so a user got `install` as the only candidate
  //      plus 18 `command not found: add:...` errors on the first TAB.
  const subcommandList = SUBCOMMAND_SPEC.map((s) => `    '${s.name}[${s.description}]'`).join(" \\\n");

  const argsCases = SUBCOMMAND_SPEC.map((spec) => {
    const lines = [`      ${spec.name})`];
    // Emit one _arguments entry per positional SLOT with every alternative
    // for that slot in its candidate group, using the slot's original index
    // for the zsh slot number (slot == slotIndex + 1 because zsh _arguments
    // slot numbering is 1-based and slot 1 is already claimed by the
    // subcommand dispatch in the outer _arguments call).
    const posArgs = realPositionals(spec).map(({ candidates, index }) => `'${index + 1}: :(${candidates.join(" ")})'`);
    // Flags are real zsh OPTION specs, not a `'*: :(...)'` rest group. The rest
    // group is only consulted once the numbered slots are used up, so at the
    // FIRST argument slot -- the only position `install --list` / `--all` can
    // occupy -- `yaw-mcp install --<TAB>` offered nothing at all. As option
    // specs zsh offers them at every position, which is what bash's `$cur != -*`
    // fallthrough already does. A bare name is a valid spec (no description
    // needed), and `(...)`-free so nothing here can open an action group.
    const flagArgs = spec.flags.map((f) => `'${f}'`);
    const argSpecs = [...posArgs, ...flagArgs];
    // `help` carries neither, and `_arguments` with no spec at all is a usage
    // error -- keep the inert rest group for that case only.
    lines.push(`        _arguments ${argSpecs.length > 0 ? argSpecs.join(" ") : "'*: :()'"}`);
    lines.push("        ;;");
    return lines.join("\n");
  }).join("\n");

  return `#compdef yaw-mcp
# zsh completion for yaw-mcp — generated by \`yaw-mcp completion zsh\`
# Install: save this to a file on your $fpath named _yaw-mcp
#          (e.g., ~/.zsh/completions/_yaw-mcp), then rebuild completions:
#            autoload -U compinit && compinit
_yaw-mcp() {
  local context state line
  _arguments -C \\
    '1: :->cmd' \\
    '*::arg:->args'

  case $state in
    cmd)
      _values 'yaw-mcp subcommand' \\
${subcommandList}
      ;;
    args)
      case $line[1] in
${argsCases}
      esac
      ;;
  esac
}
_yaw-mcp "$@"
`;
}

function renderFish(): string {
  // One helper, emitted once, resolves the ACTIVE subcommand. The flag lines
  // below (and, one release later, the positional lines) used to be guarded
  // by `__fish_seen_subcommand_from <name>`, which
  // matches a token ANYWHERE on the line -- so `yaw-mcp sidecars install
  // --<TAB>` saw the `install` token (a positional VALUE of `sidecars`) and
  // offered install's flags, none of which `sidecars` accepts. The helper takes
  // the FIRST token that is one of yaw-mcp's own subcommands, so `sidecars`
  // wins there. It scans rather than indexing a fixed position because a
  // wrapper invocation (`command yaw-mcp ...`, `env FOO=1 yaw-mcp ...`) shifts
  // the subcommand off any hardcoded slot, and it reads `commandline -opc`
  // ONCE per call instead of once per guard.
  const header = `# fish completion for yaw-mcp — generated by \`yaw-mcp completion fish\`
# Install: save this to ~/.config/fish/completions/yaw-mcp.fish
function __yaw_mcp_using_subcommand
  set -l tokens (commandline -opc)
  set -l known ${SUBCOMMAND_SPEC.map((s) => s.name).join(" ")}
  for tok in $tokens
    if contains -- $tok $known
      if test "$tok" = "$argv[1]"
        return 0
      end
      return 1
    end
  end
  return 1
end
complete -c yaw-mcp -f`;

  const subcommandLines = SUBCOMMAND_SPEC.map((spec) => {
    return `complete -c yaw-mcp -n __fish_use_subcommand -a ${spec.name}`;
  });

  const positionalLines: string[] = [];
  const flagLines: string[] = [];
  for (const spec of SUBCOMMAND_SPEC) {
    // One `complete` line per positional SLOT, offering every alternative for
    // that slot in a single space-separated -a list (fish splits it into
    // individual candidates). The slot's original index keeps the position
    // guard's argument count right: `count (commandline -opc)` returns the
    // number of tokens before the cursor (including "yaw-mcp" and the
    // subcommand), so the expected count for slotIndex N is N + 2.
    for (const { candidates, index } of realPositionals(spec)) {
      const expectedCount = index + 2;
      // Same active-subcommand helper the flag lines use (see the header
      // above): `__fish_seen_subcommand_from` matches its argument ANYWHERE
      // on the line, so with a positional VALUE that is also a subcommand
      // name (`sidecars install`, `secrets list`) the token count alone
      // decided whose candidates fish offered.
      positionalLines.push(
        `complete -c yaw-mcp -n "__yaw_mcp_using_subcommand ${spec.name}; and test (count (commandline -opc)) -eq ${expectedCount}" -a "${candidates.join(" ")}"`,
      );
    }
    for (const f of spec.flags) {
      // `-l` takes a LONG option name (no dashes). Only emit for `--` flags;
      // a single-dash flag (e.g. `-V`) would produce invalid `-l -V` syntax.
      if (!f.startsWith("--")) continue;
      const long = f.slice(2);
      flagLines.push(`complete -c yaw-mcp -n "__yaw_mcp_using_subcommand ${spec.name}" -l ${long}`);
    }
  }

  return [header, "", ...subcommandLines, "", ...positionalLines, "", ...flagLines, ""].join("\n");
}

function renderPowershell(): string {
  const subcommandNames = SUBCOMMAND_SPEC.map((s) => `'${s.name}'`).join(", ");
  const caseBranches = SUBCOMMAND_SPEC.map((spec) => {
    const flags = spec.flags.map((f) => `'${f}'`).join(", ");
    // Emit one guarded block per positional SLOT, adding every alternative
    // for that slot to the candidate array. The guard compares the slot's
    // index against $argIndex -- the NORMALIZED index of the argument being
    // completed, where 0 is the first argument after the subcommand.
    //
    // It must NOT compare a raw $tokens.Count: this switch only runs once the
    // user is past the subcommand, so a `Count -eq 2` test for slot 0 is dead
    // code and no positional candidate would ever be offered. A raw count is
    // also ambiguous, because a partially typed word is already part of
    // $tokens ("install <TAB>" and "install cl<TAB>" are both slot 0 but have
    // different counts); $argIndex normalizes that away below.
    const positionalLines = realPositionals(spec)
      .map(
        ({ candidates, index }) =>
          `      if ($argIndex -eq ${index}) { $completions += @(${candidates.map((c) => `'${c}'`).join(", ")}) }`,
      )
      .join("\n");
    const positionalBlock = positionalLines ? `${positionalLines}\n` : "";
    return `    '${spec.name}' {
${positionalBlock}      $completions += @(${flags})
    }`;
  }).join("\n");

  return `# PowerShell completion for yaw-mcp — generated by \`yaw-mcp completion powershell\`
# Install: append this script to your profile ($PROFILE) and reload.
Register-ArgumentCompleter -CommandName yaw-mcp -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  $completions = @()
  # $argIndex is the normalized index of the positional being completed: 0 is
  # the first argument AFTER the subcommand. $tokens[0] is "yaw-mcp" and
  # $tokens[1] is the subcommand, hence -2. A partially typed word is already
  # one of $tokens, so back off one more when $wordToComplete is non-empty --
  # that keeps "install <TAB>" and "install cl<TAB>" both on slot 0. Negative
  # means the user is still on the subcommand itself.
  $argIndex = $tokens.Count - 2
  if ($wordToComplete -ne '') { $argIndex-- }
  if ($argIndex -lt 0) {
    $completions = @(${subcommandNames}, '--help', '-h', '--version', '-V')
  } else {
    switch ($tokens[1]) {
${caseBranches}
    }
  }
  $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}
