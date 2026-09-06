import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KDF,
  decryptEntry,
  deriveKey,
  type EncryptedEntry,
  encryptEntry,
  generateSalt,
  KEY_LEN,
  LEGACY_KDF,
} from "../secrets-crypto.js";
import {
  collectMalformedSecretRefs,
  getSecret,
  hasSecretRefs,
  listKeys,
  loadVault,
  lock,
  MALFORMED_REF_MARKER,
  MALFORMED_REF_MAX_CHARS,
  newVault,
  removeSecret,
  resolveSecretRefs,
  rotateVault,
  SECRET_NAME_RE,
  SECRET_REF_RE,
  SECRETS_SCHEMA_VERSION,
  saveVault,
  setSecret,
  unlock,
  VAULT_CHECK_AAD,
  VAULT_CHECK_CORRUPT_ERROR,
  VAULT_CHECK_PLAINTEXT,
  VaultEntryCorruptError,
  type VaultFile,
  vaultPath,
} from "../secrets-vault.js";

let synthHome: string;

beforeEach(() => {
  synthHome = mkdtempSync(join(tmpdir(), "yaw-mcp-secrets-"));
  lock();
});

afterEach(() => {
  rmSync(synthHome, { recursive: true, force: true });
  lock();
  vi.restoreAllMocks();
});

