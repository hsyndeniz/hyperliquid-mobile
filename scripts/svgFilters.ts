/**
 * Build-time removal of SVG filter primitives from token artwork.
 *
 * `@web3icons/core` ships several icons straight out of Figma with its
 * drop/inner-shadow stack intact — `feFlood` -> `feBlend` -> `feGaussianBlur`
 * -> `feColorMatrix`, one `<filter>` per shadowed shape. `ape` alone carries
 * **nine** of them.
 *
 * react-native-svg renders a filter by allocating an offscreen buffer and
 * running the blur and colour matrix on the MAIN THREAD inside
 * `-[RNSVGSvgView drawRect:]`. Profiled on the Markets tab (2026-08-27), that
 * path produced a **1045 ms** UI hang whose top frame was
 * `-[RNSVGFilter applyFilter:...]` in 94 of ~130 samples.
 *
 * The shadows buy nothing here: `CoinBadge` draws these into a 32 pt box
 * clipped by `overflow-hidden rounded-full`, where a few pixels of blur behind
 * the artwork are invisible. So they are stripped at generation rather than
 * paid for on every scroll.
 *
 * **Masks are deliberately kept.** A Figma shadow export often wraps the shape
 * in a `<mask>` so the shadow is clipped inside it; the mask also defines what
 * is visible. Dropping the filter leaves the element painting its normal fill,
 * which is the intended artwork — dropping the mask would change the shape.
 */

/** `<filter …>…</filter>` and the self-closing form. */
const FILTER_BLOCK = /<filter\b[^>]*(?:\/>|>[\s\S]*?<\/filter\s*>)/g;

/** `filter="url(#id)"` / `filter='url(#id)'` attribute references. */
const FILTER_ATTR = /\s+filter\s*=\s*(["'])\s*url\([^)]*\)\s*\1/g;

/**
 * Strip every filter definition and reference from an SVG string.
 *
 * Both halves are removed together: a reference left pointing at a definition
 * that no longer exists is undefined behaviour across renderers, and a
 * definition left behind with no reference is dead bytes in the bundle.
 */
export function stripSvgFilters(svg: string): string {
  return svg.replace(FILTER_BLOCK, "").replace(FILTER_ATTR, "");
}

/** True when the string still carries anything on the filter path. */
export function hasSvgFilters(svg: string): boolean {
  return /<filter\b/.test(svg) || /\sfilter\s*=\s*["']\s*url\(/.test(svg);
}
