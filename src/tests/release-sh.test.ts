// release.sh -- the pre-flight guards.
//
// Until now this file had ZERO coverage: across the whole suite the only
// occurrence of the string "release.sh" was a comment. Every guard in it
// protects an IRREVERSIBLE step (npm forbids re-publishing a version, and the
// step-3 push lands on protected main), so a guard that silently inverts is
// expensive in exactly the way tests are cheap.
//
// Two harness shapes, both hermetic -- no network, no git remote, no npm:
//
//   FIXTURE RUN -- copy release.sh into a temp dir beside a synthetic
//   package.json / server.json / node_modules/.bin and run it for real. This
//   exercises the guards through the actual script, wiring included. It works
//   because the first network call is `git fetch`, and everything before it is
//   local; a fixture with no .git dies at `git rev-parse --abbrev-ref HEAD`
//   shortly after, which is well past the two guards this shape covers.
//   release.sh cds to its OWN directory on startup, so the copy is mandatory:
//   running the repo's release.sh with cwd set elsewhere would make it operate
//   on the real repo.
//
//   EXTRACTED BLOCK -- lift one guard's text out of release.sh, source it under
//   stub shell functions, and drive it directly. Used for the guards that sit
//   after the first network call. This tests the block's logic rather than its
//   wiring, so every extraction ASSERTS its anchors are present: if the script
//   is reshaped, these fail loudly instead of quietly testing nothing.
//
// Deliberately not covered: the IS_MINGW_ARM64 139/134 tolerance paths. They
// are reachable only when uname reports ARM64, so a test would be the one
// host-conditional file in the suite and would pass vacuously everywhere else.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

// Every case here spawnSyncs a real bash running a real script, and there are
// 55 of them: ~142 s of wall clock for the file, so ~2.6 s a case on an idle
// box. None of them ASSERTS a duration -- they assert on the script's stdout
// -- so the only clock that matters is the harness's patience, and the global
// 30 s testTimeout was it.
//
// That was enough until the suite grew: the default run packs the parallel
// files onto every core at once, and under that contention a single case was
// observed taking 30.3 s and failing the whole run. Twice, non-deterministically,
// on a green tree. The same file passes standalone in 142 s.
//
// So this is NOT a TIMING_SENSITIVE file (vitest.config.ts) -- that project is
// for assertions whose SUBJECT is a budget, where isolating the file is what
// makes the number meaningful, and moving a 142 s file into that sequential
// group would put all of it on the critical path. Here the deadline is
// incidental, so the fix is to stop measuring patience in units set for
// in-process unit tests. 5 minutes is ~2x the file's entire standalone
// runtime, so no single case can plausibly reach it without being genuinely
// wedged, which is the failure this still catches.
//
// release.sh runs this suite as a release gate, so a flake here blocks a
// release for a reason that has nothing to do with the release.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const releaseShPath = join(repoRoot, "release.sh");
const releaseSh = readFileSync(releaseShPath, "utf8");

const tmpRoots: string[] = [];
afterAll(() => {
  for (const d of tmpRoots) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // A leaked temp dir is not worth failing a suite over.
    }
  }
});

function newTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

/**
 * Lift a contiguous block out of release.sh, from the line equal to `start`
 * through the first subsequent line equal to `end` (both inclusive).
 *
 * Throws when either anchor is missing. That is the point: these tests assert
 * behavior of code they cannot see being wired in, so a reshaped script must
 * break them loudly rather than leave them asserting against an empty string.
 */
function extractBlock(start: string, end: string): string {
  const lines = releaseSh.split("\n");
  const from = lines.indexOf(start);
  if (from === -1) {
    throw new Error(`release.sh anchor not found: ${JSON.stringify(start)}`);
  }
  const to = lines.indexOf(end, from + 1);
  if (to === -1) {
    throw new Error(`release.sh end anchor ${JSON.stringify(end)} not found after ${JSON.stringify(start)}`);
  }
  return `${lines.slice(from, to + 1).join("\n")}\n`;
}

/** The single-line `if echo "$out" | grep -qE '...'` inside run_npm_check. */
function extractToolchainPattern(): string {
  const line = releaseSh.split("\n").find((l) => l.includes("grep -qE") && l.includes("Cannot find (module|package)"));
  if (!line) {
    throw new Error("release.sh: toolchain-missing grep pattern not found");
  }
  const m = line.match(/grep -qE '([^']+)'/);
  if (!m) {
    throw new Error(`release.sh: could not parse the pattern out of: ${line}`);
  }
  return m[1];
}

