import { EventEmitter } from "events";
import { createModuleLogger } from "../utils/logger.js";
import { WINDOW_CONFIG, FIXED_POSITION_BUDGET_USD, STRATEGY } from "../types/index.js";
import {
  getDb,
  createSimulatedTrade,
  resolveTrade,
  updateTradeMinPrice,
  logAudit,
  loadOpenTradesWithMarkets,
  insertMarketIfNew,
} from "../db/client.js";
import * as schema from "../db/schema.js";
import { eq, and, desc, gte } from "drizzle-orm";

import { getMarketScanner, MarketScanner } from "./market-scanner.js";
import { getMarketWebSocketWatcher, MarketWebSocketWatcher } from "./market-ws-watcher.js";
import {
  getStrategyEngine,
  StrategyEngine,
  type MarketOpportunity,
  type Evaluation,
  type SkipReason,
} from "./strategy-engine.js";
import { forecastSettlement, rollingOutRange } from "./settlement-model.js";
import { simulateLimitBuy, simulateLimitSell, stopTriggerPrice } from "./execution-simulator.js";
import { getBtcPriceWatcher, BtcPriceWatcher } from "./btc-price-watcher.js";
import { marketNow } from "./market-clock.js";
import { getPolymarketClient, PolymarketClient } from "./polymarket-client.js";
import { PortfolioManager } from "./portfolio-manager.js";

import type {
  BookUpdateEvent,
  TradeEvent,
  MarketResolvedEvent,
  BtcPriceData,
} from "../interfaces/websocket-types.js";

const logger = createModuleLogger("market-orchestrator");

interface WindowSummary {
  bursts: number;
  firstBurstTau: number | null;
  lastBurstSide: string | null;
  minBurstAsk: number | null;
  minBurstAskTau: number | null;
  lastSkipReason: SkipReason | null;
  traded: boolean;
}

interface ActiveMarketState {
  marketId: string;
  conditionId: string | null;
  yesTokenId: string;
  noTokenId: string;
  outcomes: string[];
  question: string;
  slug: string | null;
  endDate: Date;
  /** Window-open TWAP; null until observed, and never inferred from anything else. */
  strike: number | null;
  lastPrices: Record<string, { bid: number; ask: number }>;
  summary: WindowSummary;
  resolved: boolean;
  rawMarket: unknown;
}

