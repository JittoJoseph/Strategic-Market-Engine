import { createModuleLogger } from "./utils/logger.js";
import { getConfig } from "./utils/config.js";
import { FIXED_POSITION_BUDGET_USD, WINDOW_CONFIG, STRATEGY } from "./types/index.js";
import { connectDatabase } from "./db/client.js";
import { getBtcPriceWatcher } from "./services/btc-price-watcher.js";
import { getPlatformStatusWatcher } from "./services/platform-status.js";
import { getMarketClock } from "./services/market-clock.js";
import { getMarketOrchestrator } from "./services/market-orchestrator.js";
import { getApiServer } from "./services/api-server.js";

const logger = createModuleLogger("main");

async function main(): Promise<void> {
  logger.info("═══════════════════════════════════════════");
  logger.info("  PenguinX BTC Analysis — v4.0");
  logger.info("  Persistent-Flow Strategy - BTC 15-Minute Up/Down");
  logger.info("═══════════════════════════════════════════");

  const config = getConfig();
  logger.info(
    {
      window: WINDOW_CONFIG.label,
      twapLookbackSeconds: WINDOW_CONFIG.twapLookbackSeconds,
      entryBand: `${STRATEGY.minEntryPrice}–${STRATEGY.maxEntryPrice}`,
      entryWindowSec: `${STRATEGY.entryWindowCloseSeconds}–${STRATEGY.entryWindowOpenSeconds}`,
      flowMinPrintShares: STRATEGY.flowMinPrintShares,
      flowMinPrints: STRATEGY.flowMinPrints,
      flowBurstMs: STRATEGY.flowBurstMs,
      vetoSdMultiple: STRATEGY.vetoSdMultiple,
      entryGate: "status.polymarket.com reads UP",
      sigmaWindowMs: STRATEGY.sigmaWindowMs,
      startingCapital: config.portfolio.startingCapital,
      positionBudget: `$${FIXED_POSITION_BUDGET_USD} fixed (simulation)`,
      stopLoss: `${(STRATEGY.stopLossFraction * 100).toFixed(0)}% below entry, held ${STRATEGY.stopConfirmMs / 1000}s (always on)`,
    },
    "Configuration loaded",
  );

  await connectDatabase();

  // Must precede anything that reasons about market time or stamps prices.
  await getMarketClock().start();

  const btcWatcher = getBtcPriceWatcher();
  btcWatcher.start();
  logger.info("BTC price watcher started");

  const platformStatus = getPlatformStatusWatcher();
  await platformStatus.start();
  logger.info({ status: platformStatus.getStatus().status }, "Polymarket status watcher started");

  const orchestrator = getMarketOrchestrator();
  await orchestrator.start();

  const apiServer = getApiServer();
  await apiServer.start();

  logger.info("All systems operational ✓");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");

    try {
      apiServer.stop();
      orchestrator.stop();
      btcWatcher.stop();
      platformStatus.stop();
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
    }

    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    logger.error({ err }, "Unhandled rejection");
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
