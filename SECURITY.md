# Security

This app signs transactions that move real money. Please read this before
running it against mainnet, and before reporting anything.

## Reporting a vulnerability

**Do not open a public issue for a security bug.** Use GitHub's private
vulnerability reporting (Security → Report a vulnerability) on this repository.

Please include what you would need if you received the report: the version or
commit, the platform, the steps, and what an attacker gains. If you have a
proof of concept, keep it on testnet — see below.

Expect an acknowledgement within a few days. There is no bug bounty.

## What is in scope

Anything that could lose a user's funds or leak their keys:

- key handling — generation, storage, the vault, the agent lifecycle;
- the order and transfer paths, including how an ambiguous outcome is reported;
- the presence gate and screen-capture protection;
- anything that would let a build ship a secret (see `EXPO_PUBLIC_` below).

Out of scope: the Hyperliquid exchange itself (report to Hyperliquid), and
findings that require an already-compromised device.

## The security model, briefly

Read this before deciding whether something is a bug.

- **Secrets live in the Keychain/Keystore, never in MMKV.** The recovery phrase
  and imported keys are encrypted at rest; the master key that decrypts them is
  a Keychain item marked `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so it is unreadable
  while the device is locked and is **never included in a device backup**.
- **MMKV is unencrypted and is backed up.** It holds encrypted vault blobs
  (useless without the device-only key) plus activity metadata — the withdrawal
  journal, pending orders, addresses. Treat it as readable by anyone holding a
  backup, and never put a secret there.
- **`EXPO_PUBLIC_` means published.** Expo inlines those variables into the JS
  bundle, which the dev server also serves over the LAN. `.env` is gitignored,
  and `src/hyperliquid/config/envGuards.test.ts` fails the build if key material
  or a suspicious name appears under that prefix, or if any `.env` secret is
  hardcoded in the source tree.
- **Money paths are signed by the master wallet, not the agent.** Withdrawals
  and transfers need a real signature, and are gated behind a device-presence
  check.
- **An ambiguous outcome is never reported as a definite one.** A submit whose
  answer never arrived is `unknown`: the app offers no retry and claims no
  failure, because a retry could place a second real order. This rule is load
  bearing — see the `offline` note in `CLAUDE.md`.

## Running it safely

- **Default to testnet.** `EXPO_PUBLIC_HL_ENV=testnet` is the shipped default.
  Keep it there unless you mean otherwise.
- **Use a throwaway wallet.** Import a key you would not mind losing. Do not
  reuse a key that holds mainnet funds.
- **Some scripts sign and move funds.** `bun run smoke` and `bun run smoke:account` are read-only. `smoke:sign`, `smoke:transfers`,
  `smoke:withdraw` and `smoke:vaults` sign real testnet actions and can move
  testnet balances. The end-to-end suite (`HL_E2E=1`) places and cancels a real
  resting order far from the mid.
- **`HL_TESTNET_SIGNER_KEY` is a disposable testnet key** for those scripts.
  Never put a mainnet key there, and never rename it under `EXPO_PUBLIC_`.

## Known limitations

Stated rather than hidden, because they are the things a reader would otherwise
report as findings:

- **MMKV is inside the iCloud/iTunes backup.** The key material is not (see
  above), so what a backup exposes is encrypted blobs plus activity metadata.
  Excluding the directory from backup needs a native config plugin and has not
  been done.
- **There is no remote kill switch and no key rotation UI.** A compromised
  device is a total compromise of the wallet on it.
- **The presence gate has never fired on real hardware.** It is implemented and
  unit-tested, but a simulator cannot exercise biometry.
- **This has not been audited.** No third party has reviewed this code. It is
  provided as is, with no warranty of any kind, and that is meant literally.
