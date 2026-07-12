import { EventEmitter } from "events";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import { WINDOW_CONFIGS } from "../types/index.js";
import {
  getDb,
  createSimulatedTrade,
  resolveTrade,
  logAudit,
  loadOpenTradesWithMarkets,
  insertMarketIfNew,
} from "../db/client.js";
import * as schema from "../db/schema.js";
import { eq, and, desc, gte } from "drizzle-orm";

import { getMarketScanner, MarketScanner } from "./market-scanner.js";
import {
  getMarketWebSocketWatcher,
  MarketWebSocketWatcher,
} from "./market-ws-watcher.js";
import {
  getStrategyEngine,
  StrategyEngine,
  type MarketOpportunity,
} from "./strategy-engine.js";
import {
  simulateLimitBuy,
  simulateLimitSell,
  calculateWinProfit,
  calculateLossAmount,
  calculateEarlyExitPnl,
} from "./execution-simulator.js";
import { getBtcPriceWatcher, BtcPriceWatcher } from "./btc-price-watcher.js";
import { getPolymarketClient, PolymarketClient } from "./polymarket-client.js";
import { PortfolioManager } from "./portfolio-manager.js";

import type { MarketResolvedEvent } from "../interfaces/websocket-types.js";

const logger = createModuleLogger("market-orchestrator");

interface ActiveMarketState {
  marketId: string;
  conditionId: string | null;
  yesTokenId: string;
  noTokenId: string;
  question: string;
  slug: string | null;
  endDate: Date;
  targetPrice: number | null;
  /** BTC price at window start — the "price to beat"; the window resolves UP if
   *  BTC ends >= this value, DOWN otherwise. */
  btcPriceAtWindowStart: number | null;
  outcomes: string[];
  lastPrices: Record<string, { bid: number; ask: number; mid: number }>;
  subscribedWs: boolean;
  resolved: boolean;
  rawMarket: any;
}

interface OpenPosition {
  tradeId: string;
  marketId: string;
  tokenId: string;
  outcomeLabel: string;
  entryPrice: number;
  entryShares: number;
  fees: number;
  /** Cash spent (shares × avgPrice + fees); the cost basis for portfolio value. */
  actualCost: number;
  marketEndDate: Date;
  /** Window-start strike this position resolves against, for recross detection. */
  strike: number | null;
  recrossTriggered?: boolean;
}

/**
 * Central coordinator: the scanner finds BTC window markets, this subscribes to
 * their CLOB price feed, the strategy engine flags entries, the execution
 * simulator fills them, and positions are resolved WIN/LOSS via WS + polling.
 */
export class MarketOrchestrator extends EventEmitter {
  private scanner: MarketScanner;
  private wsWatcher: MarketWebSocketWatcher;
  private strategyEngine: StrategyEngine;
  private btcWatcher: BtcPriceWatcher;
  private client: PolymarketClient;
  readonly portfolioManager: PortfolioManager;

  private activeMarkets: Map<string, ActiveMarketState> = new Map();
  /** conditionId → marketId */
  private conditionIdMap: Map<string, string> = new Map();
  /** tokenId → marketId */
  private tokenToMarket: Map<string, string> = new Map();
  private openPositions: Map<string, OpenPosition> = new Map();
  /** marketId → tradeIds */
  private positionsByMarket: Map<string, Set<string>> = new Map();
  /** tokenId → tradeIds */
  private positionsByToken: Map<string, Set<string>> = new Map();
  /** tokenIds mid-execution in onOpportunity — blocks concurrent duplicates */
  private inFlightTokenIds: Set<string> = new Set();
  /** marketIds still awaiting btcPriceAtWindowStart */
  private pendingBtcFills: Set<string> = new Set();
  private resolutionTimers: Map<string, ReturnType<typeof setInterval>> =
    new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private windowDurationMs = 5 * 60_000;

  private running = false;
  private paused = false;
  private cycleCount = 0;
  private consecutiveLossCount = 0;
  private pausedByRiskGuard = false;
  private riskPauseTriggeredAt: number | null = null;
  private riskAutoResumeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();
    this.scanner = getMarketScanner();
    this.wsWatcher = getMarketWebSocketWatcher();
    this.strategyEngine = getStrategyEngine();
    this.btcWatcher = getBtcPriceWatcher();
    this.client = getPolymarketClient();
    this.portfolioManager = new PortfolioManager();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const config = getConfig();
    this.windowDurationMs =
      WINDOW_CONFIGS[config.strategy.marketWindow]?.durationMs ?? 5 * 60_000;
    const windowLabel = WINDOW_CONFIGS[config.strategy.marketWindow].label;

    await this.portfolioManager.init();

    logger.info(
      {
        window: config.strategy.marketWindow,
        label: windowLabel,
        zEntryThreshold: config.strategy.zEntryThreshold,
        entryFromWindowSec: config.strategy.entryFromWindowSeconds,
        maxPositions: config.strategy.maxSimultaneousPositions,
        startingCapital: config.portfolio.startingCapital,
      },
      "Starting market orchestrator",
    );

    await this.loadOpenPositions();
    await this.loadActiveMarkets();
    this.tryFillBtcWindowStart();
    this.wireEvents();

    this.wsWatcher.start();
    await this.scanner.start();

    this.cleanupTimer = setInterval(() => this.cleanupExpiredMarkets(), 10_000);

