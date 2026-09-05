import type { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quoteArgForDisplay, quoteShellArgIfNeeded } from "../auto-upgrade.js";
import { compareVersions, MIN_OAM_VERSION, type OamProbe } from "../oam-spawn.js";
import {
  buildUpgradePlan,
  detectInstallMethod,
  detectSea,
  fetchLatestVersion,
  GLOBAL_UPGRADE_METHODS,
  globalUpgradeCommandLineForTool,
  type InstallMethod,
  killProcessTree,
  localInstallRoot,
  npmGlobalPrefix,
  type ProbeSpawn,
  parseUpgradeArgs,
  REGISTRY_FETCH_TIMEOUT_MS,
  refineInstallMethod,
  runningPackageDir,
  runUpgrade,
  UPGRADE_COMMANDS,
  UPGRADE_PACKAGE_SPEC,
  upgradeCommandLine,
  upgradeSpawnSpec,
} from "../upgrade-cmd.js";

/** Recorder for the mocked child_process.spawn. Two arms of the module reach
 *  a real spawn -- runUpgrade's defaultSpawn (when no spawnImpl is injected)
 *  and npmGlobalPrefix (which short-circuits under vitest unless a ProbeSpawn
 *  is injected) -- and the OPTIONS they spawn with are the contract under
 *  test. `vi.hoisted` so the object exists before the hoisted factory below
 *  closes over it. Every other test injects its spawn, so nothing else in
 *  this file reaches the mock. */
const cp = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>,
  children: [] as EventEmitter[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter: EE } = await import("node:events");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => {
      cp.calls.push({ cmd, args: [...args], opts: { ...opts } });
      const child = new EE();
      cp.children.push(child);
      return child;
    },
  };
});

/** A version strictly ABOVE the oam floor, for the at/above-floor fixtures.
 *  Derived from the constant, not spelled: MIN_OAM_VERSION tracks the latest
 *  oam release and moves often, and a literal "above" version silently turns
 *  into a below-floor one at the next bump. */
const bumpPatch = (v: string): string => {
  const parts = v.split(".");
  parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
  return parts.join(".");
};
/** A version strictly BELOW the floor. A literal on purpose (the below-min
 *  cases assert on the printed value), pinned against the constant by the
 *  fixture-sanity test in the runUpgrade suite. */
const BELOW_FLOOR_OAM = "0.8.2";

/** An oam probe answer for runUpgrade's advisory floor line. The note reads
 *  only `version` and `belowMin`, but the hook takes oam-spawn's real OamProbe
 *  -- the same object the un-injected path gets back from probeOam -- so a
 *  fixture here cannot quietly drift from production's shape. `version` is
 *  required: a fixture must not state a version-vs-floor relationship by
 *  omission. */
const oamProbe = (belowMin: boolean, version: string | null) => async (): Promise<OamProbe> => ({
  // bin/binPath are null exactly when the version is below the floor: that
  // IS the below-min outcome (fall back to node), not an extra condition.
  bin: belowMin ? null : "oam",
  binPath: belowMin ? null : "/usr/local/bin/oam",
  version,
  belowMin,
  failure: null,
  failureDetail: null,
});

function captureIO(): { out: string[]; err: string[]; push: (s: string) => void; pushErr: (s: string) => void } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    push: (s: string) => {
      out.push(s);
    },
    pushErr: (s: string) => {
      err.push(s);
    },
  };
}

