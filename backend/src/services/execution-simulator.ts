import { CRYPTO_FEE_RATE, POLYMARKET_MIN_ORDER_SIZE, type ExecutableBook, type BookLevel } from "../types/index.js";

export interface FillDetail {
  price: number;
  shares: number;
  cost: number;
  feeForLevel: number;
}

export interface ExecutionResult {
  averagePrice: number;
  totalShares: number;
  totalCost: number;
  fees: number;
  netCost: number;
  isPartialFill: boolean;
  belowMinimumOrderSize: boolean;
  minOrderSize: number;
  fillDetails: FillDetail[];
}

export interface SellFillDetail {
  price: number;
  shares: number;
  revenue: number;
  feeForLevel: number;
}

export interface SellExecutionResult {
  averagePrice: number;
  totalSharesSold: number;
  totalRevenue: number;
  fees: number;
  netRevenue: number;
  isPartialFill: boolean;
  fillDetails: SellFillDetail[];
  belowMinimumOrderSize: boolean;
}

const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/** Polymarket crypto taker fee per share: 0.07 · p · (1 − p). */
export function calculateFeePerShare(price: number): number {
  return round4(CRYPTO_FEE_RATE * price * (1 - price));
}

const sorted = (levels: BookLevel[], ascending: boolean) =>
  levels
    .map((l) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
    .sort((a, b) => (ascending ? a.price - b.price : b.price - a.price));

/** FAK taker buy: walks the asks up to `limitPrice`, kills any unfilled budget. */
export function simulateLimitBuy(orderbook: ExecutableBook, usdAmount: number, limitPrice: number): ExecutionResult {
  const fillDetails: FillDetail[] = [];
  let remainingUsd = usdAmount;
  let totalShares = 0;
  let totalCost = 0;
  let totalFees = 0;

  for (const { price, size } of sorted(orderbook.asks, true)) {
    if (remainingUsd <= 0 || price > limitPrice) break;
    const feePerShare = calculateFeePerShare(price);
    const shares = Math.min(remainingUsd / (price + feePerShare), size);
    if (shares <= 0) continue;
    const cost = shares * price;
    const fee = shares * feePerShare;
    totalShares += shares;
    totalCost += cost;
    totalFees += fee;
    remainingUsd -= cost + fee;
    fillDetails.push({ price, shares, cost, feeForLevel: fee });
  }

  const fees = round4(totalFees);
  return {
    averagePrice: totalShares > 0 ? totalCost / totalShares : 0,
    totalShares,
    totalCost,
    fees,
    netCost: totalCost + fees,
    isPartialFill: remainingUsd > 1e-9 && totalShares > 0,
    belowMinimumOrderSize: totalShares > 0 && totalShares < POLYMARKET_MIN_ORDER_SIZE,
    minOrderSize: POLYMARKET_MIN_ORDER_SIZE,
    fillDetails,
  };
}

/** Taker sell: walks the bids down, filling at or above `limitPrice` (0 = any bid). */
export function simulateLimitSell(orderbook: ExecutableBook, sharesToSell: number, limitPrice: number): SellExecutionResult {
  const fillDetails: SellFillDetail[] = [];
  let remainingShares = sharesToSell;
  let totalSharesSold = 0;
  let totalRevenue = 0;
  let totalFees = 0;

  for (const { price, size } of sorted(orderbook.bids, false)) {
    if (remainingShares <= 0 || price < limitPrice) break;
    const shares = Math.min(remainingShares, size);
    if (shares <= 0) continue;
    const revenue = shares * price;
    const fee = shares * calculateFeePerShare(price);
    totalSharesSold += shares;
    totalRevenue += revenue;
    totalFees += fee;
    remainingShares -= shares;
    fillDetails.push({ price, shares, revenue, feeForLevel: fee });
  }

  const fees = round4(totalFees);
  return {
    averagePrice: totalSharesSold > 0 ? totalRevenue / totalSharesSold : 0,
    totalSharesSold,
    totalRevenue,
    fees,
    netRevenue: totalRevenue - fees,
    isPartialFill: remainingShares > sharesToSell * 0.1,
    fillDetails,
    belowMinimumOrderSize: false,
  };
}

/** Stop trigger as a fraction of entry, so risk per position is constant across the price band. */
export function stopTriggerPrice(entryPrice: number, fraction: number): number {
  return entryPrice * (1 - fraction);
}

export function calculateWinProfit(entryPrice: number, shares: number, fees: number): number {
  return (1 - entryPrice) * shares - fees;
}
