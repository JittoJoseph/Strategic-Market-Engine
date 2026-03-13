"use client";

import type { SimulatedTrade } from "@/lib/types";
import { MARKET_WINDOW_LABELS, type MarketWindow } from "@/lib/types";
import { formatPnl, pnlColor } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ExternalLink, X } from "lucide-react";

interface TradeDetailPopupProps {
  trade: SimulatedTrade | null;
  open: boolean;
  onClose: () => void;
  marketSlug?: string | null;
  marketQuestion?: string | null;
}

export function TradeDetailPopup({
  trade,
  open,
  onClose,
  marketSlug,
  marketQuestion,
}: TradeDetailPopupProps) {
  if (!trade) return null;

  const isClosed = trade.status === "SETTLED";
  const entryPrice = parseFloat(trade.entryPrice);
  const entryFees = parseFloat(trade.entryFees || "0");
  const pnl = parseFloat(trade.realizedPnl || "0");
  const exitPrice = trade.exitPrice ? parseFloat(trade.exitPrice) : null;
  const btcAtEntry = trade.btcPriceAtEntry
    ? parseFloat(trade.btcPriceAtEntry)
    : null;
  const btcTarget = trade.btcTargetPrice
    ? parseFloat(trade.btcTargetPrice)
    : null;
  const btcDist = trade.btcDistanceUsd
    ? parseFloat(trade.btcDistanceUsd)
    : null;
  const minPrice = trade.minPriceDuringPosition
    ? parseFloat(trade.minPriceDuringPosition)
    : null;
  const shares = parseFloat(trade.entryShares);
  const budget = parseFloat(trade.positionBudget);
  const actualCost = parseFloat(trade.actualCost);

  const windowLabel = trade.windowType
    ? (MARKET_WINDOW_LABELS[trade.windowType as MarketWindow] ??
      trade.windowType)
    : null;

  const outcome = trade.exitOutcome;
  const isWin = outcome === "WIN";

  const polyUrl =
    (marketSlug ?? trade.marketSlug)
      ? `https://polymarket.com/event/${marketSlug ?? trade.marketSlug}`
      : `https://polymarket.com/market/${trade.marketId}`;

  const resolvedQuestion = marketQuestion ?? trade.marketQuestion;

  const returnPct = actualCost > 0 ? (pnl / actualCost) * 100 : 0;

  const fmtBtc = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  /* ─── Badge colour helpers ─── */
  // exitOutcome is "WIN" or "LOSS" (STOP_LOSS is logged in audit, not stored in trade)
  const statusBadgeCls = !isClosed
    ? "text-blue-400 border-blue-400/25 bg-blue-400/5"
    : isWin
      ? "text-emerald-400 border-emerald-500/25 bg-emerald-500/5"
      : "text-red-400 border-red-500/25 bg-red-500/5";

  return (
    <Dialog open={open} onOpenChange={onClose}>
      {/*
        w-[calc(100%-2rem)]  → full-width minus 1rem each side on mobile
        sm:max-w-[520px]     → cap at 520px on larger screens
        The base DialogContent has p-6; we reset it to p-0 and control padding manually.
      */}
      <DialogContent className="w-[calc(100%-2rem)] sm:w-full sm:max-w-[520px] font-mono bg-background border-border/30 flex flex-col max-h-[90dvh] gap-0 p-0 overflow-hidden rounded-xl">
        {/* ── HEADER ── */}
        <div className="shrink-0 px-4 pt-4 pb-3 border-b border-border/20">
          {/* Row 1: chips + actions */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              {/* Status / outcome badge */}
              <span
                className={`inline-flex items-center text-[10px] font-semibold tracking-[0.15em] px-2 py-0.5 rounded border ${statusBadgeCls}`}
              >
                {isClosed ? (outcome ?? "SETTLED") : "OPEN"}
              </span>
              {windowLabel && <Chip>{windowLabel}</Chip>}
              {trade.marketCategory && (
                <Chip>{trade.marketCategory.toUpperCase()}</Chip>
              )}
              {trade.outcomeLabel && <Chip>{trade.outcomeLabel}</Chip>}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-0.5 shrink-0 -mr-1 -mt-0.5">
              {trade.marketId && (
                <a
                  href={polyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 px-2 py-1.5 rounded text-[10px] font-mono text-muted-foreground/35 hover:text-blue-400 hover:bg-blue-500/5 transition-colors"
                  aria-label="Open on Polymarket"
                >
                  polymarket <ExternalLink size={10} strokeWidth={1.75} />
                </a>
              )}
              <button
                onClick={onClose}
                className="p-1.5 rounded text-muted-foreground/30 hover:text-foreground hover:bg-muted/40 transition-colors"
                aria-label="Close"
              >
                <X size={15} strokeWidth={1.75} />
              </button>
            </div>
          </div>

          {/* Row 2: Market question */}
          {resolvedQuestion ? (
            <DialogTitle className="mt-2 text-[12px] font-sans font-normal text-foreground/65 leading-relaxed tracking-[0.01em]">
              {resolvedQuestion}
            </DialogTitle>
          ) : (
            /* DialogTitle must always be rendered for a11y */
            <DialogTitle className="sr-only">Trade Detail</DialogTitle>
          )}
        </div>

        {/* ── PnL HERO — closed trades only ── */}
        {isClosed && (
          <div
            className={`shrink-0 flex items-center justify-between gap-4 px-4 py-2.5 border-b border-border/20 ${pnl >= 0 ? "bg-emerald-500/[0.035]" : "bg-red-500/[0.035]"}`}
          >
            <div className="flex items-baseline gap-2">
              <Label>P&L</Label>
              <span
                className={`text-[15px] font-bold tabular-nums tracking-tight leading-none ${pnlColor(pnl)}`}
              >
                {formatPnl(pnl)}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <Label>RETURN</Label>
              <span
                className={`text-[14px] font-bold tabular-nums leading-none ${pnlColor(pnl)}`}
              >
                {returnPct >= 0 ? "+" : ""}
                {returnPct.toFixed(2)}%
              </span>
            </div>
          </div>
        )}

        {/* ── SCROLLABLE BODY ── */}
        <div className="overflow-y-auto flex-1 overscroll-contain">
          {/* ── EXECUTION ── */}
          <Section title="EXECUTION">
            <Row2>
              <Cell
                label="ENTRY PRICE"
                value={`${(entryPrice * 100).toFixed(3)}¢`}
              />
              <Cell
                label="EXIT PRICE"
                value={
                  exitPrice !== null ? `${(exitPrice * 100).toFixed(3)}¢` : "—"
                }
              />
              <Cell label="SHARES" value={shares.toFixed(4)} />
              <Cell
                label="SIDE"
                value={
                  <span
                    className={
                      trade.side === "BUY"
                        ? "text-emerald-400"
                        : trade.side === "SELL"
                          ? "text-red-400"
                          : "text-foreground/70"
                    }
                  >
                    {trade.side}
                  </span>
                }
              />
              <Cell label="BUDGET" value={`$${budget.toFixed(4)}`} />
              <Cell label="ACTUAL COST" value={`$${actualCost.toFixed(4)}`} />
              <Cell label="ENTRY FEES" value={`$${entryFees.toFixed(6)}`} />
              <Cell
                label="FILL STATUS"
                value={
                  <span
                    className={
                      trade.fillStatus === "FULL"
                        ? "text-emerald-400"
                        : trade.fillStatus === "PARTIAL"
                          ? "text-amber-400"
                          : "text-muted-foreground/60"
                    }
                  >
                    {trade.fillStatus ?? "—"}
                  </span>
                }
              />
              {/* Min price spans full width when present */}
              {minPrice !== null && minPrice > 0 && minPrice < entryPrice && (
                <div className="col-span-2 flex items-center justify-between py-2 px-4 border-t border-border/10 bg-amber-500/[0.03]">
                  <span className="text-[10px] tracking-[0.18em] text-muted-foreground/45">
                    MIN PRICE DURING WINDOW
                  </span>
                  <span className="text-[13px] tabular-nums text-amber-400">
                    {(minPrice * 100).toFixed(3)}¢
                    <span className="text-muted-foreground/35 ml-2 text-[11px]">
                      −{((entryPrice - minPrice) * 100).toFixed(3)}¢ draw
                    </span>
                  </span>
                </div>
              )}
            </Row2>
          </Section>

          {/* ── BTC CONTEXT ── */}
          {(btcAtEntry !== null ||
            (btcTarget !== null && btcTarget > 0) ||
            (btcDist !== null && btcDist > 0) ||
            trade.momentumDirection ||
            trade.crossovers) && (
            <Section title="BTC CONTEXT">
              <Row2>
                {btcAtEntry !== null && (
                  <Cell label="AT ENTRY" value={fmtBtc(btcAtEntry)} />
                )}
                {btcTarget !== null && btcTarget > 0 && (
                  <Cell label="TARGET" value={fmtBtc(btcTarget)} />
                )}
                {btcDist !== null && btcDist > 0 && (
                  <Cell label="DISTANCE" value={`$${btcDist.toFixed(2)}`} />
                )}
                {trade.momentumDirection && (
                  <Cell
                    label="MOMENTUM"
                    value={
                      <span
                        className={
                          trade.momentumDirection === "UP"
                            ? "text-emerald-400"
                            : trade.momentumDirection === "DOWN"
                              ? "text-red-400"
                              : "text-foreground/60"
                        }
                      >
                        {trade.momentumDirection}
                        {trade.momentumChangeUsd && (
                          <span className="text-muted-foreground/40 ml-2 font-mono">
                            $
                            {Math.abs(
                              parseFloat(trade.momentumChangeUsd),
                            ).toFixed(0)}
                          </span>
                        )}
                      </span>
                    }
                  />
                )}
                {trade.crossovers && (
                  <Cell
                    label="WINDOW CROSSOVERS"
                    value={
                      <span
                        className="cursor-help"
                        title={
                          trade.crossovers.details.length > 0
                            ? trade.crossovers.details
                                .map(
                                  (c) =>
                                    `${c.side} @ ${formatTs(new Date(c.ts).toISOString())}`,
                                )
                                .join(" | ")
                            : "None"
                        }
                      >
                        {trade.crossovers.all}
                      </span>
                    }
                  />
                )}
                {trade.crossovers && (
                  <Cell
                    label="LAST 60S CROSSOVERS"
                    value={
                      <span
                        className="cursor-help"
                        title={
                          trade.crossovers.details.filter(
                            (c) =>
                              c.ts >= new Date(trade.entryTs).getTime() - 60000,
                          ).length > 0
                            ? trade.crossovers.details
                                .filter(
                                  (c) =>
                                    c.ts >=
                                    new Date(trade.entryTs).getTime() - 60000,
                                )
                                .map(
                                  (c) =>
                                    `${c.side} @ ${formatTs(new Date(c.ts).toISOString())}`,
                                )
                                .join(" | ")
                            : "None"
                        }
                      >
                        {trade.crossovers.last60s}
                      </span>
                    }
                  />
                )}
              </Row2>
            </Section>
          )}

          {/* ── RESULT (only if settled) ── */}
          {isClosed && outcome && (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border/15">
              <span className="text-[10px] font-mono tracking-[0.2em] text-muted-foreground/35 uppercase">
                RESULT
              </span>
              <span className="text-muted-foreground/20">/</span>
              <span className="text-zinc-400 text-[11px] font-mono tracking-wider">
                SETTLED
              </span>
              <span className="text-muted-foreground/20">·</span>
              <span
                className={`text-[11px] font-mono font-semibold tracking-wider ${isWin ? "text-emerald-400" : "text-red-400"}`}
              >
                {outcome}
              </span>
            </div>
          )}

          {/* ── TIMESTAMPS ── */}
          <div className="border-b border-border/15 last:border-b-0 pb-3">
            <div className="px-4 pt-3 pb-1">
              <span className="text-[10px] font-mono font-medium tracking-[0.25em] text-muted-foreground/40 uppercase">
                TIMESTAMPS
              </span>
            </div>
            <Row2>
              <Cell label="OPENED" value={formatTs(trade.entryTs)} />
              <Cell
                label="CLOSED"
                value={trade.exitTs ? formatTs(trade.exitTs) : "—"}
              />
              {trade.marketEndDate && (
                <Cell
                  label="MARKET ENDS"
                  value={formatTs(trade.marketEndDate)}
                />
              )}
              {trade.exitTs && (
                <Cell
                  label="HOLD DURATION"
                  value={formatDuration(trade.entryTs, trade.exitTs)}
                />
              )}
            </Row2>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────── Primitives ─────────────── */

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center text-[10px] font-mono font-medium tracking-wider text-muted-foreground/50 border border-border/25 rounded px-1.5 py-0.5">
      {children}
    </span>
  );
}

/** Micro-label used in the PnL hero */
function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-[10px] font-mono tracking-[0.2em] text-muted-foreground/40 uppercase">
      {children}
    </span>
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

/* ─────────────── Formatters ─────────────── */

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

function formatDuration(start: string, end: string): string {
  const diffMs = new Date(end).getTime() - new Date(start).getTime();
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}
