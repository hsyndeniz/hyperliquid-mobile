/**
 * Alias layer over `@nktkas/hyperliquid` (0.33.3).
 *
 * Nothing outside this file imports SDK types directly. On an SDK bump, the
 * compiler points at this one file instead of every call site — which is the
 * whole reason it exists.
 *
 * It grows per phase rather than aliasing all ~78 endpoints up front; adding a
 * surface we do not use yet would be guessing at how we want to model it.
 * Current coverage: market data, account state, orders, candles, HIP-3 DEXs,
 * outcome markets.
 */

import type * as HL from "@nktkas/hyperliquid";
import type * as HLSigning from "@nktkas/hyperliquid/signing";

// ---------------------------------------------------------------------------
// Clients and transports
// ---------------------------------------------------------------------------

export type IInfoClient = HL.InfoClient;
export type IExchangeClient = HL.ExchangeClient;
export type ISubscriptionClient = HL.SubscriptionClient;
export type IHttpTransport = HL.HttpTransport;
export type IWebSocketTransport = HL.WebSocketTransport;
export type IWebSocketTransportOptions = HL.WebSocketTransportOptions;
export type IHttpTransportOptions = HL.HttpTransportOptions;

/** Every error the SDK throws derives from this. */
export type IHyperliquidError = HL.HyperliquidError;
export type IApiRequestError = HL.ApiRequestError;

// ---------------------------------------------------------------------------
// Market metadata
// ---------------------------------------------------------------------------

export type IMetaResponse = HL.MetaResponse;
export type IPerpsUniverseRaw = HL.MetaResponse["universe"][number];
export type IMetaAndAssetCtxsResponse = HL.MetaAndAssetCtxsResponse;
export type IAllPerpMetasResponse = HL.AllPerpMetasResponse;
export type IMarginTable = HL.MarginTableResponse;

export type ISpotMetaResponse = HL.SpotMetaResponse;
export type ISpotMetaAndAssetCtxsResponse = HL.SpotMetaAndAssetCtxsResponse;
export type ISpotToken = ISpotMetaResponse["tokens"][number];
export type ISpotUniverseRaw = ISpotMetaResponse["universe"][number];

/**
 * One asset context, derived from the combined-response tuples — the SDK types
 * the nullables correctly (`midPx/premium/impactPxs` null on bookless perps,
 * `midPx` null on thin spot pairs), which matches the live audit.
 */
export type IPerpAssetCtx = HL.MetaAndAssetCtxsResponse[1][number];
export type ISpotAssetCtx = HL.SpotMetaAndAssetCtxsResponse[1][number];

/** HIP-3 builder-deployed perp DEXs. `null` entries are the main DEX. */
export type IPerpDexsResponse = HL.PerpDexsResponse;
export type IPerpDex = NonNullable<IPerpDexsResponse[number]>;
export type IPerpDexLimitsResponse = HL.PerpDexLimitsResponse;
export type IPerpDexStatusResponse = HL.PerpDexStatusResponse;

/** Prediction / outcome markets. */
export type IOutcomeMetaResponse = HL.OutcomeMetaResponse;
export type IOutcomeTemplatesResponse = HL.OutcomeTemplatesResponse;

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

export type IAllMids = HL.AllMidsResponse;
export type IL2BookResponse = HL.L2BookResponse;
export type ICandle = HL.CandleSnapshotResponse[number];
export type ICandleSnapshotParameters = HL.CandleSnapshotParameters;
export type IRecentTrade = HL.RecentTradesResponse[number];
export type IFundingHistoryRecord = HL.FundingHistoryResponse[number];
export type IPredictedFundingEntry = HL.PredictedFundingsResponse[number];

// ---------------------------------------------------------------------------
// Account state
// ---------------------------------------------------------------------------

export type IClearinghouseState = HL.ClearinghouseStateResponse;
export type IPerpsAssetPosition = HL.ClearinghouseStateResponse["assetPositions"][number];
export type ISpotClearinghouseState = HL.SpotClearinghouseStateResponse;
export type IUserRole = HL.UserRoleResponse;
export type IUserFees = HL.UserFeesResponse;
export type IUserRateLimit = HL.UserRateLimitResponse;
export type IPortfolio = HL.PortfolioResponse;
export type IExtraAgents = HL.ExtraAgentsResponse;
export type IExtraAgent = IExtraAgents[number];
export type ISubAccounts = HL.SubAccounts2Response;

