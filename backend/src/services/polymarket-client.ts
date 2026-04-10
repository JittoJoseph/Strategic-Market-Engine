import axios, { AxiosInstance, AxiosError } from "axios";
import { createModuleLogger } from "../utils/logger.js";
import { withRetry, isRateLimitError } from "../utils/retry.js";
import {
  POLY_URLS,
  GammaMarketSchema,
  GammaEventSchema,
  OrderbookSchema,
  MidpointResponseSchema,
  type GammaMarket,
  type GammaEvent,
  type Orderbook,
  type MidpointResponse,
} from "../types/index.js";
import { z } from "zod";
import { logAudit } from "../db/client.js";

const logger = createModuleLogger("polymarket-client");

/**
 * Polymarket API client for BTC window markets.
 *
 * Gamma API — market discovery (https://gamma-api.polymarket.com)
 * CLOB API — orderbook, price, midpoint, fee rates (https://clob.polymarket.com)
 */
export class PolymarketClient {
  private gammaApi: AxiosInstance;
  private clobApi: AxiosInstance;
  private requestCounts = { gammaApi: 0, clobApi: 0, errors429: 0 };

  constructor() {
    this.gammaApi = axios.create({
      baseURL: POLY_URLS.GAMMA_API_BASE,
      timeout: 30000,
      headers: { Accept: "application/json", "User-Agent": "PenguinX/3.0" },
    });

    this.clobApi = axios.create({
      baseURL: POLY_URLS.CLOB_BASE,
      timeout: 30000,
      headers: { Accept: "application/json", "User-Agent": "PenguinX/3.0" },
    });

    this.setupInterceptors();
  }

  private setupInterceptors() {
    const handleError = (apiName: string) => async (error: AxiosError) => {
      if (error.response?.status === 429) {
        this.requestCounts.errors429++;
        logger.warn(
          { api: apiName, url: error.config?.url },
          "Rate limited (429)",
        );
        await logAudit("warn", "rate_limit", `Rate limited on ${apiName}`, {
          url: error.config?.url,
          retryAfter: error.response.headers["retry-after"],
        });
      }
      throw error;
    };

    this.gammaApi.interceptors.response.use((r) => {
      this.requestCounts.gammaApi++;
      return r;
    }, handleError("gammaApi"));

    this.clobApi.interceptors.response.use((r) => {
      this.requestCounts.clobApi++;
      return r;
    }, handleError("clobApi"));
  }

  getRequestCounts() {
    return { ...this.requestCounts };
  }

  // ============================================
  // Gamma API — Market Discovery
  // ============================================

  /**
   * Fetch markets from the Gamma /markets endpoint.
   * Supports slug array for deterministic lookups:
   *   getMarkets({ slug: ["btc-updown-5m-1771705500", "btc-updown-5m-1771705800"] })
   */
  async getMarkets(
    options: {
      slug?: string[];
      active?: boolean;
      closed?: boolean;
      end_date_min?: string;
      end_date_max?: string;
      order?: string;
      ascending?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<GammaMarket[]> {
    return withRetry(
      async () => {
        // Use URLSearchParams for proper multi-value slug support (slug=a&slug=b)
        const params = new URLSearchParams();
        if (options.limit !== undefined)
          params.append("limit", options.limit.toString());
        if (options.offset !== undefined)
          params.append("offset", options.offset.toString());
        if (options.active !== undefined)
          params.append("active", options.active.toString());
        if (options.closed !== undefined)
          params.append("closed", options.closed.toString());
        if (options.order) params.append("order", options.order);
        if (options.ascending !== undefined)
          params.append("ascending", options.ascending.toString());
        if (options.end_date_min)
          params.append("end_date_min", options.end_date_min);
        if (options.end_date_max)
          params.append("end_date_max", options.end_date_max);
        for (const slug of options.slug ?? []) {
          params.append("slug", slug);
        }

        logger.debug(
          { slugCount: options.slug?.length, params: params.toString() },
          "Fetching markets from Gamma API",
        );
        const response = await this.gammaApi.get("/markets", { params });
        const markets = z.array(GammaMarketSchema).parse(response.data);
        logger.debug({ count: markets.length }, "Fetched markets");
        return markets;
      },
      { maxRetries: 3, retryOn: isRateLimitError },
    );
  }

  async getMarketById(marketId: string): Promise<GammaMarket | null> {
    return withRetry(
      async () => {
        // Gamma currently serves single-market lookup at /markets/{id}.
        // Keep a query-param fallback for compatibility if API behavior changes.
        try {
          const response = await this.gammaApi.get(
            `/markets/${encodeURIComponent(marketId)}`,
          );
          return GammaMarketSchema.parse(response.data);
        } catch (error) {
          logger.warn(
            { marketId, error },
            "Primary market-by-id endpoint failed, trying fallback query",
          );
          const fallback = await this.gammaApi.get("/markets", {
            params: { id: marketId },
          });
          const markets = z.array(GammaMarketSchema).parse(fallback.data);
          return markets[0] ?? null;
        }
      },
      { maxRetries: 3, retryOn: isRateLimitError },
    );
  }

  // ============================================
  // CLOB API — Orderbook, Pricing, Fees
  // ============================================

  async getOrderbook(
    tokenId: string,
  ): Promise<{ data: Orderbook; raw: unknown }> {
    return withRetry(
      async () => {
        const response = await this.clobApi.get("/book", {
          params: { token_id: tokenId },
        });
        const raw = response.data;
        const data = OrderbookSchema.parse(raw);
        return { data, raw };
      },
      { maxRetries: 3, retryOn: isRateLimitError },
    );
  }

  async getMidpoint(tokenId: string): Promise<MidpointResponse> {
    return withRetry(
      async () => {
        const response = await this.clobApi.get("/midpoint", {
          params: { token_id: tokenId },
        });
        return MidpointResponseSchema.parse(response.data);
      },
      { maxRetries: 3, retryOn: isRateLimitError },
    );
  }

  // ============================================
  // Helpers
  // ============================================

  static parseClobTokenIds(market: GammaMarket): string[] {
    if (!market.clobTokenIds) return [];
    try {
      const parsed = JSON.parse(market.clobTokenIds);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  static parseOutcomes(market: GammaMarket): string[] {
    if (!market.outcomes) return [];
    try {
      const parsed = JSON.parse(market.outcomes);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  static parseOutcomePrices(market: GammaMarket): number[] {
    if (!market.outcomePrices) return [];
    try {
      const parsed = JSON.parse(market.outcomePrices);
      return Array.isArray(parsed) ? parsed.map(Number) : [];
    } catch {
      return [];
    }
  }

  /**
   * Parse the BTC target price from the market question text.
   * Example questions:
   *   "Will BTC be above $97,450.00 at 2026-02-21 15:05 UTC?"
   *   "Will Bitcoin price be above $98,200 at ..."
   * Returns null if not parseable.
   */
  static parseTargetPrice(question: string | null | undefined): number | null {
    if (!question) return null;
    // Match dollar amounts with optional commas and decimals
    const match = question.match(/(?:above|below)\s*\$([0-9,]+(?:\.\d+)?)/i);
    if (!match) return null;
    const priceStr = match[1]!.replace(/,/g, "");
    const price = parseFloat(priceStr);
    return isNaN(price) ? null : price;
  }
}

// Singleton
let clientInstance: PolymarketClient | null = null;
export function getPolymarketClient(): PolymarketClient {
  if (!clientInstance) clientInstance = new PolymarketClient();
  return clientInstance;
}
