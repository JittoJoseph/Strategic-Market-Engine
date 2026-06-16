import { EventEmitter } from "events";
import WebSocket from "ws";
import { createModuleLogger } from "../utils/logger.js";
import { POLY_URLS, type MomentumSignal } from "../types/index.js";
import type { BtcPriceData } from "../interfaces/websocket-types.js";
import { logAudit } from "../db/client.js";

const logger = createModuleLogger("btc-price-watcher");

/**
 * BTC price watcher via Polymarket RTDS WebSocket (wss://ws-live-data.polymarket.com).
 *
 * Subscribes to:
 *  - Chainlink (crypto_prices_chainlink, btc/usd) — ~1 tick/sec, filtered to BTC only.
 *    Also sends a historical backfill on subscribe that pre-seeds priceHistory.
 *
 * All timestamps stored as wall-clock Date.now() so getPriceAt() comparisons
 * against Date.now() are consistent.
 *
 * Emits: "btcPriceUpdate" { price, timestamp }
 *
 * Staleness watchdog: if no price tick arrives within STALE_THRESHOLD_MS, the
 * WebSocket is force-closed and reconnected even if readyState === OPEN.
 * This auto-heals the "BTC price frozen while btcConnected=true" bug where the
 * RTDS server stops sending crypto_prices/crypto_prices_chainlink messages
 * without closing the connection.
 */
export class BtcPriceWatcher extends EventEmitter {
  private ws: WebSocket | null = null;
  private currentPrice: number | null = null;
  private lastTimestamp: number = 0;
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Staleness watchdog: timestamp of last setPrice() call (wall-clock ms).
   * Initialized to 0 so the watchdog only fires after the first tick arrives
   * AND stops. Does NOT fire on initial connect before first tick.
   */
  private lastPriceReceivedMs: number = 0;
  private stalenessWatchdog: ReturnType<typeof setInterval> | null = null;

  /** Rolling 60-min buffer of BTC ticks for accurate historical lookups */
  private priceHistory: Array<{ price: number; timestamp: number }> = [];

  private static readonly PING_INTERVAL = 5_000;
  private static readonly MAX_RECONNECT_DELAY = 30_000;
  private static readonly BASE_RECONNECT_DELAY = 1_000;
  private static readonly HISTORY_TTL_MS = 60 * 60 * 1_000; // 60 minutes

  /**
   * How long without a tick before we force-reconnect.
   * Set conservatively: Chainlink ticks ~1/sec, Binance ticks ~1-2/sec in normal mode.
   * 30s covers brief server-side pauses without being too aggressive.
   */
  private static readonly STALE_THRESHOLD_MS = 30_000;

  /** How often we check for staleness */
  private static readonly STALE_CHECK_INTERVAL_MS = 10_000;

