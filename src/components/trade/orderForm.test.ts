/**
 * The order ticket's pure rules, pinned.
 *
 * The pins that guard real money:
 *
 * - `fieldsFor` returns `tif: false` for every trigger type — a tif on a
 *   trigger leg pushes it into the `limit` branch of the wire's `t` union and
 *   silently downgrades a TP/SL to a plain limit order (orders/build.ts).
 * - `sizeForFraction` returns the max VERBATIM at full drag, so Max and the
 *   slider's right edge are byte-identical and cannot strand dust.
 * - `maxSizeFor` answers `null` (UNKNOWN) for an unread balance, never `"0"`
 *   — a zero would render a disabled Max over a possibly-funded account.
 * - `orderBlockers` enforces the $10 floor nothing else in src enforces
 *   (`assertMinNotional` has zero callers) and TWAP's separate $100 floor.
 * - `orderInfo` hands `calculateLiquidationPrice` an UNSIGNED size and
 *   absorbs every throw/null path into `"--"` — a half-typed ticket hits
 *   those paths on every keystroke.
 * - `ctaState` is disabled in EVERY branch except signed-out: the boundary of
 *   this pass is stated, never faked with a live-looking dead button.
 */

import {
  acceptPercentEdit,
  referencePriceOf,
  acceptDecimalEdit,
  ctaState,
  fieldsFor,
  footFigures,
  formatRuntime,
  fractionOfSize,
  maxSizeFor,
  notionalFromSize,
  ORDER_TYPE_LABEL,
  orderBlockers,
  orderInfo,
  parseRuntimeMinutes,
  priceDecimalsOf,
  sizeDecimalsOf,
  sizeForFraction,
  sizeFromNotional,
  triggerShapeOf,
  TWAP_MAX_MINUTES,
  TWAP_MIN_MINUTES,
  TWAP_MIN_NOTIONAL_USDC,
  type OrderType,
  type TicketContext,
  type TicketState,
} from "@/components/trade/orderForm";

const ALL_TYPES = Object.keys(ORDER_TYPE_LABEL) as OrderType[];
const TRIGGER_TYPES: OrderType[] = ["stopMarket", "stopLimit", "takeMarket", "takeLimit"];

function ticket(overrides: Partial<TicketState> = {}): TicketState {
  return {
    type: "limit",
    side: "long",
    sizeUnit: "base",
    size: "",
    price: "",
    triggerPrice: "",
    scaleStart: "",
    scaleEnd: "",
    legCount: "",
    runtime: "",
    tif: "Gtc",
    reduceOnly: false,
    randomize: false,
    tpEnabled: false,
    tpPrice: "",
    slEnabled: false,
    slPrice: "",
    ...overrides,
  };
}

function context(overrides: Partial<TicketContext> = {}): TicketContext {
  return {
    kind: "perp",
    marketType: "perp",
    symbol: "BTC",
    baseAvailable: null,
    szDecimals: 3,
    markPx: "63000",
    midPx: "63001",
    available: "1000",
    positionSize: null,
    leverage: 10,
    maintenanceMarginRate: "0.01",
    takerFeeRate: "0.00045",
    makerFeeRate: "0.00015",
    isSignedIn: true,
    canTrade: true,
    ...overrides,
  };
}

describe("ORDER_TYPE_LABEL and triggerShapeOf", () => {
  it("carries the reference's exact display names, in menu order", () => {
    // Object.keys of the label map IS the order-type menu — the property
    // order is load-bearing, so it is pinned alongside the spellings.
    expect(ALL_TYPES).toEqual([
      "market",
      "limit",
      "scale",
      "stopLimit",
      "stopMarket",
      "takeLimit",
      "takeMarket",
      "twap",
    ]);
    expect(ORDER_TYPE_LABEL).toEqual({
      market: "Market",
      limit: "Limit",
      scale: "Scale",
      stopLimit: "Stop Limit",
      stopMarket: "Stop Market",
      takeLimit: "Take Limit",
      takeMarket: "Take Market",
      twap: "TWAP",
    });
  });

  it("re-exports the TWAP bounds from the module that enforces them", () => {
    expect(TWAP_MIN_MINUTES).toBe(5);
    expect(TWAP_MAX_MINUTES).toBe(1440);
    expect(TWAP_MIN_NOTIONAL_USDC).toBe(100);
  });

  it("maps stops to sl and takes to tp, Market suffix to isMarket", () => {
    // One inverted cell here places a take-profit that fires as a stop.
    expect(triggerShapeOf("stopMarket")).toEqual({ tpsl: "sl", isMarket: true });
    expect(triggerShapeOf("stopLimit")).toEqual({ tpsl: "sl", isMarket: false });
    expect(triggerShapeOf("takeMarket")).toEqual({ tpsl: "tp", isMarket: true });
    expect(triggerShapeOf("takeLimit")).toEqual({ tpsl: "tp", isMarket: false });
  });

  it("is null for the four non-trigger types", () => {
    for (const type of ["market", "limit", "scale", "twap"] as const) {
      expect(triggerShapeOf(type)).toBeNull();
    }
  });
});

