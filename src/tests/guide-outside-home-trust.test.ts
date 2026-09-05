import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadProjectGuide } from "../guide.js";
import { ALLOW_UNOWNED_ENV, CONFIG_DIRNAME, GUIDE_FILENAME } from "../paths.js";

// Guide-level integration of the outside-$HOME trust gate in paths.ts: a
// checkout on a second drive / container workspace only serves its
// YAW-MCP.md when the `.yaw-mcp/` passes the ownership gate (POSIX uid
// match) or the explicit env opt-in (platforms without geteuid, i.e.
// win32). Sits in its own file because these cases need geteuid/env stubs
// the main guide suite doesn't carry.
describe("loadProjectGuide outside $HOME trust gate", () => {
  let home: string;
  let outside: string;
  const ORIG_GETEUID = Object.getOwnPropertyDescriptor(process, "geteuid");

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yaw-mcp-guide-trust-home-"));
    // `outside` is a SIBLING of the synthetic home, not a child, which is the
    // whole point: findProjectConfigDir only stops at the $HOME bound for a
    // walk that started under $HOME, so out here the walk runs to the
    // filesystem root. The `.yaw-mcp/` is planted at the starting dir so an
    // ACCEPTED candidate ends the walk immediately -- but a REJECTED one does
    // not: the walk then climbs every ancestor of tmpdir, stat()ing a
    // `.yaw-mcp` at each (on Windows, where tmpdir lives under the real
    // profile, that includes the developer's own ~/.yaw-mcp, which the
    // ownership gate rejects in turn and warn-logs once per process). Nothing
    // up there can be RETURNED under these stubs, but the walk is not confined
    // to the temp tree, so a `.yaw-mcp/` planted above tmpdir on the test
    // machine is the one thing that could perturb these assertions.
    outside = mkdtempSync(join(tmpdir(), "yaw-mcp-guide-trust-outside-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    if (ORIG_GETEUID) Object.defineProperty(process, "geteuid", ORIG_GETEUID);
    else delete (process as { geteuid?: unknown }).geteuid;
    vi.unstubAllEnvs();
  });

  function writeGuide(dir: string, content: string): string {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, GUIDE_FILENAME);
    writeFileSync(p, content, "utf8");
    return p;
  }

  it("loads the guide when the outside-$HOME dir passes the ownership gate", async () => {
    // geteuid pinned to the uid stat actually reports for the candidate:
    // on POSIX that is this process's own uid; on win32 (no native
    // geteuid, stat reports uid 0) the stub makes the same ownership
    // gate pass deterministically.
    const cfgDir = join(outside, CONFIG_DIRNAME);
    writeGuide(cfgDir, "outside-home notes");
    Object.defineProperty(process, "geteuid", {
      value: () => statSync(cfgDir).uid,
      configurable: true,
      writable: true,
    });
    const g = await loadProjectGuide(outside, home, {});
    expect(g?.scope).toBe("project");
    expect(g?.content).toBe("outside-home notes");
    // The approval gate still applies out there: no approved bundles.json
    // beside the guide means it loads flagged, not silently trusted.
    expect(g?.unapproved).toBe(true);
  });

  it("serves no guide when ownership is unverifiable (win32 model) without the opt-in", async () => {
    // A `.yaw-mcp/` planted in a shared writable location (UNC share,
    // Public-style dir, non-system volume root) must not inject its
    // YAW-MCP.md into the model context by default.
    writeGuide(join(outside, CONFIG_DIRNAME), "planted notes");
    Object.defineProperty(process, "geteuid", { value: undefined, configurable: true, writable: true });
    vi.stubEnv(ALLOW_UNOWNED_ENV, "");
    expect(await loadProjectGuide(outside, home, {})).toBeNull();
    // POSITIVE CONTROL. A bare toBeNull cannot tell "the gate rejected this
    // candidate" from "the walk never found it" or "the read failed" -- every
    // one of those returns null. Flipping ONLY the opt-in and re-running
    // against the SAME directory serves the guide, which pins the null above
    // on the ownership gate specifically.
    // The opt-in travels in the INJECTED env, which is what doctor and the
    // guide loader actually thread through; process.env stays empty here to
    // prove the walk reads the injected one and not the real environment.
    expect((await loadProjectGuide(outside, home, { [ALLOW_UNOWNED_ENV]: "1" }))?.content).toBe("planted notes");
  });

  it("serves the guide when ownership is unverifiable but the env opt-in is set", async () => {
    writeGuide(join(outside, CONFIG_DIRNAME), "trusted second-drive notes");
    Object.defineProperty(process, "geteuid", { value: undefined, configurable: true, writable: true });
    // process.env deliberately does NOT carry the opt-in: only the injected
    // env does, so a regression back to reading process.env fails here.
    vi.stubEnv(ALLOW_UNOWNED_ENV, "");
    const g = await loadProjectGuide(outside, home, { [ALLOW_UNOWNED_ENV]: "1" });
    expect(g?.scope).toBe("project");
    expect(g?.content).toBe("trusted second-drive notes");
  });
});
