import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG_DIRNAME, GUIDE_FILENAME, cacheDir, findProjectConfigDir, guidePath, userConfigDir } from "../paths.js";

describe("cacheDir", () => {
  const ORIG_PLATFORM = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: ORIG_PLATFORM });
    vi.unstubAllEnvs();
  });

  it("uses LOCALAPPDATA on Windows when set", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("LOCALAPPDATA", "C:\\Users\\test\\AppData\\Local");
    expect(cacheDir()).toMatch(/mcph[\\/]Cache$/);
    expect(cacheDir().startsWith("C:\\Users\\test\\AppData\\Local")).toBe(true);
  });

  it("falls back to homedir on Windows when LOCALAPPDATA missing", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("LOCALAPPDATA", "");
    expect(cacheDir()).toMatch(/AppData[\\/]Local[\\/]mcph[\\/]Cache$/);
  });

  it("uses ~/Library/Caches on darwin", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(cacheDir()).toMatch(/Library[\\/]Caches[\\/]mcph$/);
  });

  it("honors XDG_CACHE_HOME on linux", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("XDG_CACHE_HOME", "/custom/cache");
    // path.join uses the host separator — tests run on Windows during
    // dev, Linux in CI — so match flexibly on "custom/cache/mcph".
    expect(cacheDir()).toMatch(/custom[\\/]cache[\\/]mcph$/);
  });

  it("falls back to ~/.cache on linux when XDG_CACHE_HOME missing", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("XDG_CACHE_HOME", "");
    expect(cacheDir()).toMatch(/\.cache[\\/]mcph$/);
  });

  it("ignores empty XDG_CACHE_HOME", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("XDG_CACHE_HOME", "");
    expect(cacheDir()).toMatch(/\.cache[\\/]mcph$/);
  });
});

describe("userConfigDir", () => {
  it("returns <home>/.mcph", () => {
    expect(userConfigDir("/home/alice")).toMatch(/^[/\\]home[/\\]alice[/\\]\.mcph$/);
  });

  it("uses os.homedir() when no arg passed", () => {
    // Just assert the tail — the prefix is whatever the host reports.
    expect(userConfigDir().endsWith(CONFIG_DIRNAME)).toBe(true);
  });
});

describe("guidePath", () => {
  it("returns <dir>/MCPH.md", () => {
    expect(guidePath("/tmp/.mcph")).toMatch(/[/\\]\.mcph[/\\]MCPH\.md$/);
  });

  it("uses the GUIDE_FILENAME constant", () => {
    expect(guidePath("/x")).toMatch(new RegExp(`${GUIDE_FILENAME.replace(".", "\\.")}$`));
  });
});

describe("findProjectConfigDir", () => {
  let home: string;
  let root: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mcph-paths-home-"));
    // Root of the synthetic project tree lives next to (not under)
    // `home` so walk-up from deep in `root` genuinely crosses fs
    // levels without ever hitting `home`.
    root = mkdtempSync(join(tmpdir(), "mcph-paths-proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null when no .mcph/ exists anywhere up to home", async () => {
    const sub = join(root, "a", "b", "c");
    mkdirSync(sub, { recursive: true });
    expect(await findProjectConfigDir(sub, home)).toBeNull();
  });

  it("finds a .mcph/ at the starting directory", async () => {
    const cfgDir = join(root, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    expect(await findProjectConfigDir(root, home)).toBe(cfgDir);
  });

  it("walks up when started in a deep subdirectory", async () => {
    const cfgDir = join(root, CONFIG_DIRNAME);
    mkdirSync(cfgDir);
    const deep = join(root, "pkg", "src", "nested");
    mkdirSync(deep, { recursive: true });
    expect(await findProjectConfigDir(deep, home)).toBe(cfgDir);
  });

  it("stops BEFORE $HOME — a .mcph/ in home is NOT returned as a project dir", async () => {
    // .mcph/ lives at $HOME. That's the user-global scope, handled
    // separately by userConfigDir(). findProjectConfigDir must not
    // claim it, or the config loader would double-load the same file
    // as both project and user-global.
    mkdirSync(join(home, CONFIG_DIRNAME));
    const sub = join(home, "projects", "p1");
    mkdirSync(sub, { recursive: true });
    expect(await findProjectConfigDir(sub, home)).toBeNull();
  });

  it("prefers the nearest .mcph/ when multiple exist on the path", async () => {
    mkdirSync(join(root, CONFIG_DIRNAME));
    const innerProject = join(root, "apps", "web");
    mkdirSync(innerProject, { recursive: true });
    const innerCfg = join(innerProject, CONFIG_DIRNAME);
    mkdirSync(innerCfg);
    const startFrom = join(innerProject, "src");
    mkdirSync(startFrom);
    expect(await findProjectConfigDir(startFrom, home)).toBe(innerCfg);
  });
});
