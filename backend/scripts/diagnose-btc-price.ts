// Monitors the RTDS feeds and the live API to diagnose a frozen BTC price.
// Usage: npx tsx scripts/diagnose-btc-price.ts

import WebSocket from "ws";

const RTDS_WS = "wss://ws-live-data.polymarket.com";
const API_BASE = "https://penguinx-btc-analysis.onrender.com";
const TEST_DURATION_MS = 60_000;

interface PriceEntry {
  source: "binance" | "chainlink" | "chainlink_backfill";
  symbol: string;
  price: number;
  rawTimestamp: number;
  wallClock: number;
  lagMs: number;
}

interface FeedHealth {
  lastTickMs: number;
  tickCount: number;
  longestSilenceMs: number;
}

const collected: PriceEntry[] = [];
const feedHealth: Record<string, FeedHealth> = {
  binance: { lastTickMs: 0, tickCount: 0, longestSilenceMs: 0 },
  chainlink: { lastTickMs: 0, tickCount: 0, longestSilenceMs: 0 },
};

let connectionOpenTime = 0;
let firstBinanceTick = 0;
let firstChainlinkTick = 0;
let backfillReceived = false;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

async function fetchApiState() {
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    const data = await res.json() as any;
    const btcTs = data.btcPrice?.timestamp ?? 0;
    const btcAge = Date.now() - btcTs;
    console.log("📡 Current production API state:");
    console.log(`  BTC price:         $${data.btcPrice?.price ?? "N/A"}`);
    console.log(
      `  BTC price age:     ${(btcAge / 1000).toFixed(1)}s ${btcAge > 30_000 ? "⚠️  STALE!" : "✅ fresh"}`
    );
    console.log(`  BTC timestamp:     ${new Date(btcTs).toISOString()}`);
    console.log(`  Wall clock now:    ${new Date().toISOString()}`);
    console.log(`  btcConnected:      ${data.orchestrator?.btcConnected}`);
    return data;
  } catch (e: any) {
    console.error("  ❌ Failed to fetch API state:", e.message);
    return null;
  }
}

function updateFeedHealth(source: "binance" | "chainlink") {
  const h = feedHealth[source]!;
  const now = Date.now();
  if (h.lastTickMs > 0) {
    const silence = now - h.lastTickMs;
    if (silence > h.longestSilenceMs) h.longestSilenceMs = silence;
  }
  h.lastTickMs = now;
  h.tickCount++;
}

function startHealthMonitor() {
  healthCheckTimer = setInterval(() => {
    const now = Date.now();
    const binageAge = now - feedHealth.binance!.lastTickMs;
    const chainlinkAge = now - feedHealth.chainlink!.lastTickMs;
    const STALE_THRESHOLD = 15_000;

    if (feedHealth.binance!.tickCount > 0 && binageAge > STALE_THRESHOLD) {
      console.log(
        `\n🔴 [WATCHDOG] Binance feed STALE for ${(binageAge / 1000).toFixed(0)}s — production WS is stuck!`
      );
    }
    if (feedHealth.chainlink!.tickCount > 0 && chainlinkAge > STALE_THRESHOLD) {
      console.log(
        `\n🔴 [WATCHDOG] Chainlink feed STALE for ${(chainlinkAge / 1000).toFixed(0)}s — production WS is stuck!`
      );
    }
  }, 5_000);
}

