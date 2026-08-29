/**
 * Generates `src/theme/tokenIcons.generated.ts` — the token artwork this app
 * can actually use, and nothing else.
 *
 * ## Why this exists
 *
 * `@web3icons/core` ships 1,554 tokens × 3 variants as raw SVG strings behind a
 * barrel export. The lookup is dynamic (`ICONS[ticker]`), so nothing can be
 * tree-shaken, and importing the barrel puts **every** icon in the bundle.
 *
 * Measured with `expo export --platform ios`:
 *
 * | Bundle | Size |
 * | --- | --- |
 * | without the icon barrel | **12.97 MB** |
 * | with the icon barrel | **29.34 MB** |
 *
 * **+16.4 MB — the bundle more than doubles** to ship artwork for ~123 markets
 * out of 1,554 icons. Subpath imports (`@web3icons/core/svgs/tokens/...`) do
 * not rescue it either: the path has to be a literal for Metro to resolve it,
 * and the ticker is only known at runtime.
 *
 * So the set is resolved here, at build time, against Hyperliquid's own live
 * metadata, and emitted as a plain map.
 *
 * ## Staleness is the tradeoff, and it is the right one
 *
 * A market listed after the last run renders the monogram fallback until this
 * is re-run. That is already the common case — 109 of 232 mainnet perps have no
 * artwork at all — so the fallback is a designed state rather than a defect,
 * and a missing logo costs nothing while 16 MB costs every user on every
 * install.
 *
 * Re-run with:  bun run icons:generate
 */

import { writeFileSync } from "node:fs";
import { svgs } from "@web3icons/core";

import { stripSvgFilters } from "./svgFilters";
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";

const OUT = "src/theme/tokenIcons.generated.ts";
const ICONS = svgs.tokens.background as Record<string, { default: string } | undefined>;

/** Every ticker this app might show, from both networks. */
async function liveTickers(): Promise<Set<string>> {
  const tickers = new Set<string>();

  for (const isTestnet of [false, true]) {
    const info = new InfoClient({ transport: new HttpTransport({ isTestnet }) });
    try {
      const meta = (await info.meta()) as { universe: { name: string }[] };
      for (const asset of meta.universe) tickers.add(asset.name);

      const spot = (await info.spotMeta()) as { tokens: { name: string }[] };
      for (const token of spot.tokens) tickers.add(token.name);
    } catch (error) {
      // A network failure must not silently emit a smaller map than last time.
      throw new Error(
        `Could not read ${isTestnet ? "testnet" : "mainnet"} metadata: ${String(error)}`
      );
    }
  }
  return tickers;
}

/**
 * The icon key for a ticker, mirroring `tokenIcon.ts`'s resolution.
 *
 * Kept in sync deliberately: if the runtime strips Hyperliquid's `k` prefix but
 * the generator does not, `kPEPE` resolves at runtime to an icon that was never
 * emitted, and the lookup silently returns the fallback.
 */
function iconKeyFor(ticker: string): string | null {
  const direct = ticker.toLowerCase();
  if (ICONS[direct]?.default) return direct;

  if (/^k./.test(ticker)) {
    const stripped = ticker.slice(1).toLowerCase();
    if (ICONS[stripped]?.default) return stripped;
  }
  return null;
}

async function main(): Promise<void> {
  const tickers = [...(await liveTickers())].sort();
  const wanted = new Map<string, string>();

  for (const ticker of tickers) {
    const key = iconKeyFor(ticker);
    if (key === null) continue;
    const svg = ICONS[key]?.default;
    if (svg) wanted.set(key, stripSvgFilters(svg));
  }

  const entries = [...wanted.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, svg]) => `  ${JSON.stringify(key)}: ${JSON.stringify(svg)},`)
    .join("\n");

  const bytes = [...wanted.values()].reduce((total, svg) => total + svg.length, 0);

  const file = `/**
 * GENERATED — do not edit. Run \`bun run icons:generate\`.
 *
 * Token artwork for the markets Hyperliquid actually lists, resolved against
 * live mainnet and testnet metadata. See \`scripts/generate-token-icons.ts\` for
 * why this is generated rather than imported: the full \`@web3icons/core\` barrel
 * adds **16.4 MB** to the iOS bundle (12.97 MB → 29.34 MB) because the lookup is
 * dynamic and nothing tree-shakes.
 *
 * ${wanted.size} icons, ${(bytes / 1024).toFixed(0)} KB of SVG.
 * Tickers seen across both networks at generation time: ${tickers.length}.
 *
 * A market listed after the last run renders the monogram fallback — which is
 * already the common case, so it is a designed state, not a defect.
 */

export const TOKEN_ICONS: Record<string, string> = {
${entries}
};
`;

  writeFileSync(OUT, file);
  console.log(
    `${OUT}: ${wanted.size} icons, ${(bytes / 1024).toFixed(0)} KB ` +
      `(from ${tickers.length} live tickers, ${Object.keys(ICONS).length} available)`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
