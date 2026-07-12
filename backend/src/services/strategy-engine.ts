import { EventEmitter } from "events";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import type { BtcPriceData } from "../interfaces/websocket-types.js";

const logger = createModuleLogger("strategy-engine");

/**
 * Barrier fair value for the favorite: P(outcome does not reverse before expiry),
 * as a driftless first-passage via the reflection principle, 1 - 2·Φ(-z).
 * Capped at 0.995: BTC jump/fat-tail risk means a pure Gaussian understates the
 * chance of reversal, so no entry is treated as more certain than ~99.5%.
 */
export function barrierFairValue(z: number): number {
  if (z <= 0) return 0.5;
  const fair = 1 - 2 * standardNormalCdf(-z);
  return Math.max(0.5, Math.min(0.995, fair));
}

/** Standard normal CDF via erf approximation (Abramowitz & Stegun 7.1.26). */
function standardNormalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}

/** Opportunity detected by the barrier strategy engine. */
export interface MarketOpportunity {
  marketId: string;
  tokenId: string;
  outcomeLabel: string; // "Up" or "Down" — always the current favorite
  midpoint: number;
  bestAsk: number;
  bestBid: number;
  btcPrice: number;
  /** Window-start (strike) BTC price the market resolves against. */
  strike: number;
  /** Signed distance in favour of this outcome (always > 0 at entry). */
  signedDistanceUsd: number;
  /** BTC realized per-second volatility used for the z-score. */
  sigmaPerSec: number;
  /** Vol-adjusted distance to the strike: distance / (sigma·√secondsLeft). */
  z: number;
  /** Barrier-implied fair value of the favorite at entry. */
  fairValue: number;
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
  /** BTC price at window open — the value the market resolves against. */
  strike: number | null;
}

/**
 * Barrier strategy engine.
 *
 * Edge: in the final seconds a BTC Up/Down market resolves on Chainlink
 * end-vs-open, which we observe in real time — yet the thin CLOB reprices
 * slowly, charging a roughly flat ~0.97 for the favorite regardless of how
 * certain the outcome already is. When the favorite is many volatility-sigmas
 * clear of the strike (high z), the true certainty is ~99%+ while the book
 * still offers ~0.97, a persistent ~2% edge with a tiny tail. We enter only
 * when that vol-adjusted cushion (z) clears a threshold.
 */
export class StrategyEngine extends EventEmitter {
  private priceStates: Map<string, TokenPriceState> = new Map();
  private watchedMarkets: Map<string, WatchedMarket> = new Map(); // tokenId → market
  private evaluatedTokens: Set<string> = new Set();
  private openPositionCount = 0;
  private triggersCount = 0;

  registerMarket(
    marketId: string,
    tokenId: string,
    outcomeLabel: string,
    endDate: Date,
    strike: number | null,
  ): void {
    this.watchedMarkets.set(tokenId, {
      marketId,
      tokenId,
      outcomeLabel,
      endDate,
      strike,
    });
  }

  unregisterMarket(tokenId: string): void {
    this.watchedMarkets.delete(tokenId);
    this.priceStates.delete(tokenId);
    this.evaluatedTokens.delete(tokenId);
  }

  /** Set the window-start strike price once BTC is known (relative Up/Down markets). */
  updateStrike(tokenId: string, strike: number): void {
    const market = this.watchedMarkets.get(tokenId);
    if (market) market.strike = strike;
  }

  setOpenPositionCount(count: number): void {
    this.openPositionCount = count;
  }

  /** Allow the orchestrator to retry a token that failed to fill. */
  clearEvaluated(tokenId: string): void {
    this.evaluatedTokens.delete(tokenId);
  }

  getStats() {
    return {
      watchedTokens: this.watchedMarkets.size,
      triggersCount: this.triggersCount,
      evaluatedTokens: this.evaluatedTokens.size,
    };
  }

  /**
   * Evaluate a token on every price tick. Emits `opportunityDetected` when the
   * token is the current favorite and its vol-adjusted cushion clears the gate.
   */
  evaluatePrice(
    tokenId: string,
    bestBid: number,
    bestAsk: number,
    btcPriceData: BtcPriceData | null,
    sigmaPerSec: number | null,
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

    // Only trade the final stretch of the window, never after close.
    if (
      secondsToEnd <= 0 ||
      secondsToEnd > config.strategy.entryFromWindowSeconds
    )
      return;

    if (!btcPriceData || btcPriceData.price <= 0) return;
    if (market.strike === null) return;

    // Distance in favour of this outcome; only the current favorite is eligible.
    const signedDistanceUsd =
      market.outcomeLabel === "Up"
        ? btcPriceData.price - market.strike
        : market.strike - btcPriceData.price;
    if (signedDistanceUsd <= 0) return;

    if (sigmaPerSec === null || sigmaPerSec <= 0) return;

    const z = signedDistanceUsd / (sigmaPerSec * Math.sqrt(secondsToEnd));
    if (z < config.strategy.zEntryThreshold) return;

    if (bestAsk <= 0 || bestAsk > config.strategy.maxEntryPrice) return;

    const fairValue = barrierFairValue(z);
    if (fairValue - bestAsk < config.strategy.minEntryEdge) return;

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
      strike: market.strike,
      signedDistanceUsd,
      sigmaPerSec,
      z,
      fairValue,
      secondsToEnd,
      trigger: "barrier_zscore",
    };

    this.evaluatedTokens.add(tokenId);
    this.triggersCount++;

    logger.info(
      {
        marketId: market.marketId,
        outcome: market.outcomeLabel,
        midpoint: midpoint.toFixed(4),
        z: z.toFixed(2),
        sigmaPerSec: sigmaPerSec.toFixed(3),
        distance: signedDistanceUsd.toFixed(1),
        fairValue: fairValue.toFixed(4),
        secondsToEnd: secondsToEnd.toFixed(1),
      },
      "Opportunity detected (barrier)",
    );

    this.emit("opportunityDetected", opportunity);
  }

  getPriceState(tokenId: string): TokenPriceState | undefined {
    return this.priceStates.get(tokenId);
  }
}

let instance: StrategyEngine | null = null;
export function getStrategyEngine(): StrategyEngine {
  if (!instance) instance = new StrategyEngine();
  return instance;
}
