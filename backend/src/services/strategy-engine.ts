import { EventEmitter } from "events";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import type { BtcPriceData } from "../interfaces/websocket-types.js";
import type { MomentumSignal } from "../types/index.js";

const logger = createModuleLogger("strategy-engine");

/** Opportunity detected by the strategy engine */
export interface MarketOpportunity {
  marketId: string;
  tokenId: string;
  outcomeLabel: string; // "Up" or "Down"
  midpoint: number;
  bestAsk: number;
  bestBid: number;
  btcPrice: number;
  btcTargetPrice: number;
  btcDistanceUsd: number;

  secondsToEnd: number;
  trigger: string;
  /** Momentum signal at time of entry (for logging/display) */
  momentum: MomentumSignal | null;
}

/** A recorded BTC crossover of the market's target price */
export interface Crossover {
  side: "UP" | "DOWN";
  ts: number;
}

interface TokenPriceState {
  bestBid: number;
  bestAsk: number;
  midpoint: number;
  lastUpdate: number;
}

interface WatchedMarket {
  marketId: string;
  tokenId: string;
  outcomeLabel: string;
  endDate: Date;
  targetPrice: number | null;
  /** Timestamps when BTC crossed the target price */
  crossovers: Crossover[];
  /** Last known side of BTC relative to target — null until first BTC tick */
  lastBtcSide: "UP" | "DOWN" | null;
}

export class StrategyEngine extends EventEmitter {
  private priceStates: Map<string, TokenPriceState> = new Map();
  private watchedMarkets: Map<string, WatchedMarket> = new Map(); // tokenId → market info
  private evaluatedTokens: Set<string> = new Set(); // tokenId combos already triggered
  private openPositionCount = 0;
  private triggersCount = 0;

  registerMarket(
    marketId: string,
    tokenId: string,
    outcomeLabel: string,
    endDate: Date,
    targetPrice: number | null,
  ): void {
    this.watchedMarkets.set(tokenId, {
      marketId,
      tokenId,
      outcomeLabel,
      endDate,
      targetPrice,
      crossovers: [],
      lastBtcSide: null,
    });
  }

  unregisterMarket(tokenId: string): void {
    this.watchedMarkets.delete(tokenId);
    this.priceStates.delete(tokenId);
    this.evaluatedTokens.delete(tokenId);
  }

  updateTargetPrice(tokenId: string, targetPrice: number): void {
    const market = this.watchedMarkets.get(tokenId);
    if (market) {
      market.targetPrice = targetPrice;
    }
  }

  setOpenPositionCount(count: number): void {
    this.openPositionCount = count;
  }

  /** Allow the orchestrator to retry a token that failed to fill. */
  clearEvaluated(tokenId: string): void {
    this.evaluatedTokens.delete(tokenId);
  }

  resetForNewWindow(): void {
    this.evaluatedTokens.clear();
  }

  /** Get crossover data for a token (for persistence before unregister). */
  getCrossoverData(tokenId: string): Crossover[] | null {
    return this.watchedMarkets.get(tokenId)?.crossovers ?? null;
  }

  getStats() {
    return {
      watchedTokens: this.watchedMarkets.size,
      triggersCount: this.triggersCount,
      evaluatedTokens: this.evaluatedTokens.size,
    };
  }

  evaluatePrice(
    tokenId: string,
    bestBid: number,
    bestAsk: number,
    btcPriceData: BtcPriceData | null,
    momentumSignal: MomentumSignal | null = null,
  ): void {
    const midpoint = (bestBid + bestAsk) / 2;
    this.priceStates.set(tokenId, {
      bestBid,
      bestAsk,
      midpoint,
      lastUpdate: Date.now(),
    });

    const market = this.watchedMarkets.get(tokenId);
    if (!market) return;

    // ── Track BTC crossovers on every tick (even if we bail out early) ──
    if (btcPriceData && btcPriceData.price > 0 && market.targetPrice !== null) {
      this.trackCrossover(market, btcPriceData.price);
    }

    if (this.evaluatedTokens.has(tokenId)) return;

    const config = getConfig();
    const secondsToEnd = (market.endDate.getTime() - Date.now()) / 1000;

    if (
      secondsToEnd < 0 ||
      secondsToEnd > config.strategy.tradeFromWindowSeconds
    )
      return;
    if (midpoint < config.strategy.entryPriceThreshold) return;
    if (midpoint > config.strategy.maxEntryPrice) {
      logger.debug(
        {
          tokenId,
          midpoint: midpoint.toFixed(4),
          maxEntryPrice: config.strategy.maxEntryPrice.toFixed(4),
        },
        "Skipping: midpoint above maxEntryPrice ceiling",
      );
      return;
    }

    if (!btcPriceData || btcPriceData.price <= 0) {
      logger.debug({ tokenId }, "Skipping: no BTC price");
      return;
    }

    if (market.targetPrice === null) return;

    const btcDistanceUsd = Math.abs(btcPriceData.price - market.targetPrice);

    if (btcDistanceUsd < config.strategy.minBtcDistanceUsd) {
      logger.debug(
        { tokenId, btcDistanceUsd, min: config.strategy.minBtcDistanceUsd },
        "Skipping: BTC too close to target",
      );
      return;
    }

    // ── Momentum Filter ───────────────────────────────────────────────
    if (config.strategy.momentumEnabled && momentumSignal !== null) {
      if (this.checkMomentumFilter(market.outcomeLabel, momentumSignal)) return;
    }

    // ── Oscillation Filter ────────────────────────────────────────────
    if (config.strategy.oscillationFilterEnabled) {
      if (this.checkOscillationFilter(market, config)) return;
    }

    if (this.openPositionCount >= config.strategy.maxSimultaneousPositions)
      return;

    const opportunity: MarketOpportunity = {
      marketId: market.marketId,
      tokenId,
      outcomeLabel: market.outcomeLabel,
      midpoint,
      bestAsk,
      bestBid,
      btcPrice: btcPriceData.price,
      btcTargetPrice: market.targetPrice,
      btcDistanceUsd,
      secondsToEnd,
      trigger: "end_of_window_micro_profit",
      momentum: momentumSignal,
    };

    this.evaluatedTokens.add(tokenId);
    this.triggersCount++;

    logger.info(
      {
        marketId: market.marketId,
        outcome: market.outcomeLabel,
        midpoint: midpoint.toFixed(4),
        bestAsk: bestAsk.toFixed(4),
        btcPrice: btcPriceData.price.toFixed(2),
        btcDistance: btcDistanceUsd.toFixed(2),
        secondsToEnd: secondsToEnd.toFixed(1),
        momentum: momentumSignal
          ? `${momentumSignal.direction} ${momentumSignal.changeUsd >= 0 ? "+" : ""}$${momentumSignal.changeUsd.toFixed(2)}`
          : "none",
      },
      "Opportunity detected",
    );

    this.emit("opportunityDetected", opportunity);
  }

