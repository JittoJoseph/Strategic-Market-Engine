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
    portfolio: { startingCapital: 100, slots: 5 },
    logging: { level: "silent" },
    env: "test",
  }),
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

  // ── Position sizing ──────────────────────────────────────────

  it("computes budget = portfolioValue / slots", () => {
    // Portfolio value = 100 cash + 0 open = 100, slots = 5 → budget = 20
    const budget = pm.computePositionBudget(0);
    expect(budget).toBe(20);
  });

  it("includes open positions value in sizing", () => {
    // cash=100, open positions worth $50 → portfolio = 150, budget = 30
    const budget = pm.computePositionBudget(50);
    expect(budget).toBe(30);
  });

  it("caps budget at available cash", async () => {
    // Reduce cash to $15
    await pm.deductCash(85);
    expect(pm.getCashBalance()).toBe(15);

    // Portfolio = 15 cash + 100 open = 115, budget = 23, but capped at cash (15)
    const budget = pm.computePositionBudget(100);
    expect(budget).toBe(15);
  });

  it("clamps budget up to $1 when portfolioValue/slots is below $1", async () => {
    // cash=$4.86, 5 slots → raw slice = $0.972 → clamped to $1, cash ≥ $1 → returns $1
    await pm.deductCash(95.14);
    expect(pm.getCashBalance()).toBeCloseTo(4.86, 2);
    const budget = pm.computePositionBudget(0);
    expect(budget).toBe(1);
  });

  it("returns 0 when cash is below $1", async () => {
    // cash=$0.50 — can't fund even the $1 minimum
    await pm.deductCash(99.5);
    const budget = pm.computePositionBudget(0);
    expect(budget).toBe(0);
  });

  it("returns 0 when cash < $1 even if portfolio value is high", async () => {
    await pm.deductCash(99.5);
    // Portfolio = 0.5 cash + 100 positions = 100.5, but cash < $1 → blocked
    const budget = pm.computePositionBudget(100);
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
