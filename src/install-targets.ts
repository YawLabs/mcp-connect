// Per-client, per-OS config file metadata for `yaw-mcp install <client>`.
// This is the authoritative mapping of {client, scope, OS} → file path +
// JSON shape. (A pre-rename dashboard install mirror has been archived; this
// file is now the sole source of truth.) The tests in install-targets.test.ts lock the
// specifics (file names, JSON root keys) that would silently break the
// install flow if regressed.
//
// Bugs we've discovered in the wild and encode as invariants here:
//   • Claude Code reads MCP servers from `~/.claude.json` (top-level
//     `mcpServers` for user scope; nested under `projects[<absDir>].
//     mcpServers` for local scope). The `mcpServers` key in
//     `~/.claude/settings.json` is silently ignored — settings.json holds
//     hooks/model/permissions only. (We discovered this the hard way in
//     v0.11.0–0.11.1: install wrote to settings.json, /mcp showed nothing.)
//   • Claude Code honors the `CLAUDE_CONFIG_DIR` env var: when set, BOTH
//     `.claude.json` AND `settings.json` move to that dir (`<DIR>/.claude.json`,
//     `<DIR>/settings.json`), not `<HOME>/.claude.json` and
//     `<HOME>/.claude/settings.json`. Wrappers like Yaw Mode use this to
//     overlay a per-session config. If install ignores it, the entry lands
//     in `~/.claude.json` while Claude Code reads from the wrapper dir —
//     and `claude mcp list` shows nothing. We accept `claudeConfigDir`
//     here so install/doctor/list-probe all see the same file Claude does.
//   • VS Code uses `servers` (not `mcpServers`) as the top-level key in
//     `.vscode/mcp.json`. Pasting a Claude Code shape fails silently.
//   • Claude Desktop has no Linux build, so install on Linux for that
//     client must refuse with a clear message rather than writing a
//     file the app will never read.
//   • On Windows, `npx` is a `.cmd` shim; MCP clients that spawn it
//     directly get ENOENT. The launch entry must be
//     `{ command: "cmd", args: ["/c", "npx", "-y", "@yawlabs/mcp@latest"] }`.
//     (`@latest` is what buildLaunchEntry actually writes -- see the `pkg`
//     default there; the unpinned spelling here read as a second, wrong shape.)

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type InstallOS = "macos" | "linux" | "windows";
export type InstallClientId = "claude-code" | "claude-desktop" | "cursor" | "vscode";
export type InstallScope = "user" | "project" | "local";
export type JsonShape = "mcpServers" | "servers";

export interface ResolvedPath {
  /** Absolute path to the config file (with ~ / env vars expanded). */
  absolute: string;
  /** Human-friendly display path with ~ / env-var form preserved. */
  display: string;
  /** JSON key path to the mcpServers/servers container that holds the
   *  ENTRY_NAME entry. Almost always `[jsonShape]`, but Claude Code's
   *  local scope nests under `["projects", <absProjectDir>, "mcpServers"]`
   *  inside `~/.claude.json`. install-cmd + doctor walk this array to
   *  read/merge the entry while preserving every sibling at every level. */
  containerPath: string[];
}

export interface InstallScopeSpec {
  scope: InstallScope;
  /** Short label for help output. */
  label: string;
  /** Why you'd choose this scope. */
  description: string;
  /** Whether project folder is needed to resolve the path. */
  requiresProjectDir: boolean;
}

export interface InstallTarget {
  clientId: InstallClientId;
  label: string;
  jsonShape: JsonShape;
  /** Scopes this client supports. Empty = client unavailable. */
  scopes: InstallScopeSpec[];
  /** OSes the client ships on. Install on other OSes refuses. */
  availableOn: InstallOS[];
  /** Extra user-facing caveats (e.g., "restart the app after editing"). */
  notes?: string;
}

export const CURRENT_OS: InstallOS =
  process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