  // ── Crossover tracking ──────────────────────────────────────────────

  /**
   * Track whether BTC has crossed the target price.
   * Called on every price tick to maintain an accurate crossover history.
   */
  private trackCrossover(market: WatchedMarket, btcPrice: number): void {
    const currentSide: "UP" | "DOWN" =
      btcPrice >= market.targetPrice! ? "UP" : "DOWN";

    if (market.lastBtcSide !== null && currentSide !== market.lastBtcSide) {
      market.crossovers.push({ side: currentSide, ts: Date.now() });
    }

    market.lastBtcSide = currentSide;
  }

  /**
   * Oscillation filter — skip if BTC has crossed the target price too many
   * times in the recent window, indicating choppy/oscillating price action
   * that makes directional trades unreliable.
   *
   * Returns true if the trade should be SKIPPED.
   */
  private checkOscillationFilter(
    market: WatchedMarket,
    config: ReturnType<typeof getConfig>,
  ): boolean {
    const now = Date.now();
    const windowStart = now - config.strategy.oscillationWindowMs;
    let recentCount = 0;

    // Count crossovers in the lookback window (iterate from end for efficiency)
    for (let i = market.crossovers.length - 1; i >= 0; i--) {
      if (market.crossovers[i]!.ts < windowStart) break;
      recentCount++;
    }

    if (recentCount >= config.strategy.oscillationMaxCrossovers) {
      logger.info(
        {
          marketId: market.marketId,
          outcome: market.outcomeLabel,
          crossovers: recentCount,
          maxAllowed: config.strategy.oscillationMaxCrossovers,
          windowMs: config.strategy.oscillationWindowMs,
        },
        "Skipping: BTC oscillating around target (choppy price action)",
      );
      return true;
    }

    return false;
  }

  // ── Momentum filter ─────────────────────────────────────────────────

  /**
   * Momentum alignment filter.
   *
   * Skips when:
   * 1. No data yet (conservative)
   * 2. Neutral momentum (BTC ranging, no edge)
   * 3. Direction mismatch (outcome disagrees with BTC momentum)
   *
   * Returns true if the trade should be SKIPPED.
   */
  private checkMomentumFilter(
    outcomeLabel: string,
    momentum: MomentumSignal,
  ): boolean {
    if (!momentum.hasData) {
      logger.debug(
        { outcomeLabel },
        "Skipping: insufficient BTC price history for momentum",
      );
      return true;
    }

    if (momentum.direction === "NEUTRAL") {
      logger.info(
        {
          outcomeLabel,
          changeUsd: momentum.changeUsd.toFixed(2),
          lookbackMs: momentum.lookbackMs,
        },
        "Skipping: BTC momentum NEUTRAL (ranging market, no edge)",
      );
      return true;
    }

    if (outcomeLabel === "Up" && momentum.direction === "DOWN") {
      logger.info(
        {
          outcomeLabel,
          momentum: momentum.direction,
          changeUsd: momentum.changeUsd.toFixed(2),
        },
        "Skipping UP: BTC momentum is DOWN — direction mismatch",
      );
      return true;
    }

    if (outcomeLabel === "Down" && momentum.direction === "UP") {
      logger.info(
        {
          outcomeLabel,
          momentum: momentum.direction,
          changeUsd: momentum.changeUsd.toFixed(2),
        },
        "Skipping DOWN: BTC momentum is UP — direction mismatch",
      );
      return true;
    }

    return false;
  }

  getPriceState(tokenId: string): TokenPriceState | undefined {
    return this.priceStates.get(tokenId);
  }
}

// Singleton
let instance: StrategyEngine | null = null;
export function getStrategyEngine(): StrategyEngine {
  if (!instance) instance = new StrategyEngine();
  return instance;
}
