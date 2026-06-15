/**
 * Types for the PenguinX BTC end-of-window micro-profit simulation frontend.
 */

// ============================================
// Trade types
// ============================================

export interface SimulatedTrade {
  id: string;
  marketId: string | null;
  tokenId: string | null;
  side: string;
  outcomeLabel: string | null;
  orderType: string;
  entryTs: string;
  entryPrice: string;
  entryShares: string;
  /** Budget allocated from portfolio (portfolioValue / slots) */
  positionBudget: string;
  /** Actual USD spent (shares × avgFillPrice + fees) */
  actualCost: string;
  entryFees: string | null;
  fillStatus: string | null;
  btcPriceAtEntry: string | null;
  btcTargetPrice: string | null;
  maxUnrealizedProfit: string | null;
  maxUnrealizedLoss: string | null;
  exitPrice: string | null;
  exitTs: string | null;
  exitOutcome: string | null;
  /** RESOLUTION | STOP_LOSS | TAKE_PROFIT | FORCE_TIMEOUT */
  exitReason: string | null;
  realizedPnl: string | null;
  takeProfitTriggerPrice?: string | null;
  takeProfitTriggeredAt?: string | null;
  takeProfitExitPrice?: string | null;
  takeProfitFees?: string | null;
  takeProfitPnl?: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  /** Market end date (ISO string) joined from markets table — used for WINDOW column display */
  marketEndDate: string | null;
  /** Market slug joined from markets table — used to build Polymarket event URL */
  marketSlug: string | null;
  /** Market question joined from markets table */
  marketQuestion: string | null;
  /** Lowest bestBid observed while position was open (before window close) */
  minPriceDuringPosition: string | null;
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
  /** ISO string for when this market's price window opens (endDate - windowDuration) */
  windowStart: string;
  yesTokenId: string;
  noTokenId: string;
  prices: Record<string, LiveMarketPrice>;
  /** ACTIVE = window open; UPCOMING = window not yet started; ENDED = awaiting resolution */
  status: "ACTIVE" | "ENDED" | "UPCOMING";
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
    maxEntryPrice: number;
    tradeFromWindowSeconds: number;
    startingCapital: number;
    maxPositions: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    allocationPerSplit: number;
    consecutiveLossPauseLimit?: number;
    riskAutoResumeEnabled?: boolean;
    riskAutoResumeCooldownMs?: number;
  };
  portfolio?: {
    cashBalance: number;
    initialCapital: number;
    openPositionsValue: number;
  };
}

// ============================================
// Activity log (unified trade events + audit)
// ============================================

export type ActivityKind =
  | "TRADE_OPENED"
  | "TRADE_WIN"
  | "TRADE_LOSS"
  | "MARKET_RESOLVED"
  | "SYSTEM"
  | "INFO"
  | "WARN"
  | "ERROR";

export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  ts: number; // wall-clock ms
  /** Optional trade data for TRADE_* kinds */
  trade?: SimulatedTrade;
  /** PnL for TRADE_WIN / TRADE_LOSS */
  pnl?: number;
}

// ============================================
// Market types
// ============================================

export interface DiscoveredMarket {
  id: string;
  conditionId: string | null;
  slug: string | null;
  question: string | null;
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
// Performance types
// ============================================

export interface PerformanceMetrics {
  period: string;
  totalPnl: string;
  totalDeployed: string;
  roi: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: string;
  avgWin: string;
  avgLoss: string;
  largestWin: string;
  largestLoss: string;
  totalFees: string;
  openPositions: number;
  unrealizedPnl: string;
  cashBalance: string;
  initialCapital: string;
  openPositionsValue: string;
}

export interface PortfolioState {
  initialCapital: number;
  cashBalance: number;
  openPositionsValue: number;
  portfolioValue: number;
  roi: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================
// Monte Carlo analysis types
// ============================================

export interface MonteCarloHistogram {
  min: number;
  max: number;
  count: number;
}

export interface EquityCurvePoint {
  tradeIndex: number;
  balance: number;
}

export interface PercentileEquityCurve {
  percentile: number;
  curve: EquityCurvePoint[];
}

export interface MonteCarloResult {
  config: { simulations: number; tradesPerSim: number };
  historical: {
    totalSettled: number;
    wins: number;
    losses: number;
    winRate: number;
    avgWinPnl: number;
    avgLossPnl: number;
    avgWinPct: number;
    avgLossPct: number;
    largestWin: number;
    largestLoss: number;
    profitFactor: number;
    expectancy: number;
  };
  distribution: {
    histogram: MonteCarloHistogram[];
    percentiles: {
      p5: number;
      p25: number;
      p50: number;
      p75: number;
      p95: number;
    };
    mean: number;
    stdDev: number;
    profitProbability: number;
    ruinProbability: number;
  };
  equityCurves: PercentileEquityCurve[];
  drawdown: { median: number; p95: number; worst: number };
  startingCapital: number;
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
    | "btcPriceUpdate"
    | "pong";
  data?: unknown;
}

// ============================================
// UI helper types
// ============================================

export type MarketWindow = "5M" | "15M" | "1H" | "4H" | "1D";

export const MARKET_WINDOW_LABELS: Record<MarketWindow, string> = {
  "5M": "BTC 5-MIN",
  "15M": "BTC 15-MIN",
  "1H": "BTC 1-HOUR",
  "4H": "BTC 4-HOUR",
  "1D": "BTC 1-DAY",
};

export const MARKET_WINDOW_DURATION_MS: Record<MarketWindow, number> = {
  "5M": 5 * 60 * 1000,
  "15M": 15 * 60 * 1000,
  "1H": 60 * 60 * 1000,
  "4H": 4 * 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000,
};

/**
 * Safe duration lookup for API-provided window types.
 * Falls back to 15 minutes when the window type is missing/unknown.
 */
export function getMarketWindowDurationMs(windowType?: string | null): number {
  if (!windowType) return MARKET_WINDOW_DURATION_MS["15M"];
  const duration =
    MARKET_WINDOW_DURATION_MS[windowType as MarketWindow] ??
    MARKET_WINDOW_DURATION_MS["15M"];
  return duration;
}
