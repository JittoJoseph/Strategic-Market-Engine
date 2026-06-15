import { EventEmitter } from "events";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import { WINDOW_CONFIGS } from "../types/index.js";
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
  btcPrice: number | null; // For passive telemetry

  secondsToEnd: number;
  secondsFromStart: number;
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
  ): void {
    this.watchedMarkets.set(tokenId, {
      marketId,
      tokenId,
      outcomeLabel,
      endDate,
    });
  }

  unregisterMarket(tokenId: string): void {
    this.watchedMarkets.delete(tokenId);
    this.priceStates.delete(tokenId);
    this.evaluatedTokens.delete(tokenId);
  }

  setOpenPositionCount(count: number): void {
    this.openPositionCount = count;
  }

  /** Allow the orchestrator to retry a token that failed to fill, after a cooldown to prevent API spam. */
  clearEvaluated(tokenId: string): void {
    setTimeout(() => {
      this.evaluatedTokens.delete(tokenId);
    }, 5000);
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
    const windowConfig = WINDOW_CONFIGS[config.strategy.marketWindow];
    const windowDurationSeconds = windowConfig.durationMs / 1000;

    const secondsToEnd = (market.endDate.getTime() - Date.now()) / 1000;
    const secondsFromStart = windowDurationSeconds - secondsToEnd;

    // Trigger only when the market window is actively open
    // and we are within the first `tradeFromWindowSeconds` of the window start
    if (
      secondsToEnd < 0 ||
      secondsFromStart < 0 ||
      secondsFromStart > config.strategy.tradeFromWindowSeconds
    ) {
      return;
    }

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

    if (this.openPositionCount >= config.strategy.maxSimultaneousPositions) {
      return;
    }

    const opportunity: MarketOpportunity = {
      marketId: market.marketId,
      tokenId,
      outcomeLabel: market.outcomeLabel,
      midpoint,
      bestAsk,
      bestBid,
      btcPrice: btcPriceData?.price ?? null, // passive telemetry
      secondsToEnd,
      secondsFromStart,
      trigger: "window_open_oscillation",
    };

    this.evaluatedTokens.add(tokenId);
    this.triggersCount++;

    logger.info(
      {
        marketId: market.marketId,
        outcome: market.outcomeLabel,
        midpoint: midpoint.toFixed(4),
        bestAsk: bestAsk.toFixed(4),
        secondsFromStart: secondsFromStart.toFixed(1),
        secondsToEnd: secondsToEnd.toFixed(1),
      },
      "Opportunity detected (Market Window Open)",
    );

    this.emit("opportunityDetected", opportunity);
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

