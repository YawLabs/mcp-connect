// What oam-spawn SAYS at debug level about the things it declines: probeOam's
// diagnostic for an oam whose --version says nothing parsable (and its warn
// for an OAM_BIN naming a path that does not exist), and rewriteForOam's line
// for an npx launch it leaves on npx -- the one place the broker used to copy
// a server's whole argv into the log.
//
// Its own file for the same reason oam-pin-notice-debug.test.ts has one: the
// level has to be raised before oam-spawn's import graph is built, and a
// static import would pull logger.js in during hoisting -- i.e. before any
// statement in the file runs. (logger.js reads LOG_LEVEL per call today, but
// setting it before the import is correct either way, and this file must not
// depend on which of the two the logger is doing.)

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Set BEFORE the dynamic import below.
const priorLogLevel = process.env.LOG_LEVEL;
process.env.LOG_LEVEL = "debug";

const { MIN_OAM_VERSION, probeOam, resetOamBinCache, rewriteForOam, winNormalize } = await import("../oam-spawn.js");

// Put it back: vitest gives each FILE a fresh module registry, not a fresh
// process.env, so a worker reused for a later file would otherwise inherit
// debug -- and sibling files assert that certain notices stay SILENT.
afterAll(() => {
  if (priorLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = priorLogLevel;
});

/** Every log line written while `fn` runs. */
async function captureLines(fn: () => unknown): Promise<Array<Record<string, unknown>>> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks
    .join("")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("probeOam version-gate diagnostics", () => {
  beforeEach(() => resetOamBinCache());

  it("says so when a clean probe produced no version to gate on", async () => {
    // The probe only pipes stdout, so an oam that prints its version to
    // stderr exits 0 with nothing parsable -- which is treated as usable
    // (a working --version proves oam exists). The consequence is invisible:
    // the below-min branch is guarded on `version !== null`, so the
    // MIN_OAM_VERSION gate never ran for this binary, and the old-build hangs
    // it guards read as server bugs with nothing anywhere to connect them.
    const lines = await captureLines(() => probeOam(async () => "oam, the runtime\n"));
    const note = lines.find((l) => String(l.msg ?? "").includes("no parsable version"));
    expect(note, "a clean probe with no version said nothing at all").toBeDefined();
    // Debug, not warn: the binary works. This is context for a hang, not
    // something the user has to act on.
    expect(note?.level).toBe("debug");
    expect(note?.minVersion).toBe(MIN_OAM_VERSION);
  });

  it("stays quiet when the probe DID produce a version", async () => {
    // The gate ran, so there is nothing to report -- and a line per probe on
    // every working setup would be noise in the one log a hang is diagnosed
    // from.
    const lines = await captureLines(() => probeOam(async () => `oam ${MIN_OAM_VERSION}\n`));
    expect(lines.filter((l) => String(l.msg ?? "").includes("no parsable version"))).toEqual([]);
  });
});

/** The error `spawn` raises for a command that is not there, tagged the way
 *  node tags it -- the path is part of the message, which is what makes the
 *  failureDetail below name the stale OAM_BIN. */
function enoent(bin: string): Error {
  const err = new Error(`spawn ${bin} ENOENT`) as Error & { code?: string };
  err.code = "ENOENT";
  return err;
}

describe("probeOam ENOENT: absence vs a stale OAM_BIN", () => {
  const priorOamBin = process.env.OAM_BIN;
  /** An absolute path that cannot exist. `run` is injected, so nothing has to
   *  be on disk -- but the point of the case is that this path is NOT there. */
  const missingBin = join(tmpdir(), `yaw-mcp-no-such-oam-${process.pid}`, "oam");

  beforeEach(() => resetOamBinCache());

  afterEach(() => {
    resetOamBinCache();
    if (priorOamBin === undefined) delete process.env.OAM_BIN;
    else process.env.OAM_BIN = priorOamBin;
  });

  it("reports a configured-but-missing OAM_BIN as a failure, not as absence", async () => {
    // Classifying this as absence produced the "reinstall software you already
    // have" loop: doctor said "not installed" and handed over the installer,
    // running it changed nothing because OAM_BIN still wins, and the next
    // doctor said "not installed" again. `failure` is what routes it to
    // "installed but UNUSABLE" plus the OAM_BIN-pointing fix line instead.
    process.env.OAM_BIN = missingBin;

    let probe: Awaited<ReturnType<typeof probeOam>> | undefined;
    const lines = await captureLines(async () => {
      probe = await probeOam(async (bin) => {
        throw enoent(bin);
      });
    });

    expect(probe?.bin, "a missing binary must still fall back to node").toBeNull();
    expect(probe?.failure).toBe("spawn");
    // The stale path itself, so the report names what to fix rather than
    // telling the user to set a variable that is already set -- wrongly.
    expect(probe?.failureDetail).toContain(winNormalize(missingBin));

    const note = lines.find((l) => String(l.msg ?? "").includes("OAM_BIN points at a path that does not exist"));
    expect(note, "a stale OAM_BIN was swallowed silently").toBeDefined();
    // Warn, not debug: unlike an absent `oam`, this one the user has to fix.
    expect(note?.level).toBe("warn");
    expect(note?.bin).toBe(winNormalize(missingBin));
  });

  it("stays silent, and unclassified, when oam is simply not installed", async () => {
    // The other side of the split, and the reason it is a split at all: with
    // no OAM_BIN the name was ours to guess, so ENOENT is the routine
    // node-only machine. A warn here would fire on every one of them.
    delete process.env.OAM_BIN;

    let probe: Awaited<ReturnType<typeof probeOam>> | undefined;
    const lines = await captureLines(async () => {
      probe = await probeOam(async (bin) => {
        throw enoent(bin);
      });
    });

    expect(probe?.bin).toBeNull();
    expect(probe?.failure).toBeNull();
    expect(probe?.failureDetail).toBeNull();
    // Nothing at all, at debug level -- not merely nothing about OAM_BIN.
    expect(lines, "an absent oam is not an event worth a log line").toEqual([]);
  });
});

describe("rewriteForOam flag diagnostic", () => {
  it("names the flag and the argv length, never the argv, when an npx flag keeps a server on npx", async () => {
    // Everything after the flag belongs to the SERVER, and a server's args are
    // where a token rides. The logger does no redaction, and LOG_LEVEL=debug
    // is exactly what support asks a user to turn on before sending the
    // client's log files over -- this line used to copy the whole command
    // line, secret included, into them.
    const args = ["-y", "--package=some-mcp", "some-mcp", "--token", "hunter2-not-for-logs"];
    const lines = await captureLines(() =>
      rewriteForOam("npx", args, { oamBin: "oam", resolveEntry: () => "/pkgs/some-mcp/index.js" }),
    );

    const note = lines.find((l) => String(l.msg ?? "").includes("carries flags yaw-mcp does not parse"));
    expect(note, "the stay-on-npx decision said nothing at debug").toBeDefined();
    expect(note?.level).toBe("debug");
    // What a reader needs to see why oam was skipped: the flag, and how much
    // argv there was. Not the argv.
    expect(note?.flag).toBe("--package=some-mcp");
    expect(note?.argc).toBe(args.length);
    expect(JSON.stringify(note)).not.toContain("hunter2-not-for-logs");
  });
});