describe("fieldsFor", () => {
  it("NEVER offers tif on a trigger type", () => {
    // A tif on a trigger leg pushes the object into the `limit` branch of the
    // `t` union and silently downgrades the TP/SL to a plain limit order at
    // the trigger price (orders/build.ts:326-328). The control is not
    // rendered, not merely disabled — this flag is that rule.
    for (const type of TRIGGER_TYPES) {
      expect(fieldsFor(type, "perp").tif).toBe(false);
      expect(fieldsFor(type, "spot").tif).toBe(false);
    }
  });

  it("offers tif on limit only — scale rests Gtc, a TWAP carries none", () => {
    expect(fieldsFor("limit", "perp").tif).toBe(true);
    for (const type of ["market", "scale", "twap"] as const) {
      expect(fieldsFor(type, "perp").tif).toBe(false);
    }
  });

  it("offers the unit toggle everywhere except scale", () => {
    for (const type of ALL_TYPES) {
      expect(fieldsFor(type, "perp").sizeUnitToggle).toBe(type !== "scale");
    }
  });

  it("offers runtime and randomize on twap only", () => {
    for (const type of ALL_TYPES) {
      expect(fieldsFor(type, "perp").runtime).toBe(type === "twap");
      expect(fieldsFor(type, "perp").randomize).toBe(type === "twap");
    }
  });

  it("offers slippage only where execution is at market", () => {
    for (const type of ALL_TYPES) {
      const expected = type === "market" || type === "stopMarket" || type === "takeMarket";
      expect(fieldsFor(type, "perp").slippage).toBe(expected);
    }
  });

  it("asks for a price on the limit-shaped types and a trigger on the trigger types", () => {
    for (const type of ALL_TYPES) {
      const fields = fieldsFor(type, "perp");
      expect(fields.price).toBe(type === "limit" || type === "stopLimit" || type === "takeLimit");
      expect(fields.triggerPrice).toBe(TRIGGER_TYPES.includes(type));
      expect(fields.scaleRange).toBe(type === "scale");
    }
  });

  it("offers the TP/SL attach on market and limit, on perps only", () => {
    // A trigger type IS a TP/SL, a ladder has no single entry to bracket, and
    // spot has no position for the bracket to act on.
    for (const type of ALL_TYPES) {
      expect(fieldsFor(type, "perp").tpslAttach).toBe(type === "market" || type === "limit");
      expect(fieldsFor(type, "spot").tpslAttach).toBe(false);
    }
  });

  it("offers reduce-only on perps and never on spot", () => {
    // Spot has no position to reduce; the checkbox's wire meaning does not
    // exist there, and rendering it would be an untruth about the account.
    for (const type of ALL_TYPES) {
      expect(fieldsFor(type, "perp").reduceOnly).toBe(true);
      expect(fieldsFor(type, "spot").reduceOnly).toBe(false);
    }
  });
});

describe("acceptDecimalEdit", () => {
  it("keeps the acceptEdit contract: digits, one dot, rejection is a no-op null", () => {
    expect(acceptDecimalEdit("2", 6)).toBe("2");
    expect(acceptDecimalEdit("2.", 6)).toBe("2.");
    expect(acceptDecimalEdit("2.5", 6)).toBe("2.5");
    expect(acceptDecimalEdit("1.2.", 6)).toBeNull();
  });

  it("turns a leading dot into a leading zero", () => {
    expect(acceptDecimalEdit(".", 6)).toBe("0.");
    expect(acceptDecimalEdit(".5", 6)).toBe("0.5");
  });

  it("strips leading zeros without eating the one that matters", () => {
    expect(acceptDecimalEdit("007", 6)).toBe("7");
    expect(acceptDecimalEdit("0", 6)).toBe("0");
    expect(acceptDecimalEdit("0.", 6)).toBe("0.");
  });

  it("REJECTS signs, exponents and spaces", () => {
    expect(acceptDecimalEdit("1e5", 6)).toBeNull();
    expect(acceptDecimalEdit("-1", 6)).toBeNull();
    expect(acceptDecimalEdit("1 000", 6)).toBeNull();
  });

  it("allows clearing back to empty and caps pathological length", () => {
    expect(acceptDecimalEdit("", 6)).toBe("");
    expect(acceptDecimalEdit("1".repeat(20), 6)).toBe("1".repeat(20));
    expect(acceptDecimalEdit("1".repeat(21), 6)).toBeNull();
  });

  it("caps decimals PER ASSET — the thing acceptEdit's fixed 6 cannot do", () => {
    // A szDecimals=2 coin must refuse the sixth decimal a USDC field accepts…
    expect(acceptDecimalEdit("1.123456", 2)).toBeNull();
    expect(acceptDecimalEdit("1.12", 2)).toBe("1.12");
    // …and an 8-decimal spot price must accept what USDC's cap would refuse.
    expect(acceptDecimalEdit("0.12345678", 8)).toBe("0.12345678");
    expect(acceptDecimalEdit("0.123456789", 8)).toBeNull();
  });

  it("REJECTS any dot at all at decimals 0", () => {
    // Whole-share outcome markets: accepting even "2." leaves a field that
    // can never become a legal size, so the dot itself is inert.
    expect(acceptDecimalEdit("2.", 0)).toBeNull();
    expect(acceptDecimalEdit(".", 0)).toBeNull();
    expect(acceptDecimalEdit("0.5", 0)).toBeNull();
    expect(acceptDecimalEdit("25", 0)).toBe("25");
  });
  it("accepts the LOCALE comma as a decimal separator", () => {
    // The bug: a `decimal-pad` in a comma locale (most of Europe, and this
    // project's own simulator) offers ONLY "," as a separator. Every press was
    // rejected here, so a fractional price or size could not be typed at all —
    // and on a sub-1-USDC asset that made the field unusable. Three of the
    // four call sites had forgotten to normalise first, which is why the
    // normalisation now lives inside this function.
    expect(acceptDecimalEdit("0,5", 4)).toBe("0.5");
    expect(acceptDecimalEdit(",5", 4)).toBe("0.5");
    expect(acceptDecimalEdit("1234,5678", 4)).toBe("1234.5678");
  });

  it("does not let normalising make an invalid string valid", () => {
    // "1,5,5" becomes "1.5.5" and is refused for two dots — the same answer a
    // dot-locale user typing "1.5.5" gets.
    expect(acceptDecimalEdit("1,5,5", 4)).toBeNull();
    // The fraction cap still applies after normalising.
    expect(acceptDecimalEdit("1,55555", 2)).toBeNull();
    // Whole-number fields still refuse any separator at all.
    expect(acceptDecimalEdit("2,", 0)).toBeNull();
  });
});

