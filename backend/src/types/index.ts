import { z } from "zod";

export const WINDOW_CONFIG = {
  slugPrefix: "btc-updown-15m",
  durationMs: 15 * 60 * 1000,
  category: "btc-15m",
  label: "BTC 15-Minute",
  cryptoMarketConfigId: "btc-15m-twap-60",
  twapLookbackSeconds: 60,
  rtdsTwapTopic: "crypto_prices_twap_sixty",
} as const;

export const RTDS_RAW_TOPIC = "crypto_prices_chainlink";

export const POLY_URLS = {
  GAMMA_API_BASE: "https://gamma-api.polymarket.com",
  CLOB_BASE: "https://clob.polymarket.com",
  CLOB_WS: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  RTDS_WS: "wss://ws-live-data.polymarket.com",
} as const;

/** https://docs.polymarket.com/trading/fees — taker fee per share = rate · p · (1 − p). */
export const CRYPTO_FEE_RATE = 0.07;
export const POLYMARKET_MIN_ORDER_SIZE = 5;
export const FIXED_POSITION_BUDGET_USD = 5;

/** Calibrated on the 4-day tape; not deployment settings. See README. */
export const STRATEGY = {
  entryWindowOpenSeconds: 120,
  entryWindowCloseSeconds: 10,
  minEntryPrice: 0.15,
  maxEntryPrice: 0.7,
  flowMinPrintShares: 50,
  flowMinPrints: 2,
  flowBurstMs: 3_000,
  vetoSdMultiple: 3,
  sigmaWindowMs: 180_000,
  maxRawStalenessMs: 5_000,
  stopLossFraction: 0.35,
  executionLatencyMs: 50,
  scanIntervalMs: 60_000,
  marketLivenessMs: 120_000,
} as const;

export const ConfigSchema = z.object({
  db: z.object({ url: z.string() }),
  portfolio: z.object({ startingCapital: z.number().min(1).max(10_000_000) }),
  admin: z.object({ password: z.string().min(1) }),
  server: z.object({ port: z.number().min(1).max(65535), host: z.string() }),
  logging: z.object({ level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]) }),
  env: z.enum(["development", "production", "test"]),
});

export type Config = z.infer<typeof ConfigSchema>;

export const GammaMarketSchema = z
  .object({
    id: z.string(),
    question: z.string().nullable().optional(),
    conditionId: z.string().optional(),
    slug: z.string().nullable().optional(),
    clobTokenIds: z.string().nullable().optional(),
    outcomes: z.string().nullable().optional(),
    outcomePrices: z.string().nullable().optional(),
    closed: z.boolean().nullable().optional(),
    endDate: z.string().nullable().optional(),
  })
  .passthrough();
export type GammaMarket = z.infer<typeof GammaMarketSchema>;

export interface BookLevel {
  price: string;
  size: string;
}

export interface ExecutableBook {
  bids: BookLevel[];
  asks: BookLevel[];
}