describe("secrets-crypto", () => {
  it("derives the same key from the same passphrase + salt", async () => {
    const salt = generateSalt();
    const k1 = await deriveKey("hunter2", salt);
    const k2 = await deriveKey("hunter2", salt);
    expect(k1.equals(k2)).toBe(true);
  });

  it("derives different keys for different passphrases", async () => {
    const salt = generateSalt();
    const k1 = await deriveKey("hunter2", salt);
    const k2 = await deriveKey("hunter3", salt);
    expect(k1.equals(k2)).toBe(false);
  });

  it("derives different keys for different salts", async () => {
    const k1 = await deriveKey("hunter2", generateSalt());
    const k2 = await deriveKey("hunter2", generateSalt());
    expect(k1.equals(k2)).toBe(false);
  });

  it("round-trips encrypt/decrypt", async () => {
    const key = await deriveKey("hunter2", generateSalt());
    const entry = encryptEntry("hello world", key);
    expect(decryptEntry(entry, key)).toBe("hello world");
  });

  it("decrypt fails with wrong key", async () => {
    const salt = generateSalt();
    const k1 = await deriveKey("hunter2", salt);
    const k2 = await deriveKey("hunter3", salt);
    const entry = encryptEntry("secret", k1);
    expect(() => decryptEntry(entry, k2)).toThrow();
  });

  it("decrypt fails on tampered ciphertext", async () => {
    const key = await deriveKey("hunter2", generateSalt());
    const entry = encryptEntry("secret", key);
    const tampered = { ...entry, ciphertext: Buffer.from("AAAA", "base64").toString("base64") };
    expect(() => decryptEntry(tampered, key)).toThrow();
  });

  it("decrypt fails on tampered auth tag", async () => {
    const key = await deriveKey("hunter2", generateSalt());
    const entry = encryptEntry("secret", key);
    const tampered = {
      ...entry,
      authTag: Buffer.from("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "base64").toString("base64"),
    };
    expect(() => decryptEntry(tampered, key)).toThrow();
  });

  it("decrypt refuses an IV or auth tag of the wrong LENGTH, by name", async () => {
    // loadVault only type-checks the three fields as strings, so a truncated
    // iv/authTag reaches decrypt intact. These two guards are what turn that
    // into a named error instead of whatever createDecipheriv/setAuthTag
    // happen to throw -- and neither had a test.
    const key = await deriveKey("hunter2", generateSalt());
    const entry = encryptEntry("secret", key);
    expect(() => decryptEntry({ ...entry, iv: Buffer.alloc(8).toString("base64") }, key)).toThrow(/invalid IV length/i);
    expect(() => decryptEntry({ ...entry, authTag: Buffer.alloc(8).toString("base64") }, key)).toThrow(
      /invalid auth tag length/i,
    );
  });
});

describe("secrets-vault: set/get/list/remove", () => {
  it("newVault has a salt and empty entries", () => {
    const v = newVault();
    expect(v.salt).toBeTruthy();
    expect(v.entries).toEqual({});
    expect(v.version).toBe(SECRETS_SCHEMA_VERSION);
    // The scrypt parameters are recorded in the file, not assumed by the
    // reader, so a later cost bump cannot orphan this vault.
    expect(v.kdf).toEqual(DEFAULT_KDF);
  });

  it("set + get round-trips a single secret", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc123");
    expect(listKeys(vault)).toEqual(["github"]);
    expect(getSecret(vault, key, "github")).toBe("ghp_abc123");
  });

  it("set multiple, list returns sorted names", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_1");
    vault = setSecret(vault, key, "aws", "aws_2");
    vault = setSecret(vault, key, "slack", "xoxb_3");
    expect(listKeys(vault)).toEqual(["aws", "github", "slack"]);
  });

  it("remove deletes an entry", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_1");
    vault = setSecret(vault, key, "aws", "aws_2");
    vault = removeSecret(vault, "github");
    expect(listKeys(vault)).toEqual(["aws"]);
    expect(getSecret(vault, key, "github")).toBeNull();
  });

  it("remove of nonexistent key is a no-op", () => {
    const v = newVault();
    expect(removeSecret(v, "nonesuch")).toEqual(v);
  });

  it("save + load round-trips the vault", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    const path = join(synthHome, ".yaw-mcp", "secrets.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    await saveVault(path, vault);
    lock();
    const loaded = await loadVault(path);
    expect(loaded).not.toBeNull();
    if (loaded) {
      const k2 = await unlock(loaded, "hunter2");
      expect(getSecret(loaded, k2, "github")).toBe("ghp_abc");
    }
  });

  it("saveVault asks for a 0o600 file inside a 0o700 .yaw-mcp/ that it creates itself", async () => {
    // Fresh home: neither the vault nor its parent .yaw-mcp/ exists, so this
    // save takes atomicWriteFile's create path -- the file born 0o600 and the
    // directory born 0o700. Every other save in this file pre-creates the
    // directory (contrary to saveVault's own MUST NOT note), which turns the
    // dirMode into a no-op and left the request itself unpinned. Mirrors
    // secrets-audit.test.ts: the MODES REQUESTED are this module's decision;
    // whether the filesystem honours POSIX bits is the OS's business (Windows
    // reports a synthetic 0o666), so statting the result proves nothing here.
    const atomic = await import("../atomic-write.js");
    const spy = vi.spyOn(atomic, "atomicWriteFile");
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    const path = vaultPath(synthHome);
    expect(existsSync(join(synthHome, ".yaw-mcp"))).toBe(false);

    await saveVault(path, vault);

    expect(existsSync(path)).toBe(true);
    const call = spy.mock.calls.find((c) => c[0] === path);
    expect(call, "saveVault did not go through atomicWriteFile").toBeDefined();
    expect(call?.[3]).toBe(0o600);
    expect(call?.[4]).toBe(0o700);
  });

  it("loadVault returns null when no file exists", async () => {
    const v = await loadVault(join(synthHome, "no-such-file.json"));
    expect(v).toBeNull();
  });

  it("unlock with wrong passphrase throws before caching the key", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    lock();
    // setSecret stamps vault.check, so a wrong passphrase is detected at
    // unlock time (no longer a silent bad-key derivation).
    await expect(unlock(vault, "hunter3")).rejects.toThrow(/wrong passphrase/i);
  });

  it("inherited Object.prototype members are not vault entries", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    // `"toString" in entries` is true for every JSON-parsed vault -- own-key
    // checks are what stop `secrets get toString` from finding an "entry".
    expect(getSecret(vault, key, "toString")).toBeNull();
    expect(removeSecret(vault, "constructor")).toBe(vault);
    const { resolved, missing } = resolveSecretRefs({ X: "${secret:toString}" }, vault, key);
    expect(resolved.X).toBe("${secret:toString}");
    expect(missing).toEqual(["toString"]);
  });

  it("unlock hands back the caller's OWN copy of the key, so lock() cannot zero it under them", async () => {
    // lock() zero-fills the module-cached Buffer in place. When unlock
    // returned that same object, a caller holding it across a lock() went on
    // encrypting under 32 zero bytes -- which encryptEntry accepts (it only
    // checks the length) -- and saved entries no passphrase could decrypt,
    // with a green exit code. Nothing shipped sequences things that way, but
    // it was a one-line refactor away (a lock() on a shutdown path, rotate's
    // lock() hoisted above its save).
    let vault = newVault();
    const first = await unlock(vault, "hunter2");
    vault = setSecret(vault, first, "github", "ghp_abc");
    // The cache-hit path must hand out a copy too, not the cached object.
    const second = await unlock(vault, "hunter2");
    expect(second).not.toBe(first);
    expect(second.equals(first)).toBe(true);
    expect(second).toHaveLength(KEY_LEN);

    lock();

    // Both copies survive the lock() intact and still work.
    expect(first.some((b) => b !== 0)).toBe(true);
    expect(second.equals(first)).toBe(true);
    expect(getSecret(vault, first, "github")).toBe("ghp_abc");
    // ...and a value written under a post-lock() copy reads back under a
    // fresh derivation -- the exact save that used to be unrecoverable.
    vault = setSecret(vault, second, "aws", "aws_xyz");
    const fresh = await unlock(vault, "hunter2");
    expect(getSecret(vault, fresh, "aws")).toBe("aws_xyz");
  });

  it("unlock rejects a wrong passphrase even when a key is already cached for this vault", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    // NOTE: no lock() here -- the key is still cached under this salt, which
    // is exactly the long-lived-process case. The cache hit must not hand
    // the key back for a passphrase that never unlocked this vault.
    await expect(unlock(vault, "hunter3")).rejects.toThrow(/wrong passphrase/i);
    // ...and the correct passphrase still resolves from cache.
    await expect(unlock(vault, "hunter2")).resolves.toBeInstanceOf(Buffer);
  });

  it("setSecret rejects a name no ${secret:NAME} reference could address", async () => {
    const vault = newVault();
    const key = await unlock(vault, "hunter2");
    for (const bad of ["has space", "a:b", "a{b}", "a/b", "a$b"]) {
      expect(() => setSecret(vault, key, bad, "v")).toThrow(/invalid secret name/i);
    }
    // The reference-safe character class is accepted.
    expect(listKeys(setSecret(vault, key, "GH_token.v2-1", "v"))).toEqual(["GH_token.v2-1"]);
  });

  it("setSecret stamps a vault.check verification token", async () => {
    let vault = newVault();
    expect(vault.check).toBeUndefined();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    expect(vault.check).toBeDefined();
    // The check decrypts to the fixed constant under the correct key.
    expect(decryptEntry(vault.check as EncryptedEntry, key, VAULT_CHECK_AAD)).toBe(VAULT_CHECK_PLAINTEXT);
  });

  it("unlock on a fresh/empty vault accepts any passphrase (nothing to verify)", async () => {
    const vault = newVault();
    // No entries, no check -- unlock cannot verify, so it must not throw.
    await expect(unlock(vault, "anything")).resolves.toBeInstanceOf(Buffer);
  });

  it("legacy vault (entries, no check) verifies via any-entry canary", async () => {
    // Build a vault, then strip its check to simulate a pre-check vault. ANY
    // entry that decrypts proves the key (the first-entry-corrupt case is
    // pinned further down); only an all-fail is a wrong passphrase.
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    const legacy = { version: vault.version, salt: vault.salt, entries: vault.entries };
    lock();
    // Correct passphrase: an entry decrypts -> resolves.
    await expect(unlock(legacy, "hunter2")).resolves.toBeInstanceOf(Buffer);
    lock();
    // Wrong passphrase: nothing decrypts -> throws.
    await expect(unlock(legacy, "hunter3")).rejects.toThrow(/wrong passphrase/i);
  });

  it("loadVault rejects a vault with a malformed entry", async () => {
    const path = join(synthHome, ".yaw-mcp", "secrets.json");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const corrupt = {
      version: 1,
      salt: generateSalt().toString("base64"),
      entries: { bad: { iv: "x", ciphertext: 123, authTag: "y" } },
    };
    writeFileSync(path, `${JSON.stringify(corrupt)}\n`);
    await expect(loadVault(path)).rejects.toThrow(/vault corrupt at entry bad/);
  });

  it("loadVault rejects a vault whose salt does not decode to SALT_LEN bytes", async () => {
    const path = join(synthHome, ".yaw-mcp", "secrets.json");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    // A string salt that decodes to 8 bytes, not 16 -- it would derive the
    // wrong key and fail every decrypt with an opaque auth-tag error.
    const badSalt = { version: 1, salt: Buffer.from("tooshort").toString("base64"), entries: {} };
    writeFileSync(path, `${JSON.stringify(badSalt)}\n`);
    await expect(loadVault(path)).rejects.toThrow(/corrupt: salt/);
  });

  it("loadVault rejects a NEWER schema version but still loads the current one", async () => {
    const path = join(synthHome, ".yaw-mcp", "secrets.json");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const salt = generateSalt().toString("base64");
    // A schema newer than this build understands is refused loudly.
    writeFileSync(path, `${JSON.stringify({ version: 99, salt, entries: {} })}\n`);
    await expect(loadVault(path)).rejects.toThrow(/newer/i);
    // Equal (current) version still loads -- forward reads stay compatible.
    // The CURRENT constant, not a literal 1: v1 is the migration tests'
    // business, and a literal silently stopped pinning the equal case the
    // moment the schema moved past it.
    writeFileSync(path, `${JSON.stringify({ version: SECRETS_SCHEMA_VERSION, salt, entries: {} })}\n`);
    await expect(loadVault(path)).resolves.not.toBeNull();
  });

  it("loadVault preserves a valid check field round-trip", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    const path = join(synthHome, ".yaw-mcp", "secrets.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    await saveVault(path, vault);
    lock();
    const loaded = await loadVault(path);
    expect(loaded?.check).toBeDefined();
    // Wrong passphrase against the loaded vault is rejected via check.
    await expect(unlock(loaded as VaultFile, "wrongpass")).rejects.toThrow(/wrong passphrase/i);
  });

  it("a damaged check marker is reported as a corrupt token, not a wrong passphrase", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    lock();
    // Flip the check ciphertext but keep the blob STRUCTURALLY valid (three
    // strings) -- exactly what survives loadVault. The entries are intact.
    const damaged: VaultFile = {
      ...vault,
      check: {
        ...(vault.check as EncryptedEntry),
        ciphertext: Buffer.from("tampered-check-marker").toString("base64"),
      },
    };
    // The right passphrase must NOT be condemned: an entry decrypts, so the
    // marker is the damaged thing and the error has to say so.
    await expect(unlock(damaged, "hunter2")).rejects.toThrow(VAULT_CHECK_CORRUPT_ERROR);
    lock();
    // A genuinely wrong passphrase against the same vault is still a wrong
    // passphrase -- nothing at all decrypts.
    await expect(unlock(damaged, "hunter3")).rejects.toThrow(/wrong passphrase/i);
  });

  it("a legacy vault whose FIRST entry is corrupt still unlocks on a later good one", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "aaa-first", "v1");
    vault = setSecret(vault, key, "zzz-second", "v2");
    lock();
    // No check (pre-check vault) AND the first entry is undecryptable. A
    // first-entry-only canary condemned the correct passphrase here.
    const legacy: VaultFile = {
      version: vault.version,
      salt: vault.salt,
      entries: {
        "aaa-first": {
          ...vault.entries["aaa-first"],
          ciphertext: Buffer.from("tampered").toString("base64"),
        },
        "zzz-second": vault.entries["zzz-second"],
      },
    };
    await expect(unlock(legacy, "hunter2")).resolves.toBeInstanceOf(Buffer);
    lock();
    // Only an ALL-fail is a wrong passphrase.
    await expect(unlock(legacy, "hunter3")).rejects.toThrow(/wrong passphrase/i);
  });

  it("vaultPath places secrets.json under ~/.yaw-mcp/", () => {
    expect(vaultPath("/home/jeff")).toMatch(/[/\\]\.yaw-mcp[/\\]secrets\.json$/);
  });
});