describe("sizeDecimalsOf and priceDecimalsOf", () => {
  it("passes szDecimals through and falls back to whole shares for outcomes", () => {
    expect(sizeDecimalsOf(3)).toBe(3);
    expect(sizeDecimalsOf(0)).toBe(0);
    expect(sizeDecimalsOf(null)).toBe(0);
  });

  it("derives the price cap from the perp/spot ceiling, clamped at zero", () => {
    expect(priceDecimalsOf(2, "perp")).toBe(4);
    expect(priceDecimalsOf(0, "spot")).toBe(8);
    expect(priceDecimalsOf(7, "perp")).toBe(0);
  });

  it("uses the OUTCOME PRICE fallback (1), never the size fallback (0)", () => {
    // The two fallbacks differ and that is the whole outcome-market trap: a
    // null szDecimals must yield 5 price decimals (6 − 1), not 6 (6 − 0).
    expect(priceDecimalsOf(null, "perp")).toBe(5);
  });
});

describe("sizeForFraction and fractionOfSize", () => {
  it("returns the max VERBATIM at or past full drag", () => {
    // Byte-identical, not merely equal in value: Max and the slider's right
    // edge must produce the same string, or the two paths differ by dust.
    expect(sizeForFraction("3.9260", 1, 3)).toBe("3.9260");
    expect(sizeForFraction("3.9260", 1.2, 3)).toBe("3.9260");
  });

  it("rounds DOWN to the asset's lot, not to 6 USDC decimals", () => {
    expect(sizeForFraction("10", 1 / 3, 3)).toBe("3.333");
    expect(sizeForFraction("10", 1 / 3, 0)).toBe("3");
  });

  it("returns the empty field at zero and below — never the illegal size 0", () => {
    expect(sizeForFraction("10", 0, 3)).toBe("");
    expect(sizeForFraction("10", -0.5, 3)).toBe("");
    // A thumb nudge worth less than one lot is an empty ticket, not "0".
    expect(sizeForFraction("10", 1e-9, 6)).toBe("");
  });

  it("is empty while the max is unknown or unusable", () => {
    expect(sizeForFraction(null, 0.5, 3)).toBe("");
    expect(sizeForFraction("abc", 0.5, 3)).toBe("");
    expect(sizeForFraction("0", 0.5, 3)).toBe("");
  });

  it("clamps the reverse mapping into [0,1] and answers 0 for the unknowable", () => {
    expect(fractionOfSize("5", "10")).toBe(0.5);
    expect(fractionOfSize("30", "10")).toBe(1);
    expect(fractionOfSize("5", null)).toBe(0);
    expect(fractionOfSize(".", "10")).toBe(0);
    expect(fractionOfSize("5", "0")).toBe(0);
  });
});

