import { describe, expect, it } from "vitest";
import {
  type InstallMethod,
  buildUpgradePlan,
  detectInstallMethod,
  parseUpgradeArgs,
  runUpgrade,
} from "../upgrade-cmd.js";

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
    if (!r.ok) expect(r.error).toContain("Usage: mcph upgrade");
  });
});

describe("detectInstallMethod", () => {
  it("returns `unknown` for undefined argvPath", () => {
    expect(detectInstallMethod(undefined)).toBe("unknown");
  });

  it("detects npx cache on linux/macos", () => {
    expect(detectInstallMethod("/home/user/.npm/_npx/abc123/node_modules/@yawlabs/mcph/dist/index.js")).toBe("npx");
  });

  it("detects npx cache on windows", () => {
    expect(
      detectInstallMethod(
        "C:\\Users\\jeff\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@yawlabs\\mcph\\dist\\index.js",
      ),
    ).toBe("npx");
  });

  it("detects linux global install under /usr/lib/node_modules", () => {
    expect(detectInstallMethod("/usr/lib/node_modules/@yawlabs/mcph/dist/index.js")).toBe("global-npm");
  });

  it("detects macos homebrew-style /usr/local/lib/node_modules", () => {
    expect(detectInstallMethod("/usr/local/lib/node_modules/@yawlabs/mcph/dist/index.js")).toBe("global-npm");
  });

  it("detects windows global npm under AppData/Roaming/npm", () => {
    expect(
      detectInstallMethod("C:\\Users\\jeff\\AppData\\Roaming\\npm\\node_modules\\@yawlabs\\mcph\\dist\\index.js"),
    ).toBe("global-npm");
  });

  it("detects nvm-style /home/u/.nvm/versions/node/.../lib/node_modules as global", () => {
    expect(
      detectInstallMethod("/home/u/.nvm/versions/node/v22.11.0/lib/node_modules/@yawlabs/mcph/dist/index.js"),
    ).toBe("global-npm");
  });

  it("detects a project-local node_modules install", () => {
    expect(detectInstallMethod("/proj/app/node_modules/@yawlabs/mcph/dist/index.js")).toBe("local-node-modules");
  });

  it("detects dev checkout (src/)", () => {
    expect(detectInstallMethod("/home/jeff/yaw/mcph/src/index.ts")).toBe("dev-checkout");
  });

  it("detects dev checkout (dist/)", () => {
    expect(detectInstallMethod("/home/jeff/yaw/mcph/dist/index.js")).toBe("dev-checkout");
  });
});

describe("buildUpgradePlan", () => {
  const method = (m: InstallMethod) => m;

  it("flags stale=true when current < latest", () => {
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: method("global-npm") });
    expect(plan.stale).toBe(true);
    expect(plan.command).toBe("npm install -g @yawlabs/mcph@latest");
  });

  it("flags stale=false when current === latest", () => {
    const plan = buildUpgradePlan({ current: "0.45.0", latest: "0.45.0", method: method("global-npm") });
    expect(plan.stale).toBe(false);
  });

  it("flags stale=false when latest is null (offline)", () => {
    const plan = buildUpgradePlan({ current: "0.45.0", latest: null, method: method("global-npm") });
    expect(plan.stale).toBe(false);
  });

  it("returns null command for npx (nothing to run)", () => {
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: method("npx") });
    expect(plan.command).toBeNull();
    expect(plan.stale).toBe(true);
  });

  it("uses plain `npm install` for local node_modules", () => {
    const plan = buildUpgradePlan({ current: "0.40.0", latest: "0.45.0", method: method("local-node-modules") });
    expect(plan.command).toBe("npm install @yawlabs/mcph@latest");
  });

  it("suggests git pull for dev checkouts", () => {
    const plan = buildUpgradePlan({ current: "dev", latest: "0.45.0", method: method("dev-checkout") });
    expect(plan.command).toContain("git pull");
    // dev is always non-stale because the version string doesn't parse.
    expect(plan.stale).toBe(false);
  });
});

describe("runUpgrade", () => {
  it("prints Current/Latest and flags already-up-to-date", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.45.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcph/dist/index.js",
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
  });

  it("exits 1 and prints the command when stale and --run not passed (global-npm)", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcph/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    expect(io.out.join("\n")).toContain("npm install -g @yawlabs/mcph@latest");
  });

  it("tells npx users to restart the MCP client (exit 0, no command)", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/home/u/.npm/_npx/abc/node_modules/@yawlabs/mcph/dist/index.js",
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
      argvPath: "/usr/lib/node_modules/@yawlabs/mcph/dist/index.js",
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
    expect(spawned[0]).toEqual({ cmd: "npm", args: ["install", "-g", "@yawlabs/mcph@latest"] });
    expect(io.out.join("\n")).toContain("Upgraded @yawlabs/mcph to 0.45.0");
  });

  it("with --run, propagates the child exit code as 3 on failure", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcph/dist/index.js",
      fetchLatest: async () => "0.45.0",
      spawnImpl: async () => 42,
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(3);
    expect(io.err.join("\n")).toContain("npm exited 42");
  });

  it("with --run on a non-global install method, refuses with exit 2", async () => {
    const io = captureIO();
    let didSpawn = false;
    const r = await runUpgrade({
      run: true,
      currentVersion: "0.40.0",
      argvPath: "/proj/app/node_modules/@yawlabs/mcph/dist/index.js",
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
    expect(io.err.join("\n")).toContain("can't be upgraded automatically");
  });

  it("without --run on a non-global method, prints suggested command and notes --run won't work", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/proj/app/node_modules/@yawlabs/mcph/dist/index.js",
      fetchLatest: async () => "0.45.0",
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(1);
    const out = io.out.join("\n");
    expect(out).toContain("Suggested command");
    expect(out).toContain("--run only works for global-npm");
  });

  it("--json emits the plan and exits 1 when stale without --run", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      json: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcph/dist/index.js",
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
      command: "npm install -g @yawlabs/mcph@latest",
    });
    // Never contains the human-readable summary lines.
    expect(io.out.join("\n")).not.toContain("Current: 0.40.0");
  });

  it("handles a null latest (offline) gracefully", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcph/dist/index.js",
      fetchLatest: async () => null,
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const out = io.out.join("\n");
    expect(out).toMatch(/couldn't reach/i);
    // Still prints the suggested command so the user can copy it.
    expect(out).toContain("npm install -g @yawlabs/mcph@latest");
  });

  it("--json + offline emits plan with latest: null", async () => {
    const io = captureIO();
    const r = await runUpgrade({
      json: true,
      currentVersion: "0.40.0",
      argvPath: "/usr/lib/node_modules/@yawlabs/mcph/dist/index.js",
      fetchLatest: async () => null,
      out: io.push,
      err: io.pushErr,
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed.latest).toBeNull();
    expect(parsed.stale).toBe(false);
  });
});