describe("SECRET_REF_RE is exported and matches ${secret:NAME}", () => {
  it("captures the name", () => {
    // NOT a fresh regex: matchAll seeds its internal clone FROM this shared
    // object's lastIndex, so it resets nothing. Nothing above advances it, so
    // it is still 0 here -- the real callers re-instantiate rather than lean
    // on that (see doctor-cmd.ts, meta-tools.ts, upstream.ts).
    const m = [...`x ${"${secret:gh}"} y`.matchAll(SECRET_REF_RE)];
    expect(m[0][1]).toBe("gh");
  });

  it("agrees with SECRET_NAME_RE on every name: storable iff referenceable", () => {
    // The two used to be separate literals kept in sync by hand. A class
    // that widened in one and not the other would let a name be STORED that
    // no reference could ever address, or the reverse; building both from
    // one SECRET_NAME_CLASS is what this pins.
    const opener = "${secret:";
    for (const name of [
      "gh",
      "GH_token.v2-1",
      "__proto__",
      "a",
      "",
      "has space",
      "a:b",
      "a{b}",
      "a/b",
      "a$b",
      "x\ny",
    ]) {
      const storable = SECRET_NAME_RE.test(name);
      const ref = `${opener}${name}}`;
      const m = [...ref.matchAll(new RegExp(SECRET_REF_RE.source, SECRET_REF_RE.flags))];
      const referenceable = m.length === 1 && m[0][0] === ref && m[0][1] === name;
      expect(referenceable, JSON.stringify(name)).toBe(storable);
    }
  });
});

