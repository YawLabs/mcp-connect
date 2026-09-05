import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSecretsArgs, runSecrets, SECRETS_USAGE } from "../secrets-cmd.js";
import { deriveKey, type EncryptedEntry, encryptEntry, generateSalt, LEGACY_KDF } from "../secrets-crypto.js";
import {
  isUnlocked,
  loadVault,
  lock,
  rotateVault,
  SECRETS_SCHEMA_VERSION,
  saveVault,
  unlock,
  type VaultFile,
  vaultPath,
} from "../secrets-vault.js";

describe("parseSecretsArgs", () => {
  it("rejects missing action", () => {
    const r = parseSecretsArgs([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing action/);
  });

  it("rejects unknown action", () => {
    const r = parseSecretsArgs(["nuke"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown action "nuke"/);
  });

  it("set requires a name", () => {
    const r = parseSecretsArgs(["set"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/<name> is required/);
  });

  it("set <name> parses", () => {
    const r = parseSecretsArgs(["set", "github"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.action).toBe("set");
      expect(r.options.name).toBe("github");
    }
  });

  it("set <name> --value v parses inline", () => {
    const r = parseSecretsArgs(["set", "github", "--value", "ghp_abc"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.value).toBe("ghp_abc");
    }
  });

  it("set <name> --stdin parses", () => {
    const r = parseSecretsArgs(["set", "github", "--stdin"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.fromStdin).toBe(true);
  });

  it("get <name> parses", () => {
    const r = parseSecretsArgs(["get", "github"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.action).toBe("get");
      expect(r.options.name).toBe("github");
    }
  });

  it("list does not need a name", () => {
    const r = parseSecretsArgs(["list"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("list");
  });

  it("remove requires a name", () => {
    const r = parseSecretsArgs(["remove"]);
    expect(r.ok).toBe(false);
  });

  it("lock parses with no name", () => {
    const r = parseSecretsArgs(["lock"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("lock");
  });

  it("--json applies", () => {
    const r = parseSecretsArgs(["list", "--json"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.json).toBe(true);
  });

  it("--help sets help:true so dispatcher routes to stdout+exit0", () => {
    const r = parseSecretsArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe(SECRETS_USAGE);
      expect((r as { help?: boolean }).help).toBe(true);
    }
  });
  it("-h sets help:true", () => {
    const r = parseSecretsArgs(["-h"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect((r as { help?: boolean }).help).toBe(true);
  });

  it("rejects --value without arg", () => {
    const r = parseSecretsArgs(["set", "github", "--value"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --value followed by a flag instead of storing it as the secret", () => {
    const r = parseSecretsArgs(["set", "github", "--value", "--json"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--value requires a value/);
  });

  it("rejects extra positional", () => {
    const r = parseSecretsArgs(["set", "github", "extra"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unexpected positional/);
  });

  it("rejects unknown flag", () => {
    const r = parseSecretsArgs(["list", "--bogus"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown flag "--bogus"/);
  });

  // `push` / `pull` and the --replace / --push flags were removed 2026-07-21
  // with the Yaw Team surface. They must now be REJECTED, not silently
  // parsed -- these assertions are what stop them creeping back as no-op
  // flags that look supported. (--force came BACK on its own terms: it now
  // gates the destructive confirmations, not a vault sync.)
  it("push action is rejected", () => {
    expect(parseSecretsArgs(["push"]).ok).toBe(false);
  });

  it("pull action is rejected", () => {
    expect(parseSecretsArgs(["pull"]).ok).toBe(false);
  });

  it("--force parses and sets force (skips the destructive confirmation)", () => {
    const r = parseSecretsArgs(["remove", "github", "--force"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.action).toBe("remove");
      expect(r.options.name).toBe("github");
      expect(r.options.force).toBe(true);
    }
  });

  it("force is undefined when --force is absent (no accidental default-yes)", () => {
    const r = parseSecretsArgs(["remove", "github"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.force).toBeUndefined();
  });

  it("documents --force in the usage text (it is the only way to script a remove)", () => {
    expect(SECRETS_USAGE).toContain("--force");
  });

  // The confirmation needs stdin AND stdout to be a TTY, so the usage text
  // must not tell the user it is only about stdin -- `remove NAME | jq` from
  // an interactive shell hits the refusal with a TTY stdin.
  it("usage text does not blame stdin alone for the non-interactive remove refusal", () => {
    expect(SECRETS_USAGE).toMatch(/stdin or stdout/);
    expect(SECRETS_USAGE).not.toMatch(/Required for remove when stdin is not a/);
  });

  it("--replace is rejected as an unknown flag", () => {
    expect(parseSecretsArgs(["rotate", "--replace"]).ok).toBe(false);
  });

  it("rotate --push is rejected as an unknown flag", () => {
    expect(parseSecretsArgs(["rotate", "--push"]).ok).toBe(false);
  });

  it("rotate action parses without a name", () => {
    const r = parseSecretsArgs(["rotate"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.action).toBe("rotate");
  });

  it("audit action parses with filters", () => {
    const r = parseSecretsArgs(["audit", "--secret", "gh", "--server", "github", "--json"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.options.action).toBe("audit");
      expect(r.options.secretFilter).toBe("gh");
      expect(r.options.serverFilter).toBe("github");
      expect(r.options.json).toBe(true);
    }
  });

  it("rejects --secret without arg", () => {
    const r = parseSecretsArgs(["audit", "--secret"]);
    expect(r.ok).toBe(false);
  });

  it("rejects --secret / --server followed by a flag instead of storing the flag as the filter", () => {
    // `audit --secret --json` used to store "--json" as the secret filter and
    // print an empty trail -- the same trap --value already refused. A
    // namespace or a secret name can never start with a dash, so a
    // dash-leading value is always a missing one.
    const r = parseSecretsArgs(["audit", "--secret", "--json"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--secret requires a value/);
    const s = parseSecretsArgs(["audit", "--server", "--json"]);
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error).toMatch(/--server requires a value/);
  });

  it('rejects `set NAME --value ""` at parse time, before any passphrase prompt', () => {
    // runSecrets refuses an empty value too, but only AFTER the passphrase
    // prompt and the ~100ms scrypt derivation -- the same ordering the name
    // check was pulled forward for. The parser owns the cheap refusal.
    const r = parseSecretsArgs(["set", "github", "--value", ""]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/Secret value cannot be empty/);
      expect((r as { help?: boolean }).help).toBeUndefined();
    }
  });

  // The name character-class check used to live ONLY in setSecret, which
  // runs after the passphrase prompt, the scrypt derivation and the no-echo
  // value prompt -- so the user typed two secrets before being told the name
  // was never valid. The parser owns it now.
  it("rejects a set name with a space, and says what is allowed", () => {
    const r = parseSecretsArgs(["set", "my token"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/invalid secret name "my token"/);
      expect(r.error).toMatch(/letters, digits/);
      expect((r as { help?: boolean }).help).toBeUndefined();
    }
  });

  it("rejects a set name with a colon or braces (unreferenceable as ${secret:NAME})", () => {
    expect(parseSecretsArgs(["set", "gh:token"]).ok).toBe(false);
    expect(parseSecretsArgs(["set", "{gh}"]).ok).toBe(false);
  });

  it("accepts the full allowed character class for a set name", () => {
    const r = parseSecretsArgs(["set", "GH.token-1_x"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.name).toBe("GH.token-1_x");
  });

  // Deliberately scoped to `set`: get/remove already short-circuit to
  // `No secret named "..."` without prompting, and a vault written before
  // the rule existed must stay readable and removable by its legacy name.
  it("does not apply the name check to get/remove", () => {
    expect(parseSecretsArgs(["get", "my token"]).ok).toBe(true);
    expect(parseSecretsArgs(["remove", "my token"]).ok).toBe(true);
  });

  // A stray positional used to be SWALLOWED for every action that takes no
  // <name>: `secrets audit GH_TOKEN` exited 0 having printed the ENTIRE
  // trail, so an operator asking "where did GH_TOKEN go" read other
  // secrets' injection events as if they were GH_TOKEN's.
  it("rejects a positional on audit and names the flag that really filters", () => {
    const r = parseSecretsArgs(["audit", "GH_TOKEN"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/unexpected argument "GH_TOKEN"/);
      expect(r.error).toMatch(/--secret GH_TOKEN/);
      expect((r as { help?: boolean }).help).toBeUndefined();
    }
  });

  it("rejects a positional on list / lock / rotate", () => {
    for (const action of ["list", "lock", "rotate"]) {
      const r = parseSecretsArgs([action, "GH_TOKEN"]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/takes no <name>/);
    }
  });

  // The usage text marks these "(set only)" / "(audit only)"; the parser
  // used to accept them anywhere and silently drop them.
  it("rejects --value / --stdin on an action other than set", () => {
    expect(parseSecretsArgs(["get", "gh", "--stdin"]).ok).toBe(false);
    const r = parseSecretsArgs(["remove", "gh", "--value", "x"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--value applies to `set` only/);
  });

  it("rejects the audit-only filters on a non-audit action", () => {
    const r = parseSecretsArgs(["list", "--secret", "gh"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--secret applies to `audit` only/);
    expect(parseSecretsArgs(["get", "gh", "--server", "github"]).ok).toBe(false);
  });

  // `lock` clears a module-scoped cache in ITS OWN one-shot process. No code
  // path lets it reach the cached key inside a running hub, so the usage
  // text must not tell an operator it revokes anything there.
  it("the lock usage does not claim it reaches a running yaw-mcp server", () => {
    expect(SECRETS_USAGE).toMatch(/CANNOT reach a yaw-mcp\s+server that is already running/);
    expect(SECRETS_USAGE).not.toMatch(/it matters for a long-running yaw-mcp server/);
  });

  // Shell history is a 0600 file only the user reads; argv is world-readable
  // via ps / procfs for the whole run, which is the bigger exposure.
  it("the --value usage names the argv/ps exposure, not just shell history", () => {
    expect(SECRETS_USAGE).toMatch(/argv/);
    expect(SECRETS_USAGE).toMatch(/ps \/ \/proc/);
    expect(SECRETS_USAGE).toMatch(/For scripting use --stdin/);
  });
});

// The push / pull test suites were removed 2026-07-21 with the Yaw Team
// surface -- `secrets push` and `secrets pull` no longer exist. The local
// vault suites below (set / rotate / audit / TTY) are unaffected.

/** Fresh throwaway HOME per test. mkdtemp (not a fixed tmpdir path) so
 *  parallel runs can't collide, and rmSync in afterEach so the suite does
 *  not leave a pile of yaw-test-* directories behind in os.tmpdir(). */
function makeHome(): string {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), "yaw-mcp-cmd-"));
  return dir;
}

// -----------------------------------------------------------------------
// runSecrets set -- wrong-passphrase and empty-passphrase rejection
// -----------------------------------------------------------------------

describe("runSecrets set -- passphrase guards", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  let home: string;

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock(); // clear any cached key from a prior test
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  it("creates a vault on first set, then rejects a wrong passphrase on a later set", async () => {
    // First set creates the vault under the correct passphrase.
    const r1 = await runSecrets(
      { action: "set", name: "github", value: "ghp_abc", passphrase: "correct-horse", home },
      io,
    );
    expect(r1.exitCode).toBe(0);
    lock(); // force re-derivation on the next call

    // A second set with the WRONG passphrase must be rejected, not silently
    // written under a bad key.
    const r2 = await runSecrets(
      { action: "set", name: "aws", value: "aws_xyz", passphrase: "wrong-passphrase", home },
      io,
    );
    expect(r2.exitCode).toBe(1);
    const errOutput = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(errOutput.toLowerCase()).toContain("wrong passphrase");
  });

  it('rejects an empty passphrase (no silent unlock under key derived from "")', async () => {
    const r = await runSecrets({ action: "set", name: "github", value: "ghp_abc", passphrase: "", home }, io);
    expect(r.exitCode).toBe(1);
    const errOutput = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(errOutput.toLowerCase()).toMatch(/passphrase required/);
  });
});

// -----------------------------------------------------------------------
// readLineFromTTY -- Ctrl-D (EOT) cancels instead of submitting a
// partial passphrase. Driven through runSecrets via a fake TTY stdin.
// -----------------------------------------------------------------------

/** Minimal controllable fake of a TTY ReadStream for the passphrase reader.
 *  Each `resume()` (one per prompt) flushes the next queued chunk to the
 *  registered "data" listener on the next microtask. */
class FakeTTYStdin {
  isTTY = true;
  isRaw = false;
  private listener: ((chunk: string) => void) | null = null;
  private queue: string[];
  constructor(chunks: string[]) {
    this.queue = [...chunks];
  }
  setRawMode(v: boolean): this {
    this.isRaw = v;
    return this;
  }
  setEncoding(): this {
    return this;
  }
  on(event: string, cb: (chunk: string) => void): this {
    if (event === "data") this.listener = cb;
    return this;
  }
  removeListener(event: string, cb: (chunk: string) => void): this {
    if (event === "data" && this.listener === cb) this.listener = null;
    return this;
  }
  resume(): this {
    // Deliver the next chunk after the current synchronous frame so the
    // reader's "data" listener (attached AFTER resume() in the reader) is
    // already registered. Read this.listener lazily inside the microtask.
    const next = this.queue.shift();
    if (next !== undefined) {
      queueMicrotask(() => this.listener?.(next));
    }
    return this;
  }
  pause(): this {
    return this;
  }
  /** Mirror Readable#unshift: the reader re-buffers paste residue (the bytes
   *  after the line terminator) here, and the next resume() delivers it. */
  unshift(chunk: string): void {
    this.queue.unshift(chunk);
  }
}

describe("readLineFromTTY -- Ctrl-D cancel", () => {
  let home: string;
  const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  const io = { out: vi.fn(), err: vi.fn() };

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  it("treats typed chars followed by Ctrl-D (\\u0004) as cancel, NOT a partial submit", async () => {
    const EOT = String.fromCharCode(4);
    // Three prompts, each: type "abc" then Ctrl-D. If EOT were a line
    // terminator (the old bug) the first prompt would submit "abc" and unlock;
    // as a cancel it resolves "" each time, so resolvePassphrase exhausts its
    // re-prompt budget and reports "passphrase required" (exit 1).
    const stdin = new FakeTTYStdin([`abc${EOT}`, `abc${EOT}`, `abc${EOT}`]);
    const r = await runSecrets(
      {
        action: "set",
        name: "github",
        value: "ghp_abc",
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    const errOutput = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(errOutput.toLowerCase()).toMatch(/passphrase required/);
    // ...and no vault was written under an "abc"-derived key. Without this
    // line the test passes for a regression that treats EOT as a line
    // terminator and CREATES the vault under the partial entry.
    expect(existsSync(vaultPath(home))).toBe(false);
  });

  it("treats Ctrl-C (\\u0003) as cancel -> exit 130, without killing the process", async () => {
    const ETX = String.fromCharCode(3);
    // A single prompt: type "abc" then ^C. The reader must hand back a
    // cancellation (exit 130) rather than calling process.exit(130) itself --
    // if it did, this test would take the whole vitest worker down with it.
    const stdin = new FakeTTYStdin([`abc${ETX}`]);
    const r = await runSecrets(
      {
        action: "set",
        name: "github",
        value: "ghp_abc",
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(130);
    const errOutput = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(errOutput.toLowerCase()).toContain("cancelled");
  });
});

// -----------------------------------------------------------------------
// A terminal paste arrives as ONE chunk. The reader must consume exactly
// through its line terminator and re-buffer the rest for the next prompt --
// dropping it meant a pasted "passphrase\nvalue\n" lost the value line and
// the next prompt hung on input the user believes they already gave.
// -----------------------------------------------------------------------

describe("readLineFromTTY -- multi-line paste feeds successive prompts", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  let home: string;

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  it("a single pasted chunk answers the passphrase, its confirm, AND the value prompt (CRLF = one Enter)", async () => {
    // One chunk, three answers. The CRLF line endings also assert the pair
    // is swallowed as ONE Enter -- a re-buffered "\n" would submit the next
    // prompt as empty, fail the confirm, and exhaust the re-prompt budget.
    const stdin = new FakeTTYStdin(["a-long-passphrase\r\na-long-passphrase\r\nthe-value\r\n"]);
    const r = await runSecrets(
      {
        action: "set",
        name: "github",
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    const prompts = (stdout.write as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .join("");
    expect(prompts).toContain("Confirm passphrase: ");
    expect(prompts).toContain("Secret value: ");

    // Every line landed where it belonged: the vault unlocks under the
    // pasted passphrase and holds the pasted value.
    lock();
    io.out.mockReset();
    const got = await runSecrets({ action: "get", name: "github", passphrase: "a-long-passphrase", home }, io);
    expect(got.exitCode).toBe(0);
    expect(io.out.mock.calls.map((c) => c[0] as string).join("")).toContain("the-value");
  });
});

// -----------------------------------------------------------------------
// The "no passphrase available" refusal must not tell a Git Bash user to
// "run from a TTY" -- they ARE at a terminal; MSYS just emulates it with
// pipes, so Node reports isTTY false and the prompt can never fire there.
// -----------------------------------------------------------------------

describe("passphrase-required message under Git Bash / MSYS", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  // Both ends non-TTY: prompting is genuinely impossible, which is the only
  // case the MSYS wording may claim.
  const stdin = { isTTY: false } as unknown as NodeJS.ReadableStream;
  const stdout = { isTTY: false, write: vi.fn() } as unknown as NodeJS.WritableStream;
  let home: string;
  let savedMsystem: string | undefined;

  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    savedMsystem = process.env.MSYSTEM;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    if (savedMsystem === undefined) delete process.env.MSYSTEM;
    else process.env.MSYSTEM = savedMsystem;
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  it("names the MSYS pipe emulation and the real remedies when MSYSTEM is set", async () => {
    process.env.MSYSTEM = "MINGW64";
    const r = await runSecrets({ action: "set", name: "github", value: "ghp_abc", home, io: { stdin, stdout } }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("Passphrase required.");
    expect(errText()).toContain("Git Bash/MSYS");
    expect(errText()).toContain("winpty");
    expect(errText()).toContain("YAW_MCP_VAULT_PASSPHRASE");
    // The wrong claim is gone: the user is not told to go find a TTY.
    expect(errText()).not.toContain("run from a TTY");
  });

  it("keeps the plain TTY wording when MSYSTEM is not set", async () => {
    delete process.env.MSYSTEM;
    const r = await runSecrets({ action: "set", name: "github", value: "ghp_abc", home, io: { stdin, stdout } }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain(
      "Passphrase required. Set YAW_MCP_VAULT_PASSPHRASE or run from a TTY so we can prompt.",
    );
    expect(errText()).not.toContain("winpty");
  });
});

// -----------------------------------------------------------------------
// Vault CREATION on first set confirms the passphrase twice. A vault with
// no check marker accepts ANY passphrase at unlock, so there is no later
// "wrong passphrase" guard to catch a first-set typo -- the confirm is the
// only line of defense against establishing an unrecoverable passphrase.
// The env-var path stays single-shot.
// -----------------------------------------------------------------------

describe("runSecrets set -- confirm-twice on vault creation", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  let home: string;

  const promptText = (): string =>
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string).join("");
  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    lock();
  });

  it("matching entries create the vault, and the second (Confirm) prompt is shown", async () => {
    // Two matching passphrase entries; the value comes from --value so no
    // third prompt is needed.
    const stdin = new FakeTTYStdin(["super-secret-pass\r", "super-secret-pass\r"]);
    const r = await runSecrets(
      {
        action: "set",
        name: "github",
        value: "ghp_abc",
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(promptText()).toContain("Confirm passphrase: ");

    // The vault unlocks under the confirmed passphrase.
    lock();
    const got = await runSecrets(
      { action: "get", name: "github", passphrase: "super-secret-pass", home, json: true },
      io,
    );
    expect(got.exitCode).toBe(0);
  });

  it("a first-set typo (the two entries disagree) is rejected -- no vault is written", async () => {
    // Three disagreeing pairs exhaust the re-prompt budget, so no passphrase
    // is ever accepted. Without the confirm, the first typo would have BECOME
    // the vault passphrase and locked the user out permanently.
    const stdin = new FakeTTYStdin([
      "typo-aaa\r",
      "typo-bbb\r",
      "typo-aaa\r",
      "typo-bbb\r",
      "typo-aaa\r",
      "typo-bbb\r",
    ]);
    const r = await runSecrets(
      {
        action: "set",
        name: "github",
        value: "ghp_abc",
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText().toLowerCase()).toMatch(/passphrase required/);
    expect(promptText()).toContain("did not match");
    expect(existsSync(vaultPath(home))).toBe(false);
  });

  it("a valid first entry then ^C at the Confirm prompt cancels with 130 -- no vault is written", async () => {
    // The existing ^C-on-creation coverage cancels at the FIRST ("Vault
    // passphrase:") prompt. This one accepts a valid first entry and hits ^C
    // at the SECOND ("Confirm passphrase:") prompt: resolvePassphrase must
    // still hand back a cancellation (exit 130), distinct from a mismatch
    // (which re-prompts) and from a first-prompt cancel.
    const ETX = String.fromCharCode(3);
    const stdin = new FakeTTYStdin(["good-passphrase-xyz\r", ETX]);
    const r = await runSecrets(
      {
        action: "set",
        name: "github",
        value: "ghp_abc",
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(130);
    // The cancel landed at the confirm prompt, so that prompt was reached.
    expect(promptText()).toContain("Confirm passphrase: ");
    expect(errText().toLowerCase()).toContain("cancelled");
    // Nothing committed to disk.
    expect(existsSync(vaultPath(home))).toBe(false);
  });

  it("a mismatch on the first confirm attempt then a matching pair on the second CREATES the vault", async () => {
    // attempt 0: "wrong-a" != "wrong-b" -> "did not match", re-prompt.
    // attempt 1: the pair agrees -> accepted (MAX_PASSPHRASE_PROMPTS is 3, so
    // the retry is well within budget). Value comes from --value, so no third
    // prompt. Existing coverage only exercised match-first and all-mismatch.
    const stdin = new FakeTTYStdin(["wrong-a\r", "wrong-b\r", "good-passphrase-xyz\r", "good-passphrase-xyz\r"]);
    const r = await runSecrets(
      {
        action: "set",
        name: "github",
        value: "ghp_abc",
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    // The user saw the mismatch feedback before the accepted retry.
    expect(promptText()).toContain("did not match");

    // The vault was created under the SECOND (matching) passphrase, so the
    // secret is retrievable with it.
    lock();
    io.out.mockReset();
    const got = await runSecrets(
      { action: "get", name: "github", passphrase: "good-passphrase-xyz", home, json: true },
      io,
    );
    expect(got.exitCode).toBe(0);
    const okLine = io.out.mock.calls.map((c) => c[0] as string).find((s) => s.trim().startsWith("{"));
    expect(okLine && JSON.parse(okLine).value).toBe("ghp_abc");
  });

  it("the env-var passphrase path stays single-shot (no confirm prompt on creation)", async () => {
    process.env.YAW_MCP_VAULT_PASSPHRASE = "env-passphrase-xyz";
    const stdin = new FakeTTYStdin([]);
    const r = await runSecrets(
      {
        action: "set",
        name: "github",
        value: "ghp_abc",
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    // The env var supplied the passphrase -- no prompt of either kind.
    expect(promptText()).not.toContain("Confirm passphrase: ");
    expect(promptText()).not.toContain("Vault passphrase: ");
  });
});

// -----------------------------------------------------------------------
// Short-passphrase warning -- on EVERY path, not just the env var.
//
// The warning used to fire only for YAW_MCP_VAULT_PASSPHRASE, so the
// interactive creation prompt -- the one place a human actually CHOOSES the
// vault passphrase -- was the single path with no feedback at all. A vault
// created under "abc" is trivially brute-forced offline against the stolen
// file, which is precisely the threat model the vault exists for.
// -----------------------------------------------------------------------

describe("runSecrets -- short-passphrase warning covers the TTY paths", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  let home: string;

  // The warnings ride the same `err` callback as every error envelope --
  // there is no separate stderr stream for an embedder to forget to wire.
  const warned = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");
  const ttyIo = (stdin: FakeTTYStdin): { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream } => ({
    stdin: stdin as unknown as NodeJS.ReadableStream,
    stdout,
  });

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    lock();
  });

  it("warns when the confirm-twice CREATION prompt accepts a short passphrase", async () => {
    const stdin = new FakeTTYStdin(["abc\r", "abc\r"]);
    const r = await runSecrets({ action: "set", name: "github", value: "ghp_abc", home, io: ttyIo(stdin) }, io);
    expect(r.exitCode).toBe(0);
    expect(warned()).toContain("shorter than 12 characters");
    // Advisory, never a block -- the vault really was created under "abc".
    lock();
    expect((await runSecrets({ action: "get", name: "github", passphrase: "abc", home }, io)).exitCode).toBe(0);
  });

  it("stays quiet when the creation prompt accepts a long passphrase", async () => {
    const stdin = new FakeTTYStdin(["a-properly-long-passphrase\r", "a-properly-long-passphrase\r"]);
    const r = await runSecrets({ action: "set", name: "github", value: "ghp_abc", home, io: ttyIo(stdin) }, io);
    expect(r.exitCode).toBe(0);
    expect(warned()).not.toContain("shorter than");
  });

  it("warns on the TTY UNLOCK prompt too, and points at rotate as the fix", async () => {
    // Seed the vault off-TTY so only the READ below exercises the prompt.
    expect(
      (await runSecrets({ action: "set", name: "github", value: "ghp_abc", passphrase: "abc", home }, io)).exitCode,
    ).toBe(0);
    lock();
    io.err.mockReset();

    const stdin = new FakeTTYStdin(["abc\r"]);
    const r = await runSecrets({ action: "get", name: "github", home, io: ttyIo(stdin) }, io);
    expect(r.exitCode).toBe(0);
    expect(warned()).toContain("shorter than 12 characters");
    // Retyping cannot lengthen a passphrase the vault already committed to, so
    // rotate stays the fix -- offered conditionally (see the next test).
    expect(warned()).toContain("yaw-mcp secrets rotate");
  });

  // The warning fires on whatever was typed, BEFORE unlock() has verified it.
  // A fat-fingered short entry must therefore never be described as this
  // vault's passphrase, nor told outright to re-key one that was never wrong.
  it("never calls the unverified entry the vault's passphrase on a WRONG one", async () => {
    expect(
      (
        await runSecrets(
          { action: "set", name: "github", value: "ghp_abc", passphrase: "a-properly-long-passphrase", home },
          io,
        )
      ).exitCode,
    ).toBe(0);
    lock();
    io.err.mockReset();

    // Short AND wrong: the vault's real passphrase is the long one above.
    const stdin = new FakeTTYStdin(["oops\r"]);
    const r = await runSecrets({ action: "get", name: "github", home, io: ttyIo(stdin) }, io);
    expect(r.exitCode).toBe(1);
    expect(warned()).toContain("shorter than 12 characters");
    expect(warned()).toContain("the passphrase you entered");
    // The misleading subject: it asserted the typed string IS the vault's and
    // told the user to re-key, immediately before "wrong passphrase".
    expect(warned()).not.toContain("this vault's passphrase");
    // Any rotate pointer must stay conditional, never an imperative.
    expect(warned()).toContain("If it unlocks this vault");
  });
});

// -----------------------------------------------------------------------
// Invalid secret name -- rejected by the PARSER, so the command body (and
// its passphrase prompt, scrypt derivation and vault read) never runs.
// -----------------------------------------------------------------------

describe("secrets set -- invalid name fails before any prompt", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  let home: string;

  /** Mirror the CLI dispatcher (src/index.ts:160): parse first, and reach
   *  runSecrets ONLY when the parse succeeded. `ran` records whether the
   *  command body executed -- everything the finding is about (prompt,
   *  ~100ms scrypt, vault read) lives behind it. */
  async function dispatch(
    argv: string[],
    stdin: FakeTTYStdin,
  ): Promise<{ ran: boolean; exitCode: number; error: string }> {
    const parsed = parseSecretsArgs(argv);
    // index.ts writes parsed.error to stderr and exits 2 on a parse failure.
    if (!parsed.ok) return { ran: false, exitCode: 2, error: parsed.error };
    const r = await runSecrets(
      {
        ...parsed.options,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    return { ran: true, exitCode: r.exitCode, error: io.err.mock.calls.map((c) => c[0] as string).join("") };
  }

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  it('rejects `set "my token"` at parse time -- no passphrase prompt, no value prompt, vault untouched', async () => {
    // Seed a vault so a read/write by the command body would be observable.
    const seed = await runSecrets(
      { action: "set", name: "github", value: "ghp_abc", passphrase: "seed-passphrase-xyz", home },
      io,
    );
    expect(seed.exitCode).toBe(0);
    const before = readFileSync(vaultPath(home), "utf8");
    lock();
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();

    // stdin is preloaded with a passphrase AND a secret value: if the check
    // regresses to setSecret-only, the command body consumes BOTH prompts
    // before reporting the bad name -- which is exactly the UX being fixed.
    const stdin = new FakeTTYStdin(["seed-passphrase-xyz\r", "some-value\r"]);
    const r = await dispatch(["set", "my token"], stdin);

    expect(r.ran).toBe(false);
    expect(r.exitCode).toBe(2);
    expect(r.error).toMatch(/invalid secret name "my token"/);
    expect(r.error).toMatch(/letters, digits/);
    // Nothing was written to the terminal -- both prompts go through
    // stdout.write, so zero calls means the user was never asked anything.
    expect(stdout.write).not.toHaveBeenCalled();
    // ...and the vault on disk is byte-identical: no entry, no re-save.
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });
});

// -----------------------------------------------------------------------
// runSecrets rotate -- local re-encryption (no --push)
// -----------------------------------------------------------------------

describe("runSecrets rotate", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  let home: string;

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock();
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  it("re-encrypts the vault: new passphrase reads, old one no longer does", async () => {
    // Seed a vault under the old passphrase.
    const r1 = await runSecrets(
      { action: "set", name: "github", value: "ghp_abc", passphrase: "old-passphrase-xyz", home },
      io,
    );
    expect(r1.exitCode).toBe(0);
    lock();

    // Rotate to a new passphrase (test hooks bypass env/TTY).
    const r2 = await runSecrets(
      { action: "rotate", passphrase: "old-passphrase-xyz", newPassphrase: "new-passphrase-xyz", home },
      io,
    );
    expect(r2.exitCode).toBe(0);
    lock();

    // get under the NEW passphrase succeeds.
    io.out.mockReset();
    const r3 = await runSecrets(
      { action: "get", name: "github", passphrase: "new-passphrase-xyz", home, json: true },
      io,
    );
    expect(r3.exitCode).toBe(0);
    const okLine = io.out.mock.calls.map((c) => c[0] as string).find((s) => s.trim().startsWith("{"));
    expect(okLine && JSON.parse(okLine).value).toBe("ghp_abc");
    lock();

    // get under the OLD passphrase is now rejected (wrong passphrase).
    io.err.mockReset();
    const r4 = await runSecrets({ action: "get", name: "github", passphrase: "old-passphrase-xyz", home }, io);
    expect(r4.exitCode).toBe(1);
    const err = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(err.toLowerCase()).toMatch(/wrong passphrase|decryption failed/);
  });

  it("aborts on a wrong current passphrase; vault is unchanged", async () => {
    await runSecrets({ action: "set", name: "k", value: "v", passphrase: "correct-current", home }, io);
    const before = readFileSync(vaultPath(home), "utf8");
    lock();

    const r = await runSecrets(
      { action: "rotate", passphrase: "wrong-current", newPassphrase: "whatever-new", home },
      io,
    );
    expect(r.exitCode).toBe(1);
    // On-disk vault untouched by the aborted rotate.
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("errors when there is no vault to rotate", async () => {
    const r = await runSecrets({ action: "rotate", passphrase: "x", newPassphrase: "y", home }, io);
    expect(r.exitCode).toBe(1);
    const err = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(err.toLowerCase()).toContain("no vault");
  });
});

// -----------------------------------------------------------------------
// runSecrets audit -- read the local audit log
// -----------------------------------------------------------------------

describe("runSecrets audit", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  let home: string;

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reports an empty trail when nothing has been recorded", async () => {
    const r = await runSecrets({ action: "audit", home }, io);
    expect(r.exitCode).toBe(0);
    const out = io.out.mock.calls.map((c) => c[0] as string).join("");
    expect(out.toLowerCase()).toContain("no secret-resolution audit");
  });

  it("renders recorded events and filters by server", async () => {
    const { appendAuditEvent } = await import("../secrets-audit.js");
    await appendAuditEvent({ server: "gh", secret: "token", event: "injected" }, home);
    await appendAuditEvent({ server: "aws", secret: "key", event: "missing" }, home);

    const r = await runSecrets({ action: "audit", serverFilter: "gh", home, json: true }, io);
    expect(r.exitCode).toBe(0);
    const out = io.out.mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(out);
    expect(parsed.count).toBe(1);
    expect(parsed.events[0].server).toBe("gh");
    // No value field in any emitted event.
    expect(Object.keys(parsed.events[0]).sort()).toEqual(["event", "secret", "server", "ts"]);
  });
});

// -----------------------------------------------------------------------
// Destructive-action confirmation (remove, and a set that overwrites).
//
// Before this gate existed, `secrets remove TOKEN` deleted immediately and
// exited 0, and `secrets set TOKEN` over an existing name silently replaced
// the value while printing the same 'Stored secret "TOKEN".' as a fresh
// write. Both destroy a credential that may exist nowhere else.
//
// The two paths are asymmetric ON PURPOSE and each half is asserted below:
// remove is unrecoverable (non-TTY must pass --force), a set overwrite is a
// swap with the new value already in hand (non-TTY proceeds, but the
// message must say "Replaced").
// -----------------------------------------------------------------------

const CONFIRM_PASS = "confirm-passphrase-xyz";

/** Non-TTY stdin/stdout pair, so these tests never depend on whether the
 *  vitest worker's process.stdin happens to be a TTY. */
function nonTTYIo(): {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
} {
  return {
    stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
    stdout: { isTTY: false, write: vi.fn() } as unknown as NodeJS.WritableStream,
  };
}

describe("runSecrets remove -- confirmation gate", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  let home: string;

  /** Seed a one-entry vault and return its exact on-disk bytes, so a test
   *  can assert the file was not touched at all. */
  async function seed(): Promise<string> {
    const r = await runSecrets({ action: "set", name: "TOKEN", value: "ghp_abc", passphrase: CONFIRM_PASS, home }, io);
    expect(r.exitCode).toBe(0);
    lock();
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();
    return readFileSync(vaultPath(home), "utf8");
  }

  const outText = (): string => io.out.mock.calls.map((c) => c[0] as string).join("");
  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");
  const promptText = (): string =>
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string).join("");

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  it("TTY + bare Enter does NOT delete (the prompt defaults to no)", async () => {
    const before = await seed();
    const stdin = new FakeTTYStdin(["\r"]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText().toLowerCase()).toContain("aborted");
    // The user was actually asked, and the vault is byte-identical.
    expect(promptText().toLowerCase()).toContain("delete");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  // The bare-Enter default above only pins "empty means no". It does NOT pin
  // the y/yes CHECK itself: relaxing promptYesNo to `answer.length > 0` (any
  // non-empty answer = consent) keeps every bare-Enter test green while
  // turning a typed "n" into a delete. On the unrecoverable path that is the
  // worst possible regression, so an explicit no is asserted directly.
  it.each(["n", "no"])('TTY + explicit "%s" does NOT delete', async (answer) => {
    const before = await seed();
    const stdin = new FakeTTYStdin([`${answer}\r`]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("Aborted.");
    // The user was actually asked, and the vault is byte-identical.
    expect(promptText().toLowerCase()).toContain("delete");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("TTY + explicit y deletes the entry", async () => {
    await seed();
    const stdin = new FakeTTYStdin(["y\r"]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(outText()).toContain('Removed "TOKEN"');
    lock();

    io.err.mockReset();
    const after = await runSecrets({ action: "get", name: "TOKEN", passphrase: CONFIRM_PASS, home }, io);
    expect(after.exitCode).toBe(1);
    expect(errText()).toContain('No secret named "TOKEN"');
  });

  // Every other confirmation test injects opts.passphrase, which
  // short-circuits resolvePassphrase -- so none of them can tell whether the
  // gate runs before or after it. This one OMITS the passphrase (and the env
  // var is deleted in beforeEach), so the passphrase would have to come from
  // a real prompt. If the gate moved to after the passphrase resolution, the
  // single queued chunk would be eaten by "Vault passphrase: " instead, which
  // is exactly the cost the ordering exists to avoid.
  it("a declined confirmation costs no passphrase entry (the gate runs BEFORE the prompt)", async () => {
    const before = await seed();
    const stdin = new FakeTTYStdin(["n\r"]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("Aborted.");
    expect(promptText()).not.toContain("Vault passphrase: ");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("TTY + ^C at the prompt cancels with 130 and leaves the vault alone", async () => {
    const before = await seed();
    const ETX = String.fromCharCode(3);
    const stdin = new FakeTTYStdin([ETX]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(130);
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  // The confirm prompt echoes what is typed (a y/n is not a secret), so any
  // byte the reader buffers goes straight back to the terminal. A raw ESC
  // sent back is EXECUTED by the terminal rather than displayed -- an arrow
  // key at the [y/N] prompt repainted the screen and desynced what the user
  // saw from what the answer buffer held.
  const ESC = String.fromCharCode(27);

  it("an ESC byte at the confirm prompt is dropped: not echoed, and the answer still reads as y", async () => {
    await seed();
    const stdin = new FakeTTYStdin([`${ESC}y\r`]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    // Buffered, the ESC would make the answer "\x1by" -- which is not "y",
    // so the delete would silently turn into an abort.
    expect(r.exitCode).toBe(0);
    expect(outText()).toContain('Removed "TOKEN"');
    expect(promptText()).not.toContain(ESC);
  });

  it("an arrow-key sequence at the confirm prompt never echoes the raw ESC back to the terminal", async () => {
    const before = await seed();
    // Up-arrow is ESC + "[A". The decision is unaffected either way (neither
    // "[A" nor "\x1b[A" is consent) -- what matters is that the terminal is
    // never handed the escape byte.
    const stdin = new FakeTTYStdin([`${ESC}[A\r`]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("Aborted.");
    expect(promptText()).not.toContain(ESC);
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  // Backspace still has to work, and it must never eat the prompt text
  // itself: "yy" then two Backspaces then "y" is a plain y.
  it("Backspace still edits the answer and cannot chew past the start of the buffer", async () => {
    await seed();
    const BS = String.fromCharCode(127);
    const stdin = new FakeTTYStdin([`yy${BS}${BS}${BS}${BS}y\r`]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(outText()).toContain('Removed "TOKEN"');
  });

  it("non-TTY without --force refuses (exit 2), names the flag, and leaves the vault byte-identical", async () => {
    const before = await seed();
    const r = await runSecrets({ action: "remove", name: "TOKEN", passphrase: CONFIRM_PASS, home, io: nonTTYIo() }, io);
    expect(r.exitCode).toBe(2);
    expect(errText()).toContain("--force");
    expect(errText()).toContain("neither stdin nor stdout is a TTY");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  // The gate needs BOTH ends (stdin to read the answer, stdout to show the
  // question), so the refusal has to name the end that actually failed.
  // Blaming stdin unconditionally sent `remove NAME --json | jq` -- run from
  // an interactive shell, so stdin IS a TTY -- to the wrong half of the pipe.
  it("names stdout when stdout is the half that is not a TTY (`remove NAME --json | jq`)", async () => {
    const before = await seed();
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: {
          stdin: { isTTY: true } as unknown as NodeJS.ReadableStream,
          stdout: { isTTY: false, write: vi.fn() } as unknown as NodeJS.WritableStream,
        },
      },
      io,
    );
    expect(r.exitCode).toBe(2);
    expect(errText()).toContain("stdout is not a TTY");
    expect(errText()).not.toContain("stdin is not a TTY");
    expect(errText()).toContain("--force");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("names stdin when stdin is the half that is not a TTY (`echo x | remove NAME`)", async () => {
    const before = await seed();
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        home,
        io: {
          stdin: { isTTY: false } as unknown as NodeJS.ReadableStream,
          stdout: { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream,
        },
      },
      io,
    );
    expect(r.exitCode).toBe(2);
    expect(errText()).toContain("stdin is not a TTY");
    expect(errText()).not.toContain("stdout is not a TTY");
    expect(errText()).toContain("--force");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("non-TTY with --force deletes", async () => {
    await seed();
    const r = await runSecrets(
      { action: "remove", name: "TOKEN", passphrase: CONFIRM_PASS, force: true, home, io: nonTTYIo() },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(outText()).toContain('Removed "TOKEN"');
    lock();

    io.out.mockReset();
    const listed = await runSecrets({ action: "list", home, json: true }, io);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(outText()).keys).toEqual([]);
  });

  // --force's headline behavior is "skip the interactive confirm", and the
  // only place that is observable is a TTY -- the non-TTY tests above pass
  // whether or not the prompt is actually skipped, because there is no
  // prompt to skip. Mirrors the set-side "--force skips the overwrite prompt
  // on a TTY" test.
  it("--force skips the confirmation prompt on a TTY (nothing is asked, and it still deletes)", async () => {
    await seed();
    // Empty queue: if the gate tried to prompt, the read would never settle
    // and this test would time out instead of passing.
    const stdin = new FakeTTYStdin([]);
    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: CONFIRM_PASS,
        force: true,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(promptText()).toBe("");
    expect(outText()).toContain('Removed "TOKEN"');
    lock();

    io.out.mockReset();
    const listed = await runSecrets({ action: "list", home, json: true }, io);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(outText()).keys).toEqual([]);
  });

  it("--force skips the confirmation but NOT the passphrase", async () => {
    const before = await seed();
    // No passphrase hook, no env var, no TTY to prompt on: --force must not
    // turn into a free pass at the vault.
    const r = await runSecrets({ action: "remove", name: "TOKEN", force: true, home, io: nonTTYIo() }, io);
    expect(r.exitCode).toBe(1);
    expect(errText().toLowerCase()).toMatch(/passphrase required/);
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("a missing name still reports not-found, never the --force refusal", async () => {
    await seed();
    const r = await runSecrets({ action: "remove", name: "NOPE", passphrase: CONFIRM_PASS, home, io: nonTTYIo() }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain('No secret named "NOPE"');
    expect(errText()).not.toContain("--force");
  });
});

describe("runSecrets set -- overwrite confirmation and Replaced/Stored split", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  let home: string;

  const outText = (): string => io.out.mock.calls.map((c) => c[0] as string).join("");
  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");
  const promptText = (): string =>
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string).join("");

  async function seed(): Promise<string> {
    const r = await runSecrets(
      { action: "set", name: "TOKEN", value: "old-value", passphrase: CONFIRM_PASS, home },
      io,
    );
    expect(r.exitCode).toBe(0);
    lock();
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();
    return readFileSync(vaultPath(home), "utf8");
  }

  async function readBack(): Promise<string | undefined> {
    lock();
    const probe = { out: vi.fn(), err: vi.fn() };
    const r = await runSecrets({ action: "get", name: "TOKEN", passphrase: CONFIRM_PASS, home, json: true }, probe);
    if (r.exitCode !== 0) return undefined;
    const line = probe.out.mock.calls.map((c) => c[0] as string).find((s) => s.trim().startsWith("{"));
    return line ? (JSON.parse(line).value as string) : undefined;
  }

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  it("TTY + bare Enter leaves the existing value in place", async () => {
    const before = await seed();
    const stdin = new FakeTTYStdin(["\r"]);
    const r = await runSecrets(
      {
        action: "set",
        name: "TOKEN",
        value: "new-value",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText().toLowerCase()).toContain("aborted");
    expect(promptText().toLowerCase()).toContain("already exists");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
    expect(await readBack()).toBe("old-value");
  });

  // Same gap as the remove side: bare Enter alone does not pin the y/yes
  // check, so a typed no is asserted here too. Both gates share promptYesNo,
  // and a regression there overwrites a credential the user just declined to
  // replace.
  it.each(["n", "no"])('TTY + explicit "%s" leaves the existing value in place', async (answer) => {
    const before = await seed();
    const stdin = new FakeTTYStdin([`${answer}\r`]);
    const r = await runSecrets(
      {
        action: "set",
        name: "TOKEN",
        value: "new-value",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("Aborted.");
    expect(promptText().toLowerCase()).toContain("already exists");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
    expect(await readBack()).toBe("old-value");
  });

  it("TTY + explicit y replaces the value and says Replaced, not Stored", async () => {
    await seed();
    const stdin = new FakeTTYStdin(["y\r"]);
    const r = await runSecrets(
      {
        action: "set",
        name: "TOKEN",
        value: "new-value",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(outText()).toContain('Replaced secret "TOKEN".');
    expect(outText()).not.toContain("Stored secret");
    expect(await readBack()).toBe("new-value");
  });

  it("non-TTY overwrite PROCEEDS without --force (credential rotation must stay scriptable)", async () => {
    await seed();
    const r = await runSecrets(
      { action: "set", name: "TOKEN", value: "rotated", passphrase: CONFIRM_PASS, home, io: nonTTYIo() },
      io,
    );
    expect(r.exitCode).toBe(0);
    // ...but the message must NOT look like a fresh write.
    expect(outText()).toContain('Replaced secret "TOKEN".');
    expect(outText()).not.toContain("Stored secret");
    expect(await readBack()).toBe("rotated");
  });

  it("a fresh name still says Stored, and --json carries replaced:false", async () => {
    const r = await runSecrets(
      { action: "set", name: "FRESH", value: "v", passphrase: CONFIRM_PASS, home, json: true, io: nonTTYIo() },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(outText()).replaced).toBe(false);

    io.out.mockReset();
    lock();
    const again = await runSecrets(
      { action: "set", name: "FRESH", value: "v2", passphrase: CONFIRM_PASS, home, json: true, io: nonTTYIo() },
      io,
    );
    expect(again.exitCode).toBe(0);
    expect(JSON.parse(outText()).replaced).toBe(true);
  });

  it("--force skips the overwrite prompt on a TTY (nothing is asked)", async () => {
    await seed();
    // Empty queue: if the gate tried to prompt, the read would never settle
    // and this test would time out instead of passing.
    const stdin = new FakeTTYStdin([]);
    const r = await runSecrets(
      {
        action: "set",
        name: "TOKEN",
        value: "forced",
        passphrase: CONFIRM_PASS,
        force: true,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(promptText()).toBe("");
    expect(await readBack()).toBe("forced");
  });

  it("prompts for the VALUE with a value label, not a second passphrase label", async () => {
    // The value prompt used to print "Secret value: Vault passphrase: " --
    // the label was written by the caller AND by the reader.
    const stdin = new FakeTTYStdin(["typed-value\r"]);
    const r = await runSecrets(
      {
        action: "set",
        name: "FRESH",
        passphrase: CONFIRM_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(promptText()).toContain("Secret value: ");
    expect(promptText()).not.toContain("Vault passphrase: ");
  });
});

// -----------------------------------------------------------------------
// runSecrets rotate -- the worst data-loss shape in the product.
//
// rotate re-encrypts EVERY entry under a new passphrase, so a partial
// failure could leave the vault half-rewritten: some entries readable only
// under the old passphrase, some only under the new, and no way for the
// user to tell which. secrets-vault.rotateVault is written decrypt-ALL-
// before-write for exactly that reason, and runSecretsRotate only reaches
// saveVault on the all-succeeded path.
//
// Every abort test below asserts the vault file's BYTES are unchanged, not
// just that the command exited non-zero -- "returned an error" and "left
// your secrets intact" are different claims and only the second matters.
// The bytes are read straight from disk before and after.
// -----------------------------------------------------------------------

const ROT_PASS = "rotate-current-xyz";
const ROT_NEW = "rotate-brand-new-xyz";

describe("runSecrets rotate -- abort paths leave the vault byte-identical", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  let home: string;

  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");
  const promptText = (): string =>
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string).join("");

  /** Seed a multi-entry vault under ROT_PASS. Multi-entry matters: a
   *  one-entry vault cannot show a HALF-rotated file. */
  async function seedMulti(): Promise<string> {
    for (const [name, value] of [
      ["ALPHA", "alpha-value"],
      ["BETA", "beta-value"],
      ["GAMMA", "gamma-value"],
    ]) {
      const r = await runSecrets({ action: "set", name, value, passphrase: ROT_PASS, home }, io);
      expect(r.exitCode).toBe(0);
    }
    lock();
    io.out.mockReset();
    io.err.mockReset();
    return readFileSync(vaultPath(home), "utf8");
  }

  /** Read one secret back with a fresh derivation. Returns undefined when
   *  the read failed (wrong passphrase, corrupt entry, missing name). */
  async function readBack(name: string, passphrase: string): Promise<string | undefined> {
    lock();
    const probe = { out: vi.fn(), err: vi.fn() };
    const r = await runSecrets({ action: "get", name, passphrase, home, json: true }, probe);
    if (r.exitCode !== 0) return undefined;
    const line = probe.out.mock.calls.map((c) => c[0] as string).find((s) => s.trim().startsWith("{"));
    return line ? (JSON.parse(line).value as string) : undefined;
  }

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    delete process.env.YAW_MCP_VAULT_PASSPHRASE_NEW;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    delete process.env.YAW_MCP_VAULT_PASSPHRASE_NEW;
    lock();
  });

  it("ONE undecryptable entry aborts the whole rotation -- vault byte-identical, siblings still readable", async () => {
    // The headline case. BETA is corrupted so that it is still STRUCTURALLY
    // valid (loadVault only checks iv/ciphertext/authTag are strings) but
    // fails AES-GCM authentication. rotateVault decrypts in insertion order,
    // so ALPHA succeeds and BETA throws -- i.e. the abort happens with
    // plaintext already in hand, which is precisely the moment a naive
    // implementation would have started writing.
    await seedMulti();
    const path = vaultPath(home);
    const vault = JSON.parse(readFileSync(path, "utf8")) as VaultFile;
    (vault.entries.BETA as EncryptedEntry).ciphertext = Buffer.from("tampered-ciphertext").toString("base64");
    writeFileSync(path, `${JSON.stringify(vault, null, 2)}\n`, "utf8");
    const before = readFileSync(path, "utf8");
    lock();

    const r = await runSecrets({ action: "rotate", passphrase: ROT_PASS, newPassphrase: ROT_NEW, home }, io);

    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("rotate aborted");
    // The message must name the entry -- it is the only way the user can
    // find and remove the one bad record.
    expect(errText()).toContain("BETA");
    // THE assertion: not one byte of the vault changed.
    expect(readFileSync(path, "utf8")).toBe(before);
    // The stale old-passphrase key must not stay cached after the failure.
    expect(isUnlocked()).toBe(false);

    // Byte-identical is necessary but not sufficient -- prove the untouched
    // bytes are still real ciphertext under the ORIGINAL passphrase.
    expect(await readBack("ALPHA", ROT_PASS)).toBe("alpha-value");
    expect(await readBack("GAMMA", ROT_PASS)).toBe("gamma-value");
    // ...and that the new passphrase was never established.
    expect(await readBack("ALPHA", ROT_NEW)).toBeUndefined();
  });

  it("a wrong CURRENT passphrase aborts before any decrypt -- vault byte-identical, all entries still readable", async () => {
    const before = await seedMulti();

    const r = await runSecrets(
      { action: "rotate", passphrase: "not-the-passphrase", newPassphrase: ROT_NEW, home },
      io,
    );

    expect(r.exitCode).toBe(1);
    expect(errText().toLowerCase()).toMatch(/wrong passphrase|decryption failed/);
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
    expect(isUnlocked()).toBe(false);

    for (const [name, value] of [
      ["ALPHA", "alpha-value"],
      ["BETA", "beta-value"],
      ["GAMMA", "gamma-value"],
    ]) {
      expect(await readBack(name, ROT_PASS)).toBe(value);
    }
  });

  it("--json keeps the abort machine-readable (one ok:false line on stderr) and still writes nothing", async () => {
    const before = await seedMulti();

    const r = await runSecrets(
      { action: "rotate", passphrase: "not-the-passphrase", newPassphrase: ROT_NEW, home, json: true },
      io,
    );

    expect(r.exitCode).toBe(1);
    const line = io.err.mock.calls.map((c) => c[0] as string).find((s) => s.trim().startsWith("{"));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line as string);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
    // No prose leaked onto stderr alongside the JSON.
    expect(errText()).not.toContain("yaw-mcp secrets rotate:");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("a corrupt vault fails rotate through the same named-entry envelope the sibling actions use", async () => {
    // loadVault throws on a malformed entry; safeLoadVault has to translate
    // that into a rotate-labelled, actionable message rather than letting
    // the rejection escape to the dispatcher.
    const path = vaultPath(home);
    const salt = Buffer.alloc(16, 7).toString("base64");
    const raw = `${JSON.stringify({ version: 1, salt, entries: { WRECKED: { iv: "x" } } }, null, 2)}\n`;
    writeFileSync(path, raw, "utf8");

    const r = await runSecrets({ action: "rotate", passphrase: ROT_PASS, newPassphrase: ROT_NEW, home }, io);

    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("rotate");
    expect(errText()).toContain("WRECKED");
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("a damaged check marker is reported as a corrupt token with the vault path, NOT a wrong passphrase", async () => {
    // A structurally-valid but undecryptable `check` survives loadVault
    // (which only type-checks the three string fields). Condemning the
    // PASSPHRASE on that made every secrets command fail forever on a vault
    // whose entries were all intact, with nothing naming the real culprit.
    const before = await seedMulti();
    const path = vaultPath(home);
    const onDisk = JSON.parse(before) as VaultFile;
    onDisk.check = {
      ...(onDisk.check as EncryptedEntry),
      ciphertext: Buffer.from("tampered-check-marker").toString("base64"),
    };
    writeFileSync(path, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");
    lock();

    const r = await runSecrets({ action: "get", name: "ALPHA", passphrase: ROT_PASS, home }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain('verification token ("check") is corrupt');
    // The vault module cannot name the file, so the CLI attaches the path.
    expect(errText()).toContain(path);
    expect(errText().toLowerCase()).not.toContain("wrong passphrase");

    // A genuinely wrong passphrase against the same damaged vault still
    // reads as a wrong passphrase -- the two cases stay distinguishable.
    lock();
    io.err.mockReset();
    const bad = await runSecrets({ action: "get", name: "ALPHA", passphrase: "not-the-passphrase", home }, io);
    expect(bad.exitCode).toBe(1);
    expect(errText().toLowerCase()).toContain("wrong passphrase");
  });

  it("refuses when no CURRENT passphrase can be obtained (non-TTY, no env) -- vault untouched", async () => {
    const before = await seedMulti();
    const r = await runSecrets({ action: "rotate", newPassphrase: ROT_NEW, home, io: nonTTYIo() }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("Current passphrase required");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("refuses when no NEW passphrase can be obtained (non-TTY, no env) -- vault untouched", async () => {
    // The current passphrase is correct and the vault is fully decryptable;
    // the only thing missing is the new passphrase. Nothing may be written.
    const before = await seedMulti();
    const r = await runSecrets({ action: "rotate", passphrase: ROT_PASS, home, io: nonTTYIo() }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("New passphrase required");
    expect(errText()).toContain("YAW_MCP_VAULT_PASSPHRASE_NEW");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it('an EMPTY new passphrase ("") is treated as "none supplied", never as a key of length zero', async () => {
    const before = await seedMulti();
    const r = await runSecrets({ action: "rotate", passphrase: ROT_PASS, newPassphrase: "", home, io: nonTTYIo() }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toContain("New passphrase required");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("^C at the CURRENT passphrase prompt exits 130 and leaves the vault alone", async () => {
    const before = await seedMulti();
    const ETX = String.fromCharCode(3);
    const stdin = new FakeTTYStdin([ETX]);
    const r = await runSecrets(
      {
        action: "rotate",
        newPassphrase: ROT_NEW,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(130);
    expect(errText().toLowerCase()).toContain("cancelled");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
  });

  it("^C at the NEW passphrase prompt exits 130 -- the vault is already unlocked, and still untouched", async () => {
    // This one gets further than any other abort: the current passphrase is
    // verified and the old key is in hand. Cancelling here must still not
    // write, and must not fall through to a "" new passphrase.
    const before = await seedMulti();
    const ETX = String.fromCharCode(3);
    const stdin = new FakeTTYStdin(["a-fine-new-passphrase\r", ETX]);
    const r = await runSecrets(
      {
        action: "rotate",
        passphrase: ROT_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(130);
    expect(promptText()).toContain("Confirm new passphrase: ");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
    expect(await readBack("ALPHA", ROT_PASS)).toBe("alpha-value");
  });

  it("three disagreeing new-passphrase confirmations exhaust the budget and write nothing", async () => {
    const before = await seedMulti();
    const stdin = new FakeTTYStdin(["new-aaa\r", "new-bbb\r", "new-aaa\r", "new-bbb\r", "new-aaa\r", "new-bbb\r"]);
    const r = await runSecrets(
      {
        action: "rotate",
        passphrase: ROT_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    expect(promptText()).toContain("did not match");
    expect(errText()).toContain("New passphrase required");
    expect(readFileSync(vaultPath(home), "utf8")).toBe(before);
    // A typo'd rotation must not have re-keyed anything.
    expect(await readBack("ALPHA", ROT_PASS)).toBe("alpha-value");
  });

  it("an empty new-passphrase entry re-prompts, and a matching pair on the retry rotates", async () => {
    // Covers the "Passphrase cannot be empty." arm of resolveNewPassphrase,
    // which is distinct from the mismatch arm above.
    await seedMulti();
    const stdin = new FakeTTYStdin(["\r", "retry-new-passphrase\r", "retry-new-passphrase\r"]);
    const r = await runSecrets(
      {
        action: "rotate",
        passphrase: ROT_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(promptText()).toContain("Passphrase cannot be empty.");
    expect(await readBack("ALPHA", "retry-new-passphrase")).toBe("alpha-value");
  });
});

describe("runSecrets rotate -- the success path re-keys EVERY entry", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  let home: string;

  const outText = (): string => io.out.mock.calls.map((c) => c[0] as string).join("");

  async function readBack(name: string, passphrase: string): Promise<string | undefined> {
    lock();
    const probe = { out: vi.fn(), err: vi.fn() };
    const r = await runSecrets({ action: "get", name, passphrase, home, json: true }, probe);
    if (r.exitCode !== 0) return undefined;
    const line = probe.out.mock.calls.map((c) => c[0] as string).find((s) => s.trim().startsWith("{"));
    return line ? (JSON.parse(line).value as string) : undefined;
  }

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    delete process.env.YAW_MCP_VAULT_PASSPHRASE_NEW;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    delete process.env.YAW_MCP_VAULT_PASSPHRASE_NEW;
    lock();
  });

  const SEEDS: Array<[string, string]> = [
    ["ALPHA", "alpha-value"],
    ["BETA", "beta-value"],
    ["GAMMA", "gamma-value"],
  ];

  it("every value survives under the NEW passphrase, none reads under the old, and salt+check+ciphertexts all change", async () => {
    for (const [name, value] of SEEDS) {
      expect((await runSecrets({ action: "set", name, value, passphrase: ROT_PASS, home }, io)).exitCode).toBe(0);
    }
    lock();
    const before = JSON.parse(readFileSync(vaultPath(home), "utf8")) as VaultFile;
    io.out.mockReset();

    const r = await runSecrets({ action: "rotate", passphrase: ROT_PASS, newPassphrase: ROT_NEW, home }, io);
    expect(r.exitCode).toBe(0);
    expect(outText()).toContain("Rotated 3 secrets");
    // rotate drops the derived key, so the very next command re-prompts.
    expect(outText()).toContain("Vault locked");
    expect(isUnlocked()).toBe(false);

    const after = JSON.parse(readFileSync(vaultPath(home), "utf8")) as VaultFile;
    // A fresh salt is the whole point -- reusing it would leave the old
    // derived key valid against the rewritten file.
    expect(after.salt).not.toBe(before.salt);
    expect(after.check).toBeDefined();
    expect(after.check?.ciphertext).not.toBe(before.check?.ciphertext);
    // No entry may be carried over verbatim, and none may go missing.
    expect(Object.keys(after.entries).sort()).toEqual(["ALPHA", "BETA", "GAMMA"]);
    for (const [name] of SEEDS) {
      expect(after.entries[name].ciphertext).not.toBe(before.entries[name].ciphertext);
      expect(after.entries[name].iv).not.toBe(before.entries[name].iv);
    }

    // EVERY value -- not just the first -- is readable under the new
    // passphrase with its original plaintext intact.
    for (const [name, value] of SEEDS) {
      expect(await readBack(name, ROT_NEW)).toBe(value);
    }
    // ...and the old passphrase is dead for all of them.
    for (const [name] of SEEDS) {
      expect(await readBack(name, ROT_PASS)).toBeUndefined();
    }
  });

  it("says `1 secret` (singular) for a one-entry vault", async () => {
    await runSecrets({ action: "set", name: "ONLY", value: "v", passphrase: ROT_PASS, home }, io);
    lock();
    io.out.mockReset();
    const r = await runSecrets({ action: "rotate", passphrase: ROT_PASS, newPassphrase: ROT_NEW, home }, io);
    expect(r.exitCode).toBe(0);
    expect(outText()).toContain("Rotated 1 secret under a new passphrase");
    expect(outText()).not.toContain("1 secrets");
  });

  it("--json reports the rotated count instead of prose", async () => {
    for (const [name, value] of SEEDS) {
      await runSecrets({ action: "set", name, value, passphrase: ROT_PASS, home }, io);
    }
    lock();
    io.out.mockReset();
    const r = await runSecrets(
      { action: "rotate", passphrase: ROT_PASS, newPassphrase: ROT_NEW, home, json: true },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(outText())).toEqual({ ok: true, rotated: true, secret_count: 3 });
    expect(outText()).not.toContain("Vault locked");
  });

  it("takes the NEW passphrase from YAW_MCP_VAULT_PASSPHRASE_NEW, warning when it is too short", async () => {
    // The env path is the scripted-rotation path, and it is single-shot --
    // there is no confirm entry to catch a typo, so the length warning is
    // the only feedback a CI rotation gets.
    await runSecrets({ action: "set", name: "ONLY", value: "v", passphrase: ROT_PASS, home }, io);
    lock();
    process.env.YAW_MCP_VAULT_PASSPHRASE_NEW = "tiny";

    const r = await runSecrets({ action: "rotate", passphrase: ROT_PASS, home, io: nonTTYIo() }, io);
    expect(r.exitCode).toBe(0);

    const warned = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(warned).toContain("the new passphrase is shorter than 12 characters");
    // The rotation still happened -- the warning is advisory, not a block.
    expect(await readBack("ONLY", "tiny")).toBe("v");
  });
});

// -----------------------------------------------------------------------
// runSecrets audit -- the render/filter arms the existing suite skips.
//
// The existing coverage reads the trail with --json only, so the human
// render loop (and its injected/missing column) was never executed, and
// --secret was never used as a filter.
// -----------------------------------------------------------------------

describe("runSecrets audit -- human render, filters, and read failure", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  let home: string;

  const outText = (): string => io.out.mock.calls.map((c) => c[0] as string).join("");
  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");

  async function seedTrail(): Promise<void> {
    const { appendAuditEvent } = await import("../secrets-audit.js");
    await appendAuditEvent({ server: "github", secret: "GH_TOKEN", event: "injected" }, home);
    await appendAuditEvent({ server: "aws", secret: "AWS_KEY", event: "missing" }, home);
    await appendAuditEvent({ server: "github", secret: "AWS_KEY", event: "injected" }, home);
  }

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("renders one line per event with the injected/missing column, and never a value", async () => {
    await seedTrail();
    const r = await runSecrets({ action: "audit", home }, io);
    expect(r.exitCode).toBe(0);

    const lines = outText().trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    // `injected` and `missing ` are padded to the same width so the server
    // and secret columns line up; both arms of the ternary are exercised.
    expect(lines[0]).toMatch(/^\S+ {2}injected {2}github {2}GH_TOKEN$/);
    // "missing " carries a trailing pad space so it occupies the same
    // column width as "injected" -- hence three spaces before the server.
    expect(lines[1]).toMatch(/^\S+ {2}missing {3}aws {2}AWS_KEY$/);
    expect(lines[2]).toMatch(/^\S+ {2}injected {2}github {2}AWS_KEY$/);
    // The log records names only; nothing that could be a value.
    expect(outText()).not.toContain("ghp_");
  });

  it("--secret filters to one secret NAME across servers", async () => {
    await seedTrail();
    const r = await runSecrets({ action: "audit", secretFilter: "AWS_KEY", home, json: true }, io);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(outText());
    expect(parsed.count).toBe(2);
    expect(parsed.events.map((e: { server: string }) => e.server)).toEqual(["aws", "github"]);
  });

  it("--secret and --server compose (AND, not OR)", async () => {
    await seedTrail();
    const r = await runSecrets(
      { action: "audit", secretFilter: "AWS_KEY", serverFilter: "github", home, json: true },
      io,
    );
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(outText());
    expect(parsed.count).toBe(1);
    expect(parsed.events[0]).toMatchObject({ server: "github", secret: "AWS_KEY", event: "injected" });
  });

  it("a filter that matches nothing is an empty result, not an error", async () => {
    await seedTrail();
    const r = await runSecrets({ action: "audit", serverFilter: "nope", home, json: true }, io);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(outText())).toMatchObject({ ok: true, count: 0, events: [] });
  });

  it("--json on an empty trail still emits the ok:true envelope (not the prose line)", async () => {
    const r = await runSecrets({ action: "audit", home, json: true }, io);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(outText())).toMatchObject({ ok: true, count: 0, events: [] });
    expect(outText()).not.toContain("No secret-resolution audit");
  });

  it("surfaces an unreadable audit log as exit 1, naming the path and errno -- not as an empty trail", async () => {
    // A DIRECTORY at the log path makes the read fail with EISDIR, the
    // "exists but unreadable" shape (EACCES and EIO are the same class).
    // readAuditLog used to swallow that and return [], so `secrets audit`
    // told the operator "no events recorded yet" about a trail sitting right
    // there, and this catch arm was reachable only by mocking readAuditLog
    // to throw. Through the real module now.
    const { auditLogPath } = await import("../secrets-audit.js");
    mkdirSync(auditLogPath(home), { recursive: true });

    const r1 = await runSecrets({ action: "audit", home }, io);
    expect(r1.exitCode).toBe(1);
    expect(errText()).toContain("yaw-mcp secrets audit: could not read the audit log");
    expect(errText()).toContain(auditLogPath(home));
    expect(errText()).toContain("EISDIR");
    // The empty-trail line is exactly the lie this exists to stop.
    expect(outText()).not.toContain("No secret-resolution audit events");

    io.err.mockReset();
    const r2 = await runSecrets({ action: "audit", home, json: true }, io);
    expect(r2.exitCode).toBe(1);
    const parsed = JSON.parse(errText());
    expect(parsed).toMatchObject({ ok: false });
    expect(parsed.error).toContain("could not read the audit log");
    expect(parsed.error).toContain("EISDIR");
  });
});

// -----------------------------------------------------------------------
// Concurrent-writer guard: every mutating action blocks on unbounded
// interactive pauses between its vault load and its save. The fingerprint
// re-check (vaultChangedSinceLoad) must refuse the save when the file on
// disk moved during the pause -- mirroring trust-cmd's "a prompt is an
// unbounded pause" re-read-and-refuse -- instead of silently reverting the
// concurrent write with the stale in-memory snapshot.
// -----------------------------------------------------------------------

describe("runSecrets -- concurrent-writer guard", () => {
  let home: string;

  beforeEach(() => {
    lock();
    // Both env passphrases: the rotate test below drives the NEW passphrase
    // through the TTY fixture, and a leaked YAW_MCP_VAULT_PASSPHRASE_NEW
    // would bypass that prompt (and the concurrent write it injects).
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    delete process.env.YAW_MCP_VAULT_PASSPHRASE_NEW;
    home = makeHome();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    delete process.env.YAW_MCP_VAULT_PASSPHRASE_NEW;
    lock();
  });

  it("set refuses to save when the vault changed while waiting for the value", async () => {
    // Seed a vault the normal way.
    const seedIo = { out: vi.fn(), err: vi.fn() };
    const seeded = await runSecrets(
      { action: "set", name: "FIRST", value: "one", passphrase: "a-long-passphrase", home },
      seedIo,
    );
    expect(seeded.exitCode).toBe(0);
    const file = vaultPath(home);
    const seededBytes = readFileSync(file);

    // The second set reads its value from a piped stdin whose iterator --
    // before yielding -- rewrites the vault file, standing in for a
    // concurrent `secrets set` / `rotate` in another terminal landing
    // during the pause. Appending a byte keeps the JSON valid; ANY byte
    // change must trip the guard.
    let mutatedBytes: Buffer | null = null;
    const rewritingStdin = {
      isTTY: false,
      setEncoding(): void {},
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        writeFileSync(file, `${seededBytes.toString("utf8")}\n`);
        mutatedBytes = readFileSync(file);
        yield "two\n";
      },
    };

    const io = { out: vi.fn(), err: vi.fn() };
    const r = await runSecrets(
      {
        action: "set",
        name: "SECOND",
        fromStdin: true,
        passphrase: "a-long-passphrase",
        home,
        io: {
          stdin: rewritingStdin as unknown as NodeJS.ReadableStream,
          stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        },
      },
      io,
    );

    expect(r.exitCode).toBe(1);
    const errOutput = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(errOutput).toMatch(/changed on disk/);
    // Nothing was written over the concurrent change.
    expect(mutatedBytes).not.toBeNull();
    expect(readFileSync(file)).toEqual(mutatedBytes);
  });

  it("set still saves normally when nothing touched the vault during the pause", async () => {
    const io = { out: vi.fn(), err: vi.fn() };
    const quietStdin = {
      isTTY: false,
      setEncoding(): void {},
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        yield "value-two\n";
      },
    };
    const seeded = await runSecrets(
      { action: "set", name: "FIRST", value: "one", passphrase: "a-long-passphrase", home },
      io,
    );
    expect(seeded.exitCode).toBe(0);
    const r = await runSecrets(
      {
        action: "set",
        name: "SECOND",
        fromStdin: true,
        passphrase: "a-long-passphrase",
        home,
        io: {
          stdin: quietStdin as unknown as NodeJS.ReadableStream,
          stdout: { write: vi.fn() } as unknown as NodeJS.WritableStream,
        },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(vaultPath(home), "utf8")).entries.SECOND).toBeDefined();
  });

  // The remove and rotate sites carry their own re-check; each is driven
  // through its OWN prompt so dropping either site's guard fails a test.
  // The concurrent write is injected from the TTY fixture's resume(),
  // which the raw-mode reader calls at the start of every prompt -- i.e.
  // the write lands exactly inside the pause the guard exists for.

  it("remove refuses to save when the vault changed while waiting for the confirmation", async () => {
    const io = { out: vi.fn(), err: vi.fn() };
    const seeded = await runSecrets(
      { action: "set", name: "TOKEN", value: "one", passphrase: "a-long-passphrase", home },
      io,
    );
    expect(seeded.exitCode).toBe(0);
    const file = vaultPath(home);
    const seededBytes = readFileSync(file);

    let mutatedBytes: Buffer | null = null;
    const stdin = new FakeTTYStdin(["y\r"]);
    const deliver = stdin.resume.bind(stdin);
    stdin.resume = () => {
      if (mutatedBytes === null) {
        writeFileSync(file, `${seededBytes.toString("utf8")}\n`);
        mutatedBytes = readFileSync(file);
      }
      return deliver();
    };
    const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;

    const r = await runSecrets(
      {
        action: "remove",
        name: "TOKEN",
        passphrase: "a-long-passphrase",
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    const errOutput = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(errOutput).toMatch(/changed on disk/);
    expect(mutatedBytes).not.toBeNull();
    expect(readFileSync(file)).toEqual(mutatedBytes);
    // The entry the user asked to delete is still there.
    expect(JSON.parse(readFileSync(file, "utf8")).entries.TOKEN).toBeDefined();
  });

  it("rotate refuses to save when a concurrent rotate landed while waiting for the new passphrase", async () => {
    // The strongest scenario: the concurrent writer is a REAL rotate to a
    // third passphrase, so the salt on disk changes under the pending
    // rotation. Saving the stale rotation would revert the concurrent one
    // and silently un-do a passphrase change its user was told succeeded.
    const OLD = "old-passphrase-xyz";
    const PENDING_NEW = "pending-new-passphrase";
    const CONCURRENT_NEW = "concurrent-new-passphrase";
    const io = { out: vi.fn(), err: vi.fn() };
    const seeded = await runSecrets({ action: "set", name: "TOKEN", value: "one", passphrase: OLD, home }, io);
    expect(seeded.exitCode).toBe(0);
    lock();
    const file = vaultPath(home);

    // Holder object (not a `let`): TS narrows a `let x: Buffer | null = null`
    // to `null` and ignores the closure assignments below.
    const concurrent: { bytes: Buffer | null; started: boolean } = { bytes: null, started: false };
    // The new passphrase is prompted (confirm-twice) on the TTY; the
    // concurrent rotate runs to completion before the first prompt's chunk
    // is delivered.
    const stdin = new FakeTTYStdin([`${PENDING_NEW}\r`, `${PENDING_NEW}\r`]);
    const deliver = stdin.resume.bind(stdin);
    stdin.resume = () => {
      if (!concurrent.started) {
        concurrent.started = true; // latch before the await so a re-entrant resume() cannot re-run it
        // The concurrent rotate is done with the vault PRIMITIVES rather than
        // a nested runSecrets: a second CLI run in the SAME process would
        // lock() the module-level key cache out from under the outer command
        // -- a shape that cannot occur in production (every CLI run is its
        // own process). unlock() hands out COPIES now, so the outer key would
        // in fact survive, but the fixture should not lean on that.
        void (async () => {
          const onDisk = await loadVault(file);
          if (!onDisk) throw new Error("fixture: vault vanished");
          const key = await unlock(onDisk, OLD);
          await saveVault(file, await rotateVault(onDisk, key, CONCURRENT_NEW));
          concurrent.bytes = readFileSync(file);
          deliver();
        })();
        return stdin;
      }
      return deliver();
    };
    const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;

    const r = await runSecrets(
      {
        action: "rotate",
        passphrase: OLD,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    const errOutput = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(errOutput).toMatch(/changed on disk/);
    expect(concurrent.bytes).not.toBeNull();
    expect(concurrent.bytes?.length).toBeGreaterThan(0);
    expect(readFileSync(file)).toEqual(concurrent.bytes);

    // The vault on disk is the CONCURRENT rotation: its passphrase reads,
    // the pending one (never saved) and the old one do not.
    lock();
    const okIo = { out: vi.fn(), err: vi.fn() };
    const ok = await runSecrets({ action: "get", name: "TOKEN", passphrase: CONCURRENT_NEW, home, json: true }, okIo);
    expect(ok.exitCode).toBe(0);
    lock();
    const stale = await runSecrets(
      { action: "get", name: "TOKEN", passphrase: PENDING_NEW, home, json: true },
      { out: vi.fn(), err: vi.fn() },
    );
    expect(stale.exitCode).toBe(1);
    lock();
    const old = await runSecrets(
      { action: "get", name: "TOKEN", passphrase: OLD, home, json: true },
      { out: vi.fn(), err: vi.fn() },
    );
    expect(old.exitCode).toBe(1);
  });

  // A DIRECTORY at the vault path makes the baseline read fail (EISDIR),
  // standing in for the transient EACCES/EBUSY class. NOTE on what this
  // pins: with a directory, loadVault itself also fails, so even before the
  // fail-fast existed no prompt was reached -- the pre-fix run surfaced
  // loadVault's raw errno via safeLoadVault. The wasted-prompts shape needs
  // a file that is unreadable for the baseline read but readable a moment
  // later, which no fixture can stage deterministically. What IS pinned:
  // the fail-fast fires (its own message, not safeLoadVault's), at BOTH
  // sites, and it names the errno the way get/list do for the same state.
  it.each([
    "set",
    "rotate",
  ] as const)("%s fails fast, naming the errno, when the vault file exists but cannot be read", async (action) => {
    const file = vaultPath(home);
    mkdirSync(file, { recursive: true });
    const io = { out: vi.fn(), err: vi.fn() };
    const r = await runSecrets(
      action === "set"
        ? { action, name: "TOKEN", value: "one", passphrase: "a-long-passphrase", home, json: true }
        : { action, passphrase: "a-long-passphrase", newPassphrase: "another-long-passphrase", home, json: true },
      io,
    );
    expect(r.exitCode).toBe(1);
    const errOutput = io.err.mock.calls.map((c) => c[0] as string).join("");
    const parsed = JSON.parse(errOutput.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/could not read the vault file/);
    expect(parsed.error).toMatch(/EISDIR/);
  });
});

// -----------------------------------------------------------------------
// The value prompt needs BOTH ends of the terminal.
//
// `yaw-mcp secrets set GH > out.json` has a TTY stdin and a redirected
// stdout. Gating the prompt on stdin alone wrote "Secret value: " into the
// redirect target, put the terminal into raw no-echo mode, and then waited
// on a prompt the user could not see.
// -----------------------------------------------------------------------

describe("runSecrets set -- the value prompt refuses a redirected stdout", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  let home: string;

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  it("refuses (naming --value / --stdin) instead of prompting into the redirect", async () => {
    // stdin has a value queued: without the stdout check the command happily
    // reads it, stores the secret and exits 0 -- having written the prompt
    // into the file the user was redirecting into.
    const stdin = new FakeTTYStdin(["typed-value\n"]);
    const stdout = { isTTY: false, write: vi.fn() } as unknown as NodeJS.WritableStream;
    const r = await runSecrets(
      {
        action: "set",
        name: "GH",
        passphrase: "a-long-passphrase",
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    const errOutput = io.err.mock.calls.map((c) => c[0] as string).join("");
    expect(errOutput).toMatch(/cannot prompt for the value/);
    expect(errOutput).toMatch(/--value/);
    expect(errOutput).toMatch(/--stdin/);
    // Nothing was written, and no prompt leaked into the redirected stream.
    expect(existsSync(vaultPath(home))).toBe(false);
    const promptText = (stdout.write as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string)
      .join("");
    expect(promptText).not.toContain("Secret value:");
  });

  it("still prompts when both ends are a TTY", async () => {
    const stdin = new FakeTTYStdin(["typed-value\n"]);
    const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
    const r = await runSecrets(
      {
        action: "set",
        name: "GH",
        passphrase: "a-long-passphrase",
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
  });

  it("still reads piped stdin when stdout is redirected (the scripted path)", async () => {
    // Not a TTY at either end: this is `echo v | yaw-mcp secrets set GH > f`,
    // which must keep working.
    const { Readable } = await import("node:stream");
    const stdin = Readable.from(["piped-value\n"]) as unknown as NodeJS.ReadableStream;
    (stdin as { isTTY?: boolean }).isTTY = false;
    const stdout = { isTTY: false, write: vi.fn() } as unknown as NodeJS.WritableStream;
    const r = await runSecrets(
      { action: "set", name: "GH", passphrase: "a-long-passphrase", home, io: { stdin, stdout } },
      io,
    );
    expect(r.exitCode).toBe(0);
  });
});

// -----------------------------------------------------------------------
// Key sequences at the NO-ECHO prompts. The raw-mode reader used to drop the
// ESC byte alone and buffer the rest of an arrow key ("[D") as typed text.
// At the echoed [y/N] prompt that was harmless noise; at "Secret value:" and
// the passphrase prompts nothing is echoed, so the corruption was invisible:
// a Left arrow to fix a typo in a pasted token stored `ghp_abc[D` behind a
// green "Stored secret", and the server later failed auth with nothing
// pointing at the vault.
// -----------------------------------------------------------------------

describe("readLineFromTTY -- key sequences never reach a no-echo prompt's value", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const stdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  const ESC = String.fromCharCode(27);
  const KEYS_PASS = "a-long-passphrase";
  let home: string;

  /** Store GH through the interactive "Secret value:" prompt fed by `stdin`
   *  (the passphrase is injected, so that is the only prompt), then read it
   *  back with a fresh derivation. undefined when either step failed. */
  async function storeViaPrompt(stdin: FakeTTYStdin): Promise<string | undefined> {
    const r = await runSecrets(
      {
        action: "set",
        name: "GH",
        passphrase: KEYS_PASS,
        home,
        io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout },
      },
      io,
    );
    if (r.exitCode !== 0) return undefined;
    lock();
    const probe = { out: vi.fn(), err: vi.fn() };
    const got = await runSecrets({ action: "get", name: "GH", passphrase: KEYS_PASS, home, json: true }, probe);
    if (got.exitCode !== 0) return undefined;
    const line = probe.out.mock.calls.map((c) => c[0] as string).find((s) => s.trim().startsWith("{"));
    return line ? (JSON.parse(line).value as string) : undefined;
  }

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    (stdout.write as unknown as ReturnType<typeof vi.fn>).mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  it("a CSI arrow key inside the value is dropped whole, never stored as [D", async () => {
    // Left arrow is ESC "[" "D". The reader is not a line editor (there is
    // no cursor to move), so the honest behavior is to drop the key -- and
    // above all never to store its printable tail as part of the secret.
    expect(await storeViaPrompt(new FakeTTYStdin([`ghp_a${ESC}[Dbc\r`]))).toBe("ghp_abc");
  });

  it("an SS3 arrow (ESC O A) is dropped too", async () => {
    // Application-cursor mode sends ESC "O" <final> for the same keys.
    expect(await storeViaPrompt(new FakeTTYStdin([`ghp${ESC}OA_abc\r`]))).toBe("ghp_abc");
  });

  it("a lone Escape key followed by Enter still submits what was typed", async () => {
    // ESC followed by a control byte is not a sequence: Enter has to keep
    // meaning Enter, or the user's submit silently vanishes.
    expect(await storeViaPrompt(new FakeTTYStdin([`ghp_abc${ESC}\r`]))).toBe("ghp_abc");
  });

  it("a lone Escape key followed by an ordinary character keeps the character", async () => {
    // Only the sequence bytes are the terminal's; the keystroke after a bare
    // ESC (a reflexive Escape, or the meta prefix of an Alt chord) is the
    // user's and must not be eaten -- the echoed [y/N] prompt pins the same
    // rule for "ESC y".
    expect(await storeViaPrompt(new FakeTTYStdin([`ghp_${ESC}abc\r`]))).toBe("ghp_abc");
  });

  it("a sequence split across two stdin chunks is still dropped whole", async () => {
    // A terminal can deliver the ESC in one read and "[D" in the next. The
    // parser state has to survive the chunk boundary, or the tail lands in
    // the value. FakeTTYStdin hands out one chunk per prompt; this override
    // delivers BOTH queued chunks to the single value prompt, in order.
    const stdin = new FakeTTYStdin([`ghp_abc${ESC}`, `[D\r`]);
    const deliver = stdin.resume.bind(stdin);
    stdin.resume = () => {
      deliver();
      return deliver();
    };
    expect(await storeViaPrompt(stdin)).toBe("ghp_abc");
  });

  it("the passphrase prompt gets the same treatment", async () => {
    // Seed off-TTY, then unlock through the TTY prompt with a Left arrow in
    // the middle of the typed passphrase. Buffered as "[D" it would be a
    // WRONG passphrase -- and the user, seeing no echo, would never know why.
    const seeded = await runSecrets({ action: "set", name: "GH", value: "ghp_abc", passphrase: KEYS_PASS, home }, io);
    expect(seeded.exitCode).toBe(0);
    lock();
    io.out.mockReset();
    const stdin = new FakeTTYStdin([`a-long-pass${ESC}[Dphrase\r`]);
    const r = await runSecrets(
      { action: "get", name: "GH", home, json: true, io: { stdin: stdin as unknown as NodeJS.ReadableStream, stdout } },
      io,
    );
    expect(r.exitCode).toBe(0);
    const line = io.out.mock.calls.map((c) => c[0] as string).find((s) => s.trim().startsWith("{"));
    expect(line && JSON.parse(line).value).toBe("ghp_abc");
  });
});

// -----------------------------------------------------------------------
// The corrupt-entry hint is derived from the ERROR TYPE, not from a regex
// over its message: an entry name holding a newline defeats /(.+)$/ and used
// to drop the only actionable half of the message.
// -----------------------------------------------------------------------

describe("runSecrets -- corrupt-entry hint survives an awkward entry name", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  let home: string;

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  it("still names the entry and how to delete it when the name contains a newline", async () => {
    const badName = `BAD${String.fromCharCode(10)}NAME`;
    const corrupt = {
      version: 1,
      salt: Buffer.alloc(16, 7).toString("base64"),
      entries: { [badName]: { iv: "x", ciphertext: 123, authTag: "y" } },
    };
    writeFileSync(vaultPath(home), `${JSON.stringify(corrupt)}\n`);
    const r = await runSecrets({ action: "list", home, json: true }, io);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(
      io.err.mock.calls
        .map((c) => c[0] as string)
        .join("")
        .trim(),
    );
    expect(parsed.error).toContain("is corrupt, and every secrets command fails");
    expect(parsed.error).toContain(badName);
    expect(parsed.error).toContain(vaultPath(home));
  });
});

// -----------------------------------------------------------------------
// runSecrets set -- the fresh-vault nudge.
//
// Storing a secret and USING one happen in different processes: `set` runs
// in the user's shell, the ${secret:NAME} substitution runs inside the
// yaw-mcp the MCP client spawns. Nothing on a SUCCESS path used to connect
// the two, so a user could store a secret, see "Stored secret", and have
// every server that references it refuse to start. The nudge fires once,
// on vault CREATION, and says where the passphrase actually has to live.
// -----------------------------------------------------------------------

describe("runSecrets set -- the fresh-vault nudge", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  let home: string;
  let savedEnv: string | undefined;

  const outText = (): string => io.out.mock.calls.map((c) => c[0] as string).join("");
  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");

  beforeEach(() => {
    io.out.mockReset();
    io.err.mockReset();
    home = makeHome();
    savedEnv = process.env.YAW_MCP_VAULT_PASSPHRASE;
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    else process.env.YAW_MCP_VAULT_PASSPHRASE = savedEnv;
    rmSync(home, { recursive: true, force: true });
  });

  it("fires on vault creation and names the env var, the client environment, and doctor", async () => {
    const r = await runSecrets(
      { action: "set", name: "tailscale", value: "tskey-abc", passphrase: "correct-horse-battery", home },
      io,
    );
    expect(r.exitCode).toBe(0);
    // stdout is unchanged -- the nudge must not disturb the scripted signal.
    expect(outText()).toBe('Created vault and Stored secret "tailscale".\n');

    const err = errText();
    expect(err).toContain("YAW_MCP_VAULT_PASSPHRASE");
    // The whole point: the passphrase has to reach the CLIENT's process,
    // not merely the shell that ran `set`.
    expect(err).toContain("MCP client launches");
    expect(err).toContain("${secret:NAME}");
    expect(err).toContain("yaw-mcp doctor");
    // The vault path, so the user can see what was just created and where.
    expect(err).toContain(nodePath.join(home, ".yaw-mcp", "secrets.json"));
  });

  it("does NOT fire on a later set into an existing vault", async () => {
    const first = await runSecrets(
      { action: "set", name: "tailscale", value: "tskey-abc", passphrase: "correct-horse-battery", home },
      io,
    );
    expect(first.exitCode).toBe(0);
    expect(errText()).not.toBe("");

    io.out.mockReset();
    io.err.mockReset();

    const second = await runSecrets(
      { action: "set", name: "github", value: "ghp_xyz", passphrase: "correct-horse-battery", home },
      io,
    );
    expect(second.exitCode).toBe(0);
    expect(outText()).toBe('Stored secret "github".\n');
    // Once per vault. A nudge on every `set` is noise a scripted caller
    // cannot turn off.
    expect(errText()).toBe("");
  });

  it("tells a user who already exported the var that the client env is a separate one", async () => {
    process.env.YAW_MCP_VAULT_PASSPHRASE = "correct-horse-battery";
    const r = await runSecrets({ action: "set", name: "tailscale", value: "tskey-abc", home }, io);
    expect(r.exitCode).toBe(0);

    const err = errText();
    expect(err).toContain("set in THIS shell");
    expect(err).toContain("its own environment");
    // The other branch's copy must not leak into this one: telling someone
    // who HAS set the var to "set YAW_MCP_VAULT_PASSPHRASE" reads as a
    // failure and sends them to re-do what they already did.
    expect(err).not.toContain("needs this passphrase");
  });

  it("never prints the passphrase value on either stream", async () => {
    const secretish = "hunter2-hunter2-hunter2";
    process.env.YAW_MCP_VAULT_PASSPHRASE = secretish;
    const r = await runSecrets({ action: "set", name: "tailscale", value: "tskey-abc", home }, io);
    expect(r.exitCode).toBe(0);
    // Anchor the negatives to a nudge that ACTUALLY fired: "the output does
    // not contain the passphrase" is trivially true of no output at all, so
    // without this line the test still passes with the feature deleted.
    expect(errText()).toContain("set in THIS shell");
    // CLI output gets pasted into bug reports. The nudge reports only
    // WHETHER the var is set.
    expect(errText()).not.toContain(secretish);
    expect(outText()).not.toContain(secretish);
  });

  it("keeps --json stdout a single parseable envelope, with the nudge on stderr", async () => {
    const r = await runSecrets(
      { action: "set", name: "tailscale", value: "tskey-abc", passphrase: "correct-horse-battery", home, json: true },
      io,
    );
    expect(r.exitCode).toBe(0);
    // One line, still valid JSON -- a nudge written to stdout would break
    // every `| jq` consumer.
    expect(JSON.parse(outText())).toMatchObject({ ok: true, name: "tailscale", fresh_vault: true });
    expect(errText()).toContain("YAW_MCP_VAULT_PASSPHRASE");
  });
});

// -----------------------------------------------------------------------
// The human-facing arms (no --json), plus the two `get` side channels.
//
// Every list invocation elsewhere in this suite passes --json, and `lock`
// is only ever called as the imported helper -- so the prose branches
// shipped unexecuted: the three `list` lines, lock's confirmation, the
// empty-value refusal, the cleartext-on-a-TTY warning, and the per-entry
// decrypt-failure hint. Each is what a human actually sees.
// -----------------------------------------------------------------------

describe("runSecrets -- the prose arms and the get side channels", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const ttyStdout = { isTTY: true, write: vi.fn() } as unknown as NodeJS.WritableStream;
  const pipedStdout = { isTTY: false, write: vi.fn() } as unknown as NodeJS.WritableStream;
  const idleStdin = { isTTY: false } as unknown as NodeJS.ReadableStream;
  let home: string;

  const PROSE_PASS = "a-long-enough-passphrase";
  const outText = (): string => io.out.mock.calls.map((c) => c[0] as string).join("");
  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");
  // The warnings ride the same `err` callback as every error envelope --
  // there is no separate stderr stream for an embedder to forget to wire.
  const warned = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");

  /** Seed two entries, then corrupt BAD's ciphertext so it is still
   *  STRUCTURALLY valid (loadVault only checks the three fields are strings)
   *  but fails AES-GCM authentication. The vault check stamp is untouched, so
   *  unlock() succeeds and only this one entry throws -- the shape an older
   *  build's differently-keyed entry leaves behind. */
  async function seedWithOneUndecryptableEntry(): Promise<void> {
    for (const [name, value] of [
      ["GOOD", "good-value"],
      ["BAD", "bad-value"],
    ]) {
      const r = await runSecrets({ action: "set", name, value, passphrase: PROSE_PASS, home }, io);
      expect(r.exitCode).toBe(0);
    }
    const file = vaultPath(home);
    const vault = JSON.parse(readFileSync(file, "utf8")) as VaultFile;
    (vault.entries.BAD as EncryptedEntry).ciphertext = Buffer.from("tampered-ciphertext").toString("base64");
    writeFileSync(file, `${JSON.stringify(vault, null, 2)}\n`, "utf8");
    lock();
    io.out.mockReset();
    io.err.mockReset();
  }

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  // `lock` can only clear the cache of the process it runs in, which from
  // the CLI is about to exit anyway. Its output used to read as a revocation
  // ("Vault locked.") and its --json envelope was a bare {locked:true}; both
  // now say what was NOT touched, so neither a human nor a script can take
  // the no-op for a cut-off of a running server.
  it("lock says it cleared THIS process's cache only, and really drops the key", async () => {
    // Seed first so there IS a cached key to clear -- against an already
    // locked process the assertion would pass for a `lock` that does nothing.
    const seeded = await runSecrets({ action: "set", name: "GH", value: "ghp_abc", passphrase: PROSE_PASS, home }, io);
    expect(seeded.exitCode).toBe(0);
    expect(isUnlocked()).toBe(true);
    io.out.mockReset();

    const r = await runSecrets({ action: "lock", home }, io);
    expect(r.exitCode).toBe(0);
    expect(outText()).toBe(
      "Passphrase cache cleared for this process only. A running yaw-mcp server keeps its own cached key until it exits, and the vault on disk is unchanged.\n",
    );
    expect(outText()).not.toContain("Vault locked");
    expect(isUnlocked()).toBe(false);
  });

  it("lock --json spells out the scope instead of a bare locked:true", async () => {
    const r = await runSecrets({ action: "lock", home, json: true }, io);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(outText())).toEqual({
      ok: true,
      locked: true,
      scope: "this-process",
      running_servers_affected: false,
      vault_changed: false,
    });
    expect(outText()).not.toContain("Passphrase cache cleared");
  });

  it("list says NO VAULT, naming the command that creates one", async () => {
    const r = await runSecrets({ action: "list", home }, io);
    expect(r.exitCode).toBe(0);
    expect(outText()).toBe(`No vault at ${vaultPath(home)}. Run \`yaw-mcp secrets set <name>\` to create one.\n`);
  });

  it("list distinguishes an EMPTY vault from an absent one", async () => {
    // Absent and empty are different states with different remedies, so the
    // two lines must never collapse into one.
    writeFileSync(
      vaultPath(home),
      `${JSON.stringify({ version: 1, salt: Buffer.alloc(16, 7).toString("base64"), entries: {} })}\n`,
      "utf8",
    );
    const r = await runSecrets({ action: "list", home }, io);
    expect(r.exitCode).toBe(0);
    expect(outText()).toBe(`Vault at ${vaultPath(home)} is empty.\n`);
  });

  it("list prints one indented name per entry, sorted, and no values", async () => {
    for (const [name, value] of [
      ["ZULU", "z-value"],
      ["ALPHA", "a-value"],
    ]) {
      expect((await runSecrets({ action: "set", name, value, passphrase: PROSE_PASS, home }, io)).exitCode).toBe(0);
    }
    io.out.mockReset();

    const r = await runSecrets({ action: "list", home }, io);
    expect(r.exitCode).toBe(0);
    // Insertion order was ZULU then ALPHA -- listKeys sorts.
    expect(outText()).toBe(`Vault at ${vaultPath(home)}\n  ALPHA\n  ZULU\n`);
    expect(outText()).not.toContain("z-value");
    expect(outText()).not.toContain("a-value");
  });

  it("set refuses an empty value in prose, writing no vault", async () => {
    const r = await runSecrets({ action: "set", name: "GH", value: "", passphrase: PROSE_PASS, home }, io);
    expect(r.exitCode).toBe(1);
    expect(errText()).toBe("yaw-mcp secrets: Secret value cannot be empty.\n");
    expect(outText()).toBe("");
    // An empty value must not create the vault (nor its nudge) as a side effect.
    expect(existsSync(vaultPath(home))).toBe(false);
  });

  it("set refuses an empty value as a JSON envelope too", async () => {
    const r = await runSecrets({ action: "set", name: "GH", value: "", passphrase: PROSE_PASS, home, json: true }, io);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(errText())).toEqual({ ok: false, error: "Secret value cannot be empty." });
    expect(outText()).toBe("");
    expect(existsSync(vaultPath(home))).toBe(false);
  });

  it("get warns on stderr that it just printed cleartext when stdout is a TTY", async () => {
    const seeded = await runSecrets({ action: "set", name: "GH", value: "ghp_abc", passphrase: PROSE_PASS, home }, io);
    expect(seeded.exitCode).toBe(0);
    lock();
    io.out.mockReset();
    io.err.mockReset();

    const r = await runSecrets(
      { action: "get", name: "GH", passphrase: PROSE_PASS, home, io: { stdin: idleStdin, stdout: ttyStdout } },
      io,
    );
    expect(r.exitCode).toBe(0);
    // The value itself is unchanged on stdout -- the warning is a side
    // channel, never mixed into the pipeable output.
    expect(outText()).toBe("ghp_abc\n");
    expect(warned()).toContain('printing "GH" in cleartext');
    expect(warned()).toContain("scrollback");
    // ...and the warning never repeats the value it is warning about.
    expect(warned()).not.toContain("ghp_abc");
  });

  it("get stays quiet when stdout is piped -- the intended consumption path", async () => {
    const seeded = await runSecrets({ action: "set", name: "GH", value: "ghp_abc", passphrase: PROSE_PASS, home }, io);
    expect(seeded.exitCode).toBe(0);
    lock();
    io.out.mockReset();
    io.err.mockReset();

    const r = await runSecrets(
      {
        action: "get",
        name: "GH",
        passphrase: PROSE_PASS,
        home,
        io: { stdin: idleStdin, stdout: pipedStdout },
      },
      io,
    );
    expect(r.exitCode).toBe(0);
    expect(outText()).toBe("ghp_abc\n");
    // `yaw-mcp secrets get GH > token` is the documented path; warning there
    // would put noise on every scripted read.
    expect(warned()).toBe("");
  });

  it("get names the entry and the fix when ONE entry fails to decrypt", async () => {
    await seedWithOneUndecryptableEntry();

    const r = await runSecrets(
      {
        action: "get",
        name: "BAD",
        passphrase: PROSE_PASS,
        home,
        io: { stdin: idleStdin, stdout: pipedStdout },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    // unlock() already verified the passphrase against the check stamp, so
    // "wrong passphrase" would be the wrong diagnosis here.
    expect(errText()).toContain('Entry "BAD" failed to decrypt');
    expect(errText()).toContain("written under a different passphrase");
    expect(errText()).toContain("Remove it and set it again.");
    expect(outText()).toBe("");

    // The sibling entry still reads: this is a per-ENTRY failure, not a
    // vault-wide one, which is exactly what the hint tells the user.
    lock();
    io.out.mockReset();
    const good = await runSecrets(
      {
        action: "get",
        name: "GOOD",
        passphrase: PROSE_PASS,
        home,
        io: { stdin: idleStdin, stdout: pipedStdout },
      },
      io,
    );
    expect(good.exitCode).toBe(0);
    expect(outText()).toBe("good-value\n");
  });

  it("get carries the decrypt hint in its own --json field", async () => {
    await seedWithOneUndecryptableEntry();

    const r = await runSecrets(
      {
        action: "get",
        name: "BAD",
        passphrase: PROSE_PASS,
        home,
        json: true,
        io: { stdin: idleStdin, stdout: pipedStdout },
      },
      io,
    );
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(errText());
    expect(parsed.ok).toBe(false);
    // `error` stays the raw crypto failure; the actionable half is its own
    // field so a --json consumer can surface it without parsing prose.
    expect(typeof parsed.error).toBe("string");
    expect(parsed.hint).toContain('Entry "BAD" failed to decrypt');
    expect(parsed.hint).toContain("Remove it and set it again.");
    expect(outText()).toBe("");
  });
});

// -----------------------------------------------------------------------
// A vault written under schema v1 stays v1 forever: setSecret spreads the
// vault it was given, and only rotate stamps the current version. The v2
// name binding therefore never engages for a pre-v2 vault (a blob swapped
// between two entries still decrypts), and until now no surface said so.
// -----------------------------------------------------------------------

describe("runSecrets -- a schema-v1 vault is reported once per command, and only rotate upgrades it", () => {
  const io = { out: vi.fn(), err: vi.fn() };
  const V1_PASS = "legacy-passphrase-xyz";
  let home: string;

  const outText = (): string => io.out.mock.calls.map((c) => c[0] as string).join("");
  const errText = (): string => io.err.mock.calls.map((c) => c[0] as string).join("");
  const onDiskVersion = (): number => JSON.parse(readFileSync(vaultPath(home), "utf8")).version as number;

  /** A vault exactly as a pre-v2 build wrote it: version 1, no kdf, no
   *  check marker, and an entry encrypted WITHOUT the name binding. Built by
   *  hand because no code path produces one any more. */
  async function writeV1Vault(): Promise<void> {
    const salt = generateSalt();
    const key = await deriveKey(V1_PASS, salt, LEGACY_KDF);
    const legacy = { version: 1, salt: salt.toString("base64"), entries: { GH: encryptEntry("ghp_legacy", key) } };
    writeFileSync(vaultPath(home), `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
  }

  beforeEach(async () => {
    io.out.mockReset();
    io.err.mockReset();
    lock();
    delete process.env.YAW_MCP_VAULT_PASSPHRASE;
    home = makeHome();
    await mkdir(nodePath.join(home, ".yaw-mcp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    lock();
  });

  it("list, get and set each say the vault is behind and name rotate as the upgrade", async () => {
    await writeV1Vault();
    for (const opts of [
      { action: "list" as const },
      { action: "get" as const, name: "GH", passphrase: V1_PASS },
      { action: "set" as const, name: "NEW", value: "v", passphrase: V1_PASS },
    ]) {
      io.err.mockReset();
      lock();
      const r = await runSecrets({ ...opts, home }, io);
      expect(r.exitCode, opts.action).toBe(0);
      expect(errText(), opts.action).toContain("schema v1");
      expect(errText(), opts.action).toContain("yaw-mcp secrets rotate");
    }
    // ...and `set` really did leave the file at v1: the notice is the ONLY
    // thing that changed, which is exactly why it has to be printed.
    expect(onDiskVersion()).toBe(1);
  });

  it("keeps --json stdout a single envelope with the notice on stderr as its own JSON line", async () => {
    await writeV1Vault();
    const r = await runSecrets({ action: "list", home, json: true }, io);
    expect(r.exitCode).toBe(0);
    // One parseable line on stdout; the notice must never land there.
    expect(JSON.parse(outText())).toMatchObject({ ok: true, vault: true, keys: ["GH"] });
    // ...and under --json the notice is JSON too, not prose: the error
    // envelopes share this stream, so a wrapper parses it line by line.
    expect(JSON.parse(errText())).toEqual({
      ok: true,
      warning: "schema-behind",
      schema: 1,
      current: SECRETS_SCHEMA_VERSION,
      upgrade: "yaw-mcp secrets rotate",
      path: vaultPath(home),
    });
  });

  it("under --json a FAILING command on a v1 vault leaves stderr parseable line by line", async () => {
    // The notice fires on every command that loads the vault, and every
    // error envelope goes to stderr under --json. A prose notice ahead of the
    // `{"ok":false,...}` envelope broke every wrapper that JSON.parses the
    // stream -- for every failing list/get/set/remove, on every pre-v2 vault.
    await writeV1Vault();
    const r = await runSecrets({ action: "get", name: "NOPE", home, json: true }, io);
    expect(r.exitCode).toBe(1);
    expect(outText()).toBe("");
    const lines = errText()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    // First the warning about the FILE, then the envelope for the COMMAND.
    expect(parsed[0]).toMatchObject({ ok: true, warning: "schema-behind", schema: 1, current: SECRETS_SCHEMA_VERSION });
    expect(parsed[1]).toMatchObject({ ok: false, error: 'No secret named "NOPE" in the vault.' });
  });

  it("rotate rewrites the file at the current schema without nagging, and the notice stops", async () => {
    await writeV1Vault();
    const r = await runSecrets(
      { action: "rotate", passphrase: V1_PASS, newPassphrase: "rotated-passphrase-xyz", home },
      io,
    );
    expect(r.exitCode).toBe(0);
    // rotate IS the upgrade -- telling the user to run it from inside it
    // would be noise.
    expect(errText()).not.toContain("schema v1");
    expect(onDiskVersion()).toBe(SECRETS_SCHEMA_VERSION);

    io.err.mockReset();
    lock();
    const listed = await runSecrets({ action: "list", home }, io);
    expect(listed.exitCode).toBe(0);
    expect(errText()).toBe("");
  });

  it("stays silent for a vault already at the current schema", async () => {
    const seeded = await runSecrets({ action: "set", name: "GH", value: "ghp_abc", passphrase: V1_PASS, home }, io);
    expect(seeded.exitCode).toBe(0);
    expect(onDiskVersion()).toBe(SECRETS_SCHEMA_VERSION);
    io.err.mockReset();
    lock();
    const r = await runSecrets({ action: "list", home }, io);
    expect(r.exitCode).toBe(0);
    expect(errText()).toBe("");
  });
});