export const INSTALL_TARGETS: InstallTarget[] = [
  {
    clientId: "claude-code",
    label: "Claude Code",
    jsonShape: "mcpServers",
    availableOn: ["macos", "linux", "windows"],
    scopes: [
      {
        scope: "user",
        label: "User (global)",
        description: "Private to this machine; applies to every project.",
        requiresProjectDir: false,
      },
      {
        scope: "project",
        label: "Project",
        description: "Commit to share with your team.",
        requiresProjectDir: true,
      },
      {
        scope: "local",
        label: "Local",
        description: "Per-project override; typically gitignored.",
        requiresProjectDir: true,
      },
    ],
  },
  {
    clientId: "claude-desktop",
    label: "Claude Desktop",
    jsonShape: "mcpServers",
    availableOn: ["macos", "windows"],
    // ASCII `--`, not an em-dash: install prints this verbatim (`Note: ...`),
    // and Claude Desktop is a Windows client -- on a console whose codepage is
    // not UTF-8 the em-dash rendered as mojibake in the line the user reads.
    notes: "Claude Desktop reads one file per OS -- no project scope. Restart the app after editing.",
    scopes: [
      {
        scope: "user",
        label: "User",
        description: "The only config file Claude Desktop reads.",
        requiresProjectDir: false,
      },
    ],
  },
  {
    clientId: "cursor",
    label: "Cursor",
    jsonShape: "mcpServers",
    availableOn: ["macos", "linux", "windows"],
    scopes: [
      {
        scope: "user",
        label: "User (global)",
        description: "Private to this machine; applies to every Cursor project.",
        requiresProjectDir: false,
      },
      {
        scope: "project",
        label: "Project",
        description: "Commit to share with your team.",
        requiresProjectDir: true,
      },
    ],
  },
  {
    clientId: "vscode",
    label: "VS Code",
    jsonShape: "servers",
    availableOn: ["macos", "linux", "windows"],
    notes: "VS Code uses `servers` (not `mcpServers`) as the top-level key in .vscode/mcp.json.",
    scopes: [
      {
        scope: "project",
        label: "Workspace",
        description: "Per-project config; commit to share.",
        requiresProjectDir: true,
      },
    ],
  },
];

export interface ResolvePathOptions {
  clientId: InstallClientId;
  scope: InstallScope;
  os: InstallOS;
  projectDir?: string;
  /** Override for tests; defaults to os.homedir(). */
  home?: string;
  /** Windows `%APPDATA%`. Defaults to `<home>/AppData/Roaming` -- the resolver
   *  never reads `process.env.APPDATA` itself, so a caller on a box where
   *  %APPDATA% is redirected must pass it (see `resolveAppDataDir` below, the
   *  one helper that reads the env, shared by install's write path, `--list`,
   *  `doctor` and `try` so none of them can disagree).
   *
   *  An EMPTY string counts as unset and takes the same `<home>/AppData/Roaming`
   *  default: an empty-but-set %APPDATA% is ordinary on Windows and in CI, and
   *  passing it through made every claude-desktop path RELATIVE
   *  (`Claude\claude_desktop_config.json`), which doctor then stat-ed and printed
   *  against the process cwd. */
  appData?: string;
  /** Claude Code's `CLAUDE_CONFIG_DIR`. When set (truthy), claude-code
   *  user/local scope writes to `<dir>/.claude.json` instead of
   *  `<home>/.claude.json`, matching Claude Code's actual read path.
   *  The resolver never reads this one from the environment on its own:
   *  callers (install-cmd, doctor-cmd, index.ts) read
   *  `process.env.CLAUDE_CONFIG_DIR` and pass it in. Same for `appData` above
   *  -- this function reads NO environment at all. */
  claudeConfigDir?: string;
}

/** The one place that decides where %APPDATA% lives for a caller.
 *
 *  `resolveInstallPath` is deliberately pure, which makes picking this the
 *  CALLER's job -- and every caller has to pick it the SAME way or read and
 *  write disagree. They did: `doctor` and `try` each derived it from `home`
 *  alone, so on a box with %APPDATA% redirected away from
 *  `<home>\AppData\Roaming` they reported the home-derived path while install
 *  wrote the real one. An explicit `appData` wins; an overridden `home` keeps a
 *  hermetic run inside that home; otherwise the ambient %APPDATA% is
 *  authoritative, because that is the directory Claude Desktop itself reads.
 *
 *  EMPTY counts as UNSET at both env-shaped steps -- matching `cacheDir()` in
 *  paths.ts and the `claudeConfigDir` guards below. A nullish-only check let an
 *  empty-but-set %APPDATA% (ordinary on Windows and in CI) return "", which
 *  `resolveInstallPath` passed straight through, resolving claude-desktop to the
 *  RELATIVE `Claude\claude_desktop_config.json` -- a file doctor stat-ed and
 *  printed against the process cwd. `home` is deliberately NOT guarded that way:
 *  falling an empty `home` through to the ambient %APPDATA% would point a run
 *  that asked for a synthetic home at the developer's REAL config file. */
export function resolveAppDataDir(opts: { appData?: string; home?: string; env?: NodeJS.ProcessEnv }): string {
  if (opts.appData !== undefined && opts.appData.length > 0) return opts.appData;
  if (opts.home !== undefined) return join(opts.home, "AppData", "Roaming");
  const env = opts.env ?? process.env;
  const fromEnv = env.APPDATA;
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), "AppData", "Roaming");
}

