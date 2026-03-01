"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Header } from "@/components/header";
import Link from "next/link";
import { RefreshCw, AlertTriangle, TrendingUp } from "lucide-react";
import type { MonteCarloResult } from "@/lib/types";
import { ApiClient } from "@/lib/api-client";

const api = new ApiClient();
const MIN_RELIABLE_TRADES = 30;

//  Formatting helpers
const fmtUsd = (n: number, dp = 2) =>
  "$" +
  Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
const fmtPct = (n: number, dp = 1) => `${n.toFixed(dp)}%`;
const fmtDelta = (n: number, dp = 2) => `${n >= 0 ? "+" : "-"}${fmtUsd(n, dp)}`;

//  Page
export default function AnalysisPage() {
  const [result, setResult] = useState<MonteCarloResult | null>(null);
  const [noData, setNoData] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalysis = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNoData(false);
    try {
      const data = await api.getAnalysis({
        simulations: 10_000,
        tradesPerSim: 100,
      });
      if (data === null) {
        setNoData(true);
        setResult(null);
      } else {
        setResult(data);
      }
    } catch (e: any) {
      setError(e?.message || "Failed to fetch analysis");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAnalysis();
  }, [fetchAnalysis]);

  const lowSample =
    result !== null && result.historical.totalSettled < MIN_RELIABLE_TRADES;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <main className="container mx-auto px-4 py-5 max-w-6xl space-y-3">
        {/* Top bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="text-[10px] font-mono text-muted-foreground/50 hover:text-muted-foreground tracking-widest transition-colors"
            >
              DASHBOARD
            </Link>
            <span className="text-muted-foreground/20 font-mono">/</span>
            <span className="text-[10px] font-mono tracking-[0.18em] text-muted-foreground">
              MONTE CARLO
            </span>
          </div>
          <button
            onClick={fetchAnalysis}
            disabled={loading}
            className="flex items-center gap-1.5 text-[10px] font-mono tracking-widest px-3 py-1.5 rounded border border-border/30 bg-card/30 hover:bg-muted/30 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
            {loading ? "RUNNING" : "RE-RUN"}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="border border-red-500/30 bg-red-500/5 rounded-lg px-4 py-3 text-xs font-mono text-red-400 flex items-center gap-2">
            <AlertTriangle size={12} />
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && !result && !noData && (
          <div className="border border-border/30 rounded-xl py-24 flex flex-col items-center gap-3">
            <TrendingUp
              size={14}
              className="text-muted-foreground/20 animate-pulse"
            />
            <p className="text-[10px] font-mono text-muted-foreground/30 tracking-widest">
              RUNNING {(10_000).toLocaleString()} SIMULATIONS
            </p>
          </div>
        )}

        {/* No data */}
        {noData && !loading && <EmptyState />}

        {/* Low sample */}
        {lowSample && !loading && result && (
          <div className="border border-amber-500/30 bg-amber-500/5 rounded-lg px-4 py-2 flex items-center gap-2">
            <AlertTriangle size={10} className="text-amber-500 shrink-0" />
            <p className="text-[10px] font-mono text-amber-500/70">
              <span className="font-bold">Low sample </span>{" "}
              {result.historical.totalSettled} settled trade
              {result.historical.totalSettled !== 1 ? "s" : ""}. Results below{" "}
              {MIN_RELIABLE_TRADES} trades are not statistically meaningful.
            </p>
          </div>
        )}

        {/* Results */}
        {result && !loading && (
          <>
            <StatsPanel data={result} />
            <ChartPanel data={result} />
            <BottomPanel data={result} />
          </>
        )}
      </main>
    </div>
  );
}

