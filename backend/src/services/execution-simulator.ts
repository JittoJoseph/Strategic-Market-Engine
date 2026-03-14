import { createModuleLogger } from "../utils/logger.js";
import { CRYPTO_FEE, type Orderbook } from "../types/index.js";
import Decimal from "decimal.js";

const logger = createModuleLogger("execution-simulator");

/** Top-N snapshot of an orderbook for audit / display purposes. */
function snapshotOrderbook(orderbook: Orderbook, depth = 5) {
  return {
    bids: orderbook.bids.slice(0, depth),
    asks: orderbook.asks.slice(0, depth),
    tick_size: orderbook.tick_size,
    timestamp: orderbook.timestamp,
  };
}

/** Result of a simulated FAK (Fill-And-Kill) order fill */
export interface ExecutionResult {
  averagePrice: number;
  totalShares: number;
  totalCost: number; // USD spent (before fees)
  fees: number; // Taker fee in USD
  netCost: number; // totalCost + fees
  /** True when budget remains after exhausting all eligible ask levels */
  isPartialFill: boolean;
  /** True when filled shares < orderbook min_order_size (Polymarket would reject this) */
  belowMinimumOrderSize: boolean;
  /** The min_order_size from the orderbook (default 5) */
  minOrderSize: number;
  fillDetails: FillDetail[];
  orderbookSnapshot: unknown;
}

interface FillDetail {
  price: number;
  shares: number;
  cost: number;
  feeForLevel: number;
}

/**
 * Simulates a FAK (Fill-And-Kill) taker BUY order execution.
 *
 * Walks the ask side of the live CLOB orderbook, filling shares at each price
 * level up to the limit price, respecting available depth (size) at each level.
 * Any unfilled budget is "killed" (returned unused) — matching Polymarket's
 * FAK order semantics for time-sensitive entries.
 *
 * After filling, enforces the orderbook's `min_order_size` (typically 5 shares).
 * If the total filled shares fall below this minimum, the result is flagged
 * with `belowMinimumOrderSize: true` — Polymarket would reject this order.
 *
 * Fee formula for crypto markets (Polymarket docs):
 *   fee_per_share = 0.25 × (p × (1-p))^2
 * At p=0.97: fee_per_share ≈ 0.000212 USDC (effective ~0.02%)
 *
 * @param orderbook   Live CLOB orderbook snapshot (includes asks with price+size)
 * @param usdAmount   USDC budget for this order
 * @param limitPrice  Maximum price we are willing to pay per share
 */
