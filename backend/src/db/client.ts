import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getConfig } from "../utils/config.js";
import { createModuleLogger } from "../utils/logger.js";
import * as schema from "./schema.js";
import { eq, sql, and } from "drizzle-orm";

const logger = createModuleLogger("database");

let client: postgres.Sql | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (!db) {
    const config = getConfig();
    client = postgres(config.db.url, {
      max: 5,
      idle_timeout: 30,
      connect_timeout: 10,
    });
    db = drizzle(client, { schema, logger: false });
    logger.info("Drizzle database client initialized");
  }
  return db;
}

export async function connectDatabase(): Promise<void> {
  const database = getDb();
  await database.execute(sql`SELECT 1`);
  logger.info("Database connection established");
}

export async function disconnectDatabase(): Promise<void> {
  if (client) {
    await client.end();
    client = null;
    db = null;
    logger.info("Database connection closed");
  }
}

// ============================================
// Market helpers
// ============================================

/**
 * Insert a market row only if it doesn't already exist.
 * Uses INSERT … ON CONFLICT DO NOTHING so we never update existing rows
 * just because the scanner re-discovered them.
 * Returns `true` when a new row was actually inserted.
 */
export async function insertMarketIfNew(
  id: string,
  data: {
    conditionId?: string;
    slug?: string;
    question?: string;
    clobTokenIds?: string[];
    outcomes?: string[];
    windowType: string;
    category: string;
    endDate?: string | null;
    targetPrice?: number | null;
    active?: boolean;
    metadata?: unknown;
  },
): Promise<boolean> {
  const database = getDb();

  const record = {
    id,
    conditionId: data.conditionId || null,
    slug: data.slug || null,
    question: data.question || null,
    clobTokenIds: data.clobTokenIds as any,
    outcomes: data.outcomes as any,
    windowType: data.windowType,
    category: data.category,
    endDate: data.endDate || null,
    targetPrice: data.targetPrice?.toString() ?? null,
    active: data.active ?? true,
    metadata: data.metadata as any,
  };

  const result = await database
    .insert(schema.markets)
    .values(record)
    .onConflictDoNothing({ target: schema.markets.id })
    .returning({ id: schema.markets.id });

  return result.length > 0;
}

/**
 * Load open trades with their market data in a single query (JOIN).
 * Avoids N+1 queries during startup.
 */
export async function loadOpenTradesWithMarkets() {
  const database = getDb();
  const rows = await database
    .select({
      trade: schema.simulatedTrades,
      marketEndDate: schema.markets.endDate,
    })
    .from(schema.simulatedTrades)
    .leftJoin(
      schema.markets,
      eq(schema.simulatedTrades.marketId, schema.markets.id),
    )
    .where(eq(schema.simulatedTrades.status, "OPEN"));
  return rows;
}

// ============================================
// Trade helpers
// ============================================

export async function createSimulatedTrade(data: {
  marketId?: string;
  tokenId: string;
  marketCategory?: string;
  windowType?: string;
  outcomeLabel?: string;
  entryTs: Date;
  entryPrice: string;
  entryShares: string;
  positionBudget: string;
  actualCost: string;
  entryFees?: string;
  fillStatus?: string;
  btcPriceAtEntry?: number;
  btcTargetPrice?: number;
  btcDistanceUsd?: number;
  momentumDirection?: string;
  momentumChangeUsd?: number;
  orderbookSnapshot?: unknown;
  raw?: unknown;
}) {
  const database = getDb();
  const result = await database
    .insert(schema.simulatedTrades)
    .values({
      marketId: data.marketId || null,
      tokenId: data.tokenId,
      marketCategory: data.marketCategory || null,
      windowType: data.windowType || null,
      side: "BUY",
      orderType: "FAK",
      outcomeLabel: data.outcomeLabel || null,
      entryTs: data.entryTs,
      entryPrice: data.entryPrice,
      entryShares: data.entryShares,
      positionBudget: data.positionBudget,
      actualCost: data.actualCost,
      entryFees: data.entryFees ?? "0",
      fillStatus: data.fillStatus ?? "FULL",
      btcPriceAtEntry: data.btcPriceAtEntry?.toString() ?? null,
      btcTargetPrice: data.btcTargetPrice?.toString() ?? null,
      btcDistanceUsd: data.btcDistanceUsd?.toString() ?? null,
      momentumDirection: data.momentumDirection || null,
      momentumChangeUsd: data.momentumChangeUsd?.toString() ?? null,
      orderbookSnapshot: data.orderbookSnapshot as any,
      raw: data.raw as any,
      status: "OPEN",
    })
    .returning();
  return result[0];
}

