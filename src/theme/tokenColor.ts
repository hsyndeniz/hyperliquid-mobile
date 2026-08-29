/**
 * A token's brand colour, for identity — never for status.
 *
 * `tokenIcon.ts` used to say brand-colour extraction was deliberately absent,
 * on the grounds that every colour on these screens is a semantic `Chip` the
 * design system owns. That reasoning still holds for STATUS — up/down, danger,
 * success — and nothing here touches it. The distinction it missed is that a
 * row also has to answer *which asset is this*, and there the brand colour is
 * the fastest signal available: the eye finds orange-for-BTC before it reads
 * the letters.
 *
 * So: identity may be branded, status stays semantic.
 *
 * ## Where the colour comes from
 *
 * The generated artwork is `@web3icons`' **background** variant, which paints
 * the brand colour as a full-bleed 24×24 square behind the mark. That square is
 * the brand colour by construction, so it is read first — 150 of the 193 icons
 * carry one, and it needs no guessing.
 *
 * It is not enough on its own. `algo` is black, `air` is white, `ai` is very
 * nearly black — full-bleed squares that are unusable as a tint. When the
 * square fails the legibility test below, every fill in the icon is scored
 * instead and the most vivid mid-tone wins.
 *
 * ## Why the result is normalised
 *
 * A tint has to survive both themes. A pale fill (ETH's near-white facet)
 * washes out on a light card; a near-black one vanishes on a dark card. The
 * winner is therefore pushed into a band — a floor on saturation, a ceiling and
 * floor on lightness — so the same value reads in both. That deliberately
 * shifts some brands slightly off their official hex; a tint that is invisible
 * half the time is worse than one that is a shade out.
 *
 * `null` means the icon is monochrome or absent, and the caller should fall
 * back to the theme accent rather than invent something.
 */

import { tokenIconSvg } from "@/theme/tokenIcon";

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** Below this saturation a fill is grey, black or white — never a brand. */
const MIN_USABLE_SATURATION = 0.2;
/** The band the winner is normalised into, so it reads on both themes. */
const FLOOR_SATURATION = 0.45;
const FLOOR_LIGHTNESS = 0.3;
const CEILING_LIGHTNESS = 0.62;

/** The full-bleed background square the `background` variant draws. */
const FULL_BLEED = /fill="(#[0-9a-fA-F]{3,8})"[^>]*d="M24 0H0v24h24z"/;
const ANY_HEX = /#[0-9a-fA-F]{3,8}\b/g;

/** `#abc` and `#aabbccdd` both normalise to `#aabbcc`. */
export function normalizeHex(hex: string): string | null {
  const body = hex.slice(1);
  if (body.length === 3) {
    const [r, g, b] = body;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (body.length === 6 || body.length === 8) return `#${body.slice(0, 6)}`.toLowerCase();
  return null;
}

export function hexToHsl(hex: string): Hsl {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) *
    60;
  return { h, s, l };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  const channel = (v: number): string =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * How well a colour survives being a tint on both a light and a dark card.
 *
 * Penalises the two failure directions separately, because they are not
 * symmetric: a pale fill on white disappears completely, while a dark fill on
 * black at least keeps its shape. Zero means unusable.
 */
function legibility({ s, l }: Hsl): number {
  if (s < MIN_USABLE_SATURATION) return 0;
  const fit = 1 - Math.max(0, l - 0.5) * 1.8 - Math.max(0, 0.3 - l) * 1.5;
  return s * Math.max(0, fit);
}

function normalize(hsl: Hsl): string {
  return hslToHex({
    h: hsl.h,
    s: Math.max(hsl.s, FLOOR_SATURATION),
    l: Math.min(Math.max(hsl.l, FLOOR_LIGHTNESS), CEILING_LIGHTNESS),
  });
}

/** The brand colour of an icon's SVG source, or `null` if it has none usable. */
export function brandColorOfSvg(svg: string): string | null {
  const bleed = svg.match(FULL_BLEED)?.[1];
  const bleedHex = bleed ? normalizeHex(bleed) : null;
  if (bleedHex !== null) {
    const hsl = hexToHsl(bleedHex);
    if (legibility(hsl) > 0) return normalize(hsl);
  }

  // No usable background square — score every fill and take the most vivid
  // mid-tone. This is what rescues the icons whose backdrop is black or white.
  let best: { hsl: Hsl; score: number } | null = null;
  for (const raw of new Set(svg.match(ANY_HEX) ?? [])) {
    const hex = normalizeHex(raw);
    if (hex === null) continue;
    const hsl = hexToHsl(hex);
    const score = legibility(hsl);
    if (score > 0 && (best === null || score > best.score)) best = { hsl, score };
  }
  return best === null ? null : normalize(best.hsl);
}

/** Memoised per wire coin: the SVG never changes, and rows re-render on every tick. */
const cache = new Map<string, string | null>();

/**
 * The brand colour for a wire coin, or `null` to fall back to the theme accent.
 *
 * Takes the WIRE coin, not a ticker, so `kPEPE` and `xyz:BTC` resolve the same
 * way their artwork does — see `tokenIcon.ts` for why that distinction is not
 * cosmetic.
 */
export function tokenColor(coin: string): string | null {
  const cached = cache.get(coin);
  if (cached !== undefined) return cached;

  const svg = tokenIconSvg(coin);
  const color = svg === null ? null : brandColorOfSvg(svg);
  cache.set(coin, color);
  return color;
}

/** Black or white, whichever stays readable on `hex`. */
export function readableTextColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Rec. 601 luma: green dominates perceived brightness, blue barely registers.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#000000" : "#ffffff";
}

/** `hex` as `rgba()`, for a fill that fades out — Skia gradient stops take this. */
export function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
