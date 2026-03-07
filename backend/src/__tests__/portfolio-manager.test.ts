import { describe, it, expect, beforeEach, vi } from "vitest";
import { PortfolioManager } from "../services/portfolio-manager.js";

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

// Mock config
vi.mock("../utils/config.js", () => ({
  getConfig: () => ({
    portfolio: { startingCapital: 100 },
    strategy: { maxSimultaneousPositions: 5 },
    logging: { level: "silent" },
    env: "test",
  }),
}));

// Mock calculateFeePerShare (avoid circular dep issues in tests)
vi.mock("../services/execution-simulator.js", () => ({
  calculateFeePerShare: (price: number) => {
    // Simplified: crypto fee = 0.25 * (p*(1-p))^2
    const pq = price * (1 - price);
    return Math.round(0.25 * Math.pow(pq, 2) * 10000) / 10000;
  },
}));

// Mock DB — in-memory single portfolio row
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
    portfolioRow = null; // Reset DB
    pm = new PortfolioManager();
    await pm.init();
  });

  // ── Initialization ──────────────────────────────────────────

  it("initialises with correct starting capital", () => {
    expect(pm.getCashBalance()).toBe(100);
    expect(pm.getInitialCapital()).toBe(100);
  });

  it("reload() refreshes from DB", async () => {
    // Simulate external DB update
    portfolioRow!.cashBalance = "75.50";
    await pm.reload();
    expect(pm.getCashBalance()).toBe(75.5);
  });

  it("reload() throws if portfolio row is missing", async () => {
    portfolioRow = null;
    await expect(pm.reload()).rejects.toThrow("Portfolio row missing");
  });

  // ── Position sizing (share-based minimum) ─────────────────────

  // Fee at bestAsk=0.95: pq=0.95*0.05=0.0475, fee=0.25*(0.0475)^2≈0.0006
  // costPerShare = 0.95 + 0.0006 = 0.9506
  // minBudget = 0.9506 * 5 = 4.753

  it("computes budget = portfolioValue / slots", () => {
    // Portfolio value = 100 cash + 0 open = 100, slots = 5 → raw = 20
    // max(20, 4.753) = 20, capped at cash(100) → 20
    const budget = pm.computePositionBudget(0, 0.95);
    expect(budget).toBe(20);
  });

  it("includes open positions value in sizing", () => {
    // cash=100, open positions worth $50 → portfolio = 150, raw = 30
    // max(30, 4.753) = 30, capped at cash(100) → 30
    const budget = pm.computePositionBudget(50, 0.95);
    expect(budget).toBe(30);
  });

  it("caps budget at available cash", async () => {
    // Reduce cash to $15
    await pm.deductCash(85);
    expect(pm.getCashBalance()).toBe(15);

    // Portfolio = 15 cash + 100 open = 115, raw = 23
    // max(23, 4.753) = 23, capped at cash(15) → 15
    const budget = pm.computePositionBudget(100, 0.95);
    expect(budget).toBe(15);
  });

  it("uses share-based minimum when raw slice is tiny", async () => {
    // cash=$4.86, portfolio=4.86, raw=0.972
    // minBudget=4.753, max(0.972, 4.753)=4.753, cash(4.86)≥4.753 → 4.753
    await pm.deductCash(95.14);
    expect(pm.getCashBalance()).toBeCloseTo(4.86, 2);
    const budget = pm.computePositionBudget(0, 0.95);
    expect(budget).toBe(4.753);
  });

  it("returns 0 when cash is below share-based minimum", async () => {
    // cash=$0.50, minBudget=4.753, cash < minBudget → 0
    await pm.deductCash(99.5);
    const budget = pm.computePositionBudget(0, 0.95);
    expect(budget).toBe(0);
  });

  it("returns 0 when cash < minimum even if portfolio value is high", async () => {
    await pm.deductCash(99.5);
    // cash=0.5, minBudget=4.753, cash < minBudget → 0
    const budget = pm.computePositionBudget(100, 0.95);
    expect(budget).toBe(0);
  });

  // ── Cash mutations ───────────────────────────────────────────

  it("deductCash reduces balance and persists to DB", async () => {
    const result = await pm.deductCash(19.5);
    expect(result).toBe(true);
    expect(pm.getCashBalance()).toBeCloseTo(80.5, 2);
    expect(portfolioRow!.cashBalance).toBe("80.5");
  });

  it("deductCash rejects when insufficient funds", async () => {
    const result = await pm.deductCash(200);
    expect(result).toBe(false);
    expect(pm.getCashBalance()).toBe(100); // Unchanged
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
