import { afterEach, describe, expect, it, vi } from "vitest";

import { cacheDir } from "../paths.js";

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
