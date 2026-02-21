"use client";

import type { SimulatedTrade, LiveMarketPrice } from "@/lib/types";
import { MARKET_WINDOW_LABELS, type MarketWindow } from "@/lib/types";

interface TradesTableProps {
  trades: SimulatedTrade[];
  loading: boolean;
  /** Real-time bid/ask/mid prices keyed by tokenId, refreshed every ~2s from WS */
  livePrices?: Record<string, LiveMarketPrice>;
  onTradeClick?: (trade: SimulatedTrade) => void;
}

export function TradesTable({
  trades,
  loading,
  livePrices = {},
  onTradeClick,
}: TradesTableProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex items-center gap-2 text-sm text-muted-foreground font-mono">
          <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-pulse" />
          Loading trades…
        </div>
      </div>
    );
  }

  if (trades.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-2">
        <div className="w-8 h-8 rounded-full border border-border/30 flex items-center justify-center text-muted-foreground/40 text-sm">
          ○
        </div>
        <div className="text-sm text-muted-foreground font-mono">
          No trades yet
        </div>
        <div className="text-xs text-muted-foreground/50 font-mono">
          Waiting for end-of-window opportunities…
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-border/30">
            <th className="text-left py-2.5 px-3 font-medium text-muted-foreground tracking-wider text-[10px]">
              WINDOW
            </th>
            <th className="text-left py-2.5 px-3 font-medium text-muted-foreground tracking-wider text-[10px]">
              SIDE
            </th>
            <th className="text-right py-2.5 px-3 font-medium text-muted-foreground tracking-wider text-[10px]">
              ENTRY
            </th>
            <th className="text-right py-2.5 px-3 font-medium text-muted-foreground tracking-wider text-[10px]">
              EXIT
            </th>
            <th className="text-right py-2.5 px-3 font-medium text-muted-foreground tracking-wider text-[10px]">
              SHARES
            </th>
            <th className="text-right py-2.5 px-3 font-medium text-muted-foreground tracking-wider text-[10px]">
              P&L
            </th>
            <th className="text-right py-2.5 px-3 font-medium text-muted-foreground tracking-wider text-[10px]">
              STATUS
            </th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade, idx) => {
            const entryPrice = parseFloat(trade.entryPrice);
            const entryCents = Math.round(entryPrice * 100);
            const shares = parseFloat(trade.entryShares || "0");
            const fees = parseFloat(trade.entryFees || "0");
            const usdAmount = parseFloat(trade.simulatedUsdAmount || "1");
            const isUp = trade.outcomeLabel === "Up";
            const isClosed = trade.status === "CLOSED";
            const isOpen = trade.status === "OPEN";

            // Exit price for closed trades
            const exitPrice = trade.exitPrice
              ? parseFloat(trade.exitPrice)
              : null;
            const exitCents =
              exitPrice !== null ? Math.round(exitPrice * 100) : null;

            // Live price for open trades
            const livePrice =
              isOpen && trade.tokenId
                ? (livePrices[trade.tokenId] ?? null)
                : null;
            const liveMid = livePrice?.mid ?? null;
            const liveCents =
              liveMid !== null ? Math.round(liveMid * 100) : null;

            // Unrealized P&L for open trades: (currentMid - entryPrice) * shares - fees
            const unrealizedPnl =
              liveMid !== null ? (liveMid - entryPrice) * shares - fees : null;

            // Realized P&L for closed trades
            const realizedPnl = parseFloat(trade.realizedPnl || "0");
            const hasPnl = isClosed && !!trade.realizedPnl;
            const pnlPositive = realizedPnl >= 0;

            // P&L percentages
            const realizedPnlPct = usdAmount > 0 ? (realizedPnl / usdAmount) * 100 : 0;
            const unrealizedPnlPct =
              unrealizedPnl !== null && usdAmount > 0
                ? (unrealizedPnl / usdAmount) * 100
                : null;

            // Window label
            const windowInfo = extractTimeWindow(trade);

            return (
              <tr
                key={trade.id}
                onClick={() => onTradeClick?.(trade)}
                className={`border-b border-border/5 cursor-pointer transition-colors duration-150 hover:bg-muted/15 ${
                  idx % 2 === 0 ? "bg-transparent" : "bg-card/5"
                } ${trade.status === "OPEN" ? "bg-emerald-500/5" : ""}`}
              >
                {/* WINDOW */}
                <td className="py-3 px-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-foreground text-xs">
                      {windowInfo.time}
                    </span>
                    <span className="text-[10px] text-muted-foreground/60">
                      {windowInfo.date}
                    </span>
                  </div>
                </td>

                {/* SIDE */}
                <td className="py-3 px-3">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider ${
                      isUp
                        ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20"
                        : "bg-red-500/10 text-red-500 border border-red-500/20"
                    }`}
                  >
                    <span className="text-[9px]">{isUp ? "▲" : "▼"}</span>
                    {isUp ? "UP" : "DOWN"}
                  </span>
                </td>

                {/* ENTRY */}
                <td className="py-3 px-3 text-right">
                  <span className="text-foreground tabular-nums">
                    {entryCents}¢
                  </span>
                </td>

                {/* EXIT */}
                <td className="py-3 px-3 text-right">
                  {exitCents !== null ? (
                    <span
                      className={`tabular-nums font-medium ${
                        exitCents >= entryCents
                          ? "text-emerald-500"
                          : "text-red-500"
                      }`}
                    >
                      {exitCents}¢
                    </span>
                  ) : liveCents !== null ? (
                    <div className="flex flex-col items-end gap-0.5">
                      <span
                        className={`tabular-nums font-medium ${
                          liveCents >= entryCents
                            ? "text-emerald-400"
                            : "text-red-400"
                        }`}
                      >
                        {liveCents}¢
                      </span>
                      <span className="text-[9px] text-blue-400 font-mono">
                        ● LIVE
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>

                {/* SHARES */}
                <td className="py-3 px-3 text-right tabular-nums text-muted-foreground">
                  {shares.toFixed(1)}
                </td>

                {/* P&L */}
                <td className="py-3 px-3 text-right">
                  {hasPnl ? (
                    <div className="flex flex-col items-end gap-0.5">
                      <span
                        className={`tabular-nums font-semibold ${
                          pnlPositive ? "text-emerald-500" : "text-red-500"
                        }`}
                      >
                        {pnlPositive ? "+" : "-"}${Math.abs(realizedPnl).toFixed(4)}
                      </span>
                      <span
                        className={`text-[10px] tabular-nums ${
                          pnlPositive ? "text-emerald-500/60" : "text-red-500/60"
                        }`}
                      >
                        {realizedPnlPct >= 0 ? "+" : ""}{realizedPnlPct.toFixed(2)}%
                      </span>
                    </div>
                  ) : unrealizedPnl !== null ? (
                    <div className="flex flex-col items-end gap-0.5">
                      <span
                        className={`tabular-nums font-semibold ${
                          unrealizedPnl >= 0
                            ? "text-emerald-400"
                            : "text-red-400"
                        }`}
                      >
                        {unrealizedPnl >= 0 ? "+" : "-"}${Math.abs(unrealizedPnl).toFixed(4)}
                      </span>
                      {unrealizedPnlPct !== null && (
                        <span
                          className={`text-[10px] tabular-nums ${
                            unrealizedPnlPct >= 0
                              ? "text-emerald-400/60"
                              : "text-red-400/60"
                          }`}
                        >
                          {unrealizedPnlPct >= 0 ? "+" : ""}{unrealizedPnlPct.toFixed(2)}%
                        </span>
                      )}
                      <span className="text-[9px] text-muted-foreground/50 font-mono">
                        unrealized
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>

                {/* STATUS */}
                <td className="py-3 px-3 text-right">
                  {isClosed ? (
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                        trade.exitOutcome === "WIN"
                          ? "bg-emerald-500/10 text-emerald-500"
                          : trade.exitOutcome === "STOP_LOSS"
                            ? "bg-amber-500/10 text-amber-500"
                            : "bg-muted/40 text-muted-foreground"
                      }`}
                    >
                      {trade.exitOutcome || "CLOSED"}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/10 text-blue-500">
                      <span className="w-1 h-1 rounded-full bg-blue-500 animate-pulse" />
                      OPEN
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Helpers ──────────────────────────────────────────────── */

function extractTimeWindow(trade: SimulatedTrade): {
  time: string;
  date: string;
} {
  const entryDate = new Date(trade.entryTs);
  const windowType = trade.windowType as MarketWindow | null;
  const label = windowType
    ? (MARKET_WINDOW_LABELS[windowType] ?? windowType)
    : "";

  const fmt = (d: Date) =>
    d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

  return {
    time: `${fmt(entryDate)} ${label ? `(${label})` : ""}`.trim(),
    date: entryDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
  };
}