describe("sizeFromNotional and notionalFromSize", () => {
  it("converts quote to base, rounded DOWN to the lot", () => {
    expect(sizeFromNotional("630", "63000", 3)).toBe("0.01");
    expect(sizeFromNotional("100", "63000", 3)).toBe("0.001");
  });

  it("is empty for a notional below one lot — never the illegal 0", () => {
    expect(sizeFromNotional("1", "63000", 3)).toBe("");
  });

  it("is empty on any unusable input", () => {
    expect(sizeFromNotional("100", null, 3)).toBe("");
    expect(sizeFromNotional("100", "0", 3)).toBe("");
    expect(sizeFromNotional("", "63000", 3)).toBe("");
    expect(sizeFromNotional("abc", "63000", 3)).toBe("");
  });

  it("converts base to quote at cents, rounded DOWN", () => {
    expect(notionalFromSize("0.01", "63000")).toBe("630");
    // 0.0001 x 63333 = 6.3333 — rounding up would show a notional the typed
    // size cannot reach.
    expect(notionalFromSize("0.0001", "63333")).toBe("6.33");
  });

  it("is empty on any unusable input in the quote direction too", () => {
    expect(notionalFromSize("0.01", null)).toBe("");
    expect(notionalFromSize("", "63000")).toBe("");
    expect(notionalFromSize("0.01", "-1")).toBe("");
  });
});

describe("maxSizeFor", () => {
  const base = {
    available: "1000",
    price: "63000",
    leverage: 10,
    szDecimals: 3,
    reduceOnly: false,
    positionSize: null,
  };

  it("returns null — UNKNOWN — for an unread balance, never '0'", () => {
    // "0" claims a measured empty account; null is what disables Max and
    // puts the reason in the caption (the AmountPad convention).
    expect(maxSizeFor({ ...base, available: null })).toBeNull();
  });

  it("returns null while the price is unread — a size needs a conversion", () => {
    expect(maxSizeFor({ ...base, price: null })).toBeNull();
  });

  it("is available x leverage / price, rounded DOWN to the lot", () => {
    // 1000 x 10 / 63000 = 0.15873… → 0.158, never rounded up past margin.
    expect(maxSizeFor(base)).toBe("0.158");
    expect(maxSizeFor({ ...base, leverage: 1 })).toBe("0.015");
  });

  it("answers a genuine '0' for a READ zero balance", () => {
    expect(maxSizeFor({ ...base, available: "0" })).toBe("0");
  });

  it("reduce-only caps at the position's UNSIGNED size and ignores margin", () => {
    // The sign is the side, not part of the quantity — a short of -2.5 has
    // 2.5 to close. Margin does not gate closing, so available is ignored.
    expect(maxSizeFor({ ...base, reduceOnly: true, positionSize: "-2.5" })).toBe("2.5");
    expect(maxSizeFor({ ...base, reduceOnly: true, positionSize: "2.5", available: null })).toBe(
      "2.5"
    );
  });

  it("reduce-only with an UNREAD position is null, not zero", () => {
    // Claiming "nothing to reduce" about a position nobody read would
    // disable a close that is actually legal.
    expect(maxSizeFor({ ...base, reduceOnly: true, positionSize: null })).toBeNull();
  });

  it("caps a SPOT SELL at the token balance, whatever the limit price is", () => {
    // The bug this guards: the screen converted the base balance to USDC at
    // the MID and this function divided it back by the ticket's own reference
    // price. With 100 HYPE at a mid of 40, `available` was "4000" — so a
    // limit sell at 50 capped at 80 (the whole balance became unsellable
    // above mid) and a limit sell at 20 capped at 200 (twice what is held).
    // A balance is not spending power; it must not be priced twice.
    const hype = { ...base, szDecimals: 2, available: "4000", baseCap: "100" };

    expect(maxSizeFor({ ...hype, price: "50" })).toBe("100");
    expect(maxSizeFor({ ...hype, price: "20" })).toBe("100");
    expect(maxSizeFor({ ...hype, price: "40" })).toBe("100");
  });

  it("answers a base cap before any price is known", () => {
    // A token balance needs no conversion, so Max works while the mid is
    // still unread — the priced path would answer null here.
    expect(maxSizeFor({ ...base, price: null, baseCap: "2.5" })).toBe("2.5");
  });

  it("rounds a base cap DOWN to the lot and reports a read zero as '0'", () => {
    expect(maxSizeFor({ ...base, baseCap: "2.5559" })).toBe("2.555");
    expect(maxSizeFor({ ...base, baseCap: "0" })).toBe("0");
  });

  it("ignores a base cap on the reduce-only path — the position still rules", () => {
    expect(maxSizeFor({ ...base, reduceOnly: true, positionSize: "2.5", baseCap: "99" })).toBe(
      "2.5"
    );
  });
});

