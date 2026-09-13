import { EventEmitter } from "events";
import { createModuleLogger } from "../utils/logger.js";
import { STRATEGY } from "../types/index.js";
import { marketNow } from "./market-clock.js";
import type { SettlementForecast } from "./settlement-model.js";

const logger = createModuleLogger("strategy-engine");

export interface FlowBurst {
  outcomeLabel: string;
  prints: number;
  shares: number;
  firstTs: number;
  lastTs: number;
}

export interface MarketOpportunity {
  marketId: string;
  tokenId: string;
  outcomeLabel: string;
  bestAsk: number;
  bestBid: number;
  strike: number;
  forecast: SettlementForecast;
  secondsToEnd: number;
  burst: FlowBurst;
}

export type SkipReason =
  | "outside_entry_window"
  | "no_strike"
  | "market_stale"
  | "no_forecast"
  | "model_opposes"
  | "quote_missing"
  | "price_band";

export interface Evaluation {
  marketId: string;
  tokenId: string;
  outcomeLabel: string;
  bestAsk: number | null;
  secondsToEnd: number;
  burst: FlowBurst;
  forecast: SettlementForecast | null;
  skipReason: SkipReason | null;
}

interface Quote {
  bestBid: number;
  bestAsk: number;
}

interface WatchedMarket {
  marketId: string;
  outcomeLabel: string;
  endDate: Date;
  strike: number | null;
}

interface LargePrint {
  ts: number;
  outcomeLabel: string;
  shares: number;
}

/**
 * Follows persistent taker flow. One large print means nothing; several on the
 * same side inside a few seconds is somebody leaning in, and that side resolved
 * their way well above what the price implied. The forecast never picks a
 * trade — it only vetoes a burst against a side it is confident about.
 */
export class StrategyEngine extends EventEmitter {
  private quotes = new Map<string, Quote>();
  private markets = new Map<string, WatchedMarket>();
  /** marketId → outcomeLabel → tokenId */
  private tokensByMarket = new Map<string, Map<string, string>>();
  private forecasts = new Map<string, SettlementForecast>();
  private lastTradeByMarket = new Map<string, number>();
  private prints = new Map<string, LargePrint[]>();
  private tradedMarkets = new Set<string>();
  private triggersCount = 0;

  registerMarket(marketId: string, tokenId: string, outcomeLabel: string, endDate: Date, strike: number | null): void {
    this.markets.set(tokenId, { marketId, outcomeLabel, endDate, strike });
    const tokens = this.tokensByMarket.get(marketId) ?? new Map<string, string>();
    tokens.set(outcomeLabel, tokenId);
    this.tokensByMarket.set(marketId, tokens);
  }

  unregisterMarket(tokenId: string): void {
    const market = this.markets.get(tokenId);
    this.markets.delete(tokenId);
    this.quotes.delete(tokenId);
    if (!market) return;
    const tokens = this.tokensByMarket.get(market.marketId);
    tokens?.delete(market.outcomeLabel);
    if (!tokens?.size) {
      this.tokensByMarket.delete(market.marketId);
      this.forecasts.delete(market.marketId);
      this.lastTradeByMarket.delete(market.marketId);
      this.prints.delete(market.marketId);
    }
  }

  releaseMarket(marketId: string): void {
    this.tradedMarkets.delete(marketId);
  }

  reset(): void {
    this.quotes.clear();
    this.markets.clear();
    this.tokensByMarket.clear();
    this.forecasts.clear();
    this.lastTradeByMarket.clear();
    this.prints.clear();
    this.tradedMarkets.clear();
    this.triggersCount = 0;
  }

  updateStrike(tokenId: string, strike: number): void {
    const market = this.markets.get(tokenId);
    if (market) market.strike = strike;
  }

  updateQuote(tokenId: string, bestBid: number, bestAsk: number): void {
    this.quotes.set(tokenId, { bestBid, bestAsk });
  }

  updateForecast(marketId: string, forecast: SettlementForecast): void {
    this.forecasts.set(marketId, forecast);
  }

  getStats() {
    return {
      watchedTokens: this.markets.size,
      triggersCount: this.triggersCount,
      tradedMarkets: this.tradedMarkets.size,
    };
  }

