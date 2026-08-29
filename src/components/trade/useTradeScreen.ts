/**
 * The trade surface's state assembly — everything the `/order` modal holds.
 *
 * Extracted when two surfaces (the since-removed Trade tab and the since-
 * retired `/trading` page) shared it; it stays a hook of its own because the
 * assembly is ~200 lines of rules with history in them, and the screen file
 * should read as layout. Three full trade pages consumed it before the modal;
 * a fourth skin costs a layout, not a second money path.
 *
 * ## The rules preserved from the tab screen's history
 *
 * - The coin's KIND is derived from the wire spelling, never stored where it
 *   could disagree.
 * - A `?coin=` param is adopted DURING RENDER, exactly once per navigation —
 *   the sanctioned reset pattern; a later in-screen choice is not overridden
 *   by the stale param still in the route.
 * - Persistence is a side effect of the coin changing, however it changed;
 *   one slot — the picker's kind tabs always return an explicit coin, so the
 *   per-kind slots the old Spot⇄Perps segment used are gone with it.
 * - Perp freshness is the ctx channel's own gate; spot's is the mids poll
 *   going quiet.
 *
 * ## What the HL-mobile redesign removed (2026-08-18)
 *
 * The two-view chart⇄form toggle, the candle feed, and the 24H range are gone
 * from this screen — the compact header shows pair + price + change only, and
 * the chart returns in a later pass. Dropping the feed here is deliberate
 * economics, not tidiness: the candle seed cost ~35 weight per market switch
 * for a range display the new header does not have. Spot⇄Perps switching
 * lives in the picker's tabs now, so `switchKind` is gone too.
 *
 * The asset's leverage pair (`useAssetLeverage`) is owned HERE, once, and
 * passed down: the control bar's pills, both sheets, and the ticket's margin
 * math must all read the SAME server-confirmed value — two hook instances
 * would double the REST reads and could briefly disagree after an apply.
 */

