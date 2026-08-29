/**
 * The glyph that goes beside a market fact.
 *
 * Keyed by the label the `detailView` tile builders already produce, so the
 * facts and their computation stay where they are and only the presentation
 * gains an icon. An unknown label falls back rather than throwing — a new stat
 * should appear without a glyph, not crash the screen it was added to.
 */

import {
  Activity,
  BarChart3,
  Building2,
  Circle,
  Coins,
  Crosshair,
  FileText,
  Gauge,
  Layers,
  Percent,
  Tag,
  type LucideIcon,
} from "lucide-react-native";

const BY_LABEL: Record<string, LucideIcon> = {
  Mark: Activity,
  Oracle: Crosshair,
  "24h volume": BarChart3,
  "Open interest": Layers,
  "Funding / hr": Percent,
  "Max leverage": Gauge,
  "Circulating supply": Coins,
  "Total supply": Coins,
  "Full name": Tag,
  Contract: FileText,
  Quote: Coins,
  Venue: Building2,
};

export function statIcon(label: string): LucideIcon {
  return BY_LABEL[label] ?? Circle;
}