export function resolveInstallPath(opts: ResolvePathOptions): ResolvedPath {
  const home = opts.home ?? homedir();
  // PURE: this resolver reads NO environment, and `appData` defaults off `home`
  // alone. It used to consult process.env.APPDATA whenever the caller passed no
  // `home`, which split READ from WRITE: every reader resolves a home first
  // (probeClientsAsync requires `home: string`; doctor, `install --list` and
  // `try` all pass homedir()) and so got `<home>/AppData/Roaming`, while the
  // writer (runInstall) passes `home: undefined` and got the ambient %APPDATA%.
  // On a box where %APPDATA% is redirected away from `<home>\AppData\Roaming`,
  // install wrote the claude_desktop_config.json Claude Desktop actually reads
  // while doctor and --list reported a different path. Choosing %APPDATA% is a
  // CALLER's job -- see `resolveAppDataDir` below, the single helper that reads
  // the env, used by install's write path, `--list`, `doctor` and `try` alike
  // so they cannot disagree. Keeping the env out of here is also what keeps a hermetic run
  // hermetic: claude-desktop is the one client living under %APPDATA%, so a
  // test that overrode `home` but not `appData` would otherwise resolve to (and
  // install would have written) the DEVELOPER's own config file.
  //
  // Empty counts as unset here too (see the `appData` doc above): a caller who
  // threaded through an empty-but-set %APPDATA% otherwise got a RELATIVE
  // claude-desktop path. Still no env read on this branch -- the fallback is the
  // resolved `home`, which is what keeps a hermetic run hermetic.
  const appData = opts.appData && opts.appData.length > 0 ? opts.appData : join(home, "AppData", "Roaming");
  const { clientId, scope, os, projectDir, claudeConfigDir } = opts;
  const target = INSTALL_TARGETS.find((t) => t.clientId === clientId);
  if (!target) throw new Error(`Unknown client: ${clientId}`);
  const scopeSpec = target.scopes.find((s) => s.scope === scope);
  if (!scopeSpec) throw new Error(`Client ${clientId} does not support scope ${scope}`);
  if (!target.availableOn.includes(os)) {
    throw new Error(`${target.label} is not available on ${os}`);
  }
  if (scopeSpec.requiresProjectDir && !projectDir) {
    throw new Error(`Scope ${scope} for ${clientId} requires a project directory`);
  }

  // Claude Code keys local-scope MCP entries by the ABSOLUTE project dir
  // (projects[<absDir>].mcpServers in ~/.claude.json). A relative
  // projectDir would produce a key that disagrees with what Claude Code
  // writes, so install/doctor/list could each compute a different key
  // and miss the entry. Resolve to absolute here -- the single place all
  // three callers funnel through -- so the key is stable regardless of
  // whether the caller pre-resolved. Already-absolute paths (the common
  // case: callers pass process.cwd() or path.resolve(...)) pass through
  // unchanged, including POSIX-rooted test fixtures on a Windows runner
  // (isAbsolute('/x') is true on win32).
  const absoluteProjectDir = projectDir && !isAbsolute(projectDir) ? resolve(projectDir) : projectDir;

  const p = pathFor(clientId, scope, os, {
    home,
    appData,
    projectDir: absoluteProjectDir ?? "",
    claudeConfigDir: claudeConfigDir && claudeConfigDir.length > 0 ? claudeConfigDir : undefined,
  });
  return p;
}

/** The `projects[...]` key Claude Code uses for `projectDir` in ~/.claude.json.
 *
 *  Claude Code writes those keys with FORWARD slashes on every OS — a Windows
 *  checkout appears as "C:/Users/me/repo", never "C:\\Users\\me\\repo" (every
 *  project key in a real Windows ~/.claude.json uses `/`). `resolve(cwd)` on
 *  win32 hands us the backslash spelling, and writing it verbatim creates a
 *  NEW sibling key Claude Code never reads: install prints Done, doctor and
 *  --list confirm "installed" (they compute the same wrong key), and /mcp
 *  shows nothing. Normalize the KEY only — the config-file path itself stays
 *  platform-native.
 *
 *  Scoped to Windows-shaped paths (drive letter or UNC) so a POSIX directory
 *  whose name legitimately contains a backslash is not mangled.
 *
 *  Exported for tests: the Windows-shape branch is unreachable through
 *  resolveInstallPath on a POSIX runner (isAbsolute("C:\\...") is false
 *  there, so resolve() rewrites the fixture first). */
export function claudeCodeProjectKey(projectDir: string): string {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(projectDir) ? projectDir.replace(/\\/g, "/") : projectDir;
}

