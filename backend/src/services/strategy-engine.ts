import { EventEmitter } from "events";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import type { BtcPriceData } from "../interfaces/websocket-types.js";

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
    if (this.evaluatedTokens.has(tokenId)) return;

    const config = getConfig();
    const secondsToEnd = (market.endDate.getTime() - Date.now()) / 1000;

    if (
      secondsToEnd < 0 ||
      secondsToEnd > config.strategy.tradeFromWindowSeconds
    )
      return;
    if (midpoint < config.strategy.entryPriceThreshold) return;

    if (!btcPriceData || btcPriceData.price <= 0) {
      logger.debug({ tokenId }, "Skipping: no BTC price");
      return;
    }

    // targetPrice is the BTC price at window open. It remains null until
    // tryFillBtcWindowStart() sets it; skip until then.
    if (market.targetPrice === null) return;

    const btcDistanceUsd = this.calculateBtcDistanceUsd(
      btcPriceData.price,
      market.targetPrice,
    );

    if (btcDistanceUsd < config.strategy.minBtcDistanceUsd) {
      logger.debug(
        { tokenId, btcDistanceUsd, min: config.strategy.minBtcDistanceUsd },
        "Skipping: BTC too close to target",
      );
      return;
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
      btcTargetPrice: market.targetPrice ?? 0,
      btcDistanceUsd,
      secondsToEnd,
      trigger: "end_of_window_micro_profit",
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
      },
      "Opportunity detected",
    );

    this.emit("opportunityDetected", opportunity);
  }

  private calculateBtcDistanceUsd(
    currentBtcPrice: number,
    targetPrice: number,
  ): number {
    return Math.abs(currentBtcPrice - targetPrice);
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
