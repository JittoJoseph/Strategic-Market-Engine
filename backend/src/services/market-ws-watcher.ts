import { EventEmitter } from "events";
import WebSocket from "ws";
import { createModuleLogger } from "../utils/logger.js";
import { POLY_URLS } from "../types/index.js";
import type {
  ClobWsMessage,
  PriceUpdateEvent,
  OrderbookUpdateEvent,
  BestBidAskEvent,
  MarketResolvedEvent,
  TickSizeChangeEvent,
  MarketSubscriptionMessage,
  SubscriptionUpdateMessage,
} from "../interfaces/websocket-types.js";
import { logAudit } from "../db/client.js";

const logger = createModuleLogger("market-ws-watcher");

/**
 * Real-time market data via Polymarket CLOB WebSocket.
 * Subscribes with custom_feature_enabled=true to receive:
 *   - book: full orderbook on subscribe + on trades
 *   - price_change: new/cancelled orders with best_bid/best_ask
 *   - best_bid_ask: top-of-book changes (custom feature)
 *   - last_trade_price: matched trades
 *   - tick_size_change: when price >0.96 or <0.04
 *   - market_resolved: market resolution (custom feature)
 *
 * Emits: "priceUpdate", "orderbookUpdate", "bestBidAskUpdate",
 *        "marketResolved", "tickSizeChange", "connected", "disconnected"
 */
