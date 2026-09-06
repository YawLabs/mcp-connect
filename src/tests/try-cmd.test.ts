import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { atomicWriteFile } from "../atomic-write.js";
import { buildLaunchEntry, ENTRY_NAME } from "../install-targets.js";
import {
  type ExploreServerResponse,
  formatTtl,
  gcExpiredTrials,
  parseDurationMs,
  parseTryArgs,
  parseTryCleanupArgs,
  runTry,
  runTryCleanup,
  scanTrials,
  TRY_USAGE,
  type TrialMarker,
  trialGcFailureWarning,
  trialMarkerPath,
  trialsDir,
} from "../try-cmd.js";

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-try-home-"));
  synthCwd = mkdtempSync(join(synthHome, "cwd-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
});

function captureIO(): {
  out: string[];
  err: string[];
  pushOut: (s: string) => void;
  pushErr: (s: string) => void;
  text: () => string;
  errText: () => string;
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    pushOut: (s: string): void => {
      out.push(s);
    },
    pushErr: (s: string): void => {
      err.push(s);
    },
    text: () => out.join(""),
    errText: () => err.join(""),
  };
}

/** Path of the retired per-machine anon-id file. `try` no longer has a
 *  loader for it -- this literal exists so the tests below can assert the
 *  fingerprint is never written back. */
function legacyAnonPath(home: string): string {
  return join(trialsDir(home), ".anon");
}

const SAMPLE: ExploreServerResponse = {
  slug: "demo",
  name: "Demo MCP",
  command: "npx",
  args: ["-y", "@demo/mcp"],
  requiredEnvVars: [],
};

