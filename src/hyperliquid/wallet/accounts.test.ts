import * as Keychain from "react-native-keychain";
import * as quickCrypto from "react-native-quick-crypto";

import {
  addAccount,
  createWallet,
  forgetWallet,
  hasStoredWallet,
  importMnemonic,
  importPrivateKey,
  markBackedUp,
  needsBackup,
  previewAccounts,
  revealRecoveryPhrase,
  signerFor,
  walletState,
} from "@/hyperliquid/wallet/accounts";
import {
  canSignUnattended,
  classifySignerFailure,
  externalSigner,
  isSilent,
  localSigner,
} from "@/hyperliquid/wallet/signer";
import {
  listVaultKeys,
  lockVault,
  registerVaultCrypto,
  type VaultCrypto,
} from "@/hyperliquid/wallet/vault";
import { accountFromPrivateKey } from "@/hyperliquid/wallet/derive";
import { createIdentity } from "@/hyperliquid/core/identity";
import { hasAgentKey, listAgentKeyServices, storeAgentKey } from "@/hyperliquid/auth/keychain";
import { hlStringStorage } from "@/hyperliquid/storage/mmkv";
import { HlError } from "@/hyperliquid/core/errors";
import type { Hex } from "@/hyperliquid/types/domain";

const VECTOR_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VECTOR_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
/**
 * Hardhat/Anvil account #0 — a key published in their documentation and in
 * millions of repositories, so it belongs to nobody and funding it is a known
 * mistake rather than a secret.
 *
 * This slot held the project's ACTUAL `HL_TESTNET_SIGNER_KEY` — the key that
 * controls the testnet account these suites and the smoke scripts run against
 * — hardcoded here and committed to 83 commits of history. In a private repo
 * that was untidy; a public one would publish a live signing key. Nothing
 * derives an expected address from this constant (every assertion computes it),
 * so the value is free to be a throwaway, and `screenGuards` now refuses any
 * key that matches the environment's.
 */
const RAW_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

beforeEach(() => {
  (Keychain as unknown as { __reset(): void }).__reset();
  for (const key of listVaultKeys()) hlStringStorage.removeItem(`hl:vault:${key}`);
  hlStringStorage.removeItem("hl:vault:__index");
  lockVault();
  registerVaultCrypto(quickCrypto as unknown as VaultCrypto);
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

describe("wallet lifecycle", () => {
  it("reports none on a fresh device", async () => {
    expect(await walletState()).toEqual({ kind: "none" });
    expect(hasStoredWallet()).toBe(false);
  });

  it("creates a seeded wallet and derives account zero", async () => {
    const { mnemonic, account } = await createWallet();

    expect(mnemonic.split(" ")).toHaveLength(12);
    expect(account.path).toBe("m/44'/60'/0'/0/0");

    const state = await walletState();
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.metadata.kind).toBe("seeded");
    expect(state.metadata.accounts[0].address).toBe(account.address);
  });

  it("refuses to create over an existing wallet", async () => {
    // Overwriting silently destroys access to whatever it held.
    await createWallet();
    await expect(createWallet()).rejects.toThrow(/already exists/);
  });

  it("starts un-backed-up, and stays so across a lock", async () => {
    // The nag this drives is the only thing between a user and an
    // unrecoverable wallet, so it has to survive a restart.
    await createWallet();
    expect(await needsBackup()).toBe(true);

    lockVault();
    expect(await needsBackup()).toBe(true);

    await markBackedUp();
    expect(await needsBackup()).toBe(false);
  });

  it("forgets everything on request", async () => {
    await createWallet();
    await forgetWallet();

    expect(await walletState()).toEqual({ kind: "none" });
    expect(hasStoredWallet()).toBe(false);
  });
});

describe("importing", () => {
  it("restores the canonical address from the spec vector", async () => {
    // Proves interoperability: the same phrase must give the same address here
    // as in every other wallet the user owns.
    const account = await importMnemonic(VECTOR_MNEMONIC);
    expect(account.address).toBe(VECTOR_ADDRESS);
  });

  it("treats an imported phrase as already backed up", async () => {
    await importMnemonic(VECTOR_MNEMONIC);
    expect(await needsBackup()).toBe(false);
  });

  it("tolerates the whitespace a paste introduces", async () => {
    const messy = `  ${VECTOR_MNEMONIC.replace(/ /g, "  ")}\n`;
    expect((await importMnemonic(messy)).address).toBe(VECTOR_ADDRESS);
  });

  it("rejects an invalid phrase without storing anything", async () => {
    await expect(importMnemonic("not a phrase")).rejects.toThrow(HlError);
    expect(hasStoredWallet()).toBe(false);
  });

  it("never puts the phrase in the error", async () => {
    try {
      await importMnemonic(`${VECTOR_MNEMONIC} extra`);
      throw new Error("should have thrown");
    } catch (error) {
      // Against the whole surface — message, stack, context and cause chain —
      // not `JSON.stringify`, which renders an Error as "{}" and passed
      // whatever the error said.
      expect(errorSurface(error)).not.toContain("abandon");
    }
  });

  it("the phrase guard would actually catch a leak", () => {
    // The guard above is the only thing standing between a recovery phrase and
    // the logger, so it is itself verified: an error carrying the phrase in
    // each place one could plausibly end up must fail it.
    expect(errorSurface(new Error(`'${VECTOR_MNEMONIC}' is not valid`))).toContain("abandon");
    expect(errorSurface(new Error("invalid", { cause: new Error(VECTOR_MNEMONIC) }))).toContain(
      "abandon"
    );
    expect(errorSurface({ context: { phrase: VECTOR_MNEMONIC } })).toContain("abandon");
    // And a clean error still passes, so it is not simply always true.
    expect(errorSurface(new Error("that is not a valid recovery phrase"))).not.toContain("abandon");
  });

  it("can import a bare private key", async () => {
    const account = await importPrivateKey(RAW_KEY);
    expect(account.address).toBe(accountFromPrivateKey(RAW_KEY as Hex).address);

    const state = await walletState();
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.metadata.kind).toBe("importedKey");
  });

  it("replaces a key wallet when a phrase is imported, and vice versa", async () => {
    // Leaving both behind would make `signerFor` depend on which branch ran.
    await importPrivateKey(RAW_KEY);
    await importMnemonic(VECTOR_MNEMONIC);
    expect((await signerFor()).address).toBe(VECTOR_ADDRESS);

    await importPrivateKey(RAW_KEY);
    expect((await signerFor()).address).toBe(accountFromPrivateKey(RAW_KEY as Hex).address);
  });
});

