import { describe, it, expect, beforeEach, vi } from "vitest";
import { StrategyEngine } from "../services/strategy-engine.js";

// Mock the logger module before importing strategy engine
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

// Mock the config module
vi.mock("../utils/config.js", () => ({
  getConfig: () => ({
    strategy: {
      entryPriceThreshold: 0.95,
      maxEntryPrice: 0.97,
      tradeFromWindowSeconds: 60,
      maxSimultaneousPositions: 5,
      minBtcDistanceUsd: 7,
      marketWindow: "5M",
      scanIntervalMs: 30000,
      stopLossEnabled: false,
      stopLossThreshold: 0.85,
    },
    simulation: { amountUsd: 1 },
    logging: { level: "silent" },
    env: "test",
  }),
}));

describe("StrategyEngine", () => {
  let engine: StrategyEngine;
  const btcPrice = { price: 97500, timestamp: Date.now() };

  beforeEach(() => {
    engine = new StrategyEngine();
  });

  it("emits opportunityDetected when all conditions met", () => {
    const endDate = new Date(Date.now() + 30_000); // 30s from now
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    // midpoint = (0.94 + 0.96) / 2 = 0.95 ≥ threshold
    engine.evaluatePrice("token-up", 0.94, 0.96, btcPrice);

    expect(handler).toHaveBeenCalledOnce();
    const opp = handler.mock.calls[0][0];
    expect(opp.tokenId).toBe("token-up");
    expect(opp.outcomeLabel).toBe("Up");
    expect(opp.midpoint).toBeCloseTo(0.95, 4);
    expect(opp.bestAsk).toBe(0.96);
    expect(opp.bestBid).toBe(0.94);
  });

  it("does NOT trigger when midpoint is below threshold", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    // midpoint = (0.90 + 0.94) / 2 = 0.92 < 0.95
    engine.evaluatePrice("token-up", 0.9, 0.94, btcPrice);

    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT trigger when outside trade window", () => {
    const endDate = new Date(Date.now() + 120_000); // 2 minutes away (>60s)
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice);

    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT trigger when BTC distance is too small", () => {
    const endDate = new Date(Date.now() + 30_000);
    // Target = 97498, current = 97500 → distance = 2 < minBtcDistanceUsd(7)
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97498);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice);

    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT trigger when position limit is reached", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);
    engine.setOpenPositionCount(5); // max positions

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice);

    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT re-trigger for already evaluated tokens", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    // First trigger
    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice);
    expect(handler).toHaveBeenCalledOnce();

    // Second evaluation — should NOT trigger again
    engine.evaluatePrice("token-up", 0.97, 0.99, btcPrice);
    expect(handler).toHaveBeenCalledOnce(); // Still only 1 call
  });

  it("resets evaluated tokens for new windows", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice);
    expect(handler).toHaveBeenCalledOnce();

    // Reset for new window
    engine.resetForNewWindow();

    // Re-evaluate — should trigger again
    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("carries BTC distance in opportunity data", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice);

    const opp = handler.mock.calls[0][0];
    expect(opp.btcDistanceUsd).toBeCloseTo(100, 0); // |97500 - 97400| = 100
    expect(opp.btcTargetPrice).toBe(97400);
    expect(opp.btcPrice).toBe(97500);
  });

  it("does NOT trigger when targetPrice is null (btcPriceAtWindowStart not yet set)", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, null);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice);

    expect(handler).not.toHaveBeenCalled();
  });

  it("triggers after updateTargetPrice fills the null target", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, null);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    // Should not fire — target is null
    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice);
    expect(handler).not.toHaveBeenCalled();

    // Simulate tryFillBtcWindowStart setting the target
    engine.updateTargetPrice("token-up", 97400);

    // Now should fire — all conditions met
    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("clearEvaluated allows retry after a failed opportunity attempt", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    // First trigger
    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice);
    expect(handler).toHaveBeenCalledOnce();

    // Orchestrator calls clearEvaluated when no orderbook fill
    engine.clearEvaluated("token-up");

    // Should fire again on next price update
    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("updateTargetPrice has no effect on unregistered token", () => {
    // Should not throw
    expect(() => engine.updateTargetPrice("nonexistent", 97000)).not.toThrow();
  });

  it("unregisterMarket clears evaluated state so token can re-trigger", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice);
    expect(handler).toHaveBeenCalledOnce();

    engine.unregisterMarket("token-up");

    // Re-register (new window, same token)
    engine.registerMarket("market-2", "token-up", "Up", endDate, 97400);
    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