describe("parseTryArgs", () => {
  it("rejects empty argv with usage", () => {
    const r = parseTryArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Usage:/);
  });

  it("accepts a bare slug", () => {
    const r = parseTryArgs(["demo"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.slug).toBe("demo");
  });

  it("rejects more than one positional", () => {
    const r = parseTryArgs(["demo", "other"]);
    expect(r.ok).toBe(false);
  });

  it("parses --client", () => {
    const r = parseTryArgs(["demo", "--client", "cursor"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.clientId).toBe("cursor");
  });

  it("rejects --client with unknown value", () => {
    const r = parseTryArgs(["demo", "--client", "zed"]);
    expect(r.ok).toBe(false);
  });

  it("parses --ttl and rejects garbage", () => {
    const good = parseTryArgs(["demo", "--ttl", "30m"]);
    expect(good.ok).toBe(true);
    const bad = parseTryArgs(["demo", "--ttl", "later"]);
    expect(bad.ok).toBe(false);
  });

  it("rejects a --ttl far enough out to overflow the expiry Date", () => {
    // "100000000d" is a fine digit run, so it used to parse -- and then
    // `new Date(now + ttl).toISOString()` in the --dry-run preview threw a
    // bare RangeError ("Invalid time value") that surfaced as an opaque
    // error, while the real run persisted the absurd marker in silence.
    const r = parseTryArgs(["demo", "--ttl", "100000000d"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--ttl: cannot parse/);
  });

  it("parses repeated --env KEY=val", () => {
    const r = parseTryArgs(["demo", "--env", "FOO=bar", "--env", "BAZ=qux"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.envOverrides).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("splits --env on the FIRST = so the value may contain more", () => {
    // Connection strings and base64 secrets carry `=`; splitting on the last
    // (or on every) `=` would truncate them.
    const r = parseTryArgs(["demo", "--env", "FOO=a=b"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.envOverrides).toEqual({ FOO: "a=b" });
  });

  it("returns usage flagged as help for -h / --help", () => {
    // help:true is what lets the dispatcher print usage on stdout and exit 0
    // instead of treating it as a parse error.
    for (const flag of ["-h", "--help"]) {
      const r = parseTryArgs(["demo", flag]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.help).toBe(true);
        expect(r.error).toMatch(/Usage: yaw-mcp try/);
      }
    }
  });

  it("rejects --env without =", () => {
    const r = parseTryArgs(["demo", "--env", "FOO"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --env with invalid key", () => {
    const r = parseTryArgs(["demo", "--env", "1FOO=bar"]);
    expect(r.ok).toBe(false);
  });

  it("parses --dry-run + --yes (and -y)", () => {
    const r = parseTryArgs(["demo", "--dry-run", "--yes"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.dryRun).toBe(true);
      expect(r.options.yes).toBe(true);
    }
    const short = parseTryArgs(["demo", "-y"]);
    expect(short.ok).toBe(true);
    if (short.ok) expect(short.options.yes).toBe(true);
    const bare = parseTryArgs(["demo"]);
    expect(bare.ok).toBe(true);
    if (bare.ok) expect(bare.options.yes).toBeUndefined();
  });

  it("rejects --base now that the no-op is gone, instead of silently accepting it", () => {
    // Parsed, threaded into the catalog seam and ignored there for one
    // release (v0.79.x). A script still passing it now gets the same exit 2
    // as any other unknown flag rather than a flag that pretends to work --
    // and the usage no longer names it, or the env var nothing ever read.
    const r = parseTryArgs(["demo", "--base", "http://localhost:3000"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unknown flag: --base/);
    expect(TRY_USAGE).not.toContain("--base");
    expect(TRY_USAGE).not.toContain("YAW_MCP_BASE_URL");
  });

  it("rejects unknown flags", () => {
    const r = parseTryArgs(["demo", "--bogus"]);
    expect(r.ok).toBe(false);
  });

  it("rejects a bare '-' positional with a clear arg-parse error", () => {
    const r = parseTryArgs(["-"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid argument "-"/);
  });
});

describe("parseTryCleanupArgs", () => {
  it("requires a slug", () => {
    expect(parseTryCleanupArgs([]).ok).toBe(false);
    expect(parseTryCleanupArgs(["demo"]).ok).toBe(true);
  });

  it("rejects unknown flags", () => {
    expect(parseTryCleanupArgs(["demo", "--bogus"]).ok).toBe(false);
  });

  it("rejects --base like any other unknown flag now that nothing reads it", () => {
    const r = parseTryCleanupArgs(["demo", "--base", "http://localhost:3000"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unknown flag: --base/);
  });

  it("rejects a bare '-' positional with a clear arg-parse error", () => {
    const r = parseTryCleanupArgs(["-"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid argument "-"/);
  });
});

describe("parseDurationMs", () => {
  it("parses s/m/h/d suffixes", () => {
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("5m")).toBe(300_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs("3d")).toBe(259_200_000);
  });

  it("returns null on bogus input", () => {
    expect(parseDurationMs("later")).toBeNull();
    expect(parseDurationMs("0h")).toBeNull();
    expect(parseDurationMs("-5m")).toBeNull();
  });

  it("returns null past the 100-year ceiling, which is what keeps the expiry a valid Date", () => {
    // Anything beyond the cap pushes `now + ttl` out of the Date range, where
    // toISOString() throws RangeError in the dry-run preview and the real run
    // writes a nonsense marker. The boundary itself still parses.
    expect(parseDurationMs("36500d")).toBe(36500 * 86_400_000);
    expect(parseDurationMs("36501d")).toBeNull();
    expect(parseDurationMs("100000000d")).toBeNull();
    expect(parseDurationMs("999999999h")).toBeNull();
  });
});

describe("formatTtl", () => {
  it("renders seconds / minutes / hours / days", () => {
    expect(formatTtl(5000)).toBe("5s");
    expect(formatTtl(120_000)).toBe("2m");
    expect(formatTtl(7_200_000)).toBe("2h");
    expect(formatTtl(2 * 86_400_000)).toBe("2d");
  });

  it("floors rather than rounds so the nudge never overstates the time left", () => {
    // Rounding printed 90m as "2h" and 36h as "2d" -- half an hour and half a
    // day the user did not have, on a line that reads as a precise expiry.
    expect(formatTtl(90 * 60_000)).toBe("1h");
    expect(formatTtl(36 * 3_600_000)).toBe("1d");
    expect(formatTtl(5_700)).toBe("5s");
    expect(formatTtl(59_999)).toBe("59s");
  });
});

describe("anon-id retirement", () => {
  it("leaves a pre-existing .anon file alone instead of reading or rewriting it", async () => {
    // An older version persisted a machine fingerprint here. Nothing loads it
    // now, and `try` must neither consume it nor delete it out from under the
    // user -- it just stops being touched.
    mkdirSync(trialsDir(synthHome), { recursive: true });
    writeFileSync(legacyAnonPath(synthHome), "deadbeefdeadbeef\n");

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    // Untouched on disk, byte for byte...
    expect(readFileSync(legacyAnonPath(synthHome), "utf8")).toBe("deadbeefdeadbeef\n");
    // ...and absent from everything the run emitted. There is no event body
    // to leak it into any more -- the reporting seam is gone outright -- so
    // the command's own output is the surface left worth checking.
    expect(cap.text()).not.toContain("deadbeef");
  });
});

describe("runTry — happy path", () => {
  it("writes the trial entry + marker and prints the 3-line nudge", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      ttl: "1h",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      now: () => 1_700_000_000_000,
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);

    // Trial marker exists with expected shape.
    const markerPath = trialMarkerPath("demo", synthHome);
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as TrialMarker;
    expect(marker.slug).toBe("demo");
    expect(marker.expiresAt).toBe(1_700_000_000_000 + 3_600_000);
    expect(marker.entryName).toBe("yaw-mcp-try-demo");
    expect(marker.clientName).toBe("claude-code");

    // Client config has the entry with upstream command/args (NOT yaw-mcp's
    // npx invocation -- this is the spec contract).
    const clientPath = join(synthHome, ".claude.json");
    expect(existsSync(clientPath)).toBe(true);
    const client = JSON.parse(readFileSync(clientPath, "utf8"));
    const entry = client.mcpServers["yaw-mcp-try-demo"];
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "@demo/mcp"]);
    // The canonical yaw-mcp entry is NOT created by `try`.
    expect(client.mcpServers[ENTRY_NAME]).toBeUndefined();

    // No machine fingerprint persisted -- the .anon file is never created.
    expect(existsSync(legacyAnonPath(synthHome))).toBe(false);

    // 3-line nudge. The keep-it CTA points at the local `add` path -- the
    // hosted signup page it used to advertise is gone (404s).
    const text = cap.text();
    expect(text).toMatch(/Trial wired/);
    expect(text).toMatch(/Expires in 1h/);
    expect(text).toMatch(/Liking it\? Keep Demo MCP for good with: yaw-mcp add demo/);
    expect(text).not.toMatch(/Sign up|\/signup/);
  });

  it("reuses buildLaunchEntry's Windows cmd /c wrap for the trial entry", async () => {
    // Same upstream shape, OS=windows; entry must be { command: 'cmd',
    // args: ['/c', <command>, ...<args>] } -- the exact pattern
    // buildLaunchEntry encodes for the canonical yaw-mcp launcher.
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "windows",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);

    const clientPath = join(synthHome, ".claude.json");
    const client = JSON.parse(readFileSync(clientPath, "utf8"));
    const entry = client.mcpServers["yaw-mcp-try-demo"];
    expect(entry.command).toBe("cmd");
    expect(entry.args).toEqual(["/c", "npx", "-y", "@demo/mcp"]);

    // Sanity: same wrapping the canonical yaw-mcp entry uses.
    const canonical = buildLaunchEntry({ os: "windows" });
    expect(entry.command).toBe(canonical.command);
  });

  it("caret-escapes cmd metacharacters in catalog args on Windows (client-spawn injection guard)", async () => {
    // The trial entry is spawned by the MCP CLIENT, whose libuv only quotes
    // argv elements containing space/tab/quote -- so a catalog arg carrying a
    // bare `&` would reach cmd.exe unquoted and run the tail as a second
    // command at client-spawn time, with the config file looking innocuous.
    // `npx` is a `.cmd` shim: it forwards args through `%*`, which cmd RE-PARSES,
    // so a metachar must survive TWO cmd parses -- triple-caret (`^^^&`). The
    // single caret this once asserted was a no-op against the shim (bug #1).
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "windows",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({
        ...SAMPLE,
        args: ["-y", "@demo/mcp", "--url", "https://api/x?a=1&b=2"],
      }),
    });
    expect(r.exitCode).toBe(0);

    const clientPath = join(synthHome, ".claude.json");
    const client = JSON.parse(readFileSync(clientPath, "utf8"));
    const entry = client.mcpServers["yaw-mcp-try-demo"];
    expect(entry.command).toBe("cmd");
    expect(entry.args).toEqual(["/c", "npx", "-y", "@demo/mcp", "--url", "https://api/x?a=1^^^&b=2"]);
  });
});

describe("runTry — missing env vars", () => {
  it("refuses to wire the trial when a required env var is missing", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/needs the following env var/);
    expect(cap.errText()).toMatch(/FOO_TOKEN/);
    // Nothing written.
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(false);
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
  });

  it("accepts the env var via --env override", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      envOverrides: { FOO_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-demo"].env).toEqual({ FOO_TOKEN: "secret" });
    // Supplied via --env, NOT the ambient shell -- no ambient-source note.
    expect(cap.errText()).not.toMatch(/read from your shell env/);
  });

  it("persists an ambient-shell value inline and warns it was sourced from the shell", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      // Value present in the ambient shell env, NOT via --env.
      env: { FOO_TOKEN: "ambient-secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    // `try` (unlike `add`) copies the resolved value inline so the directly-
    // launched trial entry can see it.
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-demo"].env).toEqual({ FOO_TOKEN: "ambient-secret" });
    // And warns on stderr that the value came from the shell.
    expect(cap.errText()).toMatch(/FOO_TOKEN/);
    expect(cap.errText()).toMatch(/read from your shell env/);
  });
});

// `try` decides the perms of the client config through the mode it hands
// atomicWriteFile: an explicit 0o600 when the launch entry carries an inline
// secret, and NO mode at all when it does not -- withholding is what makes
// atomicWriteFile carry the target's existing mode forward instead of widening
// it (see the preservation tests in atomic-write.test.ts). That REQUEST is this
// module's behaviour; whether the filesystem then honours POSIX bits is the
// OS's, and Windows does not honour them at all (stat reports a synthetic
// 0o666), so the old stat().mode assertions ran on no machine -- this suite
// only ever runs on Windows.
//
// A POSIX platform is reported throughout for the same reason:
// `tightenPerms = entryHasSecrets && platform !== "win32"`, so without it the
// 0o600 arm is unreachable AND the negative arms would pass for the platform's
// reason instead of the no-secret reason they exist to pin.
//
// It arrives through runTry's own `platform` option rather than a
// defineProperty over the global. Redefining process.platform for the whole
// block also flipped atomicWriteFile into its POSIX single-attempt rename
// branch, so these six cases lost the EPERM/EBUSY/EACCES retry that exists for
// AV-scanner and indexer handle races -- on the very Windows machine this suite
// runs on, which is the only place that retry does anything.
describe("runTry — client config perms", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const clientPath = (): string => join(synthHome, ".claude.json");

  /** Passthrough spy over the write helper -- the config is still really
   *  written, we just get to see the mode that was asked for. */
  async function spyOnWrites(): Promise<MockInstance<typeof atomicWriteFile>> {
    const atomic = await import("../atomic-write.js");
    return vi.spyOn(atomic, "atomicWriteFile");
  }

  /** The mode argument of the write to `path`. `undefined` means no explicit
   *  mode was passed, i.e. "preserve whatever the target already had". */
  function modeAskedFor(spy: MockInstance<typeof atomicWriteFile>, path: string): number | undefined {
    const call = spy.mock.calls.find((c) => c[0] === path);
    expect(call, `${path} was never written; saw ${JSON.stringify(spy.mock.calls.map((c) => c[0]))}`).toBeDefined();
    // Guards the fixture, not the SUT: a write that escaped synthHome would
    // otherwise be reported as "no write at all" (see the env note above).
    for (const c of spy.mock.calls) expect(String(c[0]).startsWith(synthHome)).toBe(true);
    return call?.[3];
  }

  it("asks for an owner-only (0600) config when it creates one carrying a secret", async () => {
    const spy = await spyOnWrites();
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      platform: "linux",
      // An EMPTY ambient env, not the process's: runTry reads CLAUDE_CONFIG_DIR
      // out of it, so inheriting process.env resolves the "claude-code" target
      // to the real config dir of whoever runs the suite instead of to
      // synthHome. (These three cases were skipped on win32, so the fixture
      // had never been exercised on a machine that sets that variable.)
      env: {},
      envOverrides: { FOO_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    // Born owner-only rather than chmodded after the rename: there is no
    // window where the plaintext credential sits at the umask default.
    expect(modeAskedFor(spy, clientPath())).toBe(0o600);
    const client = JSON.parse(readFileSync(clientPath(), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-demo"].env).toEqual({ FOO_TOKEN: "secret" });
  });

  it("asks for 0600 when writing an inline secret into a pre-existing user file", async () => {
    // User's own content-bearing file. An explicit mode beats atomicWriteFile's
    // preserve-the-target's-mode default, so this TIGHTENS a config that was
    // group/other-readable: protecting the credential we just injected wins
    // over leaving the pre-existing perms alone.
    writeFileSync(clientPath(), JSON.stringify({ mcpServers: { alpha: { command: "x" } } }));
    const spy = await spyOnWrites();
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      platform: "linux",
      // An EMPTY ambient env, not the process's: runTry reads CLAUDE_CONFIG_DIR
      // out of it, so inheriting process.env resolves the "claude-code" target
      // to the real config dir of whoever runs the suite instead of to
      // synthHome. (These three cases were skipped on win32, so the fixture
      // had never been exercised on a machine that sets that variable.)
      env: {},
      envOverrides: { FOO_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    expect(modeAskedFor(spy, clientPath())).toBe(0o600);
    // ...and it really was the merge path: the user's own entry survived.
    const client = JSON.parse(readFileSync(clientPath(), "utf8"));
    expect(client.mcpServers.alpha.command).toBe("x");
  });

  it("asks for 0600 on an EMPTY pre-existing client file", async () => {
    // File exists but is empty -> `try` materializes its content, so it counts
    // as freshly created (the perms decision keys off content, not mere
    // existence). It must not be left at the umask default.
    writeFileSync(clientPath(), "");
    const spy = await spyOnWrites();
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      platform: "linux",
      // An EMPTY ambient env, not the process's: runTry reads CLAUDE_CONFIG_DIR
      // out of it, so inheriting process.env resolves the "claude-code" target
      // to the real config dir of whoever runs the suite instead of to
      // synthHome. (These three cases were skipped on win32, so the fixture
      // had never been exercised on a machine that sets that variable.)
      env: {},
      envOverrides: { FOO_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    expect(modeAskedFor(spy, clientPath())).toBe(0o600);
  });

  it("passes NO mode when the trial carries no secret, so the target's perms are preserved", async () => {
    // The other half of the contract: `try` must not force 0600, but it must
    // never LOOSEN either. atomicWriteFile renames a new inode over the target,
    // so before mode preservation this wrote a umask-default file over a 0600
    // one -- exposing whatever the user had already tightened it for (an
    // earlier trial's inline API key, or a hand chmod). Withholding the mode is
    // exactly how this path opts into preservation.
    writeFileSync(clientPath(), JSON.stringify({ mcpServers: { alpha: { env: { A_TOKEN: "s" } } } }));
    const spy = await spyOnWrites();
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      platform: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    expect(modeAskedFor(spy, clientPath())).toBeUndefined();
    // And the pre-existing secret-bearing entry is still there to protect.
    const client = JSON.parse(readFileSync(clientPath(), "utf8"));
    expect(client.mcpServers.alpha.env.A_TOKEN).toBe("s");
  });

  it("try-cleanup passes no mode either, so peeling a trial cannot widen the config", async () => {
    const cap1 = captureIO();
    await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      platform: "linux",
      env: {},
      out: cap1.pushOut,
      err: cap1.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    // Spy only around the cleanup, so the write under test is unambiguous.
    const spy = await spyOnWrites();
    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(modeAskedFor(spy, clientPath())).toBeUndefined();
    // The entry really was removed -- otherwise there was no write to judge.
    const client = JSON.parse(readFileSync(clientPath(), "utf8"));
    expect(client.mcpServers?.["yaw-mcp-try-demo"]).toBeUndefined();
  });

  it("does NOT tighten a freshly-created config when the trial entry carries no inline secret", async () => {
    // Negative arm: SAMPLE has requiredEnvVars:[] and no --env override, so the
    // trial entry's env resolves to undefined (entryHasSecrets === false) and
    // tightenPerms === false. Nothing secret was written, so `try` must not
    // force 0600 -- which is what stops a regression that unconditionally
    // tightens every config it touches.
    const spy = await spyOnWrites();
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      platform: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(clientPath())).toBe(true);
    expect(modeAskedFor(spy, clientPath())).toBeUndefined();
  });
});

describe("runTry — unparseable ttl (programmatic callers)", () => {
  it("errors out instead of silently substituting the 1h default", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      ttl: "later", // bypasses parseTryArgs -- programmatic caller bug
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(2);
    expect(cap.errText()).toMatch(/invalid ttl "later"/);
    // Nothing written.
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(false);
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
  });
});

describe("runTry — dry-run", () => {
  it("writes nothing, returns the marker, prints the would-be plan", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      dryRun: true,
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    expect(r.marker).toBeDefined();
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(false);
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
    expect(cap.text()).toMatch(/dry-run/);
  });
});

describe("runTry — slug validation", () => {
  it("refuses uppercase / slashes / dots", async () => {
    const cap = captureIO();
    for (const bad of ["Foo", "foo/bar", "foo.bar", "../bad", ""]) {
      const r = await runTry({
        slug: bad,
        clientId: "claude-code",
        home: synthHome,
        cwd: synthCwd,
        os: "linux",
        env: {},
        out: cap.pushOut,
        err: cap.pushErr,
        fetchExplore: async () => SAMPLE,
      });
      expect(r.exitCode).toBe(2);
    }
  });
});

describe("runTry — fetch failure", () => {
  it("surfaces the error and writes nothing", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => {
        throw new Error('yaw-mcp try: no server with slug "demo"');
      },
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/no server with slug/);
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(false);
  });
});