describe("rotateVault", () => {
  it("re-encrypts every entry: old passphrase fails post-rotate, new one decrypts", async () => {
    let vault = newVault();
    const oldKey = await unlock(vault, "old-passphrase");
    vault = setSecret(vault, oldKey, "github", "ghp_abc");
    vault = setSecret(vault, oldKey, "aws", "aws_xyz");
    const oldSalt = vault.salt;

    // Sanity: old key decrypts pre-rotate.
    expect(getSecret(vault, oldKey, "github")).toBe("ghp_abc");

    const rotated = await rotateVault(vault, oldKey, "new-passphrase");

    // Salt changed -> fresh derivation lineage.
    expect(rotated.salt).not.toBe(oldSalt);
    expect(listKeys(rotated)).toEqual(["aws", "github"]);
    expect(rotated.check).toBeDefined();

    // The OLD key must NOT decrypt the rotated entries.
    expect(() => getSecret(rotated, oldKey, "github")).toThrow();

    // The NEW passphrase decrypts post-rotate, values intact.
    lock();
    const newKey = await unlock(rotated, "new-passphrase");
    expect(getSecret(rotated, newKey, "github")).toBe("ghp_abc");
    expect(getSecret(rotated, newKey, "aws")).toBe("aws_xyz");

    // The new check marker verifies under the new key, and a wrong
    // passphrase is rejected at unlock.
    expect(decryptEntry(rotated.check as EncryptedEntry, newKey, VAULT_CHECK_AAD)).toBe(VAULT_CHECK_PLAINTEXT);
    lock();
    await expect(unlock(rotated, "old-passphrase")).rejects.toThrow(/wrong passphrase/i);
  });

  it("aborts when an entry fails to decrypt, leaving the input vault untouched", async () => {
    let vault = newVault();
    const oldKey = await unlock(vault, "old-passphrase");
    vault = setSecret(vault, oldKey, "github", "ghp_abc");

    // Corrupt one entry's ciphertext so decrypt-all fails.
    const corrupted: VaultFile = {
      ...vault,
      entries: {
        ...vault.entries,
        github: { ...vault.entries.github, ciphertext: Buffer.from("tampered").toString("base64") },
      },
    };
    const snapshot = JSON.stringify(corrupted);

    await expect(rotateVault(corrupted, oldKey, "new-passphrase")).rejects.toThrow(/failed to decrypt/i);
    // The input vault object is not mutated by the abort.
    expect(JSON.stringify(corrupted)).toBe(snapshot);
  });

  it("aborts when the current key is wrong (check marker fails), nothing re-encrypted", async () => {
    let vault = newVault();
    const oldKey = await unlock(vault, "old-passphrase");
    vault = setSecret(vault, oldKey, "github", "ghp_abc");
    const snapshot = JSON.stringify(vault);

    // Derive a DIFFERENT key (wrong passphrase) against the same salt.
    const wrongKey = await deriveKey("not-the-passphrase", Buffer.from(vault.salt, "base64"));
    await expect(rotateVault(vault, wrongKey, "new-passphrase")).rejects.toThrow(/current passphrase is wrong/i);
    expect(JSON.stringify(vault)).toBe(snapshot);
  });

  it("does not lose an entry literally named __proto__", async () => {
    // SECRET_NAME_RE allows it, and set/get/list/save/load all keep it as an
    // own property -- but rebuilding the rotated entries with `entries[name]
    // = ...` assigns through Object.prototype's inherited __proto__ setter,
    // creating no own key. The secret then vanishes from the file rotate
    // atomically overwrites, with no backup and no error.
    //
    // Built via setSecret on purpose: an object literal with a bare
    // `__proto__:` key would set the prototype instead of storing anything.
    let vault = newVault();
    const oldKey = await unlock(vault, "old-passphrase");
    vault = setSecret(vault, oldKey, "__proto__", "proto-value");
    vault = setSecret(vault, oldKey, "github", "ghp_abc");
    expect(listKeys(vault)).toEqual(["__proto__", "github"]);

    const rotated = await rotateVault(vault, oldKey, "new-passphrase");

    expect(listKeys(rotated)).toContain("__proto__");
    lock();
    const newKey = await unlock(rotated, "new-passphrase");
    expect(getSecret(rotated, newKey, "__proto__")).toBe("proto-value");
    // ...and the ordinary entry alongside it is untouched.
    expect(getSecret(rotated, newKey, "github")).toBe("ghp_abc");
  });

  it("migrates a v1, kdf-less vault with UNBOUND entries to v2", async () => {
    // The migration path the source advertises, end to end: rotate is what
    // rewrites a pre-v2 file into the current schema. Built by hand because
    // no code path produces a v1 vault any more.
    const salt = generateSalt();
    const oldKey = await deriveKey("old-passphrase", salt, LEGACY_KDF);
    const legacy: VaultFile = {
      version: 1,
      salt: salt.toString("base64"),
      // No AAD: v1 ciphertexts were not bound to the name they sat under.
      entries: {
        github: encryptEntry("ghp_legacy", oldKey),
        aws: encryptEntry("aws_legacy", oldKey),
      },
    };
    lock();

    const rotated = await rotateVault(legacy, oldKey, "new-passphrase");

    expect(rotated.version).toBe(SECRETS_SCHEMA_VERSION);
    expect(rotated.kdf).toEqual(DEFAULT_KDF);
    expect(listKeys(rotated)).toEqual(["aws", "github"]);

    lock();
    const newKey = await unlock(rotated, "new-passphrase");
    expect(getSecret(rotated, newKey, "github")).toBe("ghp_legacy");
    expect(getSecret(rotated, newKey, "aws")).toBe("aws_legacy");

    // The rewritten entries are name-BOUND, which is the point of the bump:
    // an unbound decrypt of the same blob is now refused.
    expect(() => decryptEntry(rotated.entries.github, newKey)).toThrow();
    expect(decryptEntry(rotated.entries.github, newKey, "github")).toBe("ghp_legacy");
  });
});

