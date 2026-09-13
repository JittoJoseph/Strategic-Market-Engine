import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../utils/logger.js", () => {
  const noop = () => {};
  const childLogger = {
    info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop,
    child: () => childLogger,
  };
  return { createModuleLogger: () => childLogger, getLogger: () => childLogger };
});

const strategyConfig = {
  entryWindowOpenSeconds: 120,
  entryWindowCloseSeconds: 10,
  minEntryPrice: 0.15,
  maxEntryPrice: 0.7,
  flowMinPrintShares: 50,
  flowBurstMs: 3_000,
  flowMinPrints: 2,
  vetoSdMultiple: 3,
  sigmaWindowMs: 180_000,
  maxRawStalenessMs: 5_000,
  stopLossFraction: 0.35,
  scanIntervalMs: 60_000,
  executionLatencyMs: 50,
  marketLivenessMs: 120_000,
};

vi.mock("../utils/config.js", () => ({
  getConfig: () => ({ strategy: strategyConfig }),
}));

const NOW = 1_800_000_000_000;
vi.mock("../services/market-clock.js", () => ({ marketNow: () => NOW }));

const { StrategyEngine } = await import("../services/strategy-engine.js");
const { forecastSettlement, rollingOutRange } = await import(
  "../services/settlement-model.js"
);

const PRICE = 100_000;
const END = NOW + 60_000;

function makeForecast(opts: {
  rawNow: number;
  rollingOutMean?: number;
  strike?: number;
  endMs?: number;
  rawSigma?: number;
}) {
  return forecastSettlement({
    anchorMs: NOW,
    endMs: opts.endMs ?? END,
    strike: opts.strike ?? PRICE,
    twapNow: PRICE,
    rawNow: opts.rawNow,
    rollingOutMean: opts.rollingOutMean ?? PRICE,
    rawSigma: opts.rawSigma ?? 2,
  })!;
}

describe("forecastSettlement", () => {
  it("expects spot when the whole averaging window is still ahead", () => {
    const f = makeForecast({ rawNow: PRICE + 40, endMs: NOW + 300_000 });
    expect(f.expected).toBeCloseTo(PRICE + 40, 6);
  });

  it("inside the final minute only the leaving stretch moves the average", () => {
    const f = makeForecast({ rawNow: PRICE + 60, rollingOutMean: PRICE, endMs: NOW + 30_000 });
    expect(f.expected).toBeCloseTo(PRICE + 30, 6);
  });

  it("signs the z-score by the side the margin favours", () => {
    expect(makeForecast({ rawNow: PRICE + 200 }).zScore).toBeGreaterThan(0);
    expect(makeForecast({ rawNow: PRICE - 200 }).zScore).toBeLessThan(0);
  });

  it("sd shrinks as the window closes", () => {
    const far = makeForecast({ rawNow: PRICE, endMs: NOW + 60_000 });
    const near = makeForecast({ rawNow: PRICE, endMs: NOW + 10_000 });
    expect(near.sd).toBeLessThan(far.sd);
  });

  it("returns null once the window has ended", () => {
    expect(
      forecastSettlement({
        anchorMs: NOW, endMs: NOW, strike: PRICE, twapNow: PRICE, rawNow: PRICE,
        rollingOutMean: PRICE, rawSigma: 2,
      }),
    ).toBeNull();
  });
});

describe("rollingOutRange", () => {
  it("covers the tau seconds that leave the average, ending in the past", () => {
    const { fromMs, toMs } = rollingOutRange(NOW, NOW + 30_000);
    expect(fromMs).toBe(NOW - 60_000);
    expect(toMs).toBe(NOW - 30_000);
  });

  it("never asks for more than the lookback", () => {
    const { fromMs, toMs } = rollingOutRange(NOW, NOW + 300_000);
    expect(toMs - fromMs).toBe(60_000);
  });
});

