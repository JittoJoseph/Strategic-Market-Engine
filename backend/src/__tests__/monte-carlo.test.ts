import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MonteCarloResult } from "../services/monte-carlo.js";

// Mock logger
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

// In-memory settled trades for testing
let mockTrades: Array<{
  realizedPnl: string | null;
  actualCost: string;
  status: string;
  exitTs: Date | null;
}> = [];

let mockPortfolio: { initialCapital: string; cashBalance: string } | null =
  null;

// Mock DB — select(...).from(...).where(...) is now the full chain (no .orderBy)
vi.mock("../db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(mockTrades),
      }),
    }),
  }),
  getPortfolio: vi.fn(async () => mockPortfolio),
}));

// Mock schema
vi.mock("../db/schema.js", () => ({
  simulatedTrades: {
    status: "status",
    realizedPnl: "realized_pnl",
    actualCost: "actual_cost",
  },
}));

// Mock drizzle-orm operators
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col: any, val: any) => ({ op: "eq", val })),
}));

describe("Monte Carlo Analysis", () => {
  beforeEach(() => {
    mockPortfolio = { initialCapital: "100", cashBalance: "100" };
    mockTrades = [];
  });

  async function importAndRun(overrides?: {
    simulations?: number;
    tradesPerSim?: number;
  }) {
    // Dynamic import to pick up mocks
    const { runMonteCarloAnalysis } =
      await import("../services/monte-carlo.js");
    return runMonteCarloAnalysis(overrides);
  }

  it("throws when no settled trades exist", async () => {
    mockTrades = [];
    await expect(importAndRun()).rejects.toThrow("No settled trades");
  });

  it("correctly classifies wins and losses by realizedPnl", async () => {
    // 6 wins (+$0.05 each), 4 losses (-$0.95 each) → 60% win rate
    mockTrades = [
      ...Array(6)
        .fill(null)
        .map(() => ({
          realizedPnl: "0.05",
          actualCost: "0.95",
          status: "SETTLED",
          exitTs: new Date(),
        })),
      ...Array(4)
        .fill(null)
        .map(() => ({
          realizedPnl: "-0.95",
          actualCost: "0.95",
          status: "SETTLED",
          exitTs: new Date(),
        })),
    ];

    const result = await importAndRun({ simulations: 100, tradesPerSim: 10 });

    expect(result.historical.totalSettled).toBe(10);
    expect(result.historical.wins).toBe(6);
    expect(result.historical.losses).toBe(4);
    expect(result.historical.winRate).toBeCloseTo(60, 0);
  });

  it("computes correct avg win/loss PnL", async () => {
    mockTrades = [
      {
        realizedPnl: "0.10",
        actualCost: "0.90",
        status: "SETTLED",
        exitTs: new Date(),
      },
      {
        realizedPnl: "0.20",
        actualCost: "0.80",
        status: "SETTLED",
        exitTs: new Date(),
      },
      {
        realizedPnl: "-0.50",
        actualCost: "0.95",
        status: "SETTLED",
        exitTs: new Date(),
      },
    ];

    const result = await importAndRun({ simulations: 100, tradesPerSim: 10 });

    // avg win = (0.10 + 0.20) / 2 = 0.15
    expect(result.historical.avgWinPnl).toBeCloseTo(0.15, 4);
    // avg loss = -0.50 / 1 = -0.50
    expect(result.historical.avgLossPnl).toBeCloseTo(-0.5, 4);
  });

  it("computes profit factor correctly", async () => {
    mockTrades = [
      {
        realizedPnl: "0.30",
        actualCost: "0.70",
        status: "SETTLED",
        exitTs: new Date(),
      },
      {
        realizedPnl: "-0.10",
        actualCost: "0.90",
        status: "SETTLED",
        exitTs: new Date(),
      },
    ];

    const result = await importAndRun({ simulations: 100, tradesPerSim: 10 });

    // profit factor = totalWin / |totalLoss| = 0.30 / 0.10 = 3.0
    expect(result.historical.profitFactor).toBeCloseTo(3.0, 1);
  });

  it("generates correct number of histogram buckets", async () => {
    // Need enough trades to run
    mockTrades = Array(20)
      .fill(null)
      .map((_, i) => ({
        realizedPnl: i % 2 === 0 ? "0.05" : "-0.95",
        actualCost: "0.95",
        status: "SETTLED",
        exitTs: new Date(),
      }));

    const result = await importAndRun({ simulations: 500, tradesPerSim: 50 });

    expect(result.distribution.histogram.length).toBe(20); // 20 buckets
    // Sum of all bucket counts should equal # simulations
    const totalCount = result.distribution.histogram.reduce(
      (s, b) => s + b.count,
      0,
    );
    expect(totalCount).toBe(500);
  });

  it("generates 5 percentile equity curves", async () => {
    mockTrades = Array(10)
      .fill(null)
      .map(() => ({
        realizedPnl: "0.05",
        actualCost: "0.95",
        status: "SETTLED",
        exitTs: new Date(),
      }));

    const result = await importAndRun({ simulations: 100, tradesPerSim: 20 });

    expect(result.equityCurves.length).toBe(5);
    expect(result.equityCurves.map((c) => c.percentile)).toEqual([
      5, 25, 50, 75, 95,
    ]);

    // Each curve should have tradesPerSim + 1 points (including starting point)
    for (const curve of result.equityCurves) {
      expect(curve.curve.length).toBe(21); // 20 trades + starting point
      expect(curve.curve[0]!.tradeIndex).toBe(0);
      expect(curve.curve[0]!.balance).toBe(100); // starting capital
    }
  });

  it("percentile ordering is correct (P5 final < P95 final)", async () => {
    mockTrades = [
      ...Array(7)
        .fill(null)
        .map(() => ({
          realizedPnl: "0.05",
          actualCost: "0.95",
          status: "SETTLED",
          exitTs: new Date(),
        })),
      ...Array(3)
        .fill(null)
        .map(() => ({
          realizedPnl: "-0.95",
          actualCost: "0.95",
          status: "SETTLED",
          exitTs: new Date(),
        })),
    ];

    const result = await importAndRun({ simulations: 1000, tradesPerSim: 50 });

    const p5Final = result.equityCurves
      .find((c) => c.percentile === 5)!
      .curve.at(-1)!.balance;
    const p95Final = result.equityCurves
      .find((c) => c.percentile === 95)!
      .curve.at(-1)!.balance;

    expect(p5Final).toBeLessThan(p95Final);
  });

  it("drawdown percentiles are ordered", async () => {
    mockTrades = Array(10)
      .fill(null)
      .map((_, i) => ({
        realizedPnl: i % 3 === 0 ? "-0.50" : "0.10",
        actualCost: "0.90",
        status: "SETTLED",
        exitTs: new Date(),
      }));

    const result = await importAndRun({ simulations: 1000, tradesPerSim: 30 });

    expect(result.drawdown.median).toBeLessThanOrEqual(result.drawdown.p95);
    expect(result.drawdown.p95).toBeLessThanOrEqual(result.drawdown.worst);
  });

  it("profit probability is 100% when all trades are winners", async () => {
    mockTrades = Array(10)
      .fill(null)
      .map(() => ({
        realizedPnl: "0.05",
        actualCost: "0.95",
        status: "SETTLED",
        exitTs: new Date(),
      }));

    const result = await importAndRun({ simulations: 500, tradesPerSim: 20 });

    expect(result.distribution.profitProbability).toBe(100);
  });

  it("uses startingCapital from portfolio", async () => {
    mockPortfolio = { initialCapital: "250", cashBalance: "200" };
    mockTrades = Array(5)
      .fill(null)
      .map(() => ({
        realizedPnl: "0.05",
        actualCost: "0.95",
        status: "SETTLED",
        exitTs: new Date(),
      }));

    const result = await importAndRun({ simulations: 100, tradesPerSim: 10 });

    expect(result.startingCapital).toBe(250);
  });

  it("uses realizedPnl not exitOutcome to determine win/loss", async () => {
    // Stop-loss that sold above entry — exitOutcome would be LOSS but pnl is positive
    mockTrades = [
      {
        realizedPnl: "0.02",
        actualCost: "0.95",
        status: "SETTLED",
        exitTs: new Date(),
      },
    ];

    const result = await importAndRun({ simulations: 100, tradesPerSim: 10 });

    // Even though this might have exitOutcome=LOSS, we classify by PnL > 0 → win
    expect(result.historical.wins).toBe(1);
    expect(result.historical.losses).toBe(0);
  });

  it("respects simulation count limits", async () => {
    mockTrades = Array(5)
      .fill(null)
      .map(() => ({
        realizedPnl: "0.05",
        actualCost: "0.95",
        status: "SETTLED",
        exitTs: new Date(),
      }));

    const result = await importAndRun({ simulations: 200, tradesPerSim: 30 });

    expect(result.config.simulations).toBe(200);
    expect(result.config.tradesPerSim).toBe(30);
  });
});