function pathFor(
  client: InstallClientId,
  scope: InstallScope,
  os: InstallOS,
  base: { home: string; appData: string; projectDir: string; claudeConfigDir: string | undefined },
): ResolvedPath {
  const { home, appData, projectDir, claudeConfigDir } = base;
  const sep = os === "windows" ? "\\" : "/";
  const joinPath = (...parts: string[]): string => parts.join(sep);

  if (client === "claude-code") {
    if (scope === "user") {
      // Claude Code reads user-scope MCP from ~/.claude.json (top-level
      // mcpServers). The settings.json mcpServers field is silently ignored.
      // CLAUDE_CONFIG_DIR (if set) relocates this to <DIR>/.claude.json.
      if (claudeConfigDir) {
        const absolute = join(claudeConfigDir, ".claude.json");
        return { absolute, display: absolute, containerPath: ["mcpServers"] };
      }
      const display = os === "windows" ? "%USERPROFILE%\\.claude.json" : "~/.claude.json";
      return { absolute: join(home, ".claude.json"), display, containerPath: ["mcpServers"] };
    }
    if (scope === "project") {
      return {
        absolute: join(projectDir, ".mcp.json"),
        display: joinPath("<project folder>", ".mcp.json"),
        containerPath: ["mcpServers"],
      };
    }
    // local — Claude Code stores per-project local-scope MCP under
    // ~/.claude.json projects[<absolute project dir>].mcpServers. The
    // .claude/settings.local.json file is for permissions/hooks, not MCP.
    // Same CLAUDE_CONFIG_DIR redirect applies.
    const projectKey = claudeCodeProjectKey(projectDir);
    if (claudeConfigDir) {
      const absolute = join(claudeConfigDir, ".claude.json");
      return { absolute, display: absolute, containerPath: ["projects", projectKey, "mcpServers"] };
    }
    return {
      absolute: join(home, ".claude.json"),
      display: os === "windows" ? "%USERPROFILE%\\.claude.json" : "~/.claude.json",
      containerPath: ["projects", projectKey, "mcpServers"],
    };
  }

  if (client === "claude-desktop") {
    if (os === "macos") {
      return {
        absolute: join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        display: "~/Library/Application Support/Claude/claude_desktop_config.json",
        containerPath: ["mcpServers"],
      };
    }
    if (os === "windows") {
      return {
        absolute: join(appData, "Claude", "claude_desktop_config.json"),
        display: "%APPDATA%\\Claude\\claude_desktop_config.json",
        containerPath: ["mcpServers"],
      };
    }
    // linux — unreachable because availableOn guards this, but belt+suspenders.
    throw new Error("Claude Desktop is not available on Linux");
  }

  if (client === "cursor") {
    if (scope === "user") {
      const display = os === "windows" ? "%USERPROFILE%\\.cursor\\mcp.json" : "~/.cursor/mcp.json";
      return { absolute: join(home, ".cursor", "mcp.json"), display, containerPath: ["mcpServers"] };
    }
    // project
    return {
      absolute: join(projectDir, ".cursor", "mcp.json"),
      display: joinPath("<project folder>", ".cursor", "mcp.json"),
      containerPath: ["mcpServers"],
    };
  }

  if (client === "vscode") {
    // VS Code only supports workspace/project scope today.
    return {
      absolute: join(projectDir, ".vscode", "mcp.json"),
      display: joinPath("<project folder>", ".vscode", "mcp.json"),
      containerPath: ["servers"],
    };
  }

  throw new Error(`Unhandled client: ${client as string}`);
}

export interface BuildLaunchEntryOptions {
  os: InstallOS;
  /** Optional override for the `args` binary (defaults to
   *  @yawlabs/mcp@latest -- the `@latest` tag makes `npx` re-resolve
   *  the newest version on every spawn, so a client restart is all it
   *  takes to pick up a new release).
   *
   *  RESERVED SEAM WITH NO LIVE CALLER. Nothing in src/ passes `pkg`:
   *  install-cmd sends {os, oamBinPath, oamEntry}, try-cmd sends {os, upstream},
   *  and `parseInstallArgs` has no `--pkg` flag -- the `@latest` default is what
   *  every caller wants. So the precedence rule documented under `oamBinPath`
   *  (a `pkg` pin beats the oam path) is reached only from
   *  install-targets.test.ts, and combinations of `pkg` with the rest of the
   *  install flow -- notably install-cmd's `previousEnv` carry-over -- have no
   *  coverage at all. Anyone wiring a `--pkg` flag should write those tests
   *  first rather than assume the documented interactions are exercised. */
  pkg?: string;
  /** Optional upstream-shape override: when set, the entry is built for
   *  an arbitrary upstream MCP server (used by `yaw-mcp try` to wire a
   *  one-off trial entry pointing directly at the upstream's launcher,
   *  bypassing yaw-mcp). When `os === "windows"`, the upstream command +
   *  args are wrapped with `cmd /c` to dodge the same `.cmd` shim trap
   *  that bit the default yaw-mcp launcher — keep this path going through
   *  buildLaunchEntry so the wrapping logic stays in one place.
   *  Mutually exclusive with `pkg` (which tunes the default yaw-mcp
   *  entry; with `upstream` it is ignored). */
  upstream?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  /** Host the broker ITSELF on oam rather than node. Both must be set, and
   *  both are resolved by the caller: `oamBinPath` from the version-gated
   *  probe's `binPath`, `oamEntry` from resolveStableNpmEntry (durable installs
   *  only -- never the npx cache, which a config file must not point at).
   *  Either being null keeps the npx entry.
   *
   *  `binPath`, NOT the probe's `bin`. The two differ for the same reason
   *  resolveNpmEntry and resolveStableNpmEntry do: `bin` is what THIS process
   *  can spawn (`OAM_BIN` or a bare `oam`, already resolved against the shell
   *  PATH by having run it), while this value gets PERSISTED into a config file
   *  some other process reads. oam installs to `$HOME/.oam/bin` and only nudges
   *  the shell profile, so a GUI-launched client (Claude Desktop, Cursor from
   *  Finder/Explorer) inherits no such PATH -- a bare `oam` there is an ENOENT
   *  with no fallback, and doctor cannot even see it (it flags a missing command
   *  only when isAbsolute(command)). A non-absolute value is therefore IGNORED
   *  here, not just filtered by the caller, so the invariant is enforced at the
   *  boundary instead of by convention.
   *
   *  Ignored when `pkg` is set: `oamEntry` is resolved by the caller for a
   *  specific package, so honouring a `pkg` override here would emit an entry
   *  pinned in name only, pointing at whatever version happens to be on disk.
   *
   *  Scope of the safety claim: taking this path is an upgrade AT WRITE TIME.
   *  It cannot replace a launcher that works right now -- but the entry is
   *  baked, never re-resolved, and the client spawns `oam run --no-check <path>`
   *  verbatim, so none of the sidecar protections apply later (no
   *  MIN_OAM_VERSION gate, no ENOENT-to-npx retry, no boot-failure downgrade).
   *  A subsequent `npm rm -g @yawlabs/mcp` or oam uninstall breaks every client,
   *  and doctor reports a clean bill of health because it never checks the entry
   *  path in `args`.
   *
   *  Note this is a DIFFERENT axis from `runtime: "oam"` in bundles.json:
   *  that hosts the sidecars the broker spawns, this hosts the broker. */
  oamBinPath?: string | null;
  oamEntry?: string | null;
}

