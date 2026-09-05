import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUDIT_USAGE,
  findCmdMetacharToken,
  parseAuditArgs,
  redactSecretArgs,
  resolveComplianceSuiteVersion,
  runAudit,
} from "../audit-cmd.js";
import { readGradesCache } from "../grades-cache.js";
import { CONFIG_DIRNAME } from "../paths.js";

function captureIO() {
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

/** Build a throwaway home dir with a ~/.yaw-mcp/bundles.json. */
function makeHome(servers: unknown[]): string {
  const home = mkdtempSync(join(tmpdir(), "yaw-audit-"));
  mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
  writeFileSync(join(home, CONFIG_DIRNAME, "bundles.json"), JSON.stringify({ version: 1, servers }, null, 2));
  return home;
}

describe("parseAuditArgs", () => {
  it("requires a namespace", () => {
    const r = parseAuditArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("missing <namespace>");
  });

  it("parses a namespace", () => {
    expect(parseAuditArgs(["ctxlint"])).toEqual({ ok: true, options: { namespace: "ctxlint", json: false } });
  });

  it("accepts --json", () => {
    expect(parseAuditArgs(["ctxlint", "--json"])).toEqual({
      ok: true,
      options: { namespace: "ctxlint", json: true },
    });
  });

  it("rejects unknown flags", () => {
    const r = parseAuditArgs(["ctxlint", "--wat"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown argument "--wat"');
  });

  it("rejects a second positional", () => {
    const r = parseAuditArgs(["a", "b"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unexpected extra argument");
  });

  it("--help returns usage with help:true so the dispatcher routes to stdout+exit0", () => {
    const r = parseAuditArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(AUDIT_USAGE);
      expect((r as { help?: boolean }).help).toBe(true);
    }
  });
});

describe("runAudit", () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
  });

  it("scrubs yaw-mcp's own secrets from process.env before the suite spawns the audited server", async () => {
    // The compliance runner spawns the server with `{ ...process.env, ...env }`.
    // Resolving vault refs REQUIRES YAW_MCP_VAULT_PASSPHRASE to be set, so
    // without this scrub the documented way to audit a vault-backed server
    // handed the vault passphrase (and YAW_MCP_TOKEN) to a third-party
    // server -- the broker's real spawn strips exactly these keys.
    process.env.YAW_MCP_VAULT_PASSPHRASE = "probe-passphrase";
    process.env.YAW_MCP_TOKEN = "probe-token";
    process.env.AUDIT_SCRUB_CANARY = "keep-me";
    try {
      home = makeHome([{ namespace: "ctxlint", name: "ctxlint", type: "local", command: "node", args: ["x.js"] }]);
      const io = captureIO();
      let seenEnv: NodeJS.ProcessEnv | null = null;
      const r = await runAudit({
        namespace: "ctxlint",
        home,
        cwd: home,
        out: io.push,
        err: io.pushErr,
        runner: async () => {
          seenEnv = { ...process.env };
          return { grade: "A", score: 97.5 };
        },
      });
      expect(r.exitCode).toBe(0);
      expect(seenEnv).not.toBeNull();
      const env = seenEnv as unknown as NodeJS.ProcessEnv;
      expect(env.YAW_MCP_VAULT_PASSPHRASE).toBeUndefined();
      expect(env.YAW_MCP_TOKEN).toBeUndefined();
      // Only yaw-mcp's own keys go; everything else the server needs stays.
      expect(env.AUDIT_SCRUB_CANARY).toBe("keep-me");
    } finally {
      delete process.env.YAW_MCP_TOKEN;
      delete process.env.AUDIT_SCRUB_CANARY;
    }
  });

  it("refuses (exit 2, nothing cached) when the env carries a ${secret:} ref the vault cannot resolve", async () => {
    // The suite used to receive the raw bundles.json env with the literal
    // `${secret:gh}` placeholder: the server auth-failed, the WRONG letter
    // was cached, and `list` / the MCP panel showed it. Audit now resolves
    // refs the way the real spawn does and fails CLOSED on a locked vault.
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome([
      {
        namespace: "gh",
        name: "gh",
        type: "local",
        command: "node",
        args: ["x.js"],
        env: { GITHUB_TOKEN: "${secret:gh}" },
      },
    ]);
    const io = captureIO();
    let runnerCalled = false;
    const r = await runAudit({
      namespace: "gh",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async () => {
        runnerCalled = true;
        return { grade: "F", score: 0 };
      },
    });
    expect(r.exitCode).toBe(2);
    expect(runnerCalled).toBe(false);
    expect(io.err.join("")).toContain("GITHUB_TOKEN");
    expect(io.err.join("")).toContain("YAW_MCP_VAULT_PASSPHRASE");
    // Nothing graded, nothing cached.
    const cache = await readGradesCache(home);
    expect(cache.gh).toBeUndefined();
  });

  it("audits a stdio server and writes the grade", async () => {
    home = makeHome([
      { namespace: "ctxlint", name: "ctxlint", type: "local", command: "node", args: ["x.js", "--mcp-server"] },
    ]);
    const io = captureIO();
    let seen: { command: string; args: string[] } | null = null;
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async (target) => {
        seen = { command: target.command, args: target.args };
        return { grade: "A", score: 97.5 };
      },
    });
    expect(r.exitCode).toBe(0);
    expect(seen).toEqual({ command: "node", args: ["x.js", "--mcp-server"] });

    const cache = await readGradesCache(home);
    expect(cache.ctxlint.grade).toBe("A");
    expect(cache.ctxlint.score).toBe(97.5);
    expect(typeof cache.ctxlint.gradedAt).toBe("string");
    // Injected runner returned no suiteVersion -- the field must stay absent,
    // not be written as undefined/"".
    expect("suiteVersion" in cache.ctxlint).toBe(false);
    expect(io.out.join("\n")).toContain("Grade: A");
  });

  it("persists the runner's suiteVersion so the cached letter records its rubric", async () => {
    // defaultRunner attaches the @yawlabs/mcp-compliance PACKAGE version (see
    // resolveComplianceSuiteVersion); this pins the plumbing from the runner's
    // report into grades.json.
    home = makeHome([{ namespace: "ctxlint", type: "local", command: "node", args: [] }]);
    const io = captureIO();
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async () => ({ grade: "A", score: 99, suiteVersion: "0.17.1" }),
    });
    expect(r.exitCode).toBe(0);
    const cache = await readGradesCache(home);
    expect(cache.ctxlint.suiteVersion).toBe("0.17.1");
  });

  it("reports suiteVersion in the --json payload, and omits the key when there is none", async () => {
    // The rubric identifier is persisted to grades.json, so a --json consumer
    // (the Yaw MCP panel) that never saw it could not tell an "A" graded under
    // an older rubric from a current one -- the field's whole purpose.
    home = makeHome([{ namespace: "ctxlint", type: "local", command: "node", args: [] }]);
    const io = captureIO();
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      json: true,
      out: io.push,
      err: io.pushErr,
      runner: async () => ({ grade: "A", score: 99, suiteVersion: "0.17.1" }),
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(io.out.join("\n")).suiteVersion).toBe("0.17.1");

    // A runner that reports no rubric leaves the key ABSENT rather than null,
    // matching the cache entry a pre-field audit wrote.
    const io2 = captureIO();
    await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      json: true,
      out: io2.push,
      err: io2.pushErr,
      runner: async () => ({ grade: "A", score: 99 }),
    });
    expect("suiteVersion" in JSON.parse(io2.out.join("\n"))).toBe(false);
  });

  it("emits PURE JSON with --json (no human preamble)", async () => {
    // The Yaw MCP panel parses this stdout directly, so in --json mode the
    // ENTIRE output must be the JSON object -- no "Auditing..." preamble. A
    // preamble whose text could contain a brace (a server arg like
    // --config={...}) would otherwise corrupt brace-based extraction and
    // misreport a passing audit as a failure. Pins that fix.
    home = makeHome([{ namespace: "ctxlint", type: "local", command: "node", args: ['--config={"port":1}'] }]);
    const io = captureIO();
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      json: true,
      out: io.push,
      err: io.pushErr,
      runner: async () => ({ grade: "B", score: 80 }),
    });
    expect(r.exitCode).toBe(0);
    const stdout = io.out.join("\n");
    expect(stdout).not.toContain("Auditing");
    // The whole stdout parses as JSON directly -- no leading lines to skip.
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({ namespace: "ctxlint", grade: "B", score: 80 });
  });

  it("exit 2 (parse-layer convention) when called directly with no namespace", async () => {
    // Unreachable via the CLI -- parseAuditArgs requires a namespace and
    // index.ts exits 2 first. This pins the direct-caller guard at exit 2 so
    // it matches the usage-error convention, not the exit-1 not-found case.
    const io = captureIO();
    const r = await runAudit({ out: io.push, err: io.pushErr });
    expect(r.exitCode).toBe(2);
    expect(io.err.join("\n")).toContain("missing <namespace>");
  });

  it("exit 1 when the namespace is not in bundles.json", async () => {
    home = makeHome([{ namespace: "other", type: "local", command: "node", args: [] }]);
    const io = captureIO();
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async () => ({ grade: "A", score: 100 }),
    });
    expect(r.exitCode).toBe(1);
    expect(io.err.join("\n")).toContain('no server named "ctxlint"');
  });

  it("surfaces loader warnings for a malformed bundles.json instead of a bare not-found", async () => {
    // A malformed (or unreadable) bundles.json loads as zero servers. The
    // loader's diagnostic used to be discarded, so the user saw only
    // `no server named "X"` with exit 1 -- the code the header reserves for a
    // typo'd namespace -- and nothing pointed at the broken file. The exit
    // code stays 1 (nothing was graded); the warning is what changes.
    home = mkdtempSync(join(tmpdir(), "yaw-audit-"));
    mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(join(home, CONFIG_DIRNAME, "bundles.json"), "{ not json");
    const io = captureIO();
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async () => ({ grade: "A", score: 100 }),
    });
    expect(r.exitCode).toBe(1);
    const stderr = io.err.join("\n");
    expect(stderr).toMatch(/warning: .*invalid JSON/);
    expect(stderr).toContain('no server named "ctxlint"');
  });

  it("keeps warnings off stdout in --json mode (stderr only)", async () => {
    home = mkdtempSync(join(tmpdir(), "yaw-audit-"));
    mkdirSync(join(home, CONFIG_DIRNAME), { recursive: true });
    writeFileSync(join(home, CONFIG_DIRNAME, "bundles.json"), "{ not json");
    const io = captureIO();
    await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      json: true,
      out: io.push,
      err: io.pushErr,
      runner: async () => ({ grade: "A", score: 100 }),
    });
    expect(io.out.join("")).not.toContain("warning:");
    expect(io.err.join("\n")).toMatch(/warning: .*invalid JSON/);
  });

  it("exit 2 for a remote (url-only) server", async () => {
    home = makeHome([{ namespace: "remote", type: "remote", url: "https://example.com/mcp" }]);
    const io = captureIO();
    let ran = false;
    const r = await runAudit({
      namespace: "remote",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async () => {
        ran = true;
        return { grade: "A", score: 100 };
      },
    });
    expect(r.exitCode).toBe(2);
    expect(ran).toBe(false);
    expect(io.err.join("\n")).toContain("yaw-mcp compliance https://example.com/mcp");
  });

  it("exit 2 for a server carrying NEITHER a command nor a url", async () => {
    // The bundles.json validator enforces shape, not semantics: it requires a
    // valid namespace and nothing else, so an entry with no command and no url
    // loads fine and reaches the sibling of the remote-url branch above. That
    // branch can't point at `yaw-mcp compliance <url>` -- there is no url --
    // so it says what IS wrong instead. Exit 2 with the other nothing-to-spawn
    // refusals; the suite never runs.
    home = makeHome([{ namespace: "hollow", name: "hollow", type: "local" }]);
    const io = captureIO();
    let ran = false;
    const r = await runAudit({
      namespace: "hollow",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async () => {
        ran = true;
        return { grade: "A", score: 100 };
      },
    });
    expect(r.exitCode).toBe(2);
    expect(ran).toBe(false);
    const stderr = io.err.join("\n");
    expect(stderr).toContain("has no command to spawn");
    // Not the remote-server message: there is no url to point the user at.
    expect(stderr).not.toContain("yaw-mcp compliance");
    expect(await readGradesCache(home)).toEqual({});
  });

  // A cache-write failure used to throw straight out of runAudit: the grade
  // the suite just spent minutes computing was never printed, and index.ts's
  // dispatch catch exited 1 -- the code this command documents as "no server
  // with that namespace". A read-only $HOME is the real-world shape; a
  // DIRECTORY where grades.json belongs reproduces it on every platform --
  // writeGrade's read-modify-write reads STRICTLY (grades-cache.ts
  // readGradesCacheImpl), so the EISDIR is rethrown before any write is
  // attempted rather than being degraded to an empty cache and clobbering it.
  function wedgeGradesCache(root: string): void {
    mkdirSync(join(root, CONFIG_DIRNAME, "grades.json"), { recursive: true });
    writeFileSync(join(root, CONFIG_DIRNAME, "grades.json", "occupied"), "x");
  }

  it("exit 3 when grades.json cannot be written -- the grade is still printed", async () => {
    home = makeHome([{ namespace: "ctxlint", type: "local", command: "node", args: [] }]);
    wedgeGradesCache(home);
    const io = captureIO();
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async () => ({ grade: "A", score: 97.5 }),
    });
    // 3, not 1 (namespace not found) and not 2 (nothing was graded).
    expect(r.exitCode).toBe(3);
    expect(io.out.join("\n")).toContain("Grade: A");
    expect(io.out.join("\n")).not.toContain("Cached to");
    expect(io.err.join("\n")).toContain("could not write");
  });

  it("keeps --json stdout parseable when the cache write fails", async () => {
    home = makeHome([{ namespace: "ctxlint", type: "local", command: "node", args: [] }]);
    wedgeGradesCache(home);
    const io = captureIO();
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      json: true,
      out: io.push,
      err: io.pushErr,
      runner: async () => ({ grade: "B", score: 80 }),
    });
    expect(r.exitCode).toBe(3);
    // The Yaw MCP panel parses this stdout: it must stay pure JSON, keep the
    // `cache` key (null, not absent), and carry the grade.
    const parsed = JSON.parse(io.out.join("\n"));
    expect(parsed).toMatchObject({ namespace: "ctxlint", grade: "B", score: 80, cache: null });
    expect(typeof parsed.cacheError).toBe("string");
  });

  it("exit 2 when the suite throws", async () => {
    home = makeHome([{ namespace: "ctxlint", type: "local", command: "node", args: [] }]);
    const io = captureIO();
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(r.exitCode).toBe(2);
    expect(io.err.join("\n")).toContain("compliance suite failed");
  });
});