describe("what an imported key cannot do", () => {
  beforeEach(async () => importPrivateKey(RAW_KEY));

  it("has no recovery phrase to reveal", async () => {
    // Telling a user otherwise is how funds get lost.
    await expect(revealRecoveryPhrase("setup")).rejects.toThrow(/no recovery phrase/);
  });

  it("cannot derive sibling accounts", async () => {
    await expect(previewAccounts(3)).rejects.toThrow(/seeded wallet/);
    await expect(addAccount(1)).rejects.toThrow(/seeded wallet/);
  });

  it("has exactly one account", async () => {
    await expect(signerFor(1)).rejects.toThrow(/only one account/);
  });
});

describe("multiple accounts from one phrase", () => {
  beforeEach(async () => importMnemonic(VECTOR_MNEMONIC));

  it("previews addresses without adding them", async () => {
    // An address the user has not chosen is not part of their wallet.
    const preview = await previewAccounts(3);
    expect(preview).toHaveLength(3);
    expect(preview[0].address).toBe(VECTOR_ADDRESS);

    const state = await walletState();
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.metadata.accounts).toHaveLength(1);
  });

  it("adds one and remembers it", async () => {
    const address = await addAccount(1, "Trading");

    const state = await walletState();
    if (state.kind !== "ready") throw new Error("expected ready");
    expect(state.metadata.accounts).toHaveLength(2);
    expect(state.metadata.accounts[1]).toEqual({ index: 1, address, label: "Trading" });
  });

  it("refuses to add the same index twice", async () => {
    await addAccount(1);
    await expect(addAccount(1)).rejects.toThrow(/already in the wallet/);
  });

  it("gives a distinct signer per index", async () => {
    await addAccount(1);
    const first = await signerFor(0);
    const second = await signerFor(1);

    expect(first.address).toBe(VECTOR_ADDRESS);
    expect(second.address).not.toBe(first.address);
  });
});

describe("signers", () => {
  it("produces something the SDK can sign with", async () => {
    await importMnemonic(VECTOR_MNEMONIC);
    const signer = await signerFor();

    expect(signer.address).toBe(VECTOR_ADDRESS);
    expect(typeof signer.account.signTypedData).toBe("function");
  });

  it("marks a local key as silent and unattended-capable", () => {
    const signer = localSigner(accountFromPrivateKey(RAW_KEY as Hex));
    expect(signer.kind).toBe("silent");
    expect(isSilent(signer)).toBe(true);
    expect(canSignUnattended(signer)).toBe(true);
  });

  it("marks an external wallet as interactive and NOT unattended-capable", () => {
    // Background reconciliation must not depend on one: a request that hangs
    // waiting for a wallet app is indistinguishable from a network stall, and
    // for a withdrawal that case has no safe retry.
    const signer = externalSigner(accountFromPrivateKey(RAW_KEY as Hex), "MetaMask");
    expect(signer.kind).toBe("interactive");
    expect(isSilent(signer)).toBe(false);
    expect(canSignUnattended(signer)).toBe(false);
    expect(signer.label).toBe("MetaMask");
  });

  it("refuses to sign with no wallet present", async () => {
    await expect(signerFor()).rejects.toThrow(HlError);
  });

  it("does not persist a derived private key", async () => {
    // Only the phrase is stored; everything else is re-derived on demand, so a
    // seeded wallet keeps exactly one secret at rest however many accounts it has.
    await importMnemonic(VECTOR_MNEMONIC);
    await addAccount(1);
    await signerFor(1);

    expect(listVaultKeys().sort()).toEqual(["mnemonic", "walletMeta"]);
  });
});

