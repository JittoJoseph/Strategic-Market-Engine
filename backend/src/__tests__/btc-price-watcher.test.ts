import { describe, it, expect, beforeEach, vi } from "vitest";
import { BtcPriceWatcher } from "../services/btc-price-watcher.js";

// Mock the logger
vi.mock("../utils/logger.js", () => {
  const noop = () => {};
  const childLogger = {
    info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop,
    child: () => childLogger,
  };
  return { createModuleLogger: () => childLogger, getLogger: () => childLogger };
});

// Mock price history by accessing private field
function seedPriceHistory(
  watcher: BtcPriceWatcher,
  entries: Array<{ price: number; timestamp: number }>,
): void {
  // @ts-ignore — access private for testing
  watcher["priceHistory"] = entries;
  // @ts-ignore
  watcher["currentPrice"] = entries[entries.length - 1]?.price ?? null;
}

describe("BtcPriceWatcher.getMomentum()", () => {
  let watcher: BtcPriceWatcher;
  const NOW = Date.now();

  beforeEach(() => {
    watcher = new BtcPriceWatcher();
  });

  it("returns NEUTRAL with hasData=false when price history is empty", () => {
    const signal = watcher.getMomentum(90_000, 30);
    expect(signal.direction).toBe("NEUTRAL");
    expect(signal.hasData).toBe(false);
    expect(signal.changeUsd).toBe(0);
  });

  it("returns NEUTRAL with hasData=false when fewer than 2 ticks", () => {
    seedPriceHistory(watcher, [{ price: 67000, timestamp: NOW - 5_000 }]);
    const signal = watcher.getMomentum(90_000, 30);
    expect(signal.hasData).toBe(false);
  });

  it("detects UP momentum when BTC moved +$100 in last 90s", () => {
    const historicalPrice = 67000;
    const currentPrice = 67100;
    seedPriceHistory(watcher, [
      { price: historicalPrice, timestamp: NOW - 120_000 }, // 2 min ago = historical reference
      { price: 67050, timestamp: NOW - 45_000 },            // intermediate
      { price: currentPrice, timestamp: NOW - 1_000 },      // current
    ]);

    const signal = watcher.getMomentum(90_000, 30);
    expect(signal.direction).toBe("UP");
    expect(signal.changeUsd).toBeCloseTo(100, 0);
    expect(signal.hasData).toBe(true);
  });

  it("detects DOWN momentum when BTC fell -$80", () => {
    seedPriceHistory(watcher, [
      { price: 67500, timestamp: NOW - 120_000 },
      { price: 67450, timestamp: NOW - 60_000 },
      { price: 67420, timestamp: NOW - 1_000 },
    ]);

    const signal = watcher.getMomentum(90_000, 30);
    expect(signal.direction).toBe("DOWN");
    expect(signal.changeUsd).toBeLessThan(0);
    expect(signal.hasData).toBe(true);
  });

  it("returns NEUTRAL when price change is below minChangeUsd threshold", () => {
    // Only moved $10 — below the $30 minimum
    seedPriceHistory(watcher, [
      { price: 67000, timestamp: NOW - 120_000 },
      { price: 67010, timestamp: NOW - 1_000 },
    ]);

    const signal = watcher.getMomentum(90_000, 30);
    expect(signal.direction).toBe("NEUTRAL");
    expect(signal.hasData).toBe(true);
    expect(Math.abs(signal.changeUsd)).toBe(10);
  });

  it("uses oldest tick when all history is within lookback window", () => {
    // All ticks within 30s, lookback is 90s → should use oldest as reference
    const entries = [
      { price: 67000, timestamp: NOW - 25_000 }, // oldest (30s ago)
      { price: 67020, timestamp: NOW - 15_000 },
      { price: 67100, timestamp: NOW - 1_000 },  // current
    ];
    seedPriceHistory(watcher, entries);

    const signal = watcher.getMomentum(90_000, 30);
    // 67100 - 67000 = +100 → UP
    expect(signal.direction).toBe("UP");
    expect(signal.changeUsd).toBeCloseTo(100, 0);
  });

  it("returns correct lookbackMs in the signal", () => {
    seedPriceHistory(watcher, [
      { price: 67000, timestamp: NOW - 200_000 },
      { price: 67100, timestamp: NOW - 1_000 },
    ]);

    const signal = watcher.getMomentum(60_000, 30);
    expect(signal.lookbackMs).toBe(60_000);
  });

  it("handles exact minChangeUsd boundary — below = NEUTRAL", () => {
    seedPriceHistory(watcher, [
      { price: 67000, timestamp: NOW - 120_000 },
      { price: 67029, timestamp: NOW - 1_000 }, // $29 change — below $30 min
    ]);
    expect(watcher.getMomentum(90_000, 30).direction).toBe("NEUTRAL");
  });

  it("handles exact minChangeUsd boundary — at/above = directional", () => {
    seedPriceHistory(watcher, [
      { price: 67000, timestamp: NOW - 120_000 },
      { price: 67030, timestamp: NOW - 1_000 }, // exactly $30 — should be UP
    ]);
    expect(watcher.getMomentum(90_000, 30).direction).toBe("UP");
  });
});