/** The MCP client `mcpServers["mcp"]` entry — what `install` writes. The key
 *  is ENTRY_NAME (`mcp`); `yaw-mcp` is a LEGACY_ENTRY_NAME nothing writes any
 *  more, so naming it here sent readers looking for the wrong key. */
export interface LaunchEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** cmd.exe metacharacters that split or redirect an UNQUOTED command line:
 *  `&` (chain), `|` (pipe), `<` `>` (redirect), `^` (escape), `(` `)`
 *  (grouping). `%` is deliberately absent -- cmd expands %VAR% BEFORE caret
 *  processing, so a caret cannot neutralize it, and mangling every literal
 *  `%` to dodge an expansion that only fires when the variable EXISTS is the
 *  worse trade (a bare `%NAME%` for an unset var is left literal by cmd, the
 *  common case; verified on Windows). */
const CMD_METACHARS = /[&|<>^()]/g;
const HAS_CMD_METACHAR = /[&|<>^()]/;

/** Node launcher names that ship as `.cmd`/`.bat` SHIMS on Windows (npx.cmd,
 *  npm.cmd, yarn.cmd, ...). A shim forwards its args through `%*`, which
 *  cmd.exe RE-PARSES a second time -- so an arg bound for a shim must survive
 *  TWO cmd parses, not one (see escapeCmdArg for the caret depth).
 *
 *  npm's own installers are what put these here: every `node_modules/.bin`
 *  entry and every global npm bin gets a generated `.cmd` wrapper on Windows. */
const KNOWN_CMD_SHIM_LAUNCHERS = new Set(["npx", "npm", "pnpm", "yarn", "bunx"]);

/** Real executables cmd.exe launches DIRECTLY -- one cmd parse, no `%*`
 *  re-parse. Listed so the common direct launchers get single-level
 *  (full-fidelity) escaping instead of the fail-safe shim depth.
 *
 *  `uv`, `uvx` and `pipx` sit here, NOT in the shim set above, even though they
 *  are Python-ecosystem launchers: uv ships `uv.exe` and `uvx.exe` as native
 *  binaries (yaw-mcp's own bootstrap installs exactly that `uv.exe` -- see
 *  uv-bootstrap.ts), and pipx installs `pipx.exe`. Calling them shims cost an
 *  arg a caret level it never spends: a no-space metachar arg was triple-caret
 *  escaped and reached uvx.exe as the corrupted `^&` instead of `&`, after ONE
 *  cmd parse. Bare `uv` (a `uv run <srv>` upstream) was missing from this set
 *  after uvx had been cured of that, so it fell through to the fail-safe shim
 *  depth and uv.exe got the same corrupted arg. The residual risk is a user
 *  who hand-rolls their own `uvx.cmd` on PATH -- that arg is under-escaped --
 *  but an explicit `uvx.cmd` spelling in the config is still caught by the
 *  extension test in isCmdShimLauncher. */
