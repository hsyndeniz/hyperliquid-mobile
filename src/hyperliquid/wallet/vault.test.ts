import * as Keychain from "react-native-keychain";
import * as quickCrypto from "react-native-quick-crypto";

import {
  IV_BYTES,
  MASTER_KEY_BYTES,
  VAULT_ALGORITHM,
  deleteSecret,
  destroyVault,
  getSecret,
  hasSecret,
  initialiseVault,
  inspectVault,
  listVaultKeys,
  lockVault,
  putSecret,
  registerVaultCrypto,
  type EncryptedBlob,
  type VaultCrypto,
} from "@/hyperliquid/wallet/vault";
import { hlStringStorage } from "@/hyperliquid/storage/mmkv";
import { HlError } from "@/hyperliquid/core/errors";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const backend = quickCrypto as unknown as VaultCrypto;

/** Records every IV the vault generates, to prove none is ever reused. */
function recordingCrypto(seen: Uint8Array[]): VaultCrypto {
  return {
    randomBytes: (size) => {
      const bytes = backend.randomBytes(size);
      if (size === IV_BYTES) seen.push(bytes);
      return bytes;
    },
    createCipheriv: backend.createCipheriv.bind(backend),
    createDecipheriv: backend.createDecipheriv.bind(backend),
  };
}

beforeEach(async () => {
  (Keychain as unknown as { __reset(): void }).__reset();
  for (const key of listVaultKeys()) hlStringStorage.removeItem(`hl:vault:${key}`);
  hlStringStorage.removeItem("hl:vault:__index");
  lockVault();
  registerVaultCrypto(backend);
});

/**
 * Everything an error could carry a secret in, flattened to one string.
 *
 * The guards below used `JSON.stringify(error)`, which on an Error is `"{}"` —
 * `message`, `stack` and `cause` are all non-enumerable or absent, so the
 * assertion passed no matter what the error said. These are the only two
 * guards standing between a secret and the logger's `error` field, so they
 * were guarding nothing at all (2026-08-29).
 *
 * Walks the cause chain because that is how the real errors are built, and
 * includes `stack` because a thrown string appears there verbatim.
 */
function errorSurface(error: unknown, depth = 0): string {
  if (depth > 5 || error === null || error === undefined) return "";
  if (typeof error !== "object") return String(error);
  const parts: string[] = [JSON.stringify(error)];
  const record = error as {
    message?: unknown;
    stack?: unknown;
    cause?: unknown;
    context?: unknown;
  };
  if (typeof record.message === "string") parts.push(record.message);
  if (typeof record.stack === "string") parts.push(record.stack);
  if (record.context !== undefined) parts.push(JSON.stringify(record.context));
  if (record.cause !== undefined) parts.push(errorSurface(record.cause, depth + 1));
  return parts.join(" ");
}

describe("vault lifecycle", () => {
  it("reports a genuine first run as uninitialised", async () => {
    expect(await inspectVault()).toEqual({ kind: "uninitialised" });
  });

  it("is ready once initialised", async () => {
    await initialiseVault();
    expect(await inspectVault()).toEqual({ kind: "ready" });
  });

  it("initialising twice is a no-op rather than a key rotation", async () => {
    // Regenerating would orphan every existing blob.
    await initialiseVault();
    await putSecret("mnemonic", MNEMONIC);
    await initialiseVault();

    expect(await getSecret("mnemonic")).toBe(MNEMONIC);
  });

  describe("the key-loss state", () => {
    it("is distinguished from a first run", async () => {
      // These look identical to the app and demand opposite responses: one is
      // "create a wallet", the other is "your data is unrecoverable".
      await initialiseVault();
      await putSecret("mnemonic", MNEMONIC);
      await Keychain.resetGenericPassword({ service: "com.hl.vault.masterKey" });
      lockVault();

      expect(await inspectVault()).toEqual({ kind: "key_lost", blobCount: 1 });
    });

    it("refuses to initialise over it", async () => {
      // Silently minting a new key would present as a working empty wallet
      // while every stored secret became permanently undecryptable.
      await initialiseVault();
      await putSecret("mnemonic", MNEMONIC);
      await Keychain.resetGenericPassword({ service: "com.hl.vault.masterKey" });
      lockVault();

      await expect(initialiseVault()).rejects.toThrow(/master key is gone/);
    });
  });

  it("destroys the blobs along with the key", async () => {
    // Leaving blobs behind would put the vault into `key_lost` on next launch.
    await initialiseVault();
    await putSecret("mnemonic", MNEMONIC);

    await destroyVault();

    expect(await inspectVault()).toEqual({ kind: "uninitialised" });
    expect(listVaultKeys()).toEqual([]);
  });

  it("refuses to read while locked with no key present", async () => {
    await initialiseVault();
    await putSecret("mnemonic", MNEMONIC);
    await Keychain.resetGenericPassword({ service: "com.hl.vault.masterKey" });
    lockVault();

    await expect(getSecret("mnemonic")).rejects.toThrow(HlError);
  });
});

