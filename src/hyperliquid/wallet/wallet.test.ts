import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha512 } from "@noble/hashes/sha2.js";

import {
  BIP39_DIGEST,
  BIP39_ITERATIONS,
  BIP39_SEED_BYTES,
  generateMnemonic,
  hasNativePbkdf2,
  isValidMnemonic,
  mnemonicToSeed,
  normaliseMnemonic,
  registerNativePbkdf2,
  wordCount,
  type NativePbkdf2,
} from "@/hyperliquid/wallet/mnemonic";
import {
  accountFromPrivateKey,
  deriveAccount,
  deriveAccounts,
  derivationPath,
  ETH_DERIVATION_PREFIX,
  normalisePrivateKey,
} from "@/hyperliquid/wallet/derive";
import { HlError } from "@/hyperliquid/core/errors";

/**
 * The canonical BIP39 test vector, from the specification itself.
 *
 * Using the standard's own vector rather than one generated here: it proves
 * interoperability with every other wallet, which is the whole point of
 * importing a phrase.
 */
const VECTOR = {
  mnemonic:
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  /** m/44'/60'/0'/0/0 — the address MetaMask and every mainstream wallet shows. */
  address: "0x9858EfFD232B4033E47d90003D41EC34EcaEda94",
};

afterEach(() => registerNativePbkdf2(null));

describe("mnemonic generation", () => {
  it("produces a valid 12-word phrase by default", () => {
    const mnemonic = generateMnemonic();
    expect(mnemonic.split(" ")).toHaveLength(12);
    expect(isValidMnemonic(mnemonic)).toBe(true);
    expect(wordCount(128)).toBe(12);
  });

  it("produces 24 words at 256 bits", () => {
    expect(generateMnemonic(256).split(" ")).toHaveLength(24);
    expect(wordCount(256)).toBe(24);
  });

  it("never repeats", () => {
    // A generator without a real CSPRNG returns the same phrase every time,
    // which is the failure this would catch on bare Hermes.
    const phrases = new Set(Array.from({ length: 25 }, () => generateMnemonic()));
    expect(phrases.size).toBe(25);
  });
});

describe("normaliseMnemonic", () => {
  it("survives the whitespace a password-manager paste introduces", () => {
    // The checksum fails on any of these, and "invalid recovery phrase" for a
    // correct phrase is a bad way to lose someone their account.
    const messy = `  ${VECTOR.mnemonic.replace(/ /g, "  ")}\n`;
    expect(normaliseMnemonic(messy)).toBe(VECTOR.mnemonic);
    expect(isValidMnemonic(messy)).toBe(true);
  });

  it("accepts a phrase typed in capitals", () => {
    expect(isValidMnemonic(VECTOR.mnemonic.toUpperCase())).toBe(true);
  });

  it("rejects a phrase whose checksum fails", () => {
    const wrong = VECTOR.mnemonic.replace(/about$/, "abandon");
    expect(isValidMnemonic(wrong)).toBe(false);
  });

  it("rejects a word that is not in the wordlist", () => {
    expect(isValidMnemonic(VECTOR.mnemonic.replace("about", "zzzzz"))).toBe(false);
  });
});

describe("mnemonicToSeed", () => {
  it("matches the BIP39 specification vector", async () => {
    const seed = await mnemonicToSeed(VECTOR.mnemonic);
    expect(seed).toHaveLength(BIP39_SEED_BYTES);
    expect(deriveAccount(seed).address).toBe(VECTOR.address);
  });

  it("refuses an invalid phrase before doing any work", async () => {
    await expect(mnemonicToSeed("not a real phrase at all")).rejects.toThrow(HlError);
  });

  it("gives a different seed for a passphrase", async () => {
    // The BIP39 passphrase is a hidden 25th word: same phrase, different wallet.
    const plain = await mnemonicToSeed(VECTOR.mnemonic);
    const withPass = await mnemonicToSeed(VECTOR.mnemonic, "secret");
    expect(Buffer.from(withPass).toString("hex")).not.toBe(Buffer.from(plain).toString("hex"));
  });

  describe("the native fast path", () => {
    /**
     * Stands in for react-native-quick-crypto's binding, which is a Nitro module
     * and cannot load off-device. Uses @noble under the hood, so this asserts the
     * PLUMBING — argument order, async handling, byte conversion — not the maths.
     */
    const fakeNative: NativePbkdf2 = (password, salt, iterations, keylen, digest, callback) => {
      expect(iterations).toBe(BIP39_ITERATIONS);
      expect(keylen).toBe(BIP39_SEED_BYTES);
      expect(digest).toBe(BIP39_DIGEST);
      // BIP39's salt is the literal "mnemonic" plus the passphrase.
      expect(salt.startsWith("mnemonic")).toBe(true);
      pbkdf2Async(sha512, password, salt, { c: iterations, dkLen: keylen })
        .then((derived) => callback(null, derived))
        .catch((error: Error) => callback(error, new Uint8Array()));
    };

    it("is reported as unavailable until registered", () => {
      expect(hasNativePbkdf2()).toBe(false);
      registerNativePbkdf2(fakeNative);
      expect(hasNativePbkdf2()).toBe(true);
    });

    it("produces a seed IDENTICAL to the pure-JS path", async () => {
      // The decisive test. The whole reason this module exists is to take a
      // different code path on device; if the two paths ever disagreed, an
      // imported wallet would resolve to a different address in the app than in
      // every other wallet the user owns.
      const pureJs = await mnemonicToSeed(VECTOR.mnemonic);

      registerNativePbkdf2(fakeNative);
      const native = await mnemonicToSeed(VECTOR.mnemonic);

      expect(Buffer.from(native).toString("hex")).toBe(Buffer.from(pureJs).toString("hex"));
      expect(deriveAccount(native).address).toBe(VECTOR.address);
    });

    it("agrees on the passphrase path too", async () => {
      const pureJs = await mnemonicToSeed(VECTOR.mnemonic, "trezor");
      registerNativePbkdf2(fakeNative);
      const native = await mnemonicToSeed(VECTOR.mnemonic, "trezor");
      expect(Buffer.from(native).toString("hex")).toBe(Buffer.from(pureJs).toString("hex"));
    });

    it("surfaces a native failure as an HlError rather than an unhandled rejection", async () => {
      registerNativePbkdf2((_p, _s, _i, _k, _d, callback) =>
        callback(new Error("nitro binding unavailable"), new Uint8Array())
      );
      await expect(mnemonicToSeed(VECTOR.mnemonic)).rejects.toThrow(/Native key derivation/);
    });
  });
});