describe("runTry — preserves existing client config siblings", () => {
  it("does not stomp the canonical yaw-mcp entry or any other server", async () => {
    // Pre-populate ~/.claude.json with the canonical yaw-mcp entry and an
    // unrelated server.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({
        model: "claude-opus-4-7",
        mcpServers: {
          [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] },
          other: { command: "node", args: ["other.js"] },
        },
      }),
    );
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.model).toBe("claude-opus-4-7");
    expect(client.mcpServers[ENTRY_NAME]).toEqual({ command: "npx", args: ["-y", "@yawlabs/mcp@latest"] });
    expect(client.mcpServers.other).toEqual({ command: "node", args: ["other.js"] });
    expect(client.mcpServers["yaw-mcp-try-demo"]).toBeDefined();
  });
});

describe("runTry — unreadable vs invalid client config", () => {
  it("reports a read failure as a read failure, not as invalid JSON", async () => {
    // A directory where the config should be is the portable way to make
    // readFile fail (EISDIR); the real-world shape is a root-owned or
    // other-user-0600 ~/.claude.json (EACCES). Folding read and parse into one
    // catch told the user their JSON was invalid and sent them to inspect a
    // file they cannot even open.
    mkdirSync(join(synthHome, ".claude.json"), { recursive: true });
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/could not be read/);
    expect(cap.errText()).toMatch(/permissions/);
    expect(cap.errText()).not.toMatch(/not valid JSON/);
  });

  it("still reports genuinely invalid JSON as invalid JSON", async () => {
    writeFileSync(join(synthHome, ".claude.json"), "{ not json");
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/is not valid JSON/);
  });
});

describe("runTry — re-run against a different client", () => {
  it("peels the previous client's entry before the marker stops naming it", async () => {
    // The marker path is keyed on SLUG alone, so this re-run overwrites the
    // only record of the cursor wiring. Without the peel, the cursor entry --
    // inline secret included -- is orphaned past its TTL: try-cleanup reads
    // only the current marker and doctor's GC only walks markers.
    const cap1 = captureIO();
    await runTry({
      slug: "demo",
      clientId: "cursor",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      envOverrides: { D_TOKEN: "secret" },
      out: cap1.pushOut,
      err: cap1.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["D_TOKEN"] }),
    });
    const cursorPath = join(synthHome, ".cursor", "mcp.json");
    expect(JSON.parse(readFileSync(cursorPath, "utf8")).mcpServers["yaw-mcp-try-demo"]).toBeDefined();

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      envOverrides: { D_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["D_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    // Old client's entry is gone (and the user was told).
    expect(JSON.parse(readFileSync(cursorPath, "utf8")).mcpServers["yaw-mcp-try-demo"]).toBeUndefined();
    expect(cap.text()).toMatch(/Removed the previous demo trial/);
    // New client's entry is wired and the marker now points at it.
    const clientPath = join(synthHome, ".claude.json");
    expect(JSON.parse(readFileSync(clientPath, "utf8")).mcpServers["yaw-mcp-try-demo"]).toBeDefined();
    const marker = JSON.parse(readFileSync(trialMarkerPath("demo", synthHome), "utf8")) as TrialMarker;
    expect(marker.clientPath).toBe(clientPath);
  });

  it("leaves the entry alone when re-run against the SAME client", async () => {
    const common = {
      slug: "demo",
      clientId: "claude-code" as const,
      home: synthHome,
      cwd: synthCwd,
      os: "linux" as const,
      env: {},
      fetchExplore: async () => SAMPLE,
    };
    const cap1 = captureIO();
    await runTry({ ...common, out: cap1.pushOut, err: cap1.pushErr });
    const cap = captureIO();
    const r = await runTry({ ...common, ttl: "2h", out: cap.pushOut, err: cap.pushErr });
    expect(r.exitCode).toBe(0);
    // Same client + same entry name -> nothing to peel, no scary line.
    expect(cap.text()).not.toMatch(/Removed the previous/);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-demo"]).toBeDefined();
  });
});