describe("parseRuntimeMinutes and formatRuntime", () => {
  it("parses the unit forms and bare minutes to whole minutes", () => {
    expect(parseRuntimeMinutes("30m")).toBe(30);
    expect(parseRuntimeMinutes("2h")).toBe(120);
    expect(parseRuntimeMinutes("2h30m")).toBe(150);
    expect(parseRuntimeMinutes("1d")).toBe(1440);
    expect(parseRuntimeMinutes("90")).toBe(90);
    expect(parseRuntimeMinutes(" 45m ")).toBe(45);
  });

  it("accepts exactly the wire's bounds, 5..1440 inclusive", () => {
    // placeTwapOrder throws outside these; by then the action is spent.
    expect(parseRuntimeMinutes(String(TWAP_MIN_MINUTES))).toBe(TWAP_MIN_MINUTES);
    expect(parseRuntimeMinutes(String(TWAP_MAX_MINUTES))).toBe(TWAP_MAX_MINUTES);
    expect(parseRuntimeMinutes("4")).toBeNull();
    expect(parseRuntimeMinutes("1441")).toBeNull();
    expect(parseRuntimeMinutes("1d1m")).toBeNull();
    expect(parseRuntimeMinutes("0")).toBeNull();
  });

  it("rejects garbage and fractional segments", () => {
    expect(parseRuntimeMinutes("")).toBeNull();
    expect(parseRuntimeMinutes("abc")).toBeNull();
    expect(parseRuntimeMinutes("30s")).toBeNull();
    expect(parseRuntimeMinutes("1.5h")).toBeNull();
  });

  it("formats the echo and round-trips through the parser", () => {
    expect(formatRuntime(30)).toBe("30m");
    expect(formatRuntime(90)).toBe("1h 30m");
    expect(formatRuntime(1440)).toBe("1d");
    expect(formatRuntime(65)).toBe("1h 5m");
    expect(parseRuntimeMinutes(formatRuntime(90))).toBe(90);
    expect(formatRuntime(0)).toBe("--");
    expect(formatRuntime(2.5)).toBe("--");
  });
});

describe("orderBlockers", () => {
  it("signed out short-circuits to the single signedOut blocker", () => {
    const blockers = orderBlockers(ticket({ size: "🤡" }), context({ isSignedIn: false }));
    expect(blockers.map((entry) => entry.code)).toEqual(["signedOut"]);
  });

  it("puts noAgent first when signed in but unapproved", () => {
    const blockers = orderBlockers(ticket(), context({ canTrade: false }));
    expect(blockers[0]?.code).toBe("noAgent");
  });

  it("is empty for a valid limit ticket", () => {
    expect(orderBlockers(ticket({ price: "63000", size: "0.01" }), context())).toEqual([]);
  });

  it("enforces the $10 floor — the check assertMinNotional never gets to run", () => {
    // 0.0001 x 63000 = 6.30. Nothing in src calls assertMinNotional, and a
    // server-rejected order still burns an action from a budget earned only
    // by traded volume (orders/build.ts:66-69).
    const blockers = orderBlockers(ticket({ price: "63000", size: "0.0001" }), context());
    expect(blockers.map((entry) => entry.code)).toEqual(["belowMinNotional"]);
  });

  it("enforces TWAP's separate $100 floor at the mark", () => {
    // 0.001 x 63000 = 63 — clear of $10, refused by the wire at $100
    // (orders/exchange.ts:459, measured, arrives as an HTTP 200).
    const blockers = orderBlockers(
      ticket({ type: "twap", size: "0.001", runtime: "30m" }),
      context()
    );
    expect(blockers.map((entry) => entry.code)).toEqual(["belowTwapMinNotional"]);
    expect(
      orderBlockers(ticket({ type: "twap", size: "0.01", runtime: "30m" }), context())
    ).toEqual([]);
  });

  it("blocks a TWAP runtime outside 5..1440, after the size field", () => {
    const blockers = orderBlockers(
      ticket({ type: "twap", size: "0.01", runtime: "2m" }),
      context()
    );
    expect(blockers.map((entry) => entry.code)).toEqual(["runtimeOutOfRange"]);
    // Reading order: Total Size sits above Running Time on the TWAP form.
    const both = orderBlockers(ticket({ type: "twap", runtime: "nope" }), context());
    expect(both.map((entry) => entry.code)).toEqual(["noSize", "runtimeOutOfRange"]);
  });

  it("blocks market-execution types on a missing market price", () => {
    const blockers = orderBlockers(
      ticket({ type: "market", size: "0.01" }),
      context({ markPx: null, midPx: null })
    );
    expect(blockers.map((entry) => entry.code)).toEqual(["noPrice"]);
  });

  it("asks the trigger types for a trigger, the limit-shaped for a price", () => {
    const stopLimit = orderBlockers(ticket({ type: "stopLimit" }), context());
    expect(stopLimit.map((entry) => entry.code)).toEqual([
      "triggerRequired",
      "priceRequired",
      "noSize",
    ]);
    const stopMarket = orderBlockers(ticket({ type: "stopMarket", size: "0.01" }), context());
    expect(stopMarket.map((entry) => entry.code)).toEqual(["triggerRequired"]);
  });

  it("accepts size 0 ONLY on a trigger type — the whole-position encoding", () => {
    // On a trigger leg "0" means "the whole position" (formatSize would throw
    // on it anywhere else, orders/build.ts:349-353).
    expect(
      orderBlockers(ticket({ type: "stopMarket", triggerPrice: "60000", size: "0" }), context())
    ).toEqual([]);
    const market = orderBlockers(ticket({ type: "market", size: "0" }), context());
    expect(market.map((entry) => entry.code)).toEqual(["noSize"]);
  });

  it("needs a valid scale range and an integer leg count of at least 2", () => {
    const blockers = orderBlockers(
      ticket({ type: "scale", scaleEnd: "63000", legCount: "1", size: "0.05" }),
      context()
    );
    expect(blockers.map((entry) => entry.code)).toEqual(["scaleRangeInvalid", "legCountInvalid"]);
    expect(
      orderBlockers(
        ticket({
          type: "scale",
          scaleStart: "62000",
          scaleEnd: "63000",
          legCount: "5",
          size: "0.05",
        }),
        context()
      )
    ).toEqual([]);
  });

  it("checks the scale floor on the WORST leg, not the total", () => {
    // 0.001 across 2 legs: total notional 62.5 clears $10, but each leg
    // truncates to 0.000 at the lot — buildScaleOrder would throw per-leg
    // (orders/scale.ts:115), after the action was already being assembled.
    const blockers = orderBlockers(
      ticket({
        type: "scale",
        scaleStart: "62000",
        scaleEnd: "63000",
        legCount: "2",
        size: "0.001",
      }),
      context()
    );
    expect(blockers.map((entry) => entry.code)).toEqual(["belowMinNotional"]);
  });

  it("compares size against maxSizeFor and stays silent while the max is unknown", () => {
    const tooLarge = orderBlockers(ticket({ price: "63000", size: "1" }), context());
    expect(tooLarge.map((entry) => entry.code)).toEqual(["sizeTooLarge"]);
    // An unread balance must not accuse the size of being too large.
    expect(
      orderBlockers(ticket({ price: "63000", size: "1" }), context({ available: null }))
    ).toEqual([]);
  });

  it("caps a reduce-only ticket at the position's unsigned size", () => {
    const shortPosition = context({ positionSize: "-0.5" });
    const over = orderBlockers(
      ticket({ price: "63000", size: "1", reduceOnly: true }),
      shortPosition
    );
    expect(over.map((entry) => entry.code)).toEqual(["sizeTooLarge"]);
    expect(
      orderBlockers(ticket({ price: "63000", size: "0.4", reduceOnly: true }), shortPosition)
    ).toEqual([]);
  });

  it("never throws on garbage — a half-typed ticket is the normal state", () => {
    for (const type of ALL_TYPES) {
      expect(() =>
        orderBlockers(
          ticket({
            type,
            size: "-5",
            price: "NaN",
            triggerPrice: ".",
            scaleStart: "🤡",
            scaleEnd: "",
            legCount: "2.5",
            runtime: "yesterday",
          }),
          context({ szDecimals: null, markPx: "", available: "abc", leverage: Number.NaN })
        )
      ).not.toThrow();
    }
  });
});