function testRtdsWebSocket(): Promise<void> {
  return new Promise((resolve) => {
    console.log(`\n${"═".repeat(60)}`);
    console.log("  RTDS WebSocket Feed Test");
    console.log(`${"═".repeat(60)}`);
    console.log(`Connecting to ${RTDS_WS}...`);
    console.log(`Test duration: ${TEST_DURATION_MS / 1000}s\n`);

    const ws = new WebSocket(RTDS_WS);
    let pingTimer: ReturnType<typeof setInterval>;

    ws.on("open", () => {
      connectionOpenTime = Date.now();
      console.log(`✅ Connected at ${new Date().toISOString()}\n`);

      const subscribeMsg = JSON.stringify({
        action: "subscribe",
        subscriptions: [
          {
            topic: "crypto_prices_chainlink",
            type: "*",
            filters: '{"symbol":"btc/usd"}',
          },
          { topic: "crypto_prices", type: "*" },
        ],
      });

      ws.send(subscribeMsg);
      console.log("📤 Subscribed to: crypto_prices_chainlink + crypto_prices\n");
      console.log("Legend: [b]=Binance tick [c]=Chainlink tick [.]=PING\n");

      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("PING");
          process.stdout.write(".");
        }
      }, 5_000);

      startHealthMonitor();
    });

    ws.on("message", (rawData) => {
      const text = (rawData as Buffer).toString().trim();
      if (text === "PONG" || text === "pong") return;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        console.log(`\n⚠️  Non-JSON:`, text.substring(0, 100));
        return;
      }

      const topic = msg["topic"] as string | undefined;
      const msgType = msg["type"] as string | undefined;
      const payload = msg["payload"] as Record<string, unknown> | undefined;
      const now = Date.now();

      if (topic === "crypto_prices" && msgType === "subscribe") {
        const symbol = payload?.["symbol"] as string | undefined;
        const data = payload?.["data"];
        if (symbol === "btc/usd" && Array.isArray(data)) {
          backfillReceived = true;
          console.log(`\n📦 [Chainlink BACKFILL] ${data.length} historical ticks received`);

          if (data.length > 0) {
            const first = data[0] as any;
            const last = data[data.length - 1] as any;
            const firstTsRaw = first?.timestamp ?? 0;
            const lastTsRaw = last?.timestamp ?? 0;
            // < 1e12 means the timestamp is in seconds, not milliseconds
            const firstTsMs = firstTsRaw < 1e12 ? firstTsRaw * 1000 : firstTsRaw;
            const lastTsMs = lastTsRaw < 1e12 ? lastTsRaw * 1000 : lastTsRaw;

            console.log(`  First: $${first?.value?.toFixed(2)} rawTs=${firstTsRaw} (${new Date(firstTsMs).toISOString()}, age=${((now - firstTsMs) / 60000).toFixed(1)}m)`);
            console.log(`  Last:  $${last?.value?.toFixed(2)} rawTs=${lastTsRaw} (${new Date(lastTsMs).toISOString()}, age=${((now - lastTsMs) / 60000).toFixed(1)}m)`);
            console.log(`  Coverage: ${((lastTsMs - firstTsMs) / 60000).toFixed(1)} minutes of history`);

            const ninetySecondsAgo = now - 90_000;
            const coversLookback = firstTsMs <= ninetySecondsAgo;
            console.log(`  Covers 90s lookback: ${coversLookback ? "✅" : "⚠️  NO"}`);

            for (const item of data as any[]) {
              if (typeof item?.timestamp === "number" && typeof item?.value === "number") {
                collected.push({
                  source: "chainlink_backfill",
                  symbol: "btc/usd",
                  price: item.value,
                  rawTimestamp: item.timestamp,
                  wallClock: now,
                  lagMs: 0,
                });
              }
            }
          }
        }
        return;
      }

      if (topic === "crypto_prices" && msgType !== "subscribe") {
        const symbol = payload?.["symbol"] as string | undefined;
        const value = payload?.["value"];
        const rawTs = (payload?.["timestamp"] ?? msg["timestamp"]) as number | undefined;

        if (symbol === "btcusdt" && typeof value === "number") {
          const rawTsMs = rawTs ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : 0;
          const lagMs = rawTsMs > 0 ? now - rawTsMs : 0;

          if (firstBinanceTick === 0) {
            firstBinanceTick = now;
            console.log(
              `\n🟡 [Binance FIRST TICK] $${value.toFixed(2)} — ${((now - connectionOpenTime) / 1000).toFixed(1)}s after connect — lag=${lagMs}ms`
            );
          } else {
            const sinceLastTick = now - feedHealth.binance!.lastTickMs;
            if (sinceLastTick > 5000) {
              console.log(`\n🟡 [Binance] $${value.toFixed(2)} (gap=${(sinceLastTick / 1000).toFixed(1)}s)`);
            } else {
              process.stdout.write("b");
            }
          }

          updateFeedHealth("binance");
          collected.push({ source: "binance", symbol, price: value, rawTimestamp: rawTs ?? 0, wallClock: now, lagMs });
        } else if (symbol && symbol !== "btcusdt") {
          if (Math.random() < 0.005) process.stdout.write(`(${symbol})`);
        }
        return;
      }

      if (topic === "crypto_prices_chainlink") {
        const symbol = payload?.["symbol"] as string | undefined;
        const value = payload?.["value"];
        const rawTs = (payload?.["timestamp"] ?? msg["timestamp"]) as number | undefined;

        if (symbol === "btc/usd" && typeof value === "number") {
          const rawTsMs = rawTs ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : 0;
          const lagMs = rawTsMs > 0 ? now - rawTsMs : 0;

          if (firstChainlinkTick === 0) {
            firstChainlinkTick = now;
            console.log(
              `\n🔵 [Chainlink FIRST TICK] $${value.toFixed(2)} — ${((now - connectionOpenTime) / 1000).toFixed(1)}s after connect — lag=${lagMs}ms`
            );
          } else {
            const sinceLastTick = now - feedHealth.chainlink!.lastTickMs;
            if (sinceLastTick > 3000) {
              console.log(`\n🔵 [Chainlink] $${value.toFixed(2)} (gap=${(sinceLastTick / 1000).toFixed(1)}s)`);
            } else {
              process.stdout.write("c");
            }
          }

          updateFeedHealth("chainlink");
          collected.push({ source: "chainlink", symbol, price: value, rawTimestamp: rawTs ?? 0, wallClock: now, lagMs });
        }
        return;
      }

      if (Math.random() < 0.02) {
        console.log(`\n❓ Unknown (sampled): ${JSON.stringify(msg).substring(0, 200)}`);
      }
    });

    ws.on("error", (err) => console.error(`\n❌ WebSocket error:`, err.message));
    ws.on("close", (code, reason) =>
      console.log(`\n🔌 Closed: code=${code} reason=${reason.toString()}`)
    );

    setTimeout(() => {
      clearInterval(pingTimer);
      if (healthCheckTimer) clearInterval(healthCheckTimer);
      ws.close();
      resolve();
    }, TEST_DURATION_MS);
  });
}

