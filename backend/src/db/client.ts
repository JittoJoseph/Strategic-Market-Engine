import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getConfig } from "../utils/config.js";
import { createModuleLogger } from "../utils/logger.js";
import { WINDOW_CONFIG } from "../types/index.js";
import * as schema from "./schema.js";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

const logger = createModuleLogger("database");

let db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (!db) {
    const client = postgres(getConfig().db.url, { max: 5, idle_timeout: 30, connect_timeout: 10 });
    db = drizzle(client, { schema, logger: false });
  }
  return db;
}

export async function connectDatabase(): Promise<void> {
  await getDb().execute(sql`SELECT 1`);
  logger.info("Database connection established");
}

export async function insertMarketIfNew(
  id: string,
  data: {
    conditionId: string | null;
    slug: string | null;
    question: string;
    clobTokenIds: string[];
    outcomes: string[];
    endDate: string;
    targetPrice: number | null;
    metadata: unknown;
  },
): Promise<void> {
  await getDb()
    .insert(schema.markets)
    .values({
      id,
      conditionId: data.conditionId,
      slug: data.slug,
      question: data.question || null,
      clobTokenIds: data.clobTokenIds as any,
      outcomes: data.outcomes as any,
      windowType: WINDOW_CONFIG.category,
      category: "Crypto",
      endDate: data.endDate,
      targetPrice: data.targetPrice?.toString() ?? null,
      active: true,
      metadata: data.metadata as any,
    })
    .onConflictDoNothing({ target: schema.markets.id });
}

export async function loadOpenTradesWithMarkets() {
  return getDb()
    .select({ trade: schema.simulatedTrades, marketEndDate: schema.markets.endDate })
    .from(schema.simulatedTrades)
    .leftJoin(schema.markets, eq(schema.simulatedTrades.marketId, schema.markets.id))
    .where(eq(schema.simulatedTrades.status, "OPEN"));
}

export async function createSimulatedTrade(data: {
  marketId: string;
  tokenId: string;
  windowType: string;
  outcomeLabel: string;
  entryTs: Date;
  entryPrice: string;
  entryShares: string;
  positionBudget: string;
  actualCost: string;
  entryFees: string;
  fillStatus: string;
  twapAtEntry: number;
  rawAtEntry: number;
  strike: number;
  forecastSettlement: number;
  forecastMarginUsd: number;
  forecastSdUsd: number;
  flowPrints: number;
  flowShares: number;
  secondsToEnd: number;
  minPriceDuringPosition: string;
}) {
  const [row] = await getDb()
    .insert(schema.simulatedTrades)
    .values({
      ...data,
      side: "BUY",
      orderType: "FAK",
      status: "OPEN",
      twapAtEntry: data.twapAtEntry.toString(),
      rawAtEntry: data.rawAtEntry.toString(),
      strike: data.strike.toString(),
      forecastSettlement: data.forecastSettlement.toString(),
      forecastMarginUsd: data.forecastMarginUsd.toString(),
      forecastSdUsd: data.forecastSdUsd.toString(),
      flowShares: data.flowShares.toString(),
      secondsToEnd: data.secondsToEnd.toString(),
    })
    .returning();
  return row!;
}

/** Monotonic: concurrent unordered writes can never raise the recorded minimum. */
export async function updateTradeMinPrice(id: string, minPrice: string) {
  await getDb()
    .update(schema.simulatedTrades)
    .set({ minPriceDuringPosition: minPrice, updatedAt: new Date() })
    .where(
      and(
        eq(schema.simulatedTrades.id, id),
        or(
          isNull(schema.simulatedTrades.minPriceDuringPosition),
          gt(schema.simulatedTrades.minPriceDuringPosition, minPrice),
        ),
      ),
    );
}

export async function resolveTrade(
  id: string,
  outcome: "WIN" | "LOSS",
  realizedPnl: string,
  exitPrice: string,
  exitReason: "RESOLUTION" | "STOP_LOSS",
) {
  const [row] = await getDb()
    .update(schema.simulatedTrades)
    .set({
      exitOutcome: outcome,
      exitPrice,
      exitTs: new Date(),
      realizedPnl,
      exitReason,
      status: "SETTLED",
      updatedAt: new Date(),
    })
    .where(eq(schema.simulatedTrades.id, id))
    .returning();
  return row;
}

export async function logAudit(
  level: "info" | "warn" | "error",
  category: string,
  message: string,
  metadata?: unknown,
) {
  try {
    await getDb().insert(schema.auditLogs).values({ level, category, message, metadata: metadata as any });
  } catch (error) {
    logger.error({ error }, "Failed to write audit log");
  }
}

export async function getPortfolio() {
  const [row] = await getDb().select().from(schema.portfolio).where(eq(schema.portfolio.id, 1)).limit(1);
  return row ?? null;
}

async function createPortfolio(startingCapital: number) {
  const capital = startingCapital.toString();
  const [row] = await getDb()
    .insert(schema.portfolio)
    .values({ id: 1, initialCapital: capital, cashBalance: capital })
    .returning();
  return row!;
}

export async function initPortfolio(startingCapital: number) {
  return (await getPortfolio()) ?? createPortfolio(startingCapital);
}

export async function updateCashBalance(newBalance: string) {
  await getDb()
    .update(schema.portfolio)
    .set({ cashBalance: newBalance, updatedAt: new Date() })
    .where(eq(schema.portfolio.id, 1));
}

export async function wipeAndResetPortfolio(startingCapital: number) {
  const database = getDb();
  await database.delete(schema.simulatedTrades);
  await database.delete(schema.auditLogs);
  await database.delete(schema.markets);
  await database.delete(schema.portfolio);
  return createPortfolio(startingCapital);
}
