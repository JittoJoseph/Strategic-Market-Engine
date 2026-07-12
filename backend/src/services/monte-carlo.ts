import { createModuleLogger } from "../utils/logger.js";
import { getDb, getPortfolio } from "../db/client.js";
import * as schema from "../db/schema.js";
import { eq } from "drizzle-orm";

const logger = createModuleLogger("monte-carlo");

export interface MonteCarloConfig {
  /** Number of simulated equity curves to generate */
  simulations: number;
  /** Number of trades per simulated curve */
  tradesPerSim: number;
}

export interface EquityCurvePoint {
  tradeIndex: number;
  balance: number;
}

export interface PercentileEquityCurve {
  percentile: number;
  curve: EquityCurvePoint[];
}

export interface MonteCarloResult {
  config: MonteCarloConfig;

  historical: {
    totalSettled: number;
    wins: number;
    losses: number;
    winRate: number;
    avgWinPnl: number;
    avgLossPnl: number;
    avgWinPct: number;
    avgLossPct: number;
    largestWin: number;
    largestLoss: number;
    /** totalWinPnl / |totalLossPnl|; 999 when no losses */
    profitFactor: number;
    /** Average P&L per trade */
    expectancy: number;
  };

  distribution: {
    histogram: { min: number; max: number; count: number }[];
    percentiles: {
      p5: number;
      p25: number;
      p50: number;
      p75: number;
      p95: number;
    };
    mean: number;
    stdDev: number;
    /** % of sims ending above startingCapital */
    profitProbability: number;
    /** % of sims that hit a >50 % drawdown at any point */
    ruinProbability: number;
  };

  equityCurves: PercentileEquityCurve[];

  drawdown: {
    median: number;
    p95: number;
    worst: number;
  };

  startingCapital: number;
}

/** Value at percentile p (0-100) of a pre-sorted array. */
function pctile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    Math.floor((p / 100) * sorted.length),
    sorted.length - 1,
  );
  return sorted[idx]!;
}

