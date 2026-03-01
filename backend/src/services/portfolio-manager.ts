import Decimal from "decimal.js";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
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
 * - Position sizing = portfolioValue / slots   (not cash / slots)
 * - portfolioValue = cash + sum of open positions at current price
 * - Only the *actual fill cost* (shares × avgPrice + fees) is deducted from cash
 * - Minimum position size: $1
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
        slots: config.portfolio.slots,
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

  /**
   * Compute the budget for the next position.
   *
   * Sizing = portfolioValue / slots, floored at the $1 minimum.
   *
   * Rationale: if portfolioValue is $4.86 and slots=5, the raw slice is $0.97
   * which is below $1 — but we still *want* to trade, just at the $1 floor.
   * This way the system can still open up to 4 positions (spending $1 each)
   * before cash drops below the $1 minimum and new entries are blocked.
   *
   * @param openPositionsValue  Sum of actualCost for all OPEN trades
   * @returns Budget in USD, or 0 if cash is below the $1 minimum
   */
  computePositionBudget(openPositionsValue: number): number {
    const config = getConfig();
    const portfolioValue = this.cashBalance.plus(openPositionsValue);
    const rawBudget = portfolioValue.div(config.portfolio.slots);

    // Floor at $1: if the equal-share slice is below $1, still use $1 so that
    // we keep entering trades until we genuinely can't afford one.
    const budget = Decimal.max(rawBudget, new Decimal(1));

    // If we don't even have $1 in cash, we truly can't open a new position.
    if (this.cashBalance.lt(1)) {
      logger.warn(
        { cash: this.cashBalance.toString(), budget: budget.toString() },
        "Insufficient cash for minimum $1 position — skipping",
      );
      return 0;
    }

    // Don't spend more than available cash.
    const capped = Decimal.min(budget, this.cashBalance);
    return capped.toDP(8).toNumber();
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