type RunResult = { status: number | null; out: string };

/** Run a bash script body in `cwd`, merging stdout and stderr. */
function runBash(body: string, cwd: string, env: Record<string, string> = {}): RunResult {
  const file = join(cwd, `harness-${Math.abs(hash(body))}.sh`);
  writeFileSync(file, body);
  const r = spawnSync("bash", [file], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// Stable name for the harness file; Math.random is avoided so a rerun reuses
// the same path rather than littering the temp dir.
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

/** Stub implementations of release.sh's own output helpers, for extracted blocks. */
const STUB_HELPERS = [
  'info() { echo "INFO $1"; }',
  'warn() { echo "WARN $1"; }',
  'fail() { echo "FAIL $1"; exit 1; }',
].join("\n");

// ---------------------------------------------------------------------------
// FIXTURE RUN
// ---------------------------------------------------------------------------

type Fixture = {
  bins?: string[];
  lockfile?: boolean;
  description?: string;
  name?: string;
  serverJson?: string | null;
  version?: string;
};

const ALL_BINS = ["biome", "tsc", "vitest", "tsup"];

function makeFixture(opts: Fixture = {}): string {
  const dir = newTmp("release-sh-");
  copyFileSync(releaseShPath, join(dir, "release.sh"));

  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  for (const b of opts.bins ?? ALL_BINS) {
    writeFileSync(join(dir, "node_modules", ".bin", b), "");
  }
  if (opts.lockfile !== false) {
    writeFileSync(join(dir, "package-lock.json"), "{}\n");
  }

  const version = opts.version ?? "0.0.1";
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "@yawlabs/mcp",
        version,
        mcpName: "io.github.YawLabs/mcp",
        description: "fixture",
      },
      null,
      2,
    ),
  );

  if (opts.serverJson === null) {
    // caller wants server.json absent
  } else if (typeof opts.serverJson === "string") {
    writeFileSync(join(dir, "server.json"), opts.serverJson);
  } else {
    writeFileSync(
      join(dir, "server.json"),
      JSON.stringify(
        {
          name: opts.name ?? "io.github.YawLabs/mcp",
          description: opts.description ?? "a valid short description",
          version,
        },
        null,
        2,
      ),
    );
  }
  return dir;
}

/**
 * Run the copied release.sh for a target version. Never pass -y or
 * SKIP_CONFIRM: a fixture has no .git, so the run dies at the branch probe
 * shortly after the guards under test -- which is the brake keeping this from
 * ever reaching a gate, a push or a publish.
 */
