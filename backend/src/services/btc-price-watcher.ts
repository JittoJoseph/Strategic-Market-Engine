import { EventEmitter } from "events";
import WebSocket from "ws";
import axios from "axios";
import { createModuleLogger } from "../utils/logger.js";
import { POLY_URLS } from "../types/index.js";
import type { BtcPriceData } from "../interfaces/websocket-types.js";

const logger = createModuleLogger("btc-price-watcher");

/**
 * Real-time BTC price watcher via Polymarket RTDS WebSocket.
 * Connects to wss://ws-live-data.polymarket.com
 *
 * Subscribes to BOTH sources for maximum reliability:
 *   - Binance:   topic="crypto_prices",           symbol="btcusdt"
 *   - Chainlink: topic="crypto_prices_chainlink",  symbol="btc/usd"
 *
 * No server-side filter is applied — all symbols from both sources are
 * received and filtered in code (server-side filters can silently fail).
 *
 * REST FALLBACK: if RTDS hasn't delivered a price within 10 s of connecting,
 * starts polling Binance REST API (api.binance.com/api/v3/ticker/price)
 * every 8 s until RTDS resumes.
 *
 * Emits: "btcPriceUpdate" { price: number, timestamp: number }
 */
export class BtcPriceWatcher extends EventEmitter {
  private ws: WebSocket | null = null;
  private currentPrice: number | null = null;
  private lastTimestamp: number = 0;
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private restFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private restPollTimer: ReturnType<typeof setInterval> | null = null;