describe("marker trust guards", () => {
  function writeMarker(slug: string, extra: Partial<TrialMarker>): string {
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const marker: TrialMarker = {
      schemaVersion: 1,
      slug,
      name: "Demo MCP",
      expiresAt: Date.now() - 1,
      clientPath: join(synthHome, ".claude.json"),
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: `yaw-mcp-try-${slug}`,
      createdAt: Date.now() - 3_600_000,
      ...extra,
    };
    const path = trialMarkerPath(slug, synthHome);
    writeFileSync(path, JSON.stringify(marker));
    return path;
  }

  it("try-cleanup refuses a marker naming a non-trial entry instead of deleting that key", async () => {
    // Blast radius without the guard: a hand-edited / corrupted marker makes
    // cleanup remove an ARBITRARY key from an arbitrary JSON file -- here the
    // canonical yaw-mcp launch entry.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { [ENTRY_NAME]: { command: "npx" } } }),
    );
    writeMarker("evil", { entryName: ENTRY_NAME });

    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "evil",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/non-trial entry/);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers[ENTRY_NAME]).toBeDefined();
  });

  it("scanTrials classifies a non-trial entryName as malformed rather than sweepable", async () => {
    writeMarker("evil", { entryName: ENTRY_NAME });
    const scan = await scanTrials({ home: synthHome });
    expect(scan.expired).toHaveLength(0);
    expect(scan.malformed).toHaveLength(1);
  });

  it("scanTrials classifies a marker with no clientName as malformed rather than printing 'undefined'", async () => {
    // clientName is not consumed by the peel, so it went unvalidated -- but
    // doctor renders it verbatim in the TRIALS section, so a hand-rolled
    // marker without it read out as `demo -> undefined (expires in 42m)`.
    writeMarker("nameless", { clientName: undefined as unknown as TrialMarker["clientName"] });
    const scan = await scanTrials({ home: synthHome });
    expect(scan.expired).toHaveLength(0);
    expect(scan.live).toHaveLength(0);
    expect(scan.malformed).toHaveLength(1);
    expect(scan.malformed[0]).toContain("nameless");
  });

  it("try-cleanup refuses a marker written by a NEWER yaw-mcp instead of peeling it", async () => {
    // The schemaVersion guard exists because a newer writer may mean something
    // different by containerPath/entryName; acting on it would delete a key we
    // do not understand. Refuse and leave both the marker and the entry alone.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({ mcpServers: { "yaw-mcp-try-future": { command: "npx" } } }),
    );
    const markerPath = writeMarker("future", { schemaVersion: 2 });

    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "future",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/newer yaw-mcp \(schemaVersion 2 > 1\)/);
    expect(cap.errText()).toMatch(/Delete it by hand if it is stale/);
    expect(cap.text()).not.toMatch(/cleaned up/);
    // Nothing touched: the marker survives for the user, the entry stays wired.
    expect(existsSync(markerPath)).toBe(true);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-future"]).toBeDefined();
  });

  it("scanTrials refuses a marker from a NEWER schema, but accepts one with the field absent", async () => {
    // Above our version = semantics we cannot know, so the GC does not guess.
    // Absent = older / hand-rolled marker, read as v1; rejecting those would
    // strand a live trial entry with nothing able to reclaim it.
    writeMarker("future", { schemaVersion: 2 });
    writeMarker("legacy", { schemaVersion: undefined as unknown as number });
    const scan = await scanTrials({ home: synthHome });
    expect(scan.malformed).toHaveLength(1);
    expect(scan.malformed[0]).toContain("future");
    expect(scan.expired.map((e) => e.marker.slug)).toEqual(["legacy"]);
  });

  it("GC leaves a future-schema marker on disk for the user to deal with", async () => {
    const path = writeMarker("future", { schemaVersion: 99 });
    const result = await gcExpiredTrials({ home: synthHome });
    expect(result.cleared).toBe(0);
    expect(existsSync(path)).toBe(true);
  });
});

describe("runTryCleanup", () => {
  it("leaves a BOM-prefixed config byte-identical when there is no entry to remove", async () => {
    // removeJsoncEntry's no-op used to return the de-BOM'd source, which reads
    // as "changed" here -- so cleanup rewrote a Notepad-saved ~/.claude.json,
    // stripped its BOM, and printed "Removed ..." having removed nothing.
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const clientPath = join(synthHome, ".claude.json");
    const original = ["﻿{", '  "mcpServers": { "other": { "command": "x" } }', "}", ""].join("\n");
    writeFileSync(clientPath, original, "utf8");
    const marker: TrialMarker = {
      schemaVersion: 1,
      slug: "demo",
      name: "Demo MCP",
      expiresAt: Date.now() + 3_600_000,
      clientPath,
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: "yaw-mcp-try-demo",
      createdAt: Date.now(),
    };
    writeFileSync(trialMarkerPath("demo", synthHome), JSON.stringify(marker));

    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    expect(readFileSync(clientPath, "utf8")).toBe(original);
    expect(cap.text()).not.toMatch(/Removed yaw-mcp-try-demo/);
  });

  it("removes the entry + marker, written contains client path", async () => {
    // Wire a trial first.
    const cap1 = captureIO();
    await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap1.pushOut,
      err: cap1.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(true);

    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(false);
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-demo"]).toBeUndefined();
    // Cleanup must not seed a machine fingerprint either.
    expect(existsSync(legacyAnonPath(synthHome))).toBe(false);
    // written must contain the client path because the entry was actually removed.
    expect(r.written).toContain(join(synthHome, ".claude.json"));
  });

  it("written is empty when the client config has no entry to remove", async () => {
    // Create a marker that points at a config file that no longer has the entry.
    mkdirSync(trialsDir(synthHome), { recursive: true });
    writeFileSync(join(synthHome, ".claude.json"), JSON.stringify({ mcpServers: {} }));
    const marker: TrialMarker = {
      schemaVersion: 1,
      slug: "demo",
      name: "Demo MCP",
      expiresAt: Date.now() + 3_600_000,
      clientPath: join(synthHome, ".claude.json"),
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: "yaw-mcp-try-demo",
      createdAt: Date.now(),
    };
    writeFileSync(trialMarkerPath("demo", synthHome), JSON.stringify(marker));

    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(0);
    // Nothing was written because the entry was already absent.
    expect(r.written).toEqual([]);
  });

  it("is a clean no-op when no trial is wired", async () => {
    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.text()).toMatch(/nothing to do/);
  });

  it("warns rather than silently skipping the peel when the client file is valid JSON but not an object", async () => {
    // Mirror of the GC case: a JSON array has no container for removeJsoncEntry
    // to name the entry in, so no peel is possible. Skipping that in SILENCE
    // and then printing "cleaned up" is the false all-clear over a plaintext
    // credential that gcExpiredTrials was fixed to refuse.
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const clientPath = join(synthHome, ".claude.json");
    writeFileSync(clientPath, "[]\n");
    const marker: TrialMarker = {
      schemaVersion: 1,
      slug: "demo",
      name: "Demo MCP",
      expiresAt: Date.now() + 3_600_000,
      clientPath,
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: "yaw-mcp-try-demo",
      createdAt: Date.now(),
    };
    writeFileSync(trialMarkerPath("demo", synthHome), JSON.stringify(marker));

    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(r.written).toEqual([]);
    expect(cap.errText()).toMatch(/couldn't strip yaw-mcp-try-demo/);
    expect(cap.errText()).toContain("is not a JSON object");
    // Nothing to peel means nothing written -- the file is left as found.
    expect(readFileSync(clientPath, "utf8")).toBe("[]\n");
    // Unlike doctor's GC (which keeps the marker so the next sweep retries),
    // the user-initiated cleanup still drops it -- the warning above is what
    // stops that from reading as a clean sweep.
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(false);
  });
});

