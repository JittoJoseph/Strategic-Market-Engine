"use client";

import type { SimulatedTrade } from "@/lib/types";
import { MARKET_WINDOW_LABELS, type MarketWindow } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExternalLink, X } from "lucide-react";

interface TradeDetailPopupProps {
  trade: SimulatedTrade | null;
  open: boolean;
  onClose: () => void;
  /** Polymarket event slug for deep-linking (optional) */
  marketSlug?: string | null;
  /** Full market question shown in modal header */
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

  const isClosed = trade.status === "CLOSED";
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
  const windowLabel = trade.windowType
    ? (MARKET_WINDOW_LABELS[trade.windowType as MarketWindow] ??
      trade.windowType)
    : "—";

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg font-mono bg-background border-border flex flex-col max-h-[90vh] gap-0 p-0">
        {/* Sticky header with title, market question, and close button */}
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 border-b border-border/30 shrink-0">
          <div className="flex flex-col gap-1 min-w-0">
            <DialogHeader>
              <DialogTitle className="text-sm font-bold tracking-wider">
                TRADE DETAIL
              </DialogTitle>
            </DialogHeader>
            {marketQuestion && (
              <p className="text-[11px] font-mono text-muted-foreground/80 leading-snug">
                {marketQuestion}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 mt-0.5 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 px-5 py-4">
          <div className="space-y-4 text-xs">
            {/* Market info */}
            <Section title="MARKET">
              <Row label="Window Type" value={windowLabel} />
              <Row label="Outcome" value={trade.outcomeLabel || "—"} />
              <Row label="Order Type" value={trade.orderType || "—"} />
              <Row
                label="Polymarket"
                value={
                  trade.marketId ? (
                    <a
                      href={
                        marketSlug
                          ? `https://polymarket.com/event/${marketSlug}`
                          : `https://polymarket.com/market/${trade.marketId}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:text-blue-300 flex items-center gap-1 transition-colors"
                    >
                      Open on Polymarket <ExternalLink size={10} />
                    </a>
                  ) : (
                    "—"
                  )
                }
              />
            </Section>

            {/* Pricing */}
            <Section title="PRICING">
              <Row label="Entry Price" value={`$${entryPrice.toFixed(6)}`} />
              <Row
                label="Shares"
                value={parseFloat(trade.entryShares).toFixed(4)}
              />
              <Row
                label="Position Budget"
                value={`$${parseFloat(trade.positionBudget).toFixed(4)}`}
              />
              <Row
                label="Actual Cost"
                value={`$${parseFloat(trade.actualCost).toFixed(4)}`}
              />
              <Row label="Entry Fees" value={`$${entryFees.toFixed(6)}`} />
              {trade.minPriceDuringPosition && (
                <Row
                  label="Min Price (window)"
                  value={
                    <span className="text-amber-400">
                      {Math.round(
                        parseFloat(trade.minPriceDuringPosition) * 100,
                      )}
                      ¢
                      <span className="text-muted-foreground/50 ml-1 text-[10px]">
                        (Δ
                        {Math.round(
                          (entryPrice -
                            parseFloat(trade.minPriceDuringPosition)) *
                            100,
                        )}
                        ¢ from entry)
                      </span>
                    </span>
                  }
                />
              )}
            </Section>

            {/* Momentum Context */}
            {(trade.momentumDirection || trade.momentumChangeUsd) && (
              <Section title="MOMENTUM AT ENTRY">
                {trade.momentumDirection && (
                  <Row
                    label="Direction"
                    value={
                      <span
                        className={
                          trade.momentumDirection === "UP"
                            ? "text-emerald-500"
                            : trade.momentumDirection === "DOWN"
                              ? "text-red-500"
                              : "text-muted-foreground"
                        }
                      >
                        {trade.momentumDirection}
                      </span>
                    }
                  />
                )}
                {trade.momentumChangeUsd && (
                  <Row
                    label="BTC Change"
                    value={`$${parseFloat(trade.momentumChangeUsd).toFixed(2)}`}
                  />
                )}
              </Section>
            )}

            {/* BTC Context */}
            <Section title="BTC CONTEXT">
              <Row
                label="BTC at Entry"
                value={
                  btcAtEntry
                    ? `$${btcAtEntry.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : "—"
                }
              />
              {btcTarget !== null && btcTarget > 0 && (
                <Row
                  label="BTC Target"
                  value={`$${btcTarget.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                />
              )}
              {btcDist !== null && btcDist > 0 && (
                <Row label="BTC Distance" value={`$${btcDist.toFixed(2)}`} />
              )}
            </Section>

            {/* Result info */}
            <Section title="RESULT">
              <Row
                label="Status"
                value={
                  <span
                    className={
                      isClosed
                        ? pnl >= 0
                          ? "text-emerald-500"
                          : "text-red-500"
                        : "text-blue-500"
                    }
                  >
                    {isClosed ? "CLOSED" : "OPEN"}
                  </span>
                }
              />
              {trade.exitOutcome && (
                <Row
                  label="Outcome"
                  value={
                    <span
                      className={
                        trade.exitOutcome === "WIN"
                          ? "text-emerald-500"
                          : trade.exitOutcome === "STOP_LOSS"
                            ? "text-amber-500"
                            : "text-red-500"
                      }
                    >
                      {trade.exitOutcome}
                    </span>
                  }
                />
              )}
              {exitPrice !== null && (
                <Row label="Exit Price" value={`$${exitPrice.toFixed(6)}`} />
              )}
              {isClosed && (
                <Row
                  label="Realized PnL"
                  value={
                    <span
                      className={
                        pnl > 0
                          ? "text-emerald-500"
                          : pnl < 0
                            ? "text-red-500"
                            : "text-muted-foreground"
                      }
                    >
                      {pnl >= 0 ? "+" : ""}${pnl.toFixed(4)}
                    </span>
                  }
                />
              )}
            </Section>

            {/* Execution */}
            <Section title="EXECUTION">
              <Row
                label="Fill Status"
                value={
                  <span
                    className={
                      trade.fillStatus === "FULL"
                        ? "text-emerald-500"
                        : trade.fillStatus === "PARTIAL"
                          ? "text-amber-500"
                          : "text-red-500"
                    }
                  >
                    {trade.fillStatus || "—"}
                  </span>
                }
              />
            </Section>

            {/* Timestamps */}
            <Section title="TIMESTAMPS">
              <Row
                label="Opened"
                value={new Date(trade.entryTs).toLocaleString()}
              />
              {trade.exitTs && (
                <Row
                  label="Closed"
                  value={new Date(trade.exitTs).toLocaleString()}
                />
              )}
              {trade.exitTs && (
                <Row
                  label="Duration"
                  value={formatDuration(trade.entryTs, trade.exitTs)}
                />
              )}
            </Section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
    <div>
      <div className="text-[10px] text-muted-foreground tracking-widest border-b border-border/30 pb-1 mb-2">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  wide,
}: {
  label: string;
  value: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className={`flex ${wide ? "flex-col gap-0.5" : "justify-between items-center"}`}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
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
