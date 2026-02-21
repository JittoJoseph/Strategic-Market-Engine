"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { Header } from "./header";
import { SystemStatusIndicator } from "./system-status-indicator";
import { OverviewPanels } from "./overview-panels";
import { TradesTable } from "./trades-table";
import { TradeDetailPopup } from "./trade-detail-popup";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useTrades,
  useSystemStats,
  useActiveMarkets,
  useWsConnection,
  useWsEvent,
  useLiveMarkets,
  useCountdown,
} from "@/lib/hooks";
import type {
  SimulatedTrade,
  DiscoveredMarket,
  SystemStats,
  LiveMarketInfo,
  LiveMarketPrice,
} from "@/lib/types";
import { MARKET_WINDOW_LABELS, type MarketWindow } from "@/lib/types";

export function DashboardPage() {
  const [activeTab, setActiveTab] = useState("trades");
  const [selectedTrade, setSelectedTrade] = useState<SimulatedTrade | null>(
    null,
  );
  const [mounted, setMounted] = useState(false);
  const [btcPrice, setBtcPrice] = useState<{
    price: number;
    timestamp: number;
  } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Data hooks — trades are now fully WS-driven (no polling)
  const { trades, loading: tradesLoading } = useTrades(undefined, 100);
  const { stats, loading: statsLoading } = useSystemStats();
  const {
    markets,
    loading: marketsLoading,
    refetch: refetchMarkets,
  } = useActiveMarkets();

  // Real-time market prices from WS systemState broadcast
  const liveMarkets = useLiveMarkets();

  // WebSocket live events
  useWsConnection();

  // Update BTC price from systemState broadcasts
  useWsEvent(
    "systemState",
    useCallback((msg: any) => {
      const data = msg?.data;
      if (data?.btcPrice) {
        setBtcPrice(data.btcPrice);
      }
    }, []),
  );

  // Derive counts
  const openTrades = useMemo(
    () => trades.filter((t) => t.status === "OPEN"),
    [trades],
  );

  // Primary live market (earliest ending, from getLiveMarkets sorted output)
  const primaryMarket = liveMarkets[0] ?? null;

  // Flat map of all live prices keyed by tokenId, for TradesTable real-time P&L
  const livePricesMap = useMemo<Record<string, LiveMarketPrice>>(() => {
    const map: Record<string, LiveMarketPrice> = {};
    for (const m of liveMarkets) {
      for (const [tokenId, price] of Object.entries(m.prices)) {
        map[tokenId] = price;
      }
    }
    return map;
  }, [liveMarkets]);

  // Determine window label from config
  const windowLabel = stats?.config?.marketWindow
    ? (MARKET_WINDOW_LABELS[stats.config.marketWindow as MarketWindow] ??
      stats.config.marketWindow)
    : "BTC WINDOW";

  // Current BTC price (prefer WS-updated, fallback to stats)
  const currentBtcPrice = btcPrice ?? stats?.btcPrice ?? null;

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <Header />

      <main className="flex-1 px-4 py-4 pb-16 max-w-7xl mx-auto w-full space-y-4">
        {/* ── BTC Status Panel ────────────── */}
        <BtcStatusPanel
          stats={stats}
          btcPrice={currentBtcPrice}
          primaryMarket={primaryMarket}
          activeMarketsCount={markets.length}
          openTradesCount={openTrades.length}
          windowLabel={windowLabel}
          mounted={mounted}
        />

        {/* ── Performance overview ──────── */}
        <OverviewPanels />

        {/* ── Two-column: Trades + Sidebar ─────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
          {/* Left: Trades panel */}
          <div className="border border-border/30 rounded-lg bg-card/30 overflow-hidden">
            <Tabs
              value={activeTab}
              onValueChange={setActiveTab}
              className="w-full"
            >
              <div className="flex items-center justify-between border-b border-border/30 px-3 py-2">
                <TabsList className="bg-transparent gap-2 h-auto p-0">
                  <TabsTrigger
                    value="trades"
                    className="data-[state=active]:bg-muted/40 rounded px-3 py-1 text-xs font-mono"
                  >
                    TRADES ({trades.length})
                  </TabsTrigger>
                  <TabsTrigger
                    value="markets"
                    className="data-[state=active]:bg-muted/40 rounded px-3 py-1 text-xs font-mono"
                  >
                    MARKETS ({markets.length})
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="trades" className="mt-0">
                <TradesTable
                  trades={trades}
                  loading={tradesLoading}
                  livePrices={livePricesMap}
                  onTradeClick={setSelectedTrade}
                />
              </TabsContent>

              <TabsContent value="markets" className="mt-0">
                <MarketsPanel
                  markets={markets}
                  loading={marketsLoading}
                  refetch={refetchMarkets}
                />
              </TabsContent>
            </Tabs>
          </div>

          {/* Right: Sidebar */}
          <div className="space-y-4">
            {/* System stats */}
            <SidebarCard title="SYSTEM">
              {statsLoading ? (
                <div className="text-xs text-muted-foreground animate-pulse font-mono py-4 text-center">
                  Loading...
                </div>
              ) : stats ? (
                <div className="space-y-2 text-xs font-mono">
                  <StatRow label="Window Type" value={windowLabel} />
                  <StatRow
                    label="Open Positions"
                    value={stats.orchestrator.openPositions.toString()}
                  />
                  <StatRow
                    label="Active Markets"
                    value={stats.orchestrator.activeMarkets.toString()}
                  />
                  <StatRow
                    label="Scan Cycles"
                    value={stats.orchestrator.cycleCount.toString()}
                  />
                  <StatRow
                    label="Discovered"
                    value={stats.orchestrator.scanner.discoveredCount.toString()}
                  />
                  <StatRow
                    label="Scanner"
                    value={stats.orchestrator.running ? "ACTIVE" : "IDLE"}
                    accent={stats.orchestrator.running}
                  />
                  <StatRow
                    label="CLOB WS"
                    value={
                      stats.orchestrator.ws.connected
                        ? "CONNECTED"
                        : "DISCONNECTED"
                    }
                    accent={stats.orchestrator.ws.connected}
                  />
                  <StatRow
                    label="BTC Feed"
                    value={stats.orchestrator.btcConnected ? "LIVE" : "OFFLINE"}
                    accent={stats.orchestrator.btcConnected}
                  />
                </div>
              ) : null}
            </SidebarCard>

            {/* Configuration */}
            <SidebarCard title="CONFIGURATION">
              {stats?.config ? (
                <div className="space-y-2 text-xs font-mono">
                  <StatRow
                    label="Entry Threshold"
                    value={`${(stats.config.entryPriceThreshold * 100).toFixed(0)}¢`}
                  />
                  <StatRow
                    label="Trade Window"
                    value={`${stats.config.tradeFromWindowSeconds}s`}
                  />
                  <StatRow
                    label="Sim Amount"
                    value={`$${stats.config.simulationAmountUsd}`}
                  />
                  <StatRow
                    label="Max Positions"
                    value={stats.config.maxSimultaneousPositions.toString()}
                  />
                  <StatRow
                    label="BTC Min Dist"
                    value={`$${stats.config.minBtcDistanceUsd}`}
                  />
                  <StatRow
                    label="Stop Loss"
                    value={`${(stats.config.stopLossThreshold * 100).toFixed(0)}¢`}
                  />
                </div>
              ) : (
                <div className="text-xs text-muted-foreground font-mono py-4 text-center">
                  Loading...
                </div>
              )}
            </SidebarCard>
          </div>
        </div>
      </main>

      <SystemStatusIndicator stats={stats} />

      <TradeDetailPopup
        trade={selectedTrade}
        open={selectedTrade !== null}
        onClose={() => setSelectedTrade(null)}
      />
    </div>
  );
}

