import { EventEmitter } from "events";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import {
  WINDOW_CONFIGS,
  type GammaMarket,
  type WindowConfig,
} from "../types/index.js";
import { getPolymarketClient, PolymarketClient } from "./polymarket-client.js";
import { insertMarketIfNew } from "../db/client.js";

const logger = createModuleLogger("market-scanner");

/**
 * Discovers BTC markets for the configured window type from Polymarket.
 *
 * Uses **deterministic slug computation** to always find the correct markets.
 * BTC 5-minute window slugs follow the pattern:
 *   btc-updown-5m-{UNIX_TIMESTAMP}
 * where UNIX_TIMESTAMP is the window START time (seconds), aligned to round
 * 5-minute boundaries:
 *   windowStart = Math.floor(now / 300) * 300
 *
 * On every scan cycle we compute the current + next N window slugs, PLUS
 * recent past windows, fetch those exact markets from the Gamma /markets API,
 * catalog them in the DB, and emit them for the orchestrator.  The orchestrator
 * deduplicates via its own activeMarkets Map — no in-memory knownMarketIds set
 * needed here.
 *
 * Emits:
 *   "newMarket" — { market: GammaMarket }
 */
export class MarketScanner extends EventEmitter {
  private client: PolymarketClient;
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private discoveredCount = 0;
  private running = false;

  /** How many future windows to pre-fetch alongside the current one */
  private static readonly LOOKAHEAD_WINDOWS = 3;
  /** How many past windows to check for existing markets */
  private static readonly LOOKBEHIND_WINDOWS = 2;

  constructor() {
    super();
    this.client = getPolymarketClient();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const config = getConfig();
    const windowConfig = WINDOW_CONFIGS[config.strategy.marketWindow];

    logger.info(
      {
        window: config.strategy.marketWindow,
        slugPrefix: windowConfig.slugPrefix,
        durationMs: windowConfig.durationMs,
        scanIntervalMs: config.strategy.scanIntervalMs,
        lookahead: MarketScanner.LOOKAHEAD_WINDOWS,
        lookbehind: MarketScanner.LOOKBEHIND_WINDOWS,
      },
      "Starting market scanner (deterministic slug mode)",
    );

    // Initial scan
    await this.scan();

    // Periodic scanning
    this.scanInterval = setInterval(() => {
      this.scan().catch((err) =>
        logger.error({ error: err }, "Scan iteration failed"),
      );
    }, config.strategy.scanIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    logger.info("Market scanner stopped");
  }

  getDiscoveredCount(): number {
    return this.discoveredCount;
  }

  /**
   * Compute deterministic window-start timestamps for past, current + upcoming
   * windows. For 5M windows: floor(now / 300) * 300 = current window start.
   */
  private computeWindowSlugs(windowConfig: WindowConfig): string[] {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const durationSeconds = windowConfig.durationMs / 1000;
    const currentWindowStart =
      Math.floor(nowSeconds / durationSeconds) * durationSeconds;

    const slugs: string[] = [];

    // Include recent past windows
    for (let i = MarketScanner.LOOKBEHIND_WINDOWS; i > 0; i--) {
      const windowStart = currentWindowStart - i * durationSeconds;
      slugs.push(`${windowConfig.slugPrefix}-${windowStart}`);
    }

    // Include current and future windows
    for (let i = 0; i < MarketScanner.LOOKAHEAD_WINDOWS; i++) {
      const windowStart = currentWindowStart + i * durationSeconds;
      slugs.push(`${windowConfig.slugPrefix}-${windowStart}`);
    }

    return slugs;
  }

  async scan(): Promise<void> {
    const config = getConfig();
    const windowConfig = WINDOW_CONFIGS[config.strategy.marketWindow];

    try {
      const slugs = this.computeWindowSlugs(windowConfig);

      logger.debug({ slugs }, "Scanning for markets by deterministic slugs");

      const markets = await this.client.getMarkets({ slug: slugs });

      let newMarketsFound = 0;

      for (const market of markets) {
        // Verify this is actually a market for our configured window type
        if (!market.slug?.startsWith(windowConfig.slugPrefix)) continue;

        // Skip already-closed markets (resolved by oracle)
        if (market.closed) continue;

        // Catalog into DB (idempotent — INSERT ON CONFLICT DO NOTHING)
        const wasNew = await this.catalogMarket(market, windowConfig);
        if (wasNew) {
          this.discoveredCount++;
          newMarketsFound++;
        }

        // Only emit for truly new markets — orchestrator still deduplicates
        if (wasNew) {
          this.emit("newMarket", { market });
        }
      }

      if (newMarketsFound > 0) {
        logger.info(
          { newMarketsFound, total: this.discoveredCount, slugs },
          "Scan complete — new markets found",
        );
      } else {
        logger.debug(
          { returned: markets.length, slugs },
          "Scan complete — no new markets",
        );
      }
    } catch (error) {
      logger.error({ error }, "Market scan failed");
    }
  }

  /**
   * Catalog a discovered market into the database (INSERT only, no UPDATE).
   * Returns true if the market was truly new (inserted), false if it already existed.
   */
  private async catalogMarket(
    market: GammaMarket,
    windowConfig: WindowConfig,
  ): Promise<boolean> {
    try {
      const tokenIds = PolymarketClient.parseClobTokenIds(market);
      const outcomes = PolymarketClient.parseOutcomes(market);
      const targetPrice = PolymarketClient.parseTargetPrice(market.question);

      const wasNew = await insertMarketIfNew(market.id, {
        conditionId: market.conditionId,
        slug: market.slug ?? undefined,
        question: market.question ?? undefined,
        clobTokenIds: tokenIds,
        outcomes,
        windowType: getConfig().strategy.marketWindow,
        category: windowConfig.category,
        endDate: market.endDate,
        targetPrice,
        active: market.active ?? true,
        metadata: market,
      });

      return wasNew;
    } catch (error) {
      logger.error({ error, marketId: market.id }, "Failed to catalog market");
      return false;
    }
  }
}

// Singleton
let instance: MarketScanner | null = null;
export function getMarketScanner(): MarketScanner {
  if (!instance) instance = new MarketScanner();
  return instance;
}
