import { Config, ConfigSchema } from "../types/index.js";
import dotenv from "dotenv";

dotenv.config();

function env(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function envNum(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  if (isNaN(parsed)) {
    throw new Error(`Invalid number for environment variable: ${key}`);
  }
  return parsed;
}

export function loadConfig(): Config {
  const rawConfig = {
    db: {
      url: env("SUPABASE_DATABASE_URL"),
    },
    simulation: {
      amountUsd: envNum("SIMULATION_AMOUNT_USD", 1),
    },
    strategy: {
      marketWindow: env("MARKET_WINDOW", "5M"),
      tradeFromWindowSeconds: envNum("TRADE_FROM_WINDOW_SECONDS", 30),
      entryPriceThreshold: envNum("ENTRY_PRICE_THRESHOLD", 0.97),
      maxSimultaneousPositions: envNum("MAX_SIMULTANEOUS_POSITIONS", 5),
      resolutionWatchMinutes: envNum("RESOLUTION_WATCH_MINUTES", 5),
      minBtcDistanceUsd: envNum("MIN_BTC_DISTANCE_USD", 50),
      scanIntervalMs: envNum("SCAN_INTERVAL_MS", 30000),
    },
    stopLoss: {
      threshold: envNum("STOP_LOSS_THRESHOLD", 0.5),
    },
    wipe: {
      password: env("WIPE_PASSWORD"),
    },
    server: {
      port: envNum("PORT", 4000),
      host: env("HOST", "0.0.0.0"),
    },
    logging: {
      level: env("LOG_LEVEL", "info"),
    },
    env: env("NODE_ENV", "development"),
  };

  return ConfigSchema.parse(rawConfig);
}

let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}
