/**
 * Token artwork for a Hyperliquid **wire coin**.
 *
 * Artwork comes from `theme/tokenIcons.generated.ts`, **not** from
 * `@web3icons/core` directly. That barrel holds 1,554 tokens behind a dynamic
 * lookup, so nothing tree-shakes and importing it added **16.4 MB** to the iOS
 * bundle — measured, 12.97 MB to 29.34 MB. The generator resolves the ~231
 * markets Hyperliquid actually lists and emits 696 KB instead; run
 * `bun run icons:generate` after a new listing.
 *
 * Each icon is a raw SVG *string*, so it renders through `react-native-svg`'s
 * `SvgXml` with no Metro transformer involved — the `react-native-svg-transformer`
 * in this project is for `.svg` *files* and is not on this path at all.
 *
 * ## The part that is actually hard
 *
 * A `Position.coin` or `OpenOrderRow.coin` is **not a ticker**. The domain type
 * says so explicitly, and the icon set is keyed by lowercase ticker, so handing
 * it a raw wire coin misses on every non-trivial market:
 *
 * | Wire form | Example | Why the naive lookup fails |
 * | --- | --- | --- |
 * | builder dex | `xyz:BTC` | the dex prefix is not part of the ticker |
 * | spot pair id | `@107` | an index, not a name — no icon can exist |
 * | 1000x unit | `kPEPE` | Hyperliquid's `k` prefix means 1,000 PEPE |
 * | outcome share | `#12` / `+9930` | a prediction market, not a token |
 *
 * ## Coverage is partial, and that is the design constraint
 *
 * 231 icons cover 2,198 live tickers across both networks — WLD, WIF, ONDO, JTO
 * and many others are simply absent from the icon set under any spelling.
 *
 * So roughly half of every list renders a fallback. That makes the fallback a
 * first-class visual, not an error path: it must look deliberate beside a real
 * logo, which is why the caller renders a themed `Avatar.Fallback` monogram
 * rather than a broken-image slot.
 *
 * ## Brand colour lives next door
 *
 * This file used to say brand-colour extraction was deliberately absent, on the
 * grounds that status colour belongs to the design system rather than to an
 * SVG's fills. That still holds — and `tokenColor.ts` does not touch it. The
 * line it draws is between STATUS (up/down, danger, success: semantic, always)
 * and IDENTITY (which asset is this: branded, because the eye finds orange-for-
 * Bitcoin before it reads the letters).
 *
 * The `background` variant this file emits is what makes that possible: it
 * paints the brand colour as a full-bleed square behind the mark, so the colour
 * is already in the string. See `tokenColor.ts` for why reading it still needs
 * care — a third of those squares are black or white.
 */

import { parse, type JsxAST } from "react-native-svg";

import { TOKEN_ICONS } from "@/theme/tokenIcons.generated";

/**
 * The ticker inside a wire coin, or `null` when there cannot be one.
 *
 * Exported for its tests: every rule below is a real wire form observed on
 * Hyperliquid, and a regression here shows up as the wrong logo next to
 * someone's money rather than as an error.
 */
export function tickerOf(coin: string): string | null {
  // Spot pair ids (`@107`) and outcome markets (`#12`, `+9930`, `o5`) are
  // indices, not names. No artwork can exist, so do not guess at one.
  if (/^[@#+]/.test(coin)) return null;
  if (/^o\d+$/.test(coin)) return null;

  // A builder-dex market is `dex:TICKER`; the prefix names the venue.
  const withoutDex = coin.includes(":") ? (coin.split(":").pop() ?? "") : coin;
  if (withoutDex.length === 0) return null;

  return withoutDex;
}

/**
 * The SVG for a wire coin, or `null` when there is none.
 *
 * Tries the ticker as-is first, then without Hyperliquid's `k` (1,000×) prefix
 * — `kPEPE` is PEPE priced in thousands, and it is the same asset.
 */
export function tokenIconSvg(coin: string): string | null {
  const ticker = tickerOf(coin);
  if (ticker === null) return null;

  const direct = TOKEN_ICONS[ticker.toLowerCase()];
  if (direct) return direct;

  if (/^k./.test(ticker)) {
    return TOKEN_ICONS[ticker.slice(1).toLowerCase()] ?? null;
  }
  return null;
}

/**
 * The icon as a PARSED AST, cached per icon string.
 *
 * `SvgXml` memoises its parse with a per-instance `useMemo`, so a recycled
 * list row re-parses the whole string on every mount — measured at ~1.9 ms a
 * row in dev on the Markets list, where a fling mounts rows continuously.
 * Parsing here once per ICON (icons are shared across coins — `kPEPE` and
 * `PEPE` resolve to one string) and rendering through `SvgAst` makes a
 * recycled mount a map lookup.
 *
 * The AST is shared by reference across every mounted badge; `SvgAst` only
 * READS it, so sharing is safe.
 */
const AST_CACHE = new Map<string, JsxAST | null>();

export function tokenIconAst(coin: string): JsxAST | null {
  const svg = tokenIconSvg(coin);
  if (svg === null) return null;
  const held = AST_CACHE.get(svg);
  if (held !== undefined) return held;
  const ast = parse(svg);
  AST_CACHE.set(svg, ast);
  return ast;
}

/**
 * One or two letters for the fallback monogram.
 *
 * Takes the *ticker*, so `xyz:BTC` reads `BT` rather than `XY` — a fallback
 * that names the venue instead of the asset is worse than no fallback.
 */
export function tokenMonogram(coin: string): string {
  const ticker = tickerOf(coin);
  if (ticker === null) {
    // Keep the marker for pair ids and outcome shares: `@107` reads `107`,
    // which is at least the thing the user sees elsewhere in the app.
    return (
      coin
        .replace(/^[@#+]/, "")
        .slice(0, 3)
        .toUpperCase() || "?"
    );
  }
  const letters = ticker.replace(/[^a-zA-Z]/g, "");
  return (letters.slice(0, 2) || ticker.slice(0, 2)).toUpperCase();
}