describe("scanTrials + gcExpiredTrials", () => {
  it("classifies live vs expired markers correctly", async () => {
    const baseNow = 1_700_000_000_000;
    // Write two markers by hand: one expired, one live.
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const expiredMarker: TrialMarker = {
      schemaVersion: 1,
      slug: "old",
      name: "Old MCP",
      expiresAt: baseNow - 1,
      clientPath: join(synthHome, ".claude.json"),
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: "yaw-mcp-try-old",
      createdAt: baseNow - 3_600_000,
    };
    const liveMarker: TrialMarker = {
      ...expiredMarker,
      slug: "new",
      name: "New MCP",
      expiresAt: baseNow + 1_800_000,
      entryName: "yaw-mcp-try-new",
    };
    writeFileSync(trialMarkerPath("old", synthHome), JSON.stringify(expiredMarker));
    writeFileSync(trialMarkerPath("new", synthHome), JSON.stringify(liveMarker));

    const scan = await scanTrials({ home: synthHome, now: () => baseNow });
    expect(scan.expired.map((e) => e.marker.slug)).toEqual(["old"]);
    expect(scan.live.map((e) => e.marker.slug)).toEqual(["new"]);
  });

  it("treats unparseable markers as malformed instead of crashing", async () => {
    mkdirSync(trialsDir(synthHome), { recursive: true });
    writeFileSync(join(trialsDir(synthHome), "junk.json"), "{not json");
    const scan = await scanTrials({ home: synthHome });
    expect(scan.malformed).toHaveLength(1);
  });

  it("GC peels the expired entry out of the client config + deletes the marker", async () => {
    const baseNow = 1_700_000_000_000;
    // Pre-populate the client config with the entry the marker points at.
    writeFileSync(
      join(synthHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          [ENTRY_NAME]: { command: "npx", args: ["-y", "@yawlabs/mcp@latest"] },
          "yaw-mcp-try-old": { command: "npx", args: ["-y", "@old/mcp"] },
        },
      }),
    );
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const expiredMarker: TrialMarker = {
      schemaVersion: 1,
      slug: "old",
      name: "Old MCP",
      expiresAt: baseNow - 1,
      clientPath: join(synthHome, ".claude.json"),
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: "yaw-mcp-try-old",
      createdAt: baseNow - 3_600_000,
    };
    writeFileSync(trialMarkerPath("old", synthHome), JSON.stringify(expiredMarker));

    const result = await gcExpiredTrials({
      home: synthHome,
      now: () => baseNow,
    });
    expect(result.cleared).toBe(1);
    expect(result.failed).toBe(0);

    // Entry peeled out.
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-old"]).toBeUndefined();
    // Canonical yaw-mcp entry untouched.
    expect(client.mcpServers[ENTRY_NAME]).toBeDefined();
    // Marker file deleted.
    expect(existsSync(trialMarkerPath("old", synthHome))).toBe(false);
    // The GC sweep no longer seeds a machine fingerprint on its way through.
    expect(existsSync(legacyAnonPath(synthHome))).toBe(false);
  });

  it("GC is a no-op when no expired trials exist", async () => {
    const result = await gcExpiredTrials({ home: synthHome });
    expect(result.cleared).toBe(0);
  });

  it("GC unlinks the scanned marker file even when its filename doesn't match its slug", async () => {
    const baseNow = 1_700_000_000_000;
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const expiredMarker: TrialMarker = {
      schemaVersion: 1,
      slug: "old",
      name: "Old MCP",
      expiresAt: baseNow - 1,
      clientPath: join(synthHome, ".claude.json"),
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: "yaw-mcp-try-old",
      createdAt: baseNow - 3_600_000,
    };
    // Filename intentionally mismatches the slug field ("renamed" vs "old").
    // Unlinking via trialMarkerPath(marker.slug) would ENOENT, count as
    // failed, and leave the marker to re-fail on every doctor GC forever.
    const mismatchedPath = join(trialsDir(synthHome), "renamed.json");
    writeFileSync(mismatchedPath, JSON.stringify(expiredMarker));

    const result = await gcExpiredTrials({
      home: synthHome,
      now: () => baseNow,
    });
    expect(result.cleared).toBe(1);
    expect(result.failed).toBe(0);
    expect(existsSync(mismatchedPath)).toBe(false);
  });

  it("keeps the marker and reports a peel failure when the client file is valid JSON but not an object", async () => {
    // A JSON array throws nothing, so the peel was silently skipped and the
    // marker unlinked anyway -- orphaning a still-wired trial entry with
    // nothing left on disk that could ever name it again.
    const baseNow = 1_700_000_000_000;
    const clientPath = join(synthHome, ".claude.json");
    writeFileSync(clientPath, "[]\n");
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const expiredMarker: TrialMarker = {
      schemaVersion: 1,
      slug: "old",
      name: "Old MCP",
      expiresAt: baseNow - 1,
      clientPath,
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: "yaw-mcp-try-old",
      createdAt: baseNow - 3_600_000,
    };
    const markerPath = trialMarkerPath("old", synthHome);
    writeFileSync(markerPath, JSON.stringify(expiredMarker));

    const result = await gcExpiredTrials({
      home: synthHome,
      now: () => baseNow,
    });
    expect(result.cleared).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures[0].stage).toBe("peel");
    expect(result.failures[0].slug).toBe("old");
    // Marker survives so doctor keeps surfacing the still-wired trial.
    expect(existsSync(markerPath)).toBe(true);
  });

  it("reports stage 'unlink' when the entry peeled but the marker file could not be deleted", async () => {
    // The other half of the stage split, and the only path that produces the
    // "config is clean, only the marker lingers" wording. A DIRECTORY standing
    // where the marker file should be makes unlink fail on every platform; it
    // reaches the sweep through the `scan` seam because scanTrials would --
    // rightly -- call an unreadable marker malformed and never queue it.
    const baseNow = 1_700_000_000_000;
    const clientPath = join(synthHome, ".claude.json");
    writeFileSync(
      clientPath,
      JSON.stringify({ mcpServers: { "yaw-mcp-try-old": { command: "npx" }, keep: { command: "y" } } }),
    );
    const stuckMarkerPath = join(trialsDir(synthHome), "old.json");
    mkdirSync(stuckMarkerPath, { recursive: true });
    writeFileSync(join(stuckMarkerPath, "not-empty"), "x");
    const expiredMarker: TrialMarker = {
      schemaVersion: 1,
      slug: "old",
      name: "Old MCP",
      expiresAt: baseNow - 1,
      clientPath,
      clientName: "claude-code",
      containerPath: ["mcpServers"],
      entryName: "yaw-mcp-try-old",
      createdAt: baseNow - 3_600_000,
    };

    const result = await gcExpiredTrials({
      home: synthHome,
      scan: {
        live: [],
        expired: [{ marker: expiredMarker, path: stuckMarkerPath, msUntilExpiry: -1, expired: true }],
        malformed: [],
      },
    });
    expect(result.cleared).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures[0].stage).toBe("unlink");
    expect(result.failures[0].markerPath).toBe(stuckMarkerPath);
    // The peel really did land -- that is what makes "unlink" the honest stage.
    const client = JSON.parse(readFileSync(clientPath, "utf8"));
    expect(client.mcpServers["yaw-mcp-try-old"]).toBeUndefined();
    expect(client.mcpServers.keep).toBeDefined();
    // The unlink wording sends the user at the marker. The peel wording
    // ("still wired in", "run yaw-mcp try-cleanup") would send them at the
    // client config, which is already clean.
    const warning = trialGcFailureWarning(result.failures[0]);
    expect(warning).toContain("its entry was removed from");
    expect(warning).toContain(stuckMarkerPath);
    expect(warning).toContain("delete that marker by hand");
    expect(warning).not.toContain("still wired in");
  });
});

describe("runTryCleanup — marker field validation", () => {
  const baseMarker = (): Record<string, unknown> => ({
    schemaVersion: 1,
    slug: "demo",
    name: "Demo MCP",
    expiresAt: Date.now() + 3_600_000,
    clientPath: join(synthHome, ".claude.json"),
    clientName: "claude-code",
    containerPath: ["mcpServers"],
    entryName: "yaw-mcp-try-demo",
    createdAt: Date.now(),
  });

  function wireTrial(marker: Record<string, unknown>): { clientPath: string; markerPath: string } {
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const clientPath = join(synthHome, ".claude.json");
    writeFileSync(clientPath, JSON.stringify({ mcpServers: { "yaw-mcp-try-demo": { command: "npx" } } }));
    const markerPath = trialMarkerPath("demo", synthHome);
    writeFileSync(markerPath, JSON.stringify(marker));
    return { clientPath, markerPath };
  }

  it("refuses a marker with no clientPath instead of dropping it and printing 'cleaned up'", async () => {
    // The gate checked entryName only. existsSync(undefined) is false, so the
    // peel was skipped, the marker was unlinked, and the user was told the
    // trial was cleaned up -- while the entry stayed wired in the client
    // config with nothing left on disk naming it.
    const { clientPath, markerPath } = wireTrial({ ...baseMarker(), clientPath: undefined });

    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/is unreadable/);
    expect(cap.text()).not.toMatch(/cleaned up/);
    expect(existsSync(markerPath)).toBe(true);
    expect(JSON.parse(readFileSync(clientPath, "utf8")).mcpServers["yaw-mcp-try-demo"]).toBeDefined();
  });

  it("refuses a marker whose containerPath is not an array", async () => {
    const { markerPath } = wireTrial({ ...baseMarker(), containerPath: "mcpServers" });

    const cap = captureIO();
    const r = await runTryCleanup({
      slug: "demo",
      home: synthHome,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/is unreadable/);
    expect(existsSync(markerPath)).toBe(true);
  });
});

describe("runTry — previous marker naming the SAME client file", () => {
  it("does not re-insert the entry the step-6b peel just removed", async () => {
    const common = {
      slug: "demo",
      clientId: "claude-code" as const,
      home: synthHome,
      cwd: synthCwd,
      os: "linux" as const,
      env: {},
      fetchExplore: async (): Promise<ExploreServerResponse> => SAMPLE,
    };
    const cap1 = captureIO();
    await runTry({ ...common, out: cap1.pushOut, err: cap1.pushErr });
    const clientPath = join(synthHome, ".claude.json");

    // A previous trial of the same slug wired under a DIFFERENT entry name in
    // the SAME file (a renamed / hand-edited marker). Step 6b peels it out of
    // the file, but the splice was built from the bytes read BEFORE the peel,
    // so writing that render put the peeled entry straight back.
    const client = JSON.parse(readFileSync(clientPath, "utf8"));
    client.mcpServers["yaw-mcp-try-demo-old"] = { command: "npx", args: ["-y", "@old/mcp"] };
    writeFileSync(clientPath, JSON.stringify(client, null, 2));
    const markerPath = trialMarkerPath("demo", synthHome);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as TrialMarker;
    writeFileSync(markerPath, JSON.stringify({ ...marker, entryName: "yaw-mcp-try-demo-old" }));

    const cap = captureIO();
    const r = await runTry({ ...common, out: cap.pushOut, err: cap.pushErr });
    expect(r.exitCode).toBe(0);
    expect(cap.text()).toMatch(/Removed the previous demo trial/);
    const after = JSON.parse(readFileSync(clientPath, "utf8"));
    expect(after.mcpServers["yaw-mcp-try-demo-old"]).toBeUndefined();
    expect(after.mcpServers["yaw-mcp-try-demo"]).toBeDefined();
  });
});

