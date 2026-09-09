import { defaultExclude, defineConfig } from "vitest/config";

// Test files whose assertions are WALL-CLOCK budgets rather than values: a
// ReDoS tripwire timing four regexes over 98 KB, and two suites whose subject
// is a real subprocess settling on a deadline. Nothing about them is slow --
// they are contention-sensitive, and the default run packs ~400 s of test time
// into ~87 s of wall clock (roughly 4x CPU oversubscription), which is how a
// 500 ms budget measured at 26-250 ms standalone came back at 822 ms and
// failed a release run.
//
// They get their own project with fileParallelism disabled. That forces the
// project's maxWorkers to 1, which puts its files in vitest's sequential
// group: the group runs after every parallel group, one file at a time, so the
// budgets are measured on an idle box instead of a contended one. The
// alternative -- widening each budget until it cannot flake -- widens it past
// the regression it exists to catch.
const TIMING_SENSITIVE = [
  "src/tests/error-category.test.ts",
  "src/tests/install-targets.test.ts",
  "src/tests/uv-bootstrap.test.ts",
  // Same class as the two above: spawns the real broker plus a real upstream
  // and asserts BOTH settle within a budget after stdin closes. "Never exits"
  // is the regression it guards, so the budget cannot be relaxed into
  // "eventually" -- which makes it exactly the kind of assertion that must be
  // measured on an idle box.
  "src/tests/shutdown-on-stdin-close.test.ts",
];

export default defineConfig({
  test: {
    testTimeout: 30000,
    // Explicit, not inherited: hookTimeout defaults to 10 s and does NOT
    // follow testTimeout, so every heavy beforeAll/afterAll (temp-dir setup, a
    // tsup build, a spawned CLI) had to remember its own literal -- and only
    // cli-dispatch.test.ts does. This is the floor for the ones that do not.
    hookTimeout: 30000,
    // `extends: true` so each project inherits the timeouts above rather than
    // silently falling back to vitest's defaults.
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: [...defaultExclude, "**/dist/**", ...TIMING_SENSITIVE],
        },
      },
      {
        extends: true,
        test: {
          name: "timing",
          include: TIMING_SENSITIVE,
          fileParallelism: false,
        },
      },
    ],
  },
});