describe("round-tripping secrets", () => {
  beforeEach(async () => initialiseVault());

  it("returns exactly what was stored", async () => {
    await putSecret("mnemonic", MNEMONIC);
    expect(await getSecret("mnemonic")).toBe(MNEMONIC);
  });

  it("returns null for a name that was never stored", async () => {
    expect(await getSecret("nothing")).toBeNull();
    expect(hasSecret("nothing")).toBe(false);
  });

  it("survives a lock, reading the key back from the Keychain", async () => {
    await putSecret("mnemonic", MNEMONIC);
    lockVault();
    expect(await getSecret("mnemonic")).toBe(MNEMONIC);
  });

  it("keeps several secrets independent", async () => {
    await putSecret("mnemonic", MNEMONIC);
    await putSecret("agent:0xabc", "0xdeadbeef");

    expect(await getSecret("mnemonic")).toBe(MNEMONIC);
    expect(await getSecret("agent:0xabc")).toBe("0xdeadbeef");
    expect(listVaultKeys().sort()).toEqual(["agent:0xabc", "mnemonic"]);
  });

  it("deletes one without disturbing the others", async () => {
    await putSecret("mnemonic", MNEMONIC);
    await putSecret("agent:0xabc", "0xdeadbeef");

    deleteSecret("agent:0xabc");

    expect(await getSecret("agent:0xabc")).toBeNull();
    expect(await getSecret("mnemonic")).toBe(MNEMONIC);
    expect(listVaultKeys()).toEqual(["mnemonic"]);
  });

  it("handles a 24-word phrase and unicode", async () => {
    await putSecret("long", `${MNEMONIC} ${MNEMONIC}`);
    await putSecret("unicode", "café ☕ 日本語");
    expect(await getSecret("unicode")).toBe("café ☕ 日本語");
  });
});

describe("what is actually written to storage", () => {
  beforeEach(async () => initialiseVault());

  it("never stores the plaintext", async () => {
    // The whole point. MMKV is unencrypted at rest.
    await putSecret("mnemonic", MNEMONIC);
    const raw = hlStringStorage.getItem("hl:vault:mnemonic")!;

    expect(raw).not.toContain("abandon");
    expect(raw).not.toContain(MNEMONIC);
  });

  it("stores an iv, a tag and the ciphertext", async () => {
    await putSecret("mnemonic", MNEMONIC);
    const blob = JSON.parse(hlStringStorage.getItem("hl:vault:mnemonic")!) as EncryptedBlob;

    expect(Object.keys(blob).sort()).toEqual(["content", "iv", "tag"]);
    expect(globalThis.atob(blob.iv)).toHaveLength(IV_BYTES);
    // GCM's tag is 16 bytes.
    expect(globalThis.atob(blob.tag)).toHaveLength(16);
  });

  it("keeps the master key out of MMKV entirely", async () => {
    await putSecret("mnemonic", MNEMONIC);
    const stored = await Keychain.getGenericPassword({ service: "com.hl.vault.masterKey" });
    expect(stored).toBeTruthy();
    if (!stored) return;

    // The key lives in the Keychain; nothing in MMKV may echo it.
    for (const name of [...listVaultKeys(), "__index"]) {
      expect(hlStringStorage.getItem(`hl:vault:${name}`) ?? "").not.toContain(stored.password);
    }
  });

  it("uses a 256-bit key and AES-256-GCM", async () => {
    expect(MASTER_KEY_BYTES).toBe(32);
    expect(VAULT_ALGORITHM).toBe("aes-256-gcm");
    const stored = await Keychain.getGenericPassword({ service: "com.hl.vault.masterKey" });
    expect(globalThis.atob((stored as { password: string }).password)).toHaveLength(32);
  });
});

