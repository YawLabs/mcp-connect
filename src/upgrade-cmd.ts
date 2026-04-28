// `mcph upgrade` — tells the user (or the shell) how to install the
// newest version of `@yawlabs/mcph`. Detects the invocation mode from
// process.argv[1] so the suggested command matches how mcph is
// actually reaching this process:
//   - global npm (`npm install -g @yawlabs/mcph`)  → `npm install -g @yawlabs/mcph@latest`
//   - npx cache                                     → restart the MCP client; `npx -y` always pulls the latest
//   - unknown / dev checkout                        → print both and let the user decide
//
// The --run flag spawns the command for the "global npm" case; for
// "npx" there is nothing to do and --run just prints the "restart
// your client" hint. Never spawns destructive commands — only
// `npm install -g <exactly-our-package>@latest` is allowed, and
// stdout/stderr stream through to the caller unchanged.
//
// Exit codes:
//   0  already on the latest version, OR the suggested action is "restart the client"
//   1  upgrade available but --run was not passed (human-interactive mode)
//   2  usage error (unknown flag)
//   3  --run attempted the upgrade and the child process failed
//
// `mcph doctor` shows the same staleness status — upgrade is purely
// the "what do I type to fix it" surface. Kept separate so scripts
// that already run doctor can chain into `mcph upgrade --run` and
// have the shell do the right thing deterministically.

import { spawn } from "node:child_process";

declare const __VERSION__: string;

export interface UpgradeCommandOptions {
  /** When true, actually spawn the upgrade command (only for global-npm mode). */
  run?: boolean;
  /** Emit a machine-readable JSON snapshot instead of prose. */
  json?: boolean;
  /** Test hook: replace the npm registry fetch. */
  fetchLatest?: () => Promise<string | null>;
  /** Test hook: override the argv path detection. */
  argvPath?: string;
  /** Test hook: override the current version. */
  currentVersion?: string;
  /** Test hook: override stdout. */
  out?: (s: string) => void;
  /** Test hook: override stderr. */
  err?: (s: string) => void;
  /** Test hook: override the spawn invocation (returns exit code). */
  spawnImpl?: (cmd: string, args: string[]) => Promise<number>;
}

export interface UpgradeCommandResult {
  exitCode: number;
  lines: string[];
}

export type InstallMethod = "global-npm" | "npx" | "local-node-modules" | "dev-checkout" | "unknown";

export interface UpgradePlan {
  current: string;
  latest: string | null;
  stale: boolean;
  method: InstallMethod;
  /** Command to run to move to the latest version. Null when method=npx (nothing to do). */
  command: string | null;
}

export const UPGRADE_USAGE = `Usage: mcph upgrade [--run] [--json]

  Show (or execute) the command to upgrade @yawlabs/mcph to the latest version.

  --run     If this install is global (npm install -g), spawn the upgrade
            command. No-op for npx installs — they always fetch the latest.
  --json    Emit a machine-readable snapshot ({ current, latest, stale,
            method, command }) instead of prose.`;

export function parseUpgradeArgs(
  argv: string[],
): { ok: true; options: UpgradeCommandOptions } | { ok: false; error: string } {
  const opts: UpgradeCommandOptions = {};
  for (const a of argv) {
    if (a === "--run") opts.run = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") return { ok: false, error: UPGRADE_USAGE };
    else return { ok: false, error: `mcph upgrade: unknown argument "${a}"\n\n${UPGRADE_USAGE}` };
  }
  return { ok: true, options: opts };
}

/** Classify how mcph is being invoked. The argv[1] path is the most
 *  reliable signal — npm/npx land it in distinct directories. Falls
 *  through to `unknown` rather than guessing, which lets --json
 *  consumers branch without false positives.  */
