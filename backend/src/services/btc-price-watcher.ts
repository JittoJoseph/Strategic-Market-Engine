import { EventEmitter } from "events";
import WebSocket from "ws";
import { createModuleLogger } from "../utils/logger.js";
import { POLY_URLS, RTDS_RAW_TOPIC, WINDOW_CONFIG } from "../types/index.js";
import type { BtcPriceData } from "../interfaces/websocket-types.js";
import { logAudit } from "../db/client.js";
import { marketNow } from "./market-clock.js";

const logger = createModuleLogger("btc-price-watcher");
const TWAP_TOPIC = WINDOW_CONFIG.rtdsTwapTopic;

const PING_INTERVAL_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const HISTORY_TTL_MS = 30 * 60_000;
const STALE_THRESHOLD_MS = 30_000;
const STALE_CHECK_INTERVAL_MS = 10_000;
const PRUNE_EVERY_TICKS = 120;
const MAX_TICK_GAP_MS = 4_000;

interface Tick {
  price: number;
  timestamp: number;
}

/**
 * Two Chainlink BTC/USD series from RTDS: `twap` is what markets settle on;
 * `raw` is the unsmoothed feed that drives it, and the only correct input for
 * volatility and for the roll-off term of the forecast.
 */
export class BtcPriceWatcher extends EventEmitter {
  private ws: WebSocket | null = null;
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stalenessWatchdog: ReturnType<typeof setInterval> | null = null;