describe("IV handling", () => {
  it("generates a fresh IV for every encryption", async () => {
    // Reusing an IV with the same key breaks GCM's confidentiality AND its
    // authentication. The API makes it un-passable; this proves the generator
    // is actually per-call rather than hoisted.
    const seen: Uint8Array[] = [];
    registerVaultCrypto(recordingCrypto(seen));
    await initialiseVault();

    for (let i = 0; i < 20; i += 1) await putSecret(`item-${i}`, "same plaintext every time");

    const distinct = new Set(seen.map((iv) => iv.join(",")));
    expect(seen).toHaveLength(20);
    expect(distinct.size).toBe(20);
  });

  it("produces different ciphertext for identical plaintext", async () => {
    await initialiseVault();
    await putSecret("a", MNEMONIC);
    await putSecret("b", MNEMONIC);

    const first = JSON.parse(hlStringStorage.getItem("hl:vault:a")!) as EncryptedBlob;
    const second = JSON.parse(hlStringStorage.getItem("hl:vault:b")!) as EncryptedBlob;

    expect(first.iv).not.toBe(second.iv);
    expect(first.content).not.toBe(second.content);
  });
});

describe("tamper detection", () => {
  beforeEach(async () => {
    await initialiseVault();
    await putSecret("mnemonic", MNEMONIC);
  });

  function corrupt(mutate: (blob: EncryptedBlob) => EncryptedBlob): void {
    const blob = JSON.parse(hlStringStorage.getItem("hl:vault:mnemonic")!) as EncryptedBlob;
    hlStringStorage.setItem("hl:vault:mnemonic", JSON.stringify(mutate(blob)));
  }

  it("rejects modified ciphertext", async () => {
    // GCM authenticates. Without the tag check this would decrypt to garbage
    // and be handed back as if it were a recovery phrase.
    corrupt((blob) => ({ ...blob, content: `${blob.content.slice(0, -4)}AAAA` }));
    await expect(getSecret("mnemonic")).rejects.toThrow(/integrity check/);
  });

  it("rejects a swapped IV", async () => {
    corrupt((blob) => ({ ...blob, iv: globalThis.btoa("\0".repeat(IV_BYTES)) }));
    await expect(getSecret("mnemonic")).rejects.toThrow(/integrity check/);
  });

  it("rejects a forged tag", async () => {
    corrupt((blob) => ({ ...blob, tag: globalThis.btoa("\0".repeat(16)) }));
    await expect(getSecret("mnemonic")).rejects.toThrow(/integrity check/);
  });

  it("distinguishes a malformed envelope from a failed tag", async () => {
    // Different causes want different responses: one is a corrupt cache, the
    // other is a security event.
    hlStringStorage.setItem("hl:vault:mnemonic", "{not json");
    await expect(getSecret("mnemonic")).rejects.toThrow(/not readable/);
  });

  it("never puts the plaintext in the error", async () => {
    corrupt((blob) => ({ ...blob, content: `${blob.content.slice(0, -4)}AAAA` }));
    try {
      await getSecret("mnemonic");
      throw new Error("should have thrown");
    } catch (error) {
      // The whole surface, not `JSON.stringify` — see `errorSurface`.
      expect(errorSurface(error)).not.toContain("abandon");
    }
  });

  it("the plaintext guard would actually catch a leak", () => {
    expect(errorSurface(new Error("failed on 'abandon abandon'"))).toContain("abandon");
    expect(errorSurface(new Error("could not decrypt"))).not.toContain("abandon");
  });
});

