import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  StrategyEngine,
  barrierFairValue,
} from "../services/strategy-engine.js";

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

vi.mock("../utils/config.js", () => ({
  getConfig: () => ({
    strategy: {
      marketWindow: "5M",
      entryFromWindowSeconds: 60,
      maxEntryPrice: 0.98,
      zEntryThreshold: 3.0,
      sigmaWindowMs: 60_000,
      minEntryEdge: 0,
      offsideExitEnabled: true,
      offsideExitK: 1.0,
      maxSimultaneousPositions: 5,
      scanIntervalMs: 30000,
    },
    portfolio: { startingCapital: 100 },
    logging: { level: "silent" },
    env: "test",
  }),
}));

const btcPrice = { price: 97500, timestamp: Date.now() };

// strike 97400, btc 97500 → +$100 cushion; z = 100 / (sigma·√30), √30 ≈ 5.48
// sigma 5 → z ≈ 3.65 (clears 3.0 gate); sigma 20 → z ≈ 0.91 (below gate)
const SIGMA_PASS = 5;
const SIGMA_FAIL = 20;

describe("barrierFairValue", () => {
  it("is monotonically increasing in z and capped at 0.995", () => {
    expect(barrierFairValue(0)).toBeCloseTo(0.5, 4);
    expect(barrierFairValue(1)).toBeGreaterThan(barrierFairValue(0.5));
    expect(barrierFairValue(3)).toBeGreaterThan(barrierFairValue(2));
    expect(barrierFairValue(10)).toBeLessThanOrEqual(0.995);
    expect(barrierFairValue(3)).toBeGreaterThan(0.99);
  });
});

describe("StrategyEngine (barrier / z-score)", () => {
  let engine: StrategyEngine;

  beforeEach(() => {
    engine = new StrategyEngine();
  });

  it("emits opportunityDetected when the favorite clears the z gate", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, SIGMA_PASS);

    expect(handler).toHaveBeenCalledOnce();
    const opp = handler.mock.calls[0][0];
    expect(opp.tokenId).toBe("token-up");
    expect(opp.outcomeLabel).toBe("Up");
    expect(opp.strike).toBe(97400);
    expect(opp.signedDistanceUsd).toBeCloseTo(100, 0);
    expect(opp.z).toBeGreaterThanOrEqual(3.0);
    expect(opp.sigmaPerSec).toBe(SIGMA_PASS);
    expect(opp.fairValue).toBeGreaterThan(0.9);
  });

  it("emits for a DOWN favorite (BTC below strike)", () => {
    const endDate = new Date(Date.now() + 30_000);
    // strike 97600, btc 97500 → Down favored by $100
    engine.registerMarket("market-1", "token-down", "Down", endDate, 97600);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-down", 0.96, 0.98, btcPrice, SIGMA_PASS);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].outcomeLabel).toBe("Down");
    expect(handler.mock.calls[0][0].signedDistanceUsd).toBeCloseTo(100, 0);
  });

  it("does NOT trigger when the token is NOT the current favorite", () => {
    const endDate = new Date(Date.now() + 30_000);
    // Up token but BTC (97500) is BELOW strike (97600) → Up is the underdog
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97600);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, SIGMA_PASS);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT trigger when z is below the threshold (high volatility)", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, SIGMA_FAIL);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT trigger when outside the entry window", () => {
    const endDate = new Date(Date.now() + 120_000); // 2 min away (>60s)
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, SIGMA_PASS);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT trigger when sigma is unknown (null)", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, null);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT trigger when the book does not price the token as favorite (mid < 0.5)", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    // Even though z clears, mid = 0.45 < 0.5 → skip
    engine.evaluatePrice("token-up", 0.4, 0.5, btcPrice, SIGMA_PASS);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT trigger when position limit is reached", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);
    engine.setOpenPositionCount(5);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, SIGMA_PASS);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT trigger when strike is null (window-start price not yet known)", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, null);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, SIGMA_PASS);
    expect(handler).not.toHaveBeenCalled();
  });

  it("triggers after updateStrike fills the null strike", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, null);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, SIGMA_PASS);
    expect(handler).not.toHaveBeenCalled();

    engine.updateStrike("token-up", 97400);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, SIGMA_PASS);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does NOT re-trigger for already evaluated tokens", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, SIGMA_PASS);
    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, SIGMA_PASS);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("clearEvaluated allows retry after a failed opportunity attempt", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, SIGMA_PASS);
    expect(handler).toHaveBeenCalledOnce();

    engine.clearEvaluated("token-up");

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, SIGMA_PASS);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("updateStrike has no effect on an unregistered token", () => {
    expect(() => engine.updateStrike("nonexistent", 97000)).not.toThrow();
  });

  it("unregisterMarket clears evaluated state so token can re-trigger", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, SIGMA_PASS);
    expect(handler).toHaveBeenCalledOnce();

    engine.unregisterMarket("token-up");
    engine.registerMarket("market-2", "token-up", "Up", endDate, 97400);
    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, SIGMA_PASS);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