    logger.info("Market orchestrator fully started");
  }

  stop(): void {
    this.running = false;
    this.scanner.stop();
    this.wsWatcher.stop();
    if (this.riskAutoResumeTimer) {
      clearTimeout(this.riskAutoResumeTimer);
      this.riskAutoResumeTimer = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const [, timer] of this.resolutionTimers) {
      clearTimeout(timer);
    }
    this.resolutionTimers.clear();

    logger.info("Market orchestrator stopped");
  }

  /** Pause new entries; open positions stay tracked and the WS stays alive. */
  pause(): void {
    this.paused = true;
    this.scanner.stop();
    if (this.riskAutoResumeTimer) {
      clearTimeout(this.riskAutoResumeTimer);
      this.riskAutoResumeTimer = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    logger.warn("System paused — new positions blocked, existing tracked");
  }

  async resume(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    this.pausedByRiskGuard = false;
    this.riskPauseTriggeredAt = null;
    this.consecutiveLossCount = 0;
    if (this.riskAutoResumeTimer) {
      clearTimeout(this.riskAutoResumeTimer);
      this.riskAutoResumeTimer = null;
    }

    // Reload portfolio in case an admin wiped and reset it.
    await this.portfolioManager.reload();

    await this.scanner.start();
    this.cleanupTimer = setInterval(() => this.cleanupExpiredMarkets(), 10_000);

    logger.info("System resumed — trading active");
  }

  isPaused(): boolean {
    return this.paused;
  }

  getStats() {
    const config = getConfig();
    const sigmaPerSec = this.btcWatcher.getRealizedVol(
      config.strategy.sigmaWindowMs,
    );
    return {
      running: this.running,
      paused: this.paused,
      activeMarkets: this.activeMarkets.size,
      openPositions: this.openPositions.size,
      cycleCount: this.cycleCount,
      scanner: {
        discoveredCount: this.scanner.getDiscoveredCount(),
      },
      ws: this.wsWatcher.getStats(),
      strategy: this.strategyEngine.getStats(),
      btcConnected: this.btcWatcher.isConnected(),
      btcPrice: this.btcWatcher.getCurrentPrice()?.price ?? null,
      btcPriceAgeMs: this.btcWatcher.getPriceAgeMs(),
      btcPriceFresh: this.btcWatcher.isPriceFresh(),
      sigmaPerSec,
      risk: {
        consecutiveLossCount: this.consecutiveLossCount,
        consecutiveLossPauseLimit: config.strategy.consecutiveLossPauseLimit,
        pausedByRiskGuard: this.pausedByRiskGuard,
        riskPauseTriggeredAt: this.riskPauseTriggeredAt,
      },
    };
  }

  getLiveMarkets() {
    const now = Date.now();
    return Array.from(this.activeMarkets.values())
      .filter((m) => !m.resolved)
      .sort((a, b) => a.endDate.getTime() - b.endDate.getTime())
      .map((m) => {
        const hasPosition = this.hasOpenPositionsForMarket(m.marketId);
        const windowStartMs = m.endDate.getTime() - this.windowDurationMs;
        // UPCOMING: window not yet open · ACTIVE: open · ENDED: awaiting oracle.
        const status: "ACTIVE" | "ENDED" | "UPCOMING" =
          m.endDate.getTime() <= now
            ? "ENDED"
            : windowStartMs <= now
              ? "ACTIVE"
              : "UPCOMING";

        return {
          marketId: m.marketId,
          question: m.question,
          slug: m.slug,
          endDate: m.endDate.toISOString(),
          windowStart: new Date(windowStartMs).toISOString(),
          yesTokenId: m.yesTokenId,
          noTokenId: m.noTokenId,
          prices: { ...m.lastPrices },
          status,
          hasPosition,
          btcPriceAtWindowStart: m.btcPriceAtWindowStart,
        };
      });
  }

  /** Total cost basis of all open positions (sum of actualCost), not mark-to-market. */
  computeOpenPositionsValue(): number {
    let total = 0;
    for (const pos of this.openPositions.values()) {
      total += pos.actualCost;
    }
    return total;
  }

  private trackPosition(pos: OpenPosition): void {
    this.openPositions.set(pos.tradeId, pos);

    let byMarket = this.positionsByMarket.get(pos.marketId);
    if (!byMarket) {
      byMarket = new Set();
      this.positionsByMarket.set(pos.marketId, byMarket);
    }
    byMarket.add(pos.tradeId);

    let byToken = this.positionsByToken.get(pos.tokenId);
    if (!byToken) {
      byToken = new Set();
      this.positionsByToken.set(pos.tokenId, byToken);
    }
    byToken.add(pos.tradeId);

    this.strategyEngine.setOpenPositionCount(this.openPositions.size);
  }

  private untrackPosition(tradeId: string): void {
    const pos = this.openPositions.get(tradeId);
    if (!pos) return;
    this.openPositions.delete(tradeId);

    const byMarket = this.positionsByMarket.get(pos.marketId);
    if (byMarket) {
      byMarket.delete(tradeId);
      if (byMarket.size === 0) this.positionsByMarket.delete(pos.marketId);
    }

    const byToken = this.positionsByToken.get(pos.tokenId);
    if (byToken) {
      byToken.delete(tradeId);
      if (byToken.size === 0) this.positionsByToken.delete(pos.tokenId);
    }

    this.strategyEngine.setOpenPositionCount(this.openPositions.size);
  }

  private hasOpenPositionsForMarket(marketId: string): boolean {
    const set = this.positionsByMarket.get(marketId);
    return set !== undefined && set.size > 0;
  }

  private registerMarketState(state: ActiveMarketState): void {
    this.activeMarkets.set(state.marketId, state);
    this.tokenToMarket.set(state.yesTokenId, state.marketId);
    this.tokenToMarket.set(state.noTokenId, state.marketId);
    if (state.conditionId) {
      this.conditionIdMap.set(state.conditionId, state.marketId);
    }
  }

  private wireEvents(): void {
    // Scanner → new market discovered
    this.scanner.on("newMarket", async ({ market }) => {
      try {
        await this.onNewMarket(market);
      } catch (err) {
        logger.error(
          { err, marketId: market?.id },
          "Error handling new market",
        );
      }
    });

    const handlePriceEvent = (ev: {
      tokenId: string;
      bestBid: string;
      bestAsk: string;
    }) =>
      this.onTokenPriceUpdate(
        ev.tokenId,
        parseFloat(ev.bestBid),
        parseFloat(ev.bestAsk),
      );
    this.wsWatcher.on("priceUpdate", handlePriceEvent);
    this.wsWatcher.on("bestBidAskUpdate", handlePriceEvent);

    this.wsWatcher.on("marketResolved", (ev: MarketResolvedEvent) =>
      this.onMarketResolved(ev),
    );

    this.btcWatcher.on("btcPriceUpdate", (data) => {
      this.tryFillBtcWindowStart();
      this.checkRecrossExits(data.price);
    });

    this.strategyEngine.on("opportunityDetected", (opp: MarketOpportunity) => {
      this.onOpportunity(opp).catch((err) => {
        logger.error(
          { err, marketId: opp.marketId },
          "Error handling opportunity",
        );
      });
    });
  }

  /**
   * Fill btcPriceAtWindowStart for any market whose window has opened, preferring
   * a historical lookup and falling back to the current live price (the usual case
   * after a mid-window restart). Waits silently until BTC is connected.
   */
  private tryFillBtcWindowStart(): void {
    if (this.pendingBtcFills.size === 0) return;

    const nowMs = Date.now();

    for (const marketId of this.pendingBtcFills) {
      const state = this.activeMarkets.get(marketId);
      if (!state || state.btcPriceAtWindowStart !== null) {
        this.pendingBtcFills.delete(marketId);
        continue;
      }

      const windowStartMs = state.endDate.getTime() - this.windowDurationMs;
      if (nowMs < windowStartMs) continue;

      let resolved: number | null = null;
      let source: "historical" | "current" = "historical";

      // Skip the historical lookup unless the buffer predates the window start,
      // otherwise getPriceAt() only returns null and logs noise.
      const oldestHistoryMs = this.btcWatcher.getOldestHistoryTimestamp();
      if (oldestHistoryMs !== null && oldestHistoryMs <= windowStartMs) {
        resolved = this.btcWatcher.getPriceAt(windowStartMs);
      }

      if (resolved === null) {
        const current = this.btcWatcher.getCurrentPrice();
        if (current !== null) {
          resolved = current.price;
          source = "current";
        }
      }

      if (resolved === null) continue;

      state.btcPriceAtWindowStart = resolved;
      this.pendingBtcFills.delete(marketId);

      logger.info(
        {
          marketId: state.marketId,
          btcPrice: resolved,
          source,
          ...(source === "current" ? { windowStartMs } : {}),
        },
        source === "current"
          ? "btcPriceAtWindowStart filled (current price — no history covering window start)"
          : "btcPriceAtWindowStart filled (historical)",
      );

      // For relative Up/Down markets the window-start price is the strike.
      if (state.targetPrice === null) {
        state.targetPrice = resolved;
        this.strategyEngine.updateStrike(state.yesTokenId, resolved);
        this.strategyEngine.updateStrike(state.noTokenId, resolved);
      }
    }
  }

  private async onNewMarket(market: any): Promise<void> {
    if (this.paused) return;
    if (this.activeMarkets.has(market.id)) return;

    const tokenIds = PolymarketClient.parseClobTokenIds(market);
    const outcomes = PolymarketClient.parseOutcomes(market);
    const targetPrice = PolymarketClient.parseTargetPrice(market.question);

    if (tokenIds.length < 2 || outcomes.length < 2) {
      logger.warn(
        { marketId: market.id },
        "Market missing token IDs or outcomes",
      );
      return;
    }

    const endDate = market.endDate ? new Date(market.endDate) : new Date();

    // Gamma can return old unresolved markets; skip ones already expired.
    if (endDate.getTime() < Date.now()) {
      logger.debug(
        { marketId: market.id, endDate: endDate.toISOString() },
        "Skipping expired market",
      );
      return;
    }

    // Pre-fill if the window is already open; else the next BTC tick fills it.
    const windowStartMs = endDate.getTime() - this.windowDurationMs;
    const btcPriceAtWindowStart =
      windowStartMs <= Date.now()
        ? (this.btcWatcher.getPriceAt(windowStartMs) ??
          this.btcWatcher.getCurrentPrice()?.price ??
          null)
        : null;

    const state: ActiveMarketState = {
      marketId: market.id,
      conditionId: market.conditionId ?? null,
      yesTokenId: tokenIds[0]!,
      noTokenId: tokenIds[1]!,
      question: market.question ?? "",
      slug: market.slug ?? null,
      endDate,
      targetPrice: targetPrice ?? btcPriceAtWindowStart,
      btcPriceAtWindowStart,
      outcomes,
      lastPrices: {},
      subscribedWs: false,
      resolved: false,
      rawMarket: market,
    };

    this.registerMarketState(state);
    if (state.btcPriceAtWindowStart === null) {
      this.pendingBtcFills.add(market.id);
    }

    // effectiveTargetPrice is null for relative Up/Down markets until it's filled.
    const effectiveTargetPrice = targetPrice ?? btcPriceAtWindowStart;
    for (let i = 0; i < tokenIds.length; i++) {
      this.strategyEngine.registerMarket(
        market.id,
        tokenIds[i]!,
        outcomes[i] ?? `Outcome${i}`,
        endDate,
        effectiveTargetPrice,
      );
    }

    this.wsWatcher.subscribe(tokenIds);
    state.subscribedWs = true;

    logger.info(
      {
        marketId: market.id,
        question: market.question,
        endDate: endDate.toISOString(),
        targetPrice,
        tokens: tokenIds.length,
      },
      "New market activated",
    );
  }

  private onTokenPriceUpdate(
    tokenId: string,
    bestBid: number,
    bestAsk: number,
  ): void {
    const marketId = this.tokenToMarket.get(tokenId);
    if (marketId) {
      const state = this.activeMarkets.get(marketId);
      if (state && state.endDate > new Date()) {
        const mid = (bestBid + bestAsk) / 2;
        state.lastPrices[tokenId] = { bid: bestBid, ask: bestAsk, mid };
      }
      // After the window ends, freeze prices until the trade settles.
    }

    const config = getConfig();
    const sigmaPerSec = this.btcWatcher.getRealizedVol(
      config.strategy.sigmaWindowMs,
    );

    this.strategyEngine.evaluatePrice(
      tokenId,
      bestBid,
      bestAsk,
      this.btcWatcher.getCurrentPrice(),
      sigmaPerSec,
    );
  }

  private async onMarketResolved(ev: MarketResolvedEvent): Promise<void> {
    const { conditionId, winningAssetId, winningOutcome } = ev;

    logger.info(
      { conditionId, winningAssetId, winningOutcome },
      "Market resolved via WebSocket",
    );

    const marketId = this.conditionIdMap.get(conditionId);
    if (!marketId) {
      // Fallback to a DB lookup if the in-memory map missed it.
      const db = getDb();
      const [row] = await db
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.conditionId, conditionId))
        .limit(1);
      if (!row) return;

      const state = this.activeMarkets.get(row.id);
      if (!state || state.resolved) return;
      state.resolved = true;
      await this.resolvePositionsForMarket(
        row.id,
        winningAssetId,
        winningOutcome,
      );
      return;
    }

    const state = this.activeMarkets.get(marketId);
    if (!state || state.resolved) return;
    state.resolved = true;
    await this.resolvePositionsForMarket(
      marketId,
      winningAssetId,
      winningOutcome,
    );
  }

  /**
   * Fetch the live book, size and simulate a FAK buy against it, enforce the
   * protocol min order size, then deduct cash and persist the resulting trade.
   */
  private async onOpportunity(opp: MarketOpportunity): Promise<void> {
    if (this.paused) return;

    if (this.inFlightTokenIds.has(opp.tokenId)) {
      logger.debug(
        { tokenId: opp.tokenId, marketId: opp.marketId },
        "onOpportunity skipped — already in-flight for this token",
      );
      return;
    }
    this.inFlightTokenIds.add(opp.tokenId);

    const config = getConfig();

    try {
      const orderbookResult = await this.client.getOrderbook(opp.tokenId);
      if (!orderbookResult?.data || !orderbookResult.data.asks?.length) {
        logger.warn(
          { tokenId: opp.tokenId },
          "No orderbook available — will retry on next price update",
        );
        this.strategyEngine.clearEvaluated(opp.tokenId);
        return;
      }
      const orderbook = orderbookResult.data;

      const sortedAsks = [...orderbook.asks].sort(
        (a, b) => parseFloat(a.price) - parseFloat(b.price),
      );
      const bestAskPrice =
        sortedAsks.length > 0 ? parseFloat(sortedAsks[0]!.price) : opp.bestAsk;

      const openPositionsValue = this.computeOpenPositionsValue();
      const positionBudget =
        this.portfolioManager.computePositionBudget(openPositionsValue);

      if (positionBudget <= 0) {
        logger.info(
          {
            openPositionsValue,
            cash: this.portfolioManager.getCashBalance(),
          },
          "Insufficient cash for minimum share count — skipping",
        );
        return;
      }

      const execution = simulateLimitBuy(
        orderbook,
        positionBudget,
        config.strategy.maxEntryPrice,
      );

      if (execution.totalShares <= 0) {
        logger.warn(
          {
            tokenId: opp.tokenId,
            maxEntryPrice: config.strategy.maxEntryPrice,
            bestAsk: bestAskPrice,
          },
          "No fill — all asks above maxEntryPrice; will retry",
        );
        this.strategyEngine.clearEvaluated(opp.tokenId);
        return;
      }

      if (execution.belowMinimumOrderSize) {
        logger.warn(
          {
            tokenId: opp.tokenId,
            filled: execution.totalShares,
            minOrderSize: execution.minOrderSize,
          },
          `Rejecting: filled ${execution.totalShares.toFixed(2)} shares < min_order_size ${execution.minOrderSize}`,
        );
        this.strategyEngine.clearEvaluated(opp.tokenId);
        return;
      }

      const expectedProfit = calculateWinProfit(
        execution.averagePrice,
        execution.totalShares,
        execution.fees,
      );

      if (expectedProfit < 0.001) {
        logger.debug(
          { expectedProfit, tokenId: opp.tokenId },
          "Expected profit too small",
        );
        return;
      }

      const actualCost = execution.netCost;
      const deducted = await this.portfolioManager.deductCash(actualCost);
      if (!deducted) {
        logger.warn(
          { actualCost, cash: this.portfolioManager.getCashBalance() },
          "Insufficient cash for actual fill cost — skipping",
        );
        return;
      }

      const fillStatus = execution.isPartialFill ? "PARTIAL" : "FULL";

      const marketState = this.activeMarkets.get(opp.marketId);
      if (marketState && marketState.rawMarket) {
        const tokenIds = PolymarketClient.parseClobTokenIds(marketState.rawMarket);
        const outcomes = PolymarketClient.parseOutcomes(marketState.rawMarket);
        
        await insertMarketIfNew(opp.marketId, {
          conditionId: marketState.conditionId ?? "",
          slug: marketState.slug ?? undefined,
          question: marketState.question ?? undefined,
          clobTokenIds: tokenIds,
          outcomes,
          windowType: config.strategy.marketWindow,
          category: "Crypto",
          endDate: marketState.endDate.toISOString(),
          targetPrice: marketState.targetPrice,
          active: true,
          metadata: marketState.rawMarket,
        });
      }

      const entryTs = new Date();
      const tradeRow = await createSimulatedTrade({
        marketId: opp.marketId,
        tokenId: opp.tokenId,
        outcomeLabel: opp.outcomeLabel,
        entryTs,
        windowType: config.strategy.marketWindow,
        entryPrice: execution.averagePrice.toFixed(6),
        entryShares: execution.totalShares.toFixed(6),
        positionBudget: positionBudget.toFixed(6),
        actualCost: actualCost.toFixed(6),
        entryFees: execution.fees.toFixed(6),
        fillStatus,
        btcPriceAtEntry: opp.btcPrice,
        btcTargetPrice: opp.strike,
        btcDistanceUsd: opp.signedDistanceUsd,
        entryZ: opp.z,
        entrySigma: opp.sigmaPerSec,
        secondsToEnd: opp.secondsToEnd,
      });
      const tradeId = tradeRow!.id;

      // Track open position
      const market = this.activeMarkets.get(opp.marketId);
      this.trackPosition({
        tradeId,
        marketId: opp.marketId,
        tokenId: opp.tokenId,
        outcomeLabel: opp.outcomeLabel,
        entryPrice: execution.averagePrice,
        entryShares: execution.totalShares,
        fees: execution.fees,
        actualCost,
        marketEndDate: market?.endDate ?? new Date(),
        strike: opp.strike,
      });

      this.scheduleResolutionMonitor(opp.marketId);

      await logAudit(
        "info",
        "TRADE_OPENED",
        `Trade ${tradeId} opened for ${opp.outcomeLabel}`,
        {
          tradeId,
          tokenId: opp.tokenId,
          outcome: opp.outcomeLabel,
          avgPrice: execution.averagePrice,
          shares: execution.totalShares,
          positionBudget,
          actualCost,
          expectedProfit,
          btcPrice: opp.btcPrice,
          strike: opp.strike,
          distance: opp.signedDistanceUsd,
          z: opp.z,
          sigmaPerSec: opp.sigmaPerSec,
          secondsToEnd: opp.secondsToEnd,
          cashRemaining: this.portfolioManager.getCashBalance(),
        },
      );

      this.cycleCount++;
      this.emit("tradeOpened", {
        tradeId,
        trade: tradeRow,
        ...opp,
        execution,
        expectedProfit,
      });

      logger.info(
        {
          tradeId,
          marketId: opp.marketId,
          outcome: opp.outcomeLabel,
          avgPrice: execution.averagePrice.toFixed(4),
          shares: execution.totalShares.toFixed(2),
          budget: positionBudget.toFixed(2),
          actualCost: actualCost.toFixed(4),
          fees: execution.fees.toFixed(4),
          expectedProfit: expectedProfit.toFixed(4),
          btcPrice: opp.btcPrice.toFixed(2),
          z: opp.z.toFixed(2),
          distance: opp.signedDistanceUsd.toFixed(2),
          cashRemaining: this.portfolioManager.getCashBalance().toFixed(2),
        },
        "📈 Simulated trade opened",
      );
    } catch (error) {
      logger.error(
        { error, marketId: opp.marketId, tokenId: opp.tokenId },
        "Failed to execute simulated trade",
      );
      logAudit(
        "error",
        "SYSTEM",
        `Failed to execute simulated trade for market ${opp.marketId}: ${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => {});
    } finally {
      this.inFlightTokenIds.delete(opp.tokenId);
    }
  }

  /**
   * Exit any open position whose favored side has flipped — BTC has crossed back
   * through the strike against us, the real adverse event for a barrier trade.
   * Only fires while the window is open; after close the outcome is locked at the
   * Chainlink end price, so further BTC moves are irrelevant.
   */
  private checkRecrossExits(btcPrice: number): void {
    const config = getConfig();
    if (!config.strategy.recrossExitEnabled) return;
    if (this.openPositions.size === 0) return;

    const now = Date.now();
    for (const [tradeId, pos] of this.openPositions) {
      if (pos.recrossTriggered) continue;
      if (pos.strike === null) continue;
      if (pos.marketEndDate.getTime() <= now) continue; // window closed — outcome locked

      const favoredNow: "Up" | "Down" = btcPrice >= pos.strike ? "Up" : "Down";
      if (favoredNow === pos.outcomeLabel) continue; // still on our side

      pos.recrossTriggered = true;
      logger.warn(
        {
          tradeId,
          outcome: pos.outcomeLabel,
          strike: pos.strike.toFixed(2),
          btcPrice: btcPrice.toFixed(2),
        },
        "Recross detected: BTC crossed back through strike — exiting",
      );
      this.executeRecrossExit(tradeId, pos).catch((err) => {
        logger.error({ err, tradeId }, "Recross exit failed");
        const p = this.openPositions.get(tradeId);
        if (p) p.recrossTriggered = false;
      });
    }
  }

  /**
   * FAK market-sell the position into the live book (accept any bid), classify
   * by realized PnL, and settle the trade with reason RECROSS.
   */
  private async executeRecrossExit(
    tradeId: string,
    pos: OpenPosition,
  ): Promise<void> {
    try {
      const orderbookResult = await this.client.getOrderbook(pos.tokenId);

      const fallbackBid = this.strategyEngine.getPriceState(pos.tokenId)?.bestBid ?? 0;
      let exitPrice: number;
      let exitFees = 0;

      if (orderbookResult?.data && orderbookResult.data.bids?.length > 0) {
        const sellResult = simulateLimitSell(
          orderbookResult.data,
          pos.entryShares,
          0, // accept any bid — full market sell
        );
        exitPrice =
          sellResult.totalSharesSold > 0 ? sellResult.averagePrice : fallbackBid;
        exitFees = sellResult.totalSharesSold > 0 ? sellResult.fees : 0;
        if (sellResult.isPartialFill) {
          logger.warn(
            { tradeId, sold: sellResult.totalSharesSold, total: pos.entryShares },
            "Recross exit partial fill — insufficient bid liquidity",
          );
        }
      } else {
        exitPrice = fallbackBid;
      }

      const pnl = calculateEarlyExitPnl(
        pos.entryPrice,
        exitPrice,
        pos.entryShares,
        pos.fees,
        exitFees,
      );
      const isWin = pnl > 0;
      const outcome = isWin ? "WIN" : "LOSS";

      const sellProceeds = pos.entryShares * exitPrice - exitFees;
      if (sellProceeds > 0) await this.portfolioManager.addCash(sellProceeds);

      await resolveTrade(tradeId, outcome, pnl.toFixed(6), exitPrice.toFixed(6), {
        exitReason: "RECROSS",
      });
      this.updateConsecutiveLossState(isWin);
      this.untrackPosition(tradeId);

      await logAudit(
        "warn",
        "RECROSS_EXIT",
        `Recross exit for trade ${tradeId}: exit @ ${exitPrice.toFixed(4)}, PnL ${pnl.toFixed(4)} (${outcome})`,
        {
          tradeId,
          tokenId: pos.tokenId,
          entryPrice: pos.entryPrice,
          exitPrice,
          exitFees,
          pnl,
          outcome,
        },
      );

      logger.info(
        {
          tradeId,
          marketId: pos.marketId,
          outcome: pos.outcomeLabel,
          entryPrice: pos.entryPrice.toFixed(4),
          exitPrice: exitPrice.toFixed(4),
          pnl: pnl.toFixed(4),
          classification: outcome,
        },
        "🔀 Recross exit executed",
      );

      this.emit("tradeResolved", { tradeId, isWin, pnl, exitPrice, trade: null });
    } catch (error) {
      logger.error({ error, tradeId }, "Recross exit execution error");
      logAudit(
        "error",
        "SYSTEM",
        `Recross exit error for trade ${tradeId}: ${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => {});
      const position = this.openPositions.get(tradeId);
      if (position) position.recrossTriggered = false;
    }
  }

  /**
   * Schedule persistent resolution polling for a market.
   *
   * Polls every 5s for the first 2 minutes (when auto-resolution typically fires),
   * then backs off to every 30s. After 30 minutes hard-timeout: force-resolve as
   * LOSS so positions never stay open indefinitely.
   */
  private scheduleResolutionMonitor(marketId: string): void {
    if (this.resolutionTimers.has(marketId)) return;

    const FAST_INTERVAL = 5_000;
    const SLOW_INTERVAL = 30_000;
    const FAST_PHASE_MS = 2 * 60_000;
    const HARD_TIMEOUT_MS = 30 * 60_000;
    const startTime = Date.now();

    const poll = async () => {
      if (!this.running) {
        clearTimeout(timerId);
        this.resolutionTimers.delete(marketId);
        return;
      }

      if (!this.hasOpenPositionsForMarket(marketId)) {
        clearTimeout(timerId);
        this.resolutionTimers.delete(marketId);
        return;
      }

      const elapsed = Date.now() - startTime;

      if (elapsed > HARD_TIMEOUT_MS) {
        clearTimeout(timerId);
        this.resolutionTimers.delete(marketId);
        await this.forceResolveExpired(marketId);
        return;
      }

      await this.pollResolution(marketId);

      const interval = elapsed < FAST_PHASE_MS ? FAST_INTERVAL : SLOW_INTERVAL;
      timerId = setTimeout(poll, interval);
      this.resolutionTimers.set(marketId, timerId);
    };

    let timerId = setTimeout(poll, FAST_INTERVAL);
    this.resolutionTimers.set(marketId, timerId);
  }

  private async pollResolution(marketId: string): Promise<void> {
    try {
      const market = await this.client.getMarketById(marketId);
      if (!market) return;
      if (!market.closed) return;

      const state = this.activeMarkets.get(marketId);
      if (state) state.resolved = true;

      const outcomes = PolymarketClient.parseOutcomes(market);
      const prices = PolymarketClient.parseOutcomePrices(market);
      const tokenIds = PolymarketClient.parseClobTokenIds(market);

      let winningTokenId: string | null = null;
      let winningOutcome: string | null = null;

      for (let i = 0; i < outcomes.length; i++) {
        const price = prices[i] ?? 0;
        if (price >= 0.99) {
          winningTokenId = tokenIds[i] ?? null;
          winningOutcome = outcomes[i] ?? null;
          break;
        }
      }

      if (winningTokenId && winningOutcome) {
        await this.resolvePositionsForMarket(
          marketId,
          winningTokenId,
          winningOutcome,
        );

        const timer = this.resolutionTimers.get(marketId);
        if (timer) {
          clearInterval(timer);
          this.resolutionTimers.delete(marketId);
        }
      }
    } catch (error) {
      logger.error({ error, marketId }, "Resolution poll failed");
      logAudit(
        "error",
        "SYSTEM",
        `Resolution poll failed for market ${marketId}: ${error instanceof Error ? error.message : String(error)}`,
      ).catch(() => {});
    }
  }

  /**
   * Resolve all open positions for a market.
   */
  private async resolvePositionsForMarket(
    marketId: string,
    winningTokenId: string,
    winningOutcome: string,
  ): Promise<void> {
    for (const [tradeId, pos] of this.openPositions) {
      if (pos.marketId !== marketId) continue;

      const isWin = pos.tokenId === winningTokenId;
      const exitPrice = isWin ? 1.0 : 0.0;
      const pnl = isWin
        ? calculateWinProfit(pos.entryPrice, pos.entryShares, pos.fees)
        : calculateLossAmount(pos.entryPrice, pos.entryShares, pos.fees);

      // Return the original investment plus realized PnL.
      const cashReturn = pos.actualCost + pnl;
      if (cashReturn > 0) {
        await this.portfolioManager.addCash(cashReturn);
      }

      const resolvedTrade = await resolveTrade(
        tradeId,
        isWin ? "WIN" : "LOSS",
        pnl.toFixed(6),
        exitPrice.toFixed(6),
        { exitReason: "RESOLUTION" },
      );

      this.updateConsecutiveLossState(isWin);

      await logAudit(
        "info",
        "TRADE_RESOLVED",
        `Trade ${tradeId} resolved: ${isWin ? "WIN" : "LOSS"}`,
        {
          tradeId,
          outcome: isWin ? "WIN" : "LOSS",
          exitPrice,
          pnl,
          winningOutcome,
          cashBalance: this.portfolioManager.getCashBalance(),
        },
      );

      this.untrackPosition(tradeId);

      logger.info(
        {
          tradeId,
          marketId,
          outcome: isWin ? "WIN" : "LOSS",
          pnl: pnl.toFixed(4),
        },
        isWin ? "✅ Trade WON" : "❌ Trade LOST",
      );

      this.emit("tradeResolved", {
        tradeId,
        isWin,
        pnl,
        exitPrice,
        trade: resolvedTrade,
      });
    }

    if (!this.hasOpenPositionsForMarket(marketId)) {
      this.cleanupMarket(marketId);
    }
  }

  /**
   * Force-resolve expired positions after resolution watch hard timeout.
   *
   * First attempts one final API poll. If positions remain unresolved after
   * that, they are force-closed as LOSS (conservative).
   */
  private async forceResolveExpired(marketId: string): Promise<void> {
    await this.pollResolution(marketId);

    const remaining: [string, OpenPosition][] = [];
    for (const [tradeId, pos] of this.openPositions) {
      if (pos.marketId === marketId) remaining.push([tradeId, pos]);
    }

    for (const [tradeId, pos] of remaining) {
      const pnl = calculateLossAmount(
        pos.entryPrice,
        pos.entryShares,
        pos.fees,
      );

      await resolveTrade(tradeId, "LOSS", pnl.toFixed(6), "0", {
        exitReason: "FORCE_TIMEOUT",
      });
      this.updateConsecutiveLossState(false);
      this.untrackPosition(tradeId);

      await logAudit(
        "warn",
        "TRADE_FORCE_RESOLVED",
        `Trade ${tradeId} force-resolved as LOSS after timeout`,
        { tradeId, marketId, pnl },
      );

      logger.warn(
        { tradeId, marketId, pnl: pnl.toFixed(4) },
        "Position force-resolved as LOSS after timeout",
      );

      this.emit("tradeResolved", {
        tradeId,
        isWin: false,
        pnl,
        exitPrice: 0,
        trade: null,
      });
    }
  }

  private updateConsecutiveLossState(isWin: boolean): void {
    const config = getConfig();
    const limit = config.strategy.consecutiveLossPauseLimit;
    if (limit <= 0) return;

    if (isWin) {
      this.consecutiveLossCount = 0;
      return;
    }

    this.consecutiveLossCount++;

    if (this.consecutiveLossCount < limit) return;
    if (this.paused) return;

    this.pausedByRiskGuard = true;
    this.riskPauseTriggeredAt = Date.now();
    this.pause();

    logAudit(
      "error",
      "RISK_GUARD",
      `Auto-paused after ${this.consecutiveLossCount} consecutive losses`,
      {
        consecutiveLossCount: this.consecutiveLossCount,
        pauseLimit: limit,
        cashBalance: this.portfolioManager.getCashBalance(),
      },
    ).catch(() => {});

    logger.error(
      {
        consecutiveLossCount: this.consecutiveLossCount,
        pauseLimit: limit,
      },
      "🛑 Risk guard triggered — system auto-paused",
    );

    if (config.strategy.riskAutoResumeEnabled) {
      if (this.riskAutoResumeTimer) {
        clearTimeout(this.riskAutoResumeTimer);
      }
      this.riskAutoResumeTimer = setTimeout(() => {
        this.resume()
          .then(() => {
            this.consecutiveLossCount = 0;
            this.pausedByRiskGuard = false;
            this.riskPauseTriggeredAt = null;
            this.riskAutoResumeTimer = null;
            logger.warn("Risk guard auto-resume executed");
          })
          .catch((err) =>
            logger.error({ err }, "Risk guard auto-resume failed"),
          );
      }, config.strategy.riskAutoResumeCooldownMs);
    }
  }

  private async loadOpenPositions(): Promise<void> {
    const rows = await loadOpenTradesWithMarkets();

    for (const { trade, marketEndDate } of rows) {
      this.trackPosition({
        tradeId: trade.id,
        marketId: trade.marketId ?? "",
        tokenId: trade.tokenId ?? "",
        outcomeLabel: trade.outcomeLabel ?? "",
        entryPrice: parseFloat(trade.entryPrice),
        entryShares: parseFloat(trade.entryShares),
        fees: parseFloat(trade.entryFees ?? "0"),
        actualCost: parseFloat(trade.actualCost ?? "0"),
        marketEndDate: marketEndDate ? new Date(marketEndDate) : new Date(),
        // Restored from the trade's recorded window-start price, for recross detection.
        strike: trade.btcTargetPrice ? parseFloat(trade.btcTargetPrice) : null,
      });

      if (trade.marketId) this.scheduleResolutionMonitor(trade.marketId);
    }

    if (rows.length > 0) {
      logger.info(
        { count: rows.length },
        "Loaded existing open positions from database",
      );
    }
  }

  /**
   * Load active markets for the current window from the DB on startup, keeping
   * only those still in the future or recently past with open positions.
   */
  private async loadActiveMarkets(): Promise<void> {
    const config = getConfig();
    const db = getDb();

    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const marketRows = await db
      .select()
      .from(schema.markets)
      .where(
        and(
          eq(schema.markets.active, true),
          eq(schema.markets.windowType, config.strategy.marketWindow),
          gte(schema.markets.endDate, cutoff.toISOString()),
        ),
      )
      .orderBy(desc(schema.markets.endDate))
      .limit(50);

    for (const row of marketRows) {
      if (this.activeMarkets.has(row.id)) continue;

      const tokenIds = row.clobTokenIds as string[] | null;
      const outcomes = row.outcomes as string[] | null;

      if (
        !tokenIds ||
        tokenIds.length < 2 ||
        !outcomes ||
        outcomes.length < 2
      ) {
        logger.warn(
          { marketId: row.id },
          "Skipping market with invalid token IDs or outcomes",
        );
        continue;
      }

      const endDate = row.endDate ? new Date(row.endDate) : new Date();
      const targetPrice = row.targetPrice ? parseFloat(row.targetPrice) : null;

      const hasOpenPositions = this.hasOpenPositionsForMarket(row.id);

      // Drop markets that ended over 30 min ago with no open positions.
      const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
      if (endDate.getTime() < thirtyMinutesAgo && !hasOpenPositions) {
        continue;
      }

      const state: ActiveMarketState = {
        marketId: row.id,
        conditionId: row.conditionId ?? null,
        yesTokenId: tokenIds[0]!,
        noTokenId: tokenIds[1]!,
        question: row.question ?? "",
        slug: row.slug ?? null,
        endDate,
        targetPrice,
        btcPriceAtWindowStart: null,
        outcomes,
        lastPrices: {},
        subscribedWs: false,
        resolved: false,
        rawMarket: row.metadata,
      };

      this.registerMarketState(state);
      this.pendingBtcFills.add(row.id);

      const effectiveTargetPrice = targetPrice ?? null;
      for (let i = 0; i < tokenIds.length; i++) {
        this.strategyEngine.registerMarket(
          row.id,
          tokenIds[i]!,
          outcomes[i] ?? `Outcome${i}`,
          endDate,
          effectiveTargetPrice,
        );
      }

      this.wsWatcher.subscribe(tokenIds);
      state.subscribedWs = true;

      // Ended markets no longer stream on the CLOB, so seed lastPrices from REST
      // midpoints once for the frontend while awaiting oracle resolution.
      if (endDate.getTime() < Date.now() && hasOpenPositions) {
        this.seedLastPricesForEndedMarket(state).catch((err) =>
          logger.debug(
            { err, marketId: row.id },
            "Could not seed prices for ended market — will show pending",
          ),
        );
      }

      logger.info(
        {
          marketId: row.id,
          question: row.question,
          endDate: endDate.toISOString(),
          hasOpenPositions,
        },
        "Loaded existing active market from database",
      );
    }

    if (marketRows.length > 0) {
      logger.info(
        { count: marketRows.length, active: this.activeMarkets.size },
        "Loaded existing active markets from database",
      );
    }
  }

  /** Seed lastPrices for an ended market from CLOB REST midpoints (no WS stream). */
  private async seedLastPricesForEndedMarket(
    state: ActiveMarketState,
  ): Promise<void> {
    const tokenIds = [state.yesTokenId, state.noTokenId];

    await Promise.all(
      tokenIds.map(async (tokenId) => {
        try {
          const { mid: midStr } = await this.client.getMidpoint(tokenId);
          const mid = parseFloat(midStr);
          if (!isFinite(mid) || mid <= 0) return;

          // Approximate bid/ask as ±0.5¢ around mid.
          state.lastPrices[tokenId] = {
            bid: Math.max(0, mid - 0.005),
            ask: Math.min(1, mid + 0.005),
            mid,
          };

          logger.debug(
            { marketId: state.marketId, tokenId, mid: mid.toFixed(4) },
            "Seeded lastPrices for ended market from CLOB midpoint",
          );
        } catch {
          // Non-fatal: an unquotable expired token just leaves no price.
        }
      }),
    );
  }

  /** Raw GammaMarkets for active markets, for API merging. */
  getRawActiveMarkets(): any[] {
    return Array.from(this.activeMarkets.values())
      .map(state => state.rawMarket)
      .filter(Boolean);
  }

  /** Remove expired markets with no open positions; kept otherwise until resolved. */
  private cleanupExpiredMarkets(): void {
    const now = Date.now();
    const toClean: string[] = [];

    for (const [marketId, state] of this.activeMarkets) {
      if (state.resolved) {
        toClean.push(marketId);
        continue;
      }
      if (state.endDate.getTime() > now) continue;
      if (this.hasOpenPositionsForMarket(marketId)) continue;
      toClean.push(marketId);
    }

    for (const marketId of toClean) {
      this.cleanupMarket(marketId);
    }

    if (toClean.length > 0) {
      logger.debug(
        { cleaned: toClean.length, remaining: this.activeMarkets.size },
        "Cleaned up expired markets",
      );
    }
  }

  private cleanupMarket(marketId: string): void {
    const state = this.activeMarkets.get(marketId);
    if (!state) return;

    // Never clean up a market that still has open positions.
    if (this.hasOpenPositionsForMarket(marketId)) return;

    if (state.subscribedWs) {
      this.wsWatcher.unsubscribe([state.yesTokenId, state.noTokenId]);
    }

    this.strategyEngine.unregisterMarket(state.yesTokenId);
    this.strategyEngine.unregisterMarket(state.noTokenId);

    if (state.conditionId) {
      this.conditionIdMap.delete(state.conditionId);
    }

    this.tokenToMarket.delete(state.yesTokenId);
    this.tokenToMarket.delete(state.noTokenId);

    this.activeMarkets.delete(marketId);
  }
}

let instance: MarketOrchestrator | null = null;
export function getMarketOrchestrator(): MarketOrchestrator {
  if (!instance) instance = new MarketOrchestrator();
  return instance;
}