export class MarketWebSocketWatcher extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscribedTokens: Set<string> = new Set();
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private messageCount = 0;

  private static readonly PING_INTERVAL = 10000;
  private static readonly MAX_RECONNECT_DELAY = 60000;
  private static readonly BASE_RECONNECT_DELAY = 1000;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    logger.info("Market WebSocket watcher started");
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
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
      this.ws = null;
    }
    logger.info("Market WebSocket watcher stopped");
  }

  subscribe(tokenIds: string[]): void {
    const newTokens = tokenIds.filter((id) => !this.subscribedTokens.has(id));
    if (newTokens.length === 0) return;

    newTokens.forEach((id) => this.subscribedTokens.add(id));

    if (this.ws?.readyState === WebSocket.OPEN) {
      const msg: SubscriptionUpdateMessage = {
        assets_ids: newTokens,
        operation: "subscribe",
      };
      this.ws.send(JSON.stringify(msg));
      logger.info({ count: newTokens.length }, "Subscribed to new tokens");
    }
  }

  unsubscribe(tokenIds: string[]): void {
    tokenIds.forEach((id) => this.subscribedTokens.delete(id));

    if (this.ws?.readyState === WebSocket.OPEN) {
      const msg: SubscriptionUpdateMessage = {
        assets_ids: tokenIds,
        operation: "unsubscribe",
      };
      this.ws.send(JSON.stringify(msg));
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getStats() {
    return {
      connected: this.isConnected(),
      subscribedTokens: this.subscribedTokens.size,
      messageCount: this.messageCount,
      reconnectAttempts: this.reconnectAttempt,
    };
  }

  private connect(): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(POLY_URLS.CLOB_WS);

      this.ws.on("open", () => {
        logger.info("CLOB WebSocket connected");
        this.reconnectAttempt = 0;
        this.emit("connected");

        // Subscribe to all tracked tokens with custom features enabled
        if (this.subscribedTokens.size > 0) {
          const msg: MarketSubscriptionMessage = {
            assets_ids: Array.from(this.subscribedTokens),
            type: "market",
            custom_feature_enabled: true,
          };
          this.ws!.send(JSON.stringify(msg));
          logger.info(
            { tokenCount: this.subscribedTokens.size },
            "Sent initial subscription with custom_feature_enabled",
          );
        }

        // Keepalive ping every 10s
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send("PING");
          }
        }, MarketWebSocketWatcher.PING_INTERVAL);
      });

      this.ws.on("message", (rawData: WebSocket.Data) => {
        this.messageCount++;
        try {
          const text = rawData.toString();

          // Handle text responses (PONG, errors)
          if (text === "PONG" || text.startsWith("INVALID")) return;

          const msg: ClobWsMessage = JSON.parse(text);
          this.handleMessage(msg);
        } catch {
          // ignore parse errors
        }
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        logger.warn(
          { code, reason: reason.toString() },
          "CLOB WebSocket closed",
        );
        logAudit(
          "warn",
          "SYSTEM",
          `CLOB WebSocket closed (code: ${code})`,
        ).catch(() => {});
        this.cleanup();
        this.emit("disconnected", { code, reason: reason.toString() });
        this.scheduleReconnect();
      });

      this.ws.on("error", (error: Error) => {
        logger.error({ error: error.message }, "CLOB WebSocket error");
        logAudit(
          "error",
          "SYSTEM",
          `CLOB WebSocket error: ${error.message}`,
        ).catch(() => {});
        this.emit("error", error);
      });
    } catch (error) {
      logger.error({ error }, "Failed to create CLOB WebSocket");
      this.scheduleReconnect();
    }
  }

  private handleMessage(msg: ClobWsMessage): void {
    const ts =
      typeof msg.timestamp === "string"
        ? parseInt(msg.timestamp, 10)
        : (msg.timestamp ?? Date.now());

    switch (msg.event_type) {
      case "book":
        if (msg.asset_id && msg.bids && msg.asks) {
          this.emit("orderbookUpdate", {
            tokenId: msg.asset_id,
            bids: msg.bids,
            asks: msg.asks,
            hash: msg.hash ?? "",
            timestamp: ts,
          } satisfies OrderbookUpdateEvent);
        }
        break;

      case "price_change":
        if (msg.price_changes) {
          for (const pc of msg.price_changes) {
            this.emit("priceUpdate", {
              tokenId: pc.asset_id,
              bestBid: pc.best_bid,
              bestAsk: pc.best_ask,
              midpoint: (parseFloat(pc.best_bid) + parseFloat(pc.best_ask)) / 2,
              timestamp: ts,
            } satisfies PriceUpdateEvent);
          }
        }
        break;

      case "best_bid_ask":
        if (msg.asset_id && msg.best_bid && msg.best_ask) {
          this.emit("bestBidAskUpdate", {
            tokenId: msg.asset_id,
            bestBid: msg.best_bid,
            bestAsk: msg.best_ask,
            spread: msg.spread ?? "0",
            timestamp: ts,
          } satisfies BestBidAskEvent);
        }
        break;

      case "last_trade_price":
        // Also emit as price update for tracking
        if (msg.asset_id && msg.price) {
          // last_trade_price doesn't have best_bid/best_ask, skip
        }
        break;

      case "tick_size_change":
        if (msg.asset_id && msg.old_tick_size && msg.new_tick_size) {
          logger.debug(
            {
              tokenId: msg.asset_id,
              old: msg.old_tick_size,
              new: msg.new_tick_size,
            },
            "Tick size changed — price near extremes",
          );
          this.emit("tickSizeChange", {
            tokenId: msg.asset_id,
            oldTickSize: msg.old_tick_size,
            newTickSize: msg.new_tick_size,
            timestamp: ts,
          } satisfies TickSizeChangeEvent);
        }
        break;

      case "market_resolved":
        if (msg.market && msg.winning_asset_id && msg.winning_outcome) {
          logger.info(
            {
              market: msg.market,
              winner: msg.winning_outcome,
              winnerAsset: msg.winning_asset_id,
            },
            "Market resolved via WebSocket",
          );
          this.emit("marketResolved", {
            marketId: msg.id ?? "",
            conditionId: msg.market,
            winningAssetId: msg.winning_asset_id,
            winningOutcome: msg.winning_outcome,
            timestamp: ts,
          } satisfies MarketResolvedEvent);
        }
        break;
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
        MarketWebSocketWatcher.BASE_RECONNECT_DELAY *
          Math.pow(2, this.reconnectAttempt),
        MarketWebSocketWatcher.MAX_RECONNECT_DELAY,
      ) +
      Math.random() * 300;

    this.reconnectAttempt++;
    logger.info(
      { delay: Math.round(delay), attempt: this.reconnectAttempt },
      "CLOB reconnecting",
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

// Singleton
let instance: MarketWebSocketWatcher | null = null;
export function getMarketWebSocketWatcher(): MarketWebSocketWatcher {
  if (!instance) instance = new MarketWebSocketWatcher();
  return instance;
}