describe("redactSecretArgs", () => {
  it("redacts the value after a secret flag, keeping the flag name", () => {
    expect(redactSecretArgs(["--token", "abc", "--port", "3000"])).toEqual(["--token", "<redacted>", "--port", "3000"]);
  });

  it("redacts the --flag=value shape", () => {
    expect(redactSecretArgs(["--api-key=sk-live-123"])).toEqual(["--api-key=<redacted>"]);
  });

  it("matches the flag case-insensitively (both shapes)", () => {
    expect(redactSecretArgs(["--Token", "abc"])).toEqual(["--Token", "<redacted>"]);
    expect(redactSecretArgs(["--API-KEY=sk-live-123"])).toEqual(["--API-KEY=<redacted>"]);
    expect(redactSecretArgs(["--Password", "hunter2"])).toEqual(["--Password", "<redacted>"]);
    expect(redactSecretArgs(["-P", "hunter2"])).toEqual(["-P", "<redacted>"]);
  });

  it("leaves a trailing bare flag alone (nothing to redact)", () => {
    expect(redactSecretArgs(["serve", "--token"])).toEqual(["serve", "--token"]);
  });

  it("redacts secret-bearing flags outside the exact name set", () => {
    // The set is 8 names; the spellings below are all ordinary and all used to
    // print their value in the clear in the interactive preamble. Matching is
    // on the flag NAME pattern, so both shapes are covered.
    expect(redactSecretArgs(["--access-token", "abc"])).toEqual(["--access-token", "<redacted>"]);
    expect(redactSecretArgs(["--client_secret=abc"])).toEqual(["--client_secret=<redacted>"]);
    expect(redactSecretArgs(["--api_key", "abc"])).toEqual(["--api_key", "<redacted>"]);
    expect(redactSecretArgs(["--bearer", "abc"])).toEqual(["--bearer", "<redacted>"]);
    expect(redactSecretArgs(["--passwd", "abc"])).toEqual(["--passwd", "<redacted>"]);
  });

  it("keeps the =value shape on the =value branch (the name pattern must not swallow the next arg)", () => {
    // The name pattern is anchored at both ends on purpose. Unanchored it also
    // matches "--token=abc" whole, which sends it down the `--flag value`
    // branch: the flag is echoed with its secret intact and the INNOCENT next
    // arg is redacted instead -- strictly worse than the bug it was fixing.
    expect(redactSecretArgs(["--access-token=abc", "--port", "3000"])).toEqual([
      "--access-token=<redacted>",
      "--port",
      "3000",
    ]);
  });

  it("does not touch non-secret args", () => {
    expect(redactSecretArgs(["x.js", "--mcp-server", "--verbose"])).toEqual(["x.js", "--mcp-server", "--verbose"]);
    // A bare value that merely CONTAINS a secret-ish word is not a flag.
    expect(redactSecretArgs(["tokenizer.js", "--port", "3000"])).toEqual(["tokenizer.js", "--port", "3000"]);
  });
});

