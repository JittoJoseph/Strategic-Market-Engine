import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import { getDb, wipeAndResetPortfolio, getPortfolio } from "../db/client.js";
import * as schema from "../db/schema.js";
import { eq, desc, and, sql, gte } from "drizzle-orm";
import { getMarketOrchestrator } from "./market-orchestrator.js";
import { getBtcPriceWatcher } from "./btc-price-watcher.js";
import {
  calculatePortfolioPerformance,
  type TimePeriod,
} from "./performance-calculator.js";
import { runMonteCarloAnalysis } from "./monte-carlo.js";
import type { Crossover } from "./strategy-engine.js";

const logger = createModuleLogger("api-server");

/**
 * Express API server + WebSocket broadcast for real-time frontend updates.
 */
export class ApiServer {
  private app: express.Application;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.app = express();
    this.app.use(express.json());
    this.app.use(this.corsMiddleware);
    this.setupRoutes();
  }

  async start(): Promise<void> {
    const config = getConfig();
    this.server = createServer(this.app);

    // WebSocket server for real-time updates
    this.wss = new WebSocketServer({ server: this.server, path: "/ws" });
    this.wss.on("connection", (ws) => {
      logger.debug("Frontend WS client connected");

      // Respond to application-level PING with PONG so the frontend can
      // confirm true end-to-end WS connectivity.
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string };
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
          }
        } catch {
          // ignore non-JSON (e.g. raw PING frames)
        }
      });

      ws.on("close", () => logger.debug("Frontend WS client disconnected"));
    });

    // Periodic broadcast of system state + BTC price
    this.broadcastInterval = setInterval(() => this.broadcastState(), 2000);

    // Wire orchestrator events to WS broadcast
    const orchestrator = getMarketOrchestrator();
    orchestrator.on("tradeOpened", (data) =>
      this.broadcast({ type: "tradeOpened", data }),
    );
    orchestrator.on("tradeResolved", (data) =>
      this.broadcast({ type: "tradeResolved", data }),
    );

    // BTC price updates — also carry the latest momentum signal so the
    // frontend gets real-time momentum updates on every tick, not just every 2s.
    const btcWatcher = getBtcPriceWatcher();
    btcWatcher.on("btcPriceUpdate", (data) => {
      const config = getConfig();
      const momentum = config.strategy.momentumEnabled
        ? btcWatcher.getMomentum(
            config.strategy.momentumLookbackMs,
            config.strategy.momentumMinChangeUsd,
          )
        : null;
      this.broadcast({ type: "btcPriceUpdate", data: { ...data, momentum } });
    });

    return new Promise((resolve) => {
      this.server!.listen(config.server.port, config.server.host, () => {
        logger.info(
          { host: config.server.host, port: config.server.port },
          "API server started",
        );
        resolve();
      });
    });
  }

  stop(): void {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  getExpressApp(): express.Application {
    return this.app;
  }

  private corsMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  }

  /** Reusable admin auth guard — checks Bearer token against config */
  private adminAuth(req: Request, res: Response, next: NextFunction): void {
    const config = getConfig();
    const password = req.headers.authorization?.replace("Bearer ", "");
    if (!password || password !== config.admin.password) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }

  private setupRoutes(): void {
    // Health / ping
    this.app.get("/ping", (_req, res) => res.json({ message: "pong" }));
    this.app.get("/health", (_req, res) => {
      const orchestrator = getMarketOrchestrator();
      const stats = orchestrator.getStats();
      res.json({
        status: "ok",
        uptime: process.uptime(),
        ...stats,
      });
    });

    // System stats
    this.app.get(["/api/system/stats", "/api/stats"], async (_req, res) => {
      try {
        const orchestrator = getMarketOrchestrator();
        const btcWatcher = getBtcPriceWatcher();
        const config = getConfig();

        res.json({
          orchestrator: orchestrator.getStats(),
          btcPrice: btcWatcher.getCurrentPrice(),
          config: {
            marketWindow: config.strategy.marketWindow,
            entryPriceThreshold: config.strategy.entryPriceThreshold,
            maxEntryPrice: config.strategy.maxEntryPrice,
            tradeFromWindowSeconds: config.strategy.tradeFromWindowSeconds,
            startingCapital: config.portfolio.startingCapital,
            maxPositions: config.strategy.maxSimultaneousPositions,
            minBtcDistanceUsd: config.strategy.minBtcDistanceUsd,
            stopLossEnabled: config.strategy.stopLossEnabled,
            stopLossPriceTrigger: config.strategy.stopLossPriceTrigger,
            momentumEnabled: config.strategy.momentumEnabled,
            momentumLookbackMs: config.strategy.momentumLookbackMs,
            momentumMinChangeUsd: config.strategy.momentumMinChangeUsd,
            oscillationFilterEnabled: config.strategy.oscillationFilterEnabled,
            oscillationWindowMs: config.strategy.oscillationWindowMs,
            oscillationMaxCrossovers: config.strategy.oscillationMaxCrossovers,
          },
        });
      } catch (error) {
        logger.error({ error }, "System stats error");
        res.status(500).json({ error: "Failed to get system stats" });
      }
    });

    // Active market — returns the primary market (prioritizes by recency and status:
    // ACTIVE > ENDED > UPCOMING). Sources from in-memory orchestrator state so it
    // includes real-time prices and btcPriceAtWindowStart. Returns 204 if none.
    this.app.get("/api/active-market", (_req, res) => {
      const orchestrator = getMarketOrchestrator();
      const liveMarkets = orchestrator.getLiveMarkets();

      if (liveMarkets.length === 0) {
        res.status(204).end();
        return;
      }

      // Sort by recency (most recent end date first)
      liveMarkets.sort(
        (a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime(),
      );

      // Prioritize by status: ACTIVE > ENDED > UPCOMING
      const primary =
        liveMarkets.find((m) => m.status === "ACTIVE") ??
        liveMarkets.find((m) => m.status === "ENDED") ??
        liveMarkets[0]; // Most recent UPCOMING as fallback

      res.json(primary);
    });

    // Markets list — full DB-backed list of recent discovered markets.
    this.app.get("/api/markets", async (req, res) => {
      try {
        const db = getDb();
        const limit = Math.min(parseInt(req.query.limit as string) || 30, 200);
        const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
        const now = new Date();
        const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
        const markets = await db
          .select()
          .from(schema.markets)
          .where(
            and(
              eq(schema.markets.active, true),
              gte(schema.markets.endDate, cutoff),
            ),
          )
          .orderBy(desc(schema.markets.endDate))
          .limit(limit)
          .offset(offset);

        const nowMs = now.getTime();
        const enriched = markets.map((m) => {
          const endMs = m.endDate ? new Date(m.endDate).getTime() : 0;
          return {
            ...m,
            computedStatus:
              endMs > nowMs ? ("ACTIVE" as const) : ("ENDED" as const),
          };
        });

        res.json(enriched);
      } catch (error) {
        logger.error({ error }, "Markets list error");
        res.status(500).json({ error: "Failed to get markets" });
      }
    });

    // Trades
    this.app.get("/api/trades", async (req: Request, res: Response) => {
      try {
        const db = getDb();
        const limit = Math.min(parseInt(req.query.limit as string) || 25, 200);
        const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
        const status = req.query.status as string | undefined;

        const conditions = [];
        if (status === "OPEN" || status === "SETTLED") {
          conditions.push(eq(schema.simulatedTrades.status, status));
        }

        const baseQuery = db
          .select({
            trade: schema.simulatedTrades,
            marketEndDate: schema.markets.endDate,
            marketSlug: schema.markets.slug,
            marketQuestion: schema.markets.question,
            marketMetadata: schema.markets.metadata,
          })
          .from(schema.simulatedTrades)
          .leftJoin(
            schema.markets,
            eq(schema.simulatedTrades.marketId, schema.markets.id),
          )
          .orderBy(desc(schema.simulatedTrades.entryTs))
          .limit(limit)
          .offset(offset);

        const rows =
          conditions.length > 0
            ? await baseQuery.where(and(...conditions))
            : await baseQuery;

        res.json(
          rows.map((r) => {
            const crossovers = (r.marketMetadata as any)?.crossovers as
              | Crossover[]
              | undefined;
            const entryTs = new Date(r.trade.entryTs).getTime();
            const last60sCrossovers =
              crossovers?.filter((c) => c.ts >= entryTs - 60_000) || [];
            const allCrossovers = crossovers || [];

            return {
              ...r.trade,
              marketEndDate: r.marketEndDate ?? null,
              marketSlug: r.marketSlug ?? null,
              marketQuestion: r.marketQuestion ?? null,
              crossovers: {
                all: allCrossovers.length,
                last60s: last60sCrossovers.length,
                details: allCrossovers, // Send full details for hover
              },
            };
          }),
        );
      } catch (error) {
        logger.error({ error }, "Trades error");
        res.status(500).json({ error: "Failed to get trades" });
      }
    });

    // Performance
    this.app.get("/api/performance", async (req: Request, res: Response) => {
      try {
        const period = (req.query.period as TimePeriod) || "ALL";
        const validPeriods: TimePeriod[] = ["1D", "1W", "1M", "ALL"];
        if (!validPeriods.includes(period)) {
          res.status(400).json({ error: "Invalid period" });
          return;
        }

        const orchestrator = getMarketOrchestrator();
        const openPositionsValue = orchestrator.computeOpenPositionsValue();
        const metrics = await calculatePortfolioPerformance(
          period,
          undefined,
          openPositionsValue,
        );
        res.json(metrics);
      } catch (error) {
        logger.error({ error }, "Performance error");
        res.status(500).json({ error: "Failed to calculate performance" });
      }
    });

    // Audit log
    this.app.get("/api/audit", async (req: Request, res: Response) => {
      try {
        const db = getDb();
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const rows = await db
          .select()
          .from(schema.auditLogs)
          .orderBy(desc(schema.auditLogs.createdAt))
          .limit(limit);
        res.json(rows);
      } catch (error) {
        res.status(500).json({ error: "Failed to get audit logs" });
      }
    });

    // Admin: wipe — clears all trade data and resets portfolio
    this.app.delete(
      "/api/admin/wipe",
      (req, res, next) => this.adminAuth(req, res, next),
      async (req: Request, res: Response) => {
        try {
          const config = getConfig();

          // Pause the orchestrator first — stops scanner, halts new trades
          const orchestrator = getMarketOrchestrator();
          orchestrator.pause();

          await wipeAndResetPortfolio(config.portfolio.startingCapital);

          // Also clear markets
          const db = getDb();
          await db.delete(schema.markets);

          logger.warn("Database wiped and portfolio reset via admin endpoint");
          res.json({
            success: true,
            message:
              "All data wiped, portfolio reset. Use POST /api/admin/resume to resume trading.",
          });
        } catch (error) {
          logger.error({ error }, "Wipe error");
          res.status(500).json({ error: "Wipe failed" });
        }
      },
    );

    // Admin: pause — stop new trades, keep existing positions tracked
    this.app.post(
      "/api/admin/pause",
      (req, res, next) => this.adminAuth(req, res, next),
      (_req: Request, res: Response) => {
        const orchestrator = getMarketOrchestrator();
        orchestrator.pause();
        res.json({ success: true, paused: true });
      },
    );

    // Admin: resume — resume trading after a pause
    this.app.post(
      "/api/admin/resume",
      (req, res, next) => this.adminAuth(req, res, next),
      async (_req: Request, res: Response) => {
        try {
          const orchestrator = getMarketOrchestrator();
          await orchestrator.resume();
          res.json({ success: true, paused: false });
        } catch (error) {
          logger.error({ error }, "Resume error");
          res.status(500).json({ error: "Resume failed" });
        }
      },
    );

    // Portfolio state
    this.app.get("/api/portfolio", async (_req: Request, res: Response) => {
      try {
        const portfolio = await getPortfolio();
        if (!portfolio) {
          res.status(404).json({ error: "Portfolio not initialised" });
          return;
        }
        const orchestrator = getMarketOrchestrator();
        const openPositionsValue = orchestrator.computeOpenPositionsValue();
        const cashBalance = parseFloat(portfolio.cashBalance);
        const initialCapital = parseFloat(portfolio.initialCapital);
        const portfolioValue = cashBalance + openPositionsValue;

        res.json({
          initialCapital,
          cashBalance,
          openPositionsValue,
          portfolioValue,
          roi:
            initialCapital > 0
              ? ((portfolioValue - initialCapital) / initialCapital) * 100
              : 0,
          createdAt: portfolio.createdAt,
          updatedAt: portfolio.updatedAt,
        });
      } catch (error) {
        logger.error({ error }, "Portfolio error");
        res.status(500).json({ error: "Failed to get portfolio" });
      }
    });

    // Monte Carlo analysis
    this.app.get("/api/analysis", async (req: Request, res: Response) => {
      try {
        const simulations = parseInt(req.query.simulations as string) || 10_000;
        const tradesPerSim = parseInt(req.query.tradesPerSim as string) || 100;
        const result = await runMonteCarloAnalysis({
          simulations: Math.min(simulations, 50_000),
          tradesPerSim: Math.min(tradesPerSim, 500),
        });
        res.json(result);
      } catch (error: any) {
        const msg = error?.message || "Analysis failed";
        logger.error({ error }, "Monte Carlo analysis error");
        res
          .status(error?.message?.includes("No settled") ? 400 : 500)
          .json({ error: msg });
      }
    });
  }

  /**
   * Broadcast a message to all connected WebSocket clients.
   */
  private broadcast(message: unknown): void {
    if (!this.wss) return;
    const data = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Periodically broadcast system state.
   */
  private broadcastState(): void {
    const orchestrator = getMarketOrchestrator();
    const btcWatcher = getBtcPriceWatcher();
    const stats = orchestrator.getStats();
    const pm = orchestrator.portfolioManager;
    this.broadcast({
      type: "systemState",
      data: {
        ...stats,
        liveMarkets: orchestrator.getLiveMarkets(),
        btcPrice: btcWatcher.getCurrentPrice(),
        portfolio: {
          cashBalance: pm.getCashBalance(),
          initialCapital: pm.getInitialCapital(),
          openPositionsValue: orchestrator.computeOpenPositionsValue(),
        },
        timestamp: Date.now(),
      },
    });
  }
}

// Singleton
let instance: ApiServer | null = null;
export function getApiServer(): ApiServer {
  if (!instance) instance = new ApiServer();
  return instance;
}
