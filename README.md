# hl

A mobile client for [Hyperliquid](https://hyperliquid.xyz) — perps, spot,
vaults and HIP-4 prediction markets — built with Expo and React Native.

> [!WARNING]
> **This software signs transactions that move real money, and it has not been
> audited.** It defaults to testnet. Read [SECURITY.md](SECURITY.md) before
> pointing it at mainnet, and use a wallet you would not mind losing.
> Nothing here is financial advice.

## What it does

- **Markets** — live order books, candles and a searchable list across perps,
  spot and prediction markets.
- **Trading** — market, limit, stop and take-profit orders, scale ladders and
  TWAPs, with attached TP/SL and per-position bracket management.
- **Portfolio** — positions, open orders, balances, fills, funding, transfers
  and order history.
- **Vaults** — the vault directory, per-vault detail, and deposits/withdrawals
  with lockup handling.
- **Money** — deposits over the Arbitrum bridge, withdrawals, sends, and
  perp↔spot moves.

## Running it

Requires [Bun](https://bun.sh), Xcode 26+ for iOS, and Node 20+.

```bash
bun install
cp .env.example .env
bun run ios
```

This is a **dev-client** project, not Expo Go: it contains native modules, so
the first run builds the app. `bun run start` alone only starts Metro.

`.env.example` documents every variable. The defaults point at testnet and
disable builder fees; you do not need to fill anything in to run it.

## Checks

```bash
bun run typecheck
bun run lint
bun run test          # Jest. Not `bun test` — they are different runners.
bun run smoke         # read-only, against live testnet
```

`bun run smoke` is the canary that unit tests cannot be: it opens real
subscriptions against live testnet and asserts the payload shapes the app
depends on. Run it after touching anything under `src/hyperliquid/state/` or
`src/hyperliquid/api/`.

Some scripts sign and move testnet funds — see
[SECURITY.md](SECURITY.md#running-it-safely) for which.

## How it is organised

```
src/
  app/          expo-router routes — the whole navigator is this directory
  components/   screens and UI, grouped by feature
  hyperliquid/  the headless client: no React, no components
  theme/        tokens, token icons
```

`src/hyperliquid/` is the part worth reading first. It is a complete
Hyperliquid client with no UI dependency: transports and rate-limit budget,
stores and websocket channels, order building and submission with a durable
journal, wallet and agent lifecycle, transfers, vaults, and prediction markets.

A few rules hold across it, and the code will look strange if you do not know
them:

- **Wire prices and sizes are strings.** `BigNumber` for arithmetic, `Number()`
  only at a display leaf. A float in a trading path loses tick precision
  silently.
- **A submit whose answer never arrived is `unknown`** — never a success, never
  a failure. The app offers no retry, because a retry could place a second real
  order; a journal and a reconciler settle it instead.
- **One module owns each dangerous thing**: asset-ID arithmetic, identity keys,
  logging and redaction, bridge addresses. Duplicating any of them is how the
  copies drift.

[CLAUDE.md](CLAUDE.md) is the working notes for the codebase — architecture,
conventions, and a long list of traps with the measurements behind them. It is
written for contributors (human or otherwise) and is the best map of the
project's sharp edges.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: every change keeps
`typecheck`, `lint` and `test` green, and a test that guards behaviour must be
verified by reverting the behaviour and watching it fail.

## Licence

MIT. The `LICENSE` file is added at publish time.
