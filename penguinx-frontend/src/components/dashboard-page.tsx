"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { Header } from "./header";
import { SystemStatusIndicator } from "./system-status-indicator";
import { TradesTable } from "./trades-table";
import { TradeDetailPopup } from "./trade-detail-popup";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExternalLink } from "lucide-react";
import { pnlColor, formatPnl } from "@/lib/utils";
import {
  useTrades,
  useSystemStats,
  useActiveMarkets,
  useWsConnection,
  useWsEvent,
  useLiveMarkets,
  useCountdown,
  usePerformanceRealtime,
  useActivityLog,
  useUnrealizedPnL,
  useAnimatedNumber,
} from "@/lib/hooks";
import type {
  SimulatedTrade,
  DiscoveredMarket,
  SystemStats,
  LiveMarketInfo,
  LiveMarketPrice,
  ActivityEntry,
} from "@/lib/types";
import { MARKET_WINDOW_LABELS, type MarketWindow } from "@/lib/types";

export function DashboardPage() {
  const [activeTab, setActiveTab] = useState("trades");
  const [selectedTrade, setSelectedTrade] = useState<SimulatedTrade | null>(
    null,
  );
  const [btcPrice, setBtcPrice] = useState<{
    price: number;
    timestamp: number;
  } | null>(null);
  // Real-time momentum driven by btcPriceUpdate WS (falls back to stats on initial load)
  const [momentum, setMomentum] = useState<{
    direction: "UP" | "DOWN" | "NEUTRAL";
    changeUsd: number;
    lookbackMs: number;
    hasData: boolean;
  } | null>(null);

  // Data hooks — trades are WS-driven; no polling
  const {
    trades,
    loading: tradesLoading,
    loadMore,
    hasMore,
    loadingMore,
  } = useTrades();
  const { stats, loading: statsLoading } = useSystemStats();
  const {
    markets,
    loading: marketsLoading,
    refetch: refetchMarkets,
  } = useActiveMarkets();
  const { activities, loading: activitiesLoading } = useActivityLog();

  // Real-time market state from WS
  const liveMarkets = useLiveMarkets();
  useWsConnection();

  // BTC price + momentum from systemState WS broadcast
  useWsEvent(
    "btcPriceUpdate",
    useCallback((msg: any) => {
      const d = msg?.data;
      if (d?.price && typeof d.price === "number") {
        setBtcPrice({ price: d.price, timestamp: d.timestamp ?? Date.now() });
      }
      if (d?.momentum) {
        setMomentum(d.momentum);
      }
    }, []),
  );

  // systemState: update markets, btcPrice fallback (btcPriceUpdate is faster but systemState seeds initial momentum)
  useWsEvent(
    "systemState",
    useCallback(
      (msg: any) => {
        const d = msg?.data;
        if (d?.btcPrice && typeof d.btcPrice === "object") {
          setBtcPrice(d.btcPrice);
        }
        // Only seed momentum from systemState if we don't have a live value yet
        if (d?.momentum && !momentum) {
          setMomentum(d.momentum);
        }
      },
      [momentum],
    ),
  );

  // Primary live market: soonest-expiring ACTIVE window, or next UPCOMING if none open
  const primaryMarket = useMemo(() => {
    const byEnd = (a: { endDate: string }, b: { endDate: string }) =>
      new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
    const active = liveMarkets.filter((m) => m.status === "ACTIVE").sort(byEnd);
    if (active.length > 0) return active[0]!;
    const upcoming = liveMarkets
      .filter((m) => m.status === "UPCOMING")
      .sort(byEnd);
    return upcoming[0] ?? liveMarkets[0] ?? null;
  }, [liveMarkets]);

  // Markets pending resolution (ENDED but still has open position)
  const positionMarkets = useMemo(
    () => liveMarkets.filter((m) => m.status === "ENDED" && m.hasPosition),
    [liveMarkets],
  );

  // Flat tokenId → price map for TradesTable real-time P&L
  const livePricesMap = useMemo<Record<string, LiveMarketPrice>>(() => {
    const map: Record<string, LiveMarketPrice> = {};
    for (const m of liveMarkets) {
      for (const [tokenId, price] of Object.entries(m.prices)) {
        map[tokenId] = price;
      }
    }
    return map;
  }, [liveMarkets]);

  // Fallback: if btcPriceAtWindowStart is null, use the entry price from the most recent open trade for this market
  const btcPriceAtWindowStartFallback = useMemo(() => {
    const marketId = primaryMarket?.marketId;
    if (!marketId) return null;
    const trade = trades.find(
      (t) =>
        t.marketId === marketId && t.status === "OPEN" && !!t.btcPriceAtEntry,
    );
    return trade?.btcPriceAtEntry ? parseFloat(trade.btcPriceAtEntry) : null;
  }, [primaryMarket, trades]);

  // marketId → endDate for trades table WINDOW column
  const marketEndDates = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const m of liveMarkets) map[m.marketId] = m.endDate;
    for (const m of markets) if (m.id && m.endDate) map[m.id] = m.endDate;
    return map;
  }, [liveMarkets, markets]);

  // Polymarket slug + question for the selected trade (for deep-link and modal header)
  const { slug: selectedTradeSlug, question: selectedTradeQuestion } =
    useMemo(() => {
      if (!selectedTrade) return { slug: null, question: null };
      const live = liveMarkets.find(
        (m) => m.marketId === selectedTrade.marketId,
      );
      const disc = markets.find((m) => m.id === selectedTrade.marketId);
      return {
        slug: live?.slug ?? disc?.slug ?? null,
        question: live?.question ?? disc?.question ?? null,
      };
    }, [selectedTrade, liveMarkets, markets]);

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
        {/* ── Command Center Panel ────────────── */}
        <TopDashboardSection
          stats={stats}
          btcPrice={currentBtcPrice}
          primaryMarket={primaryMarket}
          positionMarkets={positionMarkets}
          activeMarketsCount={
            liveMarkets.filter(
              (m) => m.status === "ACTIVE" || m.status === "UPCOMING",
            ).length
          }
          windowLabel={windowLabel}
          refetchMarkets={refetchMarkets}
          btcPriceAtWindowStartFallback={btcPriceAtWindowStartFallback}
          trades={trades}
          liveMarkets={liveMarkets}
        />

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
                  <TabsTrigger
                    value="activity"
                    className="data-[state=active]:bg-muted/40 rounded px-3 py-1 text-xs font-mono relative"
                  >
                    ACTIVITY
                    {activities.length > 0 && (
                      <span className="ml-1.5 bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded text-[9px] font-mono px-1 py-0.5">
                        {activities.length}
                      </span>
                    )}
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="trades" className="mt-0">
                <TradesTable
                  trades={trades}
                  loading={tradesLoading}
                  livePrices={livePricesMap}
                  marketEndDates={marketEndDates}
                  onTradeClick={setSelectedTrade}
                  onLoadMore={loadMore}
                  hasMore={hasMore}
                  loadingMore={loadingMore}
                />
              </TabsContent>

              <TabsContent value="markets" className="mt-0">
                <MarketsPanel
                  markets={markets}
                  loading={marketsLoading}
                  refetch={refetchMarkets}
                />
              </TabsContent>

              <TabsContent value="activity" className="mt-0">
                <ActivityPanel
                  activities={activities}
                  loading={activitiesLoading}
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
                    label="Trades Exec"
                    value={stats.orchestrator.cycleCount.toString()}
                  />
                  <StatRow
                    label="Discovered"
                    value={stats.orchestrator.scanner.discoveredCount.toString()}
                  />
                  <StatRow
                    label="Engine"
                    value={
                      stats.orchestrator.paused
                        ? "PAUSED"
                        : stats.orchestrator.running
                          ? "ACTIVE"
                          : "IDLE"
                    }
                    accent={
                      stats.orchestrator.running && !stats.orchestrator.paused
                    }
                    warn={stats.orchestrator.paused}
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
                  {/* Use live WS-driven momentum (updates every BTC tick ~1s) */}
                  {(momentum ?? stats.orchestrator.momentum) && (
                    <StatRow
                      label="Momentum"
                      value={`${
                        (momentum ?? stats.orchestrator.momentum)!.direction
                      } ${
                        (momentum ?? stats.orchestrator.momentum)!.changeUsd >=
                        0
                          ? "+"
                          : ""
                      }$${Math.abs(
                        (momentum ?? stats.orchestrator.momentum)!.changeUsd,
                      ).toFixed(0)}`}
                      accent={
                        (momentum ?? stats.orchestrator.momentum)!.direction ===
                        "UP"
                      }
                      warn={
                        (momentum ?? stats.orchestrator.momentum)!.direction ===
                        "DOWN"
                      }
                    />
                  )}
                </div>
              ) : null}
            </SidebarCard>

            <SidebarCard title="CONFIGURATION">
              {stats?.config ? (
                <div className="space-y-2 text-xs font-mono">
                  <StatRow
                    label="Entry Range"
                    value={`${(stats.config.entryPriceThreshold * 100).toFixed(0)}–${(stats.config.maxEntryPrice * 100).toFixed(0)}¢`}
                  />
                  <StatRow
                    label="Trade Window"
                    value={`${stats.config.tradeFromWindowSeconds}s`}
                  />
                  <StatRow
                    label="Starting Capital"
                    value={`$${stats.config.startingCapital}`}
                  />
                  <StatRow
                    label="Max Positions"
                    value={stats.config.maxPositions?.toString() ?? "—"}
                  />
                  <StatRow
                    label="BTC Min Dist"
                    value={`$${stats.config.minBtcDistanceUsd}`}
                  />
                  <StatRow
                    label="Momentum Filter"
                    value={
                      stats.config.momentumEnabled
                        ? `$${stats?.config?.momentumMinChangeUsd}`
                        : "DISABLED"
                    }
                  />
                  <StatRow
                    label="Oscillation Filter"
                    value={
                      stats?.config?.oscillationFilterEnabled
                        ? `${stats?.config?.oscillationMaxCrossovers} times`
                        : "DISABLED"
                    }
                  />
                  <StatRow
                    label="Stop Loss"
                    value={
                      stats.config.stopLossEnabled
                        ? `${((stats.config as any).stopLossPriceTrigger * 100).toFixed(0)}¢ trigger`
                        : "DISABLED"
                    }
                    accent={stats.config.stopLossEnabled}
                    warn={!stats.config.stopLossEnabled}
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
        marketSlug={selectedTradeSlug}
        marketQuestion={selectedTradeQuestion}
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

function TopDashboardSection({
  stats,
  btcPrice,
  primaryMarket,
  positionMarkets,
  activeMarketsCount,
  windowLabel,
  refetchMarkets,
  btcPriceAtWindowStartFallback,
  trades,
  liveMarkets,
}: {
  stats: SystemStats | null;
  btcPrice: { price: number; timestamp: number } | null;
  primaryMarket: LiveMarketInfo | null;
  positionMarkets: LiveMarketInfo[];
  activeMarketsCount: number;
  windowLabel: string;
  refetchMarkets: () => void;
  btcPriceAtWindowStartFallback: number | null;
  trades: SimulatedTrade[];
  liveMarkets: LiveMarketInfo[];
}) {
  const [period, setPeriod] = useState<"1D" | "1W" | "1M" | "ALL">("ALL");
  const { performance } = usePerformanceRealtime(period);

  // Get live unrealized PnL from open trades and current market prices
  const liveUnrealizedPnL = useUnrealizedPnL(trades, liveMarkets);

  // Animate NET P&L with smooth counter
  const netPnlBaseValue = parseFloat(performance?.totalPnl || "0");
  const animatedNetPnl = useAnimatedNumber(netPnlBaseValue, 300);

  const isPaused = stats?.orchestrator.paused ?? false;

  const countdown = useCountdown(primaryMarket?.endDate ?? null);

  useEffect(() => {
    if (countdown?.expired) {
      const timer = setTimeout(() => refetchMarkets(), 2000);
      return () => clearTimeout(timer);
    }
  }, [countdown?.expired, refetchMarkets]);

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
    if (countdown.expired) return "00:00";
    const { days, hours, minutes, seconds } = countdown;
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0)
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  };

  const netPnl = animatedNetPnl;
  const roi = parseFloat(performance?.roi || "0");
  const winRate = parseFloat(performance?.winRate || "0");
  const totalDeployed = parseFloat(performance?.totalDeployed || "0");
  const cashBalance = parseFloat(performance?.cashBalance || "0");
  const initialCapital = parseFloat(performance?.initialCapital || "0");
  const openPositionsValue = parseFloat(performance?.openPositionsValue || "0");
  const portfolioValue = cashBalance + openPositionsValue;
  // Use live-calculated unrealized PnL instead of API value
  const unrealizedPnl = liveUnrealizedPnL;
  // totalPnl from the API already sums only SETTLED trade realizedPnl — it IS realized PnL
  const realizedPnl = netPnlBaseValue;
  const wins = performance?.wins || 0;
  const losses = performance?.losses || 0;
  const closedPositions = wins + losses;
  const openPositions = performance?.openPositions || 0;
  const bestTrade = parseFloat(performance?.largestWin || "0");
  const worstTrade = parseFloat(performance?.largestLoss || "0");
  const avgWin = parseFloat(performance?.avgWin || "0");
  const avgLoss = parseFloat(performance?.avgLoss || "0");
  const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

  const windowType = stats?.config?.marketWindow || "15M";

  // Effective BTC price at window start: use captured value or fall back to entry price from trade
  const effectiveBtcAtStart =
    primaryMarket?.btcPriceAtWindowStart ??
    btcPriceAtWindowStartFallback ??
    null;

  const marketDetails = useMemo(() => {
    if (!primaryMarket) return null;
    const question = primaryMarket.question;

    // For absolute price markets ("above $X") extract the target from the question.
    // For relative Up/Down markets, btcPriceAtWindowStart is the price to beat.
    const absolutePriceMatch = question.match(
      /(?:above|below)\s*\$([0-9,]+(?:\.\d+)?)/i,
    );
    const targetPriceStr = absolutePriceMatch
      ? `$${absolutePriceMatch[1]}`
      : effectiveBtcAtStart !== null
        ? `$${effectiveBtcAtStart.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : null;
    const targetPriceNum = absolutePriceMatch
      ? parseFloat(absolutePriceMatch[1].replace(/,/g, ""))
      : effectiveBtcAtStart;

    const end = new Date(primaryMarket.endDate);
    const windowMinMap: Record<string, number> = {
      "5M": 5,
      "15M": 15,
      "30M": 30,
      "1H": 60,
      "4H": 240,
      "1D": 1440,
    };
    const mins = windowMinMap[windowType] ?? 15;
    const start = new Date(end.getTime() - mins * 60000);
    const fmt = (d: Date) =>
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    // Direction from question: look for "above" / "higher" vs "below" / "lower"
    const qLower = question.toLowerCase();
    const isAbove =
      qLower.includes("above") ||
      qLower.includes("higher") ||
      qLower.includes("over");
    const isBelow =
      qLower.includes("below") ||
      qLower.includes("lower") ||
      qLower.includes("under");

    return {
      targetPriceStr,
      targetPriceNum,
      startTime: fmt(start),
      endTime: fmt(end),
      windowLabel:
        mins >= 60
          ? mins >= 1440
            ? "1D window"
            : `${mins / 60}H window`
          : `${mins}M window`,
      direction: isAbove ? "above" : isBelow ? "below" : null,
    };
  }, [primaryMarket, windowType, effectiveBtcAtStart]);

  // BTC price distance from target
  const btcDistanceInfo = useMemo(() => {
    if (!marketDetails?.targetPriceNum || !btcPrice) return null;
    const dist = btcPrice.price - marketDetails.targetPriceNum;
    return {
      dist: Math.abs(dist),
      above: dist >= 0,
    };
  }, [marketDetails, btcPrice]);

  const fmtUsd = (n: number) =>
    n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  return (
    <div className="border border-border/30 rounded-xl bg-background overflow-hidden">
      {isPaused && (
        <div className="flex items-center justify-center gap-2 px-4 py-1.5 bg-red-500/10 border-b border-red-500/20">
          <span className="text-[11px] font-mono font-bold text-red-400 tracking-widest">
            SYSTEM PAUSED — Use Resume to restart trading
          </span>
        </div>
      )}

      {/* Main two-panel layout */}
      <div className="flex flex-col xl:flex-row divide-y xl:divide-y-0 xl:divide-x divide-border/30">
        {/* ── LEFT: ACTIVE MARKET ── */}
        <div className="xl:w-[420px] xl:shrink-0 p-5 flex flex-col gap-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div
                className={`w-1.5 h-1.5 rounded-full ${
                  primaryMarket?.status === "ACTIVE"
                    ? "bg-emerald-500 animate-pulse"
                    : primaryMarket?.status === "UPCOMING"
                      ? "bg-amber-500/70"
                      : "bg-muted-foreground/30"
                }`}
              />
              <span className="text-[10px] font-mono tracking-[0.18em] text-muted-foreground">
                {primaryMarket?.status === "UPCOMING"
                  ? "UPCOMING MARKET"
                  : "ACTIVE MARKET"}
              </span>
            </div>
            {primaryMarket && (
              <a
                href={polymarketUrl(primaryMarket)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] font-mono text-muted-foreground/50 hover:text-blue-400 flex items-center gap-1 transition-colors"
              >
                polymarket <ExternalLink size={9} />
              </a>
            )}
          </div>

          {primaryMarket ? (
            <>
              {/* Question */}
              <p className="text-sm font-mono text-foreground/80 leading-relaxed">
                {primaryMarket.question}
              </p>

              {/* Meta tags row */}
              <div className="flex flex-wrap gap-1.5">
                {marketDetails?.windowLabel && (
                  <span className="text-[10px] font-mono text-muted-foreground border border-border/30 rounded px-2 py-0.5">
                    {marketDetails.windowLabel}
                  </span>
                )}
                {marketDetails?.startTime && (
                  <span className="text-[10px] font-mono text-muted-foreground border border-border/30 rounded px-2 py-0.5">
                    {marketDetails.startTime} → {marketDetails.endTime}
                  </span>
                )}
                {marketDetails?.direction && (
                  <span
                    className={`text-[10px] font-mono border rounded px-2 py-0.5 ${marketDetails.direction === "above" ? "text-emerald-500 border-emerald-500/30" : "text-red-500 border-red-500/30"}`}
                  >
                    {marketDetails.direction}
                  </span>
                )}
              </div>

              {/* Price to beat vs current BTC */}
              <div className="border border-border/30 rounded-lg overflow-hidden">
                <div className="grid grid-cols-2 divide-x divide-border/30">
                  <div className="p-3">
                    <div className="text-[10px] font-mono text-muted-foreground mb-1 tracking-widest">
                      {effectiveBtcAtStart !== null
                        ? "BTC AT START"
                        : "PRICE TO BEAT"}
                    </div>
                    <div className="text-base font-bold font-mono tabular-nums text-foreground">
                      {marketDetails?.targetPriceStr ?? "—"}
                    </div>
                    {effectiveBtcAtStart !== null && (
                      <div className="text-[10px] font-mono text-muted-foreground/50 mt-0.5">
                        window open price
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <div
                        className={`w-1 h-1 rounded-full ${btcPrice ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground/30"}`}
                      />
                      <span className="text-[10px] font-mono text-muted-foreground tracking-widest">
                        BTC NOW
                      </span>
                    </div>
                    <div className="text-base font-bold font-mono tabular-nums text-foreground">
                      {btcPrice ? `$${fmtUsd(btcPrice.price)}` : "—"}
                    </div>
                  </div>
                </div>
                {btcDistanceInfo && (
                  <div className="border-t border-border/30 px-3 py-1.5 flex items-center gap-2">
                    <span className="text-[10px] font-mono text-muted-foreground">
                      DISTANCE
                    </span>
                    <span
                      className={`text-[10px] font-mono font-bold tabular-nums ${btcDistanceInfo.above ? "text-emerald-500" : "text-red-500"}`}
                    >
                      {btcDistanceInfo.above ? "+" : "-"}$
                      {fmtUsd(btcDistanceInfo.dist)}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/50 ml-auto">
                      BTC is {btcDistanceInfo.above ? "above" : "below"} target
                    </span>
                  </div>
                )}
              </div>

              {/* Timer + odds */}
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-1 border border-border/30 rounded-lg p-3 flex flex-col items-center justify-center text-center gap-0.5">
                  <div className="text-[10px] font-mono text-muted-foreground tracking-widest">
                    {countdown?.expired ? "ENDED" : "CLOSES IN"}
                  </div>
                  <div
                    className={`text-lg font-bold font-mono tabular-nums tracking-tight leading-none ${
                      countdown?.expired
                        ? "text-amber-400"
                        : countdown &&
                            countdown.hours === 0 &&
                            countdown.minutes < 1
                          ? "text-red-400 animate-pulse"
                          : "text-foreground"
                    }`}
                  >
                    {fmtCountdown()}
                  </div>
                  {marketDetails?.endTime && (
                    <div className="text-[10px] font-mono text-muted-foreground/40 tabular-nums">
                      {marketDetails.endTime}
                    </div>
                  )}
                </div>
                <div className="border border-emerald-500/20 bg-emerald-500/5 rounded-lg p-3 flex flex-col items-center justify-center text-center">
                  <div className="text-[10px] font-mono text-emerald-500/60 mb-1">
                    UP ▲
                  </div>
                  <div className="text-base font-bold font-mono tabular-nums text-emerald-400">
                    {fmtPct(upPrice)}
                  </div>
                </div>
                <div className="border border-red-500/20 bg-red-500/5 rounded-lg p-3 flex flex-col items-center justify-center text-center">
                  <div className="text-[10px] font-mono text-red-500/60 mb-1">
                    DOWN ▼
                  </div>
                  <div className="text-base font-bold font-mono tabular-nums text-red-400">
                    {fmtPct(downPrice)}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs font-mono text-muted-foreground/40 py-8">
              Waiting for active market…
            </div>
          )}
        </div>

        {/* ── RIGHT: PORTFOLIO PERFORMANCE ── */}
        <div className="flex-1 flex flex-col">
          {/* Section header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-border/20">
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-mono tracking-[0.18em] text-muted-foreground">
                PORTFOLIO PERFORMANCE
              </span>
              <span className="text-[10px] font-mono text-muted-foreground/40">
                [{period}]
              </span>
            </div>
            <div className="flex border border-border/20 rounded overflow-hidden">
              {(["1D", "1W", "1M", "ALL"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`text-[10px] font-mono px-2.5 py-1 transition-colors ${period === p ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Flat column layout — separated by vertical dividers */}
          <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-border/20">
            {/* Col 1: P&L */}
            <div className="p-5 space-y-4">
              <div>
                <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-1">
                  NET P&L
                </div>
                <div
                  className={`text-3xl font-bold font-mono tabular-nums tracking-tight ${pnlColor(netPnl)}`}
                >
                  {formatPnl(netPnl)}
                </div>
                <div
                  className={`text-xs font-mono mt-1 ${pnlColor(roi, "70")}`}
                >
                  {roi >= 0 ? "+" : ""}
                  {roi.toFixed(2)}% ROI
                </div>
              </div>
              <div className="space-y-3 pt-1">
                <div>
                  <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-0.5">
                    REALIZED
                  </div>
                  <div
                    className={`text-sm font-bold font-mono tabular-nums ${pnlColor(realizedPnl)}`}
                  >
                    {formatPnl(realizedPnl)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-0.5">
                    UNREALIZED
                  </div>
                  <div
                    className={`text-sm font-bold font-mono tabular-nums ${pnlColor(unrealizedPnl)}`}
                  >
                    {formatPnl(unrealizedPnl)}
                  </div>
                </div>
              </div>
            </div>

            {/* Col 2: Portfolio + Win rate */}
            <div className="p-5 space-y-4">
              <div>
                <div className="text-[10px] font-mono text-muted-foreground tracking-widest mb-0.5">
                  PORTFOLIO VALUE
                </div>
                <div className="text-2xl font-bold font-mono tabular-nums text-foreground">
                  ${portfolioValue.toFixed(2)}
                </div>
                <div className="text-[10px] font-mono text-muted-foreground/50 mt-0.5">
                  cash ${cashBalance.toFixed(2)} + positions $
                  {openPositionsValue.toFixed(2)}
                </div>
              </div>

              <div className="space-y-2 pt-1">
                <div className="text-[10px] font-mono text-muted-foreground tracking-widest">
                  TRADE STATISTICS
                </div>
                <div className="flex items-end justify-between">
                  <span className="text-[10px] font-mono text-muted-foreground">
                    WIN RATE
                  </span>
                  <span className="text-base font-bold font-mono tabular-nums text-foreground">
                    {winRate.toFixed(1)}%
                  </span>
                </div>
                <div className="h-1 w-full rounded-full overflow-hidden flex bg-red-500/20">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${winRate}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="text-red-500/70">{losses} losses</span>
                  <span className="text-emerald-500/70">{wins} wins</span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 pt-1">
                {[
                  ["OPEN", openPositions],
                  ["SETTLED", closedPositions],
                  ["TOTAL", openPositions + closedPositions],
                ].map(([label, val]) => (
                  <div key={label as string}>
                    <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                      {label}
                    </div>
                    <div className="text-sm font-bold font-mono tabular-nums text-foreground">
                      {val}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Col 3: Best / Worst */}
            <div className="p-5 space-y-4">
              <div className="text-[10px] font-mono text-muted-foreground tracking-widest">
                PERFORMANCE
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                  BEST TRADE
                </div>
                <div className="text-lg font-bold font-mono tabular-nums text-emerald-500">
                  +${bestTrade.toFixed(4)}
                </div>
                <div className="text-[10px] font-mono text-muted-foreground/50 mt-0.5">
                  avg win: +${avgWin.toFixed(4)}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                  WORST TRADE
                </div>
                <div className="text-lg font-bold font-mono tabular-nums text-red-500">
                  {worstTrade < 0 ? "-" : ""}${Math.abs(worstTrade).toFixed(4)}
                </div>
                <div className="text-[10px] font-mono text-muted-foreground/50 mt-0.5">
                  avg loss: -${Math.abs(avgLoss).toFixed(4)}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                  PROFIT FACTOR
                </div>
                <div className="text-lg font-bold font-mono tabular-nums text-foreground">
                  {profitFactor.toFixed(2)}
                </div>
                <div className="text-[10px] font-mono text-muted-foreground/50 mt-0.5">
                  avg win ÷ avg loss
                </div>
              </div>
            </div>

            {/* Col 4: System + breakdown */}
            <div className="p-5 space-y-4">
              <div className="text-[10px] font-mono text-muted-foreground tracking-widest">
                SYSTEM
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                  ENGINE
                </div>
                <div
                  className={`text-sm font-bold font-mono ${isPaused ? "text-red-500" : stats?.orchestrator.running ? "text-emerald-500" : "text-red-500"}`}
                >
                  {isPaused
                    ? "PAUSED"
                    : stats?.orchestrator.running
                      ? "RUNNING"
                      : "STOPPED"}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                  OPEN POSITIONS
                </div>
                <div className="text-sm font-bold font-mono tabular-nums text-foreground">
                  {stats?.orchestrator.openPositions ?? 0}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                  ACTIVE MARKETS
                </div>
                <div className="text-sm font-bold font-mono tabular-nums text-foreground">
                  {activeMarketsCount}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-0.5">
                  WINDOW
                </div>
                <div className="text-sm font-bold font-mono text-foreground">
                  {windowLabel}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Awaiting resolution — compact card-style design */}
      {positionMarkets.length > 0 && (
        <div className="border-t border-border/20 bg-card/20">
          <div className="px-5 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-500/60 animate-pulse" />
                <span className="text-[10px] font-mono text-muted-foreground tracking-[0.15em]">
                  AWAITING RESOLUTION
                </span>
                <span className="text-[10px] font-mono text-muted-foreground/60">
                  ({positionMarkets.length})
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 justify-end">
                {positionMarkets.map((m) => {
                  // Compact label: "Feb 23 · 3:30–3:35 AM"
                  const end = new Date(m.endDate);
                  const start = m.windowStart ? new Date(m.windowStart) : null;
                  const datePart = end.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  });
                  const timeFmt = (d: Date) =>
                    d.toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                      hour12: true,
                    });
                  const label = start
                    ? `${datePart} · ${timeFmt(start).replace(/ AM| PM/, "")}–${timeFmt(end)}`
                    : `${datePart} · ${timeFmt(end)}`;
                  return (
                    <span
                      key={m.marketId}
                      title={m.question ?? undefined}
                      className="text-[10px] font-mono text-muted-foreground bg-muted/30 border border-border/40 rounded-md px-2.5 py-1 whitespace-nowrap hover:bg-muted/50 transition-colors cursor-help"
                    >
                      {label}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
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
  warn,
}: {
  label: string;
  value: string;
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={
          warn
            ? "text-red-400"
            : accent
              ? "text-emerald-500"
              : "text-foreground"
        }
      >
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

    const activeMarket = markets.find(
      (m) => m.computedStatus === "ACTIVE" || m.active,
    );
    if (!activeMarket?.endDate) return;

    const endTime = new Date(activeMarket.endDate).getTime();
    const now = Date.now();
    const timeUntilEnd = endTime - now;

    if (timeUntilEnd > 0 && timeUntilEnd < 20 * 60 * 1000) {
      const timer = setTimeout(() => {
        refetch();
      }, timeUntilEnd + 2000);
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

            // Compute status from API's computedStatus field, fallback to
            // local calculation
            const status: "ACTIVE" | "ENDED" = market.computedStatus
              ? market.computedStatus
              : market.endDate &&
                  new Date(market.endDate).getTime() > Date.now()
                ? "ACTIVE"
                : "ENDED";

            const isActive = status === "ACTIVE";

            return (
              <tr
                key={market.id}
                className={`border-b border-border/10 transition-colors cursor-pointer ${
                  isActive
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
                  {isActive ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      ACTIVE
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-500 border border-amber-500/20">
                      ENDED
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

/* ─── ActivityPanel ──────────────────────────────────────────────────────── */

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

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

function ActivityPanel({
  activities,
  loading,
}: {
  activities: ActivityEntry[];
  loading: boolean;
}) {
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
