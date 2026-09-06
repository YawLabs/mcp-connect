import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sidecarsRoot } from "../paths.js";
import {
  backgroundInstallOptions,
  buildRefreshPlan,
  loadSidecarSpecs,
  maybeRefreshSidecars,
  mergeSidecarRefreshState,
  parseSidecarRefreshState,
  SIDECAR_REFRESH_START_DELAY_MS,
  SIDECAR_REFRESH_THROTTLE_MS,
  type SidecarRefreshDeps,
  type SidecarRefreshState,
  type SidecarRefreshStatePatch,
  sidecarRefreshStatePath,
} from "../sidecar-refresh.js";
import { configuredRange, type SidecarSpec, sidecarsManifest } from "../sidecars-cmd.js";

// =====================================================================
// sidecar-refresh -- the startup check that keeps ~/.yaw-mcp/sidecars
// moving forward.
//
// Two halves, tested differently:
//   * buildRefreshPlan is PURE, so its tests are a truth table. This is
//     where the never-downgrade and never-touch-a-pin rules live, and
//     where a regression would be silent in production (a refresh that
//     quietly stops happening looks exactly like "no new releases").
//   * maybeRefreshSidecars is tested with every dep injected -- no
//     network, no filesystem, no npm. The assertions are about WHEN it
//     acts and WHEN it must not, plus the lock's release-on-every-path
//     guarantee.
//
// Each non-obvious test names the mutation that reddens it, so a future
// reader can tell at a glance whether the test can actually fail.
// =====================================================================

/** A SidecarSpec as collectSidecarSpecs would build it. `range` of "" means
 *  the config named the bare package with no `@version` -- the unpinned case
 *  sidecarsManifest writes into the manifest as "latest". */
function spec(pkg: string, range = "latest"): SidecarSpec {
  return { pkg, spec: range === "" ? pkg : `${pkg}@${range}`, namespaces: [pkg.replace(/\W/g, "")], conflicting: [] };
}

/** Every configured package appears in exactly one of the plan's two lists,
 *  exactly once -- the partition the plan documents. Asserted alongside the
 *  specific expectations so a rule that starts silently DROPPING a package
 *  (rather than misclassifying it) still fails a test. */
function expectPartitions(plan: ReturnType<typeof buildRefreshPlan>, specs: SidecarSpec[]): void {
  const seen = [...plan.stale.map((s) => s.pkg), ...plan.skipped.map((s) => s.pkg)].sort();
  expect(seen).toEqual(specs.map((s) => s.pkg).sort());
}

describe("configuredRange", () => {
  it("reads latest, an explicit pin, a range and a bare name", () => {
    expect(configuredRange(spec("@yawlabs/fetch-mcp", "latest"))).toBe("latest");
    expect(configuredRange(spec("@yawlabs/fetch-mcp", "0.13.3"))).toBe("0.13.3");
    expect(configuredRange(spec("@yawlabs/fetch-mcp", "^1.2.0"))).toBe("^1.2.0");
    // A bare name is what npx would have resolved as @latest, and it is what
    // sidecarsManifest writes as "latest" -- so it must read as floating here
    // too. Reddens if the `raw === ""` fallback is dropped (the range would
    // come back "" and the package would be treated as pinned).
    expect(configuredRange(spec("@yawlabs/fetch-mcp", ""))).toBe("latest");
  });

  it("refuses to guess when the name is not a prefix of the spec", () => {
    // Defensive: slicing by a length that does not correspond to a prefix
    // would yield a nonsense range that could accidentally equal "latest".
    // Returning the whole spec guarantees it does not. Reddens if the
    // startsWith guard is removed (slice(9) of "other@latest" is "test").
    const weird: SidecarSpec = { pkg: "not-the-p", spec: "other@latest", namespaces: [], conflicting: [] };
    expect(configuredRange(weird)).toBe("other@latest");
  });
});

