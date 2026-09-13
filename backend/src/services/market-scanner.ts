import { EventEmitter } from "events";
import { createModuleLogger } from "../utils/logger.js";
import { STRATEGY, WINDOW_CONFIG } from "../types/index.js";

import { getPolymarketClient, PolymarketClient } from "./polymarket-client.js";
import { marketNow } from "./market-clock.js";

const logger = createModuleLogger("market-scanner");
const LOOKBEHIND_WINDOWS = 2;
const LOOKAHEAD_WINDOWS = 3;

/** Discovers windows by deterministic slug `btc-updown-15m-<windowStartSeconds>`. */
export class MarketScanner extends EventEmitter {
  private client: PolymarketClient = getPolymarketClient();
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private discoveredCount = 0;
  private running = false;
  private seen = new Set<string>();

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.scan();
    this.scanInterval = setInterval(() => this.scan(), STRATEGY.scanIntervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.scanInterval) clearInterval(this.scanInterval);
    this.scanInterval = null;
  }

  getDiscoveredCount(): number {
    return this.discoveredCount;
  }

  /** Forget seen markets so a wiped session re-activates the ones in flight. */
  reset(): void {
    this.seen.clear();
    this.discoveredCount = 0;
  }

  private windowSlugs(): string[] {
    const duration = WINDOW_CONFIG.durationMs / 1000;
    const current = Math.floor(marketNow() / 1000 / duration) * duration;
    const slugs: string[] = [];
    for (let i = -LOOKBEHIND_WINDOWS; i < LOOKAHEAD_WINDOWS; i++) {
      slugs.push(`${WINDOW_CONFIG.slugPrefix}-${current + i * duration}`);
    }
    return slugs;
  }

  async scan(): Promise<void> {
    const slugs = this.windowSlugs();
    try {
      const markets = await this.client.getMarkets(slugs);
      // Slugs never recur, so anything outside the current set is safe to forget.
      this.seen = new Set([...this.seen].filter((s) => slugs.includes(s)));
      for (const market of markets) {
        if (!market.slug || market.closed || this.seen.has(market.slug)) continue;
        this.seen.add(market.slug);
        this.discoveredCount++;
        this.emit("newMarket", { market });
      }
    } catch (error) {
      logger.error({ error }, "Market scan failed");
    }
  }
}

let instance: MarketScanner | null = null;
export function getMarketScanner(): MarketScanner {
  if (!instance) instance = new MarketScanner();
  return instance;
}
