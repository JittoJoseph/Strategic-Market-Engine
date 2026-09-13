import { getDb, getPortfolio } from "../db/client.js";
import * as schema from "../db/schema.js";
import { desc, gte } from "drizzle-orm";
import Decimal from "decimal.js";

export type TimePeriod = "1D" | "1W" | "1M" | "ALL";

export interface PerformanceMetrics {
  period: TimePeriod;
  totalPnl: string;
  totalDeployed: string;
  roi: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: string;
  avgWin: string;
  avgLoss: string;
  largestWin: string;
  largestLoss: string;
  totalFees: string;
  openPositions: number;
  cashBalance: string;
  initialCapital: string;
  openPositionsValue: string;
}

const PERIOD_MS: Record<Exclude<TimePeriod, "ALL">, number> = {
  "1D": 24 * 60 * 60 * 1000,
  "1W": 7 * 24 * 60 * 60 * 1000,
  "1M": 30 * 24 * 60 * 60 * 1000,
};

export async function calculatePortfolioPerformance(period: TimePeriod, openPositionsValue = 0): Promise<PerformanceMetrics> {
  const query = getDb().select().from(schema.simulatedTrades).orderBy(desc(schema.simulatedTrades.entryTs));
  const trades =
    period === "ALL" ? await query : await query.where(gte(schema.simulatedTrades.entryTs, new Date(Date.now() - PERIOD_MS[period])));

  const portfolio = await getPortfolio();
  const cashBalance = new Decimal(portfolio?.cashBalance ?? 0);
  const initialCapital = new Decimal(portfolio?.initialCapital ?? 0);
  const positionsValue = new Decimal(openPositionsValue);

  let totalPnl = new Decimal(0);
  let totalDeployed = new Decimal(0);
  let totalFees = new Decimal(0);
  let winPnl = new Decimal(0);
  let lossPnl = new Decimal(0);
  let largestWin = new Decimal(0);
  let largestLoss = new Decimal(0);
  let wins = 0;
  let losses = 0;
  let openPositions = 0;

  for (const trade of trades) {
    totalDeployed = totalDeployed.plus(trade.actualCost);
    totalFees = totalFees.plus(trade.entryFees ?? 0);
    if (trade.status === "OPEN") {
      openPositions++;
      continue;
    }
    if (trade.realizedPnl === null) continue;
    const pnl = new Decimal(trade.realizedPnl);
    totalPnl = totalPnl.plus(pnl);
    if (trade.exitOutcome === "WIN") {
      wins++;
      winPnl = winPnl.plus(pnl);
      if (pnl.gt(largestWin)) largestWin = pnl;
    } else {
      losses++;
      lossPnl = lossPnl.plus(pnl);
      if (pnl.lt(largestLoss)) largestLoss = pnl;
    }
  }

  const closed = wins + losses;
  const portfolioValue = cashBalance.plus(positionsValue);
  return {
    period,
    totalPnl: totalPnl.toFixed(6),
    totalDeployed: totalDeployed.toFixed(2),
    roi: initialCapital.gt(0) ? portfolioValue.minus(initialCapital).div(initialCapital).mul(100).toFixed(2) : "0.00",
    totalTrades: trades.length,
    wins,
    losses,
    winRate: closed > 0 ? ((wins / closed) * 100).toFixed(2) : "0.00",
    avgWin: wins > 0 ? winPnl.div(wins).toFixed(6) : "0",
    avgLoss: losses > 0 ? lossPnl.div(losses).toFixed(6) : "0",
    largestWin: largestWin.toFixed(6),
    largestLoss: largestLoss.toFixed(6),
    totalFees: totalFees.toFixed(6),
    openPositions,
    cashBalance: cashBalance.toFixed(2),
    initialCapital: initialCapital.toFixed(2),
    openPositionsValue: positionsValue.toFixed(2),
  };
}