export function simulateLimitBuy(
  orderbook: Orderbook,
  usdAmount: number,
  limitPrice: number,
): ExecutionResult {
  // Sort asks by price ascending (best first)
  const asks = [...orderbook.asks].sort(
    (a, b) => parseFloat(a.price) - parseFloat(b.price),
  );

  const fillDetails: FillDetail[] = [];
  let remainingUsd = new Decimal(usdAmount);
  let totalShares = new Decimal(0);
  let totalCost = new Decimal(0);
  let totalFees = new Decimal(0);

  for (const level of asks) {
    if (remainingUsd.lte(0)) break;

    const askPrice = parseFloat(level.price);
    const askSize = parseFloat(level.size);

    // Only fill at prices at or below our limit price
    if (askPrice > limitPrice) break;

    // Calculate how many shares we can buy at this level
    const feePerShare = calculateFeePerShare(askPrice);
    const costPerShare = new Decimal(askPrice).plus(feePerShare);

    // Max shares we can afford at this level
    const maxSharesByBudget = remainingUsd.div(costPerShare).toNumber();
    const sharesToFill = Math.min(maxSharesByBudget, askSize);

    if (sharesToFill <= 0) continue;

    const shares = new Decimal(sharesToFill);
    const cost = shares.mul(askPrice);
    const fee = shares.mul(feePerShare);

    totalShares = totalShares.plus(shares);
    totalCost = totalCost.plus(cost);
    totalFees = totalFees.plus(fee);
    remainingUsd = remainingUsd.minus(cost).minus(fee);

    fillDetails.push({
      price: askPrice,
      shares: sharesToFill,
      cost: cost.toNumber(),
      feeForLevel: fee.toNumber(),
    });
  }

  // Partial fill = budget remaining after walking all eligible asks
  const isPartialFill = remainingUsd.gt(0) && totalShares.gt(0);
  const avgPrice = totalShares.gt(0)
    ? totalCost.div(totalShares).toNumber()
    : 0;

  // Round fees to 4 decimal places (Polymarket precision)
  const roundedFees = Math.round(totalFees.toNumber() * 10000) / 10000;

  // Enforce Polymarket's min_order_size (default 5 shares)
  const minOrderSize = parseFloat(orderbook.min_order_size ?? "5") || 5;
  const belowMinimumOrderSize =
    totalShares.gt(0) && totalShares.lt(minOrderSize);

  if (totalShares.gt(0)) {
    logger.debug(
      {
        avgPrice: avgPrice.toFixed(6),
        shares: totalShares.toNumber().toFixed(4),
        cost: totalCost.toNumber().toFixed(4),
        fees: roundedFees.toFixed(4),
        levels: fillDetails.length,
        partial: isPartialFill,
        belowMin: belowMinimumOrderSize,
        minOrderSize,
      },
      "FAK buy simulated",
    );
  }

  return {
    averagePrice: avgPrice,
    totalShares: totalShares.toNumber(),
    totalCost: totalCost.toNumber(),
    fees: roundedFees,
    netCost: totalCost.toNumber() + roundedFees,
    isPartialFill,
    belowMinimumOrderSize,
    minOrderSize,
    fillDetails,
    orderbookSnapshot: snapshotOrderbook(orderbook),
  };
}

/**
 * Calculate fee per share using Polymarket's documented formula for crypto markets.
 *
 * Formula (from Polymarket docs):
 *   fee_per_share = feeRate × (p × (1-p))^exponent
 * Where:
 *   feeRate  = 0.25   (CRYPTO_FEE.RATE)
 *   exponent = 2      (CRYPTO_FEE.EXPONENT)
 *   p        = share price (0–1)
 *
 * The fee approaches ZERO at price extremes and peaks at ~1.56% at p=0.50.
 * At our typical entry price of p≈0.97:
 *   fee_per_share = 0.25 × (0.97 × 0.03)^2 = 0.25 × 0.000847 ≈ 0.000212 USDC/share
 *   (~0.02% effective rate — nearly free)
 *
 * Maker rebate: in real limit orders the maker receives 20% of the fee back.
 * This simulation conservatively models taker fees (no rebate), which slightly
 * overstates costs at our near-extreme entry prices.
 *
 * Fees are rounded to 4 decimal places (smallest fee unit: 0.0001 USDC).
 */
export function calculateFeePerShare(price: number): number {
  const feeRate = CRYPTO_FEE.RATE; // 0.25 for crypto
  const exponent = CRYPTO_FEE.EXPONENT; // 2
  const pq = price * (1 - price); // p × (1-p), maximised at p=0.5
  const fee = feeRate * Math.pow(pq, exponent);

  // Round to 4 decimal places (Polymarket precision; sub-0.0001 rounds to 0)
  return Math.round(fee * 10000) / 10000;
}

// ============================================
// Sell simulation (for stop-loss / early exit)
// ============================================

/** Result of a simulated limit SELL */
export interface SellExecutionResult {
  averagePrice: number;
  totalSharesSold: number;
  totalRevenue: number; // USD received (before fees)
  fees: number; // Taker fee in USD
  netRevenue: number; // totalRevenue - fees
  isPartialFill: boolean;
  fillDetails: SellFillDetail[];
  orderbookSnapshot: unknown;
}

interface SellFillDetail {
  price: number;
  shares: number;
  revenue: number;
  feeForLevel: number;
}