export function detectInstallMethod(argvPath: string | undefined): InstallMethod {
  if (!argvPath) return "unknown";
  const normalized = argvPath.replace(/\\/g, "/");
  // `npx -y @yawlabs/mcph` stages packages under ~/.npm/_npx/ (or
  // platform equivalent with a hash dir). On Windows the cache is
  // under npm-cache/_npx/... — same marker works.
  if (/\/_npx\//.test(normalized)) return "npx";
  // npm i -g writes to the global prefix. Can be detected by
  // "npm/node_modules/@yawlabs/mcph" or "/usr/local/lib/node_modules"
  // style paths, or the npm global prefix (varies). Most dependable
  // signal: the path lives under a `node_modules` that is NOT inside
  // the current project's node_modules. Since we can't reliably tell
  // global vs local from argv alone, use the npm prefix marker on
  // common platforms and a `\\npm\\node_modules\\` Windows marker.
  if (/\/npm\/node_modules\/@yawlabs\/mcph\//.test(normalized)) return "global-npm";
  if (/\/lib\/node_modules\/@yawlabs\/mcph\//.test(normalized)) return "global-npm";
  if (/\/AppData\/Roaming\/npm\/node_modules\/@yawlabs\/mcph\//.test(normalized)) return "global-npm";
  if (/\/node_modules\/@yawlabs\/mcph\//.test(normalized)) return "local-node-modules";
  // `npm run dev` or direct `node ./dist/index.js` from a checkout —
  // not installed at all.
  if (/\/mcph\/(dist|src)\//.test(normalized)) return "dev-checkout";
  return "unknown";
}

/** Assemble the upgrade plan from method + version info. Single source
 *  of truth for both the prose and --json paths. */
export function buildUpgradePlan(input: {
  current: string;
  latest: string | null;
  method: InstallMethod;
}): UpgradePlan {
  const { current, latest, method } = input;
  const stale = latest !== null && current !== "dev" && compareSemverLocal(current, latest) < 0;

  let command: string | null;
  switch (method) {
    case "global-npm":
      command = "npm install -g @yawlabs/mcph@latest";
      break;
    case "npx":
      command = null; // npx -y refreshes on its own; nothing to run.
      break;
    case "local-node-modules":
      command = "npm install @yawlabs/mcph@latest";
      break;
    case "dev-checkout":
      command = "git pull && npm run build";
      break;
    default:
      command = "npm install -g @yawlabs/mcph@latest";
      break;
  }
  return { current, latest, stale, method, command };
}

/** Copy of compareSemver kept local so upgrade-cmd doesn't drag
 *  doctor-cmd into its import graph (keeps the CLI startup fast). */
function compareSemverLocal(a: string, b: string): number {
  const parse = (s: string): [number, number, number] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(s);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

async function defaultFetchLatest(): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3000);
  try {
    const res = await fetch("https://registry.npmjs.org/@yawlabs/mcph/latest", {
      signal: ac.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultSpawn(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("close", (code) => resolve(typeof code === "number" ? code : 1));
    child.on("error", () => resolve(1));
  });
}

export async function runUpgrade(opts: UpgradeCommandOptions = {}): Promise<UpgradeCommandResult> {
  const write = opts.out ?? ((s: string) => process.stdout.write(s));
  const writeErr = opts.err ?? ((s: string) => process.stderr.write(s));
  const lines: string[] = [];
  const print = (s = ""): void => {
    lines.push(s);
    write(`${s}\n`);
  };
  const printErr = (s: string): void => {
    lines.push(s);
    writeErr(`${s}\n`);
  };

  const fetcher = opts.fetchLatest ?? defaultFetchLatest;
  const current = opts.currentVersion ?? readCurrentVersion();
  const argvPath = opts.argvPath ?? process.argv[1];
  const method = detectInstallMethod(argvPath);

  let latest: string | null;
  try {
    latest = await fetcher();
  } catch {
    latest = null;
  }

  const plan = buildUpgradePlan({ current, latest, method });

  if (opts.json) {
    print(JSON.stringify(plan, null, 2));
    return { exitCode: plan.stale && !opts.run ? 1 : 0, lines };
  }

  // Offline or registry unreachable — still useful to print the method +
  // suggested command so the user can run it when they're back online.
  if (latest === null) {
    print("mcph upgrade: couldn't reach the npm registry (offline? firewall?).");
    if (plan.command) {
      print(`When you're back online, run:\n  ${plan.command}`);
    } else {
      print("Your install uses `npx -y` — just restart the MCP client when you're back online.");
    }
    return { exitCode: 0, lines };
  }

  print(`Current: ${current}`);
  print(`Latest:  ${latest}`);
  print(`Install: ${method}`);

  if (!plan.stale) {
    print("");
    print("✓ You're on the latest version — nothing to do.");
    return { exitCode: 0, lines };
  }

  print("");
  if (method === "npx") {
    print("Your install uses `npx -y` — restart the MCP client and it will fetch the new version.");
    return { exitCode: 0, lines };
  }

  if (!plan.command) {
    print("No upgrade command available for this install method.");
    return { exitCode: 0, lines };
  }

  // Only `global-npm` is auto-runnable -- the others need the user to
  // pick the right tool (pnpm vs npm, the right repo to git pull, etc.)
  // so the prompt is honest about whether `--run` will work.
  const autoRunnable = method === "global-npm";

  if (!opts.run) {
    if (autoRunnable) {
      print(`Run:\n  ${plan.command}\n\nOr re-run with --run to upgrade in place.`);
    } else {
      print(`Suggested command (run it yourself; --run only works for global-npm installs):\n  ${plan.command}`);
    }
    return { exitCode: 1, lines };
  }

  // --run: attempt the upgrade. Only whitelisted commands — never
  // pass arbitrary user input into a shell.
  if (!autoRunnable) {
    printErr(
      `mcph upgrade --run: install method "${method}" can't be upgraded automatically. Run manually:\n  ${plan.command}`,
    );
    return { exitCode: 2, lines };
  }

  const runner = opts.spawnImpl ?? defaultSpawn;
  print(`Running: ${plan.command}`);
  const code = await runner("npm", ["install", "-g", "@yawlabs/mcph@latest"]);
  if (code === 0) {
    print("");
    print(`✓ Upgraded @yawlabs/mcph to ${latest}.`);
    return { exitCode: 0, lines };
  }
  printErr(`mcph upgrade: npm exited ${code}. Try running the command manually.`);
  return { exitCode: 3, lines };
}

/** Read the version tsup inlines at build time; falls back to "dev"
 *  for unbuilt runs. tsup substitutes the bare `__VERSION__`
 *  identifier; a property access (e.g. `globalThis.__VERSION__`)
 *  isn't replaced, which left the shipped bundle reporting "dev". */
function readCurrentVersion(): string {
  return typeof __VERSION__ !== "undefined" ? __VERSION__ : "dev";
}