/* ─── Sub-components ───────────────────────────────────────── */

function polymarketUrl(market: LiveMarketInfo): string {
  if (market.slug) return `https://polymarket.com/event/${market.slug}`;
  return `https://polymarket.com/market/${market.marketId}`;
}

function polymarketMarketUrl(market: DiscoveredMarket): string {
  if (market.slug) return `https://polymarket.com/event/${market.slug}`;
  return `https://polymarket.com/market/${market.id}`;
}

function BtcStatusPanel({
  stats,
  btcPrice,
  primaryMarket,
  activeMarketsCount,
  openTradesCount,
  windowLabel,
  mounted,
}: {
  stats: SystemStats | null;
  btcPrice: { price: number; timestamp: number } | null;
  primaryMarket: LiveMarketInfo | null;
  activeMarketsCount: number;
  openTradesCount: number;
  windowLabel: string;
  mounted: boolean;
}) {
  const isRunning = stats?.orchestrator.running ?? false;

  // Countdown to primary market end
  const countdown = useCountdown(primaryMarket?.endDate ?? null);

  // Live UP / DOWN prices from primary market
  const upPrice = primaryMarket
    ? (primaryMarket.prices[primaryMarket.yesTokenId]?.mid ?? null)
    : null;
  const downPrice = primaryMarket
    ? (primaryMarket.prices[primaryMarket.noTokenId]?.mid ?? null)
    : null;

  const fmtPct = (v: number | null) =>
    v !== null ? `${(v * 100).toFixed(1)}¢` : "—";

  const fmtCountdown = () => {
    if (!countdown) return "—";
    if (countdown.expired) return "EXPIRED";
    const { days, hours, minutes, seconds } = countdown;
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    return `${minutes}m ${seconds}s`;
  };

  return (
    <div className="border border-border/30 rounded-lg bg-card/30 overflow-hidden">
      {/* Active market question strip */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/20 bg-card/20 min-h-[32px]">
        {primaryMarket ? (
          <>
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse flex-shrink-0" />
            <span className="text-xs font-mono text-muted-foreground truncate">
              {primaryMarket.question}
            </span>
          </>
        ) : (
          <span className="text-xs font-mono text-muted-foreground/50">
            Waiting for active market…
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 p-4 min-h-[140px]">
        {/* BTC PRICE */}
        <div className="col-span-1 lg:col-span-4 bg-gradient-to-br from-card/40 to-card/20 rounded-xl border border-border/20 p-3 lg:p-4 flex flex-col justify-center items-center relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-amber-500/5 via-transparent to-blue-500/5" />
          <div className="relative z-10 text-center">
            <div className="flex items-center justify-center gap-2 mb-1">
              <div
                className={`w-2 h-2 rounded-full ${
                  btcPrice
                    ? "bg-emerald-500 animate-pulse shadow-emerald-500/50 shadow-lg"
                    : "bg-muted-foreground/40"
                }`}
              />
              <span className="text-xs font-mono tracking-widest text-muted-foreground font-medium">
                BTC/USDT
              </span>
            </div>
            <div className="text-3xl lg:text-4xl font-bold font-mono tabular-nums mb-1 text-foreground">
              {btcPrice
                ? `$${btcPrice.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : "—"}
            </div>
            <div className="text-xs font-mono text-muted-foreground tracking-wider">
              {windowLabel}
            </div>
          </div>
        </div>

        {/* UP / DOWN PRICE BUTTONS */}
        <div className="col-span-1 lg:col-span-4 flex flex-col gap-2 justify-center">
          {/* UP button */}
          <a
            href={primaryMarket ? polymarketUrl(primaryMarket) : undefined}
            target="_blank"
            rel="noopener noreferrer"
            className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border transition-colors ${
              upPrice !== null
                ? "border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 cursor-pointer"
                : "border-border/20 bg-card/20 opacity-50 cursor-default pointer-events-none"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-lg leading-none">▲</span>
              <span className="text-xs font-mono font-bold text-emerald-400">
                UP
              </span>
            </div>
            <span className="text-base font-bold font-mono tabular-nums text-emerald-400">
              {fmtPct(upPrice)}
            </span>
          </a>

          {/* DOWN button */}
          <a
            href={primaryMarket ? polymarketUrl(primaryMarket) : undefined}
            target="_blank"
            rel="noopener noreferrer"
            className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border transition-colors ${
              downPrice !== null
                ? "border-red-500/40 bg-red-500/10 hover:bg-red-500/20 cursor-pointer"
                : "border-border/20 bg-card/20 opacity-50 cursor-default pointer-events-none"
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="text-lg leading-none">▼</span>
              <span className="text-xs font-mono font-bold text-red-400">
                DOWN
              </span>
            </div>
            <span className="text-base font-bold font-mono tabular-nums text-red-400">
              {fmtPct(downPrice)}
            </span>
          </a>
        </div>

        {/* TIMER + ENGINE STATUS + POLYMARKET LINK */}
        <div className="col-span-1 lg:col-span-4 flex flex-col gap-2">
          {/* Countdown */}
          <div className="bg-card/20 rounded-lg p-2 flex items-center justify-between">
            <div className="text-xs font-mono text-muted-foreground">
              ⏱ CLOSES IN
            </div>
            <div
              className={`text-sm font-bold font-mono tabular-nums ${
                countdown &&
                !countdown.expired &&
                countdown.hours === 0 &&
                countdown.minutes < 5
                  ? "text-red-400 animate-pulse"
                  : "text-foreground"
              }`}
            >
              {fmtCountdown()}
            </div>
          </div>

          {/* Engine status */}
          <div className="bg-card/20 rounded-lg p-2 flex items-center justify-between">
            <div className="text-xs font-mono text-muted-foreground">
              ENGINE
            </div>
            <div
              className={`text-sm font-bold font-mono ${isRunning ? "text-emerald-500" : "text-red-500"}`}
            >
              {isRunning ? "RUNNING" : "STOPPED"}
            </div>
          </div>

          {/* Polymarket link for active market */}
          {primaryMarket ? (
            <a
              href={polymarketUrl(primaryMarket)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20 transition-colors text-xs font-mono font-bold text-blue-400"
            >
              <span>↗</span>
              <span>POLYMARKET</span>
            </a>
          ) : (
            <div className="bg-card/20 rounded-lg p-2 flex items-center justify-between opacity-40">
              <div className="text-xs font-mono text-muted-foreground">
                OPEN POSITIONS
              </div>
              <div className="text-sm font-bold font-mono text-foreground">
                {openTradesCount}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SidebarCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border/30 rounded-lg bg-card/30 p-3">
      <div className="text-[10px] text-muted-foreground tracking-widest mb-2 border-b border-border/20 pb-1">
        {title}
      </div>
      {children}
    </div>
  );
}

function StatRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={accent ? "text-emerald-500" : "text-foreground"}>
        {value}
      </span>
    </div>
  );
}

function MarketsPanel({
  markets,
  loading,
  refetch,
}: {
  markets: DiscoveredMarket[];
  loading: boolean;
  refetch?: () => void;
}) {
  // Auto-refresh when the active market ends
  useEffect(() => {
    if (!refetch || markets.length === 0) return;

    const activeMarket = markets.find((m) => m.active);
    if (!activeMarket?.endDate) return;

    const endTime = new Date(activeMarket.endDate).getTime();
    const now = Date.now();
    const timeUntilEnd = endTime - now;

    if (timeUntilEnd > 0 && timeUntilEnd < 20 * 60 * 1000) {
      const timer = setTimeout(() => {
        refetch();
      }, timeUntilEnd + 1000);
      return () => clearTimeout(timer);
    }
  }, [markets, refetch]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-sm text-muted-foreground font-mono animate-pulse">
          Loading markets...
        </div>
      </div>
    );
  }

  if (markets.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-sm text-muted-foreground font-mono">
          No active markets discovered.
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-border/30 text-muted-foreground">
            <th className="text-left py-2 px-2 font-medium">MARKET</th>
            <th className="text-left py-2 px-2 font-medium">WINDOW</th>
            <th className="text-left py-2 px-2 font-medium">STATUS</th>
            <th className="text-right py-2 px-2 font-medium">TARGET</th>
            <th className="text-right py-2 px-2 font-medium">ENDS</th>
          </tr>
        </thead>
        <tbody>
          {markets.map((market) => {
            const label =
              MARKET_WINDOW_LABELS[market.windowType as MarketWindow] ??
              market.windowType;
            const href = polymarketMarketUrl(market);

            return (
              <tr
                key={market.id}
                className={`border-b border-border/10 transition-colors cursor-pointer ${
                  market.active
                    ? "bg-emerald-500/5 hover:bg-emerald-500/10"
                    : "hover:bg-muted/20"
                }`}
                onClick={() =>
                  window.open(href, "_blank", "noopener,noreferrer")
                }
                title="Open on Polymarket"
              >
                <td className="py-2.5 px-2 max-w-[200px]">
                  <div className="flex flex-col gap-0.5">
                    <span className="truncate text-foreground font-medium">
                      {market.question?.slice(0, 50) || market.id.slice(0, 16)}
                    </span>
                    <span className="truncate text-muted-foreground/70 text-[10px]">
                      {market.id.slice(0, 20)}…
                    </span>
                  </div>
                </td>
                <td className="py-2.5 px-2">
                  <span className="text-muted-foreground">{label}</span>
                </td>
                <td className="py-2.5 px-2">
                  {market.active ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      ACTIVE
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-muted/40 text-muted-foreground">
                      INACTIVE
                    </span>
                  )}
                </td>
                <td className="py-2.5 px-2 text-right tabular-nums text-foreground">
                  {market.targetPrice
                    ? `$${parseFloat(market.targetPrice).toLocaleString()}`
                    : "—"}
                </td>
                <td className="py-2.5 px-2 text-right tabular-nums text-muted-foreground">
                  {market.endDate
                    ? new Date(market.endDate).toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
