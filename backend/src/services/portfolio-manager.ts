import Decimal from "decimal.js";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import { calculateFeePerShare } from "./execution-simulator.js";
import { POLYMARKET_MIN_ORDER_SIZE } from "../types/index.js";
import {
  getPortfolio,
  initPortfolio,
  updateCashBalance,
} from "../db/client.js";

const logger = createModuleLogger("portfolio-manager");

/**
 * PortfolioManager
 *
 * Tracks the simulated portfolio's cash balance and computes position sizes.
 *
 * Key rules:
 * - Position sizing = portfolioValue / maxPositions
 * - portfolioValue = cash + sum of open positions at current price
 * - Only the *actual fill cost* (shares × avgPrice + fees) is deducted from cash
 * - Budget is always sized at maxEntryPrice (worst-case we'd accept), so even
 *   if entering at a lower price the budget can absorb fills up to the limit
 * - Minimum position: POLYMARKET_MIN_ORDER_SIZE shares (protocol-level = 5)
 * - Cash balance is persisted in DB so it survives restarts
 */
export class PortfolioManager {
  private cashBalance: Decimal = new Decimal(0);
  private initialCapital: Decimal = new Decimal(0);

  /** Initialise from DB or create fresh portfolio row. */
  async init(): Promise<void> {
    const config = getConfig();
    const portfolio = await initPortfolio(config.portfolio.startingCapital);
    if (!portfolio) {
      throw new Error("Failed to initialise portfolio row");
    }
    this.cashBalance = new Decimal(portfolio.cashBalance);
    this.initialCapital = new Decimal(portfolio.initialCapital);
    logger.info(
      {
        initialCapital: this.initialCapital.toString(),
        cashBalance: this.cashBalance.toString(),
        maxPositions: config.strategy.maxSimultaneousPositions,
      },
      "Portfolio initialised",
    );
  }

  /** Reload cash balance from DB (e.g. after a wipe). */
  async reload(): Promise<void> {
    const portfolio = await getPortfolio();
    if (!portfolio) {
      throw new Error("Portfolio row missing — call init() first");
    }
    this.cashBalance = new Decimal(portfolio.cashBalance);
    this.initialCapital = new Decimal(portfolio.initialCapital);
  }

  // ── Getters ──────────────────────────────────────────────────

  getCashBalance(): number {
    return this.cashBalance.toNumber();
  }

  getInitialCapital(): number {
    return this.initialCapital.toNumber();
  }

  // ── Position sizing ──────────────────────────────────────────

  computePositionBudget(openPositionsValue: number): number {
    const config = getConfig();
    const budget = new Decimal(config.strategy.allocationPerSide);

    // If we can't even afford the fixed budget, skip
    if (this.cashBalance.lt(budget)) {
      logger.warn(
        {
          cash: this.cashBalance.toString(),
          requiredBudget: budget.toString(),
        },
        `Insufficient cash for fixed allocation — skipping`,
      );
      return 0;
    }

    return budget.toDP(8).toNumber();
  }

  // ── Cash mutations ───────────────────────────────────────────

  /**
   * Deduct the actual fill cost from cash after a buy is executed.
   * Returns false if there's not enough cash (shouldn't happen if
   * computePositionBudget was called first, but defensive).
   */
  async deductCash(amount: number): Promise<boolean> {
    const dec = new Decimal(amount);
    if (dec.gt(this.cashBalance)) {
      logger.error(
        { requested: dec.toString(), available: this.cashBalance.toString() },
        "Attempted to deduct more cash than available",
      );
      return false;
    }
    this.cashBalance = this.cashBalance.minus(dec);
    await updateCashBalance(this.cashBalance.toString());
    logger.debug(
      { deducted: dec.toString(), remaining: this.cashBalance.toString() },
      "Cash deducted",
    );
    return true;
  }

  /**
   * Add cash back after a position is resolved (win payout or stop-loss sell).
   */
  async addCash(amount: number): Promise<void> {
    const dec = new Decimal(amount);
    this.cashBalance = this.cashBalance.plus(dec);
    await updateCashBalance(this.cashBalance.toString());
    logger.debug(
      { added: dec.toString(), newBalance: this.cashBalance.toString() },
      "Cash added",
    );
  }
}
