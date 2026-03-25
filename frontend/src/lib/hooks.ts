"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { getApiClient, getWsClient } from "./api-client";
import { formatPnl } from "./utils";
import type {
  SimulatedTrade,
  SystemStats,
  LiveMarketInfo,
  DiscoveredMarket,
  PerformanceMetrics,
  AuditLog,
  ActivityEntry,
  WsMessage,
} from "./types";

/**
 * WS-driven trades hook with pagination.
 * - Initial load via REST (PAGE_SIZE=25)
 * - loadMore() fetches the next 25 from the DB
 * - tradeOpened → prepend to list
 * - tradeResolved / stopLossTriggered → update in place
 * No periodic polling.
 */
const PAGE_SIZE = 25;

export function useTrades(status?: string) {
  const [trades, setTrades] = useState<SimulatedTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Tracks DB-fetched row count (WS-prepended rows don't count toward offset)
  const dbFetchedRef = useRef(0);

  const fetchTrades = useCallback(async () => {
    try {
      setLoading(true);
      dbFetchedRef.current = 0;
      const api = getApiClient();
      const response = await api.getTrades({
        status,
        limit: PAGE_SIZE,
        offset: 0,
      });
      setTrades(response);
      dbFetchedRef.current = response.length;
      setHasMore(response.length === PAGE_SIZE);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [status]);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    try {
      setLoadingMore(true);
      const api = getApiClient();
      const response = await api.getTrades({
        status,
        limit: PAGE_SIZE,
        offset: dbFetchedRef.current,
      });
      dbFetchedRef.current += response.length;
      setTrades((prev) => {
        const ids = new Set(prev.map((t) => t.id));
        return [...prev, ...response.filter((t) => !ids.has(t.id))];
      });
      setHasMore(response.length === PAGE_SIZE);
    } catch {
      // silent — keep existing trades visible
    } finally {
      setLoadingMore(false);
    }
  }, [status, loadingMore]);

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  // WS-driven updates — no polling
  useEffect(() => {
    const ws = getWsClient();
    ws.connect();

    const unsubOpened = ws.on("tradeOpened", (msg: WsMessage) => {
      const trade = (msg.data as { trade?: SimulatedTrade })?.trade;
      if (!trade) return;
      setTrades((prev) => {
        // Avoid dupes
        if (prev.some((t) => t.id === trade.id)) return prev;
        return [trade, ...prev];
      });
    });

    const unsubResolved = ws.on("tradeResolved", (msg: WsMessage) => {
      const trade = (msg.data as { trade?: SimulatedTrade })?.trade;
      if (!trade) return;
      setTrades((prev) => prev.map((t) => (t.id === trade.id ? trade : t)));
    });

    return () => {
      unsubOpened();
      unsubResolved();
    };
  }, []);

  return {
    trades,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    error,
    refetch: fetchTrades,
  };
}

/**
 * Hook providing live market info from the systemState WS broadcast.
 * Seeds initial state from REST /api/active-market at mount so the top section
 * renders immediately, then WS updates take over in real-time.
 */
export function useLiveMarkets(): LiveMarketInfo[] {
  const [liveMarkets, setLiveMarkets] = useState<LiveMarketInfo[]>([]);

  // Seed from REST on mount so top section isn't blank before first WS broadcast
  useEffect(() => {
    let cancelled = false;
    getApiClient()
      .getActiveMarket()
      .then((market) => {
        if (!cancelled && market) {
          setLiveMarkets((prev) => (prev.length === 0 ? [market] : prev));
        }
      })
      .catch(() => {
        /* silently skip if backend not ready */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const ws = getWsClient();
    ws.connect();

    const unsub = ws.on("systemState", (msg: WsMessage) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const incoming = (msg.data as any)?.liveMarkets as
        | LiveMarketInfo[]
        | undefined;
      if (!incoming) return;
      setLiveMarkets((prev) =>
        incoming.map((m) => {
          // Preserve last-known prices when the WS update has none yet
          // (happens briefly right after a market is first registered)
          if (Object.keys(m.prices).length === 0) {
            const existing = prev.find((p) => p.marketId === m.marketId);
            return existing ? { ...m, prices: existing.prices } : m;
          }
          return m;
        }),
      );
    });

    return unsub;
  }, []);

  return liveMarkets;
}

/**
 * Hook to fetch system stats.
 */
export function useSystemStats() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const api = getApiClient();
      const response = await api.getSystemStats();
      setStats(response);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return { stats, loading, error, refetch: fetchStats };
}

/**
 * Hook to fetch active markets list with pagination (DB-backed, for the Markets tab table).
 */
export function useActiveMarkets() {
  const [markets, setMarkets] = useState<DiscoveredMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  // Tracks DB-fetched row count (WS-updated rows don't count toward offset)
  const dbFetchedRef = useRef(0);

  const PAGE_SIZE = 20;

  const fetchMarkets = useCallback(async () => {
    try {
      setLoading(true);
      dbFetchedRef.current = 0;
      const api = getApiClient();
      const response = await api.getMarkets({
        limit: PAGE_SIZE,
        offset: 0,
      });
      setMarkets(response);
      dbFetchedRef.current = response.length;
      setHasMore(response.length === PAGE_SIZE);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    try {
      setLoadingMore(true);
      const api = getApiClient();
      const response = await api.getMarkets({
        limit: PAGE_SIZE,
        offset: dbFetchedRef.current,
      });
      dbFetchedRef.current += response.length;
      setMarkets((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        return [...prev, ...response.filter((m) => !ids.has(m.id))];
      });
      setHasMore(response.length === PAGE_SIZE);
    } catch {
      // silent — keep existing markets visible
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore]);

  useEffect(() => {
    fetchMarkets();
  }, [fetchMarkets]);

  return {
    markets,
    loading,
    loadingMore,
    hasMore,
    error,
    refetch: fetchMarkets,
    loadMore,
  };
}

/**
 * Enhanced real-time performance hook.
 *
 * - Fetches initial performance data once on mount (for the given period)
 * - When period changes, re-fetches fresh data
 * - Listens to tradeOpened and tradeResolved WS events
 * - Updates metrics in real-time (wins/losses, PnL, ROI, win rate, etc.)
 * - Recalculates derived metrics efficiently
 * - Does NOT poll the API after initial load
 */
export function usePerformanceRealtime(
  period: "1D" | "1W" | "1M" | "ALL" = "1D",
) {
  const [performance, setPerformance] = useState<PerformanceMetrics | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Fetch initial data on mount and when period changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    getApiClient()
      .getPerformance(period)
      .then((data) => {
        if (!cancelled) {
          setPerformance(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err as Error);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [period]);

  // Real-time updates from WebSocket events
  useEffect(() => {
    const ws = getWsClient();
    ws.connect();

    // Handle tradeOpened: increment open positions, deduct cost from cash, add to investedAmount
    const unsubOpened = ws.on("tradeOpened", (msg: WsMessage) => {
      const trade = (msg.data as any)?.trade as SimulatedTrade | undefined;
      if (!trade) return;

      setPerformance((prev) => {
        if (!prev) return prev;
        const actualCost = parseFloat(trade.actualCost || "0");
        const oldCash = parseFloat(prev.cashBalance || "0");
        const oldPositionsValue = parseFloat(prev.openPositionsValue || "0");
        return {
          ...prev,
          openPositions: prev.openPositions + 1,
          cashBalance: Math.max(0, oldCash - actualCost).toFixed(2),
          openPositionsValue: (oldPositionsValue + actualCost).toFixed(2),
        };
      });
    });

    // Handle tradeResolved: update wins/losses, PnL, and derived metrics
    const unsubResolved = ws.on("tradeResolved", (msg: WsMessage) => {
      const d = msg.data as any;
      const trade = d?.trade as SimulatedTrade | undefined;
      const isWin = d?.isWin as boolean | undefined;
      const pnl = typeof d?.pnl === "number" ? (d.pnl as number) : 0;

      if (!trade) return;

      setPerformance((prev) => {
        if (!prev) return prev;

        // Update win/loss counts
        const newWins = prev.wins + (isWin ? 1 : 0);
        const newLosses = prev.losses + (isWin ? 0 : 1);
        const newClosedPositions = newWins + newLosses;

        // Update PnL values
        const oldTotalPnl = parseFloat(prev.totalPnl || "0");
        const newTotalPnl = oldTotalPnl + pnl;

        // When a trade settles, cash is returned (actualCost) + pnl added back
        const actualCost = parseFloat(trade.actualCost || "0");
        const oldCashBalance = parseFloat(prev.cashBalance || "0");
        const newCashBalance = oldCashBalance + actualCost + pnl;

        // Reduce open positions value by the cost that was deployed
        const oldOpenPositionsValue = parseFloat(
          prev.openPositionsValue || "0",
        );
        const newOpenPositionsValue = Math.max(
          0,
          oldOpenPositionsValue - actualCost,
        );

        // ROI = (portfolioValue - initialCapital) / initialCapital × 100
        // (same formula as the backend performance-calculator)
        const initialCapital = parseFloat(prev.initialCapital || "0");
        const newPortfolioValue = newCashBalance + newOpenPositionsValue;
        const newRoi =
          initialCapital > 0
            ? ((newPortfolioValue - initialCapital) / initialCapital) * 100
            : 0;

        // Calculate win rate
        const newWinRate =
          newClosedPositions > 0
            ? ((newWins / newClosedPositions) * 100).toFixed(2)
            : "0.00";

        // Track best and worst trades
        const oldBestTrade = parseFloat(prev.largestWin || "0");
        const oldWorstTrade = parseFloat(prev.largestLoss || "0");
        const newBestTrade = Math.max(oldBestTrade, Math.max(0, pnl));
        const newWorstTrade = Math.min(oldWorstTrade, Math.min(0, pnl));

        // Update open positions
        const newOpenPositions = Math.max(0, prev.openPositions - 1);

        return {
          ...prev,
          totalPnl: newTotalPnl.toString(),
          roi: newRoi.toFixed(2),
          wins: newWins,
          losses: newLosses,
          winRate: newWinRate,
          cashBalance: newCashBalance.toFixed(2),
          openPositionsValue: newOpenPositionsValue.toFixed(2),
          largestWin: newBestTrade.toFixed(4),
          largestLoss: newWorstTrade.toFixed(4),
          openPositions: newOpenPositions,
        };
      });
    });

    return () => {
      unsubOpened();
      unsubResolved();
    };
  }, []);

  return { performance, loading, error };
}

/**
 * Hook to calculate unrealized PnL from open trades and live market prices.
 *
 * - Looks at all OPEN trades from the trades hook
 * - Uses live market prices from liveMarkets to calculate current value
 * - Recalculates every time trades or prices update
 * - Returns the sum of all unrealized PnLs across open positions
 */
export function useUnrealizedPnL(
  trades: SimulatedTrade[],
  liveMarkets: LiveMarketInfo[],
): number {
  return useMemo(() => {
    // Filter for open trades only
    const openTrades = trades.filter((t) => t.status === "OPEN");
    if (openTrades.length === 0) return 0;

    // Build a tokenId → current price map from live markets
    const priceMap: Record<string, number> = {};
    for (const market of liveMarkets) {
      for (const [tokenId, priceData] of Object.entries(market.prices)) {
        priceMap[tokenId] = priceData.mid;
      }
    }

    // Calculate unrealized PnL for each open trade
    let totalUnrealized = 0;
    for (const trade of openTrades) {
      if (!trade.tokenId || !priceMap[trade.tokenId]) continue;

      const entryPrice = parseFloat(trade.entryPrice || "0");
      const currentPrice = priceMap[trade.tokenId];
      const shares = parseFloat(trade.entryShares || "0");

      // For YES tokens (long): profit if price up
      // For NO tokens (short): profit if price down
      // PnL = (currentPrice - entryPrice) * shares
      const tradePnL = (currentPrice - entryPrice) * shares;
      totalUnrealized += tradePnL;
    }

    return totalUnrealized;
  }, [trades, liveMarkets]);
}

/**
 * Hook to animate a number from old value to new value.
 *
 * - Smoothly interpolates from prev value to new value over duration
 * - Uses requestAnimationFrame for smooth 60fps animation
 * - Useful for animated counters, percentages, etc.
 */
export function useAnimatedNumber(
  targetValue: number,
  duration: number = 300,
): number {
  const [displayValue, setDisplayValue] = useState(targetValue);
  const animationRef = useRef<{
    startValue: number;
    startTime: number;
    endValue: number;
  } | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    // If this is the first mount, set display value immediately
    if (displayValue === targetValue) {
      return;
    }

    // Start animation
    animationRef.current = {
      startValue: displayValue,
      startTime: Date.now(),
      endValue: targetValue,
    };

    const animate = () => {
      if (!animationRef.current) return;

      const elapsed = Date.now() - animationRef.current.startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Easing: ease-out for natural deceleration
      const easeProgress = 1 - Math.pow(1 - progress, 3);

      const current =
        animationRef.current.startValue +
        (animationRef.current.endValue - animationRef.current.startValue) *
          easeProgress;

      setDisplayValue(current);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        // Set exact value at end to avoid floating point errors
        setDisplayValue(animationRef.current.endValue);
        animationRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [targetValue, duration, displayValue]);

  return displayValue;
}

/**
 * Hook for WebSocket connection status.
 * Sends a JSON ping to the backend every 15 s; isConnected flips to true
 * only after receiving a pong, and resets to false if none arrives within 20 s.
 */
export function useWsConnection() {
  const [isConnected, setIsConnected] = useState(false);
  const pongTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const ws = getWsClient();
    ws.connect();

    const resetPongTimeout = () => {
      if (pongTimerRef.current) clearTimeout(pongTimerRef.current);
      // If no pong within 20 s, mark disconnected
      pongTimerRef.current = setTimeout(() => setIsConnected(false), 20_000);
    };

    // Listen for pong responses
    const unsubPong = ws.on("pong", () => {
      setIsConnected(true);
      resetPongTimeout();
    });

    // Send ping now and every 15 s
    const sendPing = () => ws.sendPing();
    sendPing();
    const pingInterval = setInterval(sendPing, 15_000);

    return () => {
      unsubPong();
      clearInterval(pingInterval);
      if (pongTimerRef.current) clearTimeout(pongTimerRef.current);
    };
  }, []);

  return isConnected;
}

/**
 * Hook for subscribing to specific WebSocket events.
 */
export function useWsEvent(
  eventType: string,
  callback: (message: WsMessage) => void,
) {
  useEffect(() => {
    const ws = getWsClient();
    ws.connect();
    const unsubscribe = ws.on(eventType, callback);
    return unsubscribe;
  }, [eventType, callback]);
}

/**
 * Countdown timer hook — returns { days, hours, minutes, seconds, expired }.
 */
export function useCountdown(endDate: string | null) {
  const calcRemaining = useCallback(() => {
    if (!endDate) return null;
    const diff = new Date(endDate).getTime() - Date.now();
    if (diff <= 0)
      return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
    const totalSeconds = Math.floor(diff / 1000);
    return {
      days: Math.floor(totalSeconds / 86400),
      hours: Math.floor((totalSeconds % 86400) / 3600),
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
      expired: false,
    };
  }, [endDate]);

  const [remaining, setRemaining] = useState(calcRemaining);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setRemaining(calcRemaining());
    timerRef.current = setInterval(() => {
      setRemaining(calcRemaining());
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [calcRemaining]);

  return remaining;
}

/**
 * Hook to track system status and connectivity.
 */
export function useSystemStatus() {
  const [backendActive, setBackendActive] = useState(true);
  const wsConnected = useWsConnection();

  useEffect(() => {
    const checkBackend = async () => {
      try {
        const api = getApiClient();
        await api.ping();
        setBackendActive(true);
      } catch {
        setBackendActive(false);
      }
    };

    checkBackend();
  }, []);

  return { backendActive, wsConnected };
}

// ── helper: map AuditLog → ActivityEntry ─────────────────────────────────────
function auditLogToActivity(log: AuditLog): ActivityEntry {
  const cat = log.category?.toUpperCase() ?? "";
  let kind: ActivityEntry["kind"] = "INFO";
  if (cat.includes("TRADE_RESOLVED") || cat.includes("TRADE_SETTLED"))
    kind = "TRADE_WIN"; // will be refined below by level
  else if (cat.includes("TRADE_OPENED")) kind = "TRADE_OPENED";
  else if (cat.includes("TRADE_FORCE") || cat.includes("LOSS"))
    kind = "TRADE_LOSS";
  else if (cat.includes("SKIP") || cat.includes("MOMENTUM"))
    kind = "MOMENTUM_SKIP";
  else if (cat.includes("MARKET")) kind = "MARKET_RESOLVED";
  else if (log.level === "warn") kind = "WARN";
  else if (log.level === "error") kind = "ERROR";

  // Refine TRADE_RESOLVED: look at metadata for outcome
  if (kind === "TRADE_WIN" && log.metadata) {
    const outcome = (log.metadata as any)?.outcome as string | undefined;
    if (outcome === "LOSS") kind = "TRADE_LOSS";
  }

  const pnl =
    log.metadata && typeof (log.metadata as any).pnl === "number"
      ? (log.metadata as any).pnl
      : undefined;

  return {
    id: log.id,
    kind,
    title: log.category ?? "EVENT",
    detail: log.message,
    ts: new Date(log.createdAt).getTime(),
    pnl,
  };
}

const MAX_ACTIVITY_ENTRIES = 100;

/**
 * Activity log hook.
 *
 * - Seeds from GET /api/audit?limit=30 at mount (one-time REST call)
 * - Appends real-time entries from `tradeOpened` and `tradeResolved` WS events
 * - Never polls the API again after initial load
 * - Capped at MAX_ACTIVITY_ENTRIES to prevent unbounded growth
 */
export function useActivityLog() {
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const seenIds = useRef<Set<string>>(new Set());

  // One-time REST seed on mount
  useEffect(() => {
    let cancelled = false;
    getApiClient()
      .getAuditLogs({ limit: 30 })
      .then((logs) => {
        if (cancelled) return;
        const entries = logs
          .map(auditLogToActivity)
          .sort((a, b) => b.ts - a.ts); // newest first
        entries.forEach((e) => seenIds.current.add(e.id));
        setActivities(entries);
      })
      .catch(() => {
        /* silently skip if backend not ready */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Real-time: tradeOpened
  useEffect(() => {
    const ws = getWsClient();
    ws.connect();

    const unsubOpened = ws.on("tradeOpened", (msg: WsMessage) => {
      const trade = (msg.data as any)?.trade as SimulatedTrade | undefined;
      if (!trade) return;
      const id = `opened-${trade.id}`;
      if (seenIds.current.has(id)) return;
      seenIds.current.add(id);

      const outcome = trade.outcomeLabel ?? "??";
      const price = trade.entryPrice
        ? `@${(parseFloat(trade.entryPrice) * 100).toFixed(1)}¢`
        : "";
      const btc = trade.btcPriceAtEntry
        ? ` BTC $${parseFloat(trade.btcPriceAtEntry).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
        : "";
      const momentum = (trade as any).momentum;
      const momStr = momentum ? ` mom:${momentum.direction}` : "";

      const entry: ActivityEntry = {
        id,
        kind: "TRADE_OPENED",
        title: "TRADE OPENED",
        detail: `${outcome} ${price}${btc}${momStr} — $${trade.actualCost}`,
        ts: Date.now(),
        trade,
      };

      setActivities((prev) => [entry, ...prev].slice(0, MAX_ACTIVITY_ENTRIES));
    });

    // Real-time: tradeResolved
    const unsubResolved = ws.on("tradeResolved", (msg: WsMessage) => {
      const d = msg.data as any;
      const trade = d?.trade as SimulatedTrade | undefined;
      const isWin = d?.isWin as boolean | undefined;
      const pnl = typeof d?.pnl === "number" ? (d.pnl as number) : undefined;

      const id = `resolved-${trade?.id ?? Date.now()}`;
      if (seenIds.current.has(id)) return;
      seenIds.current.add(id);

      const kind: ActivityEntry["kind"] = isWin ? "TRADE_WIN" : "TRADE_LOSS";
      const outcome = trade?.outcomeLabel ?? "??";
      const pnlStr = pnl !== undefined ? ` PnL: ${formatPnl(pnl)}` : "";

      const entry: ActivityEntry = {
        id,
        kind,
        title: isWin ? "TRADE WIN ✅" : "TRADE LOSS ❌",
        detail: `${outcome}${pnlStr}`,
        ts: Date.now(),
        trade,
        pnl,
      };

      setActivities((prev) => [entry, ...prev].slice(0, MAX_ACTIVITY_ENTRIES));
    });

    return () => {
      unsubOpened();
      unsubResolved();
    };
  }, []);

  return { activities, loading };
}