const KNOWN_DIRECT_BINARIES = new Set([
  "node",
  "deno",
  "bun",
  "python",
  "python3",
  "py",
  "uv",
  "uvx",
  "pipx",
  "ruby",
  "php",
  "docker",
  "dotnet",
  "java",
  "go",
]);

/** Is `command` a `.cmd`/`.bat` shim whose `%*` forwarding makes cmd.exe parse
 *  the forwarded args a SECOND time?  npx/npm/yarn are; node/uvx/docker are not.
 *
 *  This sets the caret depth in escapeCmdArg: an arg reaching a shim must
 *  survive two cmd parses (triple-caret), an arg reaching a real exe only one
 *  (single-caret). An UNKNOWN bare name fails SAFE to "shim" -- cmd can resolve
 *  it to a `.cmd` via PATHEXT, and over-escaping a real exe merely corrupts a
 *  hostile metachar arg, whereas under-escaping a shim is a command injection.
 *  Exported for tests. */
export function isCmdShimLauncher(command: string): boolean {
  const base = command.replace(/^.*[\\/]/, "").toLowerCase();
  if (/\.(?:cmd|bat)$/.test(base)) return true;
  if (/\.(?:exe|com)$/.test(base)) return false;
  const stem = base.replace(/\.[^.]*$/, "");
  if (KNOWN_CMD_SHIM_LAUNCHERS.has(stem)) return true;
  if (KNOWN_DIRECT_BINARIES.has(stem)) return false;
  return true;
}

/** Escape one argv element for the Windows `cmd /c` wrap in buildLaunchEntry.
 *
 *  The wrapped entry is spawned by the MCP CLIENT, whose runtime (Node/libuv on
 *  every client we target) quote-WRAPS an argv element only when it contains a
 *  space, tab, or double quote; everything else reaches cmd.exe verbatim -- and
 *  a bare `&` ends the command and runs the tail as a second one. Catalog args
 *  arrive tokenized from upstream install commands, so a plain query-string arg
 *  (`--url https://api/x?a=1&b=2`) silently truncates, and a hostile catalog
 *  entry is a command injection at client-spawn time behind an innocuous config
 *  file. Every case below was derived EMPIRICALLY on a native Windows box by
 *  spawning `cmd /c <target> <arg>` -- through both a `%*`-forwarding `.cmd`
 *  shim and a real exe -- and asserting the argv the child actually received.
 *
 *  Four shapes:
 *
 *    1. Contains a double-quote AND a cmd metacharacter -> REFUSE (throw).
 *       A literal quote forces libuv to quote-WRAP the element and escape the
 *       inner quote as `\"`. cmd.exe's parser counts quotes and does NOT honour
 *       that backslash, so `\"` prematurely CLOSES libuv's quote and flips quote
 *       parity for the rest of the element -- exposing any metacharacter there
 *       as a live splitter (reproduced: `a"&echo X` runs `echo X`). No caret
 *       depth fixes it because parity through libuv's wrapping is unpredictable,
 *       so we refuse the shape loudly rather than emit an exploitable entry.
 *
 *    2. Contains a double-quote but NO metacharacter -> verbatim. libuv wraps +
 *       escapes it and cmd, with nothing to act on, passes it through intact
 *       (`{"a":1}` round-trips). A caret here would land inside libuv's quotes
 *       as a literal and corrupt the value. Keeps legitimate JSON args working.
 *
 *    3. Contains a space/tab (no quote) -> verbatim. libuv quote-wraps it, and
 *       inside those quotes cmd treats metacharacters literally on EVERY parse
 *       (the wrap survives a shim's `%*` re-parse). A caret would corrupt it.
 *
 *    4. No quote, no space/tab -> caret-escape the metacharacters, since libuv
 *       passes the element verbatim and cmd sees them bare. Depth follows how
 *       many times cmd parses the element: a real exe is reached after ONE cmd
 *       parse (single caret, `^&` -> `&`); a `.cmd`/`.bat` shim forwards via
 *       `%*` which cmd RE-PARSES, so the element crosses TWO parses and needs a
 *       caret that survives both (`^^^&` -> `^&` -> `&`). The single-caret form
 *       that shipped before was a no-op against the shim: cmd stripped the one
 *       caret on the outer parse and the bare `&` split inside the shim. */
export function escapeCmdArg(arg: string, opts: { shim: boolean }): string {
  if (arg.includes('"')) {
    if (HAS_CMD_METACHAR.test(arg)) {
      throw new Error(
        `Cannot safely encode an argument that contains BOTH a double-quote and a ` +
          `cmd.exe metacharacter (& | < > ^ ( )) for the Windows cmd /c launcher: ${arg} -- ` +
          `passing it through cmd.exe risks a command injection at client-spawn time. ` +
          `Rework the server's args to drop one of the two.`,
      );
    }
    return arg;
  }
  if (/[ \t]/.test(arg)) return arg;
  const caret = opts.shim ? "^^^" : "^";
  return arg.replace(CMD_METACHARS, (m) => caret + m);
}

