/**
 * The wallet: creating one, importing one, and getting a signer out of it.
 *
 * Ties together the three pieces below it — `mnemonic` (generate and derive a
 * seed on the fast path), `derive` (BIP32 to an Ethereum account), and `vault`
 * (encrypt-then-store) — into the small surface an app actually calls.
 *
 * Two shapes of wallet, deliberately kept apart:
 *
 * - **Seeded**: a BIP39 phrase in the vault. Any number of accounts derive from
 *   it, and it is the only kind that can be backed up or restored.
 * - **Imported key**: a bare private key, no phrase, exactly one account. It
 *   cannot derive siblings and it cannot be backed up as words, and telling a
 *   user otherwise is how funds get lost.
 *
 * The private key is **never persisted**. Only the phrase is, and everything
 * else is re-derived on unlock — which keeps exactly one secret at rest for a
 * seeded wallet however many accounts it has.
 */

import { deleteAllAgentKeys } from "@/hyperliquid/auth/keychain";
import { HlError } from "@/hyperliquid/core/errors";
import { log } from "@/hyperliquid/core/logger";
import type { Hex } from "@/hyperliquid/types/domain";
import {
  accountFromPrivateKey,
  deriveAccount,
  deriveAccounts,
  normalisePrivateKey,
  type DerivedKey,
} from "@/hyperliquid/wallet/derive";
import {
  generateMnemonic,
  isValidMnemonic,
  mnemonicToSeed,
  normaliseMnemonic,
  type MnemonicStrength,
} from "@/hyperliquid/wallet/mnemonic";
import { clearHlStorage } from "@/hyperliquid/storage/mmkv";
import { localSigner, requireUserPresence, type MasterSigner } from "@/hyperliquid/wallet/signer";
import {
  deleteSecret,
  destroyVault,
  getSecret,
  hasSecret,
  initialiseVault,
  inspectVault,
  putSecret,
} from "@/hyperliquid/wallet/vault";

const logger = log.child("wallet.accounts");

/** Vault keys. Fixed strings, because a typo would orphan a wallet. */
const MNEMONIC_KEY = "mnemonic";
const PRIVATE_KEY_KEY = "privateKey";
const METADATA_KEY = "walletMeta";

export type WalletKind = "seeded" | "importedKey";

export interface WalletMetadata {
  kind: WalletKind;
  /** Addresses the user has added, in the order they were added. */
  accounts: { index: number; address: Hex; label: string | null }[];
  createdAt: number;
  /**
   * Whether the user has confirmed they wrote the phrase down.
   *
   * Persisted because it drives a prompt that must survive a restart — an
   * un-backed-up wallet holding funds is the single worst state this app can
   * put someone in.
   */
  backedUp: boolean;
}

export type WalletState =
  { kind: "none" } | { kind: "locked" } | { kind: "ready"; metadata: WalletMetadata };

async function readMetadata(): Promise<WalletMetadata | null> {
  const raw = await getSecret(METADATA_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WalletMetadata;
  } catch {
    // Metadata is a convenience, not a secret store. A corrupt one must not
    // make an otherwise-recoverable wallet look absent.
    logger.warn("wallet.metadata_corrupt");
    return null;
  }
}

async function writeMetadata(metadata: WalletMetadata): Promise<void> {
  await putSecret(METADATA_KEY, JSON.stringify(metadata));
}

/**
 * What the app should show on launch.
 *
 * `locked` is distinct from `none` because the vault's master key may simply not
 * be loaded yet — showing "create a wallet" to someone who already has one is a
 * good way to make them think their funds are gone.
 */
export async function walletState(): Promise<WalletState> {
  const vault = await inspectVault();
  if (vault.kind === "uninitialised") return { kind: "none" };
  if (vault.kind === "key_lost") {
    throw new HlError(
      `Wallet data exists but its encryption key is gone; restore from your recovery phrase`,
      { code: "not_authorized", context: { blobCount: vault.blobCount } }
    );
  }

  const metadata = await readMetadata();
  if (!metadata) return { kind: "none" };
  return { kind: "ready", metadata };
}

export interface CreatedWallet {
  /**
   * Shown once, for the user to write down. **Never persisted anywhere but the
   * vault**, and never logged.
   */
  mnemonic: string;
  account: DerivedKey;
}

/**
 * Create a new wallet.
 *
 * @throws {HlError} if a wallet already exists — overwriting one silently
 *   destroys access to whatever it held.
 */