  private twapHistory: Tick[] = [];
  private rawHistory: Tick[] = [];
  private lastTwapReceivedMs = 0;
  private lastRawReceivedMs = 0;
  private ticksSinceLastPrune = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.stalenessWatchdog = setInterval(() => {
      if (!this.running || this.lastTwapReceivedMs === 0 || this.getTwapAgeMs() < STALE_THRESHOLD_MS) return;
      logger.warn({ ageMs: this.getTwapAgeMs() }, "BTC feed stale, reconnecting");
      logAudit("warn", "SYSTEM", "BTC price feed stale (>30s). Force-reconnecting.").catch(() => {});
      this.closeSocket();
      this.reconnectAttempt = 0;
      this.connect();
    }, STALE_CHECK_INTERVAL_MS);
    logger.info({ twapTopic: TWAP_TOPIC, rawTopic: RTDS_RAW_TOPIC }, "BTC price watcher started");
  }

  stop(): void {
    this.running = false;
    if (this.stalenessWatchdog) clearInterval(this.stalenessWatchdog);
    this.stalenessWatchdog = null;
    this.closeSocket();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getCurrentTwap(): BtcPriceData | null {
    return this.twapHistory.at(-1) ?? null;
  }

  getCurrentRaw(): BtcPriceData | null {
    return this.rawHistory.at(-1) ?? null;
  }

  getTwapAgeMs(): number {
    return this.lastTwapReceivedMs === 0 ? -1 : marketNow() - this.lastTwapReceivedMs;
  }

  getRawAgeMs(): number {
    return this.lastRawReceivedMs === 0 ? -1 : marketNow() - this.lastRawReceivedMs;
  }

  isPriceFresh(): boolean {
    return this.lastTwapReceivedMs !== 0 && this.getTwapAgeMs() < STALE_THRESHOLD_MS;
  }

  /** Last TWAP observation at or before `targetMs`. */
  getTwapAt(targetMs: number): number | null {
    return at(this.twapHistory, targetMs);
  }

  /** Last raw observation at or before `targetMs`. */
  getRawAt(targetMs: number): number | null {
    return at(this.rawHistory, targetMs);
  }

  /**
   * Trapezoidal mean of the raw feed over [fromMs, toMs]. Null unless the range
   * is fully covered by ticks close enough to integrate, so a feed gap never
   * produces a confident wrong forecast.
   */
  getRawMean(fromMs: number, toMs: number): number | null {
    const h = this.rawHistory;
    if (toMs <= fromMs || h.length < 2 || h[0]!.timestamp > fromMs || h.at(-1)!.timestamp < toMs) return null;

    let area = 0;
    for (let i = 1; i < h.length; i++) {
      const a = h[i - 1]!;
      const b = h[i]!;
      if (b.timestamp <= fromMs) continue;
      if (a.timestamp >= toMs) break;
      if (b.timestamp - a.timestamp > MAX_TICK_GAP_MS) return null;
      const lo = Math.max(a.timestamp, fromMs);
      const hi = Math.min(b.timestamp, toMs);
      if (hi <= lo) continue;
      const slope = (b.price - a.price) / (b.timestamp - a.timestamp);
      const pLo = a.price + slope * (lo - a.timestamp);
      const pHi = a.price + slope * (hi - a.timestamp);
      area += ((pLo + pHi) / 2) * (hi - lo);
    }
    return area / (toMs - fromMs);
  }

  /** Per-second realized volatility of the raw feed, in dollars. */
  getRawSigma(windowMs: number): number | null {
    const cutoff = marketNow() - windowMs;
    const h = this.rawHistory;
    let sumSq = 0;
    let elapsedSec = 0;
    let count = 0;
    for (let i = h.length - 1; i > 0 && h[i - 1]!.timestamp >= cutoff; i--) {
      const dt = (h[i]!.timestamp - h[i - 1]!.timestamp) / 1000;
      if (dt <= 0 || dt > MAX_TICK_GAP_MS / 1000) continue;
      sumSq += (h[i]!.price - h[i - 1]!.price) ** 2;
      elapsedSec += dt;
      count++;
    }
    return count < 30 || elapsedSec <= 0 ? null : Math.sqrt(sumSq / elapsedSec);
  }

  private ingest(topic: string, price: number, timestamp: number): void {
    const isTwap = topic === TWAP_TOPIC;
    const history = isTwap ? this.twapHistory : this.rawHistory;
    if (isTwap) this.lastTwapReceivedMs = marketNow();
    else this.lastRawReceivedMs = marketNow();
    if (timestamp < (history.at(-1)?.timestamp ?? 0)) return;
    history.push({ price, timestamp });
    if (!isTwap) return;

    if (++this.ticksSinceLastPrune >= PRUNE_EVERY_TICKS) {
      this.ticksSinceLastPrune = 0;
      const cutoff = marketNow() - HISTORY_TTL_MS;
      this.twapHistory = dropBefore(this.twapHistory, cutoff);
      this.rawHistory = dropBefore(this.rawHistory, cutoff);
    }
    this.emit("twapUpdate", { price, timestamp } satisfies BtcPriceData);
  }

  private connect(): void {
    if (!this.running) return;
    const ws = new WebSocket(POLY_URLS.RTDS_WS);
    this.ws = ws;

    ws.on("open", () => {
      logger.info("RTDS WebSocket connected");
      this.reconnectAttempt = 0;
      ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [TWAP_TOPIC, RTDS_RAW_TOPIC].map((topic) => ({
            topic,
            type: "update",
            filters: '{"symbol":"btc/usd"}',
          })),
        }),
      );
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, PING_INTERVAL_MS);
    });

    ws.on("message", (data: WebSocket.Data) => {
      const text = data.toString().trim();
      if (text === "PONG" || text === "pong") return;
      try {
        const msg = JSON.parse(text) as { topic?: unknown; payload?: Record<string, unknown> };
        const { topic, payload } = msg;
        if (topic !== TWAP_TOPIC && topic !== RTDS_RAW_TOPIC) return;
        if (payload?.symbol !== "btc/usd" || typeof payload.value !== "number" || typeof payload.timestamp !== "number") return;
        this.ingest(topic, payload.value, payload.timestamp);
      } catch {
        /* ignore malformed frames */
      }
    });

    ws.on("close", (code: number) => {
      logger.warn({ code }, "RTDS WebSocket closed");
      this.closeSocket();
      this.scheduleReconnect();
    });
    ws.on("error", (error: Error) => logger.error({ error: error.message }, "RTDS WebSocket error"));
  }

  private closeSocket(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (!this.ws) return;
    this.ws.removeAllListeners();
    try {
      this.ws.terminate();
    } catch {
      /* already closed */
    }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempt, MAX_RECONNECT_DELAY_MS) + Math.random() * 500;
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

function at(h: Tick[], targetMs: number): number | null {
  let lo = 0;
  let hi = h.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (h[mid]!.timestamp <= targetMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best >= 0 ? h[best]!.price : null;
}

function dropBefore(h: Tick[], cutoff: number): Tick[] {
  let i = 0;
  while (i < h.length && h[i]!.timestamp < cutoff) i++;
  return i > 0 ? h.slice(i) : h;
}

let instance: BtcPriceWatcher | null = null;
export function getBtcPriceWatcher(): BtcPriceWatcher {
  if (!instance) instance = new BtcPriceWatcher();
  return instance;
}