describe("classifySignerFailure", () => {
  it.each([
    ["user rejected the request", "user_rejected"],
    ["Request denied by user", "user_rejected"],
    ["User cancelled", "user_rejected"],
    ["Request timed out", "wallet_timeout"],
    ["session disconnected", "session_expired"],
  ])("classifies %p", (message, reason) => {
    // An interactive signer produces failures a local key cannot, and the
    // difference decides whether a retry is even sensible.
    const error = classifySignerFailure(new Error(message));
    expect(error).toBeInstanceOf(HlError);
    expect(error.context?.reason).toBe(reason);
  });

  it("falls through safely on something unrecognised", () => {
    const error = classifySignerFailure(new Error("???"));
    expect(error.context?.reason).toBe("unknown");
    expect(error.code).toBe("transport_error");
  });

  it("passes an HlError through untouched", () => {
    const original = new HlError("already classified", { code: "not_authorized" });
    expect(classifySignerFailure(original)).toBe(original);
  });
});

describe("the phrase never reaches storage in the clear", () => {
  it("is encrypted at rest", async () => {
    await importMnemonic(VECTOR_MNEMONIC);
    const raw = hlStringStorage.getItem("hl:vault:mnemonic")!;
    expect(raw).not.toContain("abandon");
  });

  it("round-trips through a lock", async () => {
    await importMnemonic(VECTOR_MNEMONIC);
    lockVault();
    expect(await revealRecoveryPhrase("setup")).toBe(VECTOR_MNEMONIC);
  });
});

describe("agent keys do not outlive the wallet", () => {
  /**
   * "Wallet removed from this device" used to leave the agent key behind.
   *
   * `destroyVault` resets exactly one Keychain service; agent keys live under a
   * disjoint namespace it cannot reach. The leftover key cannot `withdraw3` —
   * money movement is master-signed — but it can `order`, `cancel` and
   * `agentSendAsset`, and once the master key is gone, revoking it on chain is
   * permanently impossible. The threat this button exists to defeat is handing
   * the phone on, and that is the case it failed.
   */
  const identity = createIdentity({
    env: "testnet",
    accountId: "0x1111111111111111111111111111111111111111",
    address: "0x1111111111111111111111111111111111111111",
  });

  it("sweeps the agent key when the wallet is forgotten", async () => {
    await importPrivateKey(`0x${"11".repeat(32)}`);
    await storeAgentKey(identity, `0x${"22".repeat(32)}`);
    expect(await hasAgentKey(identity)).toBe(true);

    await forgetWallet();

    expect(await hasAgentKey(identity)).toBe(false);
    expect(await listAgentKeyServices()).toEqual([]);
  });

  it("sweeps BEFORE the vault, since the vault names the identities", async () => {
    // Order is the whole fix: after `destroyVault` there is no metadata left to
    // build a service string from, so a sweep that ran second could not find
    // anything to delete.
    await importPrivateKey(`0x${"11".repeat(32)}`);
    await storeAgentKey(identity, `0x${"22".repeat(32)}`);

    await forgetWallet();
    expect(await listAgentKeyServices()).toHaveLength(0);
  });

  it("sweeps on REPLACE too — the outgoing wallet's key must not survive", async () => {
    await importPrivateKey(`0x${"11".repeat(32)}`);
    await storeAgentKey(identity, `0x${"22".repeat(32)}`);

    await importPrivateKey(`0x${"33".repeat(32)}`);

    expect(await listAgentKeyServices()).toEqual([]);
  });
});

describe("forgetting leaves nothing that names the owner", () => {
  /**
   * The threat this button exists to defeat is selling the phone — and
   * everything outside `hl:vault:*` survived it in PLAINTEXT. Each
   * `WithdrawalRecord` carries an `identityKey`, which is the composite
   * `env|accountId|0xFULL_ADDRESS|dex|sub`, plus every destination and amount.
   * MMKV here is created with no encryption key.
   */
  it("clears the non-vault storage as well as the vault", async () => {
    await importPrivateKey(`0x${"11".repeat(32)}`);
    hlStringStorage.setItem("hl:withdrawals", JSON.stringify([{ destination: "0xdead" }]));
    hlStringStorage.setItem("hl:trade:lastCoin", "BTC");

    await forgetWallet();

    expect(hlStringStorage.getItem("hl:withdrawals")).toBeNull();
    expect(hlStringStorage.getItem("hl:trade:lastCoin")).toBeNull();
  });
});