import { useCallback, useEffect, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";

import { BigNumber } from "bignumber.js";

import { changeTrend, kindOfWireCoin } from "@/components/markets/marketsView";
import { type OrderSide, type OrderType, type TicketContext } from "@/components/trade/orderForm";
import { priceIsStale } from "@/components/trade/tradeView";
import type { TradableKind } from "@/components/trade/tradeView";
import { hlConfig } from "@/hyperliquid/config/env";
import { useAccountSummary, usePosition, useSpotState } from "@/hyperliquid/hooks/account";
import { useMarketList, useMid, useMidsStale, usePerpAssetCtx } from "@/hyperliquid/hooks/markets";
import { useCanTrade, useSessionAddress, useSessionState } from "@/hyperliquid/hooks/session";
import { useFeeRates } from "@/hyperliquid/hooks/history";
import { maintenanceMarginRate } from "@/hyperliquid/core/precision";
import { useAssetLeverage } from "@/hyperliquid/hooks/leverage";
import type { MarketRow } from "@/hyperliquid/markets/rows";
import { hlStringStorage } from "@/hyperliquid/storage/mmkv";
import type { AssetCtxView } from "@/hyperliquid/state/assetCtx";
import type { SessionState } from "@/hyperliquid/session";
import type { HlEnv, Position } from "@/hyperliquid/types/domain";
import { useHyperliquid } from "@/providers/HyperliquidProvider";

/** The kind a persisted or pushed coin actually is — predictions read as perp
 *  defensively; the picker cannot produce one. */
export function tradableKindOf(coin: string): TradableKind {
  return kindOfWireCoin(coin) === "spot" ? "spot" : "perp";
}

/** The last market traded on EITHER side — what a fresh open restores. */
const TRADE_LAST_COIN_KEY = "hl:trade:lastCoin";

function initialCoin(param: string | undefined): string {
  if (param) return param;
  return hlStringStorage.getItem(TRADE_LAST_COIN_KEY) ?? "BTC";
}

export interface TradeScreenState {
  coin: string;
  kind: TradableKind;
  side: OrderSide;
  setSide: (side: OrderSide) => void;
  orderType: OrderType;
  setOrderType: (type: OrderType) => void;
  row: MarketRow | null;
  ctx: AssetCtxView | null;
  price: string | null;
  prevDayPx: string | null;
  trend: "up" | "down" | null;
  symbol: string;
  szDecimals: number | null;
  marketType: "perp" | "spot";
  isStale: boolean;
  position: Position | null;
  ticketCtx: TicketContext;
  /** The one shared leverage-pair instance — see the header docstring. */
  lev: ReturnType<typeof useAssetLeverage>;
  picked: { px: string; nonce: number } | null;
  pickPrice: (px: string) => void;
  sessionState: SessionState | null;
  env: HlEnv;
  openPicker: () => void;
  /**
   * Spending power per direction. The ticket shows a Buy AND a Sell button at
   * once, and on SPOT the two differ — USDC buying power against the base
   * token's balance converted at the reference price — so each button
   * previews and validates against its own. Equal on perps.
   */
  availableLong: string | null;
  availableShort: string | null;
}

export function useTradeScreen(): TradeScreenState {
  const params = useLocalSearchParams<{ coin?: string }>();
  const { session } = useHyperliquid();
  const sessionState = useSessionState(session);
  const env = sessionState?.config.env ?? hlConfig.env;

  const [coin, setCoin] = useState(() => initialCoin(params.coin));
  const [side, setSide] = useState<OrderSide>("long");
  const [orderType, setOrderType] = useState<OrderType>("market");

  const kind = tradableKindOf(coin);

  // Param adoption, during render — wins exactly once per navigation.
  const [adoptedParam, setAdoptedParam] = useState(params.coin);
  if (params.coin !== adoptedParam) {
    setAdoptedParam(params.coin);
    if (params.coin) setCoin(params.coin);
  }

  useEffect(() => {
    hlStringStorage.setItem(TRADE_LAST_COIN_KEY, coin);
  }, [coin]);

  const markets = useMarketList(env);
  const section = kind === "spot" ? markets.spot : markets.perps;
  const row =
    section.kind === "ready"
      ? (section.value.find((candidate) => candidate.wireCoin === coin) ?? null)
      : null;

  const { ctx, isStale: ctxStale } = usePerpAssetCtx(coin, kind, env);
  const midsStale = useMidsStale();

  const mid = useMid(coin);
  const price = mid ?? ctx?.midPx ?? ctx?.markPx ?? row?.px ?? null;
  // Follows the number actually RENDERED, not whichever channel happens to be
  // open — see `priceIsStale`, which owns the rule and is tested against it.
  const isStale = priceIsStale({
    mid,
    ctxPrice: ctx?.midPx ?? ctx?.markPx ?? null,
    midsStale,
    ctxStale,
  });
  const prevDayPx = ctx?.prevDayPx ?? row?.prevDayPx ?? null;
  const rawTrend = changeTrend(price, prevDayPx);
  const trend = rawTrend === "up" || rawTrend === "down" ? rawTrend : null;
  const symbol = row?.symbol ?? coin;
  const szDecimals = row?.szDecimals ?? null;
  const marketType = kindOfWireCoin(coin) === "spot" ? "spot" : "perp";

  const openPicker = () => router.push({ pathname: "/pick-market", params: { kind } });

  const [picked, setPicked] = useState<{ px: string; nonce: number } | null>(null);
  const pickPrice = useCallback((px: string) => {
    setPicked((current) => ({ px, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  const position = usePosition(session.stores.account, coin);
  const summary = useAccountSummary(session.stores.account);
  const spotState = useSpotState(session.stores.spot);
  const canTrade = useCanTrade(session);
  const lev = useAssetLeverage(session, coin, kind);
  // 20 weight, cached 60s and keyed on the user — the Portfolio tab reads the
  // same endpoint, so a visit that has already been there costs nothing.
  // `useSessionAddress`, not `session.address()`: the latter is a plain method
  // and would not re-render this screen on an account switch.
  const feeRates = useFeeRates(useSessionAddress(session));

  const spotAvailable = (token: string): string | null =>
    spotState?.balances.find((balance) => balance.coin === token)?.available ?? null;
  // `available` is USDC EVERYWHERE downstream — the ticket labels it "USDC"
  // and maxSizeFor divides it by price. A spot SELL's spending power is the
  // base-token balance, so it must be converted at the reference price here,
  // rounded DOWN (overstating sell power proposes an unfillable oversell).
  // No price yet → null, honestly, rather than a base amount wearing a USDC
  // label (12.5 HYPE read as $12.5 capped sells at a fraction of the balance
  // — the adversarial review's finding).
  const sellPower = (): string | null => {
    const base = spotAvailable(symbol);
    const px = mid ?? row?.px ?? null;
    if (base === null || px === null) return null;
    return new BigNumber(base).times(px).toFixed(6, BigNumber.ROUND_DOWN);
  };
  // Spending power is SIDE-DEPENDENT on spot and side-independent on perps.
  // Both are computed because the ticket now shows a Buy AND a Sell button at
  // once: each one previews and validates against its own power, so a spot
  // sell can never be sized against the USDC balance (or the reverse).
  const availableFor = (which: OrderSide): string | null => {
    if (sessionState === null) return null;
    if (kind === "perp") return summary?.withdrawable ?? null;
    return which === "long" ? spotAvailable("USDC") : sellPower();
  };
  const availableLong = availableFor("long");
  const availableShort = availableFor("short");
  const available = side === "long" ? availableLong : availableShort;

  const fees = feeRates.state.kind === "ready" ? feeRates.state.value : null;

  const ticketCtx: TicketContext = {
    kind,
    marketType,
    symbol,
    szDecimals,
    markPx: ctx?.markPx ?? null,
    midPx: mid ?? ctx?.midPx ?? null,
    available,
    // The tokens actually held, unpriced — a spot SELL is capped by this and
    // never by `available`, whose USDC conversion at the mid does not survive
    // a limit price that differs from it.
    baseAvailable: marketType === "spot" ? spotAvailable(symbol) : null,
    positionSize: position?.size ?? null,
    // The margin math sizes against the CHOSEN pair when the server has
    // confirmed one, then the open position's, then 1 — never the ASSET CAP.
    // `row.maxLeverage` is the ceiling the market permits, not anything this
    // account has set. While the leverage read is deferred by the weight budget
    // it made `maxSizeFor` offer 40x of notional on BTC under a card still
    // reading "Leverage 1x", so the slider's 100% stop sized a position the
    // account could not margin. Under-sizing is recoverable; over-sizing is not.
    leverage: lev.value?.leverage ?? position?.leverage ?? 1,
    // The tier-0 rule (1 / 2·maxLeverage) — perp only, since spot has no
    // liquidation to estimate. `orderInfo` guards on marketType too.
    maintenanceMarginRate: kind === "perp" ? maintenanceMarginRate(row?.maxLeverage ?? null) : null,
    // The account's REAL rates once the read lands, per market kind. The
    // perp taker rate is the referral-adjusted one — `crossRate` is the
    // published rate before a discount the account may actually receive.
    takerFeeRate:
      fees === null ? null : kind === "perp" ? fees.effectiveTakerRate : fees.spotCrossRate,
    makerFeeRate: fees === null ? null : kind === "perp" ? fees.addRate : fees.spotAddRate,
    isSignedIn: sessionState !== null,
    canTrade,
  };

  return {
    coin,
    kind,
    side,
    setSide,
    orderType,
    setOrderType,
    row,
    ctx,
    price,
    prevDayPx,
    trend,
    symbol,
    szDecimals,
    marketType,
    isStale,
    position,
    ticketCtx,
    lev,
    picked,
    pickPrice,
    sessionState,
    env,
    openPicker,
    /** Spending power per direction — the dual Buy/Sell buttons need both. */
    availableLong,
    availableShort,
  };
}