describe("buildRefreshPlan", () => {
  it("treats an installed version equal to latest as up to date", () => {
    const specs = [spec("a-mcp")];
    const plan = buildRefreshPlan({
      specs,
      installed: new Map([["a-mcp", "1.2.3"]]),
      latest: new Map([["a-mcp", "1.2.3"]]),
    });
    expect(plan.stale).toEqual([]);
    expect(plan.skipped).toEqual([{ pkg: "a-mcp", reason: "up to date (1.2.3)" }]);
    expectPartitions(plan, specs);
    // Reddens if `cmp < 0` becomes `cmp <= 0`.
  });

  it("marks an installed version behind latest as stale", () => {
    const specs = [spec("a-mcp")];
    const plan = buildRefreshPlan({
      specs,
      installed: new Map([["a-mcp", "1.2.3"]]),
      latest: new Map([["a-mcp", "1.3.0"]]),
    });
    expect(plan.stale).toEqual([{ pkg: "a-mcp", installed: "1.2.3", latest: "1.3.0" }]);
    expect(plan.skipped).toEqual([]);
    expectPartitions(plan, specs);
  });

  it("never downgrades: installed NEWER than latest is not stale", () => {
    // A local dev build linked into the tree, or a release yanked after it was
    // installed. Refreshing would move the user BACKWARDS.
    const specs = [spec("a-mcp")];
    const plan = buildRefreshPlan({
      specs,
      installed: new Map([["a-mcp", "2.0.0"]]),
      latest: new Map([["a-mcp", "1.9.9"]]),
    });
    expect(plan.stale).toEqual([]);
    expect(plan.skipped[0].reason).toContain("newer than the registry");
    expectPartitions(plan, specs);
    // Reddens if the staleness test becomes `cmp !== 0` (or `installed !==
    // latest`), which is the shape that turns "ahead" into "refresh me".
  });

  it("compares as semver, not as strings: 0.9.0 installed vs 0.10.0 latest IS stale", () => {
    // THE classic bug. Lexicographically "0.9.0" > "0.10.0", so a string
    // compare reports this pair as already-current and the user sits on 0.9.0
    // forever while every release ships past them.
    const specs = [spec("a-mcp")];
    const plan = buildRefreshPlan({
      specs,
      installed: new Map([["a-mcp", "0.9.0"]]),
      latest: new Map([["a-mcp", "0.10.0"]]),
    });
    expect(plan.stale).toEqual([{ pkg: "a-mcp", installed: "0.9.0", latest: "0.10.0" }]);
    // Reddens if compareVersions is replaced with `installed < latest`.
  });

  it("treats a prerelease as behind its release (compareVersions, not a triple compare)", () => {
    // Pinned because it is the divergence that justified oam-spawn owning the
    // comparator: a release-triple-only compare reads 1.2.3-rc.1 as EQUAL to
    // 1.2.3, so an rc install would never be moved onto the real release.
    const plan = buildRefreshPlan({
      specs: [spec("a-mcp")],
      installed: new Map([["a-mcp", "1.2.3-rc.1"]]),
      latest: new Map([["a-mcp", "1.2.3"]]),
    });
    expect(plan.stale).toEqual([{ pkg: "a-mcp", installed: "1.2.3-rc.1", latest: "1.2.3" }]);
  });

  it("passes over a package whose latest could not be fetched (offline / 404)", () => {
    const specs = [spec("a-mcp"), spec("b-mcp")];
    const plan = buildRefreshPlan({
      specs,
      installed: new Map([
        ["a-mcp", "1.0.0"],
        ["b-mcp", "1.0.0"],
      ]),
      // An explicit null and an ABSENT key are the same answer -- "we do not
      // know" -- and both must land in skipped rather than throwing or being
      // silently dropped.
      latest: new Map([["a-mcp", null]]),
    });
    expect(plan.stale).toEqual([]);
    expect(plan.skipped).toEqual([
      { pkg: "a-mcp", reason: "registry did not answer" },
      { pkg: "b-mcp", reason: "registry did not answer" },
    ]);
    expectPartitions(plan, specs);
    // Reddens if an unknown `latest` is coerced to "refresh anyway" -- the
    // shape that fires an npm install on no evidence every time the network
    // hiccups at startup.
  });

  it("passes over a configured package that is not installed at all", () => {
    // Pinned behavior, and it is a DECISION, not an oversight: a missing
    // package is not stale, it was never acquired. Acquiring it is the
    // network-and-minutes cost `sidecars install` is deliberately opt-in
    // about, so it must not be what a background check silently starts.
    const specs = [spec("a-mcp")];
    const plan = buildRefreshPlan({
      specs,
      installed: new Map([["a-mcp", null]]),
      latest: new Map([["a-mcp", "1.0.0"]]),
    });
    expect(plan.stale).toEqual([]);
    expect(plan.skipped).toEqual([{ pkg: "a-mcp", reason: "not installed in the managed tree" }]);
    expectPartitions(plan, specs);
  });

  it("NEVER moves an explicitly pinned spec, even when it is behind latest", () => {
    // The rule that protects the feature's purpose: sidecars exist to pin
    // versions, and `pkg@0.13.3` is the user's stated intent.
    const specs = [spec("a-mcp", "0.13.3")];
    const plan = buildRefreshPlan({
      specs,
      installed: new Map([["a-mcp", "0.13.3"]]),
      latest: new Map([["a-mcp", "9.9.9"]]),
    });
    expect(plan.stale).toEqual([]);
    expect(plan.skipped[0].pkg).toBe("a-mcp");
    expect(plan.skipped[0].reason).toContain('configured "0.13.3"');
    expectPartitions(plan, specs);
    // Reddens if the ineligibility gate is removed from buildRefreshPlan --
    // the version compare alone would call this pair stale.
  });

  it("leaves a semver range and a non-latest dist-tag alone too", () => {
    // Both would otherwise be measured against the WRONG track: `npm update`
    // honours the manifest range, so neither can ever reach the `latest` this
    // plan compares against -- they would read as stale forever and fire a
    // daily npm spawn that changes nothing.
    const specs = [spec("a-mcp", "^1.2.0"), spec("b-mcp", "next")];
    const plan = buildRefreshPlan({
      specs,
      installed: new Map([
        ["a-mcp", "1.2.0"],
        ["b-mcp", "1.0.0"],
      ]),
      latest: new Map([
        ["a-mcp", "2.0.0"],
        ["b-mcp", "1.5.0"],
      ]),
    });
    expect(plan.stale).toEqual([]);
    expect(plan.skipped.map((s) => s.pkg)).toEqual(["a-mcp", "b-mcp"]);
    expectPartitions(plan, specs);
  });

  it("treats an unpinned bare-name spec as floating and refreshes it", () => {
    const plan = buildRefreshPlan({
      specs: [spec("a-mcp", "")],
      installed: new Map([["a-mcp", "1.0.0"]]),
      latest: new Map([["a-mcp", "1.1.0"]]),
    });
    expect(plan.stale).toEqual([{ pkg: "a-mcp", installed: "1.0.0", latest: "1.1.0" }]);
    // Reddens if eligibility becomes a literal `spec.spec.endsWith("@latest")`
    // check, which would drop the bare-name case the manifest calls "latest".
  });

  it("picks only the eligible members out of a mixed set", () => {
    const specs = [
      spec("stale-mcp"), // behind -> the only one that should be refreshed
      spec("current-mcp"), // level
      spec("ahead-mcp"), // ahead of the registry
      spec("pinned-mcp", "1.0.0"), // explicitly pinned, and behind
      spec("missing-mcp"), // configured, never installed
      spec("offline-mcp"), // registry did not answer
    ];
    const plan = buildRefreshPlan({
      specs,
      installed: new Map([
        ["stale-mcp", "1.0.0"],
        ["current-mcp", "1.0.0"],
        ["ahead-mcp", "2.0.0"],
        ["pinned-mcp", "1.0.0"],
        ["missing-mcp", null],
        ["offline-mcp", "1.0.0"],
      ]),
      latest: new Map([
        ["stale-mcp", "1.1.0"],
        ["current-mcp", "1.0.0"],
        ["ahead-mcp", "1.0.0"],
        ["pinned-mcp", "5.0.0"],
        ["missing-mcp", "1.0.0"],
        ["offline-mcp", null],
      ]),
    });
    expect(plan.stale.map((s) => s.pkg)).toEqual(["stale-mcp"]);
    expect(plan.skipped).toHaveLength(5);
    expectPartitions(plan, specs);
  });

  it("returns an empty plan for an empty config", () => {
    expect(buildRefreshPlan({ specs: [], installed: new Map(), latest: new Map() })).toEqual({
      stale: [],
      skipped: [],
    });
  });
});