describe("orderInfo", () => {
  it("prices a market ticket at the mark and derives margin from real leverage", () => {
    const info = orderInfo(ticket({ type: "market", size: "0.01" }), context());
    expect(info.orderValue).toBe("630.00");
    expect(info.marginRequired).toBe("63.00");
    expect(info.slippage).toBe("8.00%");
    expect(info.sizePerSuborder).toBeNull();
    expect(info.scaleRemainder).toBeNull();
  });

  it("estimates liquidation from an UNSIGNED size, on the correct side", () => {
    // `margin_available` is NET of maintenance margin, per Hyperliquid's own
    // definition — not the initial margin. Notional 630, margin 63,
    // maintenance 630 × 0.01 = 6.3, so margin_available = 56.7:
    //   long  = 63000 − (56.7 / 0.01) / 0.99 = 57272.727…
    //   short = 63000 + (56.7 / 0.01) / 1.01 = 68613.861…
    // These numbers were previously pinned one maintenance-margin too far from
    // the mark (56636.364 / 69237.624), which read as a cushion twice the real
    // one. Equivalent closed form for the long: entry × (1 − 1/L) / (1 − m).
    //
    // Passing a signed size would cancel two negations and put a short's
    // liquidation below its entry — the exact defect precision.ts throws on.
    const long = orderInfo(ticket({ type: "market", size: "0.01" }), context());
    expect(long.liquidationPrice).toBe("57272.727");
    const short = orderInfo(ticket({ type: "market", size: "0.01", side: "short" }), context());
    expect(short.liquidationPrice).toBe("68613.861");

    // The long estimate must sit CLOSER to entry than the naive gross-margin
    // figure — the direction of the bug, pinned so a regression is unambiguous.
    expect(Number(long.liquidationPrice)).toBeGreaterThan(56636.364);
  });

  it("absorbs every liquidation null/throw path into '--'", () => {
    // Zero denominator: mmr 1 on a long makes 1 − mmr = 0 — the divide-by-
    // zero contract returns null and must render as unknown, not crash.
    const zeroDenominator = orderInfo(
      ticket({ type: "market", size: "0.01" }),
      context({ maintenanceMarginRate: "1" })
    );
    expect(zeroDenominator.liquidationPrice).toBe("--");
    const unreadMmr = orderInfo(
      ticket({ type: "market", size: "0.01" }),
      context({ maintenanceMarginRate: null })
    );
    expect(unreadMmr.liquidationPrice).toBe("--");
    const garbageMmr = orderInfo(
      ticket({ type: "market", size: "0.01" }),
      context({ maintenanceMarginRate: "abc" })
    );
    expect(garbageMmr.liquidationPrice).toBe("--");
  });

  it("never shows a liquidation price on spot", () => {
    const info = orderInfo(
      ticket({ type: "market", size: "0.01" }),
      context({ kind: "spot", marketType: "spot", leverage: 1 })
    );
    expect(info.liquidationPrice).toBe("--");
  });

  it("renders '--' for every unknown — never a held zero", () => {
    const info = orderInfo(
      ticket({ type: "market" }),
      context({ takerFeeRate: null, makerFeeRate: null })
    );
    expect(info.orderValue).toBe("--");
    expect(info.marginRequired).toBe("--");
    expect(info.liquidationPrice).toBe("--");
    expect(info.fees).toBe("--");
  });

  it("shows the fee RATES as a taker/maker percentage pair, the reference's rendering", () => {
    // 0.00045 → "0.0450%". An absolute sub-cent fee would round to a "0.00"
    // that reads as free. The pair, because which one applies to a resting
    // GTC limit is the book's decision, not the ticket's.
    const info = orderInfo(ticket({ type: "market", size: "0.01" }), context());
    expect(info.fees).toBe("0.0450% / 0.0150%");
  });

  it("renders a maker REBATE as the negative it is", () => {
    // Rebate tiers exist; clamping one to zero hides money the user is owed.
    const info = orderInfo(
      ticket({ type: "market", size: "0.01" }),
      context({ makerFeeRate: "-0.00001" })
    );
    expect(info.fees).toBe("0.0450% / -0.0010%");
  });

  it("shows the half it knows rather than dropping to '--'", () => {
    const info = orderInfo(
      ticket({ type: "market", size: "0.01" }),
      context({ makerFeeRate: null })
    );
    expect(info.fees).toBe("0.0450%");
  });

  it("offers slippage only on market execution", () => {
    const info = orderInfo(ticket({ price: "63000", size: "0.01" }), context());
    expect(info.slippage).toBeNull();
  });

  it("divides a TWAP into two 30-second suborders per minute", () => {
    // 30 minutes = 60 suborders; 60 / 60 = 1.
    const info = orderInfo(ticket({ type: "twap", size: "60", runtime: "30m" }), context());
    expect(info.sizePerSuborder).toBe("1");
    const unparsed = orderInfo(ticket({ type: "twap", size: "60", runtime: "nope" }), context());
    expect(unparsed.sizePerSuborder).toBe("--");
  });

  it("reports the scale remainder lot truncation strands", () => {
    // 0.1 across 3 legs at 2 lot decimals: 0.03 x 3 = 0.09 placed, 0.01
    // stranded — the figure the reference implementation throws away.
    const info = orderInfo(
      ticket({
        type: "scale",
        scaleStart: "62000",
        scaleEnd: "63000",
        legCount: "3",
        size: "0.1",
      }),
      context({ szDecimals: 2 })
    );
    expect(info.scaleRemainder).toBe("0.01");
    expect(info.orderValue).toBe("6250.00");
    const invalid = orderInfo(ticket({ type: "scale", size: "0.1" }), context());
    expect(invalid.scaleRemainder).toBe("--");
  });

  it("treats a quote-unit size as the notional and derives the base", () => {
    const info = orderInfo(ticket({ type: "market", sizeUnit: "quote", size: "630" }), context());
    expect(info.orderValue).toBe("630.00");
    expect(info.marginRequired).toBe("63.00");
  });

  it("never throws on garbage", () => {
    for (const type of ALL_TYPES) {
      expect(() =>
        orderInfo(
          ticket({ type, size: "-5", price: ".", runtime: "🤡", legCount: "-1" }),
          context({ szDecimals: null, leverage: 0, markPx: "abc", midPx: null })
        )
      ).not.toThrow();
    }
  });
});

