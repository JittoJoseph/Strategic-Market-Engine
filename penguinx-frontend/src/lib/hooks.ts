"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getApiClient, getWsClient } from "./api-client";
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
 * WS-driven trades hook.
 * - Initial load via REST
 * - tradeOpened → prepend to list
 * - tradeResolved / stopLossTriggered → update in place
 * No periodic polling.
 */
export function useTrades(status?: string, limit?: number) {
  const [trades, setTrades] = useState<SimulatedTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchTrades = useCallback(async () => {
    try {
      setLoading(true);
      const api = getApiClient();
      const response = await api.getTrades({ status, limit });
      setTrades(response);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [status, limit]);

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

  return { trades, loading, error, refetch: fetchTrades };
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
 * Hook to fetch active markets list (DB-backed, for the Markets tab table).
 */
export function useActiveMarkets() {
  const [markets, setMarkets] = useState<DiscoveredMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchMarkets = useCallback(async () => {
    try {
      setLoading(true);
      const api = getApiClient();
      const response = await api.getMarkets();
      setMarkets(response);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMarkets();
  }, [fetchMarkets]);

  return { markets, loading, error, refetch: fetchMarkets };
}

/**
 * Hook to fetch portfolio performance with time period selection.
 */
export function usePerformance(period: "1D" | "1W" | "1M" | "ALL" = "1D") {
  const [performance, setPerformance] = useState<PerformanceMetrics | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchPerformance = useCallback(
    async (isRefresh = false) => {
      try {
        if (isRefresh) {
          setRefreshing(true);
        } else {
          setLoading(true);
        }
        const api = getApiClient();
        const response = await api.getPerformance(period);
        setPerformance(response);
        setError(null);
      } catch (err) {
        setError(err as Error);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [period],
  );

  useEffect(() => {
    fetchPerformance();
  }, [fetchPerformance]);

  const refetch = useCallback(() => {
    fetchPerformance(true);
  }, [fetchPerformance]);

  return { performance, loading, refreshing, error, refetch };
}

/**
 * Hook to fetch audit logs.
 */
export function useAuditLogs(limit?: number) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      setLoading(true);
      const api = getApiClient();
      const response = await api.getAuditLogs({ limit });
      setLogs(response);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  return { logs, loading, error, refetch: fetchLogs };
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
  else if (cat.includes("TRADE_FORCE") || cat.includes("LOSS")) kind = "TRADE_LOSS";
  else if (cat.includes("SKIP") || cat.includes("MOMENTUM")) kind = "MOMENTUM_SKIP";
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
      .catch(() => {/* silently skip if backend not ready */})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
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
      const price = trade.entryPrice ? `@${(parseFloat(trade.entryPrice) * 100).toFixed(1)}¢` : "";
      const btc = trade.btcPriceAtEntry ? ` BTC $${parseFloat(trade.btcPriceAtEntry).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "";
      const momentum = (trade as any).momentum;
      const momStr = momentum ? ` mom:${momentum.direction}` : "";

      const entry: ActivityEntry = {
        id,
        kind: "TRADE_OPENED",
        title: "TRADE OPENED",
        detail: `${outcome} ${price}${btc}${momStr} — $${trade.simulatedUsdAmount}`,
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
      const pnl = typeof d?.pnl === "number" ? d.pnl as number : undefined;

      const id = `resolved-${trade?.id ?? Date.now()}`;
      if (seenIds.current.has(id)) return;
      seenIds.current.add(id);

      const kind: ActivityEntry["kind"] = isWin ? "TRADE_WIN" : "TRADE_LOSS";
      const outcome = trade?.outcomeLabel ?? "??";
      const pnlStr = pnl !== undefined
        ? ` PnL: ${pnl >= 0 ? "+" : ""}$${Math.abs(pnl).toFixed(4)}`
        : "";

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