// ---------------------------------------------------------------------------
// Orders and fills
// ---------------------------------------------------------------------------

export type IOrderParams = HL.OrderParameters["orders"][number];
export type IOrderRequest = HL.OrderParameters;
export type IOrderResponse = HL.OrderSuccessResponse;
export type ICancelResponse = HL.CancelSuccessResponse;
export type IModifyResponse = HL.ModifySuccessResponse;
export type ITwapOrderResponse = HL.TwapOrderSuccessResponse;
export type ITwapCancelResponse = HL.TwapCancelSuccessResponse;
export type IApproveAgentResponse = HL.ApproveAgentSuccessResponse;
export type IFill = HL.UserFillsResponse[number];
export type IOpenOrders = HL.OpenOrdersResponse;
export type IHistoricalOrders = HL.HistoricalOrdersResponse;
export type IOrderStatusResponse = HL.OrderStatusResponse;

/**
 * Time-in-force values we expose to users.
 *
 * Deliberately narrower than the SDK's raw picklist: the wire type also carries
 * internal values such as `FrontendMarket` that must never reach a user-facing
 * order form. Widen only against the SDK source, never from memory.
 */
export type ITif = "Gtc" | "Ioc" | "Alo";

// ---------------------------------------------------------------------------
// Wallet / signing
// ---------------------------------------------------------------------------

/**
 * Anything that can sign EIP-712 for Hyperliquid. Notably satisfied by a plain
 * viem local account (`{ signTypedData, address }`), so no wrapper class is
 * needed for the agent wallet.
 *
 * Lives in the `/signing` subpath — the barrel re-exports only
 * `AbstractWalletError`.
 */
export type IAbstractWallet = HLSigning.AbstractWallet;
export type IViemLocalAccount = HLSigning.AbstractViemLocalAccount;
export type ISignature = HLSigning.Signature;

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/** Handle returned by every subscribe call; `unsubscribe` is the whole contract. */
export type ISubscriptionHandle = HL.ISubscription;
export type ISubscriptionOptions = HL.SubscriptionOptions;

// Market data events
export type IL2BookEvent = HL.L2BookWsEvent;
export type IBboEvent = HL.BboWsEvent;
export type IAllMidsEvent = HL.AllMidsWsEvent;
export type ITradesEvent = HL.TradesWsEvent;
export type ICandleEvent = HL.CandleWsEvent;
export type IActiveAssetCtxEvent = HL.ActiveAssetCtxWsEvent;
export type IActiveAssetDataEvent = HL.ActiveAssetDataWsEvent;

// Account events
export type IWebData3Event = HL.WebData3WsEvent;
export type IOrderUpdatesEvent = HL.OrderUpdatesWsEvent;
export type IUserEventsEvent = HL.UserEventsWsEvent;
export type IUserFillsEvent = HL.UserFillsWsEvent;
export type INotificationEvent = HL.NotificationWsEvent;

// Parameters
export type IL2BookSubParams = HL.L2BookWsParameters;
export type IBboSubParams = HL.BboWsParameters;
export type ITradesSubParams = HL.TradesWsParameters;
export type ICandleSubParams = HL.CandleWsParameters;
export type IOrderUpdatesSubParams = HL.OrderUpdatesWsParameters;
export type IUserEventsSubParams = HL.UserEventsWsParameters;
export type INotificationSubParams = HL.NotificationWsParameters;
export type IWebData3SubParams = HL.WebData3WsParameters;

/** A single order update, as `orderUpdates` reports it. */
export type IOrderUpdate = HL.OrderUpdatesWsEvent[number];

/** Candle wire shapes. Normalised into `Candle` (types/domain) at the boundary. */
export type ICandleWsEvent = HL.CandleWsEvent;
export type ICandleSnapshotResponse = HL.CandleSnapshotResponse;
