/**
 * API client for the PenguinX BTC end-of-window micro-profit simulation backend.
 */

import type {
  SimulatedTrade,
  SystemStats,
  LiveMarketInfo,
  DiscoveredMarket,
  PerformanceMetrics,
  PortfolioState,
  MonteCarloResult,
  AuditLog,
  HealthResponse,
  WsMessage,
} from "./types";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://penguinx.onrender.com";
const WS_BASE_URL =
  process.env.NEXT_PUBLIC_WS_BASE_URL || "wss://penguinx.onrender.com";

async function fetchWithRetry<T>(
  url: string,
  options: RequestInit = {},
  retries = 3,
  delay = 1000,
): Promise<T> {
  let lastError: Error | null = null;

  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error as Error;
      if (i < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delay * (i + 1)));
      }
    }
  }

  throw lastError || new Error("Request failed after retries");
}

export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  async getHealth(): Promise<HealthResponse> {
    return fetchWithRetry(`${this.baseUrl}/health`);
  }

  async ping(): Promise<{ pong: boolean; ts: number }> {
    return fetchWithRetry(`${this.baseUrl}/ping`);
  }

  async getActiveMarket(): Promise<LiveMarketInfo | null> {
    const response = await fetch(`${this.baseUrl}/api/active-market`);
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return response.json();
  }

  async getMarkets(params?: {
    limit?: number;
    offset?: number;
  }): Promise<DiscoveredMarket[]> {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));

    const qs = searchParams.toString();
    return fetchWithRetry(`${this.baseUrl}/api/markets${qs ? `?${qs}` : ""}`);
  }

  async getSystemStats(): Promise<SystemStats> {
    return fetchWithRetry(`${this.baseUrl}/api/system/stats`);
  }

  async getTrades(params?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<SimulatedTrade[]> {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set("status", params.status);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));

    const qs = searchParams.toString();
    return fetchWithRetry(`${this.baseUrl}/api/trades${qs ? `?${qs}` : ""}`);
  }

  async getPerformance(
    period: "1D" | "1W" | "1M" | "ALL" = "1D",
  ): Promise<PerformanceMetrics> {
    return fetchWithRetry(`${this.baseUrl}/api/performance?period=${period}`);
  }

  async getAuditLogs(params?: { limit?: number }): Promise<AuditLog[]> {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set("limit", String(params.limit));

    const qs = searchParams.toString();
    return fetchWithRetry(`${this.baseUrl}/api/audit${qs ? `?${qs}` : ""}`);
  }

  async getPortfolio(): Promise<PortfolioState> {
    return fetchWithRetry(`${this.baseUrl}/api/portfolio`);
  }

  async pauseSystem(
    password: string,
  ): Promise<{ success: boolean; paused: boolean }> {
    return fetchWithRetry(`${this.baseUrl}/api/admin/pause`, {
      method: "POST",
      headers: { Authorization: `Bearer ${password}` },
    });
  }

  async resumeSystem(
    password: string,
  ): Promise<{ success: boolean; paused: boolean }> {
    return fetchWithRetry(`${this.baseUrl}/api/admin/resume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${password}` },
    });
  }

  async getAnalysis(params?: {
    simulations?: number;
    tradesPerSim?: number;
  }): Promise<MonteCarloResult | null> {
    const searchParams = new URLSearchParams();
    if (params?.simulations)
      searchParams.set("simulations", String(params.simulations));
    if (params?.tradesPerSim)
      searchParams.set("tradesPerSim", String(params.tradesPerSim));
    const qs = searchParams.toString();
    // Do NOT retry on 400 — backend returns 400 when there are no settled trades
    const response = await fetch(
      `${this.baseUrl}/api/analysis${qs ? `?${qs}` : ""}`,
    );
    if (response.status === 400) return null;
    if (!response.ok)
      throw new Error(`Analysis request failed: ${response.status}`);
    return response.json();
  }
}

/**
 * WebSocket client for real-time updates from the backend.
 */
export class WsClient {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private listeners: Map<string, Set<(data: WsMessage) => void>> = new Map();
  private isConnecting = false;

  constructor(wsUrl: string = WS_BASE_URL) {
    this.wsUrl = `${wsUrl}/ws`;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.isConnecting) return;
    this.isConnecting = true;

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.isConnecting = false;
        // Send initial ping immediately on connect
        this.sendPing();
      };

      this.ws.onmessage = (event) => {
        try {
          const message: WsMessage = JSON.parse(event.data);
          this.emit(message.type, message);
          this.emit("*", message);
        } catch {
          // Ignore invalid messages
        }
      };

      this.ws.onclose = () => {
        this.isConnecting = false;
        this.attemptReconnect();
      };

      this.ws.onerror = () => {
        this.isConnecting = false;
      };
    } catch {
      this.isConnecting = false;
      this.attemptReconnect();
    }
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.reconnectAttempts = this.maxReconnectAttempts;
  }

  on(type: string, callback: (data: WsMessage) => void): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(callback);
    return () => {
      this.listeners.get(type)?.delete(callback);
    };
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Send a JSON ping to the backend. The backend replies with {type:"pong"}. */
  sendPing(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "ping" }));
    }
  }

  private emit(type: string, message: WsMessage): void {
    this.listeners.get(type)?.forEach((cb) => cb(message));
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    setTimeout(() => this.connect(), delay);
  }
}

// Singleton instances
let apiClient: ApiClient | null = null;
let wsClient: WsClient | null = null;

export function getApiClient(): ApiClient {
  if (!apiClient) {
    apiClient = new ApiClient();
  }
  return apiClient;
}

export function getWsClient(): WsClient {
  if (!wsClient) {
    wsClient = new WsClient();
  }
  return wsClient;
}