describe("StrategyEngine", () => {
  let engine: InstanceType<typeof StrategyEngine>;
  const UP = "token-up";
  const DOWN = "token-down";

  beforeEach(() => {
    engine = new StrategyEngine();
    engine.registerMarket("m1", UP, "Up", new Date(END), PRICE);
    engine.registerMarket("m1", DOWN, "Down", new Date(END), PRICE);
    engine.updateForecast("m1", makeForecast({ rawNow: PRICE }));
    engine.updateQuote(UP, 0.5, 0.52);
    engine.updateQuote(DOWN, 0.46, 0.48);
  });

  it("buys behind two large prints on the same side inside the burst window", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    expect(engine.noteTrade(UP, "BUY", 60, NOW - 2_000)).toBeNull();
    const evaluation = engine.noteTrade(UP, "BUY", 80, NOW - 500);
    expect(evaluation?.skipReason).toBeNull();
    expect(handler).toHaveBeenCalledOnce();
    const opp = handler.mock.calls[0]![0];
    expect(opp.outcomeLabel).toBe("Up");
    expect(opp.bestAsk).toBe(0.52);
    expect(opp.burst.prints).toBe(2);
    expect(opp.burst.shares).toBe(140);
  });

  it("ignores prints below the size threshold", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.noteTrade(UP, "BUY", 49, NOW - 2_000);
    engine.noteTrade(UP, "BUY", 49, NOW - 1_000);
    engine.noteTrade(UP, "BUY", 49, NOW - 500);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a lone large print is not a burst", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    expect(engine.noteTrade(UP, "BUY", 500, NOW - 500)).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it("prints outside the burst window do not count", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.noteTrade(UP, "BUY", 60, NOW - 10_000);
    expect(engine.noteTrade(UP, "BUY", 60, NOW - 500)).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it("prints on opposite sides do not form a burst", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.noteTrade(UP, "BUY", 60, NOW - 2_000);
    expect(engine.noteTrade(DOWN, "BUY", 60, NOW - 500)).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it("a taker selling Up is flow toward Down", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.noteTrade(UP, "SELL", 60, NOW - 2_000);
    const evaluation = engine.noteTrade(DOWN, "BUY", 60, NOW - 500);
    expect(evaluation?.outcomeLabel).toBe("Down");
    expect(evaluation?.skipReason).toBeNull();
    expect(handler.mock.calls[0]![0].tokenId).toBe(DOWN);
  });

  it("never buys a side the forecast is confidently against", () => {
    engine.updateForecast("m1", makeForecast({ rawNow: PRICE - 600 }));
    engine.noteTrade(UP, "BUY", 60, NOW - 2_000);
    expect(engine.noteTrade(UP, "BUY", 60, NOW - 500)?.skipReason).toBe("model_opposes");
  });

  it("a mild lean against the flow is not a veto", () => {
    engine.updateForecast("m1", makeForecast({ rawNow: PRICE - 5 }));
    engine.noteTrade(UP, "BUY", 60, NOW - 2_000);
    expect(engine.noteTrade(UP, "BUY", 60, NOW - 500)?.skipReason).toBeNull();
  });

  it("skips when no forecast is available", () => {
    engine.registerMarket("m2", "t2u", "Up", new Date(END), PRICE);
    engine.registerMarket("m2", "t2d", "Down", new Date(END), PRICE);
    engine.updateQuote("t2u", 0.5, 0.52);
    engine.noteTrade("t2u", "BUY", 60, NOW - 2_000);
    expect(engine.noteTrade("t2u", "BUY", 60, NOW - 500)?.skipReason).toBe("no_forecast");
  });

  it("skips an ask above the cap", () => {
    engine.updateQuote(UP, 0.8, 0.82);
    engine.noteTrade(UP, "BUY", 60, NOW - 2_000);
    expect(engine.noteTrade(UP, "BUY", 60, NOW - 500)?.skipReason).toBe("price_band");
  });

  it("skips an ask below the floor", () => {
    engine.updateQuote(UP, 0.05, 0.1);
    engine.noteTrade(UP, "BUY", 60, NOW - 2_000);
    expect(engine.noteTrade(UP, "BUY", 60, NOW - 500)?.skipReason).toBe("price_band");
  });

  it("skips when no quote has arrived", () => {
    engine.registerMarket("m3", "t3u", "Up", new Date(END), PRICE);
    engine.registerMarket("m3", "t3d", "Down", new Date(END), PRICE);
    engine.updateForecast("m3", makeForecast({ rawNow: PRICE }));
    engine.noteTrade("t3u", "BUY", 60, NOW - 2_000);
    expect(engine.noteTrade("t3u", "BUY", 60, NOW - 500)?.skipReason).toBe("quote_missing");
  });

  it("skips a market with no strike", () => {
    engine.registerMarket("m4", "t4u", "Up", new Date(END), null);
    engine.registerMarket("m4", "t4d", "Down", new Date(END), null);
    engine.updateForecast("m4", makeForecast({ rawNow: PRICE }));
    engine.updateQuote("t4u", 0.5, 0.52);
    engine.noteTrade("t4u", "BUY", 60, NOW - 2_000);
    expect(engine.noteTrade("t4u", "BUY", 60, NOW - 500)?.skipReason).toBe("no_strike");
  });

  it("skips a market whose last fill is too old", () => {
    engine.noteTrade(UP, "BUY", 60, NOW - 200_000);
    engine.noteTrade(UP, "BUY", 60, NOW - 199_000);
    engine.noteTrade(UP, "BUY", 60, NOW - 198_000);
    // burst formed in the past; the market has been silent since
    engine.registerMarket("m5", "t5u", "Up", new Date(END), PRICE);
    engine.registerMarket("m5", "t5d", "Down", new Date(END), PRICE);
    engine.updateForecast("m5", makeForecast({ rawNow: PRICE }));
    engine.updateQuote("t5u", 0.5, 0.52);
    engine.noteTrade("t5u", "BUY", 60, NOW - 130_000);
    expect(engine.noteTrade("t5u", "BUY", 60, NOW - 129_000)?.skipReason).toBe("market_stale");
  });

  it("reports outside the entry window without consuming the market", () => {
    engine.registerMarket("m6", "t6u", "Up", new Date(NOW + 600_000), PRICE);
    engine.registerMarket("m6", "t6d", "Down", new Date(NOW + 600_000), PRICE);
    engine.updateForecast("m6", makeForecast({ rawNow: PRICE, endMs: NOW + 600_000 }));
    engine.updateQuote("t6u", 0.5, 0.52);
    engine.noteTrade("t6u", "BUY", 60, NOW - 2_000);
    expect(engine.noteTrade("t6u", "BUY", 60, NOW - 500)?.skipReason).toBe("outside_entry_window");
    expect(engine.getStats().tradedMarkets).toBe(0);
  });

  it("trades a market only once", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.noteTrade(UP, "BUY", 60, NOW - 2_000);
    engine.noteTrade(UP, "BUY", 60, NOW - 1_500);
    engine.noteTrade(UP, "BUY", 60, NOW - 1_000);
    expect(engine.noteTrade(UP, "BUY", 60, NOW - 500)).toBeNull();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("release lets a market be traded again", () => {
    const handler = vi.fn();
    engine.on("opportunityDetected", handler);
    engine.noteTrade(UP, "BUY", 60, NOW - 2_000);
    engine.noteTrade(UP, "BUY", 60, NOW - 1_500);
    engine.releaseMarket("m1");
    engine.noteTrade(UP, "BUY", 60, NOW - 1_000);
    engine.noteTrade(UP, "BUY", 60, NOW - 500);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  describe("reset", () => {
    it("forgets registered markets and unblocks traded ones", () => {
      const handler = vi.fn();
      engine.on("opportunityDetected", handler);
      engine.noteTrade(UP, "BUY", 60, NOW - 2_000);
      engine.noteTrade(UP, "BUY", 60, NOW - 1_500);
      engine.reset();
      expect(engine.noteTrade(UP, "BUY", 60, NOW - 1_000)).toBeNull();

      engine.registerMarket("m1", UP, "Up", new Date(END), PRICE);
      engine.registerMarket("m1", DOWN, "Down", new Date(END), PRICE);
      engine.updateForecast("m1", makeForecast({ rawNow: PRICE }));
      engine.updateQuote(UP, 0.5, 0.52);
      engine.noteTrade(UP, "BUY", 60, NOW - 1_000);
      engine.noteTrade(UP, "BUY", 60, NOW - 500);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(engine.getStats().tradedMarkets).toBe(1);
    });
  });
});
