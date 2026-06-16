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

function envBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value === "true";
}

export function loadConfig(): Config {
  const rawConfig = {
    db: {
      url: env("SUPABASE_DATABASE_URL"),
    },
    portfolio: {
      startingCapital: envNum("STARTING_CAPITAL", 100),
    },
    strategy: {
      marketWindow: env("MARKET_WINDOW", "5M"),
      tradeFromWindowSeconds: envNum("TRADE_FROM_WINDOW_SECONDS", 90),
      maxEntryPrice: envNum("MAX_ENTRY_PRICE", 0.98),
      maxSimultaneousPositions: envNum("MAX_SIMULTANEOUS_POSITIONS", 50),
      allocationPerSplit: envNum("ALLOCATION_PER_SPLIT", 5.0),
      scanIntervalMs: envNum("SCAN_INTERVAL_MS", 60_000),
      takeProfitPercent: envNum("TAKE_PROFIT_PERCENT", 0.30),
      stopLossPercent: envNum("STOP_LOSS_PERCENT", -0.30),
      // Risk guardrails
      consecutiveLossPauseLimit: envNum("CONSECUTIVE_LOSS_PAUSE_LIMIT", 3),
      riskAutoResumeEnabled: envBool("RISK_AUTO_RESUME_ENABLED", false),
      riskAutoResumeCooldownMs: envNum("RISK_AUTO_RESUME_COOLDOWN_MS", 300_000),
    },
    admin: {
      password: env("ADMIN_PASSWORD"),
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