function runRelease(dir: string, version = "9.9.9", env: Record<string, string> = {}): RunResult {
  const r = spawnSync("bash", ["./release.sh", version], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("release.sh dependency guard (fixture run)", () => {
  it("names every missing bin when node_modules/.bin is empty", () => {
    const r = runRelease(makeFixture({ bins: [] }));
    expect(r.out).toContain("Dependencies are not installed");
    for (const b of ALL_BINS) {
      expect(r.out).toContain(b);
    }
    expect(r.status).not.toBe(0);
  });

  it("names only the missing bin on a partially installed tree", () => {
    const r = runRelease(makeFixture({ bins: ["tsc", "vitest", "tsup"] }));
    expect(r.out).toContain("missing node_modules/.bin/{biome}");
    // The ${MISSING_BINS# } trim: no leading space inside the braces.
    expect(r.out).not.toContain("{ biome}");
  });

  it("skips biome entirely under SKIP_LINT=1", () => {
    const r = runRelease(makeFixture({ bins: ["tsc", "vitest", "tsup"] }), "9.9.9", {
      SKIP_LINT: "1",
    });
    expect(r.out).not.toContain("Dependencies are not installed");
    // Proceeded far enough to reach the next local guard.
    expect(r.out).toContain("server.json passes the MCP-registry field limits");
  });

  it("prescribes npm ci with a lockfile and npm install without one", () => {
    const withLock = runRelease(makeFixture({ bins: [], lockfile: true }));
    expect(withLock.out).toContain("Run `npm ci`");

    const noLock = runRelease(makeFixture({ bins: [], lockfile: false }));
    expect(noLock.out).toContain("Run `npm install`");
  });
});

describe("release.sh registry field guard (fixture run)", () => {
  it("rejects an over-cap description with the trim arithmetic", () => {
    const r = runRelease(makeFixture({ description: "L".repeat(121) }));
    expect(r.out).toContain("violates the MCP registry schema");
    expect(r.out).toContain("description is 121 characters");
    expect(r.out).toContain("trim 21");
    expect(r.status).not.toBe(0);
  });

  it("accepts a description of exactly 100 characters", () => {
    const r = runRelease(makeFixture({ description: "x".repeat(100) }));
    expect(r.out).toContain("server.json passes the MCP-registry field limits");
  });

  it("counts CODE POINTS, so 100 astral characters pass", () => {
    // String.length would report 200 here and reject a description the
    // registry accepts. This is the whole reason the guard spreads the string.
    const r = runRelease(makeFixture({ description: "\u{1F600}".repeat(100) }));
    expect(r.out).toContain("server.json passes the MCP-registry field limits");
  });

  it("rejects 101 astral characters", () => {
    const r = runRelease(makeFixture({ description: "\u{1F600}".repeat(101) }));
    expect(r.out).toContain("description is 101 characters");
  });

  it("rejects a name that does not match the registry pattern", () => {
    const r = runRelease(makeFixture({ name: "iogithubYawLabsmcp" }));
    expect(r.out).toContain("does not match the registry pattern");
    expect(r.status).not.toBe(0);
  });

  it("rejects a name shorter than three characters", () => {
    const r = runRelease(makeFixture({ name: "ab" }));
    expect(r.out).toContain("name must be 3-200 characters");
  });

  it("reports an unreadable server.json distinctly from a schema violation", () => {
    const malformed = runRelease(makeFixture({ serverJson: '{"name": "io.github.x/y",' }));
    expect(malformed.out).toContain("Could not read server.json");
    expect(malformed.status).not.toBe(0);

    const absent = runRelease(makeFixture({ serverJson: null }));
    expect(absent.out).toContain("Could not read server.json");
  });
});

// ---------------------------------------------------------------------------
// EXTRACTED BLOCKS
// ---------------------------------------------------------------------------

describe("release.sh toolchain-missing pattern", () => {
  const pattern = extractToolchainPattern();
  const dir = newTmp("release-re-");

  function matches(sample: string): boolean {
    const r = spawnSync("bash", ["-c", 'printf "%s" "$1" | grep -qE "$2"', "_", sample, pattern], {
      cwd: dir,
      encoding: "utf8",
    });
    return r.status === 0;
  }

  it.each([
    ["dash", "sh: 1: biome: not found"],
    ["busybox ash", "sh: biome: not found"],
    ["bash", "bash: biome: command not found"],
    ["absolute sh", "/bin/sh: 1: vitest: not found"],
    ["windows cmd", "'biome' is not recognized as an internal or external command,"],
    ["CJS scoped", "Error: Cannot find module '@biomejs/cli-win32-arm64/biome.exe'"],
    ["CJS unquoted", "Cannot find module @rollup/rollup-win32-arm64-msvc"],
    ["ESM package", "Error: Cannot find package '@rollup/rollup-linux-x64-gnu' imported from x"],
    ["esbuild platform", "You have an incorrect version of esbuild installed win32-x64 for another platform"],
  ])("matches the %s missing-executable shape", (_label, sample) => {
    expect(matches(sample)).toBe(true);
  });

  it.each([
    ["clean lint", "Checked 162 files in 255ms. No fixes applied."],
    ["vitest pass", "Test Files  88 passed (88)"],
    ["real lint findings", "Found 3 errors in 2 files."],
    ["src comment", '// the exit-1 "namespace not found" case below.'],
    ["src comment 2", "plus 18 `command not found: add:...` errors on"],
    ["jsonrpc", 'JSON-RPC -32601: "Method not found", "Unknown tool"'],
  ])("does not match %s", (_label, sample) => {
    expect(matches(sample)).toBe(false);
  });
});

describe("release.sh mcp_registry_gh_token", () => {
  const fn = extractBlock("mcp_registry_gh_token() {", "}");
  const dir = newTmp("release-tok-");

  function resolve(env: Record<string, string>, ghMode: "ok" | "empty" | "absent"): string {
    const gh =
      ghMode === "absent"
        ? "command() { return 1; }"
        : ghMode === "ok"
          ? 'gh() { echo "gh-token"; }'
          : "gh() { return 1; }";
    const body = [gh, fn, "mcp_registry_gh_token"].join("\n");
    return runBash(body, dir, env).out;
  }

  it("prefers GITHUB_TOKEN, then MCP_REGISTRY_TOKEN, then gh", () => {
    expect(resolve({ GITHUB_TOKEN: "G", MCP_REGISTRY_TOKEN: "M" }, "ok")).toBe("G");
    expect(resolve({ MCP_REGISTRY_TOKEN: "M" }, "ok")).toBe("M");
    expect(resolve({}, "ok")).toBe("gh-token");
  });

  it("resolves to nothing when gh errors or is absent", () => {
    expect(resolve({}, "empty")).toBe("");
    expect(resolve({}, "absent")).toBe("");
  });

  it("emits the token and nothing else on stdout", () => {
    // Step 5 captures this in a command substitution and uses it AS the
    // credential, so any stray info()/warn() inside the helper would be
    // concatenated into the token.
    expect(resolve({ GITHUB_TOKEN: "G" }, "ok")).toBe("G");
  });
});

describe("release.sh npm auth guard", () => {
  const block = extractBlock("WHOAMI_RC=0", "fi");
  const dir = newTmp("release-who-");

  function run(opts: { stdout: string; stderr: string; rc: number; alreadyPublished: string }): RunResult {
    const body = [
      STUB_HELPERS,
      'VERSION="0.81.0"',
      `ALREADY_PUBLISHED="${opts.alreadyPublished}"`,
      `npm() { printf '%s' "$FAKE_OUT"; printf '%s' "$FAKE_ERR" >&2; return ${opts.rc}; }`,
      block,
      'echo "CONTINUED"',
    ].join("\n");
    return runBash(body, dir, { FAKE_OUT: opts.stdout, FAKE_ERR: opts.stderr });
  }

  it("reports the identity without npm's stderr notices", () => {
    const r = run({
      stdout: "jeffyaw",
      stderr: "npm notice\nnpm notice New major version of npm available!\nnpm notice",
      rc: 0,
      alreadyPublished: "",
    });
    expect(r.out).toContain("INFO npm auth: jeffyaw");
    expect(r.out).not.toContain("npm notice");
    expect(r.out).toContain("CONTINUED");
  });

  it("hard-fails a definitive auth error when the version is not yet published", () => {
    const r = run({
      stdout: "",
      stderr: "npm error code ENEEDAUTH\nnpm error need auth",
      rc: 1,
      alreadyPublished: "",
    });
    expect(r.out).toContain("FAIL npm is not authenticated");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("warns and continues when the version is already published", () => {
    // The carve-out that keeps a lapsed token from blocking a resume whose
    // step 4 will skip the publish outright.
    const r = run({
      stdout: "",
      stderr: "npm error code E401\nnpm error Incorrect or missing password",
      rc: 1,
      alreadyPublished: "0.81.0",
    });
    expect(r.out).toContain("WARN npm is not authenticated");
    expect(r.out).toContain("already published");
    expect(r.out).toContain("CONTINUED");
  });

  it("fails open, echoing the diagnostic, on a non-auth failure", () => {
    const r = run({
      stdout: "",
      stderr: "npm error network request failed",
      rc: 1,
      alreadyPublished: "",
    });
    expect(r.out).toContain("WARN npm whoami inconclusive (exit 1)");
    expect(r.out).toContain("network request failed");
    expect(r.out).toContain("CONTINUED");
  });

  it("fails open on an exit-139 segfault that still printed a username", () => {
    const r = run({ stdout: "jeffyaw", stderr: "", rc: 139, alreadyPublished: "" });
    expect(r.out).toContain("inconclusive (exit 139)");
    expect(r.out).toContain("CONTINUED");
  });
});

describe("release.sh git fetch gate", () => {
  const block = extractBlock('REMOTE_MAIN_SHA=""', "fi");
  const dir = newTmp("release-fetch-");

  function run(opts: { fetchRc: number; lsRemote: string; tracking: string; allowStale?: boolean }): RunResult {
    const body = [
      STUB_HELPERS,
      // git stub: fetch exits as directed, ls-remote and rev-parse answer from
      // the scenario. Anything else is not reached by this block.
      // A failing `git ls-remote` prints NOTHING -- not an empty first field.
      // Emitting a bare "\trefs/heads/main" would let awk '{print $1}' parse
      // the ref name as the sha, so the empty case must produce no output.
      `git() {
  case "$1 $2" in
    "fetch --tags") echo "fetch output line"; return ${opts.fetchRc} ;;
    "ls-remote origin")
      if [ -n "${opts.lsRemote}" ]; then
        printf '%s\\trefs/heads/main\\n' "${opts.lsRemote}"
      else
        return 128
      fi ;;
    "rev-parse origin/main")
      if [ -n "${opts.tracking}" ]; then printf '%s\\n' "${opts.tracking}"; else return 128; fi ;;
    *) return 0 ;;
  esac
}`,
      block,
      'echo "REMOTE_MAIN_SHA=[$REMOTE_MAIN_SHA]"',
      'echo "CONTINUED"',
    ].join("\n");
    return runBash(body, dir, opts.allowStale ? { ALLOW_STALE_REMOTE: "1" } : {});
  }

  it("continues when the fetch fails but origin/main is confirmed current", () => {
    // The divergent-local-tag case: `--tags` makes the whole fetch exit
    // non-zero on a rejected tag while origin/main updates cleanly.
    const r = run({ fetchRc: 1, lsRemote: "abc123def", tracking: "abc123def" });
    expect(r.out).toContain("origin/main is confirmed current");
    expect(r.out).toContain("fetch output line");
    expect(r.out).toContain("CONTINUED");
  });

  it("hard-fails when origin/main cannot be confirmed", () => {
    const r = run({ fetchRc: 128, lsRemote: "", tracking: "abc123def" });
    expect(r.out).toContain("FAIL git fetch origin failed");
    expect(r.out).toContain("fetch output line");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("names the true remote sha under ALLOW_STALE_REMOTE when ls-remote answered", () => {
    const r = run({
      fetchRc: 1,
      lsRemote: "newsha999",
      tracking: "oldsha111",
      allowStale: true,
    });
    expect(r.out).toContain("ls-remote DID answer");
    expect(r.out).toContain("newsha999");
    expect(r.out).toContain("CONTINUED");
  });

  it("admits it is guessing under ALLOW_STALE_REMOTE when ls-remote could not answer", () => {
    const r = run({ fetchRc: 128, lsRemote: "", tracking: "oldsha111", allowStale: true });
    expect(r.out).toContain("could not answer either");
    expect(r.out).toContain("possibly STALE");
    expect(r.out).toContain("CONTINUED");
  });

  it("leaves REMOTE_MAIN_SHA empty on a clean fetch so the fresh tracking ref is used", () => {
    const r = run({ fetchRc: 0, lsRemote: "unused", tracking: "abc123def" });
    expect(r.out).toContain("REMOTE_MAIN_SHA=[]");
  });
});

describe("release.sh version-ordering guard", () => {
  const block = extractBlock('if [ -z "$LATEST_NPM" ]; then', "fi");
  const dir = newTmp("release-ver-");

  function run(env: Record<string, string>): RunResult {
    const body = [STUB_HELPERS, block, 'echo "CONTINUED"'].join("\n");
    return runBash(body, dir, env);
  }

  it("hard-fails a fresh bump when the registry is unreadable", () => {
    const r = run({ LATEST_NPM: "", RESUMING: "false" });
    expect(r.out).toContain("FAIL npm view returned nothing");
    expect(r.out).toContain("cannot verify version ordering");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("warns and continues on a resume", () => {
    const r = run({ LATEST_NPM: "", RESUMING: "true" });
    expect(r.out).toContain("WARN npm view returned nothing");
    expect(r.out).toContain("CONTINUED");
  });

  it("warns and continues under ALLOW_UNVERIFIED_VERSION=1", () => {
    const r = run({ LATEST_NPM: "", RESUMING: "false", ALLOW_UNVERIFIED_VERSION: "1" });
    expect(r.out).toContain("WARN npm view returned nothing");
    expect(r.out).toContain("CONTINUED");
  });

  it("says nothing when the registry reads normally", () => {
    const r = run({ LATEST_NPM: "0.80.0", RESUMING: "false" });
    expect(r.out.trim()).toBe("CONTINUED");
  });
});

describe("release.sh version comparator", () => {
  const dir = newTmp("release-cmp-");
  // The inline node comparator that decides whether VERSION > LATEST_NPM.
  const line = releaseSh.split("\n").find((l) => l.includes("if node -e") && l.includes("process.exit"));

  function greaterThan(version: string, latest: string): boolean {
    if (!line) {
      throw new Error("release.sh: version comparator not found");
    }
    const body = [
      `VERSION="${version}"`,
      `LATEST_NPM="${latest}"`,
      line.replace(/^\s*if /, "if "),
      // Distinct markers, not "GREATER"/"NOT_GREATER": the latter contains the
      // former, so a substring check would report every case as greater.
      '  echo "CMP:yes"',
      "else",
      '  echo "CMP:no"',
      "fi",
    ].join("\n");
    return runBash(body, dir).out.includes("CMP:yes");
  }

  it.each([
    ["0.81.0", "0.80.0", true],
    ["1.0.0", "0.99.99", true],
    ["0.80.1", "0.80.0", true],
    ["0.80.0", "0.80.0", false],
    ["0.79.3", "0.80.0", false],
    ["0.8.0", "0.80.0", false],
  ])("%s > %s === %s", (version, latest, expected) => {
    expect(greaterThan(version as string, latest as string)).toBe(expected);
  });
});

describe("release.sh tag-at-HEAD guard", () => {
  const block = extractBlock('if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then', "fi");
  const dir = newTmp("release-tag-");

  function run(opts: { tagSha: string | null; headSha: string; published: string }): RunResult {
    const body = [
      STUB_HELPERS,
      'VERSION="0.81.0"',
      `current_head_sha() { echo "${opts.headSha}"; }`,
      `git() {
  case "$1 $2" in
    "tag -l") ${opts.tagSha ? 'echo "v0.81.0"' : "true"} ;;
    "rev-list -n1") echo "${opts.tagSha ?? ""}" ;;
    "tag -a") echo "TAG_CREATED" ;;
    *) return 0 ;;
  esac
}`,
      `npm() { echo "${opts.published}"; }`,
      block,
      'echo "CONTINUED"',
    ].join("\n");
    return runBash(body, dir);
  }

  it("accepts a pre-existing tag that points at HEAD", () => {
    const r = run({ tagSha: "aaa111", headSha: "aaa111", published: "" });
    expect(r.out).toContain("already exists at HEAD");
    expect(r.out).toContain("CONTINUED");
  });

  it("refuses to publish a tree the tag does not describe", () => {
    // Tag left behind by an interrupted run, a fix committed on main after it,
    // and the version NOT yet on npm -- step 4 would pack a tree the tag does
    // not contain, permanently, since npm forbids re-publishing.
    const r = run({ tagSha: "aaa111", headSha: "bbb222", published: "" });
    expect(r.out).toContain("FAIL Tag v0.81.0 exists at aaa111");
    expect(r.out).toContain("HEAD is bbb222");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("continues on tag/HEAD drift when the version is already published", () => {
    // The v0.80.0 recovery shape: the tag describes what npm already has, so
    // step 4 packs nothing and the drift is harmless. Failing here would block
    // a resume that works.
    const r = run({ tagSha: "aaa111", headSha: "bbb222", published: "0.81.0" });
    expect(r.out).toContain("WARN Tag v0.81.0 points at aaa111");
    expect(r.out).toContain("already on npm");
    expect(r.out).toContain("CONTINUED");
  });

  it("fails closed when the registry cannot be read", () => {
    // An unreadable registry leaves the probe empty, which must NOT be treated
    // as "already published" in front of an irreversible publish.
    const r = run({ tagSha: "aaa111", headSha: "bbb222", published: "" });
    expect(r.out).toContain("FAIL");
  });

  it("creates an annotated tag when none exists", () => {
    const r = run({ tagSha: null, headSha: "bbb222", published: "" });
    expect(r.out).toContain("TAG_CREATED");
    expect(r.out).toContain("INFO Tag v0.81.0 created");
  });
});

describe("release.sh non-interactive confirm brake", () => {
  const block = extractBlock('if [ "$SKIP_CONFIRM" != "true" ] && [ "$RESUMING" != "true" ]; then', "fi");
  const dir = newTmp("release-tty-");

  it("aborts with exit 0 before any mutation when stdin is not a terminal", () => {
    // Every fixture test in this file relies on this brake: if it ever exits 1
    // or reads anyway, those runs would proceed into the gates, the push and
    // the publish.
    const body = [
      STUB_HELPERS,
      'VERSION="9.9.9"',
      'SKIP_CONFIRM="false"',
      'RESUMING="false"',
      "CYAN=''; YELLOW=''; NC=''",
      block,
      'echo "REACHED_STEP_1"',
    ].join("\n");
    const r = runBash(body, dir);
    expect(r.out).toContain("Aborted: stdin is not a terminal");
    expect(r.out).not.toContain("REACHED_STEP_1");
    expect(r.status).toBe(0);
  });
});
