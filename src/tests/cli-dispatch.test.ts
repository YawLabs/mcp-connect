// The CLI dispatcher (src/index.ts) -- the one module nothing else in this
// suite reaches.
//
// index.ts reads process.argv and dispatches at MODULE SCOPE, so it cannot be
// imported and called; the only way to exercise it is to run it the way a user
// does. That gap mattered when the 13 open-coded parse tails were factored
// into run(): the entire point of that change was that a usage body must
// survive a slow pipe, and nothing in the suite could have caught a regression
// that sent help to stderr, or let an argv error exit 0, or stranded the
// process on a pending handle once process.exit() stopped being called.
//
// Runs against dist/, matching `test:ci` (build && test). Builds once when
// dist is absent so a bare `npm test` on a fresh clone still works.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "dist", "index.js");

/** Newest mtime among the BUNDLED sources (tests are not bundled). Building
 *  only when dist/ is absent would let an edited index.ts run against a stale
 *  build -- a green that proves nothing, which is worse here than no test,
 *  since this file is the only coverage the dispatcher has. */
function newestSourceMtime(): number {
  const srcDir = join(repoRoot, "src");
  let newest = 0;
  for (const entry of readdirSync(srcDir, { recursive: true })) {
    const rel = String(entry);
    if (!rel.endsWith(".ts") || rel.includes("tests")) continue;
    const stat = statSync(join(srcDir, rel));
    if (stat.isFile() && stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest;
}

/** Throwaway HOME for every child spawned by runCli. See the beforeAll. */
let workDir: string;

beforeAll(() => {
  // The child must not read the developer's own MCP stack. HOME, USERPROFILE
  // and CLAUDE_CONFIG_DIR all point here, and it is also the child's cwd, so
  // the walk-up in config-loader.ts cannot reach this repo's project-local
  // `.yaw-mcp/` either. The sibling index-dispatch.test.ts learned this the
  // expensive way: with an un-isolated HOME its child loaded the real
  // bundles.json, PRE-WARMED the servers in it, and blew the timeout about
  // one run in four for a reason nothing in that file mentioned.
  workDir = mkdtempSync(join(tmpdir(), "yaw-mcp-cli-"));
  if (existsSync(cli) && statSync(cli).mtimeMs >= newestSourceMtime()) return;
  // npm on Windows is a .cmd shim, and Node refuses to exec one without a
  // shell since the CVE-2024-27980 fix -- same concession sidecars-cmd makes
  // for the same reason. Every argument here is a fixed literal.
  const isWindows = process.platform === "win32";
  try {
    execFileSync(isWindows ? "npm.cmd" : "npm", ["run", "build"], {
      cwd: repoRoot,
      // NOT "ignore": a tsup failure used to leave beforeAll throwing a bare
      // "Command failed", which took all of the tests below down with no
      // cause to act on. tsup names the offending file:line, so keep it.
      stdio: "pipe",
      encoding: "utf8",
      shell: isWindows,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `npm run build failed -- the CLI under test was not rebuilt (${e.message ?? "no message"}).\n--- build stdout ---\n${e.stdout ?? "(empty)"}\n--- build stderr ---\n${e.stderr ?? "(empty)"}`,
    );
  }
}, 180_000);

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the built CLI. spawnSync gives the child PIPES rather than a tty,
 *  which is the condition the exitCode-instead-of-exit change exists for.
 *  The child is hermetic -- see the beforeAll note on workDir. */
function runCli(args: string[]): CliRun {
  // Scrub inherited YAW_MCP_* so a developer's own knobs cannot change which
  // branch the child takes, then point every home-shaped lookup at workDir.
  // YAW_MCP_AUTO_UPGRADE=0 is applied AFTER the scrub (which would delete it)
  // to drop the startup registry check.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith("YAW_MCP_")) delete childEnv[k];
  }
  const res = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    cwd: workDir,
    env: {
      ...childEnv,
      HOME: workDir,
      USERPROFILE: workDir,
      CLAUDE_CONFIG_DIR: workDir,
      YAW_MCP_AUTO_UPGRADE: "0",
    },
  });
  // Never collapse a spawn failure or a kill into a status number. The two
  // failure modes this file exists to catch -- a CLI that hangs now that
  // process.exit() is gone, and one that cannot start at all -- both used to
  // reach the assertion as `-1` and report "expected -1 to be 0", which names
  // neither of them.
  const status = res.status;
  if (res.error || status === null) {
    const why = res.error ? res.error.message : `killed by ${res.signal ?? "an unknown signal"}`;
    throw new Error(
      `yaw-mcp ${args.join(" ")}: did not exit normally -- ${why}. A 30s timeout here means the CLI hung instead of exiting.\n--- stdout ---\n${res.stdout ?? "(empty)"}\n--- stderr ---\n${res.stderr ?? "(empty)"}`,
    );
  }
  return { code: status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

describe("CLI dispatch -- help goes to stdout and exits 0", () => {
  it("prints a subcommand usage on the shared parse tail", () => {
    const r = runCli(["sidecars", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: yaw-mcp sidecars install [--json]");
    expect(r.stderr, "usage went to stderr").toBe("");
  });

  it("prints install's usage, which rides a SUCCESSFUL parse instead", () => {
    // install signals --help via helpRequested on the ok branch, so it has its
    // own branch rather than the shared tail -- a second shape to keep right.
    const r = runCli(["install", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: yaw-mcp install <claude-code|claude-desktop|cursor|vscode>");
    expect(r.stderr).toBe("");
  });

  it("prints foundry's usage on the shared tail, driven by the parser's help flag", () => {
    // parseFoundryArgs returns `{ ok: false, error: FOUNDRY_USAGE, help: true }`
    // and index.ts hands that straight to run(), like every sibling. It used
    // to re-derive help by string identity (`error === FOUNDRY_USAGE`) and
    // spread that verdict OVER the flag, so a prefix or a trailing newline on
    // the usage body moved help to stderr with exit 2: `yaw-mcp foundry
    // --help | less` showed a blank pager. Nothing else in the repo runs this
    // branch, so this is the only thing that would go red if the identity
    // check came back.
    const r = runCli(["foundry", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: yaw-mcp foundry export");
    expect(r.stderr).toBe("");
  });

  it("prints doctor's usage, which is hand-rolled rather than parser-driven", () => {
    const r = runCli(["doctor", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: yaw-mcp doctor [--json]");
    expect(r.stderr).toBe("");
  });

  it("delivers the whole multi-KB top-level help through a pipe", () => {
    // THE regression the exitCode change exists to prevent: a synchronous
    // process.exit() force-flushes the event loop and can truncate a buffered
    // body when stdout is a pipe. Asserting the LAST line is what proves the
    // body arrived whole rather than merely started.
    const r = runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("one install, every MCP server");
    expect(r.stdout, "help body was truncated before its final section").toContain(
      "Source: https://github.com/YawLabs/mcp",
    );
    expect(r.stdout.length).toBeGreaterThan(6000);
  });

  it("prints the version and exits 0", () => {
    const r = runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^yaw-mcp \S+/);
    expect(r.stderr).toBe("");
  });
});

describe("CLI dispatch -- argv errors go to stderr and exit 2", () => {
  it("rejects an unknown subcommand flag", () => {
    const r = runCli(["sidecars", "--wat"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--wat");
    expect(r.stdout, "an argv error leaked onto stdout").toBe("");
  });

  it("rejects an unknown doctor argument", () => {
    const r = runCli(["doctor", "--bad"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown argument");
    expect(r.stdout).toBe("");
  });

  it("suggests the closest subcommand for a typo", () => {
    const r = runCli(["doctro"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown subcommand "doctro"');
    expect(r.stderr).toContain("doctor");
  });

  it("suggests the closest flag for a long-flag typo", () => {
    // Without this branch the argv would fall through to runServer() and hang
    // as a stdio MCP server with no diagnostic -- so exiting at all is the
    // behaviour under test, not just the exit code.
    const r = runCli(["--versionn"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown flag "--versionn"');
    expect(r.stderr).toContain("--version");
  });
});
