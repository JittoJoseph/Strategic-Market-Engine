import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { ConfigSchema, STRATEGY } from "../types/index.js";
import { loadConfig } from "../utils/config.js";

const REQUIRED = {
  SUPABASE_DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  ADMIN_PASSWORD: "x",
};
const KEYS = [...Object.keys(REQUIRED), "STARTING_CAPITAL", "PORT", "HOST", "LOG_LEVEL", "NODE_ENV"];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, REQUIRED);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("configuration", () => {
  it("built-in defaults satisfy the schema", () => {
    expect(ConfigSchema.safeParse(loadConfig()).success).toBe(true);
  });

  it("the shipped .env.example satisfies the schema", () => {
    const text = readFileSync(`${import.meta.dirname}/../../.env.example`, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && KEYS.includes(m[1]!)) process.env[m[1]!] = m[2]!.trim();
    }
    expect(ConfigSchema.safeParse(loadConfig()).success).toBe(true);
  });

  it("strategy constants are internally consistent", () => {
    expect(STRATEGY.entryWindowCloseSeconds).toBeLessThan(STRATEGY.entryWindowOpenSeconds);
    expect(STRATEGY.minEntryPrice).toBeLessThan(STRATEGY.maxEntryPrice);
    expect(STRATEGY.flowMinPrints).toBeGreaterThanOrEqual(2);
    expect(STRATEGY.stopLossFraction).toBeGreaterThan(0);
    expect(STRATEGY.stopLossFraction).toBeLessThan(1);
  });
});