export function buildLaunchEntry(opts: BuildLaunchEntryOptions): LaunchEntry {
  if (opts.upstream) {
    // Upstream-shape entry (yaw-mcp try): preserve the upstream command +
    // args verbatim, but wrap on Windows so a `.cmd` shim launcher
    // (npx.cmd, npm.cmd, yarn.cmd) doesn't ENOENT when the client
    // spawns it directly.
    const { command, args, env } = opts.upstream;
    if (opts.os === "windows") {
      // A whitespace-bearing COMMAND cannot survive this wrap at all, so refuse
      // it here rather than persist an entry that dies at client-spawn time.
      // escapeCmdArg leaves such a token verbatim (shape 3) because libuv
      // quote-WRAPS it -- correct for an arg, wrong for the command, because
      // `cmd /c` has a rule of its own: when the line has more than one quoted
      // token, cmd strips the FIRST and LAST quote of the whole line. The
      // command's opening quote is the one that goes, so `"C:\Program Files\x\
      // srv.cmd" "--flag=a b"` is executed as `C:\Program` and the client
      // reports `'C:\Program' is not recognized`. No caret depth reaches it (the
      // quotes are libuv's, added after we return), which is why this is a
      // refusal and not an escape -- same trade as escapeCmdArg's shape 1.
      if (/[ \t]/.test(command)) {
        throw new Error(
          `Cannot safely encode a launcher command that contains whitespace for the Windows cmd /c ` +
            `launcher: ${command} -- cmd.exe strips the outer quotes when the line carries another ` +
            `quoted token, so the client's spawn fails with "'...' is not recognized". Point the ` +
            `server at a whitespace-free launcher (a bare npx/uvx resolved on PATH, or a short path).`,
        );
      }
      // Caret-escape cmd.exe metacharacters (see escapeCmdArg): without it,
      // any upstream token carrying an unquoted `&` / `|` / `<` / `>` splits
      // the `cmd /c` line when the CLIENT spawns the entry, running the tail
      // as a second command. The COMMAND token is parsed by cmd ONCE -- it is
      // resolved and launched, never forwarded through a shim's `%*` -- so it
      // escapes at the single-parse depth. The ARG tokens, when `command` is a
      // `.cmd`/`.bat` shim (npx/npm/yarn), cross a SECOND cmd parse via that
      // shim's `%*`, so they escape at the deeper shim depth. escapeCmdArg
      // throws on a genuinely unsafe shape (quote + metachar); that rejection
      // propagates to the caller's dispatch and surfaces as a clean error.
      const shim = isCmdShimLauncher(command);
      const wrapped: LaunchEntry = {
        command: "cmd",
        args: ["/c", escapeCmdArg(command, { shim: false }), ...args.map((a) => escapeCmdArg(a, { shim }))],
      };
      if (env && Object.keys(env).length > 0) wrapped.env = { ...env };
      return wrapped;
    }
    const entry: LaunchEntry = { command, args: [...args] };
    if (env && Object.keys(env).length > 0) entry.env = { ...env };
    return entry;
  }
  const pkg = opts.pkg ?? "@yawlabs/mcp@latest";
  // Host the broker on oam when the caller resolved both halves. No `cmd /c`
  // wrap on Windows: that exists because `npx` is a `.cmd` shim the client
  // cannot spawn directly, and oam is a real executable. `--no-check` keeps
  // the TypeScript checker off a long-lived stdio server.
  //
  // `opts.pkg` disables this path. `pkg` exists to pin a spec ("@yawlabs/
  // mcp@0.73.0"), and npx honours that on every spawn -- but oamEntry is a
  // resolved path the caller looked up for its OWN package, so combining them
  // would emit an entry that names one version and runs whatever is on disk.
  // Silently ignoring a pin is worse than not taking the oam path.
  //
  // isAbsolute is a hard gate, not an assertion about the caller: a bare `oam`
  // written into a client config resolves against the CLIENT's PATH, which a
  // GUI-launched app does not inherit from the shell that installed oam. Bare
  // names stay on npx -- see oamBinPath above.
  if (opts.oamBinPath && isAbsolute(opts.oamBinPath) && opts.oamEntry && !opts.pkg) {
    return { command: opts.oamBinPath, args: ["run", "--no-check", opts.oamEntry] };
  }
  // No `env` on the default entry: yaw-mcp is local-only, so there is no
  // token to inject. Servers come from ~/.yaw-mcp/bundles.json.
  return opts.os === "windows"
    ? { command: "cmd", args: ["/c", "npx", "-y", pkg] }
    : { command: "npx", args: ["-y", pkg] };
}