/**
 * Simulates a limit SELL order execution for stop-loss / early exit.
 *
 * Walks the BID side of the orderbook (selling to resting buyers) from
 * highest bid downward. Only fills at bid prices **at or above** `limitPrice`.
 *
 * For a "panic sell" stop-loss, set limitPrice to 0 to accept any price.
 *
 * Fee formula is the same as for buys — taker fees (conservative).
 *
 * @param orderbook    Live CLOB orderbook snapshot
 * @param sharesToSell Number of shares to sell
 * @param limitPrice   Minimum price we are willing to accept per share (floor)
 */
export function simulateLimitSell(
  orderbook: Orderbook,
  sharesToSell: number,
  limitPrice: number,
): SellExecutionResult {
  // Sort bids by price descending (best first)
  const bids = [...orderbook.bids].sort(
    (a, b) => parseFloat(b.price) - parseFloat(a.price),
  );

  const fillDetails: SellFillDetail[] = [];
  let remainingShares = new Decimal(sharesToSell);
  let totalSharesSold = new Decimal(0);
  let totalRevenue = new Decimal(0);
  let totalFees = new Decimal(0);

  for (const level of bids) {
    if (remainingShares.lte(0)) break;

    const bidPrice = parseFloat(level.price);
    const bidSize = parseFloat(level.size);

    // Only sell at prices at or above our limit
    if (bidPrice < limitPrice) break;

    const feePerShare = calculateFeePerShare(bidPrice);
    const sharesToFillAtLevel = Math.min(remainingShares.toNumber(), bidSize);

    if (sharesToFillAtLevel <= 0) continue;

    const shares = new Decimal(sharesToFillAtLevel);
    const revenue = shares.mul(bidPrice);
    const fee = shares.mul(feePerShare);

    totalSharesSold = totalSharesSold.plus(shares);
    totalRevenue = totalRevenue.plus(revenue);
    totalFees = totalFees.plus(fee);
    remainingShares = remainingShares.minus(shares);

    fillDetails.push({
      price: bidPrice,
      shares: sharesToFillAtLevel,
      revenue: revenue.toNumber(),
      feeForLevel: fee.toNumber(),
    });
  }

  const isPartialFill = remainingShares.gt(new Decimal(sharesToSell).mul(0.1)); // >10% unsold
  const avgPrice = totalSharesSold.gt(0)
    ? totalRevenue.div(totalSharesSold).toNumber()
    : 0;
  const roundedFees = Math.round(totalFees.toNumber() * 10000) / 10000;

  if (totalSharesSold.gt(0)) {
    logger.debug(
      {
        avgPrice: avgPrice.toFixed(6),
        shares: totalSharesSold.toNumber().toFixed(4),
        revenue: totalRevenue.toNumber().toFixed(4),
        fees: roundedFees.toFixed(4),
        levels: fillDetails.length,
        partial: isPartialFill,
      },
      "Limit sell simulated",
    );
  }

  return {
    averagePrice: avgPrice,
    totalSharesSold: totalSharesSold.toNumber(),
    totalRevenue: totalRevenue.toNumber(),
    fees: roundedFees,
    netRevenue: totalRevenue.toNumber() - roundedFees,
    isPartialFill,
    fillDetails,
    orderbookSnapshot: snapshotOrderbook(orderbook),
  };
}

// ============================================
// PnL calculation helpers
// ============================================

/**
 * Calculate expected profit for a winning trade at a given entry price.
 * profit = (1.00 - entryPrice) × shares - fees
 */
export function calculateWinProfit(
  entryPrice: number,
  shares: number,
  fees: number,
): number {
  return (1.0 - entryPrice) * shares - fees;
}

/**
 * Calculate expected loss for a losing trade at a given entry price.
 * loss = -(entryPrice × shares + fees)
 */
export function calculateLossAmount(
  entryPrice: number,
  shares: number,
  fees: number,
): number {
  return -(entryPrice * shares + fees);
}

/**
 * Calculate PnL for an early exit (stop-loss / take-profit).
 * pnl = (exitPrice - entryPrice) × shares - entryFees - exitFees
 */
export function calculateEarlyExitPnl(
  entryPrice: number,
  exitPrice: number,
  shares: number,
  entryFees: number,
  exitFees: number,
): number {
  return (exitPrice - entryPrice) * shares - entryFees - exitFees;
}