describe("runTry — catalog URL threading", () => {
  async function runWithCatalogEnv(catalogEnv: Record<string, string>): Promise<Array<string | undefined>> {
    const seen: Array<string | undefined> = [];
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: catalogEnv,
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async (_slug, catalogUrl) => {
        seen.push(catalogUrl);
        return SAMPLE;
      },
    });
    expect(r.exitCode).toBe(0);
    return seen;
  }

  it("threads $YAW_MCP_CATALOG_URL from the injected env into the fetch seam", async () => {
    // Read from process.env inside the seam, an injected `env` was silently
    // overridden by the ambient environment -- the one lookup in runTry that
    // did not honor its own injection point.
    expect(await runWithCatalogEnv({ YAW_MCP_CATALOG_URL: "https://example.test/catalog.json" })).toEqual([
      "https://example.test/catalog.json",
    ]);
  });

  it("treats an EMPTY $YAW_MCP_CATALOG_URL as unset", async () => {
    // "" is not nullish, so it sailed past `??` into fetch(""), which throws a
    // bare TypeError the catalog's friendly wrapper cannot recognize.
    expect(await runWithCatalogEnv({ YAW_MCP_CATALOG_URL: "" })).toEqual([undefined]);
  });
});

describe("runTry — optional --env overrides", () => {
  it("trims override values and drops empty ones instead of persisting a blank var", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      envOverrides: { LOG_LEVEL: "", BLANK: "   ", DATABASE_URL: "  postgres://x  " },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    const entry = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8")).mcpServers["yaw-mcp-try-demo"];
    // `--env LOG_LEVEL=` is the user clearing a knob, not asking for a blank
    // one; several upstreams read a set-but-empty var as "configured".
    expect(entry.env).toEqual({ DATABASE_URL: "postgres://x" });
  });
});

describe("runTry — dry-run names the cross-client removal", () => {
  it("says a real run would peel the previous trial out of the other client's config", async () => {
    const cap1 = captureIO();
    await runTry({
      slug: "demo",
      clientId: "cursor",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap1.pushOut,
      err: cap1.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    const cursorPath = join(synthHome, ".cursor", "mcp.json");

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      dryRun: true,
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    // The preview must name every write the real run performs -- a removal it
    // omits is exactly what --dry-run is consulted to catch.
    expect(cap.text()).toMatch(/would remove: the previous demo trial/);
    expect(cap.text()).toContain(cursorPath);
    // ...and dry-run still wrote nothing.
    expect(JSON.parse(readFileSync(cursorPath, "utf8")).mcpServers["yaw-mcp-try-demo"]).toBeDefined();
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
  });

  it("does NOT promise to peel a previous marker the real run would refuse", async () => {
    // peelTrialEntry refuses an untrusted marker before touching anything, so
    // a preview built from the clientPath/entryName comparison ALONE printed
    // "would remove: ..." for a removal the real run declines with a warning.
    // A --dry-run that over-promises is worse than one that under-reports:
    // the user reads it as the plan and never checks the real output.
    const otherClient = join(synthHome, ".cursor", "mcp.json");
    mkdirSync(join(synthHome, ".cursor"), { recursive: true });
    writeFileSync(otherClient, JSON.stringify({ mcpServers: { "not-a-trial-entry": { command: "x", args: [] } } }));
    mkdirSync(trialsDir(synthHome), { recursive: true });
    writeFileSync(
      trialMarkerPath("demo", synthHome),
      JSON.stringify({
        schemaVersion: 1,
        slug: "demo",
        name: "Demo",
        expiresAt: Date.now() + 3_600_000,
        clientPath: otherClient,
        clientName: "cursor",
        containerPath: ["mcpServers"],
        // Not a `yaw-mcp-try-*` name: rejectUntrustedMarker refuses it.
        entryName: "not-a-trial-entry",
        createdAt: Date.now(),
      }),
    );

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      dryRun: true,
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.text()).not.toMatch(/would remove: the previous demo trial/);
    expect(cap.text()).toMatch(/would NOT remove: the previous demo marker names a non-trial entry/);
  });

  it("does NOT promise to peel an entry that is already gone from the other client's config", async () => {
    // Same over-promise from the other direction: the marker is perfectly
    // trustworthy, but the entry it names has already been removed from that
    // file by hand. The real run's peel returns "absent" and prints NOTHING,
    // so a preview that announces the removal describes a run that never
    // happens -- and the user reads the preview as the plan.
    const otherClient = join(synthHome, ".cursor", "mcp.json");
    mkdirSync(join(synthHome, ".cursor"), { recursive: true });
    writeFileSync(otherClient, JSON.stringify({ mcpServers: { unrelated: { command: "x", args: [] } } }));
    mkdirSync(trialsDir(synthHome), { recursive: true });
    writeFileSync(
      trialMarkerPath("demo", synthHome),
      JSON.stringify({
        schemaVersion: 1,
        slug: "demo",
        name: "Demo",
        expiresAt: Date.now() + 3_600_000,
        clientPath: otherClient,
        clientName: "cursor",
        containerPath: ["mcpServers"],
        entryName: "yaw-mcp-try-demo",
        createdAt: Date.now(),
      }),
    );

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      dryRun: true,
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.text()).not.toMatch(/would remove/);
    expect(cap.text()).not.toMatch(/would NOT remove/);
    // The preview's own no-op contract still holds: the other config is
    // untouched by the probe that decided not to promise anything.
    expect(JSON.parse(readFileSync(otherClient, "utf8")).mcpServers.unrelated).toBeDefined();
  });
});

describe("runTry — auto-detected client (no --client)", () => {
  // The CLI's DEFAULT invocation. Every other runTry test pins clientId, so
  // the branch that decides WHERE a secret-bearing entry gets written had no
  // coverage at all -- an INSTALL_TARGETS reorder could silently retarget it.
  //
  // `env: {}` is load-bearing here, not boilerplate: runTry reads
  // CLAUDE_CONFIG_DIR out of it and hands it to the probes, so an ambient one
  // (this dev shell sets it) would move claude-code's probe path outside
  // synthHome and make the result machine-dependent. `os` is pinned for the
  // same reason -- claude-desktop is unavailable on linux but available on
  // macos/windows, so the probe list itself differs by runner.

  it("picks the one client whose config already exists", async () => {
    // Only ~/.cursor/mcp.json is on disk, and synthCwd is empty, so
    // claude-code's user/project/local slots all miss and cursor is the first
    // existing slot in INSTALL_TARGETS order.
    mkdirSync(join(synthHome, ".cursor"), { recursive: true });
    const cursorPath = join(synthHome, ".cursor", "mcp.json");
    writeFileSync(cursorPath, JSON.stringify({ mcpServers: { existing: { command: "x" } } }));

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    expect(r.marker?.clientName).toBe("cursor");
    expect(r.marker?.clientPath).toBe(cursorPath);
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8"));
    expect(cursor.mcpServers["yaw-mcp-try-demo"].command).toBe("npx");
    expect(cursor.mcpServers.existing).toBeDefined();
    // Nothing was created for the client that merely COULD have been used.
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
  });

  it("falls back to claude-code when no client config exists at all", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    // claude-code is first in INSTALL_TARGETS and available on every OS, so
    // the "first merely AVAILABLE client" loop always lands here.
    expect(r.marker?.clientName).toBe("claude-code");
    const clientPath = join(synthHome, ".claude.json");
    expect(r.marker?.clientPath).toBe(clientPath);
    expect(JSON.parse(readFileSync(clientPath, "utf8")).mcpServers["yaw-mcp-try-demo"]).toBeDefined();
  });

  it("skips a client whose config exists but cannot be READ, like one that does not parse", async () => {
    // A directory at ~/.claude.json is the portable EISDIR; the real-world
    // shape is a root-owned or other-user-0600 file (EACCES). The probe
    // reports that as `unreadable`, not `malformed`, and auto-detect filtered
    // on malformed alone -- so it picked claude-code as "the client in use"
    // and runTry then aborted on the very read the probe had just watched
    // fail, while a readable ~/.cursor/mcp.json sat one slot further along.
    mkdirSync(join(synthHome, ".claude.json"), { recursive: true });
    mkdirSync(join(synthHome, ".cursor"), { recursive: true });
    const cursorPath = join(synthHome, ".cursor", "mcp.json");
    writeFileSync(cursorPath, JSON.stringify({ mcpServers: { existing: { command: "x" } } }));

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.errText()).not.toMatch(/could not be read/);
    expect(r.marker?.clientName).toBe("cursor");
    expect(r.marker?.clientPath).toBe(cursorPath);
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8"));
    expect(cursor.mcpServers["yaw-mcp-try-demo"].command).toBe("npx");
    expect(cursor.mcpServers.existing).toBeDefined();
  });
});

