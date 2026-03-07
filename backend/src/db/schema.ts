import {
  pgTable,
  text,
  boolean,
  timestamp,
  jsonb,
  decimal,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ============================================
// BTC End-of-Window Micro-Profit Simulation Schema
// ============================================

/** Cached market metadata from Gamma API */
export const markets = pgTable(
  "markets",
  {
    id: text("id").primaryKey(),
    conditionId: text("condition_id"),
    slug: text("slug"),
    question: text("question"),
    clobTokenIds: jsonb("clob_token_ids"), // ["tokenUp","tokenDown"]
    outcomes: jsonb("outcomes"), // ["Up","Down"]
    windowType: text("window_type").notNull(), // 5M, 15M, 1H, 4H, 1D
    category: text("category").notNull(), // btc-5m, btc-15m, etc.
    endDate: text("end_date"),
    targetPrice: decimal("target_price", { precision: 18, scale: 2 }), // BTC target parsed from question
    active: boolean("active").default(true).notNull(),
    metadata: jsonb("metadata"),
    lastFetchedAt: timestamp("last_fetched_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    slugIdx: index("markets_slug_idx").on(table.slug),
    activeIdx: index("markets_active_idx").on(table.active),
    endDateIdx: index("markets_end_date_idx").on(table.endDate),
    windowTypeIdx: index("markets_window_type_idx").on(table.windowType),
  }),
);

/** Portfolio state (single-row table) */
export const portfolio = pgTable("portfolio", {
  id: integer("id").primaryKey().default(1),
  initialCapital: decimal("initial_capital", {
    precision: 18,
    scale: 8,
  }).notNull(),
  cashBalance: decimal("cash_balance", { precision: 18, scale: 8 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** Simulated trades */
export const simulatedTrades = pgTable(
  "simulated_trades",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    marketId: text("market_id"),
    tokenId: text("token_id"),
    marketCategory: text("market_category"),
    windowType: text("window_type"), // 5M, 15M, etc.
    side: text("side").default("BUY").notNull(),
    outcomeLabel: text("outcome_label"), // "Up" or "Down"
    orderType: text("order_type").default("FAK").notNull(),
    // Entry
    entryTs: timestamp("entry_ts").notNull(),
    entryPrice: decimal("entry_price", { precision: 18, scale: 8 }).notNull(),
    entryShares: decimal("entry_shares", { precision: 18, scale: 8 }).notNull(),
    /** Budget allocated from portfolio (portfolioValue / slots) */
    positionBudget: decimal("position_budget", {
      precision: 18,
      scale: 8,
    }).notNull(),
    /** Actual USD spent (shares × avgFillPrice + fees) — deducted from cash */
    actualCost: decimal("actual_cost", { precision: 18, scale: 8 }).notNull(),
    entryFees: decimal("entry_fees", { precision: 18, scale: 8 }).default("0"),
    fillStatus: text("fill_status").default("FULL"), // FULL | PARTIAL | FAILED
    // BTC context at entry
    btcPriceAtEntry: decimal("btc_price_at_entry", { precision: 18, scale: 2 }),
    btcTargetPrice: decimal("btc_target_price", { precision: 18, scale: 2 }),
    btcDistanceUsd: decimal("btc_distance_usd", {
      precision: 10,
      scale: 4,
    }),
    // Momentum context at entry
    momentumDirection: text("momentum_direction"), // "UP" | "DOWN"
    momentumChangeUsd: decimal("momentum_change_usd", {
      precision: 10,
      scale: 4,
    }),
    // Exit / resolution
    exitPrice: decimal("exit_price", { precision: 18, scale: 8 }),
    exitTs: timestamp("exit_ts"),
    exitOutcome: text("exit_outcome"), // WIN | LOSS
    realizedPnl: decimal("realized_pnl", { precision: 18, scale: 8 }),
    /** Lowest bestBid observed while position was open (until window close) */
    minPriceDuringPosition: decimal("min_price_during_position", {
      precision: 18,
      scale: 8,
    }),
    // Status
    status: text("status").default("OPEN").notNull(),
    orderbookSnapshot: jsonb("orderbook_snapshot"),
    raw: jsonb("raw"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    marketIdIdx: index("st_market_id_idx").on(table.marketId),
    statusIdx: index("st_status_idx").on(table.status),
    entryTsIdx: index("st_entry_ts_idx").on(table.entryTs),
    // Prevent duplicate open trades per market+token
    uqOpenTradePerToken: uniqueIndex("uq_open_trade_per_market_token")
      .on(table.marketId, table.tokenId)
      .where(sql`status = 'OPEN'`),
  }),
);

/** Audit log for errors, rate limits, system events */
export const auditLogs = pgTable(
  "audit_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    level: text("level").notNull(),
    category: text("category").notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    levelIdx: index("al_level_idx").on(table.level),
    categoryIdx: index("al_category_idx").on(table.category),
    createdAtIdx: index("al_created_at_idx").on(table.createdAt),
  }),
);
