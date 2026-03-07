import { describe, it, expect, vi } from "vitest";

// Mock the logger module before importing execution-simulator
vi.mock("../utils/logger.js", () => {
  const noop = () => {};
  const childLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => childLogger,
  };
  return {
    createModuleLogger: () => childLogger,
    getLogger: () => childLogger,
  };
});

import {
  simulateLimitBuy,
  simulateLimitSell,
  calculateWinProfit,
  calculateLossAmount,
  calculateEarlyExitPnl,
  calculateFeePerShare,
  type ExecutionResult,
  type SellExecutionResult,
} from "../services/execution-simulator.js";
import type { Orderbook } from "../types/index.js";

/**
 * Helper to build a mock orderbook for testing.
 */
function makeOrderbook(
  asks: Array<{ price: string; size: string }>,
  bids: Array<{ price: string; size: string }>,
  tickSize = "0.01",
): Orderbook {
  return {
    market: "0xtest",
    asset_id: "test-token-id",
    timestamp: String(Date.now()),
    hash: "0xhash",
    bids,
    asks,
    tick_size: tickSize,
    neg_risk: false,
  };
}

// ============================================
// simulateLimitBuy — crypto fee always applied
// ============================================

describe("simulateLimitBuy", () => {
  it("fills at all ask levels at or below the limit price", () => {
    const orderbook = makeOrderbook(
      [
        { price: "0.93", size: "100" },
        { price: "0.95", size: "200" },
        { price: "0.97", size: "500" },
      ],
      [{ price: "0.92", size: "100" }],
    );

    // Limit at 0.95 — should fill 0.93 and 0.95, skip 0.97
    const result = simulateLimitBuy(orderbook, 1000, 0.95);

    expect(result.fillDetails.length).toBe(2);
    expect(result.fillDetails[0]!.price).toBe(0.93);
    expect(result.fillDetails[1]!.price).toBe(0.95);
    expect(result.fillDetails.every((d) => d.price <= 0.95)).toBe(true);
    expect(result.totalShares).toBeGreaterThan(0);
  });

  it("skips all asks above the limit price", () => {
    const orderbook = makeOrderbook(
      [
        { price: "0.96", size: "100" },
        { price: "0.97", size: "200" },
      ],
      [{ price: "0.94", size: "100" }],
    );

    const result = simulateLimitBuy(orderbook, 1, 0.95);

    expect(result.totalShares).toBe(0);
    expect(result.fillDetails.length).toBe(0);
  });

  it("respects the USD budget", () => {
    const orderbook = makeOrderbook([{ price: "0.50", size: "1000" }], []);

    // $1 budget at $0.50/share — crypto fees will reduce the shares slightly
    const result = simulateLimitBuy(orderbook, 1, 0.5);

    expect(result.totalShares).toBeGreaterThan(1.5);
    expect(result.netCost).toBeLessThanOrEqual(1.01);
  });

  it("handles an empty orderbook gracefully", () => {
    const orderbook = makeOrderbook([], []);
    const result = simulateLimitBuy(orderbook, 1, 0.95);

    expect(result.totalShares).toBe(0);
    expect(result.averagePrice).toBe(0);
    expect(result.fees).toBe(0);
  });

  it("fills across multiple ask levels with price improvement", () => {
    const orderbook = makeOrderbook(
      [
        { price: "0.90", size: "5" },
        { price: "0.93", size: "5" },
        { price: "0.95", size: "100" },
      ],
      [],
    );

    const result = simulateLimitBuy(orderbook, 100, 0.97);

    expect(result.fillDetails.length).toBe(3);
    expect(result.averagePrice).toBeGreaterThan(0.9);
    expect(result.averagePrice).toBeLessThan(0.97);
  });

  it("always applies crypto fee — fees > 0 at mid-range price", () => {
    const orderbook = makeOrderbook([{ price: "0.50", size: "100" }], []);

    // At p=0.50 the fee = 0.25 × (0.5 × 0.5)^2 = 0.015625 per share
    const result = simulateLimitBuy(orderbook, 10, 0.5);

    expect(result.fees).toBeGreaterThan(0);
    expect(result.fees).toBeGreaterThan(0.1);
  });

  it("applies very small fees at extreme prices (near 0.97)", () => {
    const orderbook = makeOrderbook([{ price: "0.97", size: "100" }], []);

    const result = simulateLimitBuy(orderbook, 1, 0.97);

    expect(result.fees).toBeGreaterThanOrEqual(0);
    expect(result.fees).toBeLessThan(0.01);
  });

  it("correctly marks partial fills when budget remains", () => {
    const orderbook = makeOrderbook([{ price: "0.95", size: "0.5" }], []);

    const result = simulateLimitBuy(orderbook, 10, 0.95);

    expect(result.isPartialFill).toBe(true);
    expect(result.totalShares).toBeCloseTo(0.5, 1);
  });

  it("belowMinimumOrderSize is true when filled < min_order_size", () => {
    // min_order_size defaults to 5 when not set
    const orderbook = makeOrderbook([{ price: "0.95", size: "3" }], []);

    const result = simulateLimitBuy(orderbook, 10, 0.95);

    expect(result.totalShares).toBe(3);
    expect(result.belowMinimumOrderSize).toBe(true);
    expect(result.minOrderSize).toBe(5);
  });

  it("belowMinimumOrderSize is false when filled >= min_order_size", () => {
    const orderbook = makeOrderbook([{ price: "0.95", size: "100" }], []);

    const result = simulateLimitBuy(orderbook, 10, 0.95);

    expect(result.totalShares).toBeGreaterThanOrEqual(5);
    expect(result.belowMinimumOrderSize).toBe(false);
  });

  it("respects custom min_order_size from orderbook", () => {
    const orderbook: Orderbook = {
      market: "0xtest",
      asset_id: "test-token-id",
      timestamp: String(Date.now()),
      hash: "0xhash",
      bids: [],
      asks: [{ price: "0.95", size: "8" }],
      min_order_size: "10",
      tick_size: "0.01",
      neg_risk: false,
    };

    const result = simulateLimitBuy(orderbook, 10, 0.95);

    expect(result.totalShares).toBe(8);
    expect(result.belowMinimumOrderSize).toBe(true);
    expect(result.minOrderSize).toBe(10);
  });

  it("netCost equals totalCost + fees", () => {
    const orderbook = makeOrderbook([{ price: "0.90", size: "50" }], []);

    const result = simulateLimitBuy(orderbook, 10, 0.95);

    expect(result.netCost).toBeCloseTo(result.totalCost + result.fees, 6);
  });
});

