import { createModuleLogger } from "./utils/logger.js";
import { getConfig } from "./utils/config.js";
import { connectDatabase } from "./db/client.js";
import { getBtcPriceWatcher } from "./services/btc-price-watcher.js";
import { getMarketOrchestrator } from "./services/market-orchestrator.js";
import { getApiServer } from "./services/api-server.js";

const logger = createModuleLogger("main");

async function main(): Promise<void> {
  logger.info("═══════════════════════════════════════════");
  logger.info("  PenguinX BTC Analysis — v3.0");
  logger.info("  End-of-Window Micro-Profit Strategy");
  logger.info("═══════════════════════════════════════════");

  // 1. Load and validate configuration
  const config = getConfig();
  logger.info(
    {
      window: config.strategy.marketWindow,
      threshold: config.strategy.entryPriceThreshold,
      maxEntryPrice: config.strategy.maxEntryPrice,
      tradeWindowSec: config.strategy.tradeFromWindowSeconds,
      startingCapital: config.portfolio.startingCapital,
      maxPositions: config.strategy.maxSimultaneousPositions,
      minBtcDistance: config.strategy.minBtcDistanceUsd,
      stopLoss: config.strategy.stopLossEnabled
        ? config.strategy.stopLossPriceTrigger
        : "disabled",
    },
    "Configuration loaded",
  );

  // 2. Connect to database
  await connectDatabase();

  // 3. Start BTC price watcher (RTDS WebSocket)
  const btcWatcher = getBtcPriceWatcher();
  btcWatcher.start();
  logger.info("BTC price watcher started");

  // 4. Start market orchestrator (scanner + WS + strategy + execution)
  const orchestrator = getMarketOrchestrator();
  await orchestrator.start();

  // 5. Start API server
  const apiServer = getApiServer();
  await apiServer.start();

  logger.info("All systems operational ✓");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");

    try {
      apiServer.stop();
      orchestrator.stop();
      btcWatcher.stop();
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