export async function createWallet(strength: MnemonicStrength = 128): Promise<CreatedWallet> {
  const state = await walletState();
  if (state.kind === "ready") {
    throw new HlError("A wallet already exists on this device", {
      code: "validation_error",
      context: { reason: "wallet_exists" },
    });
  }

  await initialiseVault();
  const mnemonic = generateMnemonic(strength);
  const account = deriveAccount(await mnemonicToSeed(mnemonic), 0);

  await putSecret(MNEMONIC_KEY, mnemonic);
  await writeMetadata({
    kind: "seeded",
    accounts: [{ index: 0, address: account.address, label: null }],
    createdAt: Date.now(),
    // False until the user confirms. The prompt that follows from this is the
    // only thing standing between them and an unrecoverable wallet.
    backedUp: false,
  });

  logger.info("wallet.created", { context: { address: account.address } });
  return { mnemonic, account };
}

/**
 * Everything an import must do before it may write a secret.
 *
 * Two problems, one place, because both import paths had both.
 *
 * **`key_lost` deadlocked the exact recovery it advised.** `initialiseVault()`
 * throws in that state with "re-import from a recovery phrase" — and both
 * import paths called it as their first step, so re-importing was the one
 * action that could not run. The state is reachable without any user error: a
 * restored device backup brings the MMKV blobs back but not the Keychain item,
 * which is written `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and excluded from backups
 * by design. The Account tab then said "restart the app first", which changes
 * nothing, and the only working exit was the red "forget wallet" control that a
 * user in that state will reasonably refuse to touch.
 *
 * Discarding the blobs there loses nothing: they are provably undecryptable,
 * and the phrase being pasted is the authority to replace them.
 *
 * **Replacing a wallet is as destructive as forgetting one, and was ungated.**
 * `forgetWallet` requires presence because "someone holding an unlocked phone
 * could wipe the owner's wallet off it". Import does the same damage by a
 * different door — it sweeps every agent key and overwrites the device's only
 * copy of the outgoing phrase — and asked for nothing. First-time setup stays
 * promptless; only a REPLACEMENT authenticates.
 */
async function prepareVaultForImport(): Promise<void> {
  const state = await inspectVault();

  // Gated only when there is a working vault holding a wallet — i.e. a real
  // REPLACEMENT. `inspectVault` is the primitive that never throws, which
  // matters because `walletState()` rejects outright in `key_lost` and would
  // take the deadlock with it.
  if (state.kind === "ready" && (hasSecret(MNEMONIC_KEY) || hasSecret(PRIVATE_KEY_KEY))) {
    await requireUserPresence("remove_wallet", {
      reason: "Replace the wallet on this device",
      // Same call as the other gates: a phone with no lock screen still
      // belongs to someone who may need their own wallet back.
      allowWithoutBiometry: true,
    });
  }

  // Nothing to protect and nothing to lose: the blobs cannot be decrypted by
  // anyone, including us. Clearing them is what lets `initialiseVault()` mint a
  // fresh key instead of throwing the advice it was blocking.
  if (state.kind === "key_lost") await destroyVault();

  await initialiseVault();
}

/** Restore from a recovery phrase. Replaces any existing wallet. */
export async function importMnemonic(phrase: string, accountIndex = 0): Promise<DerivedKey> {
  const mnemonic = normaliseMnemonic(phrase);
  if (!isValidMnemonic(mnemonic)) {
    throw new HlError("That is not a valid recovery phrase", {
      code: "validation_error",
      // No context: the phrase is the secret.
    });
  }

  await prepareVaultForImport();
  // "Replace wallet" has the same gap `forgetWallet` had: the OUTGOING wallet's
  // agent keys survive under their own Keychain namespace, still approved on
  // chain, now belonging to an account this device has otherwise forgotten.
  // Swept before the new secret lands, while they are still the only ones here.
  //
  // Re-importing the SAME wallet therefore costs one fresh agent approval. That
  // is a signature; the alternative is leaving a live trading key behind on a
  // "replace", and there is no version of that trade worth taking.
  await deleteAllAgentKeys();
  const account = deriveAccount(await mnemonicToSeed(mnemonic), accountIndex);

  await putSecret(MNEMONIC_KEY, mnemonic);
  deleteSecret(PRIVATE_KEY_KEY);
  await writeMetadata({
    kind: "seeded",
    accounts: [{ index: accountIndex, address: account.address, label: null }],
    createdAt: Date.now(),
    // An imported phrase is by definition already written down somewhere.
    backedUp: true,
  });

  logger.info("wallet.imported_mnemonic", { context: { address: account.address } });
  return account;
}

/**
 * Import a bare private key.
 *
 * Produces exactly one account with no phrase, so it can derive no siblings and
 * cannot be backed up as words. `metadata.kind` records that, because a UI that
 * offers "show recovery phrase" for this wallet has nothing to show.
 */