describe("footFigures", () => {
  it("picks exactly the two numbers that make a press wrong", () => {
    const info = orderInfo(ticket({ type: "market", size: "0.01" }), context());
    expect(footFigures(info)).toEqual({ liq: "57272.727", margin: "63.00" });
  });
});

describe("ctaState", () => {
  const valid = ticket({ price: "63000", size: "0.01" });

  it("signed out is the ONLY enabled branch — and it connects, not trades", () => {
    const state = ctaState([], valid, context({ isSignedIn: false }));
    expect(state).toEqual({
      label: "Connect wallet",
      tone: "primary",
      isDisabled: false,
      note: null,
    });
  });

  it("asks for agent approval when signed in but unapproved", () => {
    const state = ctaState(
      orderBlockers(valid, context({ canTrade: false })),
      valid,
      context({ canTrade: false })
    );
    expect(state.label).toBe("Approve trading to continue");
    expect(state.isDisabled).toBe(true);
  });

  it("surfaces the FIRST blocker's message on the real Buy/Sell label", () => {
    const blockers = orderBlockers(ticket(), context());
    const state = ctaState(blockers, ticket(), context());
    expect(state.label).toBe("Buy BTC");
    expect(state.isDisabled).toBe(true);
    expect(state.note).toBe(blockers[0]!.message);
  });

  it("ENABLES a valid ticket, with its real label and tone and no note", () => {
    // The money path went live 2026-08-18. The two honesty rules survive as
    // one invariant: the button is enabled EXACTLY when pressing it submits —
    // never an enabled no-op, never a disabled valid ticket.
    const buy = ctaState([], valid, context());
    expect(buy).toEqual({ label: "Buy BTC", tone: "primary", isDisabled: false, note: null });
    const sell = ctaState([], ticket({ ...valid, side: "short" }), context());
    expect(sell.label).toBe("Sell BTC");
    expect(sell.tone).toBe("danger");
    expect(sell.isDisabled).toBe(false);
  });

  it("stays disabled whenever ANYTHING blocks — only a clean ticket goes live", () => {
    // Gated agent: even a valid ticket is disabled.
    const gated = context({ canTrade: false });
    expect(ctaState(orderBlockers(valid, gated), valid, gated).isDisabled).toBe(true);
    // Blocked tickets: disabled with the first blocker's reason on the note.
    for (const t of [ticket(), ticket({ size: "🤡" })]) {
      const state = ctaState(orderBlockers(t, context()), t, context());
      expect(state.isDisabled).toBe(true);
      expect(state.note).not.toBeNull();
    }
  });

  it("never throws on garbage", () => {
    expect(() =>
      ctaState([], ticket({ size: "-5" }), context({ symbol: "", leverage: Number.NaN }))
    ).not.toThrow();
  });
});

