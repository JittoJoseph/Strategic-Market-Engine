import { EventEmitter } from "events";
import WebSocket from "ws";
import { createModuleLogger } from "../utils/logger.js";
import { POLY_URLS } from "../types/index.js";
import type { BtcPriceData } from "../interfaces/websocket-types.js";

const logger = createModuleLogger("btc-price-watcher");

/**
 * Real-time BTC price watcher via Polymarket RTDS WebSocket.
 * Endpoint: wss://ws-live-data.polymarket.com
 *
 * Subscribes to: topic="crypto_prices_chainlink" (Chainlink btc/usd)
 *
 * Keepalive: sends TEXT "PING" every 5 s per Polymarket RTDS docs.
 * Reconnects with exponential back-off on any disconnect/error.
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

  /** Send TEXT "PING" every 5 s to keep RTDS connection alive (per docs). */
  private static readonly PING_INTERVAL = 5_000;
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

  private setPrice(price: number, timestamp: number): void {
    this.currentPrice = price;
    this.lastTimestamp = timestamp;
    this.emit("btcPriceUpdate", {
      price,
      timestamp,
    } satisfies BtcPriceData);
  }

  private connect(): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(POLY_URLS.RTDS_WS);

      this.ws.on("open", () => {
        logger.info("RTDS WebSocket connected");
        this.reconnectAttempt = 0;

        // Subscribe to Chainlink topic for BTC/USD price.
        const subscribeMsg = JSON.stringify({
          action: "subscribe",
          subscriptions: [
            {
              topic: "crypto_prices_chainlink",
              type: "*",
            },
          ],
        });
        this.ws!.send(subscribeMsg);
        logger.debug("RTDS subscribed: crypto_prices_chainlink (Chainlink)");

        // Keepalive: send TEXT "PING" every 5 s per Polymarket RTDS docs
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send("PING");
          }
        }, BtcPriceWatcher.PING_INTERVAL);
      });

      this.ws.on("message", (rawData: WebSocket.Data) => {
        try {
          const text = rawData.toString().trim();
          if (text === "PONG" || text === "pong") return;

          const msg = JSON.parse(text) as Record<string, unknown>;
          const topic = msg["topic"] as string | undefined;
          const payload = msg["payload"] as Record<string, unknown> | undefined;

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
                  : ((msg["timestamp"] as number) ?? Date.now());
              this.setPrice(payload["value"] as number, ts);
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