interface OpenPosition {
  tradeId: string;
  marketId: string;
  tokenId: string;
  outcomeLabel: string;
  entryPrice: number;
  entryShares: number;
  actualCost: number;
  marketEndDate: Date;
  minBid: number;
  remainingShares: number;
  exitGross: number;
  exitFees: number;
  stopTriggered: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (v: number | null, dp = 4) => (v === null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const CLEANUP_INTERVAL_MS = 10_000;

export class MarketOrchestrator extends EventEmitter {
  private scanner: MarketScanner = getMarketScanner();
  private wsWatcher: MarketWebSocketWatcher = getMarketWebSocketWatcher();
  private strategyEngine: StrategyEngine = getStrategyEngine();
  private btcWatcher: BtcPriceWatcher = getBtcPriceWatcher();
  private client: PolymarketClient = getPolymarketClient();
  readonly portfolioManager = new PortfolioManager();

  private activeMarkets = new Map<string, ActiveMarketState>();
  private conditionIdMap = new Map<string, string>();
  private tokenToMarket = new Map<string, string>();
  private openPositions = new Map<string, OpenPosition>();
  private inFlightTokenIds = new Set<string>();
  private resolutionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private running = false;
  private paused = false;
  private cycleCount = 0;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.portfolioManager.init();
    await this.loadOpenPositions();
    await this.loadActiveMarkets();
    this.fillStrikes();
    this.wireEvents();

    this.wsWatcher.start();
    await this.scanner.start();
    this.cleanupTimer = setInterval(() => this.cleanupExpiredMarkets(), CLEANUP_INTERVAL_MS);

    logger.info("Market orchestrator started");
  }

  stop(): void {
    this.running = false;
    this.scanner.stop();
    this.wsWatcher.stop();
    this.stopCleanupTimer();
    this.clearResolutionTimers();
  }

  /** Blocks new entries. Open positions keep their stop and still settle. */
  pause(): void {
    this.paused = true;
    this.scanner.stop();
    this.stopCleanupTimer();
    logger.warn("Paused");
  }

  async resume(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    await this.portfolioManager.reload();
    await this.scanner.start();
    this.cleanupTimer = setInterval(() => this.cleanupExpiredMarkets(), CLEANUP_INTERVAL_MS);
    logger.info("Resumed");
  }

  /**
   * Drop all in-memory session state so nothing from a wiped session can act
   * against the fresh portfolio. Markets are rediscovered on resume; the price
   * buffer survives, so a window whose open is still buffered gets its strike.
   */
  resetSessionState(): void {
    this.clearResolutionTimers();
    const subscribed = [...this.tokenToMarket.keys()];
    if (subscribed.length) this.wsWatcher.unsubscribe(subscribed);
    this.openPositions.clear();
    this.inFlightTokenIds.clear();
    this.activeMarkets.clear();
    this.conditionIdMap.clear();
    this.tokenToMarket.clear();
    this.cycleCount = 0;
    this.scanner.reset();
    this.strategyEngine.reset();
    logger.warn({ unsubscribedTokens: subscribed.length }, "Session state cleared");
  }

  isPaused(): boolean {
    return this.paused;
  }

  getStats() {
    return {
      running: this.running,
      paused: this.paused,
      activeMarkets: this.activeMarkets.size,
      openPositions: this.openPositions.size,
      cycleCount: this.cycleCount,
      scanner: { discoveredCount: this.scanner.getDiscoveredCount() },
      ws: this.wsWatcher.getStats(),
      strategy: this.strategyEngine.getStats(),
      btcConnected: this.btcWatcher.isConnected(),
      btcPrice: this.btcWatcher.getCurrentTwap()?.price ?? null,
      btcRawPrice: this.btcWatcher.getCurrentRaw()?.price ?? null,
      btcPriceAgeMs: this.btcWatcher.getTwapAgeMs(),
      btcRawAgeMs: this.btcWatcher.getRawAgeMs(),
      btcPriceFresh: this.btcWatcher.isPriceFresh(),
      rawSigma: this.btcWatcher.getRawSigma(STRATEGY.sigmaWindowMs),
    };
  }

  getLiveMarkets() {
    const now = marketNow();
    return [...this.activeMarkets.values()]
      .filter((m) => !m.resolved)
      .sort((a, b) => a.endDate.getTime() - b.endDate.getTime())
      .map((m) => {
        const endMs = m.endDate.getTime();
        const windowStartMs = endMs - WINDOW_CONFIG.durationMs;
        return {
          marketId: m.marketId,
          question: m.question,
          slug: m.slug,
          endDate: m.endDate.toISOString(),
          windowStart: new Date(windowStartMs).toISOString(),
          yesTokenId: m.yesTokenId,
          noTokenId: m.noTokenId,
          prices: { ...m.lastPrices },
          status: endMs <= now ? "ENDED" : windowStartMs <= now ? "ACTIVE" : "UPCOMING",
          hasPosition: this.hasOpenPositions(m.marketId),
          btcPriceAtWindowStart: m.strike,
        };
      });
  }

  getOpenPositionSnapshots() {
    const fraction = STRATEGY.stopLossFraction;
    return [...this.openPositions.values()].map((pos) => ({
      tradeId: pos.tradeId,
      tokenId: pos.tokenId,
      marketId: pos.marketId,
      minPriceDuringPosition: pos.minBid,
      stopLossPrice: stopTriggerPrice(pos.entryPrice, fraction),
      remainingShares: pos.remainingShares,
    }));
  }

  /** Cost basis of all open positions, not mark-to-market. */
  computeOpenPositionsValue(): number {
    let total = 0;
    for (const pos of this.openPositions.values()) total += pos.actualCost;
    return total;
  }

  private hasOpenPositions(marketId: string): boolean {
    for (const pos of this.openPositions.values()) if (pos.marketId === marketId) return true;
    return false;
  }

  private positionsOnToken(tokenId: string): OpenPosition[] {
    return [...this.openPositions.values()].filter((p) => p.tokenId === tokenId);
  }

  private stopCleanupTimer(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  private clearResolutionTimers(): void {
    for (const timer of this.resolutionTimers.values()) clearTimeout(timer);
    this.resolutionTimers.clear();
  }

  private wireEvents(): void {
    this.scanner.on("newMarket", ({ market }) => {
      try {
        this.onNewMarket(market);
      } catch (err) {
        logger.error({ err, marketId: market?.id }, "Error handling new market");
      }
    });
    this.wsWatcher.on("bookUpdate", (ev: BookUpdateEvent) => this.onBookUpdate(ev));
    this.wsWatcher.on("trade", (ev: TradeEvent) => this.onTrade(ev));
    this.wsWatcher.on("marketResolved", (ev: MarketResolvedEvent) => {
      this.onMarketResolved(ev).catch((err) => logger.error({ err }, "Error handling resolution"));
    });
    this.btcWatcher.on("twapUpdate", (tick: BtcPriceData) => {
      this.fillStrikes();
      this.refreshForecasts(tick);
    });
    this.strategyEngine.on("opportunityDetected", (opp: MarketOpportunity) => {
      this.onOpportunity(opp).catch((err) =>
        logger.error({ err, marketId: opp.marketId }, "Error handling opportunity"),
      );
    });
  }

  private activateMarket(params: {
    marketId: string;
    conditionId: string | null;
    tokenIds: string[];
    outcomes: string[];
    question: string;
    slug: string | null;
    endDate: Date;
    strike: number | null;
    rawMarket: unknown;
  }): void {
    const state: ActiveMarketState = {
      marketId: params.marketId,
      conditionId: params.conditionId,
      yesTokenId: params.tokenIds[0]!,
      noTokenId: params.tokenIds[1]!,
      outcomes: params.outcomes,
      question: params.question,
      slug: params.slug,
      endDate: params.endDate,
      strike: params.strike,
      lastPrices: {},
      summary: {
        bursts: 0,
        firstBurstTau: null,
        lastBurstSide: null,
        minBurstAsk: null,
        minBurstAskTau: null,
        lastSkipReason: null,
        traded: false,
      },
      resolved: false,
      rawMarket: params.rawMarket,
    };

    this.activeMarkets.set(state.marketId, state);
    this.tokenToMarket.set(state.yesTokenId, state.marketId);
    this.tokenToMarket.set(state.noTokenId, state.marketId);
    if (state.conditionId) this.conditionIdMap.set(state.conditionId, state.marketId);

    params.tokenIds.forEach((tokenId, i) =>
      this.strategyEngine.registerMarket(
        state.marketId,
        tokenId,
        params.outcomes[i] ?? `Outcome${i}`,
        state.endDate,
        state.strike,
      ),
    );
    this.wsWatcher.subscribe(params.tokenIds);

    logger.info(
      { marketId: state.marketId, slug: state.slug, endDate: state.endDate.toISOString(), strike: state.strike },
      "Market activated",
    );
  }

  private onNewMarket(market: any): void {
    if (this.paused || this.activeMarkets.has(market.id)) return;

    const tokenIds = PolymarketClient.parseClobTokenIds(market);
    const outcomes = PolymarketClient.parseOutcomes(market);
    if (tokenIds.length < 2 || outcomes.length < 2) {
      logger.warn({ marketId: market.id }, "Market missing token IDs or outcomes");
      return;
    }
    const endDate = market.endDate ? new Date(market.endDate) : new Date();
    if (endDate.getTime() < marketNow()) return;

    this.activateMarket({
      marketId: market.id,
      conditionId: market.conditionId ?? null,
      tokenIds,
      outcomes,
      question: market.question ?? "",
      slug: market.slug ?? null,
      endDate,
      strike: null,
      rawMarket: market,
    });
  }

  private async loadActiveMarkets(): Promise<void> {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const rows = await getDb()
      .select()
      .from(schema.markets)
      .where(
        and(
          eq(schema.markets.active, true),
          eq(schema.markets.windowType, WINDOW_CONFIG.category),
          gte(schema.markets.endDate, cutoff),
        ),
      )
      .orderBy(desc(schema.markets.endDate))
      .limit(50);

    const staleBefore = marketNow() - 30 * 60 * 1000;
    for (const row of rows) {
      if (this.activeMarkets.has(row.id)) continue;
      const tokenIds = (row.clobTokenIds as string[] | null) ?? [];
      const outcomes = (row.outcomes as string[] | null) ?? [];
      if (tokenIds.length < 2 || outcomes.length < 2) continue;
      const endDate = row.endDate ? new Date(row.endDate) : new Date();
      if (endDate.getTime() < staleBefore && !this.hasOpenPositions(row.id)) continue;

      this.activateMarket({
        marketId: row.id,
        conditionId: row.conditionId ?? null,
        tokenIds,
        outcomes,
        question: row.question ?? "",
        slug: row.slug ?? null,
        endDate,
        strike: row.targetPrice ? parseFloat(row.targetPrice) : null,
        rawMarket: row.metadata,
      });
    }
  }

  private async loadOpenPositions(): Promise<void> {
    const rows = await loadOpenTradesWithMarkets();
    for (const { trade, marketEndDate } of rows) {
      const shares = parseFloat(trade.entryShares);
      this.openPositions.set(trade.id, {
        tradeId: trade.id,
        marketId: trade.marketId ?? "",
        tokenId: trade.tokenId ?? "",
        outcomeLabel: trade.outcomeLabel ?? "",
        entryPrice: parseFloat(trade.entryPrice),
        entryShares: shares,
        actualCost: parseFloat(trade.actualCost ?? "0"),
        marketEndDate: marketEndDate ? new Date(marketEndDate) : new Date(),
        minBid: parseFloat(trade.minPriceDuringPosition ?? trade.entryPrice),
        remainingShares: shares,
        exitGross: 0,
        exitFees: 0,
        stopTriggered: false,
      });
      if (trade.marketId) this.scheduleSettlementWatch(trade.marketId);
    }
    if (rows.length) logger.info({ count: rows.length }, "Loaded open positions");
  }

  /** The strike is the settlement TWAP observed at the window open, nothing else. */
  private fillStrikes(): void {
    const now = marketNow();
    for (const state of this.activeMarkets.values()) {
      if (state.strike !== null) continue;
      const windowStartMs = state.endDate.getTime() - WINDOW_CONFIG.durationMs;
      if (now < windowStartMs) continue;
      const price = this.btcWatcher.getTwapAt(windowStartMs);
      if (price === null) continue;
      state.strike = price;
      this.strategyEngine.updateStrike(state.yesTokenId, price);
      this.strategyEngine.updateStrike(state.noTokenId, price);
      logger.info({ marketId: state.marketId, strike: price }, "Strike set");
    }
  }

  private onBookUpdate({ tokenId, bestBid, bestAsk }: BookUpdateEvent): void {
    if (bestBid === null || bestAsk === null) return;

    const marketId = this.tokenToMarket.get(tokenId);
    const state = marketId ? this.activeMarkets.get(marketId) : undefined;
    // Frozen after the window ends, but seeded once so a restart mid-window is not blank.
    if (state && (state.endDate.getTime() > marketNow() || !state.lastPrices[tokenId])) {
      state.lastPrices[tokenId] = { bid: bestBid, ask: bestAsk };
    }

    this.strategyEngine.updateQuote(tokenId, bestBid, bestAsk);

    const now = marketNow();
    const fraction = STRATEGY.stopLossFraction;
    for (const pos of this.positionsOnToken(tokenId)) {
      // Past the window end the book is thin and settlement decides; the stop never fires there.
      if (pos.marketEndDate.getTime() <= now) continue;
      if (bestBid < pos.minBid) {
        pos.minBid = bestBid;
        updateTradeMinPrice(pos.tradeId, bestBid.toFixed(6)).catch(() => {});
      }
      if (pos.stopTriggered || bestBid > stopTriggerPrice(pos.entryPrice, fraction)) continue;
      pos.stopTriggered = true;
      logger.warn({ tradeId: pos.tradeId, bestBid, entryPrice: pos.entryPrice }, "Stop triggered");
      this.submitStopLossExit(pos).catch((err) => {
        logger.error({ err, tradeId: pos.tradeId }, "Stop-loss exit failed");
        pos.stopTriggered = false;
      });
    }
  }

  /**
   * Spot must be read at the TWAP's own observation time. Both feeds lag by
   * about two seconds, and pairing a fresher spot with an older TWAP breaks
   * the identity the forecast rests on.
   */
  private refreshForecasts(tick: BtcPriceData): void {
    if (this.btcWatcher.getRawAgeMs() > STRATEGY.maxRawStalenessMs) return;
    const rawSigma = this.btcWatcher.getRawSigma(STRATEGY.sigmaWindowMs);
    if (!rawSigma) return;
    const anchorMs = tick.timestamp;
    const rawNow = this.btcWatcher.getRawAt(anchorMs);
    if (rawNow === null) return;

    for (const state of this.activeMarkets.values()) {
      const endMs = state.endDate.getTime();
      if (state.resolved || state.strike === null || endMs <= anchorMs) continue;
      const { fromMs, toMs } = rollingOutRange(anchorMs, endMs);
      const rollingOutMean = this.btcWatcher.getRawMean(fromMs, toMs);
      if (rollingOutMean === null) continue;
      const forecast = forecastSettlement({
        anchorMs,
        endMs,
        strike: state.strike,
        twapNow: tick.price,
        rawNow,
        rollingOutMean,
        rawSigma,
      });
      if (forecast) this.strategyEngine.updateForecast(state.marketId, forecast);
    }
  }

  private onTrade(ev: TradeEvent): void {
    const evaluation = this.strategyEngine.noteTrade(
      ev.tokenId,
      ev.takerSide,
      this.paused ? 0 : ev.size,
      ev.timestamp,
    );
    if (!evaluation || evaluation.skipReason === "outside_entry_window") return;
    const marketId = this.tokenToMarket.get(ev.tokenId);
    const s = marketId ? this.activeMarkets.get(marketId)?.summary : undefined;
    if (!s) return;

    s.bursts++;
    s.lastBurstSide = evaluation.outcomeLabel;
    s.firstBurstTau ??= evaluation.secondsToEnd;
    if (evaluation.bestAsk && (s.minBurstAsk === null || evaluation.bestAsk < s.minBurstAsk)) {
      s.minBurstAsk = evaluation.bestAsk;
      s.minBurstAskTau = evaluation.secondsToEnd;
    }
    s.lastSkipReason = evaluation.skipReason;
    if (evaluation.skipReason === null) s.traded = true;
  }

  private async onMarketResolved(ev: MarketResolvedEvent): Promise<void> {
    let marketId = this.conditionIdMap.get(ev.conditionId);
    if (!marketId) {
      const [row] = await getDb()
        .select({ id: schema.markets.id })
        .from(schema.markets)
        .where(eq(schema.markets.conditionId, ev.conditionId))
        .limit(1);
      marketId = row?.id;
    }
    const state = marketId ? this.activeMarkets.get(marketId) : undefined;
    if (!state || state.resolved) return;
    state.resolved = true;
    await this.settleMarketPositions(state.marketId, ev.winningAssetId, ev.winningOutcome);
  }

  private async onOpportunity(opp: MarketOpportunity): Promise<void> {
    if (this.paused || this.inFlightTokenIds.has(opp.tokenId)) return;
    this.inFlightTokenIds.add(opp.tokenId);
    const release = () => this.strategyEngine.releaseMarket(opp.marketId);

    try {
      // Polymarket holds taker orders for its delay and revalidates before
      // matching, so the fill comes from the book after the hold, not the one
      // that triggered the entry.
      await sleep(STRATEGY.executionLatencyMs);
      if (this.paused) return release();

      const book = this.wsWatcher.getBook(opp.tokenId);
      if (!book?.asks.length) return release();

      const execution = simulateLimitBuy(book, FIXED_POSITION_BUDGET_USD, STRATEGY.maxEntryPrice);
      if (execution.totalShares <= 0 || execution.belowMinimumOrderSize) {
        logger.warn(
          { tokenId: opp.tokenId, filled: execution.totalShares, bestAsk: this.wsWatcher.getBestAsk(opp.tokenId) },
          "No usable fill",
        );
        return release();
      }

      const state = this.activeMarkets.get(opp.marketId);
      const entryBid = this.wsWatcher.getBestBid(opp.tokenId) ?? opp.bestBid;
      const actualCost = execution.netCost;
      await this.portfolioManager.deductCash(actualCost);

      if (state) {
        await insertMarketIfNew(opp.marketId, {
          conditionId: state.conditionId,
          slug: state.slug,
          question: state.question,
          clobTokenIds: [state.yesTokenId, state.noTokenId],
          outcomes: state.outcomes,
          endDate: state.endDate.toISOString(),
          targetPrice: state.strike,
          metadata: state.rawMarket,
        });
      }

      const trade = await createSimulatedTrade({
        marketId: opp.marketId,
        tokenId: opp.tokenId,
        outcomeLabel: opp.outcomeLabel,
        entryTs: new Date(marketNow()),
        windowType: WINDOW_CONFIG.category,
        entryPrice: execution.averagePrice.toFixed(6),
        entryShares: execution.totalShares.toFixed(6),
        positionBudget: FIXED_POSITION_BUDGET_USD.toFixed(6),
        actualCost: actualCost.toFixed(6),
        entryFees: execution.fees.toFixed(6),
        fillStatus: execution.isPartialFill ? "PARTIAL" : "FULL",
        twapAtEntry: opp.forecast.twapNow,
        rawAtEntry: opp.forecast.rawNow,
        strike: opp.strike,
        forecastSettlement: opp.forecast.expected,
        forecastMarginUsd: opp.forecast.margin,
        forecastSdUsd: opp.forecast.sd,
        flowPrints: opp.burst.prints,
        flowShares: opp.burst.shares,
        secondsToEnd: opp.secondsToEnd,
        minPriceDuringPosition: entryBid.toFixed(6),
      });

      this.openPositions.set(trade.id, {
        tradeId: trade.id,
        marketId: opp.marketId,
        tokenId: opp.tokenId,
        outcomeLabel: opp.outcomeLabel,
        entryPrice: execution.averagePrice,
        entryShares: execution.totalShares,
        actualCost,
        marketEndDate: state?.endDate ?? new Date(),
        minBid: entryBid,
        remainingShares: execution.totalShares,
        exitGross: 0,
        exitFees: 0,
        stopTriggered: false,
      });
      this.scheduleSettlementWatch(opp.marketId);
      this.cycleCount++;

      await logAudit("info", "TRADE_OPENED", `Trade ${trade.id} opened for ${opp.outcomeLabel}`, {
        tradeId: trade.id,
        tokenId: opp.tokenId,
        outcome: opp.outcomeLabel,
        avgPrice: execution.averagePrice,
        shares: execution.totalShares,
        actualCost,
        strike: opp.strike,
        forecastSettlement: opp.forecast.expected,
        forecastMargin: opp.forecast.margin,
        forecastSd: opp.forecast.sd,
        forecastZ: opp.forecast.zScore,
        burstPrints: opp.burst.prints,
        burstShares: opp.burst.shares,
        secondsToEnd: opp.secondsToEnd,
        cashRemaining: this.portfolioManager.getCashBalance(),
      });
      this.emit("tradeOpened", { tradeId: trade.id, trade, ...opp, execution });
      logger.info(
        {
          tradeId: trade.id,
          outcome: opp.outcomeLabel,
          avgPrice: execution.averagePrice.toFixed(4),
          shares: execution.totalShares.toFixed(2),
          burst: `${opp.burst.prints}x${opp.burst.shares.toFixed(0)}sh`,
          z: opp.forecast.zScore.toFixed(2),
        },
        "Trade opened",
      );
    } catch (error) {
      logger.error({ error, marketId: opp.marketId }, "Failed to execute simulated trade");
      logAudit("error", "SYSTEM", `Trade failed for market ${opp.marketId}: ${errorMessage(error)}`).catch(() => {});
    } finally {
      this.inFlightTokenIds.delete(opp.tokenId);
    }
  }

  /**
   * The trigger only decides when to sell. The fill is whatever the bid side
   * holds once the order lands, walked to the bottom of the book with no limit.
   * A book too thin for the whole position leaves a remainder that stays open
   * with the trigger re-armed.
   */
  private async submitStopLossExit(pos: OpenPosition): Promise<void> {
    try {
      await sleep(STRATEGY.executionLatencyMs);
      // Settlement may have closed the row while the order was in flight.
      if (!this.openPositions.has(pos.tradeId)) return;

      const book = this.wsWatcher.getBook(pos.tokenId);
      const sell = book ? simulateLimitSell(book, pos.remainingShares, 0) : null;
      if (!sell || sell.totalSharesSold <= 0) {
        pos.stopTriggered = false;
        return;
      }

      pos.remainingShares -= sell.totalSharesSold;
      pos.exitGross += sell.totalRevenue;
      pos.exitFees += sell.fees;
      const proceeds = sell.totalRevenue - sell.fees;
      if (proceeds > 0) await this.portfolioManager.addCash(proceeds);

      if (pos.remainingShares > 1e-6) {
        pos.stopTriggered = false;
        logger.warn(
          { tradeId: pos.tradeId, sold: sell.totalSharesSold, remaining: pos.remainingShares },
          "Stop-loss partially filled",
        );
        return;
      }
      await this.closePosition(pos, 0, "STOP_LOSS", "STOP_LOSS");
    } catch (error) {
      logger.error({ error, tradeId: pos.tradeId }, "Stop-loss execution error");
      logAudit("error", "SYSTEM", `Stop-loss error for trade ${pos.tradeId}: ${errorMessage(error)}`).catch(() => {});
      pos.stopTriggered = false;
    }
  }

  private async closePosition(
    pos: OpenPosition,
    redemption: number,
    exitReason: "RESOLUTION" | "STOP_LOSS",
    auditCategory: "STOP_LOSS" | "TRADE_RESOLVED",
    winningOutcome?: string,
  ): Promise<void> {
    const pnl = pos.exitGross - pos.exitFees + redemption - pos.actualCost;
    const isWin = pnl > 0;
    const exitPrice = (pos.exitGross + redemption) / pos.entryShares;

    const trade = await resolveTrade(pos.tradeId, isWin ? "WIN" : "LOSS", pnl.toFixed(6), exitPrice.toFixed(6), exitReason);
    this.openPositions.delete(pos.tradeId);

    await logAudit(
      isWin ? "info" : "warn",
      auditCategory,
      `Trade ${pos.tradeId} closed: ${isWin ? "WIN" : "LOSS"} via ${exitReason}`,
      {
        tradeId: pos.tradeId,
        outcome: isWin ? "WIN" : "LOSS",
        pnl,
        exitPrice,
        exitReason,
        winningOutcome: winningOutcome ?? null,
        sharesRedeemed: redemption > 0 ? pos.remainingShares : 0,
        stopProceeds: pos.exitGross - pos.exitFees,
        cashBalance: this.portfolioManager.getCashBalance(),
      },
    );
    logger.info({ tradeId: pos.tradeId, exitReason, pnl: pnl.toFixed(4) }, isWin ? "Trade won" : "Trade lost");
    this.emit("tradeResolved", { tradeId: pos.tradeId, isWin, pnl, exitPrice, trade });
  }

  private async settleMarketPositions(marketId: string, winningTokenId: string, winningOutcome: string): Promise<void> {
    for (const pos of [...this.openPositions.values()]) {
      if (pos.marketId !== marketId || !this.openPositions.has(pos.tradeId)) continue;
      const redemption = pos.tokenId === winningTokenId ? pos.remainingShares : 0;
      if (redemption > 0) await this.portfolioManager.addCash(redemption);
      await this.closePosition(
        pos,
        redemption,
        pos.exitGross > 0 ? "STOP_LOSS" : "RESOLUTION",
        "TRADE_RESOLVED",
        winningOutcome,
      );
    }
    if (!this.hasOpenPositions(marketId)) this.cleanupMarket(marketId);
  }

  private scheduleSettlementWatch(marketId: string): void {
    if (this.resolutionTimers.has(marketId)) return;
    const startedAt = Date.now();
    const poll = async () => {
      this.resolutionTimers.delete(marketId);
      if (!this.running || !this.hasOpenPositions(marketId)) return;
      await this.pollSettlement(marketId);
      if (!this.hasOpenPositions(marketId)) return;
      const interval = Date.now() - startedAt < 2 * 60_000 ? 5_000 : 30_000;
      this.resolutionTimers.set(marketId, setTimeout(poll, interval));
    };
    this.resolutionTimers.set(marketId, setTimeout(poll, 5_000));
  }

  private async pollSettlement(marketId: string): Promise<void> {
    try {
      const market = await this.client.getMarketById(marketId);
      if (!market) return;
      const prices = PolymarketClient.parseOutcomePrices(market);
      const winIdx = prices.findIndex((p) => p >= 0.99);
      if (winIdx < 0) return;
      const winningTokenId = PolymarketClient.parseClobTokenIds(market)[winIdx];
      const winningOutcome = PolymarketClient.parseOutcomes(market)[winIdx];
      if (!winningTokenId || !winningOutcome) return;

      const state = this.activeMarkets.get(marketId);
      if (state) state.resolved = true;
      await this.settleMarketPositions(marketId, winningTokenId, winningOutcome);
    } catch (error) {
      logger.error({ error, marketId }, "Settlement poll failed");
      logAudit("error", "SYSTEM", `Settlement poll failed for market ${marketId}: ${errorMessage(error)}`).catch(() => {});
    }
  }

  private cleanupExpiredMarkets(): void {
    const now = marketNow();
    for (const [marketId, state] of [...this.activeMarkets]) {
      if (state.resolved || state.endDate.getTime() <= now) this.cleanupMarket(marketId);
    }
  }

  private cleanupMarket(marketId: string): void {
    const state = this.activeMarkets.get(marketId);
    if (!state || this.hasOpenPositions(marketId)) return;

    this.flushSummary(state);
    this.wsWatcher.unsubscribe([state.yesTokenId, state.noTokenId]);
    this.strategyEngine.unregisterMarket(state.yesTokenId);
    this.strategyEngine.unregisterMarket(state.noTokenId);
    this.strategyEngine.releaseMarket(marketId);
    if (state.conditionId) this.conditionIdMap.delete(state.conditionId);
    this.tokenToMarket.delete(state.yesTokenId);
    this.tokenToMarket.delete(state.noTokenId);
    this.activeMarkets.delete(marketId);
  }

  private flushSummary(state: ActiveMarketState): void {
    const s = state.summary;
    if (s.bursts === 0 && state.strike === null) return;
    const verdict = s.traded ? "traded" : s.bursts === 0 ? "no burst" : (s.lastSkipReason ?? "not taken");
    logAudit("info", "EVALUATION", `Window ${state.slug ?? state.marketId} closed: ${verdict}`, {
      marketId: state.marketId,
      slug: state.slug,
      windowEnd: state.endDate.toISOString(),
      strike: state.strike,
      bursts: s.bursts,
      firstBurstTau: round(s.firstBurstTau, 1),
      lastBurstSide: s.lastBurstSide,
      minBurstAsk: round(s.minBurstAsk),
      minBurstAskTau: round(s.minBurstAskTau, 1),
      lastSkipReason: s.lastSkipReason,
      traded: s.traded,
    }).catch((err) => logger.error({ err, marketId: state.marketId }, "Failed to log evaluation"));
  }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

let instance: MarketOrchestrator | null = null;
export function getMarketOrchestrator(): MarketOrchestrator {
  if (!instance) instance = new MarketOrchestrator();
  return instance;
}
