import { hasSvgFilters, stripSvgFilters } from "./svgFilters";

/** The exact shape `@web3icons/core` ships for `ape` — a Figma shadow export. */
const FIGMA_SHADOW = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">
  <defs>
    <linearGradient id="APE__A" x1="2.108" x2="20.545"><stop offset=".125" stop-color="#89D0FF"/></linearGradient>
    <filter id="APE__b" width="42.208" height="36.85" x="-8.791" y="-6.796" color-interpolation-filters="sRGB" filterUnits="userSpaceOnUse">
      <feFlood flood-opacity="0" result="BackgroundImageFix"/>
      <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
      <feGaussianBlur result="effect1" stdDeviation="2"/>
      <feColorMatrix values="0 0 0 0 0"/>
      <feBlend in2="shape" result="effect1_innerShadow"/>
      <feColorMatrix values="0 0 0 0 1"/>
    </filter>
  </defs>
  <mask id="APE__m"><path d="M0 0h24v24H0z" fill="#fff"/></mask>
  <g mask="url(#APE__m)"><path d="M4 4h16v16H4z" fill="url(#APE__A)" filter="url(#APE__b)"/></g>
</svg>`;

describe("stripSvgFilters", () => {
  const out = stripSvgFilters(FIGMA_SHADOW);

  it("removes the filter definition", () => {
    expect(FIGMA_SHADOW).toContain("<filter");
    expect(out).not.toContain("<filter");
  });

  it("removes every filter primitive inside it", () => {
    for (const prim of ["feFlood", "feBlend", "feGaussianBlur", "feColorMatrix"]) {
      expect(FIGMA_SHADOW).toContain(prim);
      expect(out).not.toContain(prim);
    }
  });

  it("removes the attribute that referenced it", () => {
    expect(FIGMA_SHADOW).toContain('filter="url(#APE__b)"');
    expect(out).not.toContain('filter="url(');
  });

  it("keeps the mask — it defines the visible shape, not the shadow", () => {
    expect(out).toContain('<mask id="APE__m">');
    expect(out).toContain('mask="url(#APE__m)"');
  });

  it("keeps the gradient and the geometry it fills", () => {
    expect(out).toContain('<linearGradient id="APE__A"');
    expect(out).toContain('fill="url(#APE__A)"');
    expect(out).toContain('<path d="M4 4h16v16H4z"');
  });

  it("leaves an svg with no filters untouched", () => {
    const plain = '<svg><path d="M0 0h1v1H0z" fill="#fff"/></svg>';
    expect(stripSvgFilters(plain)).toBe(plain);
  });

  it("handles the self-closing filter form", () => {
    expect(stripSvgFilters('<svg><filter id="a"/><path d="M0 0"/></svg>')).toBe(
      '<svg><path d="M0 0"/></svg>'
    );
  });

  it("removes single-quoted references too", () => {
    expect(stripSvgFilters("<svg><path filter='url(#a)' d='M0'/></svg>")).toBe(
      "<svg><path d='M0'/></svg>"
    );
  });

  it("is idempotent", () => {
    expect(stripSvgFilters(out)).toBe(out);
  });

  it("strips every filter when several are present", () => {
    const many = `<svg>${'<filter id="x"><feBlend/></filter>'.repeat(9)}<path/></svg>`;
    expect(stripSvgFilters(many)).toBe("<svg><path/></svg>");
  });
});

describe("hasSvgFilters", () => {
  it("reports the definition", () => {
    expect(hasSvgFilters('<svg><filter id="a"/></svg>')).toBe(true);
  });

  it("reports a dangling reference even with no definition", () => {
    expect(hasSvgFilters('<svg><path filter="url(#a)"/></svg>')).toBe(true);
  });

  it("is false once stripped", () => {
    expect(hasSvgFilters(FIGMA_SHADOW)).toBe(true);
    expect(hasSvgFilters(stripSvgFilters(FIGMA_SHADOW))).toBe(false);
  });
});
