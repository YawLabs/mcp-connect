import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveComplianceSuiteVersion } from "../audit-cmd.js";
import {
  COMPLIANCE_USAGE,
  createInterruptHandler,
  formatLaunchFailure,
  INTERRUPT_EXIT_CODE,
  isRenderableReport,
  locateComplianceSuite,
  PUBLISH_REMOVED_MESSAGE,
  resolveComplianceSuiteSpec,
  resolveNpxLaunch,
  resolveSuiteLaunch,
  runComplianceCommand,
  TERMINATED_EXIT_CODE,
} from "../compliance-cmd.js";

/** The path of the suite's launcher inside its package dir, separator-
 *  agnostic: the SUT joins with the host's path flavour. */
const LOCAL_BIN_RE = /node_modules[\\/]@yawlabs[\\/]mcp-compliance[\\/]bin[\\/]mcp-compliance\.mjs$/;

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

// Only the pre-spawn arg paths are exercised here (--help and missing
// <target>). Both return before spawning the mcp-compliance child, so these
// tests never launch the suite -- neither the installed copy nor npx.
describe("runComplianceCommand arg handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--help prints usage to stdout and exits 0 (does not spawn the sub-tool)", async () => {
    const cap = captureIo();
    const code = await runComplianceCommand(["--help"], cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toBe(COMPLIANCE_USAGE);
    expect(cap.err()).toBe("");
  });

  it("-h behaves like --help", async () => {
    const cap = captureIo();
    const code = await runComplianceCommand(["-h"], cap.io);
    expect(code).toBe(0);
    expect(cap.out()).toBe(COMPLIANCE_USAGE);
  });

  it("missing <target> prints usage to stderr and exits 2 (arg-error convention)", async () => {
    const cap = captureIo();
    const code = await runComplianceCommand([], cap.io);
    expect(code).toBe(2);
    expect(cap.err()).toBe(COMPLIANCE_USAGE);
    expect(cap.out()).toBe("");
  });

  // --publish was removed with the hosted backend (it POSTed to
  // /api/compliance/ext, which 404s).
  it("no longer advertises --publish", () => {
    expect(COMPLIANCE_USAGE).not.toContain("--publish");
  });

  it("--publish is rejected with an explanation and exit 2 (never reaches the child)", async () => {
    // Behavior, not docs. Unhandled, --publish falls through to runTest as a
    // stray extra arg and the user gets an opaque child-process error instead
    // of "that flag is gone". Exit 2 is load-bearing: the child path returns
    // the mcp-compliance exit code, which is only ever 0 or 1, so a 2 here
    // proves we short-circuited before spawn.
    const cap = captureIo();
    const code = await runComplianceCommand(["--publish"], cap.io);
    expect(code).toBe(2);
    expect(cap.err()).toBe(PUBLISH_REMOVED_MESSAGE);
    expect(cap.err()).toContain("no longer publishes compliance reports");
    expect(cap.out()).toBe("");
  });

  it("--publish is rejected even alongside a valid target", async () => {
    const cap = captureIo();
    const code = await runComplianceCommand(["https://example.com/mcp", "--publish"], cap.io);
    expect(code).toBe(2);
    expect(cap.err()).toBe(PUBLISH_REMOVED_MESSAGE);
  });

  it("--publish=<value> is rejected too, not just the bare flag", async () => {
    // A removed flag is the one a user is most likely to type with its old
    // ARGUMENT still attached (the retired backend took `--publish=public`).
    // An exact-match `argv.includes("--publish")` let that spelling through to
    // the child as an unrecognized extra arg -- exactly the opaque failure this
    // branch exists to replace, and only for the spelling people actually used.
    for (const spelling of ["--publish=public", "--publish=private", "--publish="]) {
      const cap = captureIo();
      const code = await runComplianceCommand(["https://example.com/mcp", spelling], cap.io);
      expect(code).toBe(2);
      expect(cap.err()).toBe(PUBLISH_REMOVED_MESSAGE);
      expect(cap.out()).toBe("");
    }
  });

  it("does not mistake a different flag that merely starts with --publish", async () => {
    // The prefix match is anchored on `--publish=`, not on "--publish": a
    // bare startsWith would swallow a hypothetical `--publisher` and refuse a
    // flag that was never removed. Spawn is mocked so the forwarding path can
    // be exercised without launching the suite.
    const report = {
      grade: "A",
      score: 100,
      url: "https://example.com/mcp",
      summary: { total: 1, passed: 1, failed: 0, required: 1, requiredPassed: 1 },
      tests: [],
    };
    const calls: string[][] = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => {
      const spawn = (_command: string, args: string[]) => {
        calls.push(args);
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          pid: number;
          kill: () => boolean;
        };
        child.stdout = new EventEmitter();
        child.pid = 4242;
        child.kill = () => true;
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from(JSON.stringify(report)));
          child.emit("close", 0);
        });
        return child;
      };
      return { spawn, default: { spawn } };
    });
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      const code = await mod.runComplianceCommand(["https://example.com/mcp", "--publisher"], cap.io);
      expect(code).toBe(0);
      expect(cap.err()).not.toContain("--publish was removed");
      // Forwarded to the child like any other extra arg.
      expect((calls[0] ?? []).join(" ")).toContain("--publisher");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("defaults to the real process streams when no io is injected", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const code = await runComplianceCommand(["--help"]);
    expect(code).toBe(0);
    expect(out).toHaveBeenCalledWith(COMPLIANCE_USAGE);
  });
});