// ============================================
// simulateLimitSell — crypto fee always applied
// ============================================

describe("simulateLimitSell", () => {
  it("fills at bid levels at or above the limit price", () => {
    const orderbook = makeOrderbook(
      [],
      [
        { price: "0.90", size: "100" },
        { price: "0.85", size: "200" },
        { price: "0.80", size: "500" },
      ],
    );

    const result = simulateLimitSell(orderbook, 50, 0.85);

    expect(result.totalSharesSold).toBe(50);
    expect(result.fillDetails.length).toBe(1);
    expect(result.fillDetails[0]!.price).toBe(0.9);
  });

  it("skips bids below the limit price", () => {
    const orderbook = makeOrderbook(
      [],
      [
        { price: "0.80", size: "100" },
        { price: "0.70", size: "200" },
      ],
    );

    const result = simulateLimitSell(orderbook, 10, 0.85);

    expect(result.totalSharesSold).toBe(0);
    expect(result.fillDetails.length).toBe(0);
  });

  it("panic-sells at any price when limit is 0", () => {
    const orderbook = makeOrderbook(
      [],
      [
        { price: "0.50", size: "10" },
        { price: "0.30", size: "10" },
        { price: "0.10", size: "10" },
      ],
    );

    const result = simulateLimitSell(orderbook, 25, 0);

    expect(result.totalSharesSold).toBe(25);
    expect(result.fillDetails.length).toBe(3);
    expect(result.averagePrice).toBeGreaterThan(0.1);
    expect(result.averagePrice).toBeLessThan(0.5);
  });

  it("handles empty bids gracefully", () => {
    const orderbook = makeOrderbook([], []);
    const result = simulateLimitSell(orderbook, 10, 0);

    expect(result.totalSharesSold).toBe(0);
    expect(result.averagePrice).toBe(0);
    expect(result.netRevenue).toBe(0);
  });

  it("handles partial fills correctly", () => {
    const orderbook = makeOrderbook([], [{ price: "0.80", size: "5" }]);

    const result = simulateLimitSell(orderbook, 100, 0);

    expect(result.totalSharesSold).toBe(5);
    expect(result.isPartialFill).toBe(true);
  });

  it("netRevenue equals grossRevenue minus fees", () => {
    const orderbook = makeOrderbook([], [{ price: "0.80", size: "100" }]);

    const result = simulateLimitSell(orderbook, 20, 0);

    expect(result.netRevenue).toBeCloseTo(result.totalRevenue - result.fees, 6);
  });
});

