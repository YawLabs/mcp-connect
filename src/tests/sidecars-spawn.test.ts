// `sidecars install`'s DEFAULT npm runner -- the one that actually spawns.
//
// The sibling sidecars-cmd.test.ts injects `runNpm` everywhere, which is the
// right shape for the collect/manifest/report logic but structurally cannot
// observe the spawn. That left the spawn options untested, and BOTH production
// bugs this file has had lived exactly there: npm failing EINVAL on Windows
// because Node will not exec a .cmd shim without a shell, and the child's
// stdout being inherited so npm's progress landed ahead of the JSON document
// and made `--json` unparseable. Both were caught by hand. Neither would have
// survived this file.
//
// Split out (rather than added to the sibling) because the mock is
// module-scoped -- same reason oam-probe-options.test.ts is its own file.

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SpawnCall {
  bin: string;
  args: string[];
  opts: Record<string, unknown>;
}

/** The spawned bin's own name, stripped of the quotes and directory npmBin
 *  adds when it finds an npm beside the running node. WHICH shape comes back
 *  depends on the machine running the suite, so the spawn tests assert the
 *  name; npmBin's own tests below pin both shapes exactly. */
const binName = (bin: string): string => bin.replace(/^"|"$/g, "").split(/[\\/]/).pop() ?? bin;

const spawnCalls: SpawnCall[] = [];
/** Exit code the fake npm reports; null + a signal models a killed child. */
let exitCode: number | null = 0;
let exitSignal: string | null = null;
/** When set, spawn() throws it -- npm missing from PATH entirely. */
let spawnThrows: Error | null = null;
/** When set, the child emits 'error' instead of exiting. */
let childError: Error | null = null;

vi.mock("node:child_process", () => ({
  spawn: (bin: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ bin, args: [...(args ?? [])], opts: { ...opts } });
    if (spawnThrows) throw spawnThrows;
    const child = new EventEmitter();
    setTimeout(() => {
      if (childError) {
        child.emit("error", childError);
        return;
      }
      child.emit("close", exitCode, exitSignal);
    }, 0);
    return child;
  },
}));

const { defaultRunNpm, npmBin, runSidecarsInstall, sidecarsRoot } = await import("../sidecars-cmd.js");
// The one OTHER caller of the runner, whose spawn shape this file also pins:
// it goes through the same mocked child_process because the mock is
// module-scoped to this file's whole import graph.
const { backgroundInstallOptions } = await import("../sidecar-refresh.js");

