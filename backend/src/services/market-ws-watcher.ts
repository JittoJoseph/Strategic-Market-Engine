import { EventEmitter } from "events";
import WebSocket from "ws";
import { createModuleLogger } from "../utils/logger.js";
import { POLY_URLS, type BookLevel, type ExecutableBook } from "../types/index.js";
import type {
  ClobWsMessage,
  BookUpdateEvent,
  TradeEvent,
  MarketResolvedEvent,
  MarketSubscriptionMessage,
  SubscriptionUpdateMessage,
} from "../interfaces/websocket-types.js";
import { logAudit } from "../db/client.js";

const logger = createModuleLogger("market-ws-watcher");
const PING_INTERVAL_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

type Side = Map<number, number>;
interface MaintainedBook {
  bids: Side;
  asks: Side;
}

export class MarketWebSocketWatcher extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscribedTokens = new Set<string>();
  private books = new Map<string, MaintainedBook>();
  private lastTradeAt = new Map<string, number>();
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private messageCount = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.cleanup();
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
      this.ws = null;
    }
  }

  subscribe(tokenIds: string[]): void {
    const fresh = tokenIds.filter((id) => !this.subscribedTokens.has(id));
    if (!fresh.length) return;
    fresh.forEach((id) => this.subscribedTokens.add(id));
    this.send({ assets_ids: fresh, operation: "subscribe" } satisfies SubscriptionUpdateMessage);
  }

  unsubscribe(tokenIds: string[]): void {
    for (const id of tokenIds) {
      this.subscribedTokens.delete(id);
      this.books.delete(id);
      this.lastTradeAt.delete(id);
    }
    this.send({ assets_ids: tokenIds, operation: "unsubscribe" } satisfies SubscriptionUpdateMessage);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getBook(tokenId: string): ExecutableBook | null {
    const book = this.books.get(tokenId);
    if (!book) return null;
    const levels = (m: Side, desc: boolean): BookLevel[] =>
      [...m.entries()]
        .filter(([, size]) => size > 0)
        .sort((a, b) => (desc ? b[0] - a[0] : a[0] - b[0]))
        .map(([price, size]) => ({ price: String(price), size: String(size) }));
    return { bids: levels(book.bids, true), asks: levels(book.asks, false) };
  }

  getLastTradeAt(tokenId: string): number | null {
    return this.lastTradeAt.get(tokenId) ?? null;
  }

  getBestBid(tokenId: string): number | null {
    return bestOf(this.books.get(tokenId)?.bids, true);
  }

  getBestAsk(tokenId: string): number | null {
    return bestOf(this.books.get(tokenId)?.asks, false);
  }

  getStats() {
    return {
      connected: this.isConnected(),
      subscribedTokens: this.subscribedTokens.size,
      maintainedBooks: this.books.size,
      messageCount: this.messageCount,
      reconnectAttempts: this.reconnectAttempt,
    };
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private connect(): void {
    if (!this.running) return;
    const ws = new WebSocket(POLY_URLS.CLOB_WS);
    this.ws = ws;

    ws.on("open", () => {
      logger.info("CLOB WebSocket connected");
      this.reconnectAttempt = 0;
      this.emit("connected");
      if (this.subscribedTokens.size) {
        this.send({
          assets_ids: [...this.subscribedTokens],
          type: "market",
          custom_feature_enabled: true,
        } satisfies MarketSubscriptionMessage);
      }
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, PING_INTERVAL_MS);
    });

    ws.on("message", (data: WebSocket.Data) => {
      this.messageCount++;
      const text = data.toString();
      if (text === "PONG" || text.startsWith("INVALID")) return;
      try {
        this.handleMessage(JSON.parse(text));
      } catch {
        /* ignore parse errors */
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      logger.warn({ code, reason: reason.toString() }, "CLOB WebSocket closed");
      logAudit("warn", "SYSTEM", `CLOB WebSocket closed (code: ${code})`).catch(() => {});
      this.cleanup();
      this.emit("disconnected", { code, reason: reason.toString() });
      this.scheduleReconnect();
    });

    ws.on("error", (error: Error) => {
      logger.error({ error: error.message }, "CLOB WebSocket error");
      logAudit("error", "SYSTEM", `CLOB WebSocket error: ${error.message}`).catch(() => {});
      this.emit("error", error);
    });
  }

  private handleMessage(msg: ClobWsMessage): void {
    const ts = typeof msg.timestamp === "string" ? parseInt(msg.timestamp, 10) : (msg.timestamp ?? Date.now());

    switch (msg.event_type) {
      case "book":
        if (msg.asset_id && msg.bids && msg.asks) {
          this.books.set(msg.asset_id, { bids: toSide(msg.bids), asks: toSide(msg.asks) });
          this.emitBookUpdate(msg.asset_id, ts);
        }
        break;

      case "price_change": {
        const touched = new Set<string>();
        for (const pc of msg.price_changes ?? []) {
          const book = this.books.get(pc.asset_id);
          if (!book) continue; // no snapshot yet; the next `book` resyncs us
          const price = parseFloat(pc.price);
          const size = parseFloat(pc.size);
          if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
          const side = pc.side === "BUY" ? book.bids : book.asks;
          if (size > 0) side.set(price, size);
          else side.delete(price);
          touched.add(pc.asset_id);
        }
        for (const tokenId of touched) this.emitBookUpdate(tokenId, ts);
        break;
      }

      case "last_trade_price": {
        if (!msg.asset_id || !msg.price) break;
        const price = parseFloat(msg.price);
        const size = parseFloat(msg.size ?? "0");
        if (!Number.isFinite(price) || !Number.isFinite(size)) break;
        this.lastTradeAt.set(msg.asset_id, ts);
        this.emit("trade", {
          tokenId: msg.asset_id,
          takerSide: msg.side === "SELL" ? "SELL" : "BUY",
          price,
          size,
          timestamp: ts,
        } satisfies TradeEvent);
        break;
      }

      case "market_resolved":
        if (msg.market && msg.winning_asset_id && msg.winning_outcome) {
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

  private emitBookUpdate(tokenId: string, timestamp: number): void {
    this.emit("bookUpdate", {
      tokenId,
      bestBid: this.getBestBid(tokenId),
      bestAsk: this.getBestAsk(tokenId),
      timestamp,
    } satisfies BookUpdateEvent);
  }

  private cleanup(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    // A reconnect replays fresh snapshots; stale depth must never be executable.
    this.books.clear();
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempt, MAX_RECONNECT_DELAY_MS) + Math.random() * 300;
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

function bestOf(m: Side | undefined, max: boolean): number | null {
  if (!m) return null;
  let best: number | null = null;
  for (const [price, size] of m) {
    if (size > 0 && (best === null || (max ? price > best : price < best))) best = price;
  }
  return best;
}

function toSide(levels: BookLevel[]): Side {
  const m: Side = new Map();
  for (const l of levels) {
    const price = parseFloat(l.price);
    const size = parseFloat(l.size);
    if (Number.isFinite(price) && Number.isFinite(size) && size > 0) m.set(price, size);
  }
  return m;
}

let instance: MarketWebSocketWatcher | null = null;
export function getMarketWebSocketWatcher(): MarketWebSocketWatcher {
  if (!instance) instance = new MarketWebSocketWatcher();
  return instance;
}