describe("a key_lost vault does not block its own recovery", () => {
  /**
   * `initialiseVault()` throws in `key_lost` with "re-import from a recovery
   * phrase" — and both import paths called it first, so re-importing was the
   * one action that could not run. Reachable with no user error at all: a
   * restored device backup brings the MMKV blobs back but not the Keychain
   * item, which is written `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and excluded from
   * backups by design.
   */
  it("re-imports over an orphaned vault instead of refusing", async () => {
    await importMnemonic(VECTOR_MNEMONIC);
    // Exactly the restored-backup shape: blobs present, master key gone.
    await Keychain.resetGenericPassword({ service: "com.hl.vault.masterKey" });

    await expect(importMnemonic(VECTOR_MNEMONIC)).resolves.toBeDefined();
    expect(await revealRecoveryPhrase("setup")).toBe(VECTOR_MNEMONIC);
  });
});

describe("the presence gate", () => {
  /**
   * `requireUserPresence` and its whole `GatedOperation` union shipped with
   * ZERO call sites, while this module's own docstring said the gate was
   * "enforced by convention here rather than by type". The convention was never
   * followed once: "Show recovery phrase" revealed 12-24 BIP-39 words on a
   * single tap, and "Forget wallet" wiped the device behind a slide gesture,
   * which is friction rather than authentication.
   *
   * Asserted through the Keychain the gate actually writes to, not a spy: the
   * gate proves presence by writing an access-controlled item and reading it
   * back, so the item's existence IS the evidence the gate ran.
   */
  const prompts = (): string[] =>
    (Keychain as unknown as { __authPrompts: () => string[] }).__authPrompts();

  /** The in-memory mock's test hooks — see `__mocks__/react-native-keychain.js`. */
  const keychainControl = (): {
    __setWriteFailure: (fn: ((options: { accessControl?: string }) => Error | null) | null) => void;
    __writes: () => { service: string; options: { accessControl?: string; accessible?: string } }[];
  } => Keychain as never;

  it("gates an EXPORT of the recovery phrase", async () => {
    await importMnemonic(VECTOR_MNEMONIC);
    await revealRecoveryPhrase("export");

    expect(prompts()).toContain("Show your recovery phrase");
  });

  it("does NOT gate the setup read-back", async () => {
    // The same uninterrupted interaction that generated the seed seconds
    // earlier. Prompting there asks someone to prove they are themselves to
    // see a thing they are in the middle of creating.
    await importMnemonic(VECTOR_MNEMONIC);
    await revealRecoveryPhrase("setup");

    expect(prompts()).toEqual([]);
  });

  it("gates forgetting the wallet", async () => {
    await importMnemonic(VECTOR_MNEMONIC);
    await forgetWallet();

    expect(prompts()).toContain("Remove this wallet from the device");
  });

  it("FAILS CLOSED when the keychain is unavailable, rather than skipping the prompt", async () => {
    // The gate proves presence by writing an access-controlled item. EVERY
    // rejection of that write used to be read as "this device has no
    // passcode", and with `allowWithoutBiometry` — which all six production
    // call sites pass, withdraw and send among them — it returned success on
    // a warning log. So one transient Keystore exception on a fully protected
    // phone signed a withdrawal with no prompt at all.
    //
    // The distinguishing probe is an UNGUARDED write: here it fails too, so
    // the keychain itself is unavailable, which says nothing about the
    // device's protection and must not wave a money path through.
    await importMnemonic(VECTOR_MNEMONIC);
    keychainControl().__setWriteFailure(() => new Error("keystore unavailable"));
    try {
      await expect(revealRecoveryPhrase("export")).rejects.toThrow(/could not confirm/i);
    } finally {
      keychainControl().__setWriteFailure(null);
    }
  });

  it("skips only when an UNGUARDED write proves the device itself is unprotected", async () => {
    // The opposite arm, and the reason the opt-out exists: on a phone with no
    // lock screen the guarded write is impossible but a plain one is fine, so
    // refusing outright would lock someone out of their own recovery phrase.
    await importMnemonic(VECTOR_MNEMONIC);
    // Only the ACCESS-CONTROLLED write fails — a plain one still works, which
    // is exactly what a phone with no lock screen looks like.
    keychainControl().__setWriteFailure((options) =>
      options.accessControl === undefined ? null : new Error("no passcode set")
    );
    try {
      // Resolves, and without ever prompting — there is nothing to prompt with.
      await expect(revealRecoveryPhrase("export")).resolves.toBe(VECTOR_MNEMONIC);
      expect(prompts()).toEqual([]);
    } finally {
      keychainControl().__setWriteFailure(null);
    }
  });
});