describe("sidecars install default npm runner", () => {
  let home: string;

  beforeEach(() => {
    spawnCalls.length = 0;
    exitCode = 0;
    exitSignal = null;
    spawnThrows = null;
    childError = null;
    home = mkdtempSync(join(tmpdir(), "sidecar-spawn-"));
    mkdirSync(join(home, ".yaw-mcp"), { recursive: true });
    writeFileSync(
      join(home, ".yaw-mcp", "bundles.json"),
      JSON.stringify({
        version: 1,
        servers: [
          {
            id: "1",
            name: "F",
            namespace: "fetch",
            type: "local",
            transport: "stdio",
            command: "npx",
            args: ["-y", "@yawlabs/fetch-mcp@latest"],
          },
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // The oam probe spawns too, and it would go through the same mock and land in
  // spawnCalls -- so it is stubbed out here, leaving the npm spawns this file
  // exists to observe. Its own options live in oam-probe-options.test.ts.
  //
  // `platform` is INJECTED rather than stamped onto process.platform: the two
  // platform-branch tests below need a platform this machine may not be, and
  // redefining the global for the whole call also strips atomicWriteFile of its
  // Windows-only rename retry -- the AV/indexer EPERM dance that exists for
  // exactly the host those tests would otherwise be flaky on. Every other test
  // here passes nothing and runs against the real platform.
  const run = (platform?: NodeJS.Platform) =>
    runSidecarsInstall({
      home,
      cwd: home,
      platform,
      out: () => {},
      oamProbe: async () => ({
        bin: null,
        binPath: null,
        version: null,
        belowMin: false,
        failure: null,
        failureDetail: null,
      }),
    });

  it("keeps npm's own output off stdout so --json stays parseable", async () => {
    // THE regression this file exists for. npm writes its progress ("added 220
    // packages in 12s") to STDOUT; inheriting that put it ahead of the JSON
    // document, so `sidecars install --json | jq` failed outright. fd 2 keeps
    // the progress visible without it landing in the parsed stream.
    await run();

    // Two steps: `install` acquires, `update` is the only one that can move an
    // already-locked @latest forward on a re-run.
    expect(spawnCalls).toHaveLength(2);
    const stdio = spawnCalls[0].opts.stdio as unknown[];
    expect(stdio[1], "npm stdout must not reach the caller's stdout").toBe(2);
    // stdin closed (nothing to answer with), stderr inherited (progress).
    expect(stdio[0]).toBe("ignore");
    expect(stdio[2]).toBe("inherit");
  });

  it("silences the child when the caller asks -- the background install's shape", async () => {
    // sidecar-refresh's backgroundInstallOptions runs this same runner from
    // inside `serve`, where fd 2 is the stream the MCP client reads our
    // diagnostics from and npm's progress has nowhere to go. It differs on
    // stdio and windowsHide ALONE: a second spawn of its own would have to
    // restate the Windows-shell concession and the fixed-literal-args
    // condition that makes it safe. Reddens if the override is dropped and the
    // default shape wins.
    await defaultRunNpm(["install"], home, { stdio: "ignore" });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].opts.stdio).toBe("ignore");
    expect(spawnCalls[0].opts.cwd).toBe(home);
  });

  it("leaves the console window alone on the CLI path", async () => {
    // The CLI runs attached to a terminal, and there windowsHide is
    // CREATE_NO_WINDOW: it detaches npm from that console, so a Ctrl-C that
    // kills the CLI no longer reaches npm and the install keeps running,
    // half-owned, after the user thought they stopped it. Pinned as an
    // explicit false rather than "unset" so a refactor that hides
    // unconditionally reddens here and not in a user's terminal.
    await run();

    expect(spawnCalls).toHaveLength(2);
    for (const call of spawnCalls) expect(call.opts.windowsHide).toBe(false);
  });

  it("hides the console window for the background install, and only there", async () => {
    // `serve` under a GUI-launched MCP client has no console of its own, so a
    // console child of it (cmd.exe running npm.cmd) is given a brand-new
    // window on the desktop for the length of an install plus an update, once
    // a day, from a process the user never started by hand. Pinned through
    // backgroundInstallOptions' OWN runner rather than by handing defaultRunNpm
    // the flag: what matters is that the background caller sets it, the same
    // way oam-probe-options.test.ts pins the probe's.
    const bg = backgroundInstallOptions(home);
    await bg.runNpm?.(["install"], home);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].opts.windowsHide).toBe(true);
    // And the silent stdio it always had: the two overrides travel together.
    expect(spawnCalls[0].opts.stdio).toBe("ignore");
  });

  it("strips yaw-mcp's own secrets from npm's env on every path", async () => {
    // npm runs arbitrary registry lifecycle scripts, and the in-server daily
    // refresh reaches this spawn with the vault passphrase in process.env.
    // README promises the strip for EVERY child yaw-mcp starts; this npm run
    // was the one that inherited process.env whole. The rest of the env must
    // still arrive (npm needs PATH), so the assertion is on the one key, not
    // on an empty env.
    vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE", "hunter2-do-not-leak");
    vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE_NEW", "also-secret");
    try {
      await run();
      const bg = backgroundInstallOptions(home);
      await bg.runNpm?.(["install"], home);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(spawnCalls).toHaveLength(3);
    for (const call of spawnCalls) {
      const env = call.opts.env as NodeJS.ProcessEnv | undefined;
      expect(env, "spawn must pass an explicit env").toBeDefined();
      expect(env).not.toHaveProperty("YAW_MCP_VAULT_PASSPHRASE");
      expect(env).not.toHaveProperty("YAW_MCP_VAULT_PASSPHRASE_NEW");
      expect(Object.keys(env ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("goes through the shell on Windows, where npm is a .cmd shim", async () => {
    // Node refuses to exec .cmd/.bat directly since the CVE-2024-27980 fix and
    // fails EINVAL before the process starts -- observed, not theoretical.
    await run("win32");

    // The bin is `npm.cmd`, or an absolute quoted path ending in it when this
    // machine has one beside its node (npmBin prefers the sibling, and the
    // quotes are what survive cmd.exe splitting `C:\Program Files\...`).
    expect(binName(spawnCalls[0].bin)).toBe("npm.cmd");
    expect(spawnCalls[0].opts.shell).toBe(true);
  });

  it("does NOT use a shell off Windows", async () => {
    // The shell is a Windows-only concession; taking it everywhere would put a
    // command line through an extra parser for no reason.
    await run("linux");

    expect(binName(spawnCalls[0].bin)).toBe("npm");
    expect(spawnCalls[0].opts.shell).toBe(false);
  });

  it("runs npm in the managed directory, never in the caller's cwd", async () => {
    // `cwd` travels as a spawn OPTION rather than in the command line, which
    // is what makes the Windows shell above safe -- no user-controlled path is
    // ever parsed by cmd. If this moved into the args it would be injectable.
    await run();

    expect(spawnCalls.map((c) => c.args)).toEqual([
      ["install", "--no-audit", "--no-fund"],
      ["update", "--no-audit", "--no-fund"],
    ]);
    // Holds for BOTH steps: the shell concession above is only safe while every
    // argument is a fixed literal.
    for (const call of spawnCalls) {
      expect(call.opts.cwd).toBe(sidecarsRoot(home));
      expect(call.args.join(" ")).not.toContain(home);
      // No platform injected, so the shape must be the HOST's -- which is what
      // makes this a check on the real default rather than on an override.
      expect(call.opts.shell).toBe(process.platform === "win32");
    }
  });

  it("reports failure when spawn throws synchronously instead of emitting 'error'", async () => {
    // spawn does not always defer its failure to an 'error' event -- an option
    // the platform rejects (the EINVAL that made the Windows shell necessary)
    // or a cwd that vanished throws right out of the call. defaultRunNpm builds
    // the child inside the Promise executor, so an uncaught throw there rejects
    // runSidecarsInstall and the CLI prints a raw Node message (index.ts)
    // instead of the degradation the ENOENT case above pins.
    spawnThrows = new Error("spawn EINVAL");

    const res = await run();

    expect(res.exitCode).toBe(1);
    expect(res.lines.join("\n")).toContain("npx cache");
  });

  it("reports failure when npm cannot be spawned at all", async () => {
    // npm missing from PATH. The command must degrade to "your servers keep
    // using npx", not crash the CLI.
    childError = new Error("spawn npm ENOENT");

    const res = await run();

    expect(res.exitCode).toBe(1);
    expect(res.lines.join("\n")).toContain("npx cache");
  });

  it("treats a signal death as failure rather than success", async () => {
    // `close` reports code null when the child died on a signal; reading that
    // as 0 would declare an interrupted install (Ctrl-C, OOM) successful.
    exitCode = null;
    exitSignal = "SIGKILL";

    const res = await run();

    expect(res.exitCode).toBe(1);
  });
});

describe("npmBin", () => {
  let nodeDir: string;

  beforeEach(() => {
    nodeDir = mkdtempSync(join(tmpdir(), "sidecar-npmbin-"));
  });
  afterEach(() => rmSync(nodeDir, { recursive: true, force: true }));

  it("prefers the npm installed beside the running node", () => {
    // npm resolves native bindings for the node that RUNS it, while the
    // platform marker records the node running THIS process. On a mixed-arch
    // machine -- the case the marker exists for -- a PATH `npm` can belong to a
    // different node, and the marker would then certify an arch the tree was
    // never built for.
    writeFileSync(join(nodeDir, "npm"), "#!/bin/sh\n");
    writeFileSync(join(nodeDir, "npm.cmd"), "@echo off\r\n");

    expect(npmBin("linux", nodeDir)).toBe(join(nodeDir, "npm"));
    // Quoted on Windows: the command line goes through cmd.exe, and the default
    // install location (`C:\Program Files\nodejs`) splits at the space without
    // them.
    expect(npmBin("win32", nodeDir)).toBe(`"${join(nodeDir, "npm.cmd")}"`);
  });

  it("falls back to the PATH shim when node has no npm beside it", () => {
    // A standalone node build, or an image that puts npm elsewhere. The bare
    // name is what this always used, so the fallback is the old behaviour.
    expect(npmBin("linux", nodeDir)).toBe("npm");
    expect(npmBin("win32", nodeDir)).toBe("npm.cmd");
  });
});