describe("acceptPercentEdit", () => {
  it("accepts whole percents up to 100 and the empty string", () => {
    expect(acceptPercentEdit("")).toBe("");
    expect(acceptPercentEdit("0")).toBe("0");
    expect(acceptPercentEdit("7")).toBe("7");
    expect(acceptPercentEdit("100")).toBe("100");
  });

  it("refuses decimals, signs, and anything past 100", () => {
    expect(acceptPercentEdit("101")).toBeNull();
    expect(acceptPercentEdit("2.5")).toBeNull();
    expect(acceptPercentEdit("-3")).toBeNull();
    expect(acceptPercentEdit("1000")).toBeNull();
    expect(acceptPercentEdit("x")).toBeNull();
  });
});

describe("referencePriceOf (exported for the order sheet's anchor)", () => {
  const ctx = (over: Partial<TicketContext> = {}): TicketContext => ({
    kind: "perp",
    marketType: "perp",
    symbol: "BTC",
    baseAvailable: null,
    szDecimals: 5,
    markPx: "100",
    midPx: "101",
    available: "1000",
    positionSize: null,
    leverage: 10,
    maintenanceMarginRate: "0.0125",
    takerFeeRate: null,
    makerFeeRate: null,
    isSignedIn: true,
    canTrade: true,
    ...over,
  });
  const ticket = (over: Partial<TicketState>): TicketState => ({
    type: "market",
    side: "long",
    sizeUnit: "base",
    size: "",
    price: "",
    triggerPrice: "",
    scaleStart: "",
    scaleEnd: "",
    legCount: "2",
    runtime: "30m",
    tif: "Gtc",
    reduceOnly: false,
    randomize: false,
    tpEnabled: false,
    tpPrice: "",
    slEnabled: false,
    slPrice: "",
    ...over,
  });

  it("values market and twap at mark, mid as fallback", () => {
    expect(referencePriceOf(ticket({ type: "market" }), ctx())?.toFixed()).toBe("100");
    expect(referencePriceOf(ticket({ type: "twap" }), ctx({ markPx: null }))?.toFixed()).toBe(
      "101"
    );
  });

  it("values limit shapes at the typed price, null until one exists", () => {
    expect(referencePriceOf(ticket({ type: "limit", price: "95" }), ctx())?.toFixed()).toBe("95");
    expect(referencePriceOf(ticket({ type: "limit" }), ctx())).toBeNull();
    expect(referencePriceOf(ticket({ type: "stopLimit" }), ctx())).toBeNull();
  });

  it("values a market trigger at its trigger price", () => {
    expect(
      referencePriceOf(ticket({ type: "stopMarket", triggerPrice: "90" }), ctx())?.toFixed()
    ).toBe("90");
  });

  it("values a scale ladder at its mean — the anchor the sheet must share", () => {
    // The review finding: a mark-anchored slider over a mean-valued ladder
    // let a maxed slider produce a size the blocker then rejected.
    expect(
      referencePriceOf(
        ticket({ type: "scale", scaleStart: "92", scaleEnd: "88" }),
        ctx()
      )?.toFixed()
    ).toBe("90");
  });
});