/**
 * Does `entryPath` live in the node_modules of the tree `cwd` sits in?
 *
 * resolveStableNpmEntry calls any non-`_npx` node_modules hit "durable", which
 * includes a project's own `node_modules` -- and install persists that path into
 * a MACHINE-GLOBAL config (~/.claude.json, claude_desktop_config.json). A
 * project tree is much less durable than a global one: `rm -rf node_modules`,
 * `npm prune`, or renaming the checkout invalidates it, and the "npm update -g
 * rewrites that path in place" reasoning that justifies persisting a resolved
 * path at all only covers the global case. So the write is allowed but the user
 * is told, which needs this predicate to distinguish the two shapes.
 *
 * The test is "is cwd inside the tree that owns this node_modules", not a
 * global-prefix pattern match: prefix layouts differ per installer (nvm, fnm,
 * volta, homebrew, %APPDATA%\npm) and a missed layout would warn on a perfectly
 * good global install. It is also precisely the reachable case -- the entry is
 * resolved from the RUNNING broker's own module URL, so a project hit means
 * yaw-mcp was launched from that project's node_modules, which is where the
 * user is.
 *
 * Pure string work on both separators, and case-insensitive: Windows paths
 * compare case-insensitively (including drive-letter case, which differs
 * between `process.cwd()` and a resolved module path), and a POSIX tree whose
 * only difference is case would at worst earn one extra note.
 */
export function isProjectLocalEntry(entryPath: string, cwd: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const entry = norm(entryPath);
  const here = norm(cwd);
  // OUTERMOST node_modules, so a transitively-nested copy is still attributed
  // to the tree the user owns and would delete. Anchoring on the innermost one
  // instead would put the root under node_modules, where cwd never sits.
  const idx = entry.indexOf("/node_modules/");
  if (idx <= 0) return false;
  const root = entry.slice(0, idx);
  // Only this direction. The mirror test ("is the tree inside cwd") looks
  // tempting but misfires on every global install whose prefix happens to live
  // under HOME -- ~/.nvm/versions/node/<v>/lib/node_modules is inside cwd for
  // anyone running install from their home directory.
  return here === root || here.startsWith(`${root}/`);
}

/** The entry key we write into `mcpServers` (Claude Code / Desktop / Cursor)
 *  or `servers` (VS Code). Stable across clients so doctor can detect
 *  collisions deterministically. */
export const ENTRY_NAME = "mcp";

/** Entry keys earlier installers wrote under: the dead `mcp.hosting` / `mcph`
 *  brand and the interim `yaw-mcp` key. Doctor + install detect these so users
 *  upgrading get a visible nudge instead of silently running two parallel
 *  servers from the same client config. Nothing writes these keys anymore. */
export const LEGACY_ENTRY_NAMES = ["mcp.hosting", "mcph", "yaw-mcp"] as const;

/** The legacy entry key present in `container`, or null -- lets the upgrade
 *  nudge name the actual stale key it found. */
export function findLegacyEntry(container: Record<string, unknown>): string | null {
  return LEGACY_ENTRY_NAMES.find((n) => n in container) ?? null;
}

/** Pattern added to Claude Code's `permissions.allow` on install so the
 *  user isn't re-prompted for each yaw-mcp MCP tool call. Only matters for
 *  Claude Code (Claude Desktop / Cursor / VS Code have their own models).
 *  Keep in sync with the tool-name prefix our proxy exposes -- Claude Code
 *  derives the prefix from ENTRY_NAME by replacing non-alphanumeric chars
 *  with underscores, so "mcp" becomes "mcp__mcp__". */
export const CLAUDE_CODE_ALLOW_PATTERN = "mcp__mcp__*";

/** Resolve the Claude Code settings.json file that holds `permissions.allow`.
 *  Different from the mcpServers path (`~/.claude.json`): permissions live
 *  in `settings.json`, not the user config. Returns null for clients that
 *  don't use this scheme.
 *
 *  When `claudeConfigDir` is set, user-scope `settings.json` lives at
 *  `<DIR>/settings.json` (NOT `<DIR>/.claude/settings.json` — the `.claude`
 *  segment is absorbed by the env redirect). Project/local scopes are
 *  project-relative and unaffected.
 *
 *  No `os` parameter, unlike pathFor (which spells a `display` string for the
 *  TARGET os): every path here is built with `node:path.join` against the
 *  runner's own platform -- the only thing a caller writing the file could
 *  use. A dead `os` option used to ride along for the sake of old call sites;
 *  it was dropped once the last one stopped passing it. */
export function resolveClaudeCodeSettingsPath(
  scope: InstallScope,
  opts: { home: string; projectDir?: string; claudeConfigDir?: string },
): string | null {
  const { home, projectDir, claudeConfigDir } = opts;
  const cfgDir = claudeConfigDir && claudeConfigDir.length > 0 ? claudeConfigDir : null;
  if (scope === "user") return cfgDir ? join(cfgDir, "settings.json") : join(home, ".claude", "settings.json");
  if (scope === "project" && projectDir) return join(projectDir, ".claude", "settings.json");
  if (scope === "local" && projectDir) return join(projectDir, ".claude", "settings.local.json");
  return null;
}
