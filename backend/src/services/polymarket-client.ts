import axios, { AxiosInstance, AxiosError } from "axios";
import { createModuleLogger } from "../utils/logger.js";
import { withRetry, isRateLimitError } from "../utils/retry.js";
import {
  POLY_URLS,
  GammaMarketSchema,
  GammaEventSchema,
  OrderbookSchema,
  MidpointResponseSchema,
  FeeRateResponseSchema,
  type GammaMarket,
  type GammaEvent,
  type Orderbook,
  type MidpointResponse,
  type FeeRateResponse,
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

  async getEvents(
    options: {
      limit?: number;
      offset?: number;
      closed?: boolean;
      active?: boolean;
      tag_slug?: string;
      slug?: string;
      /** ISO-8601 datetime — only return events whose endDate >= this value */
      end_date_min?: string;
    } = {},
  ): Promise<GammaEvent[]> {
    return withRetry(
      async () => {
        const params: Record<string, string | number | boolean> = {
          limit: options.limit ?? 50,
          offset: options.offset ?? 0,
        };
        if (options.closed !== undefined) params.closed = options.closed;
        if (options.active !== undefined) params.active = options.active;
        if (options.tag_slug) params.tag_slug = options.tag_slug;
        if (options.slug) params.slug = options.slug;
        if (options.end_date_min) params.end_date_min = options.end_date_min;

        logger.debug({ params }, "Fetching events from Gamma API");
        const response = await this.gammaApi.get("/events", { params });
        const events = z.array(GammaEventSchema).parse(response.data);
        logger.debug({ count: events.length }, "Fetched events");
        return events;
      },
      { maxRetries: 3, retryOn: isRateLimitError },
    );
  }

  async getMarketById(marketId: string): Promise<GammaMarket | null> {
    return withRetry(
      async () => {
        const response = await this.gammaApi.get("/markets", {
          params: { id: marketId },
        });
        const markets = z.array(GammaMarketSchema).parse(response.data);
        return markets[0] ?? null;
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

  /**
   * Get the fee rate for a token.
   * Per docs: GET /fee-rate?token_id={token_id}
   * Returns fee_rate_bps as string. For crypto 5M/15M markets this is non-zero.
   */
  async getFeeRate(tokenId: string): Promise<number> {
    return withRetry(
      async () => {
        const response = await this.clobApi.get("/fee-rate", {
          params: { token_id: tokenId },
        });
        const parsed = FeeRateResponseSchema.parse(response.data);
        return parseInt(parsed.fee_rate_bps, 10) || 0;
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
