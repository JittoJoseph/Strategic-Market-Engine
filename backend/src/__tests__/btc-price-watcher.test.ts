import { describe, it, expect, beforeEach, vi } from "vitest";
import { BtcPriceWatcher } from "../services/btc-price-watcher.js";

vi.mock("../utils/logger.js", () => {
  const noop = () => {};
  const childLogger = {
    info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop,
    child: () => childLogger,
  };
  return { createModuleLogger: () => childLogger, getLogger: () => childLogger };
});

function seedPriceHistory(
  watcher: BtcPriceWatcher,
  entries: Array<{ price: number; timestamp: number }>,
): void {
  // @ts-ignore — access private for testing
  watcher["priceHistory"] = entries;
  // @ts-ignore
  watcher["currentPrice"] = entries[entries.length - 1]?.price ?? null;
}

function ramp(n: number, start: number, step: number, now: number) {
  const out: Array<{ price: number; timestamp: number }> = [];
  for (let i = 0; i < n; i++) {
    out.push({ price: start + i * step, timestamp: now - (n - 1 - i) * 1000 });
  }
  return out;
}

describe("BtcPriceWatcher.getRealizedVol()", () => {
  let watcher: BtcPriceWatcher;
  const NOW = Date.now();

  beforeEach(() => {
    watcher = new BtcPriceWatcher();
  });

  it("returns null when price history is empty", () => {
    expect(watcher.getRealizedVol(60_000)).toBeNull();
  });

  it("returns null with too few increments (< 10) to be stable", () => {
    seedPriceHistory(watcher, ramp(5, 67000, 10, NOW)); // 4 increments
    expect(watcher.getRealizedVol(60_000)).toBeNull();
  });

  it("computes per-second sigma from a constant-step ramp", () => {
    // 12 ticks 1s apart, +$10 each → 11 increments of $10.
    // sigma = sqrt( sum(dp^2) / sum(dt) ) = sqrt(11*100 / 11) = 10.
    seedPriceHistory(watcher, ramp(12, 67000, 10, NOW));
    expect(watcher.getRealizedVol(60_000)).toBeCloseTo(10, 6);
  });

  it("scales with the size of the moves", () => {
    seedPriceHistory(watcher, ramp(12, 67000, 30, NOW));
    expect(watcher.getRealizedVol(60_000)).toBeCloseTo(30, 6);
  });

  it("ignores ticks older than the window", () => {
    // 20 ticks 1s apart, but a 5s window only covers the last ~6 ticks
    // (5 increments < 10) → null.
    seedPriceHistory(watcher, ramp(20, 67000, 10, NOW));
    expect(watcher.getRealizedVol(5_000)).toBeNull();
  });

  it("is zero for a flat (unchanging) price series", () => {
    seedPriceHistory(watcher, ramp(12, 67000, 0, NOW));
    expect(watcher.getRealizedVol(60_000)).toBe(0);
  });
});