describe("hasSecretRefs + resolveSecretRefs (spawn-time substitution)", () => {
  it("hasSecretRefs detects ${secret:NAME} in env values", () => {
    expect(hasSecretRefs({ FOO: "bar" })).toBe(false);
    expect(hasSecretRefs({ FOO: "${secret:GITHUB}" })).toBe(true);
    expect(hasSecretRefs({ FOO: "Bearer ${secret:TOKEN}" })).toBe(true);
    expect(hasSecretRefs(undefined)).toBe(false);
    expect(hasSecretRefs({})).toBe(false);
  });

  it("resolveSecretRefs substitutes a single ref end-to-end", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc123");
    const { resolved, missing } = resolveSecretRefs({ GITHUB_TOKEN: "${secret:github}" }, vault, key);
    expect(resolved.GITHUB_TOKEN).toBe("ghp_abc123");
    expect(missing).toEqual([]);
  });

  it("resolveSecretRefs preserves surrounding text", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "tok", "abc");
    const { resolved } = resolveSecretRefs({ AUTH: "Bearer ${secret:tok}" }, vault, key);
    expect(resolved.AUTH).toBe("Bearer abc");
  });

  it("resolveSecretRefs reports missing secrets and leaves the literal", async () => {
    const vault = newVault();
    const key = await unlock(vault, "hunter2");
    const { resolved, missing } = resolveSecretRefs({ GITHUB_TOKEN: "${secret:nonesuch}" }, vault, key);
    expect(resolved.GITHUB_TOKEN).toBe("${secret:nonesuch}");
    expect(missing).toEqual(["nonesuch"]);
  });

  it("resolveSecretRefs reports a PRESENT but undecryptable entry as missing", async () => {
    // Distinct from the absent case above: the entry exists, so the
    // own-property lookup finds it and the decrypt is what fails. That branch
    // is the difference between a spawn failing closed and a corrupt blob
    // being substituted into a child's env, and nothing covered it.
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "gh", "ghp_abc");
    const damaged: VaultFile = {
      ...vault,
      entries: {
        ...vault.entries,
        gh: { ...vault.entries.gh, ciphertext: Buffer.from("tampered").toString("base64") },
      },
    };
    const { resolved, missing } = resolveSecretRefs({ GITHUB_TOKEN: "${secret:gh}" }, damaged, key);
    expect(resolved.GITHUB_TOKEN).toBe("${secret:gh}");
    expect(missing).toEqual(["gh"]);
  });

  it("resolveSecretRefs passes through env values without refs", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    const { resolved } = resolveSecretRefs({ LITERAL: "no refs here", GITHUB_TOKEN: "${secret:github}" }, vault, key);
    expect(resolved.LITERAL).toBe("no refs here");
    expect(resolved.GITHUB_TOKEN).toBe("ghp_abc");
  });

  it("reports a MALFORMED ${secret:...} reference in `malformed` instead of passing it to the child", async () => {
    // hasSecretRefs gates on the `${secret:` substring, so each of these
    // passes the gate, demands a passphrase and unlocks the vault -- and used
    // to come out of `replace` untouched with `missing` EMPTY, because the
    // strict regex never matched. The child was then spawned with the literal
    // as its token: a one-character typo silently broke the fail-closed
    // promise, and no "missing" audit event was written either.
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "gh", "ghp_abc");
    for (const [literal, auditName] of [
      ["${secret:gh token}", `${MALFORMED_REF_MARKER} gh`],
      ["${secret:gh", `${MALFORMED_REF_MARKER} gh`],
      // No name prefix parses at all: the marker stands alone.
      ["${secret:}", MALFORMED_REF_MARKER],
    ]) {
      expect(hasSecretRefs({ GITHUB_TOKEN: literal }), literal).toBe(true);
      const { resolved, missing, malformed } = resolveSecretRefs({ GITHUB_TOKEN: literal }, vault, key);
      expect(resolved.GITHUB_TOKEN, literal).toBe(literal);
      // Its OWN list, never folded into `missing`: `missing` is NAMES, and
      // every consumer (the audit trail above all) treats it as such.
      expect(missing, literal).toEqual([]);
      // `display` quotes the opener, the name prefix and the one character
      // that broke the reference, behind the marker, so the refusal can point
      // at the typo without printing what follows it (env-value text that
      // may be a credential); `auditName` keeps only the prefix that IS legal
      // name text.
      expect(malformed, literal).toHaveLength(1);
      expect(malformed[0].auditName, literal).toBe(auditName);
      expect(malformed[0].display.startsWith(`${MALFORMED_REF_MARKER} \${secret:`), literal).toBe(true);
      expect(malformed[0].display.length, literal).toBeLessThanOrEqual(
        MALFORMED_REF_MARKER.length + 1 + MALFORMED_REF_MAX_CHARS + 3,
      );
    }
  });

  it("a malformed reference is reported alongside the well-formed ones in the same value", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "gh", "ghp_abc");
    const { resolved, missing, malformed } = resolveSecretRefs(
      { AUTH: "${secret:gh} ${secret:bad name} ${secret:absent}" },
      vault,
      key,
    );
    // The good ref still resolves; the value is refused over the other two.
    expect(resolved.AUTH).toBe("ghp_abc ${secret:bad name} ${secret:absent}");
    expect(missing).toEqual(["absent"]);
    // display stops one character past the name prefix -- the typo itself
    // (the space) -- and elides the rest: past that point is env-value text.
    expect(malformed).toEqual([
      { display: `${MALFORMED_REF_MARKER} \${secret:bad ...`, auditName: `${MALFORMED_REF_MARKER} bad` },
    ]);
  });

  it("never returns a malformed span raw: display is control-stripped and capped, auditName stops at the name", async () => {
    // An unterminated reference runs to the END of the env value, so the
    // span can carry whatever the user put after the typo -- a host, a
    // password, a newline, an escape sequence. Folded into `missing` as-is,
    // it used to reach the thrown error (an MCP payload and a log line) and
    // the audit log's names-only `secret` field verbatim.
    const vault = newVault();
    const key = await unlock(vault, "hunter2");
    const tail = `DB_PASS@db.internal:5432/prod?x=y&pw=${"z".repeat(200)}`;
    const { missing, malformed } = resolveSecretRefs({ DB: `\${secret:${tail}` }, vault, key);
    expect(missing).toEqual([]);
    expect(malformed).toHaveLength(1);
    const [ref] = malformed;
    // Bounded: marker + space + MALFORMED_REF_MAX_CHARS of span + "...".
    expect(ref.display.length).toBeLessThanOrEqual(MALFORMED_REF_MARKER.length + 1 + MALFORMED_REF_MAX_CHARS + 3);
    // display shows the opener, the name prefix and the ONE character after
    // it (the typo), then elides: the host, port and query never print.
    expect(ref.display).toBe(`${MALFORMED_REF_MARKER} \${secret:DB_PASS@...`);
    expect(ref.display).not.toContain("db.internal");
    expect(ref.display).not.toContain("pw=");
    // The audit form never carries anything past the legal-name prefix --
    // not the host, not the port, not the query string.
    expect(ref.auditName).toBe(`${MALFORMED_REF_MARKER} DB_PASS`);
    expect(ref.auditName).not.toContain("@db.internal");

    // Control characters are DROPPED from display (not escaped): the string
    // is headed for a terminal and a log, where a raw ESC can forge a cursor
    // move and a newline can forge a line. What remains is inert text. The
    // ESC is built at runtime so no control byte sits in this source file.
    const ESC = String.fromCharCode(0x1b);
    const NL = String.fromCharCode(0x0a);
    const ctl = resolveSecretRefs({ X: `\${secret:gh${ESC}[2J${NL}token}` }, vault, key).malformed;
    // After stripping, the body reads `gh[2Jtoken}`: name prefix `gh`, then
    // `[` is the character that broke the reference.
    expect(ctl).toEqual([
      { display: `${MALFORMED_REF_MARKER} \${secret:gh[...`, auditName: `${MALFORMED_REF_MARKER} gh` },
    ]);
  });

  it("bounds the name prefix, so a token pasted where a NAME belongs never reaches the audit log whole", async () => {
    // The realistic typo: a value pasted instead of a name, brace dropped.
    // Every character of a classic PAT is in the name class, so an unbounded
    // prefix put the entire token into the names-only audit log and most of
    // it into display.
    const vault = newVault();
    const key = await unlock(vault, "hunter2");
    const token = `ghp_${"A".repeat(36)}`;
    const [ref] = resolveSecretRefs({ T: `\${secret:${token}` }, vault, key).malformed;
    expect(ref.auditName.length).toBeLessThanOrEqual(MALFORMED_REF_MARKER.length + 1 + 16);
    expect(ref.auditName).not.toContain(token);
    expect(ref.display).not.toContain(token);
    expect(ref.display.endsWith("...")).toBe(true);
  });

  it("never leaves a lone surrogate in display, and strips Unicode format controls", async () => {
    const vault = newVault();
    const key = await unlock(vault, "hunter2");
    // A key emoji right after a 16-char name prefix: the old code-unit slice
    // could end on the emoji's high half. The cut is on code points now.
    const emojiSpan = `\${secret:${"a".repeat(16)}${String.fromCodePoint(0x1f511)} tail`;
    const [emoji] = resolveSecretRefs({ X: emojiSpan }, vault, key).malformed;
    // No lone surrogate anywhere: a high half not followed by a low half, or
    // a low half not preceded by a high half. (String.prototype.isWellFormed
    // is the same predicate, but this project's TS lib target predates it.)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji.display)).toBe(false);
    // A right-to-left override (U+202E) would redraw the rest of a doctor
    // line; it is a format control, stripped like the C0 range. Built from
    // the code point so no control character sits in this source file.
    const rlo = String.fromCodePoint(0x202e);
    const [bidi] = resolveSecretRefs({ X: `\${secret:x${rlo}token}` }, vault, key).malformed;
    expect(bidi.display).not.toContain(rlo);
    expect(bidi.auditName).toBe(`${MALFORMED_REF_MARKER} x`);
  });

  it("does not mistake a `${secret:` inside a DECRYPTED value for an unparsed reference", async () => {
    // The malformed-span scan runs on the ORIGINAL value: a secret whose
    // plaintext happens to contain the opener must not be reported malformed
    // after it was substituted in.
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "tricky", "literally ${secret:inside");
    const { resolved, missing, malformed } = resolveSecretRefs({ X: "${secret:tricky}" }, vault, key);
    expect(resolved.X).toBe("literally ${secret:inside");
    expect(missing).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it("collectMalformedSecretRefs names the spans the strict name scanners cannot see, in display form", () => {
    // doctor and mcp_connect_secrets scan with the strict regex, so a
    // reference a typo has put outside it is invisible to them while the
    // spawn is refused over it. This is how they can name it -- and they get
    // the same bounded `display` the refusal quotes, never the raw span.
    expect(collectMalformedSecretRefs(undefined)).toEqual([]);
    expect(collectMalformedSecretRefs({ A: "${secret:ok}", B: "plain" })).toEqual([]);
    expect(
      collectMalformedSecretRefs({ A: "${secret:gh token}", B: "x ${secret:gh token} y", C: "${secret:tail" }),
    ).toEqual([`${MALFORMED_REF_MARKER} \${secret:gh ...`, `${MALFORMED_REF_MARKER} \${secret:tail`]);
    const long = collectMalformedSecretRefs({ C: `\${secret:DB_PASS@db.internal/${"q".repeat(100)}` });
    expect(long).toHaveLength(1);
    expect(long[0].length).toBeLessThanOrEqual(MALFORMED_REF_MARKER.length + 1 + MALFORMED_REF_MAX_CHARS + 3);
    expect(long[0].endsWith("...")).toBe(true);
  });

  it("resolveSecretRefs caches decryption across multiple refs to the same secret", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "x", "value-x");
    const { resolved } = resolveSecretRefs(
      { A: "${secret:x}", B: "prefix-${secret:x}-suffix", C: "${secret:x}" },
      vault,
      key,
    );
    expect(resolved.A).toBe("value-x");
    expect(resolved.B).toBe("prefix-value-x-suffix");
    expect(resolved.C).toBe("value-x");
  });
});

