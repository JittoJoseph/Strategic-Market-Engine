import { createModuleLogger } from "../utils/logger.js";
import { POLY_URLS } from "../types/index.js";

const logger = createModuleLogger("market-clock");

/**
 * The single source of truth for market time.
 *
 * Every window boundary, countdown and entry deadline is defined by Polymarket,
 * so market time is Polymarket's clock — not the host's. The host clock is only
 * used to interpolate between syncs. `GET /time` returns the CLOB server's Unix
 * seconds and is documented for exactly this purpose:
 * https://docs.polymarket.com/api-reference/data/get-server-time
 */
export class MarketClock {
  private offsetMs = 0;
  private syncedAtMs: number | null = null;
  private lastRttMs: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Server time has 1s resolution, so sub-second corrections are noise. */
  private static readonly MIN_CORRECTION_MS = 1000;
  private static readonly SYNC_INTERVAL_MS = 5 * 60_000;
  /** A slow round-trip makes the midpoint estimate unreliable; resample instead. */
  private static readonly MAX_ACCEPTABLE_RTT_MS = 2000;
  private static readonly SYNC_ATTEMPTS = 3;

  async start(): Promise<void> {
    await this.sync();
    this.timer = setInterval(() => {
      this.sync().catch(() => {});
    }, MarketClock.SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Current market time in epoch ms. */
  now(): number {
    return Date.now() + this.offsetMs;
  }

  getStatus() {
    return {
      offsetMs: Math.round(this.offsetMs),
      syncedAtMs: this.syncedAtMs,
      lastRttMs: this.lastRttMs,
      synced: this.syncedAtMs !== null,
    };
  }

  /**
   * Samples the server clock a few times and keeps the lowest-latency reading:
   * with symmetric latency the request midpoint is the best estimate of the
   * instant the server stamped its reply, so the tightest round-trip wins.
   */
  async sync(): Promise<boolean> {
    let best: { offsetMs: number; rttMs: number } | null = null;

    for (let i = 0; i < MarketClock.SYNC_ATTEMPTS; i++) {
      try {
        const sentAt = Date.now();
        const res = await fetch(`${POLY_URLS.CLOB_BASE}/time`, {
          signal: AbortSignal.timeout(5000),
        });
        const receivedAt = Date.now();
        if (!res.ok) continue;

        const serverSeconds = parseInt((await res.text()).trim(), 10);
        if (!Number.isFinite(serverSeconds)) continue;

        const rttMs = receivedAt - sentAt;
        const offsetMs = serverSeconds * 1000 - (sentAt + receivedAt) / 2;
        if (!best || rttMs < best.rttMs) best = { offsetMs, rttMs };
        if (rttMs <= MarketClock.MAX_ACCEPTABLE_RTT_MS) break;
      } catch {
        /* try again */
      }
    }

    if (!best) {
      logger.warn(
        { offsetMs: Math.round(this.offsetMs), synced: this.syncedAtMs !== null },
        "Market clock sync failed — continuing on the last known offset",
      );
      return false;
    }

    const previousOffsetMs = this.offsetMs;
    // Ignore sub-resolution jitter so the clock doesn't wobble every sync.
    if (Math.abs(best.offsetMs - previousOffsetMs) >= MarketClock.MIN_CORRECTION_MS) {
      this.offsetMs = best.offsetMs;
    }
    this.syncedAtMs = Date.now();
    this.lastRttMs = Math.round(best.rttMs);

    const drift = best.offsetMs - previousOffsetMs;
    const log =
      Math.abs(best.offsetMs) >= MarketClock.MIN_CORRECTION_MS ? "warn" : "info";
    logger[log](
      {
        offsetMs: Math.round(this.offsetMs),
        measuredMs: Math.round(best.offsetMs),
        driftMs: Math.round(drift),
        rttMs: this.lastRttMs,
      },
      "Market clock synced to Polymarket",
    );
    return true;
  }
}

let instance: MarketClock | null = null;
export function getMarketClock(): MarketClock {
  if (!instance) instance = new MarketClock();
  return instance;
}

/** Market time in epoch ms — use instead of Date.now() for anything market-related. */
export function marketNow(): number {
  return getMarketClock().now();
}