describe("runTry — vscode has no user scope", () => {
  it("writes the trial into .vscode/mcp.json under the cwd, keyed on `servers`", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "vscode",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    // vscode flips the scope to "project", so the trial lands in a WORKSPACE
    // file that is routinely committed. With no inline secret there is
    // nothing to publish, so no --yes is needed and nothing is said about it.
    expect(cap.errText()).toBe("");
    const workspacePath = join(synthCwd, ".vscode", "mcp.json");
    expect(existsSync(workspacePath)).toBe(true);
    const config = JSON.parse(readFileSync(workspacePath, "utf8"));
    // VS Code's top-level key is `servers`, not `mcpServers`.
    expect(config.servers["yaw-mcp-try-demo"].command).toBe("npx");
    expect(config.mcpServers).toBeUndefined();
    const marker = JSON.parse(readFileSync(trialMarkerPath("demo", synthHome), "utf8")) as TrialMarker;
    expect(marker.clientName).toBe("vscode");
    expect(marker.clientPath).toBe(workspacePath);
    expect(marker.containerPath).toEqual(["servers"]);
  });
});

describe("runTry -- inline secret bound for a project-scope (commit-to-share) file", () => {
  // The auto-detect scenario: a repo ships .vscode/mcp.json, the developer
  // has the token exported and no personal client config, and `yaw-mcp try`
  // picks vscode -- whose only scope is the workspace file -- and copies the
  // token inline into a file `git add -A` sweeps up. Nothing used to say so:
  // the only secret-location note was the ambient-only one, and the 0600
  // chmod protects local perms, not version control.
  const workspacePath = (): string => join(synthCwd, ".vscode", "mcp.json");

  function seedWorkspaceConfig(): void {
    mkdirSync(join(synthCwd, ".vscode"), { recursive: true });
    writeFileSync(workspacePath(), JSON.stringify({ servers: { existing: { command: "x" } } }));
  }

  it("refuses without --yes, names the file, the key and the hazard, and writes nothing", async () => {
    seedWorkspaceConfig();
    const before = readFileSync(workspacePath(), "utf8");
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      // No --client: auto-detect lands on vscode because its workspace file
      // is the only client config that exists.
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: { FOO_TOKEN: "ambient-secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.written).toEqual([]);
    // The workspace file is byte-identical and no marker was dropped.
    expect(readFileSync(workspacePath(), "utf8")).toBe(before);
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(false);
    const err = cap.errText();
    expect(err).toContain(workspacePath());
    expect(err).toMatch(/commit/i);
    expect(err).toContain("FOO_TOKEN");
    expect(err).not.toContain("ambient-secret");
    expect(err).toContain("--yes");
    // The way out that keeps the secret off the shared file.
    expect(err).toMatch(/--client claude-code/);
    expect(cap.text()).not.toMatch(/Trial wired/);
  });

  it("refuses under --dry-run too, so the preview never promises a write the real run declines", async () => {
    seedWorkspaceConfig();
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "vscode",
      dryRun: true,
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      envOverrides: { FOO_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(1);
    expect(cap.text()).not.toMatch(/would write/);
    expect(cap.errText()).toContain("--yes");
  });

  it("writes it with --yes, still warning on stderr", async () => {
    seedWorkspaceConfig();
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "vscode",
      yes: true,
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      envOverrides: { FOO_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.written).toContain(workspacePath());
    const config = JSON.parse(readFileSync(workspacePath(), "utf8"));
    expect(config.servers["yaw-mcp-try-demo"].env).toEqual({ FOO_TOKEN: "secret" });
    expect(config.servers.existing).toBeDefined();
    // --yes lifts the refusal, not the warning: the user is still told where
    // the plaintext value now lives.
    const err = cap.errText();
    expect(err).toContain(workspacePath());
    expect(err).toContain("FOO_TOKEN");
    expect(err).not.toContain("refusing");
    expect(cap.text()).toMatch(/Trial wired/);
  });

  it("never asks a user-scope target for --yes", async () => {
    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      envOverrides: { FOO_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["FOO_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    expect(cap.errText()).not.toContain("--yes");
    expect(cap.errText()).not.toMatch(/commit/i);
  });
});

describe("runTry — previous marker the real peel refuses", () => {
  it("warns on stderr, leaves the other file untouched, and still wires the new trial", async () => {
    // The dry-run twin of this is covered above; this is the REAL run, whose
    // warning is the only thing telling the user an entry is being left behind
    // ("the marker below no longer points at it").
    const otherClient = join(synthHome, ".cursor", "mcp.json");
    mkdirSync(join(synthHome, ".cursor"), { recursive: true });
    const untouched = JSON.stringify({ mcpServers: { "not-a-trial-entry": { command: "x", args: [] } } });
    writeFileSync(otherClient, untouched);
    mkdirSync(trialsDir(synthHome), { recursive: true });
    writeFileSync(
      trialMarkerPath("demo", synthHome),
      JSON.stringify({
        schemaVersion: 1,
        slug: "demo",
        name: "Demo",
        expiresAt: Date.now() + 3_600_000,
        clientPath: otherClient,
        clientName: "cursor",
        containerPath: ["mcpServers"],
        // Not a `yaw-mcp-try-*` name: rejectUntrustedMarker refuses it.
        entryName: "not-a-trial-entry",
        createdAt: Date.now(),
      }),
    );

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(0);
    expect(cap.errText()).toMatch(/couldn't remove the previous demo trial \(not-a-trial-entry\)/);
    expect(cap.errText()).toMatch(/the marker below no longer points at it/);
    // The refusal is the whole point: that key is NOT ours to delete.
    expect(readFileSync(otherClient, "utf8")).toBe(untouched);
    // ...and the run still completed, wiring the new trial.
    const client = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8"));
    expect(client.mcpServers["yaw-mcp-try-demo"]).toBeDefined();
  });
});

describe("runTry — env objects with their own lookup semantics", () => {
  it("resolves a required var through the injected env rather than a flattened copy", async () => {
    // Node's process.env is case-INSENSITIVE on Windows: a var the user stores
    // as `Github_Token` answers to process.env.GITHUB_TOKEN. Spreading it into
    // a plain object threw that away, so `try` reported a required var missing
    // that was sitting right there in the shell. This Proxy stands in for that
    // object; reading THROUGH it is the fix.
    const backing: Record<string, string> = { Github_Token: "ambient-secret" };
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      get: (_target, prop): string | undefined => {
        if (typeof prop !== "string") return undefined;
        const hit = Object.keys(backing).find((k) => k.toLowerCase() === prop.toLowerCase());
        return hit === undefined ? undefined : backing[hit];
      },
    });

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env,
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["GITHUB_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    expect(cap.errText()).not.toMatch(/needs the following env var/);
    const entry = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8")).mcpServers["yaw-mcp-try-demo"];
    // Written under the name the catalog asked for, with the shell's value.
    expect(entry.env).toEqual({ GITHUB_TOKEN: "ambient-secret" });
    // And it still counts as ambient-sourced, so the user is told it landed
    // inline on disk.
    expect(cap.errText()).toMatch(/read from your shell env/);
  });

  it("still lets an explicit --env override shadow the shell value", async () => {
    // The old spread gave overrides precedence; the lookup must too, including
    // the case where the shell has the var under a different spelling.
    const backing: Record<string, string> = { Github_Token: "ambient-secret" };
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      get: (_target, prop): string | undefined => {
        if (typeof prop !== "string") return undefined;
        const hit = Object.keys(backing).find((k) => k.toLowerCase() === prop.toLowerCase());
        return hit === undefined ? undefined : backing[hit];
      },
    });

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env,
      envOverrides: { GITHUB_TOKEN: "explicit" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["GITHUB_TOKEN"] }),
    });
    expect(r.exitCode).toBe(0);
    const entry = JSON.parse(readFileSync(join(synthHome, ".claude.json"), "utf8")).mcpServers["yaw-mcp-try-demo"];
    expect(entry.env).toEqual({ GITHUB_TOKEN: "explicit" });
    // Supplied via --env, so no ambient-source note.
    expect(cap.errText()).not.toMatch(/read from your shell env/);
  });
});

describe("runTry — trial marker write failure", () => {
  it("reports it and wires nothing, rather than writing a client entry no marker names", async () => {
    // The marker is written FIRST precisely so a crash can't leave an
    // unsweepable entry. If that write fails, the run has to stop there: going
    // on to write the client config would put a trial entry (inline secret and
    // all) on disk with nothing able to reclaim it. A plain FILE where
    // ~/.yaw-mcp should be makes the trials-dir mkdir fail with no mocking.
    writeFileSync(join(synthHome, ".yaw-mcp"), "not a directory");

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      envOverrides: { D_TOKEN: "secret" },
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => ({ ...SAMPLE, requiredEnvVars: ["D_TOKEN"] }),
    });
    expect(r.exitCode).toBe(1);
    expect(r.written).toEqual([]);
    expect(cap.errText()).toMatch(/failed to write trial marker/);
    // Crucially, the client config was never touched.
    expect(existsSync(join(synthHome, ".claude.json"))).toBe(false);
  });
});