// ---------------------------------------------------------------------
// Schema v2: the scrypt parameters live IN the file, and every ciphertext
// is bound to the entry name it is stored under.
// ---------------------------------------------------------------------

describe("secrets-vault v2: recorded KDF parameters", () => {
  /** Write a vault file by hand under the given parameters. */
  async function writeVaultWithKdf(params: { N: number; r: number; p: number }): Promise<string> {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const path = vaultPath(synthHome);
    const salt = generateSalt();
    const key = await deriveKey("hunter2", salt, params);
    const file = {
      version: 2,
      salt: salt.toString("base64"),
      kdf: params,
      entries: { github: encryptEntry("ghp_abc", key, "github") },
      check: encryptEntry(VAULT_CHECK_PLAINTEXT, key, VAULT_CHECK_AAD),
    };
    writeFileSync(path, `${JSON.stringify(file)}\n`);
    return path;
  }

  it("derives under the vault's OWN cost factor, not this build's default", async () => {
    // N here is deliberately NOT DEFAULT_KDF.N: a reader that assumes the
    // compile-time constant derives a different key and reports a wrong
    // passphrase for a vault whose passphrase is perfectly correct.
    const params = { N: 1 << 14, r: 8, p: 1 };
    expect(params.N).not.toBe(DEFAULT_KDF.N);
    const path = await writeVaultWithKdf(params);
    lock();
    const loaded = (await loadVault(path)) as VaultFile;
    expect(loaded.kdf).toEqual(params);
    const key = await unlock(loaded, "hunter2");
    expect(getSecret(loaded, key, "github")).toBe("ghp_abc");
  });

  it("a kdf-LESS vault stays readable after the build default is bumped", async () => {
    // The cost bump this whole design exists to make possible is also the
    // thing that breaks a v1 vault: it records no `kdf`, so whatever the
    // reader falls back to IS its derivation. Falling back to DEFAULT_KDF
    // means raising DEFAULT_KDF silently re-keys every v1 vault in the wild
    // into "wrong passphrase for this vault" -- so the fallback is pinned to
    // LEGACY_KDF, which must never move.
    const salt = generateSalt();
    const legacyKey = await deriveKey("hunter2", salt, LEGACY_KDF);
    const legacy: VaultFile = {
      version: 1,
      salt: salt.toString("base64"),
      entries: { github: encryptEntry("ghp_legacy", legacyKey) },
    };

    // Stand in for a future release raising the cost factor.
    const originalN = DEFAULT_KDF.N;
    DEFAULT_KDF.N = 1 << 14;
    try {
      expect(DEFAULT_KDF.N).not.toBe(LEGACY_KDF.N);
      lock();
      const key = await unlock(legacy, "hunter2");
      expect(getSecret(legacy, key, "github")).toBe("ghp_legacy");
    } finally {
      DEFAULT_KDF.N = originalN;
      lock();
    }
  });

  it("a saved vault records its parameters on disk", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    const path = vaultPath(synthHome);
    await saveVault(path, vault);
    const { readFileSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(path, "utf8")).kdf).toEqual(DEFAULT_KDF);
  });

  it("refuses a vault whose kdf is nonsense rather than falling back to the default", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const path = vaultPath(synthHome);
    // N is not a power of two, and a bogus N means a wrong key (or a memory
    // bomb), not something to silently paper over.
    const bad = { version: 2, salt: generateSalt().toString("base64"), kdf: { N: 3, r: 8, p: 1 }, entries: {} };
    writeFileSync(path, `${JSON.stringify(bad)}\n`);
    await expect(loadVault(path)).rejects.toThrow(/invalid kdf/i);
  });

  it("refuses an N/r PAIR whose working set busts the memory bound, not just each field", async () => {
    // The per-field caps (N <= 2^18, r <= 32) are individually satisfiable at
    // values that multiply out to 128 * 2^18 * 32 = 1 GiB -- four times the
    // 256MB the guard documents. Bounding the fields separately is not the
    // same as bounding what they cost together, and scryptCallWithMaxmem
    // hands node a maxmem derived from the same params, so it would not stop
    // the allocation either.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const path = vaultPath(synthHome);
    const bomb = {
      version: 2,
      salt: generateSalt().toString("base64"),
      kdf: { N: 1 << 18, r: 32, p: 1 },
      entries: {},
    };
    writeFileSync(path, `${JSON.stringify(bomb)}\n`);
    await expect(loadVault(path)).rejects.toThrow(/invalid kdf/i);

    // The documented worst case (2^18 at the default r=8 = exactly 256MB) is
    // still accepted, so the bound rejects the bomb without shrinking the
    // headroom the per-field caps were chosen to leave.
    const atCap = {
      version: 2,
      salt: generateSalt().toString("base64"),
      kdf: { N: 1 << 18, r: 8, p: 1 },
      entries: {},
    };
    writeFileSync(path, `${JSON.stringify(atCap)}\n`);
    await expect(loadVault(path)).resolves.toBeDefined();
  });
});

