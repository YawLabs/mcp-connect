// `mcph completion <shell>` — prints a shell completion script to
// stdout. Every decent CLI has this; surfacing it as a first-class
// subcommand means a user can one-line it into their completions dir
// (the install instructions render right below the script for each
// shell, commented out so they're preserved but don't pollute the
// sourced file).
//
// Supported shells:
//   bash        Writes to ~/.local/share/bash-completion/completions/mcph
//   zsh         Writes to a path on $fpath (e.g., ~/.zsh/completions/_mcph)
//   fish        Writes to ~/.config/fish/completions/mcph.fish
//   powershell  Sourced from $PROFILE
//
// The completion surface is derived from a single SUBCOMMAND_SPEC table
// so that adding a new subcommand or flag updates every shell template
// at once. Static strings would drift on a codebase that's been
// shipping a subcommand a day.

export type CompletionShell = "bash" | "zsh" | "fish" | "powershell";

export interface CompletionCommandOptions {
  shell?: CompletionShell;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export interface CompletionCommandResult {
  exitCode: number;
  lines: string[];
}

export const COMPLETION_USAGE = `Usage: mcph completion <bash|zsh|fish|powershell>

  Print a shell completion script to stdout. Redirect it to the right
  location for your shell:

    bash        mcph completion bash       > ~/.local/share/bash-completion/completions/mcph
    zsh         mcph completion zsh        > "\${fpath[1]}/_mcph"    (must be on $fpath)
    fish        mcph completion fish       > ~/.config/fish/completions/mcph.fish
    powershell  mcph completion powershell >> $PROFILE`;

// Central spec for every user-facing subcommand. One source of truth —
// every shell template derives from this so a new subcommand added
// elsewhere shows up in all four completions without hand-edits.
interface SubcommandSpec {
  name: string;
  positional?: string[];
  flags: string[];
}

const INSTALL_CLIENTS = ["claude-code", "claude-desktop", "cursor", "vscode"] as const;

const SUBCOMMAND_SPEC: SubcommandSpec[] = [
  {
    name: "install",
    positional: [...INSTALL_CLIENTS],
    flags: [
      "--scope",
      "--token",
      "--project-dir",
      "--os",
      "--force",
      "--skip",
      "--dry-run",
      "--no-mcph-config",
      "--list",
      "--all",
    ],
  },
  { name: "doctor", flags: ["--json", "--help"] },
  { name: "servers", flags: ["--json", "--help"] },
  { name: "bundles", positional: ["list", "match"], flags: ["--json", "--help"] },
  { name: "compliance", flags: ["--publish", "--help"] },
  { name: "reset-learning", flags: ["--help"] },
  { name: "completion", positional: ["bash", "zsh", "fish", "powershell"], flags: ["--help"] },
  { name: "help", flags: [] },
];

export function parseCompletionArgs(
  argv: string[],
): { ok: true; options: { shell: CompletionShell } } | { ok: false; error: string } {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { ok: false, error: COMPLETION_USAGE };
  }
  const positional = argv.filter((a) => !a.startsWith("-"));
  if (positional.length === 0) {
    return { ok: false, error: `mcph completion: missing shell argument\n\n${COMPLETION_USAGE}` };
  }
  if (positional.length > 1) {
    return { ok: false, error: `mcph completion: too many arguments\n\n${COMPLETION_USAGE}` };
  }
  const shell = positional[0];
  if (shell !== "bash" && shell !== "zsh" && shell !== "fish" && shell !== "powershell") {
    return { ok: false, error: `mcph completion: unknown shell "${shell}"\n\n${COMPLETION_USAGE}` };
  }
  return { ok: true, options: { shell } };
}