// ---------------------------------------------------------------------
// maybeRefreshSidecars -- every dep injected, so these tests touch no
// network, no npm, and no real home directory.
// ---------------------------------------------------------------------

const HOME = join("/", "test-home");
const NOW = 1_700_000_000_000;

/** Deps that pass every gate and find exactly one stale package, plus a handle
 *  on each one so a test can assert what was and was not called.
 *
 *  Each override is WRAPPED in vi.fn rather than replacing the dep after the
 *  fact, so the handle returned here is always the implementation that actually
 *  ran. The obvious alternative -- keep the default mocks as handles and spread
 *  `over` into `deps` -- silently hands back an unused default for any impl a
 *  test overrode, which makes `expect(h.x).not.toHaveBeenCalled()` pass for the
 *  wrong reason. A test that cannot fail is worse than no test. */
function harness(over: Partial<SidecarRefreshDeps> = {}) {
  const release = vi.fn();
  const fetchLatestImpl = vi.fn(over.fetchLatestImpl ?? (async (_pkg: string): Promise<string | null> => "1.1.0"));
  // The default background impl reports success by calling onDone, exactly as
  // defaultSpawnRefresh's `finally` does.
  const spawnRefreshImpl = vi.fn(
    over.spawnRefreshImpl ?? ((_stale: SidecarSpec[], onDone: () => void): void => onDone()),
  );
  const acquireLockImpl = vi.fn(over.acquireLockImpl ?? ((_dir: string): (() => void) | null => release));
  const installedVersionImpl = vi.fn(
    over.installedVersionImpl ?? ((_pkg: string, _home?: string): string | null => "1.0.0"),
  );
  const hasManagedSidecarsImpl = vi.fn(over.hasManagedSidecarsImpl ?? ((_home?: string): boolean => true));
  const specsImpl = vi.fn(over.specsImpl ?? (async (): Promise<SidecarSpec[]> => [spec("a-mcp")]));
  const nowImpl = vi.fn(over.nowImpl ?? ((): number => NOW));
  // Resolves at once by default: the delay's PLACEMENT is what the tests
  // below pin, and a real minute would make every other assertion here wait.
  const delayImpl = vi.fn(over.delayImpl ?? (async (_ms: number): Promise<void> => {}));
  // Both typed from the module's own exported shapes rather than a hand-copied
  // literal: the state is read-modify-written precisely so a key a newer build
  // adds survives, and a local `{ lastSidecarRefreshCheck?: number }` here
  // would drift from it with no type error to say so.
  const readStateImpl = vi.fn(over.readStateImpl ?? ((): SidecarRefreshState | null => null));
  const writeStateImpl = vi.fn(over.writeStateImpl ?? ((_patch: SidecarRefreshStatePatch): void => {}));
  const deps: SidecarRefreshDeps = {
    fetchLatestImpl,
    spawnRefreshImpl,
    acquireLockImpl,
    installedVersionImpl,
    hasManagedSidecarsImpl,
    specsImpl,
    nowImpl,
    delayImpl,
    readStateImpl,
    writeStateImpl,
    home: over.home ?? HOME,
  };
  return {
    deps,
    release,
    fetchLatestImpl,
    spawnRefreshImpl,
    acquireLockImpl,
    installedVersionImpl,
    hasManagedSidecarsImpl,
    specsImpl,
    nowImpl,
    delayImpl,
    readStateImpl,
    writeStateImpl,
  };
}

/** A throwaway home directory, deleted after the test that asked for it.
 *
 *  The two tests that exercise the DEFAULT impls need a real path on disk, and
 *  mkdtempSync makes a real directory: called bare, each run left another pair
 *  of them in the OS temp dir permanently. Registering them here keeps the
 *  cleanup impossible to forget. */
const tempHomes: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "yaw-sidecar-refresh-"));
  tempHomes.push(dir);
  return dir;
}