export async function resolveTrade(
  id: string,
  outcome: "WIN" | "LOSS",
  realizedPnl: string,
  exitPrice?: string,
  minPriceDuringPosition?: string,
  extras?: {
    exitReason?: "RESOLUTION" | "STOP_LOSS" | "TAKE_PROFIT" | "FORCE_TIMEOUT";
    takeProfitTriggerPrice?: string;
    takeProfitTriggeredAt?: Date;
    takeProfitExitPrice?: string;
    takeProfitFees?: string;
    takeProfitPnl?: string;
  },
) {
  const database = getDb();
  const finalExitPrice = exitPrice ?? (outcome === "WIN" ? "1" : "0");

  const result = await database
    .update(schema.simulatedTrades)
    .set({
      exitOutcome: outcome,
      exitPrice: finalExitPrice,
      exitTs: new Date(),
      realizedPnl,
      status: "SETTLED",
      updatedAt: new Date(),
      ...(minPriceDuringPosition != null ? { minPriceDuringPosition } : {}),
      ...(extras?.exitReason ? { exitReason: extras.exitReason } : {}),
      ...(extras?.takeProfitTriggerPrice
        ? { takeProfitTriggerPrice: extras.takeProfitTriggerPrice }
        : {}),
      ...(extras?.takeProfitTriggeredAt
        ? { takeProfitTriggeredAt: extras.takeProfitTriggeredAt }
        : {}),
      ...(extras?.takeProfitExitPrice
        ? { takeProfitExitPrice: extras.takeProfitExitPrice }
        : {}),
      ...(extras?.takeProfitFees ? { takeProfitFees: extras.takeProfitFees } : {}),
      ...(extras?.takeProfitPnl ? { takeProfitPnl: extras.takeProfitPnl } : {}),
    })
    .where(eq(schema.simulatedTrades.id, id))
    .returning();
  return result[0];
}

// ============================================
// Audit log
// ============================================

export async function logAudit(
  level: "info" | "warn" | "error",
  category: string,
  message: string,
  metadata?: unknown,
) {
  const database = getDb();
  try {
    await database.insert(schema.auditLogs).values({
      level,
      category,
      message,
      metadata: metadata as any,
    });
  } catch (e) {
    logger.error({ error: e }, "Failed to write audit log");
  }
}

// ============================================
// Portfolio helpers
// ============================================

/** Get the single portfolio row (or null if not initialised). */
export async function getPortfolio() {
  const database = getDb();
  const rows = await database
    .select()
    .from(schema.portfolio)
    .where(eq(schema.portfolio.id, 1))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Initialise the portfolio row if it doesn't exist.
 * If it already exists, leave it alone (allows server restarts without resetting).
 */
export async function initPortfolio(startingCapital: number) {
  const database = getDb();
  const existing = await getPortfolio();
  if (existing) return existing;

  const result = await database
    .insert(schema.portfolio)
    .values({
      id: 1,
      initialCapital: startingCapital.toString(),
      cashBalance: startingCapital.toString(),
    })
    .returning();
  return result[0];
}

/** Atomically update cash balance. */
export async function updateCashBalance(newBalance: string) {
  const database = getDb();
  const result = await database
    .update(schema.portfolio)
    .set({ cashBalance: newBalance, updatedAt: new Date() })
    .where(eq(schema.portfolio.id, 1))
    .returning();
  return result[0];
}

/**
 * Wipe all data and reset portfolio to the given starting capital.
 * Used by the admin wipe endpoint.
 */
export async function wipeAndResetPortfolio(startingCapital: number) {
  const database = getDb();
  await database.delete(schema.simulatedTrades);
  await database.delete(schema.auditLogs);
  await database.delete(schema.portfolio);
  // Re-create portfolio with fresh capital
  const result = await database
    .insert(schema.portfolio)
    .values({
      id: 1,
      initialCapital: startingCapital.toString(),
      cashBalance: startingCapital.toString(),
    })
    .returning();
  return result[0];
}