describe("secrets-vault v2: ciphertexts are bound to their entry name", () => {
  it("a blob moved to another entry no longer decrypts", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "PROD", "prod-token");
    vault = setSecret(vault, key, "DEV", "dev-token");
    // Exactly what an attacker with write access to secrets.json does: swap
    // the two ciphertext blobs so the server spawned for PROD gets DEV's
    // token. Both blobs are intact and the key is right.
    const swapped: VaultFile = {
      ...vault,
      entries: { PROD: vault.entries.DEV, DEV: vault.entries.PROD },
    };
    expect(() => getSecret(swapped, key, "PROD")).toThrow();
    expect(() => getSecret(swapped, key, "DEV")).toThrow();
  });

  it("still reads a v1 vault, whose entries were written unbound", async () => {
    const salt = generateSalt();
    const key = await deriveKey("hunter2", salt);
    const legacy: VaultFile = {
      version: 1,
      salt: salt.toString("base64"),
      entries: { github: encryptEntry("ghp_legacy", key) },
    };
    lock();
    const unlocked = await unlock(legacy, "hunter2");
    expect(getSecret(legacy, unlocked, "github")).toBe("ghp_legacy");
  });

  it("does NOT accept an unbound blob in a v2 vault", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    // A v2 vault carrying an entry written the old way is a downgrade
    // attempt: accepting it would let an attacker strip the binding.
    const downgraded: VaultFile = { ...vault, entries: { github: encryptEntry("ghp_swapped", key) } };
    expect(() => getSecret(downgraded, key, "github")).toThrow();
  });
});