export async function runCompletion(opts: CompletionCommandOptions = {}): Promise<CompletionCommandResult> {
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  const lines: string[] = [];
  const print = (s: string): void => {
    lines.push(s);
    write(`${s}\n`);
  };

  if (!opts.shell) {
    writeErr(`mcph completion: missing shell argument\n${COMPLETION_USAGE}\n`);
    return { exitCode: 2, lines };
  }

  const script = renderScript(opts.shell);
  print(script);
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

function renderBash(): string {
  const subcommandList = SUBCOMMAND_SPEC.map((s) => s.name).join(" ");
  const topLevelFlags = "--help -h --version -V";
  const cases = SUBCOMMAND_SPEC.map((spec) => {
    const posClause = spec.positional
      ? `    if [[ $cword -eq 2 ]]; then
      COMPREPLY=( $(compgen -W "${spec.positional.join(" ")} ${spec.flags.join(" ")}" -- "$cur") )
      return 0
    fi`
      : "";
    return `  ${spec.name})
${posClause}
    COMPREPLY=( $(compgen -W "${spec.flags.join(" ")}" -- "$cur") )
    return 0
    ;;`;
  }).join("\n");

  return `# bash completion for mcph — generated by \`mcph completion bash\`
# Install: save this to ~/.local/share/bash-completion/completions/mcph
#          or source it from your .bashrc.
_mcph() {
  local cur prev words cword
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
complete -F _mcph mcph
`;
}

function renderZsh(): string {
  const subcommandDescriptions: Record<string, string> = {
    install: "Auto-edit an MCP client's config",
    doctor: "Print diagnostic of mcph setup",
    servers: "List servers in your mcp.hosting dashboard",
    bundles: "Browse curated multi-server bundles",
    compliance: "Run the compliance suite against a server",
    "reset-learning": "Clear cross-session learning history",
    completion: "Print a shell completion script",
    help: "Show usage",
  };
  const subcommandList = SUBCOMMAND_SPEC.map((s) => `    '${s.name}:${subcommandDescriptions[s.name] ?? ""}'`).join(
    "\n",
  );

  const argsCases = SUBCOMMAND_SPEC.map((spec) => {
    const lines = [`      ${spec.name})`];
    if (spec.positional) {
      lines.push(`        _arguments '1: :(${spec.positional.join(" ")})' '*: :(${spec.flags.join(" ")})'`);
    } else {
      lines.push(`        _arguments '*: :(${spec.flags.join(" ")})'`);
    }
    lines.push("        ;;");
    return lines.join("\n");
  }).join("\n");

  return `#compdef mcph
# zsh completion for mcph — generated by \`mcph completion zsh\`
# Install: save this to a file on your $fpath named _mcph
#          (e.g., ~/.zsh/completions/_mcph), then rebuild completions:
#            autoload -U compinit && compinit
_mcph() {
  local context state line
  _arguments -C \\
    '1: :->cmd' \\
    '*::arg:->args'

  case $state in
    cmd)
      _values 'mcph subcommand' \\
${subcommandList}
      ;;
    args)
      case $line[1] in
${argsCases}
      esac
      ;;
  esac
}
_mcph "$@"
`;
}

function renderFish(): string {
  const header = `# fish completion for mcph — generated by \`mcph completion fish\`
# Install: save this to ~/.config/fish/completions/mcph.fish
complete -c mcph -f`;

  const subcommandLines = SUBCOMMAND_SPEC.map((spec) => {
    return `complete -c mcph -n __fish_use_subcommand -a ${spec.name}`;
  });

  const positionalLines: string[] = [];
  const flagLines: string[] = [];
  for (const spec of SUBCOMMAND_SPEC) {
    if (spec.positional) {
      for (const p of spec.positional) {
        positionalLines.push(`complete -c mcph -n "__fish_seen_subcommand_from ${spec.name}" -a ${p}`);
      }
    }
    for (const f of spec.flags) {
      const long = f.replace(/^--/, "");
      flagLines.push(`complete -c mcph -n "__fish_seen_subcommand_from ${spec.name}" -l ${long}`);
    }
  }

  return [header, "", ...subcommandLines, "", ...positionalLines, "", ...flagLines, ""].join("\n");
}

function renderPowershell(): string {
  const subcommandNames = SUBCOMMAND_SPEC.map((s) => `'${s.name}'`).join(", ");
  const caseBranches = SUBCOMMAND_SPEC.map((spec) => {
    const positional = spec.positional ? spec.positional.map((p) => `'${p}'`).join(", ") : "";
    const flags = spec.flags.map((f) => `'${f}'`).join(", ");
    const positionalLine = positional ? `      $completions += @(${positional})\n` : "";
    return `    '${spec.name}' {
${positionalLine}      $completions += @(${flags})
    }`;
  }).join("\n");

  return `# PowerShell completion for mcph — generated by \`mcph completion powershell\`
# Install: append this script to your profile ($PROFILE) and reload.
Register-ArgumentCompleter -CommandName mcph -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = $commandAst.CommandElements | ForEach-Object { $_.ToString() }
  $completions = @()
  if ($tokens.Count -le 2) {
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