/** Build a fixed-width histogram from a sorted array in O(N). */
function buildHistogram(
  sorted: number[],
  buckets = 20,
): { min: number; max: number; count: number }[] {
  const lo = sorted[0]!;
  const hi = sorted[sorted.length - 1]!;
  const width = hi > lo ? (hi - lo) / buckets : 1;
  const counts = new Int32Array(buckets);

  for (const v of sorted) {
    const i = Math.min(Math.floor((v - lo) / width), buckets - 1);
    counts[i]!++;
  }

  return Array.from({ length: buckets }, (_, i) => ({
    min: r2(lo + i * width),
    max: r2(i === buckets - 1 ? hi + 0.01 : lo + (i + 1) * width),
    count: counts[i]!,
  }));
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

const DEFAULT_CONFIG: MonteCarloConfig = {
  simulations: 10_000,
  tradesPerSim: 100,
};

const CURVE_PERCENTILES = [5, 25, 50, 75, 95] as const;

/**
 * Monte Carlo analysis over all settled trades. Realized PnL (not exitOutcome)
 * drives win/loss classification, so an early exit that clears the entry price
 * still counts as a win.
 */
export async function runMonteCarloAnalysis(
  overrides?: Partial<MonteCarloConfig>,
): Promise<MonteCarloResult> {
  const config: MonteCarloConfig = { ...DEFAULT_CONFIG, ...overrides };
  const db = getDb();

  const rows = await db
    .select({
      realizedPnl: schema.simulatedTrades.realizedPnl,
      actualCost: schema.simulatedTrades.actualCost,
    })
    .from(schema.simulatedTrades)
    .where(eq(schema.simulatedTrades.status, "SETTLED"));

  if (rows.length === 0) {
    throw new Error("No settled trades to analyse  need historical data");
  }

  const pnlPool: number[] = [];

  let winCount = 0;
  let lossCount = 0;
  let totalWin = 0;
  let totalLoss = 0;
  let sumWinPct = 0;
  let sumLossPct = 0;
  let largestWin = 0;
  let largestLoss = 0;

  for (const row of rows) {
    const pnl = parseFloat(row.realizedPnl ?? "0");
    const cost = parseFloat(row.actualCost ?? "0");
    const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;

    pnlPool.push(pnl);

    if (pnl > 0) {
      winCount++;
      totalWin += pnl;
      sumWinPct += pnlPct;
      if (pnl > largestWin) largestWin = pnl;
    } else {
      lossCount++;
      totalLoss += pnl;
      sumLossPct += pnlPct;
      if (pnl < largestLoss) largestLoss = pnl;
    }
  }

  const n = pnlPool.length;
  const winRate = winCount / n;
  const avgWinPnl = winCount > 0 ? totalWin / winCount : 0;
  const avgLossPnl = lossCount > 0 ? totalLoss / lossCount : 0;
  const avgWinPct = winCount > 0 ? sumWinPct / winCount : 0;
  const avgLossPct = lossCount > 0 ? sumLossPct / lossCount : 0;
  const totalLossAbs = Math.abs(totalLoss);
  const profitFactor =
    totalLossAbs > 0 ? totalWin / totalLossAbs : totalWin > 0 ? Infinity : 0;
  const expectancy = pnlPool.reduce((s, v) => s + v, 0) / n;

  const portfolio = await getPortfolio();
  const startingCapital = portfolio
    ? parseFloat(portfolio.initialCapital)
    : 100;

  // Keep each sim's three dimensions together so a single sort stays aligned,
  // avoiding index drift between finalBalances and the curves.
  type Sim = { finalBalance: number; maxDrawdown: number; curve: Float64Array };
  const sims: Sim[] = new Array(config.simulations);

  for (let s = 0; s < config.simulations; s++) {
    let balance = startingCapital;
    let peak = balance;
    let maxDD = 0;
    const curve = new Float64Array(config.tradesPerSim + 1);
    curve[0] = balance;

    for (let t = 0; t < config.tradesPerSim; t++) {
      balance += pnlPool[Math.floor(Math.random() * n)]!;
      curve[t + 1] = balance;
      if (balance > peak) peak = balance;
      const dd = peak > 0 ? ((peak - balance) / peak) * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    }

    sims[s] = { finalBalance: balance, maxDrawdown: maxDD, curve };
  }

  sims.sort((a, b) => a.finalBalance - b.finalBalance);

  const sortedFinalBalances = sims.map((s) => s.finalBalance);

  const sortedMaxDrawdowns = sims
    .map((s) => s.maxDrawdown)
    .sort((a, b) => a - b);

  let sum = 0;
  for (const b of sortedFinalBalances) sum += b;
  const mean = sum / config.simulations;

  let varSum = 0;
  for (const b of sortedFinalBalances) varSum += (b - mean) ** 2;
  const stdDev = Math.sqrt(varSum / config.simulations);

  let profitCount = 0;
  for (const b of sortedFinalBalances) if (b > startingCapital) profitCount++;

  let ruinCount = 0;
  for (const dd of sortedMaxDrawdowns) if (dd > 50) ruinCount++;

  const histogram = buildHistogram(sortedFinalBalances);

  // sims[] is sorted by finalBalance, so index directly for each percentile.
  const equityCurves: PercentileEquityCurve[] = CURVE_PERCENTILES.map((p) => {
    const idx = Math.min(
      Math.floor((p / 100) * config.simulations),
      config.simulations - 1,
    );
    const raw = sims[idx]!.curve;
    const curve: EquityCurvePoint[] = Array.from(
      { length: raw.length },
      (_, i) => ({ tradeIndex: i, balance: r2(raw[i]!) }),
    );
    return { percentile: p, curve };
  });

  logger.info(
    {
      settledTrades: n,
      simulations: config.simulations,
      winRate: (winRate * 100).toFixed(1) + "%",
      median: r2(pctile(sortedFinalBalances, 50)),
      profitProb: ((profitCount / config.simulations) * 100).toFixed(1) + "%",
    },
    "Monte Carlo complete",
  );

  return {
    config,
    historical: {
      totalSettled: n,
      wins: winCount,
      losses: lossCount,
      winRate: r2(winRate * 100),
      avgWinPnl: r6(avgWinPnl),
      avgLossPnl: r6(avgLossPnl),
      avgWinPct: r2(avgWinPct),
      avgLossPct: r2(avgLossPct),
      largestWin: r6(largestWin),
      largestLoss: r6(largestLoss),
      profitFactor: profitFactor === Infinity ? 999 : r2(profitFactor),
      expectancy: r6(expectancy),
    },
    distribution: {
      histogram,
      percentiles: {
        p5: r2(pctile(sortedFinalBalances, 5)),
        p25: r2(pctile(sortedFinalBalances, 25)),
        p50: r2(pctile(sortedFinalBalances, 50)),
        p75: r2(pctile(sortedFinalBalances, 75)),
        p95: r2(pctile(sortedFinalBalances, 95)),
      },
      mean: r2(mean),
      stdDev: r2(stdDev),
      profitProbability: r2((profitCount / config.simulations) * 100),
      ruinProbability: r2((ruinCount / sortedMaxDrawdowns.length) * 100),
    },
    equityCurves,
    drawdown: {
      median: r2(pctile(sortedMaxDrawdowns, 50)),
      p95: r2(pctile(sortedMaxDrawdowns, 95)),
      worst: r2(sortedMaxDrawdowns[sortedMaxDrawdowns.length - 1]!),
    },
    startingCapital,
  };
}