export async function importPrivateKey(input: string): Promise<DerivedKey> {
  const privateKey = normalisePrivateKey(input);
  const account = accountFromPrivateKey(privateKey);

  await prepareVaultForImport();
  // "Replace wallet" has the same gap `forgetWallet` had: the OUTGOING wallet's
  // agent keys survive under their own Keychain namespace, still approved on
  // chain, now belonging to an account this device has otherwise forgotten.
  // Swept before the new secret lands, while they are still the only ones here.
  //
  // Re-importing the SAME wallet therefore costs one fresh agent approval. That
  // is a signature; the alternative is leaving a live trading key behind on a
  // "replace", and there is no version of that trade worth taking.
  await deleteAllAgentKeys();
  await putSecret(PRIVATE_KEY_KEY, privateKey);
  deleteSecret(MNEMONIC_KEY);
  await writeMetadata({
    kind: "importedKey",
    accounts: [{ index: 0, address: account.address as Hex, label: null }],
    createdAt: Date.now(),
    backedUp: true,
  });

  logger.info("wallet.imported_key", { context: { address: account.address } });
  return { privateKey, address: account.address as Hex, path: "imported", index: 0 };
}

/**
 * A signer for one account.
 *
 * Re-derives from the stored phrase every time rather than caching a private
 * key: the phrase is already in memory-decrypted form for the duration of the
 * call, and holding derived keys around widens the window in which a heap dump
 * yields something spendable.
 */
export async function signerFor(accountIndex = 0): Promise<MasterSigner> {
  const metadata = await readMetadata();
  if (!metadata) {
    throw new HlError("No wallet on this device", { code: "not_authorized" });
  }

  if (metadata.kind === "importedKey") {
    if (accountIndex !== 0) {
      throw new HlError("An imported key has only one account", {
        code: "validation_error",
        context: { accountIndex },
      });
    }
    const stored = await getSecret(PRIVATE_KEY_KEY);
    if (!stored) throw new HlError("Wallet key is missing", { code: "not_authorized" });
    return localSigner(accountFromPrivateKey(stored as Hex));
  }

  const mnemonic = await getSecret(MNEMONIC_KEY);
  if (!mnemonic) throw new HlError("Recovery phrase is missing", { code: "not_authorized" });

  const derived = deriveAccount(await mnemonicToSeed(mnemonic), accountIndex);
  return localSigner(accountFromPrivateKey(derived.privateKey));
}

/**
 * Addresses for an account picker.
 *
 * Derives without persisting anything: an address the user has not chosen yet
 * is not part of their wallet.
 */
export async function previewAccounts(count = 5, startIndex = 0): Promise<DerivedKey[]> {
  const metadata = await readMetadata();
  if (metadata?.kind !== "seeded") {
    throw new HlError("Only a seeded wallet can derive more accounts", {
      code: "validation_error",
      context: { kind: metadata?.kind ?? "none" },
    });
  }
  const mnemonic = await getSecret(MNEMONIC_KEY);
  if (!mnemonic) throw new HlError("Recovery phrase is missing", { code: "not_authorized" });

  return deriveAccounts(await mnemonicToSeed(mnemonic), count, startIndex);
}

/** Add a derived account to the wallet. */
export async function addAccount(accountIndex: number, label: string | null = null): Promise<Hex> {
  const metadata = await readMetadata();
  if (metadata?.kind !== "seeded") {
    throw new HlError("Only a seeded wallet can add accounts", { code: "validation_error" });
  }
  if (metadata.accounts.some((account) => account.index === accountIndex)) {
    throw new HlError("That account is already in the wallet", {
      code: "validation_error",
      context: { accountIndex },
    });
  }

  const mnemonic = await getSecret(MNEMONIC_KEY);
  if (!mnemonic) throw new HlError("Recovery phrase is missing", { code: "not_authorized" });
  const derived = deriveAccount(await mnemonicToSeed(mnemonic), accountIndex);

  await writeMetadata({
    ...metadata,
    accounts: [...metadata.accounts, { index: accountIndex, address: derived.address, label }],
  });
  return derived.address;
}

/**
 * Reveal the recovery phrase.
 *
 * Separated from every other read so the call site is obvious in review, and so
 * a user-presence gate has exactly one place to sit. The caller is responsible
 * for calling `requireUserPresence` first — enforced by convention here rather
 * than by type, because the gate needs a UI reason string this module has no
 * business inventing.
 */
export type RevealPurpose =
  /**
   * The user is creating the wallet and is being shown the phrase to write
   * down. Ungated: it is the same uninterrupted interaction that generated the
   * seed seconds ago, and there is nothing yet to protect it from.
   */
  | "setup"
  /**
   * The user is asking to see the phrase again, later, from Account. GATED —
   * this is the request that hands over permanent, off-device control of every
   * account under the seed, and an unlocked phone borrowed for a minute was
   * enough.
   */
  | "export";