// The FALLBACK spawn strategy, for a build with no @yawlabs/mcp-compliance
// installed beside it (resolveSuiteLaunch runs the installed bin first -- see
// its own block below). `spawn("npx.cmd", ...)` throws EINVAL synchronously on
// every patched Node on Windows (CVE-2024-27980 hardening), so the launcher
// resolves npm's npx-cli.js and runs it with the current node binary instead.
describe("resolveNpxLaunch", () => {
  it("prefers node + npx-cli.js beside node.exe (Windows layout)", () => {
    const launch = resolveNpxLaunch(["-y", "pkg"], {
      execPath: "C:\\nodejs\\node.exe",
      platform: "win32",
      // Separator-agnostic: the SUT builds candidates with path.join, which
      // emits "/" on a POSIX test runner and "\\" on Windows.
      exists: (p) => p.replace(/\\/g, "/").endsWith("nodejs/node_modules/npm/bin/npx-cli.js"),
    });
    expect(launch).not.toBeNull();
    expect(launch?.shell).toBe(false);
    expect(launch?.command).toBe("C:\\nodejs\\node.exe");
    expect(launch?.args[0]).toContain("npx-cli.js");
    expect(launch?.args.slice(1)).toEqual(["-y", "pkg"]);
    // The .cmd shim is never spawned -- that is the EINVAL path.
    expect(launch?.command).not.toContain("npx.cmd");
  });

  it("finds the POSIX <prefix>/lib/node_modules layout", () => {
    const launch = resolveNpxLaunch(["-y", "pkg"], {
      execPath: "/usr/local/bin/node",
      platform: "linux",
      exists: (p) => p.includes("lib") && p.endsWith("npx-cli.js"),
    });
    expect(launch?.shell).toBe(false);
    expect(launch?.command).toBe("/usr/local/bin/node");
    expect(launch?.args[0]).toContain("npx-cli.js");
  });

  it("falls back to a shell with every argument quoted when npx-cli.js is missing", () => {
    const launch = resolveNpxLaunch(["-y", "pkg", "npx -y server /tmp"], {
      execPath: "/usr/local/bin/node",
      platform: "linux",
      exists: () => false,
    });
    expect(launch?.shell).toBe(true);
    expect(launch?.command).toBe("npx");
    expect(launch?.args).toEqual(["'-y'", "'pkg'", "'npx -y server /tmp'"]);
  });

  it("refuses the shell fallback for arguments that cannot be quoted safely", () => {
    expect(
      resolveNpxLaunch(["-y", "pkg", "it's; rm -rf /"], {
        execPath: "/usr/local/bin/node",
        platform: "linux",
        exists: () => false,
      }),
    ).toBeNull();
    expect(
      resolveNpxLaunch(["-y", 'a"b'], { execPath: "C:\\nodejs\\node.exe", platform: "win32", exists: () => false }),
    ).toBeNull();
    expect(
      resolveNpxLaunch(["-y", "%PATH%"], { execPath: "C:\\nodejs\\node.exe", platform: "win32", exists: () => false }),
    ).toBeNull();
    expect(
      resolveNpxLaunch(["-y", "a\nb"], { execPath: "/usr/local/bin/node", platform: "linux", exists: () => false }),
    ).toBeNull();
  });

  // Built from a char code rather than typed as an escape so no editing layer
  // between here and disk can quietly halve the run -- the whole point of
  // these cases is the exact number of trailing backslashes.
  const BS = String.fromCharCode(92);

  it("refuses a win32 argument ending in a backslash (it would escape the closing quote)", () => {
    // quoteForShell wraps a win32 arg as `"<arg>"`. CommandLineToArgvW -- which
    // node uses to split the command line back into argv on the receiving side
    // -- reads a `\"` as a LITERAL quote, so a trailing backslash never closes
    // the quoted run and the NEXT argument is merged into this one. Before the
    // refusal this produced a launch whose argv was silently one element short.
    const target = `C:${BS}Program Files${BS}srv${BS}`;
    expect(
      resolveNpxLaunch(["-y", "pkg", target], {
        execPath: "C:\\nodejs\\node.exe",
        platform: "win32",
        exists: () => false,
      }),
    ).toBeNull();
    // A doubled trailing run is the same hazard: cmd hands the text through and
    // the receiving parser still sees the final `\` against the closing quote.
    expect(
      resolveNpxLaunch(["-y", `dir${BS}${BS}`], {
        execPath: "C:\\nodejs\\node.exe",
        platform: "win32",
        exists: () => false,
      }),
    ).toBeNull();
  });

  it("still accepts a win32 argument whose backslashes are interior", () => {
    // Only the TRAILING position is dangerous -- refusing every Windows path
    // would make the fallback useless on the platform it exists for.
    const launch = resolveNpxLaunch(["-y", `C:${BS}srv${BS}main.js`], {
      execPath: "C:\\nodejs\\node.exe",
      platform: "win32",
      exists: () => false,
    });
    expect(launch?.shell).toBe(true);
    expect(launch?.args).toEqual(['"-y"', `"C:${BS}srv${BS}main.js"`]);
  });

  it("leaves a trailing backslash alone on POSIX, where single quotes are literal", () => {
    // The refusal is a win32-quoting concern; `'a\'` is a perfectly good POSIX
    // single-quoted token and must not be collateral damage.
    const launch = resolveNpxLaunch(["-y", `dir${BS}`], {
      execPath: "/usr/local/bin/node",
      platform: "linux",
      exists: () => false,
    });
    expect(launch?.shell).toBe(true);
    expect(launch?.args).toEqual(["'-y'", `'dir${BS}'`]);
  });

  // Live smoke on THIS machine's node: the resolved launch must actually
  // start (no EINVAL). `npx --version` is offline and prints the npm version.
  it("the resolved launch actually spawns on this host", async () => {
    const launch = resolveNpxLaunch(["--version"]);
    expect(launch).not.toBeNull();
    // FAIL, don't skip. This used to be `if (!launch || launch.shell) return`,
    // which fired on any host where npx-cli.js is not beside the node binary
    // and left the whole case green with nothing smoked -- the only assertion
    // that ever ran was one resolveNpxLaunch can hardly fail. A host that
    // resolves only the shell fallback is precisely the broken-install case
    // worth hearing about, not a reason to pass quietly.
    expect(launch?.shell).toBe(false);
    // Narrowing only: the assertion above has already failed if launch is null.
    if (!launch) return;
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, { stdio: ["ignore", "ignore", "ignore"] });
      child.on("error", reject);
      child.on("close", resolve);
    });
    expect(code).toBe(0);
  }, 60_000);
});

