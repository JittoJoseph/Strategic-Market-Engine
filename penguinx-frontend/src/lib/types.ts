/**
 * Types for the PenguinX BTC end-of-window micro-profit simulation frontend.
 */

// ============================================
// Trade types
// ============================================

export interface SimulatedTrade {
  id: string;
  experimentId: string | null;
  marketId: string | null;
  tokenId: string | null;
  marketCategory: string | null;
  windowType: string | null;
  side: string;
  outcomeLabel: string | null;
  orderType: string;
  entryTs: string;
  entryPrice: string;
  entryShares: string;
  simulatedUsdAmount: string;
  entryFees: string | null;
  feeRateBps: number | null;
  fillStatus: string | null;
  btcPriceAtEntry: string | null;
  btcTargetPrice: string | null;
  btcDistanceUsd: string | null;
  exitPrice: string | null;
  exitTs: string | null;
  exitOutcome: string | null;
  realizedPnl: string | null;
  status: string;
  strategyTrigger: string | null;
  orderbookSnapshot: unknown;
  raw: unknown;
  createdAt: string;
  updatedAt: string;
}

// ============================================
// Live market types (pushed via WebSocket systemState)
// ============================================

export interface LiveMarketPrice {
  bid: number;
  ask: number;
  mid: number;
}

export interface LiveMarketInfo {
  marketId: string;
  question: string;
  slug: string | null;
  endDate: string; // ISO string
  yesTokenId: string;
  noTokenId: string;
  prices: Record<string, LiveMarketPrice>;
  status: "ACTIVE" | "ENDED";
  hasPosition: boolean;
  /** BTC price captured when the market window opened — the "price to beat" for Up/Down markets */
  btcPriceAtWindowStart: number | null;
}

// ============================================
// System stats types
// ============================================

export interface SystemStats {
  orchestrator: {
    running: boolean;
    paused: boolean;
    activeMarkets: number;
    openPositions: number;
    cycleCount: number;
    scanner: { discoveredCount: number };
    ws: {
      connected: boolean;
      subscribedTokens: number;
      messageCount: number;
      reconnectAttempts: number;
    };
    strategy: {
      watchedTokens: number;
      triggersCount: number;
      evaluatedTokens: number;
    };
    btcConnected: boolean;
    btcPrice: number | null;
  };
  liveMarkets: LiveMarketInfo[];
  btcPrice: { price: number; timestamp: number } | null;
  config: {
    marketWindow: string;
    entryPriceThreshold: number;
    tradeFromWindowSeconds: number;
    simulationAmountUsd: number;
    maxSimultaneousPositions: number;
    minBtcDistanceUsd: number;
    stopLossThreshold: number;
  };
}

// ============================================
// Market types
// ============================================

export interface DiscoveredMarket {
  id: string;
  conditionId: string | null;
  slug: string | null;
  question: string | null;
  windowType: string;
  category: string;
  endDate: string | null;
  targetPrice: string | null;
  active: boolean;
  outcomes: unknown;
  clobTokenIds: unknown;
  lastFetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Computed by the API: ACTIVE (window open) or ENDED (window closed) */
  computedStatus?: "ACTIVE" | "ENDED";
}

// ============================================
// Experiment types
// ============================================

export interface ExperimentRun {
  id: string;
  name: string;
  description: string | null;
  strategyVariant: string | null;
  parameters: Record<string, unknown> | null;
  startedAt: string;
  endedAt: string | null;
  status: string;
  totalTrades: string;
  successfulTrades: string;
  avgRealizedPnl: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ============================================
// Performance types
// ============================================

export interface PerformanceMetrics {
  period: string;
  totalPnl: string;
  totalInvested: string;
  roi: string;
  totalTrades: number;
  wins: number;
  losses: number;
  stopLosses: number;
  winRate: string;
  avgWin: string;
  avgLoss: string;
  largestWin: string;
  largestLoss: string;
  totalFees: string;
  avgBtcDistance: string;
  openPositions: number;
  unrealizedPnl: string;
}

// ============================================
// Audit log types
// ============================================

export interface AuditLog {
  id: string;
  level: string;
  category: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ============================================
// API response types — backend returns arrays directly
// ============================================

export interface HealthResponse {
  status: string;
  uptime: number;
  [key: string]: unknown;
}

// ============================================
// WebSocket types
// ============================================

export interface WsMessage {
  type:
    | "systemState"
    | "tradeOpened"
    | "tradeResolved"
    | "stopLossTriggered"
    | "btcPriceUpdate";
  data?: unknown;
}

// ============================================
// UI helper types
// ============================================

export type Direction = "up" | "down" | "flat";

export type MarketWindow = "5M" | "15M" | "1H" | "4H" | "1D";

export const MARKET_WINDOW_LABELS: Record<MarketWindow, string> = {
  "5M": "BTC 5-MIN",
  "15M": "BTC 15-MIN",
  "1H": "BTC 1-HOUR",
  "4H": "BTC 4-HOUR",
  "1D": "BTC 1-DAY",
};