describe("runAudit preamble redaction", () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("redacts a mixed-case secret flag value in the non-json preamble", async () => {
    home = makeHome([
      {
        namespace: "ctxlint",
        type: "local",
        command: "node",
        args: ["x.js", "--Token", "super-secret-value", "--API-KEY=another-secret", "--port", "3000"],
      },
    ]);
    const io = captureIO();
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async () => ({ grade: "A", score: 100 }),
    });
    expect(r.exitCode).toBe(0);
    const stdout = io.out.join("\n");
    expect(stdout).toContain("Auditing");
    expect(stdout).not.toContain("super-secret-value");
    expect(stdout).not.toContain("another-secret");
    expect(stdout).toContain("--Token <redacted>");
    expect(stdout).toContain("--API-KEY=<redacted>");
    // Non-secret args survive untouched so the operator still sees the shape.
    expect(stdout).toContain("--port 3000");
  });

  it("scrubs each arg on its own, so a header arg's redaction tail cannot swallow the args after it", async () => {
    // Scrubbing the space-JOINED args let rule 2's whole-clause tail run past
    // the argument boundary: `-H X-Api-Key: abc /srv/data --port 3000` came
    // out as `-H X-Api-Key: <redacted> --port 3000` with the path gone, and a
    // trailing positional after the header vanished entirely. Per-arg
    // scrubbing bounds the tail at the argument.
    const rawArgs = ["-H", "X-Api-Key: abc123def456", "/srv/data", "--port", "3000", "serve", "/srv"];
    home = makeHome([{ namespace: "ctxlint", type: "local", command: "node", args: rawArgs }]);
    const io = captureIO();
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async () => ({ grade: "A", score: 100 }),
    });
    expect(r.exitCode).toBe(0);
    const stdout = io.out.join("\n");
    expect(stdout).not.toContain("abc123def456");
    expect(stdout).toContain("X-Api-Key: <redacted>");
    expect(stdout).toContain("/srv/data");
    expect(stdout).toContain("--port 3000");
    expect(stdout).toContain("serve /srv");
  });

  it("scrubs a credential that is NOT a --flag value: a query string, a header arg, a JSON body", async () => {
    // redactSecretArgs knows the `--flag value` / `--flag=value` shapes and
    // nothing else, so a key inside a URL, an `Authorization:` header arg or
    // an inline JSON body printed in the clear in the interactive preamble --
    // scrollback, screen shares, pasted support output. The joined args now
    // also go through health-score's scrubForWarning, which covers exactly
    // those shapes. Still display-only: the runner gets the raw argv.
    const rawArgs = [
      "x.js",
      "--url",
      "https://api.example.test/x?api_key=sk-live-1234567890",
      "-H",
      "Authorization: Bearer abc123def456ghi789",
      '--body={"token":"tok_9f8e7d6c5b4a"}',
      "--port",
      "3000",
    ];
    home = makeHome([{ namespace: "ctxlint", type: "local", command: "node", args: rawArgs }]);
    const io = captureIO();
    let seenArgs: string[] = [];
    const r = await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async (target) => {
        seenArgs = target.args;
        return { grade: "A", score: 100 };
      },
    });
    expect(r.exitCode).toBe(0);
    const stdout = io.out.join("\n");
    expect(stdout).toContain("Auditing");
    expect(stdout).not.toContain("sk-live-1234567890");
    expect(stdout).not.toContain("abc123def456ghi789");
    expect(stdout).not.toContain("tok_9f8e7d6c5b4a");
    // The shape survives so the operator can still read WHICH arg carried it.
    expect(stdout).toContain("--url https://api.example.test/x?api_key=<redacted>");
    expect(stdout).toContain("-H Authorization: <redacted>");
    expect(stdout).toContain('--body={"token":"<redacted>"}');
    expect(stdout).toContain("--port 3000");
    // The framing around the args is intact: the scrub runs over the ARGS, not
    // the whole line, so its whole-clause tail cannot eat the closing paren.
    expect(stdout).toMatch(/--port 3000\)\.\.\./);
    expect(seenArgs).toEqual(rawArgs);
  });

  it("passes the UNREDACTED args to the runner (redaction is display-only)", async () => {
    home = makeHome([
      { namespace: "ctxlint", type: "local", command: "node", args: ["x.js", "--Token", "super-secret-value"] },
    ]);
    const io = captureIO();
    let seenArgs: string[] = [];
    await runAudit({
      namespace: "ctxlint",
      home,
      cwd: home,
      out: io.push,
      err: io.pushErr,
      runner: async (target) => {
        seenArgs = target.args;
        return { grade: "A", score: 100 };
      },
    });
    expect(seenArgs).toEqual(["x.js", "--Token", "super-secret-value"]);
  });
});

