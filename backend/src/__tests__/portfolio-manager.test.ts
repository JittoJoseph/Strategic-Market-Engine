import { describe, it, expect, beforeEach, vi } from "vitest";
import { PortfolioManager } from "../services/portfolio-manager.js";

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
    portfolio: {
      startingCapital: 100,
      budgetDivisor: 5,
      budgetMinUsd: 5,
      budgetMaxUsd: 20,
    },
    logging: { level: "silent" },
    env: "test",
  }),
}));

let portfolioRow: { initialCapital: string; cashBalance: string } | null = null;

vi.mock("../db/client.js", () => ({
  getPortfolio: vi.fn(async () => portfolioRow),
  initPortfolio: vi.fn(async (startingCapital: number) => {
    if (!portfolioRow) {
      portfolioRow = {
        initialCapital: startingCapital.toString(),
        cashBalance: startingCapital.toString(),
      };
    }
    return portfolioRow;
  }),
  updateCashBalance: vi.fn(async (newBalance: string) => {
    if (portfolioRow) {
      portfolioRow.cashBalance = newBalance;
    }
    return portfolioRow;
  }),
}));

describe("PortfolioManager", () => {
  let pm: PortfolioManager;

  beforeEach(async () => {
    portfolioRow = null;
    pm = new PortfolioManager();
    await pm.init();
  });

  it("initialises with correct starting capital", () => {
    expect(pm.getCashBalance()).toBe(100);
    expect(pm.getInitialCapital()).toBe(100);
  });

  it("reload() refreshes from DB", async () => {
    portfolioRow!.cashBalance = "75.50";
    await pm.reload();
    expect(pm.getCashBalance()).toBe(75.5);
  });

  it("reload() throws if portfolio row is missing", async () => {
    portfolioRow = null;
    await expect(pm.reload()).rejects.toThrow("Portfolio row missing");
  });

  it("budget = clamp(totalPortfolioValue / 5, 5, 20)", () => {
    // pv = 100, /5 = 20 → clamped at max 20
    expect(pm.computePositionBudget(0)).toBe(20);
  });

  it("sizes from TOTAL portfolio value (cash + open positions)", () => {
    // pv = 100 + 50 = 150, /5 = 30 → clamped at max 20
    expect(pm.computePositionBudget(50)).toBe(20);
  });

  it("does NOT shrink to available cash — open positions keep budget stable", async () => {
    await pm.deductCash(85); // cash 15
    // pv = 15 cash + 100 open = 115, /5 = 23 → clamp max 20 (NOT capped at cash 15)
    expect(pm.computePositionBudget(100)).toBe(20);
  });

  it("applies the minimum budget when total value is small", async () => {
    await pm.deductCash(90); // cash 10, no open
    // pv = 10, /5 = 2 → clamped up to min 5
    expect(pm.computePositionBudget(0)).toBe(5);
  });

  it("scales with total value between the clamp bounds", async () => {
    await pm.deductCash(50); // cash 50
    // pv = 50, /5 = 10 → within [5,20]
    expect(pm.computePositionBudget(0)).toBe(10);
  });

  it("deductCash reduces balance and persists to DB", async () => {
    const result = await pm.deductCash(19.5);
    expect(result).toBe(true);
    expect(pm.getCashBalance()).toBeCloseTo(80.5, 2);
    expect(portfolioRow!.cashBalance).toBe("80.5");
  });

  it("deductCash rejects when insufficient funds", async () => {
    const result = await pm.deductCash(200);
    expect(result).toBe(false);
    expect(pm.getCashBalance()).toBe(100);
  });

  it("addCash increases balance and persists to DB", async () => {
    await pm.addCash(10.25);
    expect(pm.getCashBalance()).toBeCloseTo(110.25, 2);
    expect(portfolioRow!.cashBalance).toBe("110.25");
  });

  it("handles sequential deduct + add correctly", async () => {
    await pm.deductCash(20); // 80
    await pm.deductCash(15); // 65
    await pm.addCash(5); // 70
    expect(pm.getCashBalance()).toBe(70);
  });

  it("handles tiny amounts with precision", async () => {
    await pm.deductCash(99.999999);
    expect(pm.getCashBalance()).toBeCloseTo(0.000001, 6);
    await pm.addCash(0.000001);
    expect(pm.getCashBalance()).toBeCloseTo(0.000002, 6);
  });
});
