# Contributing

Thanks for looking. This is a real-money trading client, so the bar is a little
different from a typical app: a bug here can cost someone their position.

**Security bugs do not go in issues.** See [SECURITY.md](SECURITY.md).

## Before you start

Read [CLAUDE.md](CLAUDE.md). It is the working notes for this codebase —
architecture, conventions, and a list of traps that were each paid for once.
Most surprises in the code are explained there, and a change that contradicts
it usually needs to explain why.

## The checks

```bash
bun run typecheck && bun run lint && bun run test
```

All three must pass. `bun run test` runs Jest — **not** `bun test`, which is a
different runner that ignores the config and fails in ways that look like code
bugs.

If you touched `src/hyperliquid/state/` or `src/hyperliquid/api/`, also run
`bun run smoke`. It checks live payload shapes against testnet, which is the
class of breakage unit tests cannot see.

## Tests

A test that guards behaviour must be **revert-verified**: reintroduce the bug,
watch the test fail, then restore. This is not ceremony. An audit of this
codebase found five guards that were passing against broken code — a
`JSON.stringify` on an Error that is always `"{}"`, a case-sensitive regex that
missed the one spelling that mattered, a scan that skipped every single-line
call site. Each looked thorough and checked nothing.

If your guard matches a pattern, give it a self-test on the shapes it is meant
to catch. The real files are usually clean, so they exercise nothing.

## Money paths

Changes under `orders/`, `transfers/`, `vaults/` or `wallet/` get more
scrutiny, and a few rules are absolute:

- Wire prices and sizes stay **strings**; `BigNumber` for maths; `Number()`
  only at a display leaf.
- An outcome you do not know is `unknown` — never reported as success or
  failure, never offered a retry.
- Every order, cancel, modify and transfer threads the acting account
  (`actingRoute`), or it silently signs for the wrong one.
- Nothing secret goes to MMKV, to a log, or under an `EXPO_PUBLIC_` name.

Guard tests enforce the last two and will fail the build.

## Style

Prettier and ESLint decide; run `bun run format`. Beyond that: comments explain
_why_, especially when the code looks wrong and is not — that is what most of
the existing ones are doing, and it is the house style.

## Commits and PRs

Describe what changes and why it is safe. If you fixed a bug, say how you
verified it — for anything on a money path, "the tests pass" is not by itself
an answer, because the tests passing is how several of these bugs survived.