describe("derivation", () => {
  it("uses the standard Ethereum path", () => {
    // Deviating produces a DIFFERENT, empty account from the same phrase —
    // which reads to a user as "my funds are gone".
    expect(ETH_DERIVATION_PREFIX).toBe("m/44'/60'/0'/0");
    expect(derivationPath(0)).toBe("m/44'/60'/0'/0/0");
    expect(derivationPath(5)).toBe("m/44'/60'/0'/0/5");
  });

  it("rejects a negative or fractional index", () => {
    expect(() => derivationPath(-1)).toThrow(HlError);
    expect(() => derivationPath(1.5)).toThrow(HlError);
  });

  it("derives distinct accounts per index", async () => {
    const seed = await mnemonicToSeed(VECTOR.mnemonic);
    const first = deriveAccount(seed, 0);
    const second = deriveAccount(seed, 1);

    expect(first.address).toBe(VECTOR.address);
    expect(second.address).not.toBe(first.address);
    expect(second.path).toBe("m/44'/60'/0'/0/1");
  });

  it("derives a batch identically to one at a time", async () => {
    // The batch path reuses one master node; it must not diverge from the
    // single-account path an account picker was populated from.
    const seed = await mnemonicToSeed(VECTOR.mnemonic);
    const batch = deriveAccounts(seed, 5);
    expect(batch).toHaveLength(5);
    batch.forEach((derived, index) => {
      expect(derived.address).toBe(deriveAccount(seed, index).address);
    });
  });

  it("rejects a seed of the wrong length", () => {
    expect(() => deriveAccount(new Uint8Array(32))).toThrow(/64 bytes/);
  });

  it("produces a private key the SDK can sign with", async () => {
    // The SDK's wallet interface is structurally { signTypedData, address }, so
    // a viem local account satisfies it with no wrapper.
    const seed = await mnemonicToSeed(VECTOR.mnemonic);
    const account = accountFromPrivateKey(deriveAccount(seed).privateKey);
    expect(account.address).toBe(VECTOR.address);
    expect(typeof account.signTypedData).toBe("function");
  });
});

describe("normalisePrivateKey", () => {
  // Hardhat/Anvil account #0, not this project's testnet signer — see the note
  // in `accounts.test.ts`. Only the SHAPE matters to these assertions.
  const KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

  it("accepts a key with or without the prefix, and trims", () => {
    expect(normalisePrivateKey(KEY)).toBe(`0x${KEY}`);
    expect(normalisePrivateKey(`0x${KEY}`)).toBe(`0x${KEY}`);
    expect(normalisePrivateKey(`  0X${KEY.toUpperCase()}  `)).toBe(`0x${KEY}`);
  });

  it.each([
    ["too short", KEY.slice(0, 60)],
    ["too long", `${KEY}ff`],
    ["not hex", `${KEY.slice(0, 60)}zzzz`],
    ["empty", ""],
    ["a mnemonic pasted by mistake", VECTOR.mnemonic],
  ])("rejects a %s value", (_label, bad) => {
    expect(() => normalisePrivateKey(bad)).toThrow(HlError);
  });

  it("rejects an all-zero key", () => {
    // Not a valid secp256k1 scalar, but viem accepts it far enough to yield a
    // deterministic address — so it looks like a working wallet.
    expect(() => normalisePrivateKey(`0x${"0".repeat(64)}`)).toThrow(/cannot be zero/);
  });

  it("never puts the key in the error", () => {
    // The value IS the secret; an error carrying it ends up in a log or a
    // crash report.
    try {
      normalisePrivateKey(`${KEY}ff`);
      throw new Error("should have thrown");
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(KEY.slice(0, 16));
    }
  });
});