describe("parseUpgradeArgs", () => {
  it("defaults to no flags", () => {
    expect(parseUpgradeArgs([])).toEqual({ ok: true, options: {} });
  });

  it("accepts --run", () => {
    expect(parseUpgradeArgs(["--run"])).toEqual({ ok: true, options: { run: true } });
  });

  it("accepts --json", () => {
    expect(parseUpgradeArgs(["--json"])).toEqual({ ok: true, options: { json: true } });
  });

  it("accepts both --run and --json", () => {
    expect(parseUpgradeArgs(["--run", "--json"])).toEqual({ ok: true, options: { run: true, json: true } });
  });

  it("rejects unknown flags", () => {
    const r = parseUpgradeArgs(["--bogus"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown argument "--bogus"');
  });

  it("--help returns usage as error", () => {
    const r = parseUpgradeArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Usage: yaw-mcp upgrade");
  });
});

describe("detectInstallMethod", () => {
  it("returns `unknown` for undefined argvPath", () => {
    expect(detectInstallMethod(undefined)).toBe("unknown");
  });

  it("detects npx cache on linux/macos", () => {
    expect(detectInstallMethod("/home/user/.npm/_npx/abc123/node_modules/@yawlabs/mcp/dist/index.js")).toBe("npx");
  });

  it("detects npx cache on windows", () => {
    expect(
      detectInstallMethod(
        "C:\\Users\\jeff\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@yawlabs\\mcp\\dist\\index.js",
      ),
    ).toBe("npx");
  });

  it("does NOT classify a user project path that merely contains a `_npx` segment as npx", () => {
    // A bare `_npx` directory anywhere in the path used to match. The npx
    // marker now requires the npm-cache context (_npx/<hex>/node_modules/
    // @yawlabs/mcp/), so a project dir named `_npx` falls through to the
    // real install method (local-node-modules) instead of false-positiving.
    expect(detectInstallMethod("/home/u/projects/_npx/app/node_modules/@yawlabs/mcp/dist/index.js")).toBe(
      "local-node-modules",
    );
  });

  it("detects linux global install under /usr/lib/node_modules", () => {
    expect(detectInstallMethod("/usr/lib/node_modules/@yawlabs/mcp/dist/index.js")).toBe("global-npm");
  });

  it("detects macos homebrew-style /usr/local/lib/node_modules", () => {
    expect(detectInstallMethod("/usr/local/lib/node_modules/@yawlabs/mcp/dist/index.js")).toBe("global-npm");
  });

  it("detects windows global npm under AppData/Roaming/npm", () => {
    expect(
      detectInstallMethod("C:\\Users\\jeff\\AppData\\Roaming\\npm\\node_modules\\@yawlabs\\mcp\\dist\\index.js"),
    ).toBe("global-npm");
  });

  it("detects scoop/volta-style <prefix>/bin/node_modules as global", () => {
    expect(
      detectInstallMethod(
        "C:\\Users\\jeff\\scoop\\persist\\nodejs22\\bin\\node_modules\\@yawlabs\\mcp\\dist\\index.js",
      ),
    ).toBe("global-npm");
    expect(
      detectInstallMethod(
        "C:\\Users\\jeff\\scoop\\apps\\nodejs22\\current\\bin\\node_modules\\@yawlabs\\mcp\\dist\\index.js",
      ),
    ).toBe("global-npm");
  });

  it("detects nvm-style /home/u/.nvm/versions/node/.../lib/node_modules as global", () => {
    expect(detectInstallMethod("/home/u/.nvm/versions/node/v22.11.0/lib/node_modules/@yawlabs/mcp/dist/index.js")).toBe(
      "global-npm",
    );
  });

  it("detects a project-local node_modules install", () => {
    expect(detectInstallMethod("/proj/app/node_modules/@yawlabs/mcp/dist/index.js")).toBe("local-node-modules");
  });

  it("does NOT classify a workspace package directory named `lib` as a global install", () => {
    // The POSIX global marker used to be a bare `/lib/node_modules/@yawlabs/mcp/`,
    // which any monorepo package literally named `lib` satisfies. maybeAutoUpgrade
    // then treated it as global-npm and spawned
    // `npm install -g --prefix <repo>/packages` (detectRunningInstallPrefix strips
    // the trailing /lib), writing a global tree and bin shims into the user's repo
    // and overwriting the workspace-pinned version. The marker is now anchored on
    // real Node-root shapes, so this falls through to local-node-modules.
    expect(detectInstallMethod("/home/u/repo/packages/lib/node_modules/@yawlabs/mcp/dist/index.js")).toBe(
      "local-node-modules",
    );
    expect(detectInstallMethod("C:\\dev\\repo\\packages\\lib\\node_modules\\@yawlabs\\mcp\\dist\\index.js")).toBe(
      "local-node-modules",
    );
    // ...and the managed-Node marker must not re-open it either. It used to
    // allow any number of free segments between the manager directory and
    // `lib`, so a repo under an ancestor named `.local` (or `n`, or `fnm`)
    // satisfied it and drove the same `npm install -g --prefix <repo>/packages`.
    expect(
      detectInstallMethod("/home/u/.local/share/myrepo/packages/lib/node_modules/@yawlabs/mcp/dist/index.js"),
    ).toBe("local-node-modules");
  });

  it("still detects the real POSIX global prefixes after anchoring the lib marker", () => {
    // The anchored marker must keep every shape a global install actually uses:
    // system prefixes, /opt tool prefixes, and version-manager Node roots. An
    // exotic prefix that misses these degrades safely (local-node-modules, which
    // refineInstallMethod then fixes via `npm prefix -g`) -- but these must not
    // need refinement.
    for (const p of [
      "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/usr/local/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/opt/homebrew/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/opt/node/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/home/u/.nvm/versions/node/v22.11.0/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/home/u/.volta/tools/image/node/22.11.0/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/home/u/.asdf/installs/nodejs/22.11.0/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/home/u/.local/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/home/u/.local/share/fnm/node-versions/v22.11.0/installation/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/home/u/.fnm/node-versions/v22.11.0/installation/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/home/u/.nodenv/versions/22.11.0/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/home/u/.nvs/node/22.11.0/x64/lib/node_modules/@yawlabs/mcp/dist/index.js",
      "/opt/n-prefix/n/versions/node/22.11.0/lib/node_modules/@yawlabs/mcp/dist/index.js",
    ]) {
      expect(detectInstallMethod(p), p).toBe("global-npm");
    }
  });

  it("detects pnpm global stores on linux/macos/windows", () => {
    expect(detectInstallMethod("/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js")).toBe(
      "pnpm-global",
    );
    expect(detectInstallMethod("/Users/u/Library/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js")).toBe(
      "pnpm-global",
    );
    expect(
      detectInstallMethod("C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@yawlabs\\mcp\\dist\\index.js"),
    ).toBe("pnpm-global");
  });

  it("detects bun global installs", () => {
    expect(detectInstallMethod("/home/u/.bun/install/global/node_modules/@yawlabs/mcp/dist/index.js")).toBe(
      "bun-global",
    );
  });

  it("detects the Yaw Terminal bundled copy (asar.unpacked) over the node_modules marker", () => {
    expect(
      detectInstallMethod(
        "C:\\Users\\u\\AppData\\Local\\yaw\\resources\\app.asar.unpacked\\node_modules\\@yawlabs\\mcp\\dist\\index.js",
      ),
    ).toBe("bundled-app");
    expect(
      detectInstallMethod(
        "/Applications/Yaw.app/Contents/Resources/app.asar.unpacked/node_modules/@yawlabs/mcp/dist/index.js",
      ),
    ).toBe("bundled-app");
  });

  it("detects dev checkout (src/)", () => {
    expect(detectInstallMethod("/home/jeff/yaw/yaw-mcp/src/index.ts")).toBe("dev-checkout");
  });

  it("detects dev checkout (dist/)", () => {
    expect(detectInstallMethod("/home/jeff/yaw/yaw-mcp/dist/index.js")).toBe("dev-checkout");
  });

  it("detects the canonical clone dir `mcp/` as a dev checkout", () => {
    // `git clone git@github.com:YawLabs/mcp.git` lands in mcp/ -- the
    // repo's own working tree used to classify as "unknown" and get told
    // to `npm install -g` a second global copy. Every node_modules-shaped
    // install is classified before this test, so bare `mcp` is safe here:
    // an install under node_modules/@yawlabs/mcp/ never reaches it.
    expect(detectInstallMethod("C:/Users/jeff/yaw/yaw_terminal/mcp/dist/index.js")).toBe("dev-checkout");
    expect(detectInstallMethod("/home/x/mcp/src/index.ts")).toBe("dev-checkout");
    // ...and the node_modules shape still wins.
    expect(detectInstallMethod("/usr/lib/node_modules/@yawlabs/mcp/dist/index.js")).not.toBe("dev-checkout");
  });

  // The canonical POSIX invocation does NOT hand us the package entrypoint: npm
  // installs a bin SHIM and argv[1] is the shim's path. None of the markers
  // above matches one, so every `yaw-mcp upgrade` on macOS/Linux classified
  // `unknown` -- a real `npm prefix -g` subprocess on the startup path, then
  // "Install: unknown" and a `--run` that refuses with exit 2.
  describe("bin-shim resolution", () => {
    /** A realpath stand-in: unit-test paths are fictional, so the real
     *  realpathSync ENOENTs on every one of them. */
    const resolves = (map: Record<string, string>) => (p: string) => {
      const target: string | undefined = map[p];
      if (target === undefined) throw new Error(`ENOENT: ${p}`);
      return target;
    };

    it("resolves a global bin shim to the install it points at", () => {
      expect(
        detectInstallMethod(
          "/usr/local/bin/yaw-mcp",
          resolves({ "/usr/local/bin/yaw-mcp": "/usr/local/lib/node_modules/@yawlabs/mcp/dist/index.js" }),
        ),
      ).toBe("global-npm");
    });

    it("resolves a project-local .bin shim to local-node-modules", () => {
      expect(
        detectInstallMethod(
          "/proj/app/node_modules/.bin/yaw-mcp",
          resolves({
            "/proj/app/node_modules/.bin/yaw-mcp": "/proj/app/node_modules/@yawlabs/mcp/dist/index.js",
          }),
        ),
      ).toBe("local-node-modules");
    });

    it("resolves an npx cache .bin shim to npx", () => {
      expect(
        detectInstallMethod(
          "/home/u/.npm/_npx/abc123/node_modules/.bin/yaw-mcp",
          resolves({
            "/home/u/.npm/_npx/abc123/node_modules/.bin/yaw-mcp":
              "/home/u/.npm/_npx/abc123/node_modules/@yawlabs/mcp/dist/index.js",
          }),
        ),
      ).toBe("npx");
    });

    it("never resolves a path the literal markers already classified", () => {
      // Order matters: pnpm's global store entry is ITSELF a symlink into
      // `.pnpm/@yawlabs+mcp@<ver>/node_modules/@yawlabs/mcp`, whose resolved
      // path misses the pnpm marker and lands on local-node-modules -- i.e.
      // `--run` would `npm install` inside the pnpm store. Resolving only the
      // `unknown` leftovers is what keeps that from happening.
      const realpath = vi.fn(
        () => "/home/u/.local/share/pnpm/.pnpm/@yawlabs+mcp@0.45.0/node_modules/@yawlabs/mcp/dist/index.js",
      );
      expect(
        detectInstallMethod("/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js", realpath),
      ).toBe("pnpm-global");
      expect(realpath).not.toHaveBeenCalled();
      // Same guarantee for the dev checkout, whose path really does exist on a
      // contributor's box -- a junctioned checkout must not start re-classifying.
      expect(detectInstallMethod("C:/Users/jeff/yaw/yaw_terminal/mcp/dist/index.js", realpath)).toBe("dev-checkout");
      expect(realpath).not.toHaveBeenCalled();
    });

    it("keeps the literal answer when the path cannot be resolved", () => {
      // Production degradation path: a shim that no longer exists (or an argv[1]
      // we cannot stat) throws, and the literal `unknown` stands rather than
      // taking the process down.
      expect(detectInstallMethod("/opt/custom/yaw-mcp-launcher.js", resolves({}))).toBe("unknown");
    });

    it("resolves a literal `local-node-modules` only when resolveWhen says so (the background upgrader's npm-link case)", () => {
      // The CLI default resolves `unknown` only, for the pnpm reason above. The
      // background upgrader widens it to local-node-modules: an `npm link`ed
      // project tree or a staged shim is a literal local-node-modules whose
      // realpath is the global install actually running. It used to carry its
      // own copy of this realpath pass for that one difference.
      const linked = "/proj/app/node_modules/@yawlabs/mcp/dist/index.js";
      const realpath = vi.fn(resolves({ [linked]: "/usr/local/lib/node_modules/@yawlabs/mcp/dist/index.js" }));
      expect(detectInstallMethod(linked, realpath)).toBe("local-node-modules");
      expect(realpath).not.toHaveBeenCalled();
      expect(detectInstallMethod(linked, realpath, ["unknown", "local-node-modules"])).toBe("global-npm");
      // A marker match outside resolveWhen is still never second-guessed.
      expect(
        detectInstallMethod("/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js", realpath, [
          "unknown",
          "local-node-modules",
        ]),
      ).toBe("pnpm-global");
      // ...and a genuine project tree, whose realpath is itself, keeps its answer.
      expect(detectInstallMethod(linked, (p) => p, ["unknown", "local-node-modules"])).toBe("local-node-modules");
    });

    it("spares the resolved global shim any `npm prefix -g` refinement", async () => {
      // The refinement probe is a multi-second subprocess and the whole point of
      // resolving the shim is that this install no longer needs it.
      const method = detectInstallMethod(
        "/usr/local/bin/yaw-mcp",
        resolves({ "/usr/local/bin/yaw-mcp": "/usr/local/lib/node_modules/@yawlabs/mcp/dist/index.js" }),
      );
      const npmPrefix = vi.fn(async () => "/usr/local");
      expect(await refineInstallMethod(method, "/usr/local/bin/yaw-mcp", npmPrefix)).toBe("global-npm");
      expect(npmPrefix).not.toHaveBeenCalled();
    });
  });
});

describe("detectSea", () => {
  it("returns false when ELECTRON_RUN_AS_NODE is set (Electron is never a SEA)", async () => {
    const prev = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = "1";
    try {
      expect(await detectSea()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = prev;
    }
  });

  it("returns false on an ordinary node run (execPath basename is node; no SEA blob)", async () => {
    // Vitest runs under plain node, so the basename gate (and isSea()) yield
    // false -- this pins that detectSea() never false-positives on real node.
    expect(await detectSea()).toBe(false);
  });
});

describe("refineInstallMethod", () => {
  it("reclassifies local-node-modules as global-npm when the entrypoint lives under npm's prefix", async () => {
    // Windows layout: globals at <prefix>/node_modules.
    expect(
      await refineInstallMethod(
        "local-node-modules",
        "/custom/prefix/node_modules/@yawlabs/mcp/dist/index.js",
        async () => "/custom/prefix",
      ),
    ).toBe("global-npm");
    // POSIX layout: globals at <prefix>/lib/node_modules.
    expect(
      await refineInstallMethod(
        "local-node-modules",
        "/custom/prefix/lib/node_modules/@yawlabs/mcp/dist/index.js",
        async () => "/custom/prefix",
      ),
    ).toBe("global-npm");
  });

  it("leaves a genuine project-local install alone", async () => {
    expect(
      await refineInstallMethod(
        "local-node-modules",
        "/proj/app/node_modules/@yawlabs/mcp/dist/index.js",
        async () => "/custom/prefix",
      ),
    ).toBe("local-node-modules");
  });

  it("skips refinement for unambiguous methods and when npm doesn't answer", async () => {
    let probed = false;
    const probe = async () => {
      probed = true;
      return "/custom/prefix";
    };
    expect(await refineInstallMethod("global-npm", "/x/node_modules/@yawlabs/mcp/dist/index.js", probe)).toBe(
      "global-npm",
    );
    expect(await refineInstallMethod("bundled-app", "/x/node_modules/@yawlabs/mcp/dist/index.js", probe)).toBe(
      "bundled-app",
    );
    expect(probed).toBe(false);
    expect(
      await refineInstallMethod(
        "local-node-modules",
        "/proj/node_modules/@yawlabs/mcp/dist/index.js",
        async () => null,
      ),
    ).toBe("local-node-modules");
  });
});

describe("npmGlobalPrefix", () => {
  it("short-circuits to null under vitest so no unit test spawns a real npm", async () => {
    // The guard is load-bearing for both callers: refineInstallMethod's
    // second-chance classification AND auto-upgrade's multi-prefix warning route
    // through this one helper, and a real `npm prefix -g` in a unit test is a
    // multi-second subprocess whose answer varies per machine. Tests that need a
    // prefix inject their own probe (opts.npmPrefix / deps.npmPrefixImpl).
    expect(process.env.VITEST).toBeTruthy();
    expect(await npmGlobalPrefix()).toBeNull();
  });

  it("spawns `npm prefix -g` with yaw-mcp's own secrets STRIPPED from the child env", async () => {
    // Even a read-only probe is an npm invocation running with whatever env it
    // inherits, and the passphrase README tells the user to park in yaw-mcp's
    // env block must not ride along. The VITEST short-circuit keeps the real
    // spawn unreachable, so the spawn itself is injected -- the only way to
    // see its options.
    vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE", "hunter2");
    vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE_NEW", "hunter3");
    vi.stubEnv("YAW_MCP_TOKEN", "mcp_pat_stale");
    try {
      const seen: Array<Parameters<ProbeSpawn>> = [];
      const probeSpawn: ProbeSpawn = (cmd, args, opts) => {
        seen.push([cmd, args, opts]);
        return {
          pid: 4321,
          kill: () => true,
          stdout: {
            on: (_event, listener) => setImmediate(() => listener("/opt/node\n")),
          },
          on: (event, listener) => {
            // After the stdout chunk above: one tick later.
            if (event === "close") setImmediate(() => setImmediate(() => listener(0)));
          },
        };
      };
      expect(await npmGlobalPrefix(probeSpawn)).toBe("/opt/node");
      expect(seen).toHaveLength(1);
      const [cmd, args, opts] = seen[0];
      expect(cmd).toBe("npm");
      expect(args).toEqual(["prefix", "-g"]);
      expect(opts.env).not.toHaveProperty("YAW_MCP_VAULT_PASSPHRASE");
      expect(opts.env).not.toHaveProperty("YAW_MCP_VAULT_PASSPHRASE_NEW");
      expect(opts.env).not.toHaveProperty("YAW_MCP_TOKEN");
      // A strip, not a blank env: npm still has to be found on PATH. The copy
      // keeps process.env's own spelling of the key (`Path` on Windows).
      const pathKey = Object.keys(opts.env).find((k) => k.toUpperCase() === "PATH");
      expect(pathKey).toBeDefined();
      expect(opts.env[pathKey as string]).toBe(process.env.PATH);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// The ONE registry probe for the package. `upgrade`, auto-upgrade at serve
// startup and `doctor` all call this; it used to exist three times over, and the
// copies had drifted on exactly the two axes covered here -- the abort budget
// and whether a stand-in could be injected. Both are now parameters, so these
// tests are what keep a caller with a real difference in requirement from
// forking the URL and the failure semantics along with it.
describe("fetchLatestVersion -- the shared registry probe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A fetch that never resolves on its own -- it settles only when the
   *  AbortController fires, which is what a real fetch does on abort. Captures
   *  the signal so a test can assert WHEN the abort landed, not just that it
   *  eventually did. */
  function hangingFetch(): { mock: ReturnType<typeof vi.fn>; signal: () => AbortSignal | undefined } {
    let seen: AbortSignal | undefined;
    const mock = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init.signal;
          init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
        }),
    );
    return { mock, signal: () => seen };
  }

  it("uses the override instead of the network, and never touches fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchLatestVersion({ override: async () => "1.2.3" })).toBe("1.2.3");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("absorbs a throwing override to null -- an injected probe cannot fail its caller", async () => {
    // doctor's registryFetch hook lands here. A hook that rejects must degrade
    // the freshness line to "unknown", exactly like an offline registry does,
    // rather than take down the whole diagnostic.
    const thrower = async (): Promise<string | null> => {
      throw new Error("hook blew up");
    };
    await expect(fetchLatestVersion({ override: thrower })).resolves.toBeNull();
  });

  it("aborts at the caller's timeout when one is given, not at the default", async () => {
    vi.useFakeTimers();
    const { mock, signal } = hangingFetch();
    vi.stubGlobal("fetch", mock);

    const pending = fetchLatestVersion({ timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal()?.aborted).toBe(true);
    // An aborted fetch is a failure like any other: null, never a throw.
    await expect(pending).resolves.toBeNull();
  });

  it("falls back to the 3s default budget when the caller names none", async () => {
    // Pins the asymmetry doctor depends on: doctor passes 2000 (see
    // DOCTOR_REGISTRY_TIMEOUT_MS) precisely because the shared default is
    // longer. If these two ever collapse to one number, this test and the
    // 2000ms one above stop disagreeing and the requirement is silently gone.
    expect(REGISTRY_FETCH_TIMEOUT_MS).toBe(3000);
    vi.useFakeTimers();
    const { mock, signal } = hangingFetch();
    vi.stubGlobal("fetch", mock);

    const pending = fetchLatestVersion();
    await vi.advanceTimersByTimeAsync(2999);
    expect(signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal()?.aborted).toBe(true);
    await expect(pending).resolves.toBeNull();
  });

  it("returns null for a non-2xx response and for a body with no string version", async () => {
    const responses = [
      { ok: false, json: async () => ({ version: "9.9.9" }) },
      { ok: true, json: async () => ({}) },
      { ok: true, json: async () => ({ version: 47 }) },
    ];
    for (const res of responses) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => res as unknown as Response),
      );
      expect(await fetchLatestVersion()).toBeNull();
    }
  });

  it("requests @yawlabs/mcp/latest with a JSON accept header and an abort signal", async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ version: "0.47.8" }) }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchLatestVersion()).toBe("0.47.8");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: unknown; signal: unknown }];
    expect(url).toBe("https://registry.npmjs.org/@yawlabs/mcp/latest");
    expect(init.headers).toEqual({ accept: "application/json" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("localInstallRoot", () => {
  it("returns the tree root before the first node_modules segment", () => {
    expect(localInstallRoot("/proj/app/node_modules/@yawlabs/mcp/dist/index.js")).toBe("/proj/app");
  });

  it("keeps Windows drive letters and backslashes intact", () => {
    expect(localInstallRoot("C:\\Users\\u\\node_modules\\@yawlabs\\mcp\\dist\\index.js")).toBe("C:\\Users\\u");
  });

  it("uses the FIRST node_modules segment for nested installs", () => {
    expect(localInstallRoot("/proj/node_modules/foo/node_modules/@yawlabs/mcp/dist/index.js")).toBe("/proj");
  });

  it("returns null when no node_modules segment exists", () => {
    expect(localInstallRoot("/home/jeff/yaw/yaw-mcp/dist/index.js")).toBeNull();
    expect(localInstallRoot(undefined)).toBeNull();
  });
});

describe("runningPackageDir -- the copy that is RUNNING, as opposed to the tree npm runs in", () => {
  const NESTED = "/proj/node_modules/foo/node_modules/@yawlabs/mcp/dist/index.js";

  it("takes the LAST node_modules/@yawlabs/mcp segment of a nested install (localInstallRoot takes the FIRST)", () => {
    // The two legitimately differ for a nested copy: npm must run in /proj,
    // but /proj is not where the running bytes live -- which is exactly the
    // mismatch the post-`--run` check reports.
    expect(runningPackageDir(NESTED)).toBe("/proj/node_modules/foo/node_modules/@yawlabs/mcp");
    expect(localInstallRoot(NESTED)).toBe("/proj");
  });

  it("keeps Windows drive letters and backslashes intact", () => {
    expect(runningPackageDir("C:\\Users\\u\\node_modules\\@yawlabs\\mcp\\dist\\index.js")).toBe(
      "C:\\Users\\u\\node_modules\\@yawlabs\\mcp",
    );
  });

  it("prefers the LITERAL path over its realpath (pnpm repoints the link; the old store dir keeps the old version)", () => {
    const realpath = vi.fn(
      () => "/home/u/.local/share/pnpm/.pnpm/@yawlabs+mcp@0.40.0/node_modules/@yawlabs/mcp/dist/index.js",
    );
    expect(
      runningPackageDir("/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js", realpath),
    ).toBe("/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp");
    expect(realpath).not.toHaveBeenCalled();
  });

  it("falls back to the realpath for a bin shim, whose literal path carries no node_modules segment", () => {
    expect(
      runningPackageDir("/usr/local/bin/yaw-mcp", () => "/usr/local/lib/node_modules/@yawlabs/mcp/dist/index.js"),
    ).toBe("/usr/local/lib/node_modules/@yawlabs/mcp");
  });

  it("returns null when neither form carries the segment, or the path cannot be resolved", () => {
    expect(runningPackageDir("/opt/custom/launcher.js", () => "/opt/custom/real.js")).toBeNull();
    expect(
      runningPackageDir("/opt/custom/launcher.js", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
    expect(runningPackageDir(undefined)).toBeNull();
  });
});

describe("buildUpgradePlan", () => {
  it("flags stale=true when current < latest", () => {
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: "global-npm" });
    expect(plan.stale).toBe(true);
    expect(plan.command).toBe("npm install -g @yawlabs/mcp@latest");
  });

  it("flags stale=false when current === latest", () => {
    const plan = buildUpgradePlan({ current: "0.45.0", latest: "0.45.0", method: "global-npm" });
    expect(plan.stale).toBe(false);
  });

  it("flags stale=false when latest is null (offline)", () => {
    const plan = buildUpgradePlan({ current: "0.45.0", latest: null, method: "global-npm" });
    expect(plan.stale).toBe(false);
  });

  it("ranks a prerelease below its release (0.45.0-rc.1 is stale against 0.45.0)", () => {
    // The staleness check runs on oam-spawn's compareVersions, the package's
    // one semver comparator -- this used to be a third private copy here whose
    // prerelease branch nothing exercised. Prerelease precedence is the branch
    // a triple-only comparator gets WRONG (it reads the two as equal, so an rc
    // build is told it is current), which is why this case is the one pinned.
    expect(buildUpgradePlan({ current: "0.45.0-rc.1", latest: "0.45.0", method: "global-npm" }).stale).toBe(true);
    // ...and not the other way round: a release is never stale against its own rc.
    expect(buildUpgradePlan({ current: "0.45.0", latest: "0.45.0-rc.1", method: "global-npm" }).stale).toBe(false);
    // A git-tag-shaped "v" prefix is stripped before comparing, so it neither
    // fails to parse (which would compare equal and hide a real upgrade) nor
    // invents one.
    expect(buildUpgradePlan({ current: "v0.40.0", latest: "0.45.0", method: "global-npm" }).stale).toBe(true);
    expect(buildUpgradePlan({ current: "0.45.0", latest: "v0.45.0", method: "global-npm" }).stale).toBe(false);
  });

  it("returns null command for npx (nothing to run)", () => {
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: "npx" });
    expect(plan.command).toBeNull();
    expect(plan.stale).toBe(true);
  });

  it("uses plain `npm install` for local node_modules", () => {
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: "local-node-modules" });
    expect(plan.command).toBe("npm install @yawlabs/mcp@latest");
  });

  it("uses the owning tool for pnpm/bun global stores", () => {
    expect(buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: "pnpm-global" }).command).toBe(
      "pnpm add -g @yawlabs/mcp@latest",
    );
    expect(buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: "bun-global" }).command).toBe(
      "bun add -g @yawlabs/mcp@latest",
    );
  });

  it("returns null command for the Yaw Terminal bundled copy (updates with the app)", () => {
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: "bundled-app" });
    expect(plan.command).toBeNull();
    expect(plan.stale).toBe(true);
  });

  it("suggests git pull for dev checkouts", () => {
    const plan = buildUpgradePlan({ current: "dev", latest: "0.45.0", method: "dev-checkout" });
    expect(plan.command).toContain("git pull");
    // dev is always non-stale because the version string doesn't parse.
    expect(plan.stale).toBe(false);
  });

  it("falls back to npm -g command for unknown method", () => {
    // Item 2: the default switch arm for unknown must return the npm -g
    // install command so an unrecognized install path still gives the
    // user a sensible copy-paste command.
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: "unknown" });
    expect(plan.command).toBe("npm install -g @yawlabs/mcp@latest");
    expect(plan.stale).toBe(true);
  });

  it("returns null command for a standalone binary (replace the executable, no package manager)", () => {
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: "binary" });
    expect(plan.command).toBeNull();
    expect(plan.stale).toBe(true);
  });
});

