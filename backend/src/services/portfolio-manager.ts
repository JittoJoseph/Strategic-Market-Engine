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
 * - Position sizing = portfolioValue / slots   (not cash / slots)
 * - portfolioValue = cash + sum of open positions at current price
 * - Only the *actual fill cost* (shares × avgPrice + fees) is deducted from cash
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

  /**
   * Compute the budget for the next position.
   *
   * Share-based sizing (matching Polymarket's min_order_size):
   *   rawBudget  = portfolioValue / maxSimultaneousPositions
   *   minBudget  = POLYMARKET_MIN_ORDER_SIZE × (bestAskPrice + fee_per_share)
   *   budget     = max(rawBudget, minBudget)  — ensure at least min order size
   *   if cash < minBudget → return 0 (can't afford minimum order)
   *   cap at cashBalance
   *
   * @param openPositionsValue  Sum of actualCost for all OPEN trades
   * @param bestAskPrice        Current best ask price for the target token
   * @returns Budget in USD, or 0 if cash can't cover the minimum share count
   */
  computePositionBudget(
    openPositionsValue: number,
    bestAskPrice: number,
  ): number {
    const config = getConfig();
    const minShares = POLYMARKET_MIN_ORDER_SIZE;
    const portfolioValue = this.cashBalance.plus(openPositionsValue);
    const rawBudget = portfolioValue.div(
      config.strategy.maxSimultaneousPositions,
    );

    // Cost of the minimum share count at current best ask (including taker fee)
    const feePerShare = calculateFeePerShare(bestAskPrice);
    const costPerShare = new Decimal(bestAskPrice).plus(feePerShare);
    const minBudget = costPerShare.mul(minShares);

    // Use whichever is larger: the equal-share slice or the minimum-shares cost
    const budget = Decimal.max(rawBudget, minBudget);

    // If we can't even afford the minimum shares, skip
    if (this.cashBalance.lt(minBudget)) {
      logger.warn(
        {
          cash: this.cashBalance.toString(),
          minBudget: minBudget.toString(),
          minShares,
          bestAskPrice,
        },
        `Insufficient cash for ${minShares}-share minimum — skipping`,
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