//  Empty state
function EmptyState() {
  return (
    <div className="border border-border/30 rounded-xl flex flex-col items-center justify-center py-24 gap-3 text-center">
      <TrendingUp size={14} className="text-muted-foreground/20" />
      <p className="text-[10px] font-mono text-muted-foreground/40 tracking-[0.18em]">
        NO SETTLED TRADES YET
      </p>
      <p className="text-[11px] font-mono text-muted-foreground/30 max-w-xs leading-relaxed">
        Analysis requires at least one settled position.
      </p>
      <Link
        href="/"
        className="text-[10px] font-mono tracking-widest text-muted-foreground/40 hover:text-muted-foreground border border-border/20 rounded px-3 py-1.5 transition-colors mt-1"
      >
        VIEW DASHBOARD
      </Link>
    </div>
  );
}

//  Stats panel  mirrors dashboard portfolio section layout
function StatsPanel({ data }: { data: MonteCarloResult }) {
  const h = data.historical;
  const pfDisplay = h.profitFactor >= 999 ? "" : h.profitFactor.toFixed(2);
  const pfLabel =
    h.profitFactor >= 999
      ? "no losses recorded"
      : h.profitFactor >= 2
        ? "strong edge"
        : h.profitFactor >= 1
          ? "marginal edge"
          : "negative edge";

  return (
    <div className="border border-border/30 rounded-xl bg-background overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/20">
        <span className="text-[10px] font-mono tracking-[0.18em] text-muted-foreground">
          HISTORICAL STATISTICS
        </span>
        <span className="text-[10px] font-mono text-muted-foreground/40">
          {h.totalSettled} settled trade{h.totalSettled !== 1 ? "s" : ""}
          Monte Carlo pool
        </span>
      </div>

      {/* Columns */}
      <div className="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-border/20">
        {/* Win rate */}
        <div className="p-5 space-y-3">
          <div className="text-[10px] font-mono text-muted-foreground tracking-widest">
            WIN RATE
          </div>
          <div
            className={`text-3xl font-bold font-mono tabular-nums tracking-tight ${h.winRate >= 50 ? "text-emerald-500" : "text-red-500"}`}
          >
            {fmtPct(h.winRate, 1)}
          </div>
          <div className="h-1 w-full rounded-full overflow-hidden flex bg-red-500/20">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${Math.min(100, h.winRate)}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] font-mono">
            <span className="text-red-500/70">{h.losses} losses</span>
            <span className="text-emerald-500/70">{h.wins} wins</span>
          </div>
        </div>

        {/* Profit factor */}
        <div className="p-5">
          <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-1">
            PROFIT FACTOR
          </div>
          <div
            className={`text-3xl font-bold font-mono tabular-nums tracking-tight ${h.profitFactor >= 1 ? "text-emerald-500" : "text-red-500"}`}
          >
            {pfDisplay}
          </div>
          <div className="text-[10px] font-mono text-muted-foreground/50 mt-1.5">
            {pfLabel}
          </div>
          <div className="text-[10px] font-mono text-muted-foreground/40 mt-1">
            {h.wins > 0
              ? `best +${fmtUsd(h.largestWin, 4)}`
              : "no winning trades"}
          </div>
        </div>

        {/* Expectancy */}
        <div className="p-5">
          <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-1">
            EXPECTANCY
          </div>
          <div
            className={`text-3xl font-bold font-mono tabular-nums tracking-tight ${h.expectancy >= 0 ? "text-emerald-500" : "text-red-500"}`}
          >
            {h.expectancy >= 0 ? "+" : ""}
            {fmtUsd(h.expectancy, 4)}
          </div>
          <div className="text-[10px] font-mono text-muted-foreground/50 mt-1.5">
            avg per trade
          </div>
          <div className="text-[10px] font-mono text-muted-foreground/40 mt-1">
            {h.losses > 0
              ? `worst ${fmtDelta(h.largestLoss, 4)}`
              : "no losing trades"}
          </div>
        </div>

        {/* Avg win / avg loss */}
        <div className="p-5 space-y-4">
          <div>
            <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-0.5">
              AVG WIN
            </div>
            <div className="text-lg font-bold font-mono tabular-nums text-emerald-500">
              {h.wins > 0 ? `+${fmtUsd(h.avgWinPnl, 4)}` : ""}
            </div>
            <div className="text-[10px] font-mono text-muted-foreground/40 mt-0.5">
              {h.wins > 0
                ? `+${h.avgWinPct.toFixed(1)}% avg return`
                : "no wins yet"}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-0.5">
              AVG LOSS
            </div>
            <div className="text-lg font-bold font-mono tabular-nums text-red-500">
              {h.losses > 0 ? fmtDelta(h.avgLossPnl, 4) : ""}
            </div>
            <div className="text-[10px] font-mono text-muted-foreground/40 mt-0.5">
              {h.losses > 0
                ? `${h.avgLossPct.toFixed(1)}% avg return`
                : "no losses yet"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

//  Chart panel
function ChartPanel({ data }: { data: MonteCarloResult }) {
  const [tab, setTab] = useState<"histogram" | "equity">("histogram");
  return (
    <div className="border border-border/30 rounded-xl bg-background overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/20">
        <div className="flex gap-0.5">
          {(["histogram", "equity"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-[10px] font-mono tracking-wider px-3 py-1.5 rounded transition-colors ${
                tab === t
                  ? "bg-muted/50 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "histogram" ? "DISTRIBUTION" : "EQUITY CURVES"}
            </button>
          ))}
        </div>
        <span className="text-[10px] font-mono text-muted-foreground/40">
          {data.config.simulations.toLocaleString()} sims{" "}
          {data.config.tradesPerSim} trades start{" "}
          {fmtUsd(data.startingCapital, 0)}
        </span>
      </div>
      {tab === "histogram" ? (
        <HistogramChart data={data} />
      ) : (
        <EquityCurvesChart data={data} />
      )}
    </div>
  );
}

//  Histogram
function HistogramChart({ data }: { data: MonteCarloResult }) {
  const { histogram, percentiles } = data.distribution;
  const [hovered, setHovered] = useState<number | null>(null);
  const maxCount = Math.max(...histogram.map((b) => b.count), 1);
  const startCap = data.startingCapital;
  const hoveredBucket = hovered !== null ? histogram[hovered] : null;

  return (
    <div className="px-5 pb-4 pt-4">
      {/* Hover info strip */}
      <div className="h-5 mb-3">
        {hoveredBucket ? (
          <div className="flex items-center justify-between text-[10px] font-mono">
            <span className="text-foreground/70">
              {fmtUsd(hoveredBucket.min, 1)} {fmtUsd(hoveredBucket.max, 1)}
            </span>
            <span className="text-muted-foreground/60">
              {hoveredBucket.count.toLocaleString()} sim
              {hoveredBucket.count !== 1 ? "s" : ""} (
              {((hoveredBucket.count / data.config.simulations) * 100).toFixed(
                1,
              )}
              %)
            </span>
          </div>
        ) : (
          <p className="text-[10px] font-mono text-muted-foreground/25">
            hover bars for details
          </p>
        )}
      </div>

      {/* Bars */}
      <div className="flex items-end h-44">
        {histogram.map((bucket, i) => {
          const mid = (bucket.min + bucket.max) / 2;
          const isProfit = mid >= startCap;
          const isMedian =
            percentiles.p50 >= bucket.min && percentiles.p50 < bucket.max;
          const barH = Math.max((bucket.count / maxCount) * 100, 0.3);
          return (
            <div
              key={i}
              className="flex-1 flex items-end h-full cursor-default"
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            >
              <div
                className="w-full rounded-t-sm"
                style={{
                  height: `${barH}%`,
                  backgroundColor: isMedian
                    ? "#3b82f6"
                    : isProfit
                      ? hovered === i
                        ? "#10b981"
                        : "#10b98155"
                      : hovered === i
                        ? "#ef4444"
                        : "#ef444455",
                }}
              />
            </div>
          );
        })}
      </div>

      {/* X axis */}
      <div className="flex justify-between mt-2 text-[9px] font-mono text-muted-foreground/40">
        <span>{fmtUsd(histogram[0]?.min ?? 0, 0)}</span>
        <span className="text-blue-400/60">
          median {fmtUsd(percentiles.p50, 2)}
        </span>
        <span>{fmtUsd(histogram[histogram.length - 1]?.max ?? 0, 0)}</span>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-2.5 text-[9px] font-mono text-muted-foreground/50">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-1.5 rounded-sm bg-emerald-500/50 inline-block" />
          profit
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-1.5 rounded-sm bg-red-500/50 inline-block" />
          loss
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-1.5 rounded-sm bg-blue-500 inline-block" />
          median
        </span>
        <span className="ml-auto">break-even {fmtUsd(startCap, 0)}</span>
      </div>
    </div>
  );
}

//  Equity curves
function EquityCurvesChart({ data }: { data: MonteCarloResult }) {
  const curves = data.equityCurves;
  const startCap = data.startingCapital;

  const { minVal, maxVal, tradeCount } = useMemo(() => {
    let mn = Infinity,
      mx = -Infinity,
      cnt = 0;
    for (const c of curves)
      for (const pt of c.curve) {
        if (pt.balance < mn) mn = pt.balance;
        if (pt.balance > mx) mx = pt.balance;
        if (pt.tradeIndex > cnt) cnt = pt.tradeIndex;
      }
    return { minVal: mn, maxVal: mx, tradeCount: cnt };
  }, [curves]);

  const range = maxVal - minVal || 1;
  const W = 800,
    H = 200;

  const toX = (t: number) => (tradeCount > 0 ? (t / tradeCount) * W : 0);
  const toY = (b: number) => H - ((b - minVal) / range) * H;

  const cfg: Record<number, { color: string; w: number; label: string }> = {
    5: { color: "#ef4444", w: 1.5, label: "P5" },
    25: { color: "#f97316", w: 1.5, label: "P25" },
    50: { color: "#e2e8f0", w: 2.5, label: "P50" },
    75: { color: "#22c55e", w: 1.5, label: "P75" },
    95: { color: "#10b981", w: 1.5, label: "P95" },
  };

  // Confidence band P25P75
  const p25 = curves.find((c) => c.percentile === 25);
  const p75 = curves.find((c) => c.percentile === 75);
  const bandPoints =
    p25 && p75
      ? [
          ...p25.curve.map((pt) => `${toX(pt.tradeIndex)},${toY(pt.balance)}`),
          ...[...p75.curve]
            .reverse()
            .map((pt) => `${toX(pt.tradeIndex)},${toY(pt.balance)}`),
        ].join(" ")
      : "";

  const breakEvenY = toY(startCap);

  return (
    <div className="px-5 pb-4 pt-4">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-52"
        preserveAspectRatio="none"
      >
        {/* Break-even */}
        <line
          x1={0}
          y1={breakEvenY}
          x2={W}
          y2={breakEvenY}
          stroke="white"
          strokeOpacity={0.06}
          strokeDasharray="4 5"
        />
        {/* P25-P75 band */}
        {bandPoints && (
          <polygon points={bandPoints} fill="white" fillOpacity={0.04} />
        )}
        {/* Curves  P50 last to render on top */}
        {[...curves]
          .sort((a, b) =>
            b.percentile === 50 ? -1 : a.percentile === 50 ? 1 : 0,
          )
          .map((c) => {
            const style = cfg[c.percentile];
            const pts = c.curve
              .map((pt) => `${toX(pt.tradeIndex)},${toY(pt.balance)}`)
              .join(" ");
            return (
              <polyline
                key={c.percentile}
                points={pts}
                fill="none"
                stroke={style?.color ?? "#888"}
                strokeWidth={style?.w ?? 1.5}
                strokeOpacity={c.percentile === 50 ? 0.9 : 0.5}
              />
            );
          })}
      </svg>

      <div className="flex justify-between text-[9px] font-mono text-muted-foreground/40 mt-1">
        <span>Trade 0</span>
        <span>Trade {tradeCount}</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 mt-3">
        {curves.map((c) => {
          const style = cfg[c.percentile];
          const finalBal = c.curve[c.curve.length - 1]?.balance ?? 0;
          const delta = finalBal - startCap;
          return (
            <div
              key={c.percentile}
              className="flex items-center gap-1.5 text-[10px] font-mono"
            >
              <span
                className="w-4 inline-block shrink-0"
                style={{
                  height: "2px",
                  backgroundColor: style?.color,
                  display: "inline-block",
                }}
              />
              <span className="text-muted-foreground/50">{style?.label}</span>
              <span className="text-foreground/70 tabular-nums">
                {fmtUsd(finalBal, 2)}
              </span>
              <span
                className={`tabular-nums text-[9px] ${delta >= 0 ? "text-emerald-500/50" : "text-red-500/50"}`}
              >
                ({fmtDelta(delta, 2)})
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

//  Bottom panel  3-col grid matching dashboard style
function BottomPanel({ data }: { data: MonteCarloResult }) {
  const d = data.distribution;
  const dd = data.drawdown;
  const h = data.historical;
  const s = data.startingCapital;

  // Verdict score
  const scores = [
    Math.min(20, (h.winRate / 60) * 20),
    Math.min(
      20,
      h.profitFactor >= 1 ? Math.min((h.profitFactor - 1) / 2, 1) * 20 : 0,
    ),
    (d.profitProbability / 100) * 20,
    Math.max(0, 20 - d.ruinProbability),
    Math.max(0, 20 - dd.median),
  ];
  const score = Math.round(scores.reduce((a, v) => a + v, 0));
  const tier =
    score >= 75
      ? { label: "ROBUST", color: "text-emerald-500", bar: "#10b981" }
      : score >= 50
        ? { label: "VIABLE", color: "text-amber-500", bar: "#f59e0b" }
        : { label: "FRAGILE", color: "text-red-500", bar: "#ef4444" };

  const pval = (p: 5 | 25 | 50 | 75 | 95) => d.percentiles[`p${p}`];

  return (
    <div className="border border-border/30 rounded-xl bg-background overflow-hidden">
      <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border/20">
        {/* Final balance distribution */}
        <div className="p-5">
          <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-4">
            FINAL BALANCE
          </div>
          <div className="space-y-2">
            {([5, 25, 50, 75, 95] as const).map((p) => {
              const val = pval(p);
              const delta = val - s;
              return (
                <div key={p} className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-muted-foreground/60 w-8">
                    P{p}
                  </span>
                  <span className="text-sm font-bold font-mono tabular-nums text-foreground">
                    {fmtUsd(val, 2)}
                  </span>
                  <span
                    className={`text-[10px] font-mono tabular-nums ${delta >= 0 ? "text-emerald-500/60" : "text-red-500/60"}`}
                  >
                    {fmtDelta(delta, 2)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="border-t border-border/10 mt-3 pt-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-muted-foreground/60">
                Mean
              </span>
              <span className="text-sm font-bold font-mono tabular-nums text-foreground">
                {fmtUsd(d.mean, 2)}
              </span>
              <span
                className={`text-[10px] font-mono tabular-nums ${d.mean - s >= 0 ? "text-emerald-500/60" : "text-red-500/60"}`}
              >
                {fmtDelta(d.mean - s, 2)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-muted-foreground/40">
                Std Dev
              </span>
              <span className="text-[10px] font-mono tabular-nums text-muted-foreground/50">
                {fmtUsd(d.stdDev, 2)}
              </span>
              <span />
            </div>
          </div>
        </div>

        {/* Risk */}
        <div className="p-5">
          <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-4">
            RISK METRICS
          </div>
          <div className="space-y-4">
            {/* Profit probability */}
            <div>
              <div className="flex items-end justify-between mb-1.5">
                <span className="text-[10px] font-mono text-muted-foreground tracking-widest">
                  PROFIT PROBABILITY
                </span>
                <span
                  className={`text-xl font-bold font-mono tabular-nums ${d.profitProbability >= 60 ? "text-emerald-500" : d.profitProbability >= 40 ? "text-amber-500" : "text-red-500"}`}
                >
                  {fmtPct(d.profitProbability)}
                </span>
              </div>
              <div className="h-1 w-full rounded-full bg-muted/30 overflow-hidden">
                <div
                  className={`h-full rounded-full ${d.profitProbability >= 60 ? "bg-emerald-500" : d.profitProbability >= 40 ? "bg-amber-500" : "bg-red-500"}`}
                  style={{ width: `${d.profitProbability}%` }}
                />
              </div>
            </div>

            {/* Ruin risk */}
            <div>
              <div className="flex items-end justify-between mb-1.5">
                <div>
                  <span className="text-[10px] font-mono text-muted-foreground tracking-widest">
                    RUIN RISK
                  </span>
                  <span className="text-[9px] font-mono text-muted-foreground/30 ml-1">
                    &gt;50% DD
                  </span>
                </div>
                <span
                  className={`text-xl font-bold font-mono tabular-nums ${d.ruinProbability <= 5 ? "text-emerald-500" : d.ruinProbability <= 20 ? "text-amber-500" : "text-red-500"}`}
                >
                  {fmtPct(d.ruinProbability)}
                </span>
              </div>
              <div className="h-1 w-full rounded-full bg-muted/30 overflow-hidden">
                <div
                  className={`h-full rounded-full ${d.ruinProbability <= 5 ? "bg-emerald-500" : d.ruinProbability <= 20 ? "bg-amber-500" : "bg-red-500"}`}
                  style={{ width: `${Math.min(100, d.ruinProbability)}%` }}
                />
              </div>
            </div>

            {/* Drawdown grid */}
            <div>
              <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-2">
                MAX DRAWDOWN
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Median", val: dd.median, color: "text-amber-500" },
                  { label: "P95", val: dd.p95, color: "text-red-400" },
                  { label: "Worst", val: dd.worst, color: "text-red-500" },
                ].map(({ label, val, color }) => (
                  <div
                    key={label}
                    className="text-center border border-border/15 rounded-lg py-2"
                  >
                    <div
                      className={`text-sm font-bold font-mono tabular-nums ${color}`}
                    >
                      {fmtPct(val)}
                    </div>
                    <div className="text-[9px] font-mono text-muted-foreground/40 mt-0.5">
                      {label}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Verdict */}
        <div className="p-5">
          <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-4">
            VERDICT
          </div>

          <div className="flex items-start gap-4 mb-3">
            <div
              className={`text-5xl font-bold font-mono tabular-nums tracking-tight ${tier.color}`}
            >
              {score}
            </div>
            <div className="pt-1.5">
              <div
                className={`text-sm font-mono font-bold tracking-widest ${tier.color}`}
              >
                {tier.label}
              </div>
              <div className="text-[10px] font-mono text-muted-foreground/40 mt-0.5">
                out of 100
              </div>
            </div>
          </div>

          {/* Overall bar */}
          <div className="h-1 w-full rounded-full bg-muted/20 overflow-hidden mb-4">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{ width: `${score}%`, backgroundColor: tier.bar }}
            />
          </div>

          {/* Factor breakdown */}
          <div className="space-y-2">
            {[
              { label: "Win rate", v: scores[0]! },
              { label: "Profit factor", v: scores[1]! },
              { label: "Profit prob", v: scores[2]! },
              { label: "Ruin safety", v: scores[3]! },
              { label: "DD safety", v: scores[4]! },
            ].map(({ label, v }) => (
              <div key={label} className="flex items-center gap-2">
                <span className="text-[9px] font-mono text-muted-foreground/40 w-20 shrink-0">
                  {label}
                </span>
                <div className="flex-1 h-0.5 bg-muted/20 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(v / 20) * 100}%`,
                      backgroundColor: tier.bar,
                      opacity: 0.6,
                    }}
                  />
                </div>
                <span className="text-[9px] font-mono tabular-nums text-muted-foreground/30 w-4 text-right">
                  {Math.round(v)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