describe("UPGRADE_COMMANDS -- the one whitelist every spawn surface derives from", () => {
  // This used to be spelled in four places (buildUpgradePlan's switch,
  // runUpgrade's runSpec, auto-upgrade's globalSpec and its failure hint), so a
  // change to the package spec or a new tool had to land in all four or they
  // drifted. These pin that every surface now reads the one table.
  const SPAWNABLE = ["global-npm", "pnpm-global", "bun-global", "local-node-modules"] as const;
  const MANUAL = ["npx", "bundled-app", "dev-checkout", "binary", "unknown"] as const;

  it("every spawnable entry ends in the @latest package spec, so a stale copy always moves to the newest publish", () => {
    expect(UPGRADE_PACKAGE_SPEC).toBe("@yawlabs/mcp@latest");
    for (const m of Object.keys(UPGRADE_COMMANDS) as InstallMethod[]) {
      const entry = UPGRADE_COMMANDS[m];
      if (entry === null) continue;
      expect(entry.args[entry.args.length - 1], m).toBe(UPGRADE_PACKAGE_SPEC);
    }
    for (const m of SPAWNABLE) expect(UPGRADE_COMMANDS[m], m).not.toBeNull();
    for (const m of MANUAL) expect(UPGRADE_COMMANDS[m], m).toBeNull();
  });

  it("names exactly the global methods the background upgrader may act on", () => {
    expect(GLOBAL_UPGRADE_METHODS).toEqual(["global-npm", "pnpm-global", "bun-global"]);
  });

  it("upgradeSpawnSpec inserts --prefix ahead of the package spec for global-npm only", () => {
    expect(upgradeSpawnSpec("global-npm", "/opt/node")).toEqual({
      cmd: "npm",
      args: ["install", "-g", "--prefix", "/opt/node", "@yawlabs/mcp@latest"],
    });
    expect(upgradeSpawnSpec("global-npm")).toEqual({ cmd: "npm", args: ["install", "-g", "@yawlabs/mcp@latest"] });
    // `pnpm add -g --prefix` is not a real flag: the arg is ignored, not passed.
    expect(upgradeSpawnSpec("pnpm-global", "/opt/node")).toEqual({
      cmd: "pnpm",
      args: ["add", "-g", "@yawlabs/mcp@latest"],
    });
    expect(upgradeSpawnSpec("bun-global", "/opt/node")).toEqual({
      cmd: "bun",
      args: ["add", "-g", "@yawlabs/mcp@latest"],
    });
    expect(upgradeSpawnSpec("local-node-modules", "/opt/node")).toEqual({
      cmd: "npm",
      args: ["install", "@yawlabs/mcp@latest"],
    });
    for (const m of MANUAL) expect(upgradeSpawnSpec(m, "/opt/node"), m).toBeNull();
  });

  it("hands out a fresh args array each call, so a caller may push onto it without editing the table", () => {
    upgradeSpawnSpec("global-npm")?.args.push("--dry-run");
    expect(upgradeSpawnSpec("global-npm")?.args).toEqual(["install", "-g", "@yawlabs/mcp@latest"]);
    expect(UPGRADE_COMMANDS["global-npm"]?.args).toEqual(["install", "-g", "@yawlabs/mcp@latest"]);
  });

  it("buildUpgradePlan's command IS the table's line for every spawnable method, and the global line for unknown", () => {
    for (const m of SPAWNABLE) {
      expect(buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: m }).command, m).toBe(
        upgradeCommandLine(m),
      );
    }
    expect(buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: "unknown" }).command).toBe(
      upgradeCommandLine("global-npm"),
    );
    for (const m of ["npx", "bundled-app", "binary"] as const) expect(upgradeCommandLine(m), m).toBeNull();
  });

  it("derives the --prefix suggestion (printed and --json) from the table too", async () => {
    // The prefixed global-npm form was the one hand-spelled copy left after
    // UPGRADE_COMMANDS became the single source: a change to the package spec
    // would have moved the spawn and left the printed suggestion behind.
    const io = captureIO();
    const prefix = "/opt/node";
    await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: `${prefix}/lib/node_modules/@yawlabs/mcp/dist/index.js`,
      fetchLatest: async () => "0.45.0",
      oamProbe: oamProbe(false, "0.13.1"),
      platform: "linux",
      runningPrefix: () => prefix,
      json: true,
      out: io.push,
      err: io.pushErr,
    });
    const doc = JSON.parse(io.out.join("\n")) as { command: string };
    const spec = upgradeSpawnSpec("global-npm", prefix);
    expect(spec).not.toBeNull();
    expect(doc.command).toBe([spec?.cmd, ...(spec?.args ?? [])].join(" "));
    expect(doc.command).toContain(UPGRADE_PACKAGE_SPEC);
  });

  it("resolves auto-upgrade's failure hint by TOOL to the global line, never the local one", () => {
    // The background spawn's failure callback is handed the tool, not the
    // method, and npm owns two entries -- the hint must be the `-g` one.
    expect(globalUpgradeCommandLineForTool("npm")).toBe("npm install -g @yawlabs/mcp@latest");
    expect(globalUpgradeCommandLineForTool("pnpm")).toBe("pnpm add -g @yawlabs/mcp@latest");
    expect(globalUpgradeCommandLineForTool("bun")).toBe("bun add -g @yawlabs/mcp@latest");
    expect(globalUpgradeCommandLineForTool("yarn")).toBeNull();
  });
});

