/**
 * Every text element names its typeface.
 *
 * SF Pro Rounded only applies through explicit `font-*` classes — a text
 * component without one silently falls back to the system font, and the miss
 * is invisible in review because the two faces are close. This walks the
 * source the way `screenGuards.test.ts` does and fails on any text tag with
 * no font source.
 *
 * The parser is brace-aware on purpose: a template-literal `className` does
 * not match a naive `className="…"` regex, and the first attempt at this
 * sweep misread every one of them as missing — then "fixed" them by
 * flattening the template, which destroyed conditional tones and
 * `numberOfLines` across eighteen files. The check must see attributes the
 * way JSX does or it is worse than no check.
 *
 * A tag passes when its attributes carry `font-` (a class), `fontFamily` (a
 * style), or forward `className={className}` verbatim (the caller owns it).
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SRC = __dirname;

const TEXT_TAGS =
  /(?:Typography\.\w+|Chip\.Label|Button\.Label|Segment\.Label|Tabs\.Label|EmptyState\.Title|EmptyState\.Description|ListGroup\.ItemTitle|ListGroup\.ItemDescription)/;
const OPEN = new RegExp(`<(${TEXT_TAGS.source})\\b`, "g");

function* tsxFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* tsxFiles(path);
    } else if (entry.endsWith(".tsx")) {
      yield path;
    }
  }
}

/** The attribute text of each opening tag, read with JSX's own brace rules. */
function* tagAttrs(source: string): Generator<{ line: number; name: string; attrs: string }> {
  OPEN.lastIndex = 0;
  for (let m = OPEN.exec(source); m !== null; m = OPEN.exec(source)) {
    let i = m.index + m[0].length;
    let depth = 0;
    let inString: string | null = null;
    while (i < source.length) {
      const c = source[i];
      if (inString !== null) {
        if (c === inString && source[i - 1] !== "\\") inString = null;
      } else if (c === '"' || c === "'" || c === "`") {
        inString = c;
      } else if (c === "{") {
        depth += 1;
      } else if (c === "}") {
        depth -= 1;
      } else if (c === ">" && depth === 0) {
        break;
      }
      i += 1;
    }
    yield {
      line: source.slice(0, m.index).split("\n").length,
      name: m[1]!,
      attrs: source.slice(m.index + m[0].length, i),
    };
  }
}

it("every text tag names its typeface", () => {
  const missing: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    for (const { line, name, attrs } of tagAttrs(source)) {
      const hasFont =
        attrs.includes("font-") ||
        attrs.includes("fontFamily") ||
        attrs.includes("className={className}");
      if (!hasFont) missing.push(`${file.slice(SRC.length + 1)}:${line} <${name}>`);
    }
  }
  expect(missing).toEqual([]);
});