  /** Only prune the history buffer every N ticks to reduce GC pressure */
  private static readonly PRUNE_INTERVAL_TICKS = 60;
  private ticksSinceLastPrune = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.startStalenessWatchdog();
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
    if (this.stalenessWatchdog) {
      clearInterval(this.stalenessWatchdog);
      this.stalenessWatchdog = null;
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

  /** Wall-clock age of the last BTC price tick in milliseconds. */
  getPriceAgeMs(): number {
    if (this.lastPriceReceivedMs === 0) return -1; // never received
    return Date.now() - this.lastPriceReceivedMs;
  }

  /** True if the last price tick was received within STALE_THRESHOLD_MS. */
  isPriceFresh(): boolean {
    if (this.lastPriceReceivedMs === 0) return false;
    return this.getPriceAgeMs() < BtcPriceWatcher.STALE_THRESHOLD_MS;
  }

  /** Last known BTC/USD price at or before `targetMs` (wall-clock ms).
   *  Uses binary search — history is sorted ascending by insertion time. */
  getPriceAt(targetMs: number): number | null {
    const h = this.priceHistory;
    if (h.length === 0) return null;

    // Binary search for the rightmost entry with timestamp <= targetMs
    let lo = 0;
    let hi = h.length - 1;
    let bestIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (h[mid]!.timestamp <= targetMs) {
        bestIdx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (bestIdx >= 0) {
      const best = h[bestIdx]!;
      logger.debug(
        {
          targetMs,
          foundTs: best.timestamp,
          price: best.price,
          ageMs: Date.now() - best.timestamp,
        },
        "Found historical BTC price",
      );
      return best.price;
    }

    logger.debug(
      {
        targetMs,
        historySize: h.length,
        oldestTs: h[0]?.timestamp,
      },
      "No historical BTC price found for target time",
    );
    return null;
  }

  /**
   * Timestamp of the oldest entry in the price history buffer, or null if empty.
   * Used by the orchestrator to decide whether it's worth calling getPriceAt().
   */
  getOldestHistoryTimestamp(): number | null {
    return this.priceHistory.length > 0
      ? (this.priceHistory[0]?.timestamp ?? null)
      : null;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Compute BTC momentum over the last `lookbackMs` milliseconds.
   *
   * Uses the existing priceHistory rolling buffer — no additional data sources.
   * Finds the best historical price at or before `now - lookbackMs`, then
   * computes the USD delta to the current price.
   *
   * Returns NEUTRAL when:
   *   - Insufficient history (< 2 ticks)
   *   - Absolute change is below `minChangeUsd` (sideways chop)
   */
  getMomentum(lookbackMs: number, minChangeUsd: number = 30): MomentumSignal {
    const now = Date.now();
    const cutoff = now - lookbackMs;

    if (this.priceHistory.length < 2 || this.currentPrice === null) {
      return { direction: "NEUTRAL", changeUsd: 0, lookbackMs, hasData: false };
    }

    // Find the most recent price at or before the cutoff (i.e. the price
    // `lookbackMs` ago). Walk backwards for efficiency since history is sorted
    // by insertion time (ascending).
    let historical: { price: number; timestamp: number } | null = null;
    for (let i = this.priceHistory.length - 1; i >= 0; i--) {
      const entry = this.priceHistory[i]!;
      if (entry.timestamp <= cutoff) {
        historical = entry;
        break;
      }
    }

    if (!historical) {
      // All history is within the lookback window — use oldest available as proxy
      historical = this.priceHistory[0]!;
    }

    const changeUsd = this.currentPrice - historical.price;
    const absChange = Math.abs(changeUsd);

    let direction: MomentumSignal["direction"];
    if (absChange < minChangeUsd) {
      direction = "NEUTRAL"; // BTC is ranging — no clear edge
    } else if (changeUsd > 0) {
      direction = "UP";
    } else {
      direction = "DOWN";
    }

    return { direction, changeUsd, lookbackMs, hasData: true };
  }

  private setPrice(price: number, _rtdsTimestamp: number): void {
    // Store wall-clock time — RTDS source timestamps can lag real time significantly.
    const timestamp = Date.now();
    this.currentPrice = price;
    this.lastTimestamp = timestamp;
    this.lastPriceReceivedMs = timestamp; // Update staleness watchdog reference
    this.priceHistory.push({ price, timestamp });

    // Only prune every N ticks to avoid allocating a new array on every single tick
    this.ticksSinceLastPrune++;
    if (this.ticksSinceLastPrune >= BtcPriceWatcher.PRUNE_INTERVAL_TICKS) {
      this.ticksSinceLastPrune = 0;
      const cutoff = Date.now() - BtcPriceWatcher.HISTORY_TTL_MS;
      let pruneIdx = 0;
      while (
        pruneIdx < this.priceHistory.length &&
        this.priceHistory[pruneIdx]!.timestamp < cutoff
      ) {
        pruneIdx++;
      }
      if (pruneIdx > 0) this.priceHistory = this.priceHistory.slice(pruneIdx);
    }

    this.emit("btcPriceUpdate", { price, timestamp } satisfies BtcPriceData);
  }

  /**
   * Starts a periodic staleness check.
   *
   * If we have received at least one price tick (lastPriceReceivedMs > 0) and
   * it was more than STALE_THRESHOLD_MS ago, we force-close and reconnect the
   * RTDS WebSocket. This handles the bug where the RTDS server stops sending
   * messages without closing the connection (ws.readyState remains OPEN).
   */
  private startStalenessWatchdog(): void {
    if (this.stalenessWatchdog) return;

    this.stalenessWatchdog = setInterval(() => {
      if (!this.running) return;

      // Only check if we've received at least one tick already
      // (avoids false positives on initial connect before first message)
      if (this.lastPriceReceivedMs === 0) return;

      const ageMs = Date.now() - this.lastPriceReceivedMs;
      if (ageMs < BtcPriceWatcher.STALE_THRESHOLD_MS) return;

      logger.warn(
        {
          ageMs,
          lastPrice: this.currentPrice,
          lastPriceAt: new Date(this.lastPriceReceivedMs).toISOString(),
          wsReadyState: this.ws?.readyState,
          staleThresholdMs: BtcPriceWatcher.STALE_THRESHOLD_MS,
        },
        "BTC price feed stale — force-reconnecting RTDS WebSocket",
      );

      logAudit(
        "warn",
        "SYSTEM",
        "BTC price feed stale (no ticks for >30s). Force-reconnecting to auto-heal.",
      ).catch(() => {});

      // Force-close the existing WebSocket (even if readyState === OPEN)
      // and trigger a fresh reconnect. This is the key fix: the OS-level
      // TCP connection can remain open while the server silently stops
      // sending messages, so we cannot rely on the close event.
      this.forceReconnect();
    }, BtcPriceWatcher.STALE_CHECK_INTERVAL_MS);
  }

  /**
   * Forcefully closes the current WebSocket (if any) and immediately schedules
   * a reconnect. Unlike scheduleReconnect(), this does NOT use exponential
   * backoff — we've been stuck for 30+ seconds already, so reconnect fast.
   */
  private forceReconnect(): void {
    if (!this.running) return;

    // Cancel any pending reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Forcefully destroy the current connection
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.terminate(); // Hard close — does not go through close handshake
      } catch {
        // ignore
      }
      this.ws = null;
    }

    this.cleanup();
    this.reconnectAttempt = 0; // Reset backoff so we reconnect quickly

    // Reconnect immediately
    logger.info("Force-reconnecting RTDS WebSocket due to stale price feed");
    this.connect();
  }

  private connect(): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(POLY_URLS.RTDS_WS);

      this.ws.on("open", () => {
        logger.info("RTDS WebSocket connected");
        this.reconnectAttempt = 0;

        // Subscribe to Chainlink (btc/usd, filtered) + Binance (all symbols, filter in code).
        // crypto_prices filters may not work reliably, so filter btcusdt in message handler.
        const subscribeMsg = JSON.stringify({
          action: "subscribe",
          subscriptions: [
            {
              topic: "crypto_prices_chainlink",
              type: "*",
              filters: '{"symbol":"btc/usd"}',
            },
          ],
        });
        this.ws!.send(subscribeMsg);
        logger.debug("RTDS subscribed: crypto_prices_chainlink");

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

          // Real-time Chainlink logic
          const isChainlink =
            topic === "crypto_prices_chainlink" &&
            payload?.["symbol"] === "btc/usd";

          if (isChainlink && typeof payload?.["value"] === "number") {
            const rawTs =
              typeof payload["timestamp"] === "number"
                ? payload["timestamp"]
                : ((msg["timestamp"] as number) ?? 0);
            this.setPrice(payload["value"] as number, rawTs);
            return;
          }

          // Handle Chainlink backfill (comes through crypto_prices topic with type="subscribe")
          if (
            topic === "crypto_prices" &&
            msg["type"] === "subscribe" &&
            payload?.["symbol"] === "btc/usd" &&
            Array.isArray(payload["data"])
          ) {
            for (const item of payload["data"]) {
              if (
                item &&
                typeof item === "object" &&
                typeof (item as any).timestamp === "number" &&
                typeof (item as any).value === "number"
              ) {
                this.setPrice(
                  (item as any).value as number,
                  (item as any).timestamp as number,
                );
              }
            }
            return;
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
        logAudit(
          "warn",
          "SYSTEM",
          `BTC RTDS WebSocket closed (code: ${code})`,
        ).catch(() => {});
        this.cleanup();
        this.scheduleReconnect();
      });

      this.ws.on("error", (error: Error) => {
        logger.error({ error: error.message }, "RTDS WebSocket error");
        logAudit(
          "error",
          "SYSTEM",
          `BTC RTDS WebSocket error: ${error.message}`,
        ).catch(() => {});
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
