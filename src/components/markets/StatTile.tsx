/**
 * One market statistic as a labelled tile — the extraction of the portfolio
 * screen's `EquityTile`, driven by `detailView`'s `StatTile` data.
 *
 * The tile renders whatever the view module decided: `value: null` is `"--"`
 * and the label never vanishes — a vanished "Funding / hr" reads as "this
 * market has no funding", a different claim than "not loaded yet". `tone`
 * colours only where sign IS meaning (funding), through the same semantic
 * classes `signColor` uses elsewhere.
 */

import type { JSX } from "react";
import { View } from "react-native";
import { Surface, Typography } from "heroui-native";

import type { StatTile as StatTileData } from "@/components/markets/detailView";

function toneClass(tone: StatTileData["tone"]): string {
  if (tone === "up") return "text-success";
  if (tone === "down") return "text-danger";
  if (tone === "neutral") return "text-muted";
  return "";
}

export function StatTile({
  tile,
  dimmed = false,
}: {
  tile: StatTileData;
  /** Stale live source: last-known values dim rather than blank. */
  dimmed?: boolean;
}): JSX.Element {
  return (
    <Surface variant="secondary" className="flex-1 gap-1 rounded-xl px-3 py-3">
      <Typography.Paragraph className="text-xs text-muted font-normal" numberOfLines={1}>
        {tile.label}
      </Typography.Paragraph>
      <Typography.Paragraph
        className={`text-sm font-semibold tabular-nums ${toneClass(tile.tone)} ${
          dimmed ? "opacity-50" : ""
        }`}
        numberOfLines={1}
      >
        {tile.value ?? "--"}
      </Typography.Paragraph>
    </Surface>
  );
}

/**
 * Tiles in rows of two. The pairing is not decoration: `perpStatTiles`
 * returns card order (Mark·Oracle / Volume·OI / Funding·Max lev), and two
 * columns is what keeps "Open interest" from truncating on a phone. An odd
 * final tile spans the row alone.
 */
export function StatTileGrid({
  tiles,
  dimmed = false,
}: {
  tiles: readonly StatTileData[];
  dimmed?: boolean;
}): JSX.Element {
  const rows: StatTileData[][] = [];
  for (let i = 0; i < tiles.length; i += 2) {
    rows.push(tiles.slice(i, i + 2) as StatTileData[]);
  }
  return (
    <View className="gap-2">
      {rows.map((pair) => (
        <View key={pair[0]!.label} className="flex-row gap-2">
          {pair.map((tile) => (
            <StatTile key={tile.label} tile={tile} dimmed={dimmed} />
          ))}
        </View>
      ))}
    </View>
  );
}
