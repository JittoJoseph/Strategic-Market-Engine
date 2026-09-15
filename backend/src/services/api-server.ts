import express, { type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import { FIXED_POSITION_BUDGET_USD, WINDOW_CONFIG, STRATEGY } from "../types/index.js";
import { getDb, wipeAndResetPortfolio, getPortfolio } from "../db/client.js";
import * as schema from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { getMarketOrchestrator } from "./market-orchestrator.js";
import { getBtcPriceWatcher } from "./btc-price-watcher.js";
import { getMarketClock, marketNow } from "./market-clock.js";
import { calculatePortfolioPerformance, type TimePeriod } from "./performance-calculator.js";
import { runMonteCarloAnalysis } from "./monte-carlo.js";

const logger = createModuleLogger("api-server");

const clamp = (raw: unknown, fallback: number, max: number) =>
  Math.min(Math.max(parseInt(String(raw)) || fallback, 0), max);

export class ApiServer {
  private app = express();
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.app.use(express.json());
    this.app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });
    this.setupRoutes();
  }

  async start(): Promise<void> {
    const config = getConfig();
    this.server = createServer(this.app);

    this.wss = new WebSocketServer({ server: this.server, path: "/ws" });
    this.wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "liveState", data: buildLiveState() }));
      ws.on("message", (raw) => {
        try {
          if ((JSON.parse(raw.toString()) as { type?: string }).type === "ping") {
            ws.send(JSON.stringify({ type: "pong", ts: marketNow() }));
          }
        } catch {
          /* ignore non-JSON frames */
        }
      });
    });

    this.broadcastInterval = setInterval(() => this.broadcast({ type: "liveState", data: buildLiveState() }), 1000);
    const orchestrator = getMarketOrchestrator();
    orchestrator.on("tradeOpened", (data) => this.broadcast({ type: "tradeOpened", data }));
    orchestrator.on("tradeResolved", (data) => this.broadcast({ type: "tradeResolved", data }));

    await new Promise<void>((resolve) =>
      this.server!.listen(config.server.port, config.server.host, () => {
        logger.info({ host: config.server.host, port: config.server.port }, "API server started");
        resolve();
      }),
    );
  }

  stop(): void {
    if (this.broadcastInterval) clearInterval(this.broadcastInterval);
    this.broadcastInterval = null;
    this.wss?.close();
    this.wss = null;
    this.server?.close();
    this.server = null;
  }

  private adminAuth(req: Request, res: Response, next: NextFunction): void {
    const password = req.headers.authorization?.replace("Bearer ", "");
    if (!password || password !== getConfig().admin.password) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }

  private setupRoutes(): void {
    const admin = (req: Request, res: Response, next: NextFunction) => this.adminAuth(req, res, next);
    const handle =
      (label: string, fn: (req: Request, res: Response) => Promise<void> | void) =>
      async (req: Request, res: Response) => {
        try {
          await fn(req, res);
        } catch (error) {
          logger.error({ error }, `${label} error`);
          res.status(500).json({ error: `${label} failed` });
        }
      };

    this.app.get("/ping", (_req, res) => res.json({ message: "pong" }));
    this.app.get("/health", (_req, res) =>
      res.json({ status: "ok", uptime: process.uptime(), ...getMarketOrchestrator().getStats() }),
    );
    this.app.get("/api/live-state", handle("Live state", (_req, res) => void res.json(buildLiveState())));

    this.app.get(
      "/api/markets",
      handle("Markets", async (req, res) => {
        const rows = await getDb()
          .select()
          .from(schema.markets)
          .orderBy(desc(schema.markets.endDate))
          .limit(clamp(req.query.limit, 20, 200))
          .offset(clamp(req.query.offset, 0, Number.MAX_SAFE_INTEGER));
        res.json(rows);
      }),
    );

    this.app.get(
      "/api/trades",
      handle("Trades", async (req, res) => {
        const status = req.query.status;
        const query = getDb()
          .select({
            trade: schema.simulatedTrades,
            marketEndDate: schema.markets.endDate,
            marketSlug: schema.markets.slug,
            marketQuestion: schema.markets.question,
          })
          .from(schema.simulatedTrades)
          .leftJoin(schema.markets, eq(schema.simulatedTrades.marketId, schema.markets.id))
          .orderBy(desc(schema.simulatedTrades.entryTs))
          .limit(clamp(req.query.limit, 25, 200))
          .offset(clamp(req.query.offset, 0, Number.MAX_SAFE_INTEGER));
        const rows =
          status === "OPEN" || status === "SETTLED"
            ? await query.where(eq(schema.simulatedTrades.status, status))
            : await query;
        res.json(rows.map((r) => ({ ...r.trade, marketEndDate: r.marketEndDate, marketSlug: r.marketSlug, marketQuestion: r.marketQuestion })));
      }),
    );

    this.app.get(
      "/api/performance",
      handle("Performance", async (req, res) => {
        const period = (req.query.period as TimePeriod) || "ALL";
        if (!["1D", "1W", "1M", "ALL"].includes(period)) {
          res.status(400).json({ error: "Invalid period" });
          return;
        }
        res.json(await calculatePortfolioPerformance(period, getMarketOrchestrator().computeOpenPositionsValue()));
      }),
    );

    this.app.get(
      "/api/audit",
      handle("Audit", async (req, res) => {
        res.json(
          await getDb()
            .select()
            .from(schema.auditLogs)
            .orderBy(desc(schema.auditLogs.createdAt))
            .limit(clamp(req.query.limit, 50, 200)),
        );
      }),
    );

    this.app.get(
      "/api/portfolio",
      handle("Portfolio", async (_req, res) => {
        const portfolio = await getPortfolio();
        if (!portfolio) {
          res.status(404).json({ error: "Portfolio not initialised" });
          return;
        }
        const cashBalance = parseFloat(portfolio.cashBalance);
        const initialCapital = parseFloat(portfolio.initialCapital);
        const openPositionsValue = getMarketOrchestrator().computeOpenPositionsValue();
        const portfolioValue = cashBalance + openPositionsValue;
        res.json({
          initialCapital,
          cashBalance,
          openPositionsValue,
          portfolioValue,
          roi: initialCapital > 0 ? ((portfolioValue - initialCapital) / initialCapital) * 100 : 0,
          createdAt: portfolio.createdAt,
          updatedAt: portfolio.updatedAt,
        });
      }),
    );

    this.app.get("/api/analysis", async (req, res) => {
      try {
        res.json(
          await runMonteCarloAnalysis({
            simulations: Math.min(parseInt(String(req.query.simulations)) || 10_000, 50_000),
            tradesPerSim: Math.min(parseInt(String(req.query.tradesPerSim)) || 100, 500),
          }),
        );
      } catch (error: any) {
        const msg = error?.message || "Analysis failed";
        res.status(msg.includes("No settled") ? 400 : 500).json({ error: msg });
      }
    });

    // Order matters: stop entries, drop the in-memory session so no orphaned
    // position can settle against the new portfolio, then clear the rows.
    this.app.delete(
      "/api/admin/wipe",
      admin,
      handle("Wipe", async (_req, res) => {
        const orchestrator = getMarketOrchestrator();
        orchestrator.pause();
        orchestrator.resetSessionState();
        await wipeAndResetPortfolio(getConfig().portfolio.startingCapital);
        await orchestrator.portfolioManager.reload();
        logger.warn("Database wiped and portfolio reset");
        res.json({ success: true, message: "All data wiped, portfolio reset. POST /api/admin/resume to resume." });
      }),
    );
    this.app.post("/api/admin/pause", admin, (_req, res) => {
      getMarketOrchestrator().pause();
      res.json({ success: true, paused: true });
    });
    this.app.post(
      "/api/admin/resume",
      admin,
      handle("Resume", async (_req, res) => {
        await getMarketOrchestrator().resume();
        res.json({ success: true, paused: false });
      }),
    );
  }

  private broadcast(message: unknown): void {
    if (!this.wss) return;
    const data = JSON.stringify(message);
    for (const client of this.wss.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

/** The one live-state model: REST snapshot and WebSocket stream share it. */
export function buildLiveState() {
  const orchestrator = getMarketOrchestrator();
  const config = getConfig();
  const pm = orchestrator.portfolioManager;
  return {
    orchestrator: orchestrator.getStats(),
    liveMarkets: orchestrator.getLiveMarkets(),
    openPositions: orchestrator.getOpenPositionSnapshots(),
    btcPrice: getBtcPriceWatcher().getCurrentTwap(),
    portfolio: {
      cashBalance: pm.getCashBalance(),
      initialCapital: pm.getInitialCapital(),
      openPositionsValue: orchestrator.computeOpenPositionsValue(),
    },
    config: {
      marketWindow: WINDOW_CONFIG.label,
      twapLookbackSeconds: WINDOW_CONFIG.twapLookbackSeconds,
      minEntryPrice: STRATEGY.minEntryPrice,
      maxEntryPrice: STRATEGY.maxEntryPrice,
      entryWindowOpenSeconds: STRATEGY.entryWindowOpenSeconds,
      entryWindowCloseSeconds: STRATEGY.entryWindowCloseSeconds,
      sigmaWindowMs: STRATEGY.sigmaWindowMs,
      flowMinPrintShares: STRATEGY.flowMinPrintShares,
      flowMinPrints: STRATEGY.flowMinPrints,
      flowBurstMs: STRATEGY.flowBurstMs,
      vetoSdMultiple: STRATEGY.vetoSdMultiple,
      stopLossFraction: STRATEGY.stopLossFraction,
      stopConfirmMs: STRATEGY.stopConfirmMs,
      startingCapital: config.portfolio.startingCapital,
      positionBudgetUsd: FIXED_POSITION_BUDGET_USD,
    },
    clock: getMarketClock().getStatus(),
    timestamp: marketNow(),
  };
}

export type LiveState = ReturnType<typeof buildLiveState>;

let instance: ApiServer | null = null;
export function getApiServer(): ApiServer {
  if (!instance) instance = new ApiServer();
  return instance;
}