function printSummary() {
  const now = Date.now();
  console.log(`\n\n${"═".repeat(60)}`);
  console.log("  DIAGNOSTIC SUMMARY");
  console.log(`${"═".repeat(60)}\n`);

  const binanceTicks = collected.filter((e) => e.source === "binance");
  const chainlinkTicks = collected.filter((e) => e.source === "chainlink");
  const backfill = collected.filter((e) => e.source === "chainlink_backfill");

  console.log(`📊 Feed tick counts over ${TEST_DURATION_MS / 1000}s:`);
  const binanceOk = binanceTicks.length > 0;
  const chainlinkOk = chainlinkTicks.length > 0;
  console.log(`  Binance real-time:   ${binanceTicks.length} ticks ${binanceOk ? "✅" : "⚠️  DEAD"}`);
  console.log(`  Chainlink real-time: ${chainlinkTicks.length} ticks ${chainlinkOk ? "✅" : "⚠️  DEAD"}`);
  console.log(`  Chainlink backfill:  ${backfill.length} historical ticks`);

  if (binanceTicks.length > 1) {
    const first = binanceTicks[0]!;
    const last = binanceTicks[binanceTicks.length - 1]!;
    const avgInterval = (last.wallClock - first.wallClock) / (binanceTicks.length - 1);
    const priceChange = last.price - first.price;
    console.log(`\n🟡 Binance:`);
    console.log(`  Price: $${first.price.toFixed(2)} → $${last.price.toFixed(2)} (Δ${priceChange >= 0 ? "+" : ""}$${priceChange.toFixed(2)})`);
    console.log(`  Avg interval: ${avgInterval.toFixed(0)}ms`);
    console.log(`  Longest silence: ${feedHealth.binance!.longestSilenceMs}ms`);
    console.log(`  Time to first tick: ${((firstBinanceTick - connectionOpenTime) / 1000).toFixed(1)}s`);
  } else if (!binanceOk) {
    console.log(`\n🟡 Binance: ⚠️  NO TICKS — feed appears dead`);
    console.log(`  The RTDS WS is OPEN but no btcusdt messages arrived.`);
    console.log(`  This directly causes the BTC price freeze in production!`);
  }

  if (chainlinkTicks.length > 1) {
    const first = chainlinkTicks[0]!;
    const last = chainlinkTicks[chainlinkTicks.length - 1]!;
    const avgInterval = (last.wallClock - first.wallClock) / (chainlinkTicks.length - 1);
    console.log(`\n🔵 Chainlink:`);
    console.log(`  Price: $${first.price.toFixed(2)} → $${last.price.toFixed(2)}`);
    console.log(`  Avg interval: ${avgInterval.toFixed(0)}ms`);
    console.log(`  Longest silence: ${feedHealth.chainlink!.longestSilenceMs}ms`);
  } else if (!chainlinkOk) {
    console.log(`\n🔵 Chainlink: ⚠️  NO TICKS`);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log("🔬 ROOT CAUSE ANALYSIS:");

  if (!binanceOk && !chainlinkOk) {
    console.log("  ❌ CONFIRMED: RTDS WebSocket delivers NO real-time BTC ticks.");
    console.log("  → setPrice() is never called after backfill");
    console.log("  → currentPrice freezes at last backfill value");
    console.log("  → btcConnected stays true (WebSocket.OPEN is not enough)");
    console.log("  → strategy stops trading because price never changes");
  } else if (binanceOk && !chainlinkOk) {
    console.log("  ℹ️  Binance is working, Chainlink is silent (normal if rate limited)");
    console.log("  → Binance alone should keep price updating");
  } else if (!binanceOk && chainlinkOk) {
    console.log("  ℹ️  Chainlink is working, Binance is silent (~1 tick/sec from Chainlink is enough)");
  } else {
    console.log("  ✅ Both feeds active. Freeze may be intermittent.");
    console.log("  → Check if feed stops after longer periods");
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log("🔧 FIX:");
  console.log("  BtcPriceWatcher needs a STALENESS WATCHDOG:");
  console.log("  - Track wall-clock time of last setPrice() call");
  console.log("  - If no tick for > STALE_MS (e.g., 30s), force-reconnect RTDS WebSocket");
  console.log("  - Even when ws.readyState === OPEN, close + reconnect");
  console.log("  - This auto-heals frozen feeds without any manual intervention");
  console.log(`${"═".repeat(60)}\n`);
}

async function main() {
  console.log(`${"═".repeat(60)}`);
  console.log("  PenguinX BTC Price Feed Diagnostic");
  console.log(`${"═".repeat(60)}\n`);

  await fetchApiState();

  console.log(`\nStarting ${TEST_DURATION_MS / 1000}s RTDS WebSocket test...\n`);
  await testRtdsWebSocket();

  printSummary();

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