  /**
   * A taker fill on a token. Every fill keeps the market live; large ones feed
   * the burst buffer. Returns the evaluation when a burst was scored and emits
   * `opportunityDetected` when its side is bought.
   */
  noteTrade(tokenId: string, takerSide: "BUY" | "SELL", size: number, timestamp: number): Evaluation | null {
    const market = this.markets.get(tokenId);
    if (!market) return null;
    if (timestamp > (this.lastTradeByMarket.get(market.marketId) ?? 0)) {
      this.lastTradeByMarket.set(market.marketId, timestamp);
    }

    const { flowMinPrintShares, flowBurstMs, flowMinPrints } = STRATEGY;
    if (!(size >= flowMinPrintShares)) return null;

    const tokens = this.tokensByMarket.get(market.marketId);
    const outcomeLabel =
      takerSide === "BUY" ? market.outcomeLabel : [...(tokens?.keys() ?? [])].find((o) => o !== market.outcomeLabel);
    const burstToken = outcomeLabel && tokens?.get(outcomeLabel);
    if (!outcomeLabel || !burstToken) return null;

    const buf = (this.prints.get(market.marketId) ?? []).filter((p) => timestamp - p.ts <= flowBurstMs);
    buf.push({ ts: timestamp, outcomeLabel, shares: size });
    this.prints.set(market.marketId, buf);

    const same = buf.filter((p) => p.outcomeLabel === outcomeLabel);
    if (same.length < flowMinPrints) return null;

    return this.evaluate(burstToken, {
      outcomeLabel,
      prints: same.length,
      shares: same.reduce((s, p) => s + p.shares, 0),
      firstTs: same[0]!.ts,
      lastTs: timestamp,
    });
  }

  private evaluate(tokenId: string, burst: FlowBurst): Evaluation | null {
    const market = this.markets.get(tokenId);
    if (!market || this.tradedMarkets.has(market.marketId)) return null;

    const config = STRATEGY;
    const now = marketNow();
    const secondsToEnd = (market.endDate.getTime() - now) / 1000;
    const quote = this.quotes.get(tokenId);
    const forecast = this.forecasts.get(market.marketId) ?? null;
    const skip = (skipReason: SkipReason): Evaluation => ({
      marketId: market.marketId,
      tokenId,
      outcomeLabel: market.outcomeLabel,
      bestAsk: quote?.bestAsk ?? null,
      secondsToEnd,
      burst,
      forecast,
      skipReason,
    });

    if (secondsToEnd > config.entryWindowOpenSeconds || secondsToEnd < config.entryWindowCloseSeconds) {
      return skip("outside_entry_window");
    }
    if (market.strike === null) return skip("no_strike");
    const lastTrade = this.lastTradeByMarket.get(market.marketId);
    if (lastTrade === undefined || now - lastTrade > config.marketLivenessMs) return skip("market_stale");
    if (!forecast) return skip("no_forecast");
    const against = market.outcomeLabel === "Up" ? forecast.zScore < 0 : forecast.zScore > 0;
    if (against && Math.abs(forecast.zScore) >= config.vetoSdMultiple) return skip("model_opposes");
    if (!quote || quote.bestAsk <= 0 || quote.bestAsk >= 1 || quote.bestBid <= 0) return skip("quote_missing");
    if (quote.bestAsk < config.minEntryPrice || quote.bestAsk > config.maxEntryPrice) return skip("price_band");

    this.tradedMarkets.add(market.marketId);
    this.prints.delete(market.marketId);
    this.triggersCount++;

    const opportunity: MarketOpportunity = {
      marketId: market.marketId,
      tokenId,
      outcomeLabel: market.outcomeLabel,
      bestAsk: quote.bestAsk,
      bestBid: quote.bestBid,
      strike: market.strike,
      forecast,
      secondsToEnd,
      burst,
    };
    logger.info(
      {
        marketId: market.marketId,
        outcome: market.outcomeLabel,
        ask: quote.bestAsk,
        prints: burst.prints,
        shares: burst.shares,
        z: forecast.zScore.toFixed(2),
        secondsToEnd: secondsToEnd.toFixed(1),
      },
      "Opportunity detected",
    );
    this.emit("opportunityDetected", opportunity);
    return { ...skip("outside_entry_window"), skipReason: null };
  }
}

let instance: StrategyEngine | null = null;
export function getStrategyEngine(): StrategyEngine {
  if (!instance) instance = new StrategyEngine();
  return instance;
}
