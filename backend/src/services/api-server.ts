import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import { getDb } from "../db/client.js";
import * as schema from "../db/schema.js";
import { eq, desc, and, sql, gte } from "drizzle-orm";
import { getMarketOrchestrator } from "./market-orchestrator.js";
import { getBtcPriceWatcher } from "./btc-price-watcher.js";
import {
  calculatePortfolioPerformance,
  type TimePeriod,
} from "./performance-calculator.js";

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

    // BTC price updates
    const btcWatcher = getBtcPriceWatcher();
    btcWatcher.on("btcPriceUpdate", (data) =>
      this.broadcast({ type: "btcPriceUpdate", data }),
    );

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
            simulationAmountUsd: config.simulation.amountUsd,
            maxSimultaneousPositions: config.strategy.maxSimultaneousPositions,
            minBtcDistanceUsd: config.strategy.minBtcDistanceUsd,
            stopLossEnabled: config.strategy.stopLossEnabled,
            stopLossThreshold: config.strategy.stopLossThreshold,
            momentumEnabled: config.strategy.momentumEnabled,
            momentumLookbackMs: config.strategy.momentumLookbackMs,
            momentumMinChangeUsd: config.strategy.momentumMinChangeUsd,
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
    this.app.get("/api/markets", async (_req, res) => {
      try {
        const db = getDb();
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
          .limit(30);

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
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const status = req.query.status as string | undefined;

        const conditions = [];
        if (status === "OPEN" || status === "SETTLED") {
          conditions.push(eq(schema.simulatedTrades.status, status));
        }

        const query = db
          .select()
          .from(schema.simulatedTrades)
          .orderBy(desc(schema.simulatedTrades.entryTs))
          .limit(limit);

        const trades =
          conditions.length > 0
            ? await query.where(and(...conditions))
            : await query;

        res.json(trades);
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

        const metrics = await calculatePortfolioPerformance(period);
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

    // Admin: wipe — clears all DB data and pauses the system until restart
    this.app.delete("/api/admin/wipe", async (req: Request, res: Response) => {
      try {
        const config = getConfig();
        const password = req.headers.authorization?.replace("Bearer ", "");
        if (!password || password !== config.wipe.password) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }

        // Pause the orchestrator first — stops scanner, halts new trades
        const orchestrator = getMarketOrchestrator();
        orchestrator.pause();

        const db = getDb();
        await db.delete(schema.simulatedTrades);
        await db.delete(schema.markets);
        await db.delete(schema.auditLogs);

        logger.warn(
          "Database wiped and system paused via admin endpoint — restart required",
        );
        res.json({
          success: true,
          message: "All data wiped. System paused — restart to resume.",
        });
      } catch (error) {
        logger.error({ error }, "Wipe error");
        res.status(500).json({ error: "Wipe failed" });
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
    this.broadcast({
      type: "systemState",
      data: {
        ...stats,
        liveMarkets: orchestrator.getLiveMarkets(),
        btcPrice: btcWatcher.getCurrentPrice(),
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