// ============================================
// PnL Calculation Helpers
// ============================================

describe("calculateFeePerShare", () => {
  it("returns near-zero fee at extreme prices", () => {
    const fee97 = calculateFeePerShare(0.97);
    expect(fee97).toBeLessThan(0.001);
    expect(fee97).toBeGreaterThanOrEqual(0);
  });

  it("returns peak fee near 0.50", () => {
    const fee50 = calculateFeePerShare(0.5);
    expect(fee50).toBeGreaterThan(0.01);
  });

  it("returns 0 at price 0 and 1", () => {
    expect(calculateFeePerShare(0)).toBe(0);
    expect(calculateFeePerShare(1)).toBe(0);
  });
});

describe("calculateWinProfit", () => {
  it("calculates profit for a winning trade", () => {
    const profit = calculateWinProfit(0.95, 10, 0.01);
    expect(profit).toBeCloseTo(0.49, 4);
  });

  it("returns higher profit for lower entry price", () => {
    const profitAt95 = calculateWinProfit(0.95, 10, 0);
    const profitAt90 = calculateWinProfit(0.9, 10, 0);
    expect(profitAt90).toBeGreaterThan(profitAt95);
  });

  it("returns 0 profit at entry price 1.00", () => {
    const profit = calculateWinProfit(1.0, 10, 0);
    expect(profit).toBeCloseTo(0, 4);
  });
});

describe("calculateLossAmount", () => {
  it("calculates full loss for a losing trade", () => {
    const loss = calculateLossAmount(0.95, 10, 0.01);
    expect(loss).toBeCloseTo(-9.51, 4);
  });

  it("loss is always negative", () => {
    const loss = calculateLossAmount(0.5, 1, 0);
    expect(loss).toBeLessThan(0);
  });
});

describe("calculateEarlyExitPnl", () => {
  it("calculates partial loss for stop-loss exit", () => {
    const pnl = calculateEarlyExitPnl(0.95, 0.8, 10, 0.01, 0.005);
    expect(pnl).toBeCloseTo(-1.515, 4);
  });

  it("calculates profit for a profitable early exit", () => {
    const pnl = calculateEarlyExitPnl(0.5, 0.7, 10, 0.01, 0.01);
    expect(pnl).toBeCloseTo(1.98, 4);
  });

  it("stop-loss loss is smaller than full loss", () => {
    const fullLoss = calculateLossAmount(0.95, 10, 0.01);
    const stopLoss = calculateEarlyExitPnl(0.95, 0.8, 10, 0.01, 0.005);
    expect(stopLoss).toBeGreaterThan(fullLoss);
  });
});