  /** Send TEXT "PING" every 5 s to keep RTDS connection alive (per docs). */
  private static readonly PING_INTERVAL = 5000;
  /** Start REST fallback if no price after this delay from connect. */
  private static readonly REST_FALLBACK_DELAY = 10_000;
  /** Poll Binance REST every N ms when REST fallback is active. */
  private static readonly REST_POLL_INTERVAL = 8_000;
  private static readonly MAX_RECONNECT_DELAY = 30_000;
  private static readonly BASE_RECONNECT_DELAY = 1_000;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    logger.info("BTC price watcher started");
  }

  stop(): void {
    this.running = false;
    this.clearRestTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }
    logger.info("BTC price watcher stopped");
  }

  getCurrentPrice(): BtcPriceData | null {
    if (this.currentPrice === null) return null;
    return { price: this.currentPrice, timestamp: this.lastTimestamp };
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Fetch BTC/USDT price from Binance REST API.
   * Used as fallback when RTDS hasn't delivered a price yet, and also
   * callable directly from the orchestrator when a new market opens and
   * currentPrice is still null.
   * Returns null on failure.
   */
  async fetchCurrentPriceRest(): Promise<number | null> {
    try {
      const resp = await axios.get<{ symbol: string; price: string }>(
        "https://api.binance.com/api/v3/ticker/price",
        { params: { symbol: "BTCUSDT" }, timeout: 5000 },
      );
      const price = parseFloat(resp.data.price);
      if (!isNaN(price) && price > 0) {
        logger.info({ price }, "BTC price fetched via Binance REST");
        // Update internal state but do NOT stop REST polling — RTDS may be
        // permanently broken; polling must continue until RTDS resumes.
        this.currentPrice = price;
        this.lastTimestamp = Date.now();
        this.emit("btcPriceUpdate", {
          price: this.currentPrice,
          timestamp: this.lastTimestamp,
        } satisfies BtcPriceData);
        return price;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, "Binance REST price fetch failed");
    }
    return null;
  }

  // -------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------

  /**
   * Update price state and notify listeners.
   * When called from the RTDS message handler, also cancels any REST fallback
   * timers since RTDS is working correctly.
   */
  private setCurrentPrice(
    price: number,
    timestamp: number,
    source: "rtds" | "rest",
  ): void {
    this.currentPrice = price;
    this.lastTimestamp = timestamp;
    if (source === "rtds") {
      // RTDS is delivering — cancel REST fallback
      this.clearRestTimers();
    }
    this.emit("btcPriceUpdate", {
      price: this.currentPrice,
      timestamp: this.lastTimestamp,
    } satisfies BtcPriceData);
  }

  private clearRestTimers(): void {
    if (this.restFallbackTimer) {
      clearTimeout(this.restFallbackTimer);
      this.restFallbackTimer = null;
    }
    if (this.restPollTimer) {
      clearInterval(this.restPollTimer);
      this.restPollTimer = null;
    }
  }

  /**
   * Start a delayed REST fallback.
   * If no RTDS price arrives within REST_FALLBACK_DELAY ms, begin polling
   * Binance REST API every REST_POLL_INTERVAL ms.
   */
  private startRestFallback(): void {
    this.clearRestTimers();
    this.restFallbackTimer = setTimeout(() => {
      if (!this.running) return;
      if (this.currentPrice === null) {
        logger.warn(
          "RTDS produced no BTC price after 10 s — starting Binance REST fallback poll",
        );
        this.fetchCurrentPriceRest();
        this.restPollTimer = setInterval(async () => {
          if (this.running && this.currentPrice === null) {
            await this.fetchCurrentPriceRest();
          }
        }, BtcPriceWatcher.REST_POLL_INTERVAL);
      }
    }, BtcPriceWatcher.REST_FALLBACK_DELAY);
  }

  private connect(): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(POLY_URLS.RTDS_WS);

      this.ws.on("open", () => {
        logger.info("RTDS WebSocket connected");
        this.reconnectAttempt = 0;

        // Subscribe to BOTH Binance and Chainlink topics.
        // We intentionally omit the "filters" field on the Binance topic —
        // subscribing to all symbols and filtering in code is more robust;
        // server-side filters can silently fail without a connection drop.
        const subscribeMsg = JSON.stringify({
          action: "subscribe",
          subscriptions: [
            {
              topic: "crypto_prices",
              type: "update",
              // no "filters" → receive ALL symbols (btcusdt, ethusdt, solusdt, xrpusdt)
            },
            {
              topic: "crypto_prices_chainlink",
              type: "*",
              // no "filters" → receive all Chainlink symbols
            },
          ],
        });
        this.ws!.send(subscribeMsg);
        logger.debug(
          "RTDS subscribed: crypto_prices (all Binance) + crypto_prices_chainlink (all Chainlink)",
        );

        // Keepalive: send TEXT "PING" every 5 s per Polymarket RTDS docs
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send("PING");
          }
        }, BtcPriceWatcher.PING_INTERVAL);

        // Start REST fallback in case subscription delivers no data
        this.startRestFallback();
      });

      this.ws.on("message", (rawData: WebSocket.Data) => {
        try {
          const text = rawData.toString().trim();
          if (text === "PONG" || text === "pong") return;

          const msg = JSON.parse(text) as Record<string, unknown>;
          const topic = msg["topic"] as string | undefined;
          const type = msg["type"] as string | undefined;
          const payload = msg["payload"] as Record<string, unknown> | undefined;

          // ── Binance source ──────────────────────────────────────────────
          // topic = "crypto_prices", type = "update"
          // payload.symbol = "btcusdt", payload.value = 95123.45
          if (topic === "crypto_prices" && type === "update") {
            if (
              payload?.["symbol"] === "btcusdt" &&
              typeof payload["value"] === "number"
            ) {
              const ts =
                typeof payload["timestamp"] === "number"
                  ? (payload["timestamp"] as number)
                  : (msg["timestamp"] as number) ?? Date.now();
              this.setCurrentPrice(payload["value"] as number, ts, "rtds");
              return;
            }
          }

          // ── Chainlink source ────────────────────────────────────────────
          // topic = "crypto_prices_chainlink"
          // payload.symbol = "btc/usd", payload.value = 95123.45
          if (topic === "crypto_prices_chainlink") {
            if (
              payload?.["symbol"] === "btc/usd" &&
              typeof payload["value"] === "number"
            ) {
              const ts =
                typeof payload["timestamp"] === "number"
                  ? (payload["timestamp"] as number)
                  : (msg["timestamp"] as number) ?? Date.now();
              this.setCurrentPrice(payload["value"] as number, ts, "rtds");
              return;
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.debug({ err: msg }, "RTDS message parse error");
        }
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        logger.warn(
          { code, reason: reason.toString() },
          "RTDS WebSocket closed",
        );
        this.cleanup();
        this.scheduleReconnect();
      });

      this.ws.on("error", (error: Error) => {
        logger.error({ error: error.message }, "RTDS WebSocket error");
      });
    } catch (error) {
      logger.error({ error }, "Failed to create RTDS WebSocket");
      this.scheduleReconnect();
    }
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    // Don't clear REST fallback on disconnect — keep polling if active
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay =
      Math.min(
        BtcPriceWatcher.BASE_RECONNECT_DELAY *
          Math.pow(2, this.reconnectAttempt),
        BtcPriceWatcher.MAX_RECONNECT_DELAY,
      ) +
      Math.random() * 500;

    this.reconnectAttempt++;
    logger.info(
      { delay: Math.round(delay), attempt: this.reconnectAttempt },
      "RTDS reconnecting",
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

// Singleton
let instance: BtcPriceWatcher | null = null;
export function getBtcPriceWatcher(): BtcPriceWatcher {
  if (!instance) instance = new BtcPriceWatcher();
  return instance;
}