describe("resolveComplianceSuiteVersion", () => {
  // This is the value defaultRunner records as suiteVersion, exercised for
  // real (no injected runner, no network, no child process): the resolver
  // reads the installed @yawlabs/mcp-compliance package.json off disk.
  it("resolves the installed PACKAGE version -- semver-shaped, not the spec revision date", async () => {
    const v = await resolveComplianceSuiteVersion();
    // Ground truth: the package.json of the copy installed in this repo's
    // node_modules, read at a known relative path so the assertion cannot
    // drift from what the walk found.
    const pjPath = fileURLToPath(new URL("../../node_modules/@yawlabs/mcp-compliance/package.json", import.meta.url));
    const groundTruth = (JSON.parse(await readFile(pjPath, "utf8")) as { version: string }).version;
    expect(v).toBe(groundTruth);
    // The rubric identifier must be the package release (changes when the
    // rubric changes), NEVER the exported SPEC_VERSION protocol date
    // ("2025-11-25"), which is constant across compliance releases.
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    expect(v).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns undefined (never throws) for an unresolvable fromUrl", async () => {
    expect(await resolveComplianceSuiteVersion("not-a-file-url")).toBeUndefined();
  });

  // The two cases below are what `fromUrl` is injectable FOR. The walk mirrors
  // Node's own node_modules lookup, and both of its rules are silent when
  // wrong: a wrong copy still yields a plausible semver, so nothing downstream
  // ever notices that grades.json is labelled with a rubric that never ran.
  /** Plant a fake @yawlabs/mcp-compliance install under `root`. A null version
   *  writes an unparseable manifest. */
  function plantInstall(root: string, version: string | null): void {
    const dir = join(root, "node_modules", "@yawlabs", "mcp-compliance");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), version === null ? "{ not json" : JSON.stringify({ version }));
  }

  it("resolves the NEAREST installed copy, not an ancestor's", async () => {
    const root = mkdtempSync(join(tmpdir(), "yaw-suite-version-"));
    try {
      const inner = join(root, "apps", "web");
      mkdirSync(inner, { recursive: true });
      plantInstall(root, "9.9.9");
      plantInstall(inner, "1.2.3");
      // The nested copy is the one `import()` from inner would load, so it is
      // the one whose version describes the rubric that actually ran.
      expect(await resolveComplianceSuiteVersion(pathToFileURL(join(inner, "audit-cmd.js")).href)).toBe("1.2.3");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns undefined on a bad manifest rather than walking on to an ancestor's copy", async () => {
    // Continuing the walk would find a DIFFERENT install and attribute ITS
    // version to this one -- a mislabelled rubric is worse than no rubric,
    // which the cache already handles by omitting the field.
    const root = mkdtempSync(join(tmpdir(), "yaw-suite-version-"));
    try {
      const inner = join(root, "apps", "web");
      mkdirSync(inner, { recursive: true });
      plantInstall(root, "9.9.9");
      plantInstall(inner, null);
      expect(await resolveComplianceSuiteVersion(pathToFileURL(join(inner, "audit-cmd.js")).href)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// There is deliberately NO `describe("grades-cache")` block here. One existed
// -- round-trip, preserve-existing-entries, missing -> {}, malformed -> {},
// drop-malformed-entries -- and every case of it duplicated one already in
// grades-cache.test.ts (plus that file's concurrency, __proto__, score-range and
// strict-read coverage), while touching no line of audit-cmd.ts. Grade-cache
// behaviour belongs to its own suite; what audit-cmd.test.ts pins about the
// cache is what runAudit DOES with it -- the write on success, and the exit-3
// path when the write fails.

// The compliance runner spawns stdio targets with `shell: true` on win32 (so
// that .cmd/.bat launcher shims resolve). Node's shell path JOINS command +
// args into one string and hands it to `cmd.exe /d /s /c`, so an unquoted cmd
// metacharacter anywhere in the spawn config is parsed by cmd rather than
// passed through: at best the audited command is truncated and graded F for a
// failure yaw-mcp caused, at worst the tail after an `&` runs as a second
// command.
describe("cmd.exe metacharacter gate", () => {
  describe("findCmdMetacharToken", () => {
    it("finds a splitter or redirect in either the command or the args", () => {
      expect(findCmdMetacharToken("node", ["--url", "https://api/x?a=1&b=2"])).toBe("https://api/x?a=1&b=2");
      expect(findCmdMetacharToken("node", ["a|b"])).toBe("a|b");
      expect(findCmdMetacharToken("node", ["a>b"])).toBe("a>b");
      expect(findCmdMetacharToken("node", ["a<b"])).toBe("a<b");
      expect(findCmdMetacharToken("node", ["a^b"])).toBe("a^b");
      expect(findCmdMetacharToken("node", ["(x)"])).toBe("(x)");
      // The COMMAND shares the joined line, so it is checked too.
      expect(findCmdMetacharToken("srv&evil", [])).toBe("srv&evil");
    });

    it("returns the FIRST offending token so the diagnostic names one thing", () => {
      expect(findCmdMetacharToken("node", ["ok", "a&b", "c|d"])).toBe("a&b");
    });

    it("passes ordinary spawn configs, percent signs included", () => {
      expect(findCmdMetacharToken("node", ["x.js", "--mcp-server"])).toBeUndefined();
      expect(findCmdMetacharToken("npx", ["-y", "@scope/pkg", "/tmp/dir"])).toBeUndefined();
      expect(findCmdMetacharToken("node", ['--config={"port":1}'])).toBeUndefined();
      // `%` is deliberately NOT in the set: cmd expands %VAR% before any escape
      // processing (so refusing is the only lever and it is too blunt), and a
      // percent-encoded URL arg is the common, harmless case.
      expect(findCmdMetacharToken("node", ["https://example.com/%7Bid%7D"])).toBeUndefined();
    });
  });

  describe("runAudit", () => {
    let home: string;
    afterEach(() => {
      if (home) rmSync(home, { recursive: true, force: true });
    });

    it("refuses a metacharacter-bearing target on win32 without running the suite", async () => {
      home = makeHome([
        { namespace: "ctxlint", type: "local", command: "node", args: ["x.js", "--url", "https://api/x?a=1&b=2"] },
      ]);
      const io = captureIO();
      let ran = false;
      const r = await runAudit({
        namespace: "ctxlint",
        home,
        cwd: home,
        platform: "win32",
        out: io.push,
        err: io.pushErr,
        runner: async () => {
          ran = true;
          return { grade: "A", score: 100 };
        },
      });
      // Exit 2 is the "nothing was graded" code, alongside the remote-server
      // and no-command refusals -- never 1 (no such namespace) or 3 (graded
      // but not cached).
      expect(r.exitCode).toBe(2);
      expect(ran).toBe(false);
      const err = io.err.join("\n");
      expect(err).toContain("cmd.exe metacharacter");
      // Names the offending token, so the operator knows which arg to rework.
      expect(err).toContain("https://api/x?a=1&b=2");
      // Nothing graded means nothing cached.
      expect(await readGradesCache(home)).toEqual({});
    });

    it("refuses a metacharacter in the COMMAND, not just the args", async () => {
      home = makeHome([{ namespace: "ctxlint", type: "local", command: "srv&calc", args: [] }]);
      const io = captureIO();
      let ran = false;
      const r = await runAudit({
        namespace: "ctxlint",
        home,
        cwd: home,
        platform: "win32",
        out: io.push,
        err: io.pushErr,
        runner: async () => {
          ran = true;
          return { grade: "A", score: 100 };
        },
      });
      expect(r.exitCode).toBe(2);
      expect(ran).toBe(false);
      expect(io.err.join("\n")).toContain("srv&calc");
    });

    it("refuses BEFORE resolving vault refs, so a target it will not spawn never unlocks the vault", async () => {
      // runAudit's ordering is a security property, not an accident: the
      // metachar gate sits ABOVE the ${secret:} resolution so a spawn config
      // that is never going to run cannot make yaw-mcp open the vault (and, on
      // the documented vault-audit path, hand the passphrase to the process
      // env). Without a target carrying BOTH, swapping the two blocks passes
      // the whole suite -- the vault test has no metachar and the metachar
      // tests have no refs.
      delete process.env.YAW_MCP_VAULT_PASSPHRASE;
      home = makeHome([
        {
          namespace: "gh",
          name: "gh",
          type: "local",
          command: "node",
          args: ["a&b"],
          env: { GITHUB_TOKEN: "${secret:gh}" },
        },
      ]);
      const io = captureIO();
      let ran = false;
      const r = await runAudit({
        namespace: "gh",
        home,
        cwd: home,
        platform: "win32",
        out: io.push,
        err: io.pushErr,
        runner: async () => {
          ran = true;
          return { grade: "A", score: 100 };
        },
      });
      expect(r.exitCode).toBe(2);
      expect(ran).toBe(false);
      const err = io.err.join("\n");
      expect(err).toContain("cmd.exe metacharacter");
      expect(err).toContain("a&b");
      // The vault was never consulted: reversed, this run would report the
      // unresolvable ${secret:} ref instead.
      expect(err).not.toMatch(/vault/i);
      expect(await readGradesCache(home)).toEqual({});
    });

    it("does NOT refuse the same target off win32, where the runner spawns without a shell", async () => {
      // The gate is a Windows quoting concern only: everywhere else the
      // compliance runner passes argv straight through, so `&` is just a
      // character and refusing would be gratuitous.
      home = makeHome([
        { namespace: "ctxlint", type: "local", command: "node", args: ["x.js", "--url", "https://api/x?a=1&b=2"] },
      ]);
      const io = captureIO();
      let seen: string[] | null = null;
      const r = await runAudit({
        namespace: "ctxlint",
        home,
        cwd: home,
        platform: "linux",
        out: io.push,
        err: io.pushErr,
        runner: async (target) => {
          seen = target.args;
          return { grade: "A", score: 100 };
        },
      });
      expect(r.exitCode).toBe(0);
      expect(seen).toEqual(["x.js", "--url", "https://api/x?a=1&b=2"]);
    });

    it("still audits a clean target on win32", async () => {
      home = makeHome([{ namespace: "ctxlint", type: "local", command: "node", args: ["x.js"] }]);
      const io = captureIO();
      const r = await runAudit({
        namespace: "ctxlint",
        home,
        cwd: home,
        platform: "win32",
        out: io.push,
        err: io.pushErr,
        runner: async () => ({ grade: "B", score: 80 }),
      });
      expect(r.exitCode).toBe(0);
      expect(io.out.join("\n")).toContain("Grade: B");
    });
  });
});