/**
 * The master key's storage OPTIONS, which nothing could observe until the mock
 * kept them.
 *
 * `KEYCHAIN_OPTIONS` carries the whole security property of this file: without
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` the item falls back to the library default
 * (`AfterFirstUnlock`, not device-only), so the key that decrypts the recovery
 * phrase becomes readable in the background AND migrates into an encrypted
 * iCloud/iTunes backup onto another device — exactly what this module's
 * docstring says must never happen.
 *
 * Deleting that spread from the write left all thirty tests in this file
 * green, because the in-memory mock stored `{username, password, service}` and
 * dropped the options object. The mock now records them (`__writes`), so the
 * property is finally assertable.
 */
describe("the master key's keychain protection", () => {
  const writes = (): { service: string; options: { accessible?: string } }[] =>
    (
      Keychain as unknown as {
        __writes: () => { service: string; options: { accessible?: string } }[];
      }
    ).__writes();

  it("stores the master key device-only, unlocked-only", async () => {
    await initialiseVault();

    const write = writes().find((entry) => entry.service === "com.hl.vault.masterKey");
    expect(write).toBeDefined();
    expect(write!.options.accessible).toBe("AccessibleWhenUnlockedThisDeviceOnly");
  });

  it("does not silently accept the library default", async () => {
    // The assertion above is only meaningful if the default would FAIL it —
    // otherwise it passes whatever the code does.
    await initialiseVault();

    const write = writes().find((entry) => entry.service === "com.hl.vault.masterKey");
    expect(write!.options.accessible).not.toBe(undefined);
    expect(write!.options.accessible).not.toBe("AccessibleAfterFirstUnlock");
  });
});

describe("crypto backend registration", () => {
  it("refuses to operate without one, rather than storing plaintext", async () => {
    registerVaultCrypto(null);
    await expect(initialiseVault()).rejects.toThrow(/not registered/);
  });
});

describe("a locked vault is not reported as tampering", () => {
  it("reports not_authorized, not an integrity failure", async () => {
    // Telling a user their recovery phrase failed its integrity check, when in
    // fact nothing was read at all, is a false alarm about the worst possible
    // event. The two demand opposite responses: unlock vs restore from backup.
    await initialiseVault();
    await putSecret("mnemonic", MNEMONIC);
    await Keychain.resetGenericPassword({ service: "com.hl.vault.masterKey" });
    lockVault();

    await expect(getSecret("mnemonic")).rejects.toThrow(/locked/);
    await expect(getSecret("mnemonic")).rejects.not.toThrow(/integrity/);
  });

  it("reports an unregistered backend as configuration, not tampering", async () => {
    await initialiseVault();
    await putSecret("mnemonic", MNEMONIC);
    lockVault();
    registerVaultCrypto(null);

    await expect(getSecret("mnemonic")).rejects.toThrow(/not registered/);
  });
});

describe("a cache wipe preserves the vault", () => {
  it("clearHlStorage leaves the recovery phrase intact", async () => {
    // clearAll() took the vault with it while the Keychain key survived, so
    // inspectVault() then saw a key and zero blobs and reported `ready` — a
    // clean, empty, working wallet. The user was told nothing went wrong.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { clearHlStorage } = require("@/hyperliquid/storage/mmkv");
    await initialiseVault();
    await putSecret("mnemonic", MNEMONIC);

    clearHlStorage();

    expect(await getSecret("mnemonic")).toBe(MNEMONIC);
    expect(await inspectVault()).toEqual({ kind: "ready" });
  });

  it("but still clears non-vault keys", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { clearHlStorage, hlStringStorage: store } = require("@/hyperliquid/storage/mmkv");
    await initialiseVault();
    store.setItem("hl:some-cache", "throwaway");

    clearHlStorage();

    expect(store.getItem("hl:some-cache")).toBeNull();
  });
});