describe("secrets-vault: passphrase normalization", () => {
  // Built from code points, never typed: the two forms are visually identical
  // in an editor, so a literal fixture would silently be the same string.
  const COMPOSED = `caf${String.fromCharCode(0xe9)}-passphrase`;
  const DECOMPOSED = `cafe${String.fromCharCode(0x301)}-passphrase`;

  it("opens a vault created with the composed form using the decomposed one", async () => {
    expect(COMPOSED).not.toBe(DECOMPOSED);
    let vault = newVault();
    const key = await unlock(vault, COMPOSED);
    vault = setSecret(vault, key, "github", "ghp_abc");
    lock();
    // Same passphrase to a human; different UTF-8 bytes. Without NFC the
    // second form reports "wrong passphrase for this vault".
    const reopened = await unlock(vault, DECOMPOSED);
    expect(getSecret(vault, reopened, "github")).toBe("ghp_abc");
  });

  it("still opens a legacy vault keyed on the UN-normalized bytes", async () => {
    // What a vault created before normalization looks like: the key came from
    // the decomposed bytes exactly as typed.
    const salt = generateSalt();
    const legacyKey = await deriveKey(DECOMPOSED, salt, DEFAULT_KDF, false);
    const vault: VaultFile = {
      version: 1,
      salt: salt.toString("base64"),
      entries: { github: encryptEntry("ghp_legacy", legacyKey) },
    };
    lock();
    const key = await unlock(vault, DECOMPOSED);
    expect(getSecret(vault, key, "github")).toBe("ghp_legacy");
  });

  it("a genuinely wrong passphrase is still rejected", async () => {
    let vault = newVault();
    const key = await unlock(vault, COMPOSED);
    vault = setSecret(vault, key, "github", "ghp_abc");
    lock();
    await expect(unlock(vault, "not-the-passphrase")).rejects.toThrow(/wrong passphrase/i);
  });
});

describe("secrets-vault: the check marker is compared, not merely decrypted", () => {
  it("treats a marker holding the WRONG plaintext as corrupt", async () => {
    let vault = newVault();
    const key = await unlock(vault, "hunter2");
    vault = setSecret(vault, key, "github", "ghp_abc");
    // Decrypts cleanly under the right key, but is not the expected constant.
    // verifyKey used to accept on "it decrypted" alone, so this vault
    // unlocked while rotateVault -- which compares -- refused it.
    const wrongMarker: VaultFile = {
      ...vault,
      check: encryptEntry("some-other-plaintext", key, VAULT_CHECK_AAD),
    };
    lock();
    await expect(unlock(wrongMarker, "hunter2")).rejects.toThrow(VAULT_CHECK_CORRUPT_ERROR);
  });
});

describe("secrets-vault: loadVault error shapes", () => {
  it("throws a typed error carrying the corrupt entry NAME, newlines and all", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const path = vaultPath(synthHome);
    // A legacy vault could store a name with a newline in it; sniffing the
    // name back out of the message text with /(.+)$/ silently lost it.
    const badName = `BAD${String.fromCharCode(10)}NAME`;
    const corrupt = {
      version: 1,
      salt: generateSalt().toString("base64"),
      entries: { [badName]: { iv: "x", ciphertext: 123, authTag: "y" } },
    };
    writeFileSync(path, `${JSON.stringify(corrupt)}\n`);
    const err = await loadVault(path).catch((e) => e);
    expect(err).toBeInstanceOf(VaultEntryCorruptError);
    expect((err as VaultEntryCorruptError).entryName).toBe(badName);
  });

  it("propagates a NON-ENOENT read error instead of reporting no vault", async () => {
    // ENOENT is the only "vault absent" signal. Anything else (EACCES, EIO,
    // EISDIR) means the file is probably there and unreadable, and returning
    // null would let the caller bootstrap a fresh vault straight over it.
    // A directory at the vault path produces exactly that shape.
    const { mkdirSync } = await import("node:fs");
    const path = vaultPath(synthHome);
    mkdirSync(path, { recursive: true });
    await expect(loadVault(path)).rejects.toThrow();
    // ...and the absent case still reports absent rather than throwing.
    await expect(loadVault(join(synthHome, ".yaw-mcp", "not-here.json"))).resolves.toBeNull();
  });

  it("refuses a vault whose version is a STRING instead of assuming it is current", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(synthHome, ".yaw-mcp"), { recursive: true });
    const path = vaultPath(synthHome);
    // "99" as a string used to sail past the newer-schema guard entirely.
    const bad = { version: "99", salt: generateSalt().toString("base64"), entries: {} };
    writeFileSync(path, `${JSON.stringify(bad)}\n`);
    await expect(loadVault(path)).rejects.toThrow(/"version" must be a number/);
  });
});