// The diagnostic printed when EVERY strategy is out (no installed suite, no
// npx-cli.js on disk AND an argument we refuse to shell-quote). quoteForShell
// rejects a different character set per platform -- `%` only on win32, `'`
// only on POSIX -- so a message that always says "quotes / newlines" names
// nothing actually at fault for a percent-encoded target.
describe("formatLaunchFailure", () => {
  it("names the win32 character class and echoes the offending % argument", () => {
    const msg = formatLaunchFailure(["-y", "pkg", "https://example.com/%7Bid%7D"], "win32");
    // Two remedies remove the shell path outright: npm (npx-cli.js) and the
    // suite itself, which a reinstall of @yawlabs/mcp brings back beside it.
    expect(msg).toContain("Install npm");
    expect(msg).toContain("reinstall @yawlabs/mcp");
    expect(msg).toContain("not installed beside yaw-mcp");
    expect(msg).toContain("percent signs");
    expect(msg).toContain('"https://example.com/%7Bid%7D"');
    // `%` is inert on POSIX; don't send a Windows operator after single quotes.
    expect(msg).not.toContain("single quotes");
  });

  it("names the POSIX character class and echoes the offending ' argument", () => {
    const msg = formatLaunchFailure(["-y", "npx -y it's-a-server"], "linux");
    expect(msg).toContain("Install npm");
    expect(msg).toContain("single quotes");
    expect(msg).toContain("it's-a-server");
    // cmd.exe's %VAR% expansion is a win32-only concern.
    expect(msg).not.toContain("percent signs");
  });

  it("escapes a control character in the echoed argument instead of breaking the line", () => {
    const msg = formatLaunchFailure(["-y", "a\nb"], "linux");
    expect(msg).toContain('"a\\nb"');
    // 4 lines of prose + trailing newline; the echoed \n must not add one.
    expect(msg.split("\n")).toHaveLength(5);
  });

  it("still explains itself if no single argument is to blame (direct callers only)", () => {
    // Not a production shape: runComplianceCommand reaches formatLaunchFailure
    // only when resolveSuiteLaunch's npx fallback came back null, which
    // happens only after quoteForShell refused one of these same arguments --
    // so an offender is always found on that path and this branch is
    // defensive. Pinned anyway, because the alternative it guards against is
    // rendering `undefined` into the diagnostic if resolveNpxLaunch ever gains
    // another way to fail.
    const msg = formatLaunchFailure(["-y", "pkg"], "linux");
    expect(msg).toContain("Install npm");
    expect(msg).toContain("cannot be safely quoted");
    // Nothing is echoed, precisely because nothing is to blame.
    expect(msg).not.toContain("this argument");
  });

  it("names the trailing backslash and echoes the offending win32 path", () => {
    // The character class quoteForShell refuses has to stay in lockstep with
    // the sentence naming it: a path rejected for its trailing separator used
    // to be explained by a list that mentioned only quotes, percent signs,
    // newlines and NUL bytes -- none of which appear in it.
    const target = `C:${String.fromCharCode(92)}srv${String.fromCharCode(92)}`;
    const msg = formatLaunchFailure(["-y", "pkg", target], "win32");
    expect(msg).toContain("trailing backslash");
    expect(msg).toContain(JSON.stringify(target));
    // Still a win32-only concern; a POSIX operator must not see it.
    expect(formatLaunchFailure(["-y", "it's"], "linux")).not.toContain("trailing backslash");
  });
});

