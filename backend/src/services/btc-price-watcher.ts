import { EventEmitter } from "events";
import WebSocket from "ws";
import { createModuleLogger } from "../utils/logger.js";
import { POLY_URLS } from "../types/index.js";
import type { BtcPriceData } from "../interfaces/websocket-types.js";

const logger = createModuleLogger("btc-price-watcher");

/**
 * BTC price watcher via Polymarket RTDS WebSocket (wss://ws-live-data.polymarket.com).
 *
 * Subscribes to both Binance (crypto_prices/btcusdt) and Chainlink
 * (crypto_prices_chainlink/btc/usd) topics — whichever fires first sets the price.
 * Binance fires on every tick; Chainlink fires on deviation. Together they give
 * reliable, high-frequency coverage.
 *
 * All timestamps stored as wall-clock Date.now() so getPriceAt() comparisons
 * against Date.now() are consistent.
 *
 * Emits: "btcPriceUpdate" { price, timestamp }
 */
export class BtcPriceWatcher extends EventEmitter {
  private ws: WebSocket | null = null;
  private currentPrice: number | null = null;
  private lastTimestamp: number = 0;
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** Rolling 20-min buffer of BTC ticks. Timestamps are wall-clock ms (Date.now()). */
  private priceHistory: Array<{ price: number; timestamp: number }> = [];

  private static readonly PING_INTERVAL = 5_000;
  private static readonly MAX_RECONNECT_DELAY = 30_000;
  private static readonly BASE_RECONNECT_DELAY = 1_000;
  private static readonly HISTORY_TTL_MS = 20 * 60 * 1_000;

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

  /** Last known BTC/USD price at or before `targetMs` (wall-clock ms). */
  getPriceAt(targetMs: number): number | null {
    let best: { price: number; timestamp: number } | null = null;
    for (const entry of this.priceHistory) {
      if (entry.timestamp <= targetMs) {
        if (best === null || entry.timestamp > best.timestamp) {
          best = entry;
        }
      }
    }
    return best?.price ?? null;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private setPrice(price: number, _rtdsTimestamp: number): void {
    // Store wall-clock time — RTDS source timestamps can lag real time significantly.
    const timestamp = Date.now();
    this.currentPrice = price;
    this.lastTimestamp = timestamp;
    this.priceHistory.push({ price, timestamp });
    const cutoff = Date.now() - BtcPriceWatcher.HISTORY_TTL_MS;
    let pruneIdx = 0;
    while (
      pruneIdx < this.priceHistory.length &&
      this.priceHistory[pruneIdx]!.timestamp < cutoff
    ) {
      pruneIdx++;
    }
    if (pruneIdx > 0) this.priceHistory = this.priceHistory.slice(pruneIdx);
    this.emit("btcPriceUpdate", { price, timestamp } satisfies BtcPriceData);
  }

  private connect(): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(POLY_URLS.RTDS_WS);

      this.ws.on("open", () => {
        logger.info("RTDS WebSocket connected");
        this.reconnectAttempt = 0;

        // Subscribe to Binance + Chainlink BTC price topics simultaneously.
        // Either firing updates our price.
        const subscribeMsg = JSON.stringify({
          action: "subscribe",
          subscriptions: [
            { topic: "crypto_prices", type: "update", filters: "btcusdt" },
            {
              topic: "crypto_prices_chainlink",
              type: "*",
              filters: JSON.stringify({ symbol: "btc/usd" }),
            },
          ],
        });
        this.ws!.send(subscribeMsg);
        logger.debug(
          "RTDS subscribed: crypto_prices + crypto_prices_chainlink",
        );

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

          // Binance: topic="crypto_prices", payload.symbol="btcusdt"
          if (topic === "crypto_prices") {
            if (
              payload?.["symbol"] === "btcusdt" &&
              typeof payload["value"] === "number"
            ) {
              const rawTs =
                typeof payload["timestamp"] === "number"
                  ? (payload["timestamp"] as number)
                  : ((msg["timestamp"] as number) ?? 0);
              this.setPrice(payload["value"] as number, rawTs);
              return;
            }
          }

          // Chainlink: topic="crypto_prices_chainlink", payload.symbol="btc/usd"
          if (topic === "crypto_prices_chainlink") {
            if (
              payload?.["symbol"] === "btc/usd" &&
              typeof payload["value"] === "number"
            ) {
              const rawTs =
                typeof payload["timestamp"] === "number"
                  ? (payload["timestamp"] as number)
                  : ((msg["timestamp"] as number) ?? 0);
              this.setPrice(payload["value"] as number, rawTs);
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
