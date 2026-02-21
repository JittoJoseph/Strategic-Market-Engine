import { EventEmitter } from "events";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import { WINDOW_CONFIGS, type Orderbook } from "../types/index.js";
import {
  getDb,
  createSimulatedTrade,
  resolveTrade,
  logAudit,
  loadOpenTradesWithMarkets,
} from "../db/client.js";
import * as schema from "../db/schema.js";
import { eq, and } from "drizzle-orm";

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
  calculateWinProfit,
  calculateLossAmount,
} from "./execution-simulator.js";
import { getBtcPriceWatcher, BtcPriceWatcher } from "./btc-price-watcher.js";
import { getPolymarketClient, PolymarketClient } from "./polymarket-client.js";

import type {
  PriceUpdateEvent,
  BestBidAskEvent,
  MarketResolvedEvent,
  OrderbookUpdateEvent,
  BtcPriceData,
} from "../interfaces/websocket-types.js";

const logger = createModuleLogger("market-orchestrator");

/** Tracks an active market through its lifecycle */
interface ActiveMarketState {
  marketId: string;
  yesTokenId: string;
  noTokenId: string;
  question: string;
  slug: string | null;
  endDate: Date;
  targetPrice: number | null;
  /** BTC spot price captured at the moment this market was first registered.
   *  For Up/Down relative markets this IS the "price to beat" — the window
   *  resolves UP if BTC ends >= this value, DOWN otherwise. */
  btcPriceAtWindowStart: number | null;
  outcomes: string[];
  lastPrices: Record<string, { bid: number; ask: number; mid: number }>;
  subscribedWs: boolean;
  resolved: boolean;
}

/** Tracks an open simulated position during resolution */
interface OpenPosition {
  tradeId: string;
  marketId: string;
  tokenId: string;
  outcomeLabel: string;
  entryPrice: number;
  entryShares: number;
  fees: number;
  marketEndDate: Date;
}

/**
 * Central coordinator for the PenguinX system.
 *
 * Lifecycle:
 *   1. Scanner finds BTC markets for the configured window
 *   2. Orchestrator subscribes to CLOB WebSocket for real-time prices
 *   3. StrategyEngine evaluates entry conditions on every price update
 *   4. On opportunity: ExecutionSimulator fills a limit buy, trade is persisted
 *   5. After market ends: monitor for resolution via WS + polling
 *   6. Resolve trades as WIN/LOSS via oracle resolution
 */
export class MarketOrchestrator extends EventEmitter {
  private scanner: MarketScanner;
  private wsWatcher: MarketWebSocketWatcher;
  private strategyEngine: StrategyEngine;
  private btcWatcher: BtcPriceWatcher;
  private client: PolymarketClient;

  private activeMarkets: Map<string, ActiveMarketState> = new Map();
  private openPositions: Map<string, OpenPosition> = new Map();
  private resolutionTimers: Map<string, ReturnType<typeof setInterval>> =
    new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  private running = false;
  private paused = false;
  private cycleCount = 0;

  constructor() {
    super();
    this.scanner = getMarketScanner();
    this.wsWatcher = getMarketWebSocketWatcher();
    this.strategyEngine = getStrategyEngine();
    this.btcWatcher = getBtcPriceWatcher();
    this.client = getPolymarketClient();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const config = getConfig();
    const windowLabel = WINDOW_CONFIGS[config.strategy.marketWindow].label;

    logger.info(
      {
        window: config.strategy.marketWindow,
        label: windowLabel,
        threshold: config.strategy.entryPriceThreshold,
        tradeWindowSec: config.strategy.tradeFromWindowSeconds,
        maxPositions: config.strategy.maxSimultaneousPositions,
      },
      "Starting market orchestrator",
    );

    // Load any existing open trades from DB
    await this.loadOpenPositions();

    // Wire up event handlers
    this.wireEvents();

    // Start child services
    this.wsWatcher.start();
    await this.scanner.start();

    // Start periodic cleanup of expired markets without positions (every 10s)
    this.cleanupTimer = setInterval(() => this.cleanupExpiredMarkets(), 10_000);

    logger.info("Market orchestrator fully started");
  }

  stop(): void {
    this.running = false;
    this.scanner.stop();
    this.wsWatcher.stop();

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const [marketId, timer] of this.resolutionTimers) {
      clearInterval(timer);
    }
    this.resolutionTimers.clear();

