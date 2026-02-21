"use client";

import type { SimulatedTrade } from "@/lib/types";
import { MARKET_WINDOW_LABELS, type MarketWindow } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExternalLink } from "lucide-react";

interface TradeDetailPopupProps {
  trade: SimulatedTrade | null;
  open: boolean;
  onClose: () => void;
  /** Polymarket event slug for deep-linking (optional) */
  marketSlug?: string | null;
}

export function TradeDetailPopup({
  trade,
  open,
  onClose,
  marketSlug,
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
      <DialogContent className="max-w-lg font-mono bg-background border-border">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold tracking-wider">
            TRADE DETAIL
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-xs">
          {/* Market info */}
          <Section title="MARKET">
            <Row label="Window Type" value={windowLabel} />
            <Row
              label="Market ID"
              value={trade.marketId ? trade.marketId : "—"}
            />
            <Row label="Outcome" value={trade.outcomeLabel || "—"} />
            <Row label="Order Type" value={trade.orderType || "—"} />
            <Row
              label="Token ID"
              value={trade.tokenId ? trade.tokenId.slice(0, 24) + "…" : "—"}
            />
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
            {trade.experimentId && (
              <Row label="Experiment" value={trade.experimentId} />
            )}
          </Section>

          {/* Pricing */}
          <Section title="PRICING">
            <Row label="Entry Price" value={`$${entryPrice.toFixed(6)}`} />
            <Row
              label="Shares"
              value={parseFloat(trade.entryShares).toFixed(4)}
            />
            <Row
              label="USD Amount"
              value={`$${parseFloat(trade.simulatedUsdAmount).toFixed(4)}`}
            />
            <Row label="Entry Fees" value={`$${entryFees.toFixed(6)}`} />
            {trade.feeRateBps != null && (
              <Row label="Fee Rate" value={`${trade.feeRateBps} bps`} />
            )}
          </Section>

          {/* BTC Context */}
          <Section title="BTC CONTEXT">
            <Row
              label="BTC at Entry"
              value={btcAtEntry ? `$${btcAtEntry.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}
            />
            {btcTarget !== null && btcTarget > 0 && (
              <Row
                label="BTC Target"
                value={`$${btcTarget.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              />
            )}
            {btcDist !== null && btcDist > 0 && (
              <Row
                label="BTC Distance"
                value={`$${btcDist.toFixed(2)}`}
              />
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
            {trade.strategyTrigger && (
              <Row label="Strategy Trigger" value={trade.strategyTrigger} />
            )}
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
