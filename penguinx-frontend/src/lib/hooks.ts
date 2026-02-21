"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { getApiClient, getWsClient } from "./api-client";
import type {
  SimulatedTrade,
  SystemStats,
  LiveMarketInfo,
  DiscoveredMarket,
  ExperimentRun,
  PerformanceMetrics,
  AuditLog,
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

    const unsubStopLoss = ws.on("stopLossTriggered", (msg: WsMessage) => {
      const trade = (msg.data as { trade?: SimulatedTrade })?.trade;
      if (!trade) return;
      setTrades((prev) => prev.map((t) => (t.id === trade.id ? trade : t)));
    });

    return () => {
      unsubOpened();
      unsubResolved();
      unsubStopLoss();
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
      const data = msg.data as SystemStats | undefined;
      if (data?.liveMarkets) {
        setLiveMarkets(data.liveMarkets);
      }
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
 * Hook to fetch experiment runs.
 */
export function useExperiments() {
  const [experiments, setExperiments] = useState<ExperimentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchExperiments = useCallback(async () => {
    try {
      setLoading(true);
      const api = getApiClient();
      const response = await api.getExperiments();
      setExperiments(response);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchExperiments();
  }, [fetchExperiments]);

  return { experiments, loading, error, refetch: fetchExperiments };
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