describe("runUpgrade", () => {
  it("prints Current/Latest and flags already-up-to-date", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.45.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const out = io.out.join("\n");
    expect(out).toContain("Current: 0.45.0");
    expect(out).toContain("Latest:  0.45.0");
    expect(out).toContain("Install: global-npm");
    expect(out).toContain("latest version");
    expect(out).toContain("OK:");
  });

  it("exits 1 and prints the command when stale and --run not passed (global-npm)", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    expect(io.out.join("\n")).toContain("npm install -g @yawlabs/mcp@latest");
  });

  it("tells npx users to restart the MCP client (exit 0, no command)", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/home/u/.npm/_npx/abc/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const out = io.out.join("\n");
    expect(out).toContain("restart the MCP client");
    expect(out).not.toContain("npm install");
  });

  it("with --run, spawns npm install -g and reports success", async () => {
    const io = captureIO();
    const spawned: Array<{ cmd: string; args: string[] }> = [];
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async (cmd, args) => {
        spawned.push({ cmd, args });
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual({ cmd: "npm", args: ["install", "-g", "@yawlabs/mcp@latest"] });
    expect(io.out.join("\n")).toContain("OK: Upgraded @yawlabs/mcp to 0.45.0");
  });

  it("with --run and no injected spawn, the real spawn gets yaw-mcp's own secrets STRIPPED from its env", async () => {
    // README tells the user to park YAW_MCP_VAULT_PASSPHRASE in yaw-mcp's own
    // env block because "yaw-mcp strips its own secrets from every child env".
    // `upgrade --run` spawns `npm install -g` with stdio inherited and used to
    // hand it process.env whole -- and npm runs every dependency's
    // pre/postinstall with that env.
    vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE", "hunter2");
    vi.stubEnv("YAW_MCP_VAULT_PASSPHRASE_NEW", "hunter3");
    vi.stubEnv("YAW_MCP_TOKEN", "mcp_pat_stale");
    cp.calls.length = 0;
    cp.children.length = 0;
    try {
      const io = captureIO();
      const pending = runUpgrade({
        run: true,
        isSea: () => false,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => null,
        oamProbe: oamProbe(false, MIN_OAM_VERSION),
        // No spawnImpl: defaultSpawn runs, against the mocked child_process.
        out: io.push,
        err: io.pushErr,
      });
      // Let runUpgrade reach the spawn, then settle the child.
      for (let i = 0; i < 100 && cp.calls.length === 0; i++) {
        await new Promise<void>((r) => setImmediate(r));
      }
      expect(cp.calls).toHaveLength(1);
      cp.children[0].emit("close", 0);
      expect((await pending).exitCode).toBe(0);

      const { cmd, args, opts } = cp.calls[0];
      expect(cmd).toBe("npm");
      expect(args).toEqual(["install", "-g", "@yawlabs/mcp@latest"]);
      expect(opts).toMatchObject({ stdio: "inherit", shell: process.platform === "win32" });
      const env = opts.env as NodeJS.ProcessEnv | undefined;
      // An absent `env` option means "inherit process.env" -- the leaking shape.
      expect(env).toBeDefined();
      expect(env).not.toHaveProperty("YAW_MCP_VAULT_PASSPHRASE");
      expect(env).not.toHaveProperty("YAW_MCP_VAULT_PASSPHRASE_NEW");
      expect(env).not.toHaveProperty("YAW_MCP_TOKEN");
      // A strip, not a blank env: npm still has to be found on PATH. The copy
      // keeps process.env's own spelling of the key (`Path` on Windows).
      const pathKey = Object.keys(env ?? {}).find((k) => k.toUpperCase() === "PATH");
      expect(pathKey).toBeDefined();
      expect(env?.[pathKey as string]).toBe(process.env.PATH);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // After a `--run` whose child exited 0, the RUNNING copy's package.json is
  // re-read. localInstallRoot's FIRST-segment rule is kept on purpose (it is
  // what makes pnpm's `.pnpm/<pkg>/node_modules/@yawlabs/mcp` layout resolve to
  // the right root), so a copy nested under another package's node_modules
  // gets `npm install` in the top-level tree: npm adds a NEW top-level
  // dependency, exits 0, and the nested copy the client spawns stays put.
  // "OK: Upgraded" on its own was the silent wrong-tree upgrade the --prefix
  // machinery exists to prevent; the check makes it visible.
  describe("post --run verification of the running copy", () => {
    const NESTED = "/proj/node_modules/foo/node_modules/@yawlabs/mcp/dist/index.js";
    const NESTED_PKG_DIR = "/proj/node_modules/foo/node_modules/@yawlabs/mcp";

    async function runNested(installedVersion: (pkgDir: string) => string | null, childExit = 0) {
      const io = captureIO();
      const spawned: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
      const installed = vi.fn(installedVersion);
      const r = await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: NESTED,
        fetchLatest: async () => "0.45.0",
        spawnImpl: async (cmd, args, cwd) => {
          spawned.push({ cmd, args, cwd });
          return childExit;
        },
        installedVersion: installed,
        out: io.push,
        err: io.pushErr,
      });
      return { io, spawned, installed, r };
    }

    it("warns on stderr, naming the nested directory, when the copy that ran is still on the old version", async () => {
      const { io, spawned, installed, r } = await runNested(() => "0.40.0");
      // The spawn itself is unchanged: first-segment root, no refusal.
      expect(spawned).toEqual([{ cmd: "npm", args: ["install", "@yawlabs/mcp@latest"], cwd: "/proj" }]);
      // The check reads the LAST segment's package dir -- the copy that ran --
      // not the tree npm ran in.
      expect(installed).toHaveBeenCalledWith(NESTED_PKG_DIR);
      // Advisory only: the child did succeed, and scripts branch on 0..3.
      expect(r.exitCode).toBe(0);
      expect(io.out.join("\n")).toContain("OK: Upgraded @yawlabs/mcp to 0.45.0");
      const err = io.err.join("\n");
      expect(err).toContain("WARNING");
      expect(err).toContain("still reports 0.40.0, not 0.45.0");
      expect(err).toContain(NESTED_PKG_DIR);
      expect(err).toContain("different tree");
    });

    it("stays quiet when the running copy is NEWER than the pre-install fetch (dist-tag moved mid-run)", async () => {
      // `latest` is fetched before the child runs and `@latest` resolves at
      // install time, so a release cut between the two leaves the running copy
      // AHEAD of the fetched value. Strict inequality called that the
      // wrong-tree case; only an OLDER running copy is.
      const { io, r } = await runNested(() => "0.46.0");
      expect(r.exitCode).toBe(0);
      expect(io.err.join("\n")).not.toContain("WARNING");
    });

    it("stays quiet when the running copy now reports the new version", async () => {
      const { io, r } = await runNested(() => "0.45.0");
      expect(r.exitCode).toBe(0);
      expect(io.err).toEqual([]);
    });

    it("stays quiet when the running copy's version cannot be read -- unverifiable is not wrong", async () => {
      const { io, installed, r } = await runNested(() => null);
      expect(installed).toHaveBeenCalledTimes(1);
      expect(r.exitCode).toBe(0);
      expect(io.err).toEqual([]);
    });

    it("does not consult the running copy at all when the child failed", async () => {
      const { installed, r } = await runNested(() => "0.40.0", 1);
      expect(r.exitCode).toBe(3);
      expect(installed).not.toHaveBeenCalled();
    });

    it("checks a global install too -- the tree a bare `npm install -g` may have missed", async () => {
      const io = captureIO();
      const installed = vi.fn(() => "0.40.0");
      const r = await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => null,
        spawnImpl: async () => 0,
        installedVersion: installed,
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(0);
      expect(installed).toHaveBeenCalledWith("/usr/lib/node_modules/@yawlabs/mcp");
      expect(io.err.join("\n")).toContain("/usr/lib/node_modules/@yawlabs/mcp");
    });
  });

  // --prefix pinning for global-npm: without it, `npm install -g` writes into
  // whatever `npm prefix -g` resolves, which can be a DIFFERENT tree than the
  // running install (multiple Node versions, custom NPM_CONFIG_PREFIX, the
  // bundled Node) -- the child exits 0, we print "OK: Upgraded", and the copy
  // the client spawns stays stale. Same policy as auto-upgrade's
  // maybeAutoUpgrade, whose detectRunningInstallPrefix backs the default walk.
  describe("--prefix pinning for global-npm", () => {
    it("with --run, passes --prefix from the running-install walk and prints the exact spawned line", async () => {
      const io = captureIO();
      const spawned: Array<{ cmd: string; args: string[] }> = [];
      const r = await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => "/custom/node-root",
        spawnImpl: async (cmd, args) => {
          spawned.push({ cmd, args });
          return 0;
        },
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(0);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]).toEqual({
        cmd: "npm",
        args: ["install", "-g", "--prefix", "/custom/node-root", "@yawlabs/mcp@latest"],
      });
      // The printed line matches what was spawned -- not the bare plan.command.
      expect(io.out.join("\n")).toContain("  npm install -g --prefix /custom/node-root @yawlabs/mcp@latest");
    });

    it("without --run, the 'run it yourself' suggestion carries the same --prefix the spawn would", async () => {
      const io = captureIO();
      const r = await runUpgrade({
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => "/custom/node-root",
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(1);
      expect(io.out.join("\n")).toContain("npm install -g --prefix /custom/node-root @yawlabs/mcp@latest");
    });

    it("falls back to bare `npm install -g` when the walk finds no prefix", async () => {
      const io = captureIO();
      const spawned: Array<{ cmd: string; args: string[] }> = [];
      await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => null,
        spawnImpl: async (cmd, args) => {
          spawned.push({ cmd, args });
          return 0;
        },
        out: io.push,
        err: io.pushErr,
      });
      expect(spawned[0]).toEqual({ cmd: "npm", args: ["install", "-g", "@yawlabs/mcp@latest"] });
    });

    it("routes the detected prefix through quoteShellArgIfNeeded (spaces survive win32's shell:true spawn)", async () => {
      // quoteShellArgIfNeeded quotes only on win32 (POSIX execve needs no
      // quoting), so compute the expectation with the same helper the SUT
      // uses rather than hardcoding a platform's answer.
      const spaced = "/custom/node root";
      const expected = quoteShellArgIfNeeded(spaced);
      expect(expected).not.toBeNull();
      const spawned: Array<{ cmd: string; args: string[] }> = [];
      const io = captureIO();
      await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => spaced,
        spawnImpl: async (cmd, args) => {
          spawned.push({ cmd, args });
          return 0;
        },
        out: io.push,
        err: io.pushErr,
      });
      expect(spawned[0]?.args).toEqual(["install", "-g", "--prefix", expected, "@yawlabs/mcp@latest"]);
    });

    it("never consults the walk for non-global-npm methods", async () => {
      const io = captureIO();
      const runningPrefix = vi.fn(async () => "/should/not/be/used");
      const spawned: Array<{ cmd: string; args: string[] }> = [];
      await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: "/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix,
        spawnImpl: async (cmd, args) => {
          spawned.push({ cmd, args });
          return 0;
        },
        out: io.push,
        err: io.pushErr,
      });
      expect(runningPrefix).not.toHaveBeenCalled();
      expect(spawned[0]).toEqual({ cmd: "pnpm", args: ["add", "-g", "@yawlabs/mcp@latest"] });
    });

    it("offline suggestion carries the same --prefix the spawn would (walk is filesystem-only)", async () => {
      // The walk realpaths argv[1] and never touches the network, so the
      // "when you're back online" suggestion must pin the prefix too -- a
      // bare `-g` there re-opens the wrong-tree hazard for the one user who
      // will paste it verbatim later.
      const io = captureIO();
      const r = await runUpgrade({
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => null,
        runningPrefix: async () => "/custom/node-root",
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(0);
      const out = io.out.join("\n");
      expect(out).toMatch(/couldn't reach/i);
      expect(out).toContain("npm install -g --prefix /custom/node-root @yawlabs/mcp@latest");
      expect(out).not.toContain("npm install -g @yawlabs/mcp@latest");
    });

    it("--json plan.command carries the same --prefix the spawn would", async () => {
      const io = captureIO();
      const r = await runUpgrade({
        json: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => "/custom/node-root",
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(1);
      const parsed = JSON.parse(io.out.join("\n"));
      expect(parsed.command).toBe("npm install -g --prefix /custom/node-root @yawlabs/mcp@latest");
      expect(parsed).toMatchObject({ stale: true, method: "global-npm" });
    });

    it("--json + offline still pins --prefix in the command", async () => {
      const io = captureIO();
      const r = await runUpgrade({
        json: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => null,
        runningPrefix: async () => "/custom/node-root",
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(io.out.join("\n"));
      expect(parsed.latest).toBeNull();
      expect(parsed.command).toBe("npm install -g --prefix /custom/node-root @yawlabs/mcp@latest");
    });

    it("display-quotes a whitespace prefix in printed lines; the spawn argv keeps the platform form", async () => {
      // Display and spawn quoting are computed independently: the spawn
      // argv gets quoteShellArgIfNeeded (raw on POSIX, double-quoted on
      // win32), the printed line gets quoteArgForDisplay (single-quoted on
      // POSIX so the paste doesn't split, same double quotes on win32).
      // Compute both expectations with the SUT's own helpers rather than
      // hardcoding one platform's answer.
      const spaced = "/custom/node root";
      const expectedSpawn = quoteShellArgIfNeeded(spaced);
      const expectedDisplay = quoteArgForDisplay(spaced);
      expect(expectedSpawn).not.toBeNull();
      expect(expectedDisplay).not.toBeNull();
      const spawned: Array<{ cmd: string; args: string[] }> = [];
      const io = captureIO();
      const r = await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => spaced,
        spawnImpl: async (cmd, args) => {
          spawned.push({ cmd, args });
          return 0;
        },
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(0);
      expect(spawned[0]?.args).toEqual(["install", "-g", "--prefix", expectedSpawn, "@yawlabs/mcp@latest"]);
      expect(io.out.join("\n")).toContain(`  npm install -g --prefix ${expectedDisplay} @yawlabs/mcp@latest`);
    });

    it("exit-1 and exit-3 manual-run suggestions both use the display-quoted prefix", async () => {
      const spaced = "/custom/node root";
      const expectedDisplay = quoteArgForDisplay(spaced);
      const suggestion = `  npm install -g --prefix ${expectedDisplay} @yawlabs/mcp@latest`;

      // exit 1: stale without --run.
      const io1 = captureIO();
      const r1 = await runUpgrade({
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => spaced,
        out: io1.push,
        err: io1.pushErr,
      });
      expect(r1.exitCode).toBe(1);
      expect(io1.out.join("\n")).toContain(suggestion);

      // exit 3: --run whose child failed; the retry hint goes to stderr.
      const io3 = captureIO();
      const r3 = await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => spaced,
        spawnImpl: async () => 42,
        out: io3.push,
        err: io3.pushErr,
      });
      expect(r3.exitCode).toBe(3);
      expect(io3.err.join("\n")).toContain(suggestion);
    });

    // An unquotable prefix drops `--prefix` from BOTH the spawn argv and every
    // printed suggestion -- npm's own resolution is the worse-but-safe fallback,
    // and a mangled command line is not. Only win32 can refuse a value
    // (cmd.exe expands %VAR% and breaks on a literal quote regardless of
    // quoting), so opts.platform is the only way a POSIX runner reaches it.
    it("drops --prefix entirely when the prefix cannot be quoted for win32's shell", async () => {
      const unquotable = "C:\\pct%path";
      expect(quoteShellArgIfNeeded(unquotable, "win32")).toBeNull();
      expect(quoteArgForDisplay(unquotable, "win32")).toBeNull();

      const io = captureIO();
      const spawned: Array<{ cmd: string; args: string[] }> = [];
      const r = await runUpgrade({
        run: true,
        platform: "win32",
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => unquotable,
        spawnImpl: async (cmd, args) => {
          spawned.push({ cmd, args });
          return 0;
        },
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(0);
      expect(spawned[0]).toEqual({ cmd: "npm", args: ["install", "-g", "@yawlabs/mcp@latest"] });
      // The printed line must fall back with the argv, not advertise a prefix
      // the spawn did not pass.
      const out = io.out.join("\n");
      expect(out).toContain("  npm install -g @yawlabs/mcp@latest");
      expect(out).not.toContain("--prefix");
    });

    it("--json falls back to the bare -g command for an unquotable win32 prefix", async () => {
      const io = captureIO();
      const r = await runUpgrade({
        json: true,
        platform: "win32",
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        runningPrefix: async () => "C:\\pct%path",
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(io.out.join("\n")).command).toBe("npm install -g @yawlabs/mcp@latest");
    });
  });

  it("with --run, propagates the child exit code as 3 on failure", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async () => 42,
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(3);
    expect(io.err.join("\n")).toContain("npm exited 42");
  });

  it("with --run on a local-node-modules install, spawns npm install in the tree root", async () => {
    const io = captureIO();
    const spawned: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/proj/app/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async (cmd, args, cwd) => {
        spawned.push({ cmd, args, cwd });
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual({ cmd: "npm", args: ["install", "@yawlabs/mcp@latest"], cwd: "/proj/app" });
    expect(io.out.join("\n")).toContain("OK: Upgraded @yawlabs/mcp to 0.45.0");
  });

  it("with --run on a pnpm global store, spawns pnpm (never npm-installs into the store)", async () => {
    const io = captureIO();
    const spawned: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/home/u/.local/share/pnpm/global/5/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async (cmd, args, cwd) => {
        spawned.push({ cmd, args, cwd });
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual({ cmd: "pnpm", args: ["add", "-g", "@yawlabs/mcp@latest"], cwd: undefined });
  });

  it("with --run on a dev checkout, refuses with exit 2 and prints the command", async () => {
    const io = captureIO();
    let didSpawn = false;
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/home/jeff/yaw/yaw-mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async () => {
        didSpawn = true;
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(2);
    expect(didSpawn).toBe(false);
    const err = io.err.join("\n");
    expect(err).toContain("can't be upgraded automatically");
    expect(err).toContain("git pull && npm run build");
  });

  it("without --run on a local-node-modules install, prints 'in <root>:' above the command", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/proj/app/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    const out = io.out.join("\n");
    expect(out).toContain("in /proj/app:");
    // Command must be on its own line with no trailing punctuation.
    const cmdLine = io.out.find((l) => l.includes("npm install @yawlabs/mcp@latest"));
    expect(cmdLine).toBeDefined();
    expect(cmdLine!.trimEnd()).toMatch(/@latest$/);
    // The 'in <root>:' line must appear before the command line.
    const rootIdx = io.out.findIndex((l) => l.includes("in /proj/app:"));
    const cmdIdx = io.out.findIndex((l) => l.includes("npm install @yawlabs/mcp@latest"));
    expect(rootIdx).toBeLessThan(cmdIdx);
  });

  // A local install's command is only correct from the tree root: run anywhere
  // else, `npm install @yawlabs/mcp@latest` writes a stray package.json +
  // node_modules there and leaves the stale copy alone. Every surface that
  // hands the command over therefore has to hand over the directory with it --
  // the exit-1 listing above did, and these three did not.
  describe("the install root travels with the command on every surface", () => {
    const localArgv = "/proj/app/node_modules/@yawlabs/mcp/dist/index.js";

    it("--json reports cwd alongside the command", async () => {
      const io = captureIO();
      const r = await runUpgrade({
        json: true,
        currentVersion: "0.40.0",
        argvPath: localArgv,
        fetchLatest: async () => "0.45.0",
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(io.out.join("\n"))).toMatchObject({
        method: "local-node-modules",
        command: "npm install @yawlabs/mcp@latest",
        cwd: "/proj/app",
      });
    });

    it("--json reports cwd: null for a method whose command runs anywhere", async () => {
      const io = captureIO();
      await runUpgrade({
        json: true,
        currentVersion: "0.40.0",
        argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
        fetchLatest: async () => "0.45.0",
        out: io.push,
        err: io.pushErr,
      });
      expect(JSON.parse(io.out.join("\n")).cwd).toBeNull();
    });

    it("the offline 'when you're back online' suggestion names the root", async () => {
      const io = captureIO();
      const r = await runUpgrade({
        currentVersion: "0.40.0",
        argvPath: localArgv,
        fetchLatest: async () => null,
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(0);
      const rootIdx = io.out.findIndex((l) => l.includes("in /proj/app:"));
      const cmdIdx = io.out.findIndex((l) => l.includes("npm install @yawlabs/mcp@latest"));
      expect(rootIdx).toBeGreaterThanOrEqual(0);
      expect(rootIdx).toBeLessThan(cmdIdx);
    });

    it("the exit-3 retry hint names the root the failed child ran in", async () => {
      const io = captureIO();
      const r = await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: localArgv,
        fetchLatest: async () => "0.45.0",
        spawnImpl: async () => 42,
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(3);
      const rootIdx = io.err.findIndex((l) => l.includes("in /proj/app:"));
      const cmdIdx = io.err.findIndex((l) => l.includes("npm install @yawlabs/mcp@latest"));
      expect(rootIdx).toBeGreaterThanOrEqual(0);
      expect(rootIdx).toBeLessThan(cmdIdx);
    });
  });

  it("without --run on a dev checkout, prints the command and notes --run won't work", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/home/jeff/yaw/yaw-mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    const out = io.out.join("\n");
    expect(out).toContain("Run it yourself");
    expect(out).toContain("git pull && npm run build");
  });

  it("tells Yaw Terminal bundled-copy users the app updates it (exit 0, no spawn)", async () => {
    const io = captureIO();
    let didSpawn = false;
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/Applications/Yaw.app/Contents/Resources/app.asar.unpacked/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async () => {
        didSpawn = true;
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(didSpawn).toBe(false);
    const out = io.out.join("\n");
    expect(out).toContain("Update Yaw Terminal");
    expect(out).not.toContain("npm install");
  });

  it("command lines carry no trailing punctuation (copy-friendly)", async () => {
    const io = captureIO();
    await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    const cmdLines = io.out.filter((l) => l.includes("npm install"));
    expect(cmdLines.length).toBeGreaterThan(0);
    for (const line of cmdLines) {
      expect(line.trimEnd()).toMatch(/@latest$/);
    }
  });

  it("--json emits the plan and exits 1 when stale without --run", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      json: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed).toMatchObject({
      current: "0.40.0",
      latest: "0.45.0",
      stale: true,
      method: "global-npm",
      command: "npm install -g @yawlabs/mcp@latest",
    });
    // Never contains the human-readable summary lines.
    expect(io.out.join("\n")).not.toContain("Current: 0.40.0");
  });

  it("handles a null latest (offline) gracefully", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => null,
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const out = io.out.join("\n");
    expect(out).toMatch(/couldn't reach/i);
    // Still prints the suggested command so the user can copy it.
    expect(out).toContain("npm install -g @yawlabs/mcp@latest");
  });

  it("--json + offline emits plan with latest: null", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      json: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => null,
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.latest).toBeNull();
    expect(parsed.stale).toBe(false);
  });

  it("--json --run emits JSON, never spawns, and STILL exits 1 on a stale install", async () => {
    // Pins that --json is a report-only snapshot: combining it with --run
    // must NOT spawn the upgrade -- and, because nothing was installed, must
    // NOT report success either. The old `plan.stale && !opts.run` exit rule
    // returned 0 here, so a script that added --json purely to parse the
    // output silently lost both the upgrade and the "you are stale" signal.
    const io = captureIO();
    let didSpawn = false;
    const r = await runUpgrade({
      json: true,
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async () => {
        didSpawn = true;
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(didSpawn).toBe(false);
    // JSON branch emits the plan and exits on staleness ALONE -- --run does
    // not soften it, because --run never installed anything here.
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.stale).toBe(true);
    expect(r.exitCode).toBe(1);
  });

  it("--json --run on an UP-TO-DATE install still exits 0", async () => {
    // The new rule keys on staleness only, so the not-stale side must stay 0 --
    // otherwise every scripted `upgrade --json --run` poll reports failure.
    const io = captureIO();
    const r = await runUpgrade({
      json: true,
      run: true,
      currentVersion: "0.45.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(JSON.parse(io.out.join("\n")).stale).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it("offline (fetchLatest null) with bundled-app argvPath: prints the app-update hint, never spawns, exit 0", async () => {
    // Item 3: offline + bundled-app must print the app-update hint, never
    // an npm command, and always exit 0.
    const io = captureIO();
    let didSpawn = false;
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/Applications/Yaw.app/Contents/Resources/app.asar.unpacked/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => null,
      spawnImpl: async () => {
        didSpawn = true;
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(didSpawn).toBe(false);
    const out = io.out.join("\n");
    expect(out).toContain("Yaw Terminal");
    expect(out).not.toContain("npm install");
    expect(out).not.toContain("npm run");
  });

  it("with --run on a bun-global argvPath, spawns ['bun', ['add', '-g', '@yawlabs/mcp@latest']]", async () => {
    // Item 4: mirror the pnpm-global --run test for bun-global.
    const io = captureIO();
    const spawned: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/home/u/.bun/install/global/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async (cmd, args, cwd) => {
        spawned.push({ cmd, args, cwd });
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual({ cmd: "bun", args: ["add", "-g", "@yawlabs/mcp@latest"], cwd: undefined });
    expect(io.out.join("\n")).toContain("OK: Upgraded @yawlabs/mcp to 0.45.0");
  });

  it("tells a standalone-binary user the track was retired: install from npm (exit 1)", async () => {
    // The SEA binary track was retired in 0.70.3 and the releases page is
    // frozen at v0.70.2 -- OLDER than npm -- so pointing binary users at
    // "releases/latest" was a dead end. The path forward is the npm
    // install plus deleting the old executable.
    const io = captureIO();
    const r = await runUpgrade({
      isSea: () => true,
      currentVersion: "0.40.0",
      argvPath: "/opt/yaw-mcp/yaw-mcp",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    const out = io.out.join("\n");
    expect(out).toContain("Install: binary");
    expect(out).toContain("standalone binary");
    expect(out).toContain("retired in 0.70.3");
    expect(out).toContain("npm install -g @yawlabs/mcp@latest");
    expect(out).toContain("delete this executable");
    expect(out).not.toContain("releases/latest");
  });

  it("with --run on a binary, refuses with exit 2 (no package manager to run)", async () => {
    const io = captureIO();
    let didSpawn = false;
    const r = await runUpgrade({
      run: true,
      isSea: () => true,
      currentVersion: "0.40.0",
      argvPath: "/opt/yaw-mcp/yaw-mcp",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async () => {
        didSpawn = true;
        return 0;
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(2);
    expect(didSpawn).toBe(false);
    // The retired-track hint NAMES the npm command, but only as something
    // the USER runs manually -- --run must still refuse to spawn anything.
    //
    // ...and the refusal goes to STDERR, like the dev-checkout / unknown one
    // below. They are the same documented exit-2 class, and a script that
    // redirects a stream to catch the refusal cannot be expected to know which
    // non-runnable method it hit. The exit-1 listing above stays on stdout.
    expect(io.err.join("\n")).toContain("manual upgrade required");
    expect(io.out.join("\n")).not.toContain("manual upgrade required");
  });

  it("--json reports method: binary with a null command", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      json: true,
      isSea: () => true,
      currentVersion: "0.40.0",
      argvPath: "/opt/yaw-mcp/yaw-mcp",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed).toMatchObject({ method: "binary", command: null, stale: true });
  });

  it("warns that oam is below the floor even when yaw-mcp itself has nothing to do", async () => {
    // MIN_OAM_VERSION tracks the LATEST oam release, so upgrading yaw-mcp can
    // raise the floor past the user's oam and silently drop every sidecar from
    // oam to node. `upgrade` is the command a user runs to "get current", and it
    // used to print "nothing to do" with no mention of that -- the only other
    // notices are a warn line on the broker's stderr (which MCP clients hide)
    // and `doctor`.
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.45.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      oamProbe: oamProbe(true, BELOW_FLOOR_OAM),
      out: io.push,
      err: io.pushErr,
    });
    // Advisory only: the exit-code contract for "already current" is unchanged.
    expect(r.exitCode).toBe(0);
    const out = io.out.join("\n");
    expect(out).toContain("nothing to do");
    expect(out).toContain(`v${BELOW_FLOOR_OAM}`);
    expect(out).toContain("oam self-update");
    expect(out).toContain("run on node instead of oam");
    // The floor the note NAMES has to be the floor the spawn path enforces.
    // Pinning only the probe's own version left the interpolated MIN_OAM_VERSION
    // free to be anything -- including a literal that stopped tracking the
    // constant -- while the test stayed green.
    expect(out).toContain(`below the v${MIN_OAM_VERSION} floor`);
  });

  it("fixture sanity: the below-floor literal IS below MIN_OAM_VERSION, and the derived above-floor version IS above it", () => {
    // The SUT reads only belowMin, so a fixture whose version contradicts the
    // floor stays green while stating a relationship that is false -- and reads
    // as a bug to whoever bumps the floor next. Pin the fixtures to the constant.
    expect(compareVersions(BELOW_FLOOR_OAM, MIN_OAM_VERSION)).toBeLessThan(0);
    expect(compareVersions(bumpPatch(MIN_OAM_VERSION), MIN_OAM_VERSION)).toBeGreaterThan(0);
  });

  it("says nothing about oam when it is absent or already at/above the floor", async () => {
    const io = captureIO();
    await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      oamProbe: oamProbe(false, bumpPatch(MIN_OAM_VERSION)),
      out: io.push,
      err: io.pushErr,
    });
    const out = io.out.join("\n");
    // Assert on the advisory's own lines, not on the substring "oam": ordinary
    // Windows output contains it ("AppData/Roaming"), so a bare
    // not.toContain("oam") is a test that can fail for a reason it does not
    // mean -- and, on a path without it, one that passes without checking much.
    expect(out).not.toContain("oam self-update");
    expect(out).not.toContain("floor yaw-mcp");
    expect(out).not.toContain("instead of oam");
  });

  it("keeps the oam note out of --json (the snapshot stays machine-parseable)", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      json: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      oamProbe: oamProbe(true, BELOW_FLOOR_OAM),
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    // Would throw if an advisory line leaked into the snapshot.
    expect(JSON.parse(io.out.join("\n"))).toMatchObject({ method: "global-npm", stale: true });
  });

  it("never fails the upgrade when the oam probe throws", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.45.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      oamProbe: async () => {
        throw new Error("oam probe exploded");
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    expect(io.out.join("\n")).toContain("nothing to do");
  });

  it("offline + binary says the track was retired, not the npx restart message", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      isSea: () => true,
      currentVersion: "0.40.0",
      argvPath: "/opt/yaw-mcp/yaw-mcp",
      fetchLatest: async () => null,
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const out = io.out.join("\n");
    expect(out).toContain("standalone binary");
    expect(out).toContain("retired in 0.70.3");
    expect(out).not.toContain("npx");
  });

  it("still prints the oam floor note when the registry is unreachable", async () => {
    // The oam probe is LOCAL (`oam --version`); an unreachable npm registry
    // says nothing about it. The note used to sit below the offline return, so
    // the one user who cannot fix the yaw-mcp half right now was also the one
    // never told their sidecars had already dropped from oam to node.
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => null,
      oamProbe: oamProbe(true, BELOW_FLOOR_OAM),
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const out = io.out.join("\n");
    expect(out).toMatch(/couldn't reach/i);
    expect(out).toContain(`below the v${MIN_OAM_VERSION} floor`);
    expect(out).toContain("oam self-update");
  });

  // Gaps the header's SCRIPTING TRAP note names but nothing exercised: the
  // `unknown` method's two exit codes, the refinement probe reaching runUpgrade
  // at all, and a fetchLatest that rejects rather than resolving null.
  describe("the `unknown` install method", () => {
    // No node_modules segment, no npx cache, no `<repo>/(dist|src)` checkout
    // shape -- and no realpath to rescue it, since the path is fictional.
    const unknownArgv = "/opt/custom/yaw-mcp-launcher.js";

    it("exits 1 with 'Manual upgrade required' and never promises --run", async () => {
      const io = captureIO();
      const r = await runUpgrade({
        currentVersion: "0.40.0",
        argvPath: unknownArgv,
        fetchLatest: async () => "0.45.0",
        out: io.push,
        err: io.pushErr,
      });
      expect(r.exitCode).toBe(1);
      const out = io.out.join("\n");
      expect(out).toContain("Install: unknown");
      expect(out).toContain("Manual upgrade required");
      expect(out).not.toContain("to upgrade in place");
      expect(out).toContain("npm install -g @yawlabs/mcp@latest");
    });

    it("refuses --run with exit 2 on stderr rather than mutating an install it cannot name", async () => {
      const io = captureIO();
      let didSpawn = false;
      const r = await runUpgrade({
        run: true,
        currentVersion: "0.40.0",
        argvPath: unknownArgv,
        fetchLatest: async () => "0.45.0",
        spawnImpl: async () => {
          didSpawn = true;
          return 0;
        },
        out: io.push,
        err: io.pushErr,
      });
      // The 1 -> 2 transition the file header documents: a script that reads 1
      // as "retry with --run" lands here forever, never on 0.
      expect(r.exitCode).toBe(2);
      expect(didSpawn).toBe(false);
      const err = io.err.join("\n");
      expect(err).toContain('a "unknown" install can\'t be upgraded automatically');
      expect(err).toContain("npm install -g @yawlabs/mcp@latest");
    });
  });

  it("wires opts.npmPrefix through to the refinement probe", async () => {
    // npmGlobalPrefix short-circuits to null under vitest, so this hook is the
    // ONLY way the second-chance classification is reachable from runUpgrade --
    // and it is what rescues an exotic prefix (custom NPM_CONFIG_PREFIX, a new
    // tool manager) that no path marker knows.
    const io = captureIO();
    const npmPrefix = vi.fn(async () => "/custom/prefix");
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/custom/prefix/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => "0.45.0",
      npmPrefix,
      out: io.push,
      err: io.pushErr,
    });
    expect(npmPrefix).toHaveBeenCalledTimes(1);
    expect(r.exitCode).toBe(1);
    const out = io.out.join("\n");
    // Without the probe this path classifies local-node-modules and hands out a
    // cwd-scoped `npm install` that would install into the global prefix's tree.
    expect(out).toContain("Install: global-npm");
    expect(out).toContain("npm install -g @yawlabs/mcp@latest");
  });

  it("treats a REJECTING fetchLatest exactly like an unreachable registry", async () => {
    // fetchLatestVersion resolves null on every failure of its own, but the
    // hook is caller-supplied: doctor's registryFetch shape can throw, and a
    // throw here must degrade to the offline path rather than take the command
    // down with a stack trace.
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcp/dist/index.js",
      fetchLatest: async () => {
        throw new Error("DNS went away");
      },
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const out = io.out.join("\n");
    expect(out).toMatch(/couldn't reach/i);
    expect(out).toContain("npm install -g @yawlabs/mcp@latest");
  });
});

// ---------------------------------------------------------------------------
// killProcessTree -- the timeout teardown behind npmGlobalPrefix.
//
// The probe spawns with `shell: true` on win32 (npm is npm.cmd and Node
// refuses to spawn a .cmd without a shell), so the pid we hold belongs to
// cmd.exe, not npm. A bare child.kill() reaped the wrapper and left the
// npm -> node grandchild running -- it could outlive the CLI process that
// started the 3s probe. npmGlobalPrefix itself short-circuits under VITEST,
// so this helper is the only reachable surface for that path.
// ---------------------------------------------------------------------------

describe("killProcessTree", () => {
  it("kills the whole tree via taskkill on win32, then still calls kill()", () => {
    const kill = vi.fn(() => true);
    const on = vi.fn();
    const spawnImpl = vi.fn(() => ({ on }));

    killProcessTree({ pid: 4321, kill }, "win32", spawnImpl);

    expect(spawnImpl).toHaveBeenCalledWith("taskkill", ["/pid", "4321", "/T", "/F"], { stdio: "ignore" });
    // The error sink is load-bearing: an unhandled 'error' event on a spawned
    // child takes the process down.
    expect(on).toHaveBeenCalledWith("error", expect.any(Function));
    // kill() still runs so the probe's close/error handler resolves.
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("uses a plain kill on POSIX, where there is no shell wrapper to punch through", () => {
    const kill = vi.fn(() => true);
    const spawnImpl = vi.fn(() => ({ on: vi.fn() }));

    killProcessTree({ pid: 4321, kill }, "linux", spawnImpl);

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("falls back to the plain kill when taskkill itself cannot be spawned", () => {
    const kill = vi.fn(() => true);
    const spawnImpl = vi.fn(() => {
      throw new Error("taskkill: not found");
    });

    expect(() => killProcessTree({ pid: 4321, kill }, "win32", spawnImpl)).not.toThrow();
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("skips taskkill when the child never got a pid", () => {
    const kill = vi.fn(() => true);
    const spawnImpl = vi.fn(() => ({ on: vi.fn() }));

    killProcessTree({ pid: undefined, kill }, "win32", spawnImpl);

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledTimes(1);
  });
});