export async function revealRecoveryPhrase(purpose: RevealPurpose): Promise<string> {
  // A REQUIRED argument, not a convention. `requireUserPresence` and its whole
  // `GatedOperation` union existed with zero call sites anywhere in the tree
  // while `accounts.ts` documented the gate as "enforced by convention here
  // rather than by type" — and the convention was never once followed. Making
  // the caller name its purpose is what stops the next call site from being
  // added without anyone deciding.
  if (purpose === "export") {
    await requireUserPresence("export_recovery_phrase", {
      reason: "Show your recovery phrase",
      // A phone with no lock screen still belongs to someone who may need
      // their own phrase back.
      allowWithoutBiometry: true,
    });
  }

  const metadata = await readMetadata();
  if (metadata?.kind !== "seeded") {
    throw new HlError("This wallet has no recovery phrase", {
      code: "validation_error",
      context: { kind: metadata?.kind ?? "none" },
    });
  }
  const mnemonic = await getSecret(MNEMONIC_KEY);
  if (!mnemonic) throw new HlError("Recovery phrase is missing", { code: "not_authorized" });

  logger.info("wallet.phrase_revealed");
  return mnemonic;
}

/** Record that the user has written the phrase down. */
export async function markBackedUp(): Promise<void> {
  const metadata = await readMetadata();
  if (!metadata) throw new HlError("No wallet on this device", { code: "not_authorized" });
  await writeMetadata({ ...metadata, backedUp: true });
}

/** Whether to keep nagging about a backup. */
export async function needsBackup(): Promise<boolean> {
  const metadata = await readMetadata();
  return metadata !== null && metadata.kind === "seeded" && !metadata.backedUp;
}

/**
 * Remove the wallet from this device.
 *
 * Irreversible without the recovery phrase, so the caller must gate it — the
 * same treatment a withdrawal gets, for the same reason.
 */
export async function forgetWallet(): Promise<void> {
  // Agent keys FIRST, and this order is the whole point.
  //
  // `destroyVault` resets exactly one Keychain service, `MASTER_KEY_SERVICE`.
  // Agent keys live under a disjoint namespace (`hyperliquid.agent.<identity>`)
  // that vault teardown provably cannot reach, so "Wallet removed from this
  // device" used to leave behind a key Hyperliquid still honours as an approved
  // API wallet. It cannot `withdraw3` — money movement is master-signed — but it
  // can `order`, `cancel` and `agentSendAsset`, which is enough to open
  // max-leverage positions or wash the balance across the spread into someone
  // else's account. The threat this button exists to defeat is selling the
  // phone, and that is exactly the case it failed.
  //
  // Sweeping before the wipe is required, not tidier: after `destroyVault` the
  // metadata naming those identities is gone, so there is nothing left to build
  // a service string from. `deleteAllAgentKeys` enumerates instead of guessing.
  //
  // On-chain revocation is deliberately NOT attempted here. It needs the master
  // key to sign, so this is the last moment it would be possible — but it is a
  // network call on a path the user expects to be local and instant, and a
  // failed revocation must not leave the key on the device. Removing the key is
  // what makes it unusable from this phone; revoking the approval upstream is a
  // separate concern, tracked, and belongs where a failure can be reported.
  // Gated: this is irreversible, and a slide gesture is friction rather than
  // authentication. Someone holding an unlocked phone could wipe the owner's
  // wallet off it — recoverable only from a phrase they may not have.
  await requireUserPresence("remove_wallet", {
    reason: "Remove this wallet from the device",
    allowWithoutBiometry: true,
  });

  const swept = await deleteAllAgentKeys();
  await destroyVault();

  // The rest of the app's storage, which the vault wipe does NOT reach.
  //
  // This function's own threat model is "selling the phone", and everything
  // outside `hl:vault:*` survived it — in PLAINTEXT, because the MMKV instance
  // is created with no encryption key and that module's header says so. What
  // stayed behind names the owner: every `WithdrawalRecord` in `hl:withdrawals`
  // carries an `identityKey`, which is the composite
  // `env|accountId|0xFULL_ADDRESS|dex|sub`, alongside each withdrawal's
  // destination address and amount. `hl:orders:pending` and the rest of the
  // per-identity cache went with it.
  //
  // So a user who slid to forget, read "Wallet removed from this device", and
  // sold the phone left their full master address and complete withdrawal
  // history — counterparties and amounts — readable by anyone with file access
  // to the container. No key, no decryption, no Keychain involved.
  //
  // Ordered after `destroyVault()` because `clearHlStorage` deliberately skips
  // `hl:vault:*`; the vault has to remove its own blobs first.
  clearHlStorage();
  logger.info("wallet.forgotten", { context: { agentKeysRemoved: swept } });
}

/** Whether anything is stored at all, without decrypting. */
export function hasStoredWallet(): boolean {
  return hasSecret(MNEMONIC_KEY) || hasSecret(PRIVATE_KEY_KEY);
}
