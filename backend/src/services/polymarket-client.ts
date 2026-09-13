import axios, { AxiosInstance } from "axios";
import { createModuleLogger } from "../utils/logger.js";
import { withRetry, isRateLimitError } from "../utils/retry.js";
import { POLY_URLS, GammaMarketSchema, type GammaMarket } from "../types/index.js";
import { z } from "zod";

const logger = createModuleLogger("polymarket-client");

const parseJsonArray = <T = string>(raw: string | null | undefined, map?: (v: unknown) => T): T[] => {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (map ? parsed.map(map) : parsed) : [];
  } catch {
    return [];
  }
};

export class PolymarketClient {
  private gammaApi: AxiosInstance = axios.create({
    baseURL: POLY_URLS.GAMMA_API_BASE,
    timeout: 30_000,
    headers: { Accept: "application/json", "User-Agent": "PenguinX/3.0" },
  });

  async getMarkets(slugs: string[]): Promise<GammaMarket[]> {
    return withRetry(
      async () => {
        const params = new URLSearchParams();
        for (const slug of slugs) params.append("slug", slug);
        const response = await this.gammaApi.get("/markets", { params });
        return z.array(GammaMarketSchema).parse(response.data);
      },
      { maxRetries: 3, retryOn: isRateLimitError },
    );
  }

  async getMarketById(marketId: string): Promise<GammaMarket | null> {
    return withRetry(
      async () => {
        try {
          const response = await this.gammaApi.get(`/markets/${encodeURIComponent(marketId)}`);
          return GammaMarketSchema.parse(response.data);
        } catch (error) {
          logger.warn({ marketId, error }, "Market-by-id failed, trying query fallback");
          const fallback = await this.gammaApi.get("/markets", { params: { id: marketId } });
          return z.array(GammaMarketSchema).parse(fallback.data)[0] ?? null;
        }
      },
      { maxRetries: 3, retryOn: isRateLimitError },
    );
  }

  static parseClobTokenIds(market: GammaMarket): string[] {
    return parseJsonArray(market.clobTokenIds);
  }

  static parseOutcomes(market: GammaMarket): string[] {
    return parseJsonArray(market.outcomes);
  }

  static parseOutcomePrices(market: GammaMarket): number[] {
    return parseJsonArray(market.outcomePrices, Number);
  }
}

let instance: PolymarketClient | null = null;
export function getPolymarketClient(): PolymarketClient {
  if (!instance) instance = new PolymarketClient();
  return instance;
}