// Wiring: the unlaunchable path inside runComplianceCommand must print THAT
// message, not a hardcoded one. node:fs's existsSync is mocked so neither the
// installed suite's bin nor any npx-cli.js is "on disk" (the manifest is still
// read through node:fs/promises, so the fallback spec stays pinned), and the
// platform is pinned so the assertion holds on any CI runner. The command
// returns before spawning anything.
describe("runComplianceCommand unlaunchable path", () => {
  it("surfaces the platform-accurate message and exits 1 without spawning", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return { ...actual, default: actual, existsSync: () => false };
    });
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      const target = "https://example.com/%7Bid%7D";
      const code = await mod.runComplianceCommand([target], cap.io);
      expect(code).toBe(1);
      expect(cap.out()).toBe("");
      // Content first: the old text named only "quotes / newlines", neither of
      // which appears in this target -- `%` is what quoteForShell rejected.
      expect(cap.err()).toContain("percent signs");
      expect(cap.err()).toContain(target);
      // The argv the diagnostic is built from is the npx fallback's: the
      // pinned spec (this repo has the dependency, so the manifest resolves)
      // ahead of the suite's own subcommand and the target.
      const spec = await mod.resolveComplianceSuiteSpec();
      expect(spec).toMatch(/^@yawlabs\/mcp-compliance@\d/);
      expect(cap.err()).toBe(mod.formatLaunchFailure(["-y", spec, "test", "--format", "json", target], "win32"));
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

// printSummary does score.toFixed(1); a report that reaches it without a
// numeric score would crash the CLI with a raw TypeError, so the score check
// lives in the parse gate and routes to the "unexpected JSON" path instead.
describe("isRenderableReport", () => {
  // `url` is part of the fixture because the gate now checks it: printSummary
  // renders `Target: ${url}`, and the child is a separate process -- the
  // installed dependency, or npx at a pinned-when-resolvable version -- whose
  // output this one does not control, so a renamed field must route to the
  // "unexpected JSON" path rather than printing "Target: undefined".
  const base = {
    grade: "A",
    score: 91.5,
    url: "stdio:npx -y server",
    summary: { total: 1, passed: 1, failed: 0, required: 1, requiredPassed: 1 },
  };

  it("accepts a report with grade, summary and a finite numeric score", () => {
    expect(isRenderableReport(base)).toBe(true);
    expect(isRenderableReport({ ...base, score: 0 })).toBe(true);
  });

  // A truthy-but-empty summary used to pass the gate, and printSummary then
  // rendered "undefined/undefined passed, undefined/undefined required" with
  // exit 0 -- garbage presented as a clean result.
  it("rejects a summary missing the counters printSummary formats", () => {
    expect(isRenderableReport({ ...base, summary: {} })).toBe(false);
    expect(isRenderableReport({ ...base, summary: { total: 1, passed: 1 } })).toBe(false);
    expect(isRenderableReport({ ...base, summary: { ...base.summary, requiredPassed: "1" } })).toBe(false);
    expect(isRenderableReport({ ...base, summary: { ...base.summary, total: Number.NaN } })).toBe(false);
  });

  it("rejects a missing or non-string url", () => {
    expect(isRenderableReport({ grade: "A", score: 1, summary: base.summary })).toBe(false);
    expect(isRenderableReport({ ...base, url: 42 })).toBe(false);
  });

  // summary.failed is not rendered, so the gate must not demand it -- this
  // guard protects what is printed, it does not re-declare the child schema.
  it("does not require fields printSummary never renders", () => {
    const { failed: _failed, ...rest } = base.summary;
    expect(isRenderableReport({ ...base, summary: rest })).toBe(true);
  });

  it("rejects a missing, non-numeric or non-finite score", () => {
    expect(isRenderableReport({ grade: "A", summary: base.summary })).toBe(false);
    expect(isRenderableReport({ ...base, score: "91.5" })).toBe(false);
    expect(isRenderableReport({ ...base, score: null })).toBe(false);
    expect(isRenderableReport({ ...base, score: Number.NaN })).toBe(false);
  });

  it("still rejects a missing grade or summary", () => {
    expect(isRenderableReport({ score: 1, summary: base.summary })).toBe(false);
    expect(isRenderableReport({ grade: "A", score: 1 })).toBe(false);
    expect(isRenderableReport(null)).toBe(false);
    expect(isRenderableReport("nope")).toBe(false);
  });

  it("rejects a non-string grade instead of printing it as a letter", () => {
    // `grade` was checked for truthiness only, so a suite that switched the
    // field to a numeric score passed the gate and printSummary interpolated
    // it: "Compliance: 5 (91.5%)" reads as a letter grade of 5. Every other
    // rendered field is type-checked; this one was the hole.
    expect(isRenderableReport({ ...base, grade: 5 })).toBe(false);
    expect(isRenderableReport({ ...base, grade: true })).toBe(false);
    expect(isRenderableReport({ ...base, grade: ["A"] })).toBe(false);
    expect(isRenderableReport({ ...base, grade: { letter: "A" } })).toBe(false);
    // An empty string renders as "Compliance:  (91.5%)" -- also not a grade.
    expect(isRenderableReport({ ...base, grade: "" })).toBe(false);
    // The real shape still passes.
    expect(isRenderableReport({ ...base, grade: "F" })).toBe(true);
  });
});

// `compliance` and `audit` are two front doors onto the same suite, and they
// must grade under ONE rubric. `audit` imports the installed dependency and
// records its version as `suiteVersion` in grades.json. `compliance` first
// shelled out to `npx -y @yawlabs/mcp-compliance` with no pin, so it graded
// under whatever npm called latest; then to npx at the pinned version, which
// re-resolved the SAME package against the registry on every run (npx looks in
// the caller's project, never in yaw-mcp's own node_modules) and could not run
// at all on a machine without npm beside node. It now spawns the installed
// copy's own bin script with the current node binary; npx is the fallback for
// a build with no dependency beside it, still at the pinned spec whenever the
// manifest can be read.

/** Plant a fake @yawlabs/mcp-compliance install under `root` -- a manifest
 *  object, or raw bytes for an unparseable one -- and hand back a `fromUrl`
 *  for a module one directory below `root`, so the walk's first node_modules
 *  probe misses and its second finds the plant. */
function plantSuite(root: string, manifest: Record<string, unknown> | string): string {
  const dir = join(root, "node_modules", "@yawlabs", "mcp-compliance");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  const inner = join(root, "dist");
  mkdirSync(inner, { recursive: true });
  return pathToFileURL(join(inner, "compliance-cmd.js")).href;
}

describe("locateComplianceSuite", () => {
  it("finds this repo's install: its directory, its version and its bin script", async () => {
    const found = await locateComplianceSuite();
    expect(found).toBeDefined();
    expect(found?.dir.replace(/\\/g, "/")).toMatch(/node_modules\/@yawlabs\/mcp-compliance$/);
    // ONE lookup feeds the version `audit` records and the spec the fallback
    // pins, so the two commands cannot name different rubrics.
    expect(found?.version).toBe(await resolveComplianceSuiteVersion());
    expect(found?.version).toMatch(/^\d+\.\d+\.\d+/);
    // The map form is what the suite ships; the entry is read by name.
    expect(found?.bin).toBe("bin/mcp-compliance.mjs");
  });

  it("reads a single-string bin too, so a packaging change upstream cannot route every run through npx", async () => {
    const root = mkdtempSync(join(tmpdir(), "yaw-suite-locate-"));
    try {
      const found = await locateComplianceSuite(plantSuite(root, { version: "1.2.3", bin: "cli.mjs" }));
      expect(found).toMatchObject({ version: "1.2.3", bin: "cli.mjs" });
      expect(found?.dir.replace(/\\/g, "/")).toBe(`${root.replace(/\\/g, "/")}/node_modules/@yawlabs/mcp-compliance`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("no bin when the manifest names none or only other bins; no version when it is not a string", async () => {
    const root = mkdtempSync(join(tmpdir(), "yaw-suite-locate-"));
    try {
      expect(await locateComplianceSuite(plantSuite(root, { version: "1.2.3" }))).toMatchObject({
        version: "1.2.3",
        bin: undefined,
      });
      expect(await locateComplianceSuite(plantSuite(root, { version: 7, bin: { other: "x.js" } }))).toMatchObject({
        version: undefined,
        bin: undefined,
      });
      expect(await locateComplianceSuite(plantSuite(root, { version: "", bin: "" }))).toMatchObject({
        version: undefined,
        bin: undefined,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns undefined (never throws) for an unresolvable fromUrl or an unreadable nearest manifest", async () => {
    expect(await locateComplianceSuite("not-a-file-url")).toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), "yaw-suite-locate-"));
    try {
      // The nearest copy is the one `import()` loads; a bad manifest there
      // must not send the walk on to an ancestor's DIFFERENT install
      // (audit-cmd.test.ts pins the same rule through resolveComplianceSuiteVersion).
      expect(await locateComplianceSuite(plantSuite(root, "{ not json"))).toBeUndefined();
      expect(await locateComplianceSuite(plantSuite(root, "[1, 2]"))).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveSuiteLaunch", () => {
  const target = "https://example.com/mcp";

  it("runs the installed bin with the current node when it is on disk -- no npx, no shell", async () => {
    // `exists` answers yes ONLY to the suite's own launcher, which proves
    // that is the path probed -- not some npx-cli.js candidate.
    const res = await resolveSuiteLaunch([target], {
      execPath: "/usr/local/bin/node",
      platform: "linux",
      exists: (p) => LOCAL_BIN_RE.test(p),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.launch.via).toBe("local");
    expect(res.launch.shell).toBe(false);
    expect(res.launch.command).toBe("/usr/local/bin/node");
    expect(res.launch.args[0]).toMatch(LOCAL_BIN_RE);
    // The suite's subcommand and format ahead of the caller's args, verbatim.
    expect(res.launch.args.slice(1)).toEqual(["test", "--format", "json", target]);
    expect(res.launch.args.join(" ")).not.toContain("npx");
  });

  it("falls back to npx at the pinned spec when the installed bin is not on disk", async () => {
    // A pruned install: the manifest still reads (so the version is known)
    // but the script it names is gone. `exists` says yes only to npx-cli.js.
    const version = await resolveComplianceSuiteVersion();
    expect(version).toBeTypeOf("string");
    const res = await resolveSuiteLaunch([target], {
      execPath: "/usr/local/bin/node",
      platform: "linux",
      exists: (p) => p.endsWith("npx-cli.js"),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.launch.via).toBe("npx");
    expect(res.launch.shell).toBe(false);
    expect(res.launch.command).toBe("/usr/local/bin/node");
    expect(res.launch.args[0]).toContain("npx-cli.js");
    expect(res.launch.args.slice(1)).toEqual([
      "-y",
      `@yawlabs/mcp-compliance@${version}`,
      "test",
      "--format",
      "json",
      target,
    ]);
    expect(res.launch.args.join(" ")).not.toMatch(LOCAL_BIN_RE);
  });

  it("falls back to npx, still pinned, when the manifest names no bin", async () => {
    const root = mkdtempSync(join(tmpdir(), "yaw-suite-launch-"));
    try {
      const res = await resolveSuiteLaunch([target], {
        fromUrl: plantSuite(root, { version: "1.2.3" }),
        execPath: "/usr/local/bin/node",
        platform: "linux",
        exists: () => true,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.launch.via).toBe("npx");
      // The manifest was readable, so the rubric is still named.
      expect(res.launch.args).toContain("@yawlabs/mcp-compliance@1.2.3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the bare package name when no install can be read at all", async () => {
    const root = mkdtempSync(join(tmpdir(), "yaw-suite-launch-"));
    try {
      const res = await resolveSuiteLaunch([target], {
        fromUrl: plantSuite(root, "{ not json"),
        execPath: "/usr/local/bin/node",
        platform: "linux",
        exists: (p) => p.endsWith("npx-cli.js"),
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.launch.via).toBe("npx");
      // The oldest behaviour -- npx fetches latest -- rather than nothing.
      expect(res.launch.args.slice(1)).toEqual(["-y", "@yawlabs/mcp-compliance", "test", "--format", "json", target]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hands back the npx argv when nothing can launch, so the diagnostic can name the offender", async () => {
    const root = mkdtempSync(join(tmpdir(), "yaw-suite-launch-"));
    try {
      const bad = "https://example.com/%7Bid%7D";
      const res = await resolveSuiteLaunch([bad], {
        fromUrl: plantSuite(root, "{ not json"),
        execPath: "C:\\nodejs\\node.exe",
        platform: "win32",
        exists: () => false,
      });
      expect(res).toEqual({ ok: false, npxArgs: ["-y", "@yawlabs/mcp-compliance", "test", "--format", "json", bad] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Live smoke on THIS machine: the local launch must actually start under
  // the current node binary and answer offline. `--help` behind the suite's
  // own `test --format json` prints that subcommand's usage and exits 0
  // without touching any server. FAIL, don't skip: this repo installs the
  // dependency, so a host that resolves anything but the local bin is the
  // broken-install case worth hearing about.
  it("the local launch actually spawns on this host", async () => {
    const res = await resolveSuiteLaunch(["--help"]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.launch.via).toBe("local");
    expect(res.launch.command).toBe(process.execPath);
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(res.launch.command, res.launch.args, { stdio: ["ignore", "ignore", "ignore"] });
      child.on("error", reject);
      child.on("close", resolve);
    });
    expect(code).toBe(0);
  }, 60_000);
});

// Wiring: what runComplianceCommand actually hands to spawn.
describe("compliance suite launch", () => {
  it("pins the fallback spec to the dependency version audit records", async () => {
    const version = await resolveComplianceSuiteVersion();
    const spec = await resolveComplianceSuiteSpec();
    // This repo has the dependency installed, so the pin must resolve here.
    expect(version).toBeTypeOf("string");
    expect(spec).toBe(`@yawlabs/mcp-compliance@${version}`);
    // The unpinned spelling is precisely what regressed.
    expect(spec).not.toBe("@yawlabs/mcp-compliance");
  });

  /** doMock node:child_process with a spawn that records what it was handed
   *  and plays a complete report back. Call before the dynamic import. */
  function mockRecordingSpawn(): Array<{ command: string; args: string[]; opts: Record<string, unknown> }> {
    const report = {
      grade: "A",
      score: 100,
      url: "https://example.com/mcp",
      summary: { total: 1, passed: 1, failed: 0, required: 1, requiredPassed: 1 },
      tests: [],
    };
    const calls: Array<{ command: string; args: string[]; opts: Record<string, unknown> }> = [];
    vi.resetModules();
    vi.doMock("node:child_process", () => {
      const spawn = (command: string, args: string[], opts: Record<string, unknown> = {}) => {
        calls.push({ command, args, opts });
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          pid: number;
          kill: () => boolean;
        };
        child.stdout = new EventEmitter();
        child.pid = 4242;
        child.kill = () => true;
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from(JSON.stringify(report)));
          child.emit("close", 0);
        });
        return child;
      };
      return { spawn, default: { spawn } };
    });
    return calls;
  }

  it("spawns the installed suite directly -- the current node and its bin script, never npx", async () => {
    const calls = mockRecordingSpawn();
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      const code = await mod.runComplianceCommand(["https://example.com/mcp"], cap.io);
      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call?.command).toBe(process.execPath);
      expect(call?.args[0]).toMatch(LOCAL_BIN_RE);
      expect(call?.args.slice(1)).toEqual(["test", "--format", "json", "https://example.com/mcp"]);
      // Neither npm's npx entry nor a registry spec is anywhere in the argv:
      // this run never consults the registry.
      const flat = call?.args.join(" ") ?? "";
      expect(flat).not.toContain("npx");
      expect(flat).not.toContain("@yawlabs/mcp-compliance@");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("strips yaw-mcp's own secrets from the suite's env", async () => {
    // The suite is a registry package running arbitrary code. `audit` scrubs
    // process.env before its spawn; this command hands the child a stripped
    // COPY instead, so the rest of the env (PATH for one) still arrives while
    // the vault passphrase does not. README promises the strip for every
    // child yaw-mcp starts; this spawn inherited process.env whole.
    vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE", "hunter2-do-not-leak");
    const calls = mockRecordingSpawn();
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      await mod.runComplianceCommand(["https://example.com/mcp"], cap.io);
      expect(calls).toHaveLength(1);
      const env = calls[0]?.opts.env as NodeJS.ProcessEnv | undefined;
      expect(env, "spawn must pass an explicit env").toBeDefined();
      expect(env).not.toHaveProperty("YAW_MCP_VAULT_PASSPHRASE");
      expect(Object.keys(env ?? {}).length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("falls back to npx at the pinned spec when the installed bin is not on disk", async () => {
    const version = await resolveComplianceSuiteVersion();
    expect(version).toBeTypeOf("string");
    const calls = mockRecordingSpawn();
    // existsSync says no to the suite's bin and yes to npm's npx-cli.js -- the
    // pruned-install shape. The manifest is read through node:fs/promises,
    // which stays real, so the version is still known and the spec pinned.
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return { ...actual, default: actual, existsSync: (p: unknown) => !LOCAL_BIN_RE.test(String(p)) };
    });
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      const code = await mod.runComplianceCommand(["https://example.com/mcp"], cap.io);
      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call?.command).toBe(process.execPath);
      expect(call?.args[0]).toContain("npx-cli.js");
      expect(call?.args.slice(1)).toEqual([
        "-y",
        `@yawlabs/mcp-compliance@${version}`,
        "test",
        "--format",
        "json",
        "https://example.com/mcp",
      ]);
      // The bare name must not appear as a standalone spec token.
      expect(call?.args.join(" ")).not.toMatch(/@yawlabs\/mcp-compliance(?!@)/);
    } finally {
      vi.doUnmock("node:fs");
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});

// Registering a `process.once` SIGINT listener suppresses node's default "die
// on the signal" behaviour, so the handler owns the promise that the run ends.
// killTree is best-effort (it shells out to taskkill on Windows and swallows
// the error), and when it fails to land the first Ctrl-C was consumed for
// nothing: the CLI sat on a child that would never close until a SECOND
// interrupt -- the shape a user reads as a hang.
describe("createInterruptHandler", () => {
  it("force-exits when the kill did not take the child down within the grace window", () => {
    vi.useFakeTimers();
    try {
      let directKills = 0;
      const child = {
        pid: 4242,
        kill: () => {
          directKills += 1;
          return true;
        },
      } as unknown as Parameters<typeof createInterruptHandler>[0];
      const exits: number[] = [];
      // A killTree that does nothing -- the real win32 failure mode, where
      // taskkill cannot spawn and the error is deliberately swallowed.
      const handler = createInterruptHandler(child, {
        graceMs: 50,
        exit: (c) => exits.push(c),
        kill: () => {},
      });
      handler.onInterrupt();
      expect(exits).toEqual([]);
      vi.advanceTimersByTime(49);
      expect(exits).toEqual([]);
      vi.advanceTimersByTime(1);
      // Direct kill first (it reaches the wrapper even when the tree walk
      // failed), then the forced exit so ONE Ctrl-C always ends the run.
      expect(directKills).toBe(1);
      expect(exits).toEqual([INTERRUPT_EXIT_CODE]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not force-exit when the run settles first", () => {
    vi.useFakeTimers();
    try {
      const child = { pid: 1, kill: () => true } as unknown as Parameters<typeof createInterruptHandler>[0];
      const exits: number[] = [];
      const handler = createInterruptHandler(child, { graceMs: 50, exit: (c) => exits.push(c), kill: () => {} });
      handler.onInterrupt();
      handler.cancel();
      vi.advanceTimersByTime(5000);
      expect(exits).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms exactly one fallback no matter how many interrupts arrive", () => {
    vi.useFakeTimers();
    try {
      const child = { pid: 1, kill: () => true } as unknown as Parameters<typeof createInterruptHandler>[0];
      const exits: number[] = [];
      let killTreeCalls = 0;
      const handler = createInterruptHandler(child, {
        graceMs: 50,
        exit: (c) => exits.push(c),
        kill: () => {
          killTreeCalls += 1;
        },
      });
      handler.onInterrupt();
      handler.onInterrupt();
      handler.onInterrupt();
      // Every interrupt still re-attempts the kill -- only the timer is single.
      expect(killTreeCalls).toBe(3);
      vi.advanceTimersByTime(5000);
      expect(exits).toEqual([INTERRUPT_EXIT_CODE]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// `--strict` and `--min-grade` are forwarded to the child verbatim, and their
// ONLY effect is a non-zero exit -- the JSON report is identical either way.
// Swallowing the child's code made both flags silent no-ops through yaw-mcp:
// a CI gate printed "Grade F is below threshold A" and exited 0.
describe("runComplianceCommand child exit propagation", () => {
  const report = {
    grade: "F",
    score: 12,
    url: "https://example.com/mcp",
    summary: { total: 10, passed: 2, failed: 8, required: 5, requiredPassed: 1 },
    tests: [],
  };

  // `bytes` defaults to the fixture report above; the report-failure cases
  // below hand it stdout the parse gate is meant to reject.
  async function runWithChildExit(exitCode: number | null, bytes: Buffer = Buffer.from(JSON.stringify(report))) {
    vi.resetModules();
    vi.doMock("node:child_process", () => {
      const spawn = (): EventEmitter & { stdout: EventEmitter; pid: number; kill: () => boolean } => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          pid: number;
          kill: () => boolean;
        };
        child.stdout = new EventEmitter();
        child.pid = 4242;
        child.kill = () => true;
        setImmediate(() => {
          child.stdout.emit("data", bytes);
          child.emit("close", exitCode);
        });
        return child;
      };
      return { spawn, default: { spawn } };
    });
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      const code = await mod.runComplianceCommand(["https://example.com/mcp", "--min-grade", "A"], cap.io);
      return { code, out: cap.out(), err: cap.err() };
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  }

  it("propagates a non-zero child exit while still printing the report", async () => {
    const r = await runWithChildExit(1);
    expect(r.code).toBe(1);
    // The report is NOT suppressed -- the user still sees why the gate failed.
    expect(r.out).toContain("Compliance: F");
    expect(r.out).toContain("2/10 passed, 1/5 required");
  });

  it("stays 0 when the child exits cleanly", async () => {
    const r = await runWithChildExit(0);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Compliance: F");
  });

  it("reports a signal death (null code) as 1", async () => {
    const r = await runWithChildExit(null);
    expect(r.code).toBe(1);
  });

  // isRenderableReport is exhaustively unit-tested; its only PRODUCTION caller
  // was not. If the guard or its resolve(null) broke, an offline or
  // misconfigured run would print a raw TypeError out of printSummary instead
  // of a one-line diagnostic, and the CLI would die on an unhandled rejection
  // rather than exit 1.
  it("routes parseable-but-unrenderable JSON to the unexpected-JSON diagnostic", async () => {
    // A string score is the crash case: printSummary calls score.toFixed(1).
    const r = await runWithChildExit(0, Buffer.from(JSON.stringify({ ...report, score: "91.5" })));
    expect(r.code).toBe(1);
    expect(r.err).toContain("mcp-compliance returned unexpected JSON (exit 0)");
    // printSummary is never reached -- nothing at all lands on stdout.
    expect(r.out).toBe("");
  });

  it("reports unparseable stdout with the child's exit code and prints no summary", async () => {
    const r = await runWithChildExit(3, Buffer.from("not json"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("mcp-compliance exited 3 without valid JSON output");
    expect(r.out).toBe("");
  });

  it("reassembles a multi-byte UTF-8 sequence split across two pipe chunks", async () => {
    // A report bigger than the pipe's highWaterMark arrives in multiple
    // Buffer chunks, and the split lands wherever the kernel cuts it --
    // including MID-character. Decoding each chunk on its own turned both
    // halves into U+FFFD, silently corrupting the field the split landed in.
    const utf8Report = {
      grade: "B",
      score: 88,
      url: "https://exämple.com/mcp",
      summary: { total: 10, passed: 9, failed: 1, required: 5, requiredPassed: 5 },
      tests: [],
    };
    const bytes = Buffer.from(JSON.stringify(utf8Report), "utf8");
    // Cut INSIDE the two-byte "ä" sequence (0xc3 0xa4).
    const cut = bytes.indexOf(0xc3) + 1;
    expect(cut).toBeGreaterThan(0);
    vi.resetModules();
    vi.doMock("node:child_process", () => {
      const spawn = (): EventEmitter & { stdout: EventEmitter; pid: number; kill: () => boolean } => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          pid: number;
          kill: () => boolean;
        };
        child.stdout = new EventEmitter();
        child.pid = 4242;
        child.kill = () => true;
        setImmediate(() => {
          child.stdout.emit("data", bytes.subarray(0, cut));
          child.stdout.emit("data", bytes.subarray(cut));
          child.emit("close", 0);
        });
        return child;
      };
      return { spawn, default: { spawn } };
    });
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      const code = await mod.runComplianceCommand(["https://example.com/mcp"], cap.io);
      expect(code).toBe(0);
      expect(cap.out()).toContain("https://exämple.com/mcp");
      expect(cap.out()).not.toContain("�");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});

// A mock child with a deliberately UNDEFINED pid. Every case below reaches the
// real killTree, and with no pid it takes the plain `child.kill()` path instead
// of signalling a process group (POSIX) or shelling out to taskkill (win32)
// against a pid this file invented.
type MockChild = EventEmitter & { stdout: EventEmitter; pid: number | undefined; kill: () => boolean };

/** doMock node:child_process with a spawn that hands the started child back to
 *  the caller. Resolves the moment runTest spawns, so the test can drive
 *  stdout, signals and close explicitly instead of racing setImmediate. */
function mockSpawnedChild(onKill: () => void = () => {}): Promise<MockChild> {
  let started: (c: MockChild) => void = () => {};
  const child = new Promise<MockChild>((resolve) => {
    started = resolve;
  });
  vi.resetModules();
  vi.doMock("node:child_process", () => {
    const spawn = (): MockChild => {
      const c = new EventEmitter() as MockChild;
      c.stdout = new EventEmitter();
      c.pid = undefined;
      c.kill = () => {
        onKill();
        return true;
      };
      started(c);
      return c;
    };
    return { spawn, default: { spawn } };
  });
  return child;
}

// The two child guardrails -- a 5-minute wall-clock timeout and a 16 MB stdout
// cap -- had never executed in a test, so the kill-and-resolve sequencing they
// share (settled flag, clearTimeout, releaseSignals, killTree) was unverified
// in the exact two paths that also call the real killTree.
describe("runComplianceCommand child guardrails", () => {
  it("kills a hung child and exits 1 when the wall-clock timeout fires", async () => {
    let kills = 0;
    const started = mockSpawnedChild(() => {
      kills += 1;
    });
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      // Fake timers only AFTER the dynamic import -- module resolution is real
      // I/O, and so is the install lookup inside the command, which settles
      // under fake timers because it is fs work rather than a timer.
      vi.useFakeTimers();
      const pending = mod.runComplianceCommand(["https://example.com/mcp"], cap.io);
      // Awaiting the spawned child proves the timeout below is already armed.
      const child = await started;
      // No stdout at all: the hung-server case the timeout exists for.
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(await pending).toBe(1);
      expect(cap.err()).toBe("\nmcp-compliance timed out after 300s; killed.\n");
      expect(cap.out()).toBe("");
      expect(kills).toBe(1);
      // A close arriving after the kill must not double-resolve or print a
      // second diagnostic -- the settled flag is the only thing stopping it.
      child.emit("close", null);
      expect(cap.err()).toBe("\nmcp-compliance timed out after 300s; killed.\n");
      expect(cap.out()).toBe("");
    } finally {
      vi.useRealTimers();
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("kills the child and exits 1 when stdout blows past the 16 MB cap", async () => {
    let kills = 0;
    const started = mockSpawnedChild(() => {
      kills += 1;
    });
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      const pending = mod.runComplianceCommand(["https://example.com/mcp"], cap.io);
      const child = await started;
      // One chunk past the cap: the guard counts running bytes per chunk, so it
      // fires on arrival rather than buffering the whole stream to close.
      child.stdout.emit("data", Buffer.alloc(17 * 1024 * 1024));
      expect(await pending).toBe(1);
      expect(cap.err()).toBe("\nmcp-compliance produced more than 16 MB of output; killed.\n");
      expect(cap.out()).toBe("");
      expect(kills).toBe(1);
      child.emit("close", null);
      expect(cap.err()).toBe("\nmcp-compliance produced more than 16 MB of output; killed.\n");
      expect(cap.out()).toBe("");
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});

// Ctrl-C used to read as a malfunction of the tool. Installing the SIGINT
// listener SUPPRESSES node's die-on-signal, so the killed child's close event
// fell into the "exited N without valid JSON output" branch: the message named
// nothing the operator had done, and the status was 1 -- indistinguishable
// from a genuine parse failure or a --min-grade gate failure, which is exactly
// the discrimination INTERRUPT_EXIT_CODE exists to provide.
describe("runComplianceCommand cancellation", () => {
  const report = {
    grade: "F",
    score: 12,
    url: "https://example.com/mcp",
    summary: { total: 10, passed: 2, failed: 8, required: 5, requiredPassed: 1 },
    tests: [],
  };

  /** Invoke the listener runTest just registered, rather than
   *  `process.emit(signal)`: emitting the real signal name on the test worker
   *  would also wake vitest's own handlers. Ours is the most recent. */
  function fireSignal(signal: NodeJS.Signals): void {
    const listeners = process.listeners(signal);
    const handler = listeners[listeners.length - 1];
    expect(handler).toBeTypeOf("function");
    handler(signal);
  }

  async function runCancelled(signal: NodeJS.Signals, bytes: Buffer, closeCode: number | null) {
    const started = mockSpawnedChild();
    try {
      const mod = await import("../compliance-cmd.js");
      const cap = captureIo();
      const pending = mod.runComplianceCommand(["https://example.com/mcp", "--min-grade", "A"], cap.io);
      const child = await started;
      if (bytes.length > 0) child.stdout.emit("data", bytes);
      fireSignal(signal);
      // The kill lands and the child closes, leaving whatever partial (or
      // absent) stdout it had already written.
      child.emit("close", closeCode);
      return { code: await pending, out: cap.out(), err: cap.err() };
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  }

  it("reports Ctrl-C as an interruption with the 130 status", async () => {
    const r = await runCancelled("SIGINT", Buffer.from(""), null);
    expect(r.code).toBe(INTERRUPT_EXIT_CODE);
    expect(r.err).toBe("\nmcp-compliance interrupted.\n");
    // The message this replaces named a malfunction, not a cancellation.
    expect(r.err).not.toContain("without valid JSON output");
    expect(r.out).toBe("");
  });

  it("treats a report truncated by the kill as a cancellation, not unexpected JSON", async () => {
    // A child killed mid-write can leave stdout that still parses but fails the
    // render gate. That is the same cancellation, not a broken suite.
    const r = await runCancelled("SIGINT", Buffer.from(JSON.stringify({ grade: "A" })), null);
    expect(r.code).toBe(INTERRUPT_EXIT_CODE);
    expect(r.err).toBe("\nmcp-compliance interrupted.\n");
    expect(r.err).not.toContain("unexpected JSON");
  });

  it("reports SIGTERM as 143 rather than the interrupt's 130", async () => {
    // SIGTERM shares SIGINT's handler (one child, one teardown), so both used
    // to end 130 -- a wrapper could not tell a supervisor kill from a Ctrl-C.
    const r = await runCancelled("SIGTERM", Buffer.from(""), null);
    expect(r.code).toBe(TERMINATED_EXIT_CODE);
    expect(r.code).not.toBe(INTERRUPT_EXIT_CODE);
    expect(r.err).toBe("\nmcp-compliance interrupted.\n");
  });

  it("keeps the child's real verdict when a complete report beat the signal", async () => {
    // The race: the child finished as the signal arrived. A renderable report
    // is still a result, and reporting 130 would swallow the --min-grade
    // verdict its exit code carries.
    const r = await runCancelled("SIGINT", Buffer.from(JSON.stringify(report)), 1);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Compliance: F");
    expect(r.err).toBe("");
  });
});
