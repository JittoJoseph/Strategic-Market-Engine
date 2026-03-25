"use client";

import { useSystemStatus } from "@/lib/hooks";
import type { SystemStats } from "@/lib/types";

export function SystemStatusIndicator({
  stats,
}: {
  stats?: SystemStats | null;
}) {
  const { backendActive, wsConnected } = useSystemStatus();

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-background/90 backdrop-blur-sm border-t border-border/40">
      <div className="container mx-auto px-4 py-2 flex items-center justify-between text-[10px] font-mono text-muted-foreground">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div
              className={`w-1.5 h-1.5 rounded-full ${backendActive ? "bg-emerald-500" : "bg-red-500"}`}
            />
            <span>{backendActive ? "BACKEND ACTIVE" : "BACKEND OFFLINE"}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className={`w-1.5 h-1.5 rounded-full ${wsConnected ? "bg-emerald-500" : "bg-amber-500"}`}
            />
            <span>{wsConnected ? "WS CONNECTED" : "WS DISCONNECTED"}</span>
          </div>
        </div>
        {stats && (
          <div className="flex items-center gap-4">
            <span>POSITIONS: {stats.orchestrator.openPositions}</span>
            <span>MARKETS: {stats.orchestrator.activeMarkets}</span>
            <span>CYCLES: {stats.orchestrator.cycleCount}</span>
          </div>
        )}
      </div>
    </div>
  );
}