describe("runTry — client-config write failure on a re-run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restores the previous marker instead of orphaning the entry it still names", async () => {
    // The marker is written BEFORE the client config, and the catch used to
    // unlink it unconditionally. On a re-run that is the wrong rollback: the
    // marker just overwritten named the PREVIOUS run's entry, which is still
    // live in the file this write failed on -- inline secret and all -- and
    // that marker was the only thing on disk naming it. Deleting it puts the
    // entry out of reach of both `try-cleanup` ("nothing to do") and doctor's
    // GC, over a plaintext credential, while the user reads "failed to write"
    // and concludes nothing was wired.
    const common = {
      slug: "demo",
      clientId: "claude-code" as const,
      home: synthHome,
      cwd: synthCwd,
      os: "linux" as const,
      env: {},
      envOverrides: { D_TOKEN: "secret" },
      fetchExplore: async (): Promise<ExploreServerResponse> => ({ ...SAMPLE, requiredEnvVars: ["D_TOKEN"] }),
    };
    const cap1 = captureIO();
    const first = await runTry({
      ...common,
      now: () => 1_700_000_000_000,
      out: cap1.pushOut,
      err: cap1.pushErr,
    });
    expect(first.exitCode).toBe(0);
    const markerPath = trialMarkerPath("demo", synthHome);
    const clientPath = join(synthHome, ".claude.json");
    const markerAfterFirstRun = readFileSync(markerPath, "utf8");
    const clientAfterFirstRun = readFileSync(clientPath, "utf8");

    // Fail only the client-config write; the marker write must still land so
    // the rollback has something to roll back.
    const atomic = await import("../atomic-write.js");
    const realWrite = atomic.atomicWriteFile;
    vi.spyOn(atomic, "atomicWriteFile").mockImplementation(async (path, contents, encoding, mode, dirMode) => {
      if (path === clientPath) throw new Error("EACCES: permission denied");
      await realWrite(path, contents, encoding, mode, dirMode);
    });

    const cap = captureIO();
    const r = await runTry({
      ...common,
      ttl: "2h",
      now: () => 1_700_000_777_000,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(1);
    expect(r.written).toEqual([]);
    expect(cap.errText()).toMatch(/failed to write .*EACCES/);
    // The marker is back to the FIRST run's bytes, byte for byte -- so it
    // still names the entry that is still wired, and both try-cleanup and
    // doctor's GC can reclaim it.
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf8")).toBe(markerAfterFirstRun);
    const restored = JSON.parse(readFileSync(markerPath, "utf8")) as TrialMarker;
    expect(restored.createdAt).toBe(1_700_000_000_000);
    expect(restored.entryName).toBe("yaw-mcp-try-demo");
    // ...and the entry it names really is still there, untouched.
    expect(readFileSync(clientPath, "utf8")).toBe(clientAfterFirstRun);
    expect(JSON.parse(clientAfterFirstRun).mcpServers["yaw-mcp-try-demo"].env).toEqual({ D_TOKEN: "secret" });
  });

  it("restores a previous marker whose step-6b peel FAILED, keeping the still-wired entry reachable", async () => {
    // The re-run targets a DIFFERENT client, so step 6b tries to peel the old
    // cursor entry -- but that peel is best-effort and can return "failed" on
    // an unreadable / unparseable / unwritable old client file. The entry is
    // then STILL live over there, so the "step 6b already peeled it" reasoning
    // that justifies an unconditional unlink does not hold: unlinking strands
    // the cursor entry (inline secret and all) past the reach of both
    // `try-cleanup` and doctor's GC, exactly as on the same-target re-run above.
    const common = {
      slug: "demo",
      home: synthHome,
      cwd: synthCwd,
      os: "linux" as const,
      env: {},
      envOverrides: { D_TOKEN: "secret" },
      fetchExplore: async (): Promise<ExploreServerResponse> => ({ ...SAMPLE, requiredEnvVars: ["D_TOKEN"] }),
    };
    const cap1 = captureIO();
    const first = await runTry({
      ...common,
      clientId: "cursor",
      now: () => 1_700_000_000_000,
      out: cap1.pushOut,
      err: cap1.pushErr,
    });
    expect(first.exitCode).toBe(0);
    const cursorPath = join(synthHome, ".cursor", "mcp.json");
    const clientPath = join(synthHome, ".claude.json");
    const markerPath = trialMarkerPath("demo", synthHome);
    const markerAfterFirstRun = readFileSync(markerPath, "utf8");
    const cursorAfterFirstRun = readFileSync(cursorPath, "utf8");

    // Fail the step-6b peel of the cursor file AND the new client write; the
    // marker write between them still lands, so there is something to roll back.
    const atomic = await import("../atomic-write.js");
    const realWrite = atomic.atomicWriteFile;
    vi.spyOn(atomic, "atomicWriteFile").mockImplementation(async (path, contents, encoding, mode, dirMode) => {
      if (path === cursorPath || path === clientPath) throw new Error("EACCES: permission denied");
      await realWrite(path, contents, encoding, mode, dirMode);
    });

    const cap = captureIO();
    const r = await runTry({
      ...common,
      clientId: "claude-code",
      now: () => 1_700_000_777_000,
      out: cap.pushOut,
      err: cap.pushErr,
    });
    expect(r.exitCode).toBe(1);
    expect(r.written).toEqual([]);
    expect(cap.errText()).toMatch(/couldn't remove the previous demo trial \(yaw-mcp-try-demo\)/);
    expect(cap.errText()).toMatch(/failed to write .*EACCES/);
    // The peel really did fail: the cursor entry is untouched, secret included.
    expect(readFileSync(cursorPath, "utf8")).toBe(cursorAfterFirstRun);
    expect(JSON.parse(cursorAfterFirstRun).mcpServers["yaw-mcp-try-demo"].env).toEqual({ D_TOKEN: "secret" });
    // ...so the marker naming it must be back, byte for byte.
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf8")).toBe(markerAfterFirstRun);
    const restored = JSON.parse(readFileSync(markerPath, "utf8")) as TrialMarker;
    expect(restored.clientPath).toBe(cursorPath);
    expect(restored.entryName).toBe("yaw-mcp-try-demo");
  });

  it("still unlinks when the peel 'failed' because the previous marker was REFUSED", async () => {
    // The other side of that gate. peelTrialEntry reports an untrusted marker
    // as "failed" too, but it refused before touching anything -- and every
    // other consumer (try-cleanup, doctor's GC) refuses it just the same, so
    // restoring it would only re-arm a marker nothing on disk will ever act on.
    // Consuming it is the deliberate behaviour; the stderr warning is what
    // tells the user to remove the entry by hand.
    const otherClient = join(synthHome, ".cursor", "mcp.json");
    mkdirSync(join(synthHome, ".cursor"), { recursive: true });
    writeFileSync(otherClient, JSON.stringify({ mcpServers: { "not-a-trial-entry": { command: "x", args: [] } } }));
    mkdirSync(trialsDir(synthHome), { recursive: true });
    const markerPath = trialMarkerPath("demo", synthHome);
    writeFileSync(
      markerPath,
      JSON.stringify({
        schemaVersion: 1,
        slug: "demo",
        name: "Demo",
        expiresAt: Date.now() + 3_600_000,
        clientPath: otherClient,
        clientName: "cursor",
        containerPath: ["mcpServers"],
        // Not a `yaw-mcp-try-*` name: rejectUntrustedMarker refuses it.
        entryName: "not-a-trial-entry",
        createdAt: Date.now(),
      }),
    );

    const clientPath = join(synthHome, ".claude.json");
    const atomic = await import("../atomic-write.js");
    const realWrite = atomic.atomicWriteFile;
    vi.spyOn(atomic, "atomicWriteFile").mockImplementation(async (path, contents, encoding, mode, dirMode) => {
      if (path === clientPath) throw new Error("EACCES: permission denied");
      await realWrite(path, contents, encoding, mode, dirMode);
    });

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(1);
    expect(cap.errText()).toMatch(/couldn't remove the previous demo trial \(not-a-trial-entry\)/);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("still unlinks the marker on a FIRST run, where nothing was wired before", async () => {
    // The other half of the gate: with no previous marker there is no entry to
    // keep reachable, and leaving a marker behind would have doctor report a
    // trial whose launch entry was never written.
    const clientPath = join(synthHome, ".claude.json");
    const atomic = await import("../atomic-write.js");
    const realWrite = atomic.atomicWriteFile;
    vi.spyOn(atomic, "atomicWriteFile").mockImplementation(async (path, contents, encoding, mode, dirMode) => {
      if (path === clientPath) throw new Error("EACCES: permission denied");
      await realWrite(path, contents, encoding, mode, dirMode);
    });

    const cap = captureIO();
    const r = await runTry({
      slug: "demo",
      clientId: "claude-code",
      home: synthHome,
      cwd: synthCwd,
      os: "linux",
      env: {},
      out: cap.pushOut,
      err: cap.pushErr,
      fetchExplore: async () => SAMPLE,
    });
    expect(r.exitCode).toBe(1);
    expect(existsSync(trialMarkerPath("demo", synthHome))).toBe(false);
  });
});
