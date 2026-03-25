"use client";

import type { ActivityEntry } from "@/lib/types";
import { formatPnl } from "@/lib/utils";

const KIND_META: Record<
  ActivityEntry["kind"],
  { dot: string; badge: string; label: string }
> = {
  TRADE_OPENED: {
    dot: "bg-blue-400",
    badge: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    label: "OPENED",
  },
  TRADE_WIN: {
    dot: "bg-emerald-400",
    badge: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    label: "WIN",
  },
  TRADE_LOSS: {
    dot: "bg-red-400",
    badge: "bg-red-500/10 text-red-400 border-red-500/20",
    label: "LOSS",
  },
  MOMENTUM_SKIP: {
    dot: "bg-amber-400",
    badge: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    label: "SKIPPED",
  },
  MARKET_RESOLVED: {
    dot: "bg-purple-400",
    badge: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    label: "RESOLVED",
  },
  SYSTEM: {
    dot: "bg-muted-foreground/40",
    badge: "bg-muted/40 text-muted-foreground border-border/30",
    label: "SYSTEM",
  },
  INFO: {
    dot: "bg-muted-foreground/40",
    badge: "bg-muted/40 text-muted-foreground border-border/30",
    label: "INFO",
  },
  WARN: {
    dot: "bg-amber-500",
    badge: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    label: "WARN",
  },
  ERROR: {
    dot: "bg-red-500",
    badge: "bg-red-500/10 text-red-400 border-red-500/20",
    label: "ERROR",
  },
};

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

interface ActivityPanelProps {
  activities: ActivityEntry[];
  loading: boolean;
}

export function ActivityPanel({ activities, loading }: ActivityPanelProps) {
  if (loading) {
    return (
      <div className="p-6 text-center text-xs text-muted-foreground font-mono animate-pulse">
        Loading activity…
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="p-6 text-center text-xs text-muted-foreground/40 font-mono">
        No activity yet — trades and system events will appear here in
        real-time.
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/10 overflow-y-auto max-h-[480px]">
      {activities.map((entry) => {
        const meta = KIND_META[entry.kind] ?? KIND_META["INFO"];
        const hasPnl = entry.pnl !== undefined && entry.pnl !== null;

        return (
          <div
            key={entry.id}
            className="flex items-start gap-3 px-4 py-3 hover:bg-muted/10 transition-colors"
          >
            {/* Dot */}
            <div className="mt-1.5 shrink-0">
              <div className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                {/* Kind badge */}
                <span
                  className={`text-[9px] font-mono font-bold border rounded px-1.5 py-0.5 ${meta.badge}`}
                >
                  {meta.label}
                </span>

                {/* PnL badge for trade results */}
                {hasPnl && (
                  <span
                    className={`text-[9px] font-mono font-bold tabular-nums ${
                      (entry.pnl ?? 0) >= 0
                        ? "text-emerald-400"
                        : "text-red-400"
                    }`}
                  >
                    {formatPnl(entry.pnl ?? 0)}
                  </span>
                )}

                {/* Timestamp */}
                <span className="ml-auto text-[9px] font-mono text-muted-foreground/40 tabular-nums shrink-0">
                  {timeAgo(entry.ts)}
                </span>
              </div>

              {/* Detail line */}
              <div className="text-xs font-mono text-muted-foreground leading-snug truncate">
                {entry.detail}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