describe("maybeRefreshSidecars", () => {
  let prevOptOut: string | undefined;

  beforeEach(() => {
    prevOptOut = process.env.YAW_MCP_SIDECAR_REFRESH;
    delete process.env.YAW_MCP_SIDECAR_REFRESH;
  });

  afterEach(() => {
    if (prevOptOut === undefined) delete process.env.YAW_MCP_SIDECAR_REFRESH;
    else process.env.YAW_MCP_SIDECAR_REFRESH = prevOptOut;
    // `force` because the point of those tests is that NOTHING was written
    // into the directory, so it is usually still empty.
    for (const dir of tempHomes.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when YAW_MCP_SIDECAR_REFRESH=0", async () => {
    process.env.YAW_MCP_SIDECAR_REFRESH = "0";
    const h = harness();
    await maybeRefreshSidecars(h.deps);
    // The opt-out is checked before EVERY other gate, so even the local reads
    // must not have happened.
    expect(h.hasManagedSidecarsImpl).not.toHaveBeenCalled();
    expect(h.fetchLatestImpl).not.toHaveBeenCalled();
    expect(h.spawnRefreshImpl).not.toHaveBeenCalled();
    expect(h.writeStateImpl).not.toHaveBeenCalled();
  });

  it("does nothing when YAW_MCP_SIDECAR_REFRESH=false, case-insensitively", async () => {
    process.env.YAW_MCP_SIDECAR_REFRESH = "FALSE";
    const h = harness();
    await maybeRefreshSidecars(h.deps);
    expect(h.fetchLatestImpl).not.toHaveBeenCalled();
    expect(h.spawnRefreshImpl).not.toHaveBeenCalled();
    // Reddens if the opt-out drops `.toLowerCase()` -- auto-upgrade's parse
    // accepts "FALSE" and the two features must not disagree about it.
  });

  it("still runs for an unrelated value of the opt-out var", async () => {
    // Only "0" and "false" disable it; a stray "1"/"yes"/"" must not.
    process.env.YAW_MCP_SIDECAR_REFRESH = "1";
    const h = harness();
    await maybeRefreshSidecars(h.deps);
    expect(h.spawnRefreshImpl).toHaveBeenCalledTimes(1);
  });

  it("returns before the registry when there is no managed tree", async () => {
    const h = harness({ hasManagedSidecarsImpl: vi.fn(() => false) });
    await maybeRefreshSidecars(h.deps);
    expect(h.fetchLatestImpl).not.toHaveBeenCalled();
    expect(h.spawnRefreshImpl).not.toHaveBeenCalled();
    // No timestamp either: nothing was checked, so nothing should be
    // suppressed for a day. Reddens if the gate is moved after recordCheck.
    expect(h.writeStateImpl).not.toHaveBeenCalled();
  });

  it("re-reads the throttle after the start delay, so a pane that woke second does not probe", async () => {
    // Two panes start inside the same minute: both pass the pre-delay gate
    // (no stamp yet), both sleep. The first to wake stamps; the second used to
    // load the config and probe the registry anyway, because the gate was
    // decided once, before the sleep. The second read is what stops it.
    const reads = vi.fn<() => SidecarRefreshState | null>();
    reads.mockReturnValueOnce(null).mockReturnValueOnce({ lastSidecarRefreshCheck: NOW - 2_000 });
    const h = harness({ readStateImpl: reads });
    await maybeRefreshSidecars(h.deps);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(h.delayImpl).toHaveBeenCalledTimes(1);
    expect(h.specsImpl).not.toHaveBeenCalled();
    expect(h.fetchLatestImpl).not.toHaveBeenCalled();
    expect(h.writeStateImpl).not.toHaveBeenCalled();
  });

  it("is throttled by a check made an hour ago", async () => {
    const h = harness({
      readStateImpl: vi.fn(() => ({ lastSidecarRefreshCheck: NOW - 60 * 60 * 1000 })),
    });
    await maybeRefreshSidecars(h.deps);
    expect(h.specsImpl).not.toHaveBeenCalled();
    expect(h.fetchLatestImpl).not.toHaveBeenCalled();
    expect(h.spawnRefreshImpl).not.toHaveBeenCalled();
    // And the stamp is left ALONE. A throttled start performed no check, so it
    // has nothing to record -- reddens if a refactor moves recordCheck into a
    // `finally` or up above the throttle gate, which would make the window
    // self-renewing: every start inside 24h would push the deadline out, and a
    // user who opens a pane more than once a day would never refresh again.
    expect(h.writeStateImpl).not.toHaveBeenCalled();
  });

  it("proceeds when the last check was 25 hours ago", async () => {
    const h = harness({
      readStateImpl: vi.fn(() => ({ lastSidecarRefreshCheck: NOW - 25 * 60 * 60 * 1000 })),
    });
    await maybeRefreshSidecars(h.deps);
    expect(h.fetchLatestImpl).toHaveBeenCalledWith("a-mcp");
    expect(h.spawnRefreshImpl).toHaveBeenCalledTimes(1);
  });

  it("proceeds on a timestamp exactly one throttle window old, and not a millisecond younger", async () => {
    // Boundary pinned in both directions so an off-by-one in either sign shows
    // up as a failure rather than as a feature that fires twice a day.
    const atWindow = harness({
      readStateImpl: vi.fn(() => ({ lastSidecarRefreshCheck: NOW - SIDECAR_REFRESH_THROTTLE_MS })),
    });
    await maybeRefreshSidecars(atWindow.deps);
    expect(atWindow.spawnRefreshImpl).toHaveBeenCalledTimes(1);

    const justInside = harness({
      readStateImpl: vi.fn(() => ({ lastSidecarRefreshCheck: NOW - SIDECAR_REFRESH_THROTTLE_MS + 1 })),
    });
    await maybeRefreshSidecars(justInside.deps);
    expect(justInside.spawnRefreshImpl).not.toHaveBeenCalled();
    // Same self-renewing-window mutation as in the hour-ago test: a suppressed
    // start must not re-stamp, or the deadline would move on every pane start
    // and the boundary this test pins would never be reached.
    expect(justInside.writeStateImpl).not.toHaveBeenCalled();
  });

  it("proceeds on a FUTURE timestamp instead of sitting out the window", async () => {
    // A backwards-stepped clock (or a home copied from a machine ahead of this
    // one) leaves a timestamp in the future. Honouring it would compute a
    // negative age that never reaches the window, suppressing the feature until
    // wall-clock caught up; proceeding rewrites the stamp and self-heals in one
    // run. Reddens if the `age >= 0` guard is dropped.
    const h = harness({
      readStateImpl: vi.fn(() => ({ lastSidecarRefreshCheck: NOW + 7 * 24 * 60 * 60 * 1000 })),
    });
    await maybeRefreshSidecars(h.deps);
    expect(h.spawnRefreshImpl).toHaveBeenCalledTimes(1);
    expect(h.writeStateImpl).toHaveBeenCalledWith({ lastSidecarRefreshCheck: NOW });
  });

  it("waits out the start delay before it reads the config or the registry", async () => {
    // server.ts fires this the instant the transport connects, which is when
    // the client's first tools/list spawns servers from the very tree a
    // refresh rewrites. The delay is what moves the rewrite off that burst,
    // so it has to sit ahead of everything that reads the config or the
    // registry. Reddens if the await is dropped or moved below the config
    // read.
    let go: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      go = resolve;
    });
    const h = harness({ delayImpl: vi.fn(() => gate) });

    const run = maybeRefreshSidecars(h.deps);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.delayImpl).toHaveBeenCalledWith(SIDECAR_REFRESH_START_DELAY_MS);
    expect(h.specsImpl).not.toHaveBeenCalled();
    expect(h.fetchLatestImpl).not.toHaveBeenCalled();
    // And nothing is recorded while the delay is pending: a `serve` that
    // exits inside it has checked nothing, so it must check again on its next
    // start rather than sit out a day on a check that never happened.
    expect(h.writeStateImpl).not.toHaveBeenCalled();

    go();
    await run;
    expect(h.fetchLatestImpl).toHaveBeenCalledWith("a-mcp");
    expect(h.spawnRefreshImpl).toHaveBeenCalledTimes(1);
    expect(h.writeStateImpl).toHaveBeenCalledWith({ lastSidecarRefreshCheck: NOW });
  });

  it("holds no delay at all on a start the cheap gates stop", async () => {
    // The common no-op start -- no managed tree, a check within the last day,
    // the opt-out -- must not park a timer: the delay sits AFTER those gates
    // so it costs nothing on the machines (most of them) that never refresh.
    const noTree = harness({ hasManagedSidecarsImpl: vi.fn(() => false) });
    await maybeRefreshSidecars(noTree.deps);
    expect(noTree.delayImpl).not.toHaveBeenCalled();

    const throttled = harness({
      readStateImpl: vi.fn(() => ({ lastSidecarRefreshCheck: NOW - 60 * 60 * 1000 })),
    });
    await maybeRefreshSidecars(throttled.deps);
    expect(throttled.delayImpl).not.toHaveBeenCalled();

    process.env.YAW_MCP_SIDECAR_REFRESH = "0";
    const off = harness();
    await maybeRefreshSidecars(off.deps);
    expect(off.delayImpl).not.toHaveBeenCalled();
  });

  it("does not resolve until an async state write has landed", async () => {
    // The default write is atomic and therefore async. "Resolves once the
    // check completes" has to include it, or a caller that awaits this and
    // then reads the stamp back races the write. Reddens if recordCheck goes
    // back to a fire-and-forget call of the writer.
    let landed = false;
    const h = harness({
      writeStateImpl: vi.fn(async (_patch: SidecarRefreshStatePatch): Promise<void> => {
        await new Promise((r) => setTimeout(r, 5));
        landed = true;
      }),
    });
    await maybeRefreshSidecars(h.deps);
    expect(landed).toBe(true);
  });

  it("does NOT spawn and does NOT record the timestamp when the lock is held", async () => {
    // The loser must retry on the NEXT startup rather than sitting out a day on
    // a refresh it never performed -- the winner may die before finishing.
    const h = harness({ acquireLockImpl: vi.fn(() => null) });
    await maybeRefreshSidecars(h.deps);
    expect(h.spawnRefreshImpl).not.toHaveBeenCalled();
    expect(h.writeStateImpl).not.toHaveBeenCalled();
    // Reddens if recordCheck moves above the lock acquisition.
  });

  it("locks the sidecars root, not some other directory", async () => {
    const h = harness();
    await maybeRefreshSidecars(h.deps);
    expect(h.acquireLockImpl).toHaveBeenCalledWith(sidecarsRoot(HOME));
    // Reddens if the lock dir becomes tmpdir() or the home root -- either would
    // make unrelated trees contend, or make two homes share one lock.
  });

  it("releases the lock when the background refresh succeeds", async () => {
    const h = harness();
    await maybeRefreshSidecars(h.deps);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("releases the lock when the background refresh fails asynchronously", async () => {
    // Shaped like defaultSpawnRefresh, because the point is its `finally`: an
    // async body that REJECTS after maybeRefreshSidecars has already returned,
    // with the failure swallowed by the same catch the real one has. An impl
    // that merely defers onDone models no failure at all -- it would pass
    // against a spawn wrapper with no error handling whatsoever, which is
    // exactly the regression this test is supposed to catch.
    const failed = vi.fn();
    const h = harness({
      spawnRefreshImpl: (_stale: SidecarSpec[], onDone: () => void) => {
        void (async () => {
          try {
            await new Promise((_resolve, reject) => setTimeout(() => reject(new Error("npm exited 1")), 0));
          } catch {
            failed();
          } finally {
            onDone();
          }
        })();
      },
    });
    await maybeRefreshSidecars(h.deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(failed).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    // The check itself completed, so the stamp lands regardless of how the
    // install turned out -- a failing npm must not put every later startup
    // into a retry against an npm that is already unhappy.
    expect(h.writeStateImpl).toHaveBeenCalledWith({ lastSidecarRefreshCheck: NOW });
  });

  it("releases the lock when the spawn throws SYNCHRONOUSLY", async () => {
    // Without the try/catch around the spawn, the lock would stay held for the
    // full stale window and suppress the next several startups' refresh over a
    // failure that already happened.
    const h = harness({
      spawnRefreshImpl: vi.fn(() => {
        throw new Error("spawn exploded");
      }),
    });
    await expect(maybeRefreshSidecars(h.deps)).resolves.toBeUndefined();
    expect(h.release).toHaveBeenCalledTimes(1);
    // The check still completed, so the timestamp is recorded -- a failing
    // spawn must not put the process into a per-startup retry loop.
    expect(h.writeStateImpl).toHaveBeenCalledWith({ lastSidecarRefreshCheck: NOW });
  });

  it("releases the lock exactly once when the impl both calls onDone and throws", async () => {
    // A double release would unlink a lock a DIFFERENT process had since taken
    // -- precisely the failure the lock exists to prevent. Reddens if the
    // releaseOnce guard is replaced by the raw release callback.
    const h = harness({
      spawnRefreshImpl: (_stale: SidecarSpec[], onDone: () => void) => {
        onDone();
        throw new Error("and then it exploded");
      },
    });
    await maybeRefreshSidecars(h.deps);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("resolves (never rejects) and does not spawn when every registry probe rejects", async () => {
    const h = harness({
      fetchLatestImpl: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    await expect(maybeRefreshSidecars(h.deps)).resolves.toBeUndefined();
    expect(h.spawnRefreshImpl).not.toHaveBeenCalled();
    expect(h.acquireLockImpl).not.toHaveBeenCalled();
    // Reddens if the per-probe catch is removed: Promise.all would reject, the
    // outer catch would swallow it, and the timestamp below would never land.
    expect(h.writeStateImpl).toHaveBeenCalledWith({ lastSidecarRefreshCheck: NOW });
  });

  it("refreshes the packages that did resolve when only SOME probes fail", async () => {
    // The documented decision: a failed lookup does not veto the batch. The
    // action is whole-tree, so "only the ones that resolved" is not expressible
    // anyway -- and letting one 404 disable the refresh for every other package
    // would do so once a day, forever.
    const h = harness({
      specsImpl: vi.fn(async () => [spec("good-mcp"), spec("gone-mcp")]),
      fetchLatestImpl: vi.fn(async (pkg: string) => {
        if (pkg === "gone-mcp") throw new Error("404");
        return "1.1.0";
      }),
    });
    await maybeRefreshSidecars(h.deps);
    expect(h.spawnRefreshImpl).toHaveBeenCalledTimes(1);
    expect(h.spawnRefreshImpl.mock.calls[0][0].map((s) => s.pkg)).toEqual(["good-mcp"]);
  });

  it("records the timestamp and does not spawn when nothing is stale", async () => {
    const h = harness({ fetchLatestImpl: vi.fn(async () => "1.0.0") });
    await maybeRefreshSidecars(h.deps);
    expect(h.spawnRefreshImpl).not.toHaveBeenCalled();
    expect(h.acquireLockImpl).not.toHaveBeenCalled();
    expect(h.writeStateImpl).toHaveBeenCalledWith({ lastSidecarRefreshCheck: NOW });
    // Reddens if recordCheck is dropped from the nothing-stale path: an
    // offline machine would then probe the registry on every client start.
  });

  it("records the timestamp when nothing is configured, without probing", async () => {
    const h = harness({ specsImpl: vi.fn(async () => []) });
    await maybeRefreshSidecars(h.deps);
    expect(h.fetchLatestImpl).not.toHaveBeenCalled();
    expect(h.writeStateImpl).toHaveBeenCalledWith({ lastSidecarRefreshCheck: NOW });
  });

  it("never probes the registry for a pinned or uninstalled package", async () => {
    // The probe set is narrowed by the SAME eligibility rule the plan uses, so
    // a package that could not be moved costs no network at all. Reddens if the
    // narrowing filter is dropped -- the plan would still be right, but every
    // startup would spend N round trips learning nothing.
    const h = harness({
      specsImpl: vi.fn(async () => [spec("float-mcp"), spec("pinned-mcp", "1.0.0"), spec("absent-mcp")]),
      installedVersionImpl: vi.fn((pkg: string) => (pkg === "absent-mcp" ? null : "1.0.0")),
    });
    await maybeRefreshSidecars(h.deps);
    expect(h.fetchLatestImpl.mock.calls.map((c) => c[0])).toEqual(["float-mcp"]);
  });

  it("hands the background refresh the full SidecarSpec of each stale package", async () => {
    // The spawn takes SidecarSpec objects, not the plan's {pkg, installed,
    // latest} rows -- the agreed shape, and the one that lets an impl see the
    // configured spec and namespaces.
    const stale = spec("a-mcp");
    const h = harness({
      specsImpl: vi.fn(async () => [stale, spec("current-mcp")]),
      fetchLatestImpl: vi.fn(async (pkg: string) => (pkg === "a-mcp" ? "1.1.0" : "1.0.0")),
    });
    await maybeRefreshSidecars(h.deps);
    expect(h.spawnRefreshImpl.mock.calls[0][0]).toEqual([stale]);
  });

  it("threads `home` into the installed-version read", async () => {
    const h = harness();
    await maybeRefreshSidecars(h.deps);
    expect(h.installedVersionImpl).toHaveBeenCalledWith("a-mcp", HOME);
    // Reddens if the home is dropped -- the check would read the REAL home's
    // tree while the refresh writes the injected one.
  });

  it("stamps the injected clock, not Date.now()", async () => {
    const h = harness();
    await maybeRefreshSidecars(h.deps);
    expect(h.writeStateImpl).toHaveBeenCalledWith({ lastSidecarRefreshCheck: NOW });
  });

  it("resolves instead of rejecting when an injected dep throws", async () => {
    // The contract is "never throws" -- it runs on the serve startup path where
    // an unhandled rejection is a logged error in the user's client.
    const h = harness({
      specsImpl: vi.fn(async () => {
        throw new Error("bundles.json is on fire");
      }),
    });
    await expect(maybeRefreshSidecars(h.deps)).resolves.toBeUndefined();
    expect(h.spawnRefreshImpl).not.toHaveBeenCalled();
  });

  it("does nothing observable under vitest when no deps are injected", async () => {
    // Pins the VITEST short-circuit on every default impl. Without it, a test
    // that forgot an injection would hit the real registry, write into the
    // user's real ~/.yaw-mcp, and could start a real `npm install`.
    const home = tempHome();
    await expect(maybeRefreshSidecars({ home, hasManagedSidecarsImpl: () => true })).resolves.toBeUndefined();
    expect(existsSync(sidecarRefreshStatePath(home))).toBe(false);
  });

  it("reads NOTHING outside the injected home -- no real bundles.json, no real sidecars tree", async () => {
    // The assertion above is satisfied by defaultWriteState's guard ALONE, so
    // it stayed green while defaultSpecs, hasManagedSidecars and
    // installedVersion were unguarded -- and defaultSpecs calls the real
    // loadLocalBundles, which walks the real cwd and home. The tell was a log
    // line naming a real path ("Skipping an untrusted .yaw-mcp/ dir outside
    // $HOME") during this suite. Assert the gate directly instead of through a
    // side effect a different guard already prevents.
    const home = tempHome();
    const specsImpl = vi.fn();
    const installedVersionImpl = vi.fn();
    const fetchLatestImpl = vi.fn();
    const spawnRefreshImpl = vi.fn();

    // hasManagedSidecars NOT injected: its own guard must answer false and
    // stop the ladder before anything below it can touch the real machine.
    await expect(maybeRefreshSidecars({ home })).resolves.toBeUndefined();
    expect(specsImpl).not.toHaveBeenCalled();

    // With the tree forced on, the specs default must still refuse to read a
    // real bundles.json -- an empty list, so the ladder stops at "nothing
    // configured" rather than planning against the developer's own servers.
    await expect(
      maybeRefreshSidecars({
        home,
        hasManagedSidecarsImpl: () => true,
        installedVersionImpl,
        fetchLatestImpl,
        spawnRefreshImpl,
      }),
    ).resolves.toBeUndefined();
    // No specs means no version reads, no registry probes, no refresh.
    expect(installedVersionImpl).not.toHaveBeenCalled();
    expect(fetchLatestImpl).not.toHaveBeenCalled();
    expect(spawnRefreshImpl).not.toHaveBeenCalled();
  });

  it("reads an installed version only for specs the plan can actually move", async () => {
    // buildRefreshPlan reaches its ineligible branch BEFORE consulting
    // installed.get, so a pinned spec's version read is work whose result is
    // guaranteed unused -- on the serve startup path, once per package.
    const h = harness({
      specsImpl: vi.fn(async () => [spec("floats"), spec("pinned", "1.2.3"), spec("ranged", "^2.0.0")]),
      installedVersionImpl: vi.fn(() => "1.0.0"),
      fetchLatestImpl: vi.fn(async () => "1.0.0"),
    });

    await maybeRefreshSidecars(h.deps);

    const probed = h.installedVersionImpl.mock.calls.map((c) => c[0]);
    expect(probed).toEqual(["floats"]);
  });
});

// ---------------------------------------------------------------------
// Which config scope the background refresh acts on.
//
// The managed tree is keyed on HOME alone and shared by every project on
// the machine, while `serve` runs with whatever cwd the MCP client was
// launched in. Planning against a project-local bundles.json and then
// rewriting the shared manifest from it would npm-prune every other
// project's servers out of the tree, silently -- so both halves force the
// scope to $HOME, and both halves have to agree.
// ---------------------------------------------------------------------

describe("user-global scope", () => {
  it("loads specs with cwd forced to the home dir, never process.cwd()", async () => {
    // Reddens if the load reverts to `{ home }` (or to opts.cwd), which is what
    // lets a project-local bundles.json decide the shared tree's contents.
    // findProjectConfigDir stops just before $HOME when the walk starts there,
    // so cwd=home is what resolves to "the user-global file only".
    const load = vi.fn(async () => ({ config: null }));
    await expect(loadSidecarSpecs(HOME, load)).resolves.toEqual([]);
    expect(load).toHaveBeenCalledWith({ cwd: HOME, home: HOME });
    expect(HOME).not.toBe(process.cwd());
  });

  it("collects the specs the loaded config carries", async () => {
    // The other half of the same seam: a load failure is a clean no-op, and a
    // successful one is fed through collectSidecarSpecs rather than used raw.
    const load = vi.fn(async () => ({
      config: { servers: [{ type: "local" as const, namespace: "a", command: "npx", args: ["-y", "a-mcp@latest"] }] },
    }));
    await expect(loadSidecarSpecs(HOME, load)).resolves.toEqual([
      { pkg: "a-mcp", spec: "a-mcp@latest", namespaces: ["a"], conflicting: [] },
    ]);

    const boom = vi.fn(async () => {
      throw new Error("bundles.json is on fire");
    });
    await expect(loadSidecarSpecs(HOME, boom)).resolves.toEqual([]);
  });

  it("installs with the same scope the plan was computed from, on silent channels", () => {
    // The plan and the action MUST move together: a plan computed from the
    // user-global config and an install performed from a project's would
    // describe one tree and write another. Reddens if `cwd` is dropped here
    // while loadSidecarSpecs keeps it -- the exact half-fix that reads as
    // correct in a diff.
    const opts = backgroundInstallOptions(HOME);
    expect(opts.home).toBe(HOME);
    expect(opts.cwd).toBe(HOME);
    // And all three output channels are supplied rather than left to default:
    // runSidecarsInstall's own defaults write the command's prose to stdout and
    // stderr, and spawn npm with its output inherited -- from inside serve that
    // is an "Installed:" table in the middle of the MCP client's stream.
    expect(opts.out).toBeTypeOf("function");
    expect(opts.err).toBeTypeOf("function");
    expect(opts.runNpm).toBeTypeOf("function");
    // And a no-op lock, not the command's default: maybeRefreshSidecars already
    // HOLDS the real sidecars lock when this install runs, and the default
    // would take that same file again and read its own holder as "someone
    // else" -- the refresh would refuse the install it took the lock for.
    // Reddens if `acquireLock` is dropped from the options.
    const release = opts.acquireLock?.(sidecarsRoot(HOME));
    expect(release).toBeTypeOf("function");
    expect(() => release?.()).not.toThrow();
  });
});

describe("configuredRange agrees with sidecarsManifest", () => {
  // The two answer the same question for different halves of the feature: this
  // module decides whether a spec is floating, sidecarsManifest writes the
  // range npm then acts on. They are now ONE function -- configuredRange lives
  // in sidecars-cmd (the module sidecar-refresh already imports, so no cycle)
  // and sidecarsManifest calls it -- and this pins that it stays that way. A
  // re-inlined derivation in the manifest reddens here rather than making the
  // refresh skip a package it could move, or schedule one npm refuses to move,
  // once a day, forever, with nothing on screen.
  it.each([
    ["latest"],
    ["0.13.3"],
    ["^1.2.0"],
    ["~2.0.0"],
    ["next"],
    [""],
  ])("derives the same range as the manifest for %j", (range) => {
    const s = spec("@yawlabs/fetch-mcp", range);
    const manifest = JSON.parse(sidecarsManifest([s])) as { dependencies: Record<string, string> };
    expect(configuredRange(s)).toBe(manifest.dependencies["@yawlabs/fetch-mcp"]);
  });
});

// ---------------------------------------------------------------------
// The throttle-state file: parse and merge.
//
// Pure halves, split out of the read/write wrappers precisely so they can
// be tested -- the wrappers themselves are short-circuited under VITEST, so
// every branch below used to be unreachable from a test.
// ---------------------------------------------------------------------

describe("parseSidecarRefreshState", () => {
  it("reads a well-formed document", () => {
    expect(parseSidecarRefreshState('{"lastSidecarRefreshCheck": 1700000000000}')).toEqual({
      lastSidecarRefreshCheck: 1_700_000_000_000,
    });
  });

  it("returns null for a document that is not a state object", () => {
    // Every one of these reads as "never checked", which is the fail-open
    // direction: the cost is one extra check, never a suppressed feature.
    expect(parseSidecarRefreshState("")).toBeNull();
    expect(parseSidecarRefreshState("{oh no")).toBeNull();
    expect(parseSidecarRefreshState("null")).toBeNull();
    expect(parseSidecarRefreshState("5")).toBeNull();
    expect(parseSidecarRefreshState('"1700000000000"')).toBeNull();
    // An array is typeof "object" too, and spreading one would turn its
    // indices into state keys that the next write persists as {"0": ...}.
    expect(parseSidecarRefreshState("[1,2]")).toBeNull();
  });

  it("drops a corrupt timestamp but keeps the document", () => {
    // A hand-edited or torn file. NaN fails every comparison silently, so the
    // honest reading of a broken stamp is "never checked" -- while anything
    // else in the file is still someone's data.
    expect(parseSidecarRefreshState("{}")).toEqual({});
    expect(parseSidecarRefreshState('{"lastSidecarRefreshCheck": "yesterday"}')).toEqual({});
    expect(parseSidecarRefreshState('{"lastSidecarRefreshCheck": null}')).toEqual({});
    expect(parseSidecarRefreshState('{"lastSidecarRefreshCheck": -1}')).toEqual({});
    // JSON has no NaN or Infinity literal, but an overflowing exponent parses
    // to Infinity -- a number, so `typeof at === "number"` alone lets it
    // through. Number.isFinite is what stands between it and a throttle
    // comparison that then never fires.
    expect(parseSidecarRefreshState('{"lastSidecarRefreshCheck": 1e400}')).toEqual({});
  });

  it("preserves a key a NEWER build wrote", () => {
    // The forward-compat promise the state is read-modify-written for. Reddens
    // if the parse goes back to rebuilding `{ lastSidecarRefreshCheck }` from
    // scratch, which drops every other key on this build's next write.
    expect(parseSidecarRefreshState('{"lastSidecarRefreshCheck": 7, "lastNudgeShown": 42}')).toEqual({
      lastSidecarRefreshCheck: 7,
      lastNudgeShown: 42,
    });
    // Including when the known key is the broken one.
    expect(parseSidecarRefreshState('{"lastSidecarRefreshCheck": "bad", "lastNudgeShown": 42}')).toEqual({
      lastNudgeShown: 42,
    });
  });
});

describe("mergeSidecarRefreshState", () => {
  it("stamps an absent or empty state", () => {
    expect(mergeSidecarRefreshState(null, { lastSidecarRefreshCheck: 9 })).toEqual({ lastSidecarRefreshCheck: 9 });
    expect(mergeSidecarRefreshState({}, { lastSidecarRefreshCheck: 9 })).toEqual({ lastSidecarRefreshCheck: 9 });
  });

  it("overwrites the known key and carries every other one through", () => {
    // The round trip the whole split exists for: parse -> merge -> write must
    // return a newer build's key unharmed while moving the timestamp.
    const onDisk = parseSidecarRefreshState('{"lastSidecarRefreshCheck": 1, "lastNudgeShown": 42}');
    expect(mergeSidecarRefreshState(onDisk, { lastSidecarRefreshCheck: 9 })).toEqual({
      lastSidecarRefreshCheck: 9,
      lastNudgeShown: 42,
    });
  });
});
