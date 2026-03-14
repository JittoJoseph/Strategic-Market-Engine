"use client";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ExternalLink, X } from "lucide-react";
import type { DiscoveredMarket, SimulatedTrade } from "@/lib/types";
import { MARKET_WINDOW_LABELS, type MarketWindow } from "@/lib/types";

interface MarketDetailModalProps {
  market: DiscoveredMarket | null;
  trades: SimulatedTrade[];
  open: boolean;
  onClose: () => void;
}

function polymarketMarketUrl(market: DiscoveredMarket): string {
  if (market.slug) return `https://polymarket.com/event/${market.slug}`;
  return `https://polymarket.com/market/${market.id}`;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center text-[10px] font-mono font-medium tracking-wider text-muted-foreground/50 border border-border/25 rounded px-1.5 py-0.5">
      {children}
    </span>
  );
}

function CrossoverTimeline({
  crossovers,
  trades,
  marketStart,
  marketEnd,
}: {
  crossovers: Array<{ side: "UP" | "DOWN"; ts: number }>;
  trades: SimulatedTrade[];
  marketStart: number;
  marketEnd: number;
}) {
  const duration = marketEnd - marketStart;
  if (duration <= 0) return null;

  // Sort crossovers by timestamp
  const sortedCrossovers = [...crossovers].sort((a, b) => a.ts - b.ts);

  // Generate minute markers
  const minuteMarkers = [];
  const totalMinutes = Math.ceil(duration / (60 * 1000));
  for (let i = 0; i <= totalMinutes; i++) {
    const timeMs = marketStart + i * 60 * 1000;
    if (timeMs <= marketEnd) {
      const position = ((timeMs - marketStart) / duration) * 100;
      minuteMarkers.push({ time: timeMs, position });
    }
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        {/* Timeline background */}
        <div className="relative h-12 bg-muted/20 rounded border">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full h-px bg-border/30"></div>
          </div>

          {/* Crossover points */}
          {sortedCrossovers.map((crossover, i) => {
            const position = ((crossover.ts - marketStart) / duration) * 100;
            return (
              <div
                key={i}
                className="absolute top-1/2 transform -translate-y-1/2 -translate-x-1/2"
                style={{ left: `${Math.max(0, Math.min(100, position))}%` }}
                title={`${crossover.side} crossover @ ${new Date(crossover.ts).toLocaleTimeString()}`}
              >
                <div
                  className={`w-2 h-2 rounded-full ${
                    crossover.side === "UP"
                      ? "bg-green-500/70"
                      : "bg-red-500/70"
                  } border border-white/50`}
                />
              </div>
            );
          })}

          {/* Trade entry lines */}
          {trades.map((trade, i) => {
            const entryTime = new Date(trade.entryTs).getTime();
            const position = ((entryTime - marketStart) / duration) * 100;
            return (
              <div
                key={`trade-${i}`}
                className="absolute top-0 bottom-0 w-px bg-blue-500/50"
                style={{ left: `${Math.max(0, Math.min(100, position))}%` }}
                title={`Trade entry @ ${new Date(trade.entryTs).toLocaleTimeString()}`}
              />
            );
          })}
        </div>

        {/* Minute markers */}
        <div className="relative mt-1 pb-4">
          {minuteMarkers.map((marker, i) => (
            <div
              key={i}
              className="absolute transform -translate-x-1/2"
              style={{ left: `${marker.position}%` }}
            >
              <div className="w-px h-2 bg-border/50"></div>
              <div className="text-[10px] text-muted-foreground/70 mt-0.5 text-center font-mono">
                {i}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/15 last:border-b-0">
      <div className="px-4 pt-3 pb-1">
        <span className="text-[10px] font-mono font-medium tracking-[0.25em] text-muted-foreground/40 uppercase">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

/** 2-column grid wrapper for Cell items */
function Row2({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border/[0.08]">
      {children}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="px-4 py-2 flex flex-col gap-0.5">
      <span className="text-[10px] font-mono tracking-[0.18em] text-muted-foreground/40 uppercase">
        {label}
      </span>
      <span className="text-[12px] font-mono tabular-nums text-foreground/80 leading-tight">
        {value}
      </span>
    </div>
  );
}

function formatTs(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatTimeRemaining(endTime: number): string {
  const now = Date.now();
  const diff = endTime - now;
  if (diff <= 0) return "ENDED";

  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatTimeAgo(endTime: number): string {
  const now = Date.now();
  const diff = now - endTime;
  if (diff <= 0) return "ACTIVE";

  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function MarketDetailModal({
  market,
  trades,
  open,
  onClose,
}: MarketDetailModalProps) {
  if (!market) return null;

  const isActive = market.computedStatus === "ACTIVE";
  const windowLabel =
    MARKET_WINDOW_LABELS[market.windowType as MarketWindow] ??
    market.windowType;
  const polyUrl = polymarketMarketUrl(market);
  const crossovers = market.metadata?.crossovers || [];
  const marketTrades = trades.filter((trade) => trade.marketId === market.id);

  // Calculate crossovers before entry for trades
  const tradeCrossoverCounts = marketTrades.map((trade) => {
    const entryTime = new Date(trade.entryTs).getTime();
    const windowStart = entryTime - 60 * 1000; // 60 seconds before entry
    const count = crossovers.filter(
      (c) => c.ts >= windowStart && c.ts <= entryTime,
    ).length;
    return { trade, count };
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="w-[calc(100%-2rem)] sm:w-full sm:max-w-[520px] font-mono bg-background border-border/30 max-h-[90dvh] gap-0 p-0 overflow-hidden rounded-xl">
        {/* ── HEADER ── */}
        <div className="shrink-0 px-4 pt-4 pb-3 border-b border-border/20">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span
                className={`inline-flex items-center text-[10px] font-semibold tracking-[0.15em] px-2 py-0.5 rounded border ${
                  isActive
                    ? "text-emerald-400 border-emerald-400/25 bg-emerald-400/5"
                    : "text-amber-400 border-amber-400/25 bg-amber-400/5"
                }`}
              >
                {isActive ? "ACTIVE" : "ENDED"}
              </span>
              <Chip>{windowLabel}</Chip>
            </div>
            <div className="flex items-center gap-0.5 shrink-0 -mr-1 -mt-0.5">
              <a
                href={polyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 px-2 py-1.5 rounded text-[10px] font-mono text-muted-foreground/35 hover:text-blue-400 hover:bg-blue-500/5 transition-colors"
                aria-label="Open on Polymarket"
              >
                polymarket <ExternalLink size={10} strokeWidth={1.75} />
              </a>
              <button
                onClick={onClose}
                className="p-1.5 rounded text-muted-foreground/30 hover:text-foreground hover:bg-muted/40 transition-colors"
                aria-label="Close"
              >
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
          </div>

          <DialogTitle className="mt-2 text-[12px] font-sans font-normal text-foreground/65 leading-relaxed tracking-[0.01em]">
            {market.question}
          </DialogTitle>
        </div>

        {/* ── SCROLLABLE BODY ── */}
        <div className="overscroll-contain">
          {/* ── MARKET INFO ── */}
          <Section title="MARKET INFO">
            <Row2>
              <Cell label="ID" value={market.id.slice(0, 16) + "..."} />
              <Cell
                label="CONDITION ID"
                value={market.conditionId?.slice(0, 16) + "..." || "—"}
              />
              <Cell label="CATEGORY" value={market.category} />
              <Cell label="STATUS" value={isActive ? "ACTIVE" : "ENDED"} />
            </Row2>
          </Section>

          {/* ── TIMING ── */}
          <Section title="TIMING">
            <Row2>
              <Cell label="CREATED" value={formatTs(market.createdAt)} />
              <Cell
                label="ENDS"
                value={market.endDate ? formatTs(market.endDate) : "—"}
              />
              <Cell
                label={isActive ? "TIME REMAINING" : "ENDED"}
                value={
                  market.endDate
                    ? isActive
                      ? formatTimeRemaining(new Date(market.endDate).getTime())
                      : formatTimeAgo(new Date(market.endDate).getTime())
                    : "—"
                }
              />
              <Cell
                label="LAST FETCHED"
                value={
                  market.lastFetchedAt ? formatTs(market.lastFetchedAt) : "—"
                }
              />
            </Row2>
          </Section>

          {/* ── OSCILLATION ── */}
          {crossovers.length > 0 && (
            <Section title="OSCILLATION">
              <div className="px-4 pb-4 space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-mono text-muted-foreground">
                    CROSSOVERS: {crossovers.length}
                  </span>
                  {tradeCrossoverCounts.length > 0 && (
                    <span
                      className={`text-xs font-mono ${
                        tradeCrossoverCounts[0].count >= 3
                          ? "text-red-500"
                          : "text-green-600"
                      }`}
                    >
                      BEFORE ENTRY: {tradeCrossoverCounts[0].count}
                    </span>
                  )}
                </div>

                <CrossoverTimeline
                  crossovers={crossovers}
                  trades={marketTrades}
                  marketStart={
                    market.endDate
                      ? new Date(market.endDate).getTime() - 5 * 60 * 1000 // 5 minutes before end
                      : Date.now() - 24 * 60 * 60 * 1000 // fallback
                  }
                  marketEnd={
                    market.endDate
                      ? new Date(market.endDate).getTime()
                      : Date.now()
                  }
                />
              </div>
            </Section>
          )}

          {/* ── TRADES ── */}
          {marketTrades.length > 0 && (
            <Section title="TRADES">
              {marketTrades.map((trade) => (
                <div
                  key={trade.id}
                  className="px-4 py-3 border-b border-border/10 last:border-b-0"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${
                          trade.outcomeLabel === "Up"
                            ? "text-emerald-400 border-emerald-400/25 bg-emerald-400/5"
                            : "text-red-400 border-red-400/25 bg-red-400/5"
                        }`}
                      >
                        {trade.outcomeLabel || "UNKNOWN"}
                      </span>
                      <span
                        className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${
                          trade.status === "OPEN"
                            ? "text-blue-400 border-blue-400/25 bg-blue-400/5"
                            : trade.realizedPnl &&
                                parseFloat(trade.realizedPnl) > 0
                              ? "text-emerald-400 border-emerald-400/25 bg-emerald-400/5"
                              : "text-red-400 border-red-400/25 bg-red-400/5"
                        }`}
                      >
                        {trade.status === "OPEN"
                          ? "OPEN"
                          : trade.realizedPnl &&
                              parseFloat(trade.realizedPnl) > 0
                            ? "WIN"
                            : "LOSS"}
                      </span>
                    </div>
                    {trade.realizedPnl && (
                      <span
                        className={`text-[10px] font-mono font-bold tabular-nums ${
                          parseFloat(trade.realizedPnl) >= 0
                            ? "text-emerald-400"
                            : "text-red-400"
                        }`}
                      >
                        ${parseFloat(trade.realizedPnl).toFixed(4)}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-[10px] font-mono">
                    <div>
                      <span className="text-muted-foreground/60">ENTRY:</span>
                      <span className="ml-1 tabular-nums">
                        ${parseFloat(trade.entryPrice).toFixed(4)} ×{" "}
                        {parseFloat(trade.entryShares).toFixed(2)}
                      </span>
                    </div>
                    {trade.exitPrice && (
                      <div>
                        <span className="text-muted-foreground/60">EXIT:</span>
                        <span className="ml-1 tabular-nums">
                          ${parseFloat(trade.exitPrice).toFixed(4)}
                        </span>
                      </div>
                    )}
                    <div>
                      <span className="text-muted-foreground/60">
                        BTC @ ENTRY:
                      </span>
                      <span className="ml-1 tabular-nums">
                        $
                        {parseFloat(
                          trade.btcPriceAtEntry || "0",
                        ).toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted-foreground/60">TIME:</span>
                      <span className="ml-1">{formatTs(trade.entryTs)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </Section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
