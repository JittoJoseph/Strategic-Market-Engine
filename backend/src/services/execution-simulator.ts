import { createModuleLogger } from "../utils/logger.js";
import {
  CRYPTO_FEE,
  type Orderbook,
  type OrderbookLevel,
} from "../types/index.js";
import Decimal from "decimal.js";

const logger = createModuleLogger("execution-simulator");

/** Result of a simulated limit order fill */
export interface ExecutionResult {
  averagePrice: number;
  totalShares: number;
  totalCost: number; // USD spent (before fees)
  fees: number; // Taker fee in USD
  netCost: number; // totalCost + fees
  isPartialFill: boolean;
  fillDetails: FillDetail[];
  orderbookSnapshot: unknown;
  feeRateBps: number;
}

interface FillDetail {
  price: number;
  shares: number;
  cost: number;
  feeForLevel: number;
}

/**
 * Simulates a GTC limit BUY order execution.
 *
 * Models the end-of-window micro-profit strategy:
 *   1. Both YES and NO tokens have resting limit orders at 0.97 in the last minute.
 *   2. Only the WINNING token ever reaches 0.97 (the losing token goes to 0).
 *   3. When triggered, the order fills against resting asks at ≤ limitPrice.
 *
 * This is modelled as a TAKER fill (immediately crossing the spread). In the
 * real trade execution this would be a resting maker limit at 0.97, so actual
 * fees would be even lower (20% maker rebate), but the difference is negligible
 * at p≈0.97 where the effective fee rate is ~0.02%.
 *
 * Fee formula for 5-min / 15-min crypto markets (Polymarket docs):
 *   fee = C × 0.25 × (p × (1-p))^2
 * At p=0.97: fee_per_share ≈ 0.000212 USDC (effective ~0.02%)
 *
 * @param orderbook   Live CLOB orderbook snapshot
 * @param usdAmount   USDC budget for this order
 * @param limitPrice  Maximum price we are willing to pay per share
 * @param feeRateBps  Fee rate in basis points from CLOB API (>0 = fees enabled)
 */
export function simulateLimitBuy(
  orderbook: Orderbook,
  usdAmount: number,
  limitPrice: number,
  feeRateBps: number,
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
    const feePerShare = calculateFeePerShare(askPrice, feeRateBps);
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

  const isPartialFill = remainingUsd.gt(new Decimal(usdAmount).mul(0.1)); // >10% unfilled
  const avgPrice = totalShares.gt(0)
    ? totalCost.div(totalShares).toNumber()
    : 0;

  // Round fees to 4 decimal places (Polymarket precision)
  const roundedFees = Math.round(totalFees.toNumber() * 10000) / 10000;

  if (totalShares.gt(0)) {
    logger.debug(
      {
        avgPrice: avgPrice.toFixed(6),
        shares: totalShares.toNumber().toFixed(4),
        cost: totalCost.toNumber().toFixed(4),
        fees: roundedFees.toFixed(4),
        levels: fillDetails.length,
        partial: isPartialFill,
      },
      "Limit buy simulated",
    );
  }

  return {
    averagePrice: avgPrice,
    totalShares: totalShares.toNumber(),
    totalCost: totalCost.toNumber(),
    fees: roundedFees,
    netCost: totalCost.toNumber() + roundedFees,
    isPartialFill,
    fillDetails,
    orderbookSnapshot: {
      bids: orderbook.bids.slice(0, 5),
      asks: orderbook.asks.slice(0, 5),
      tick_size: orderbook.tick_size,
      timestamp: orderbook.timestamp,
    },
    feeRateBps,
  };
}

/**
 * Calculate fee per share using Polymarket's documented formula for 5-min / 15-min crypto markets.
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
 * Note: `feeRateBps` is the value embedded in real CLOB orders (used by the
 * smart contract for signature verification). It is used here solely as a
 * "fees-enabled?" gate — feeRateBps > 0 means this is a fee-enabled market
 * (5M/15M crypto). The actual per-share fee is always computed from the
 * Polymarket formula above, NOT from feeRateBps directly.
 *
 * Maker rebate: in real limit orders the maker receives 20% of the fee back.
 * This simulation conservatively models taker fees (no rebate), which slightly
 * overstates costs at our near-extreme entry prices.
 *
 * Fees are rounded to 4 decimal places (smallest fee unit: 0.0001 USDC).
 */
function calculateFeePerShare(price: number, feeRateBps: number): number {
  // Gate: if feeRateBps is 0 this is a fee-free market
  if (feeRateBps <= 0) return 0;

  const feeRate = CRYPTO_FEE.RATE;     // 0.25 for 5M/15M crypto
  const exponent = CRYPTO_FEE.EXPONENT; // 2 for 5M/15M crypto
  const pq = price * (1 - price);       // p × (1-p), maximised at p=0.5
  const fee = feeRate * Math.pow(pq, exponent);

  // Round to 4 decimal places (Polymarket precision; sub-0.0001 rounds to 0)
  return Math.round(fee * 10000) / 10000;
}

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
