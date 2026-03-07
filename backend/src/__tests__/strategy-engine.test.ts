import { describe, it, expect, beforeEach, vi } from "vitest";
import { StrategyEngine } from "../services/strategy-engine.js";
import type { MomentumSignal } from "../types/index.js";

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
      stopLossPriceTrigger: 0.85,
      momentumEnabled: true,
      momentumLookbackMs: 90_000,
      momentumMinChangeUsd: 30,
      minOracleLeadUsd: 50,
    },
    portfolio: { startingCapital: 100 },
    logging: { level: "silent" },
    env: "test",
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMomentum(
  direction: MomentumSignal["direction"],
  changeUsd = 50,
): MomentumSignal {
  return {
    direction,
    changeUsd: direction === "DOWN" ? -changeUsd : changeUsd,
    lookbackMs: 90_000,
    hasData: true,
  };
}

const btcPrice = { price: 97500, timestamp: Date.now() };
const upMomentum = makeMomentum("UP");
const downMomentum = makeMomentum("DOWN");
const neutralMomentum: MomentumSignal = {
  direction: "NEUTRAL",
  changeUsd: 10,
  lookbackMs: 90_000,
  hasData: true,
};
const noDataMomentum: MomentumSignal = {
  direction: "NEUTRAL",
  changeUsd: 0,
  lookbackMs: 90_000,
  hasData: false,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("StrategyEngine", () => {
  let engine: StrategyEngine;

  beforeEach(() => {
    engine = new StrategyEngine();
  });

  // ── Core threshold / timing tests ────────────────────────────────────────

  it("emits opportunityDetected when all conditions met (UP+UP)", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    // midpoint = (0.94 + 0.96) / 2 = 0.95 ≥ threshold, momentum UP
    engine.evaluatePrice("token-up", 0.94, 0.96, btcPrice, upMomentum);

    expect(handler).toHaveBeenCalledOnce();
    const opp = handler.mock.calls[0][0];
    expect(opp.tokenId).toBe("token-up");
    expect(opp.outcomeLabel).toBe("Up");
    expect(opp.midpoint).toBeCloseTo(0.95, 4);
    expect(opp.momentum?.direction).toBe("UP");
  });

  it("emits opportunityDetected for DOWN outcome with DOWN momentum", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-down", "Down", endDate, 97600);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-down", 0.94, 0.96, btcPrice, downMomentum);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].momentum?.direction).toBe("DOWN");
  });

  it("does NOT trigger when midpoint is below threshold", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    // midpoint = (0.90 + 0.94) / 2 = 0.92 < 0.95
    engine.evaluatePrice("token-up", 0.9, 0.94, btcPrice, upMomentum);

    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT trigger when midpoint is above maxEntryPrice ceiling (0.97)", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    // midpoint = (0.97 + 0.99) / 2 = 0.98 > 0.97 maxEntryPrice
    engine.evaluatePrice("token-up", 0.97, 0.99, btcPrice, upMomentum);

    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT trigger when outside trade window", () => {
    const endDate = new Date(Date.now() + 120_000); // 2 minutes away (>60s)
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);

    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT trigger when BTC distance is too small", () => {
    const endDate = new Date(Date.now() + 30_000);
    // Target = 97498, current = 97500 → distance = 2 < minBtcDistanceUsd(7)
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97498);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);

    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT trigger when position limit is reached", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);
    engine.setOpenPositionCount(5); // max positions

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);

    expect(handler).not.toHaveBeenCalled();
  });

  it("does NOT re-trigger for already evaluated tokens", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);
    expect(handler).toHaveBeenCalledOnce();

    engine.evaluatePrice("token-up", 0.97, 0.99, btcPrice, upMomentum);
    expect(handler).toHaveBeenCalledOnce(); // Still only 1 call
  });

  it("resets evaluated tokens for new windows", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);
    expect(handler).toHaveBeenCalledOnce();

    engine.resetForNewWindow();

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("carries BTC distance in opportunity data", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);

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

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);

    expect(handler).not.toHaveBeenCalled();
  });

  it("triggers after updateTargetPrice fills the null target", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, null);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);
    expect(handler).not.toHaveBeenCalled();

    engine.updateTargetPrice("token-up", 97400);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("clearEvaluated allows retry after a failed opportunity attempt", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);
    expect(handler).toHaveBeenCalledOnce();

    engine.clearEvaluated("token-up");

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("updateTargetPrice has no effect on unregistered token", () => {
    expect(() => engine.updateTargetPrice("nonexistent", 97000)).not.toThrow();
  });

  it("unregisterMarket clears evaluated state so token can re-trigger", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);
    expect(handler).toHaveBeenCalledOnce();

    engine.unregisterMarket("token-up");

    engine.registerMarket("market-2", "token-up", "Up", endDate, 97400);
    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  // ── Momentum filter tests ─────────────────────────────────────────────────

  it("BLOCKS UP entry when momentum is DOWN", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, downMomentum);

    expect(handler).not.toHaveBeenCalled();
  });

  it("BLOCKS DOWN entry when momentum is UP", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-down", "Down", endDate, 97600);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-down", 0.96, 0.98, btcPrice, upMomentum);

    expect(handler).not.toHaveBeenCalled();
  });

  it("BLOCKS entry when momentum is NEUTRAL (BTC ranging)", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, neutralMomentum);

    expect(handler).not.toHaveBeenCalled();
  });

  it("BLOCKS entry when momentum has no data (insufficient history)", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, noDataMomentum);

    expect(handler).not.toHaveBeenCalled();
  });

  it("ALLOWS entry when no momentum signal passed (momentum disabled path)", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    // null signal = momentum disabled; should still fire
    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, null);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].momentum).toBeNull();
  });

  it("opportunity includes momentum signal data", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);

    const opp = handler.mock.calls[0][0];
    expect(opp.momentum).not.toBeNull();
    expect(opp.momentum.direction).toBe("UP");
    expect(opp.momentum.changeUsd).toBeGreaterThan(0);
    expect(opp.momentum.hasData).toBe(true);
  });

  // ── Oracle confirmation filter tests ─────────────────────────────────────
  // btcPrice = 97500, minOracleLeadUsd = 50
  // Up bets pass when BTC >= windowStart + 50 → target must be <= 97450
  // Down bets pass when BTC <= windowStart - 50 → target must be >= 97550

  it("ALLOWS Up entry when BTC is 100 USD above window-start (oracle pass)", () => {
    const endDate = new Date(Date.now() + 30_000);
    // target=97400, btcPrice=97500 → oracleLeadUsd=+100 >= +50 ✓
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].oracleLeadUsd).toBeCloseTo(100, 0);
  });

  it("BLOCKS Up entry when BTC is only 20 USD above window-start (oracle fail)", () => {
    const endDate = new Date(Date.now() + 30_000);
    // target=97480, btcPrice=97500 → oracleLeadUsd=+20 < +50 ✗
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97480);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);

    expect(handler).not.toHaveBeenCalled();
  });

  it("BLOCKS Up entry when BTC is BELOW window-start (oracle fail — wrong side)", () => {
    const endDate = new Date(Date.now() + 30_000);
    // target=97600, btcPrice=97500 → oracleLeadUsd=-100 < +50 ✗
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97600);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);

    expect(handler).not.toHaveBeenCalled();
  });

  it("ALLOWS Down entry when BTC is 100 USD below window-start (oracle pass)", () => {
    const endDate = new Date(Date.now() + 30_000);
    // target=97600, btcPrice=97500 → oracleLeadUsd=-100 <= -50 ✓
    engine.registerMarket("market-1", "token-down", "Down", endDate, 97600);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-down", 0.96, 0.98, btcPrice, downMomentum);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].oracleLeadUsd).toBeCloseTo(-100, 0);
  });

  it("BLOCKS Down entry when BTC is only 20 USD below window-start (oracle fail)", () => {
    const endDate = new Date(Date.now() + 30_000);
    // target=97520, btcPrice=97500 → oracleLeadUsd=-20 > -50 ✗
    engine.registerMarket("market-1", "token-down", "Down", endDate, 97520);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-down", 0.96, 0.98, btcPrice, downMomentum);

    expect(handler).not.toHaveBeenCalled();
  });

  it("BLOCKS Down entry when BTC is ABOVE window-start (oracle fail — wrong side)", () => {
    const endDate = new Date(Date.now() + 30_000);
    // target=97400, btcPrice=97500 → oracleLeadUsd=+100 > -50 ✗
    engine.registerMarket("market-1", "token-down", "Down", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-down", 0.96, 0.98, btcPrice, downMomentum);

    expect(handler).not.toHaveBeenCalled();
  });

  it("oracle check passes exacty at the boundary (lead === minOracleLeadUsd)", () => {
    const endDate = new Date(Date.now() + 30_000);
    // target=97450, btcPrice=97500 → oracleLeadUsd=+50 === +50 ✓ (passes >=)
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97450);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);

    expect(handler).toHaveBeenCalledOnce();
  });

  it("opportunity carries oracleLeadUsd in emitted data", () => {
    const endDate = new Date(Date.now() + 30_000);
    engine.registerMarket("market-1", "token-up", "Up", endDate, 97400);

    const handler = vi.fn();
    engine.on("opportunityDetected", handler);

    engine.evaluatePrice("token-up", 0.96, 0.98, btcPrice, upMomentum);

    const opp = handler.mock.calls[0][0];
    expect(typeof opp.oracleLeadUsd).toBe("number");
    expect(opp.oracleLeadUsd).toBeCloseTo(100, 0); // 97500 - 97400
  });
});