    logger.info("Market orchestrator stopped");
  }

  /**
   * Pause all trading activity. Used by the wipe endpoint.
   * Stops scanner and strategy evaluation but keeps WS alive
   * for any open position resolution. System won't resume until restart.
   */
  pause(): void {
    this.paused = true;
    this.scanner.stop();

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    logger.warn("System paused — restart required to resume");
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
      scanner: {
        discoveredCount: this.scanner.getDiscoveredCount(),
      },
      ws: this.wsWatcher.getStats(),
      strategy: this.strategyEngine.getStats(),
      btcConnected: this.btcWatcher.isConnected(),
      btcPrice: this.btcWatcher.getCurrentPrice()?.price ?? null,
    };
  }

  getLiveMarkets() {
    const now = Date.now();
    const windowDurationMs =
      WINDOW_CONFIGS[getConfig().strategy.marketWindow]?.durationMs ??
      5 * 60_000;
    return Array.from(this.activeMarkets.values())
      .filter((m) => !m.resolved)
      .sort((a, b) => a.endDate.getTime() - b.endDate.getTime())
      .map((m) => {
        const hasPosition = Array.from(this.openPositions.values()).some(
          (p) => p.marketId === m.marketId,
        );
        const windowStartMs = m.endDate.getTime() - windowDurationMs;
        // Three-state status:
        //   UPCOMING  — window has not yet opened (price to beat unknown)
        //   ACTIVE    — window is currently open (trading live)
        //   ENDED     — window closed, awaiting oracle resolution
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

    // WS → price updates from CLOB
    this.wsWatcher.on("priceUpdate", (ev: PriceUpdateEvent) =>
      this.onPriceUpdate(ev),
    );
    this.wsWatcher.on("bestBidAskUpdate", (ev: BestBidAskEvent) =>
      this.onBestBidAskUpdate(ev),
    );
    this.wsWatcher.on("orderbookUpdate", (ev: OrderbookUpdateEvent) =>
      this.onOrderbookUpdate(ev),
    );
    this.wsWatcher.on("marketResolved", (ev: MarketResolvedEvent) =>
      this.onMarketResolved(ev),
    );

    // BTC price → lazily fill btcPriceAtWindowStart for markets whose window had
    //              not yet opened when they were first discovered, and for any
    //              cold-start race. Only fire once the BTC tick timestamp is at or
    //              after the window-open second so we match Polymarket's oracle.
    this.btcWatcher.on("btcPriceUpdate", (data: BtcPriceData) => {
      const windowDurationMs =
        WINDOW_CONFIGS[getConfig().strategy.marketWindow]?.durationMs ??
        5 * 60_000;
      for (const state of this.activeMarkets.values()) {
        if (state.btcPriceAtWindowStart !== null) continue;
        const windowStartMs = state.endDate.getTime() - windowDurationMs;
        // Don't fill until the window has actually opened.
        if (data.timestamp < windowStartMs) continue;
        const buffered = this.btcWatcher.getPriceAt(windowStartMs);
        state.btcPriceAtWindowStart = buffered ?? data.price;
        logger.info(
          {
            marketId: state.marketId,
            btcPrice: state.btcPriceAtWindowStart,
            source: buffered !== null ? "buffer" : "current-tick",
          },
          "btcPriceAtWindowStart set lazily",
        );
      }
    });

    // Strategy → opportunity detected
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
   * Handle a newly discovered market from the scanner.
   */
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

    // Safety guard: skip markets whose trading window has already closed.
    // The Gamma API may return markets with active=true/closed=false even when
    // their endDate is months in the past (awaiting oracle resolution).
    if (endDate.getTime() < Date.now()) {
      logger.debug(
        {
          marketId: market.id,
          endDate: endDate.toISOString(),
          question: market.question,
        },
        "Skipping expired market (endDate in the past)",
      );
      return;
    }

    // Capture the Chainlink BTC/USD price at the exact window-open second.
    // For pre-discovered future windows (window hasn't started yet) we leave
    // this null — using the current live price would be wrong. The btcPriceUpdate
    // lazy fill (wireEvents) will set it once the first tick after windowStart
    // arrives, using the history buffer to pinpoint the exact oracle snapshot.
    const windowDurationMs =
      WINDOW_CONFIGS[getConfig().strategy.marketWindow]?.durationMs ??
      5 * 60_000;
    const windowStartMs = endDate.getTime() - windowDurationMs;
    const btcPriceAtWindowStart =
      windowStartMs <= Date.now()
        ? (this.btcWatcher.getPriceAt(windowStartMs) ??
          this.btcWatcher.getCurrentPrice()?.price ??
          null)
        : null;

    const state: ActiveMarketState = {
      marketId: market.id,
      yesTokenId: tokenIds[0]!,
      noTokenId: tokenIds[1]!,
      question: market.question ?? "",
      slug: market.slug ?? null,
      endDate,
      targetPrice,
      btcPriceAtWindowStart,
      outcomes,
      lastPrices: {},
      subscribedWs: false,
      resolved: false,
    };

    this.activeMarkets.set(market.id, state);

    // Register both outcome tokens with the strategy engine.
    // For relative Up/Down markets (targetPrice=null), use btcPriceAtWindowStart
    // as the effective target so that MIN_BTC_DISTANCE_USD can be applied correctly.
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

    // Subscribe to WebSocket for real-time data
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

  /**
   * Handle price_change events — evaluate both tokens for opportunities.
   */
  private onPriceUpdate(ev: PriceUpdateEvent): void {
    const tokenId = ev.tokenId;
    const bestBid = parseFloat(ev.bestBid);
    const bestAsk = parseFloat(ev.bestAsk);

    // Update local price state
    for (const state of this.activeMarkets.values()) {
      if (state.yesTokenId === tokenId || state.noTokenId === tokenId) {
        state.lastPrices[tokenId] = {
          bid: bestBid,
          ask: bestAsk,
          mid: (bestBid + bestAsk) / 2,
        };
        break;
      }
    }

    // Feed to strategy engine
    this.strategyEngine.evaluatePrice(
      tokenId,
      bestBid,
      bestAsk,
      this.btcWatcher.getCurrentPrice(),
    );
  }

  /**
   * Handle best_bid_ask events (custom feature).
   */
  private onBestBidAskUpdate(ev: BestBidAskEvent): void {
    const bestBid = parseFloat(ev.bestBid);
    const bestAsk = parseFloat(ev.bestAsk);
    const mid = (bestBid + bestAsk) / 2;

    // Update local price state so getLiveMarkets() always has fresh prices
    for (const state of this.activeMarkets.values()) {
      if (state.yesTokenId === ev.tokenId || state.noTokenId === ev.tokenId) {
        state.lastPrices[ev.tokenId] = { bid: bestBid, ask: bestAsk, mid };
        break;
      }
    }

    // Also feed to strategy engine
    this.strategyEngine.evaluatePrice(
      ev.tokenId,
      bestBid,
      bestAsk,
      this.btcWatcher.getCurrentPrice(),
    );
  }

  /**
   * Handle full orderbook snapshots — primarily used during opportunity evaluation.
   */
  private onOrderbookUpdate(ev: OrderbookUpdateEvent): void {
    // Orderbook is used on-demand, not stored in memory
  }

  /**
   * Handle WebSocket market resolution event.
   */
  private async onMarketResolved(ev: MarketResolvedEvent): Promise<void> {
    const { conditionId, winningAssetId, winningOutcome } = ev;

    logger.info(
      { conditionId, winningAssetId, winningOutcome },
      "Market resolved via WebSocket",
    );

    // Find active market by condition ID
    for (const [marketId, state] of this.activeMarkets) {
      if (state.resolved) continue;

      // Need to match by looking up condition ID from DB
      const db = getDb();
      const [row] = await db
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.conditionId, conditionId))
        .limit(1);

      if (!row) continue;

      state.resolved = true;

      // Resolve all open positions for this market
      await this.resolvePositionsForMarket(
        row.id,
        winningAssetId,
        winningOutcome,
      );
    }
  }

  /**
   * Execute a simulated trade when the strategy detects an opportunity.
   */
  private async onOpportunity(opp: MarketOpportunity): Promise<void> {
    if (this.paused) return;

    const config = getConfig();

    try {
      // Fetch the full orderbook for this token
      const orderbookResult = await this.client.getOrderbook(opp.tokenId);
      if (!orderbookResult?.data || !orderbookResult.data.asks?.length) {
        logger.warn(
          { tokenId: opp.tokenId },
          "No orderbook available — skipping",
        );
        return;
      }
      const orderbook = orderbookResult.data;

      // Calculate fee rate
      let feeRateBps: number;
      try {
        feeRateBps = await this.client.getFeeRate(opp.tokenId);
      } catch {
        // Default to crypto market fee rate
        feeRateBps = 25; // 0.25 * 100
      }

      // Simulate the limit buy
      const execution = simulateLimitBuy(
        orderbook,
        config.simulation.amountUsd,
        opp.bestAsk, // Place limit at best ask - taker fill
        feeRateBps,
      );

      if (execution.totalShares <= 0) {
        logger.warn(
          { tokenId: opp.tokenId },
          "No fill from simulation — skipping",
        );
        return;
      }

      // Calculate expected profit
      const expectedProfit = calculateWinProfit(
        execution.averagePrice,
        execution.totalShares,
        execution.fees,
      );

      // Skip if expected profit is negative or negligible
      if (expectedProfit < 0.001) {
        logger.debug(
          { expectedProfit, tokenId: opp.tokenId },
          "Expected profit too small, skipping",
        );
        return;
      }

      // Persist the simulated trade
      const tradeRow = await createSimulatedTrade({
        marketId: opp.marketId,
        tokenId: opp.tokenId,
        outcomeLabel: opp.outcomeLabel,
        strategyTrigger: "end_of_window_micro_profit",
        entryTs: new Date(),
        entryPrice: execution.averagePrice.toFixed(6),
        entryShares: execution.totalShares.toFixed(6),
        entryFees: execution.fees.toFixed(6),
        simulatedUsdAmount: config.simulation.amountUsd,
        feeRateBps: execution.feeRateBps,
        btcPriceAtEntry: opp.btcPrice,
        btcTargetPrice: opp.btcTargetPrice,
        btcDistanceUsd: opp.btcDistanceUsd,
        orderbookSnapshot: execution.orderbookSnapshot,
      });
      const tradeId = tradeRow!.id;

      // Track open position
      const market = this.activeMarkets.get(opp.marketId);
      this.openPositions.set(tradeId, {
        tradeId,
        marketId: opp.marketId,
        tokenId: opp.tokenId,
        outcomeLabel: opp.outcomeLabel,
        entryPrice: execution.averagePrice,
        entryShares: execution.totalShares,
        fees: execution.fees,
        marketEndDate: market?.endDate ?? new Date(),
      });

      // Update strategy engine with position count
      this.strategyEngine.setOpenPositionCount(this.openPositions.size);

      // Set up resolution monitoring if market has ended or will end soon
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
          cost: execution.netCost,
          expectedProfit,
          btcPrice: opp.btcPrice,
          btcTarget: opp.btcTargetPrice,
          btcDistance: opp.btcDistanceUsd,
          secondsToEnd: opp.secondsToEnd,
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
          cost: execution.netCost.toFixed(4),
          fees: execution.fees.toFixed(4),
          expectedProfit: expectedProfit.toFixed(4),
          btcPrice: opp.btcPrice.toFixed(2),
          btcDistance: opp.btcDistanceUsd.toFixed(2),
        },
        "📈 Simulated trade opened",
      );
    } catch (error) {
      logger.error(
        { error, marketId: opp.marketId, tokenId: opp.tokenId },
        "Failed to execute simulated trade",
      );
    }
  }

  /**
   * Schedule periodic resolution polls for a market.
   */
  private scheduleResolutionMonitor(marketId: string): void {
    if (this.resolutionTimers.has(marketId)) return;

    const config = getConfig();
    const checkInterval = 5000; // 5s
    const maxChecks =
      (config.strategy.resolutionWatchMinutes * 60 * 1000) / checkInterval;
    let checkCount = 0;

    const timer = setInterval(async () => {
      checkCount++;
      if (checkCount > maxChecks || !this.running) {
        clearInterval(timer);
        this.resolutionTimers.delete(marketId);
        // Force resolve any remaining positions as expired
        await this.forceResolveExpired(marketId);
        return;
      }

      await this.pollResolution(marketId);
    }, checkInterval);

    this.resolutionTimers.set(marketId, timer);
  }

  /**
   * Poll Gamma API for market resolution status.
   */
  private async pollResolution(marketId: string): Promise<void> {
    try {
      const market = await this.client.getMarketById(marketId);
      if (!market) return;

      // Check resolved status — market is resolved when closed and prices hit 1/0
      if (!market.closed) return;

      const state = this.activeMarkets.get(marketId);
      if (state) state.resolved = true;

      // Determine winning token
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

        // Clean up timer
        const timer = this.resolutionTimers.get(marketId);
        if (timer) {
          clearInterval(timer);
          this.resolutionTimers.delete(marketId);
        }
      }
    } catch (error) {
      logger.error({ error, marketId }, "Resolution poll failed");
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

      const resolvedTrade = await resolveTrade(
        tradeId,
        isWin ? "WIN" : "LOSS",
        pnl.toFixed(6),
        exitPrice.toFixed(6),
      );

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
        },
      );

      this.openPositions.delete(tradeId);

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

    // Update strategy engine position count
    this.strategyEngine.setOpenPositionCount(this.openPositions.size);

    // Cleanup active market
    this.cleanupMarket(marketId);
  }

  /**
   * Force-resolve expired positions after resolution watch period.
   */
  private async forceResolveExpired(marketId: string): Promise<void> {
    for (const [tradeId, pos] of this.openPositions) {
      if (pos.marketId !== marketId) continue;

      // Try one last resolve via API
      try {
        await this.pollResolution(marketId);
      } catch {
        // If still unresolved, mark as loss (conservative)
        const pnl = calculateLossAmount(
          pos.entryPrice,
          pos.entryShares,
          pos.fees,
        );

        await resolveTrade(tradeId, "LOSS", pnl.toFixed(6), "0");

        this.openPositions.delete(tradeId);

        logger.warn(
          { tradeId, marketId },
          "Position expired without resolution — marked as loss",
        );
      }
    }

    this.strategyEngine.setOpenPositionCount(this.openPositions.size);
    this.cleanupMarket(marketId);
  }

  /**
   * Load existing open trades from the database on startup (single JOIN query).
   */
  private async loadOpenPositions(): Promise<void> {
    const rows = await loadOpenTradesWithMarkets();

    for (const { trade, marketEndDate } of rows) {
      this.openPositions.set(trade.id, {
        tradeId: trade.id,
        marketId: trade.marketId ?? "",
        tokenId: trade.tokenId ?? "",
        outcomeLabel: trade.outcomeLabel ?? "",
        entryPrice: parseFloat(trade.entryPrice),
        entryShares: parseFloat(trade.entryShares),
        fees: parseFloat(trade.entryFees ?? "0"),
        marketEndDate: marketEndDate ? new Date(marketEndDate) : new Date(),
      });

      // Set up resolution monitoring for existing positions
      if (trade.marketId) this.scheduleResolutionMonitor(trade.marketId);
    }

    this.strategyEngine.setOpenPositionCount(this.openPositions.size);

    if (rows.length > 0) {
      logger.info(
        { count: rows.length },
        "Loaded existing open positions from database",
      );
    }
  }

  /**
   * Periodically remove expired markets that have no open positions.
   * Markets with open positions are kept until those positions resolve.
   */
  private cleanupExpiredMarkets(): void {
    const now = Date.now();
    const toClean: string[] = [];

    for (const [marketId, state] of this.activeMarkets) {
      if (state.resolved) {
        toClean.push(marketId);
        continue;
      }
      // Keep active markets
      if (state.endDate.getTime() > now) continue;
      // Keep ended markets that have open positions
      const hasPosition = Array.from(this.openPositions.values()).some(
        (p) => p.marketId === marketId,
      );
      if (hasPosition) continue;
      // Expired + no positions → safe to clean up
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

  /**
   * Cleanup a fully resolved market.
   */
  private cleanupMarket(marketId: string): void {
    const state = this.activeMarkets.get(marketId);
    if (!state) return;

    // Unsubscribe from WS
    if (state.subscribedWs) {
      this.wsWatcher.unsubscribe([state.yesTokenId, state.noTokenId]);
    }

    // Unregister from strategy engine
    this.strategyEngine.unregisterMarket(state.yesTokenId);
    this.strategyEngine.unregisterMarket(state.noTokenId);

    this.activeMarkets.delete(marketId);
  }
}

// Singleton
let instance: MarketOrchestrator | null = null;
export function getMarketOrchestrator(): MarketOrchestrator {
  if (!instance) instance = new MarketOrchestrator();
  return instance;
}
