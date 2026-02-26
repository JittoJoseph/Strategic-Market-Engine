/**
 * RTDS WebSocket Test Script
 * Tests Polymarket's real-time data service WebSocket to verify
 * Chainlink and Binance BTC price feed message structures.
 *
 * Usage: npx tsx scripts/test-rtds-ws.ts
 */

import WebSocket from "ws";

const RTDS_WS = "wss://ws-live-data.polymarket.com";
const TEST_DURATION_MS = 20_000; // 20 seconds

interface PriceEntry {
  source: string;
  symbol: string;
  price: number;
  rawTimestamp: number;
  wallClock: number;
  raw: unknown;
}

const collected: PriceEntry[] = [];

function main() {
  console.log("Connecting to Polymarket RTDS WebSocket...");
  console.log(`URL: ${RTDS_WS}`);
  console.log(`Will collect data for ${TEST_DURATION_MS / 1000}s then exit.\n`);

  const ws = new WebSocket(RTDS_WS);

  ws.on("open", () => {
    console.log("✅ Connected!\n");

    // Subscribe to both Chainlink (BTC/USD filtered) and Binance (all symbols)
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
    console.log("📤 Sent subscription:", subscribeMsg, "\n");

    // Keepalive ping every 5s
    const pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send("PING");
        process.stdout.write(".");
      }
    }, 5_000);

    // Auto-disconnect after test duration
    setTimeout(() => {
      clearInterval(pingTimer);
      ws.close();
      printSummary();
    }, TEST_DURATION_MS);
  });

  ws.on("message", (rawData) => {
    const text = (rawData as Buffer).toString().trim();

    if (text === "PONG" || text === "pong") {
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      console.log("⚠️  Non-JSON message:", text.substring(0, 200));
      return;
    }

    const topic = msg["topic"] as string | undefined;
    const msgType = msg["type"] as string | undefined;
    const payload = msg["payload"] as Record<string, unknown> | undefined;

    // ── Binance: topic="crypto_prices", real-time ticks ──────────────────────
    if (topic === "crypto_prices" && msgType !== "subscribe") {
      const symbol = payload?.["symbol"] as string | undefined;
      const value = payload?.["value"];
      const ts = (payload?.["timestamp"] ?? msg["timestamp"]) as number | undefined;

      if (symbol === "btcusdt" && typeof value === "number") {
        const entry: PriceEntry = {
          source: "binance",
          symbol,
          price: value,
          rawTimestamp: ts ?? 0,
          wallClock: Date.now(),
          raw: { topic, type: msgType, payload },
        };
        collected.push(entry);
        console.log(
          `\n🟡 [Binance]  BTC=$${value.toFixed(2)}  rawTs=${ts}  wallClock=${Date.now()}`
        );
      } else if (symbol) {
        // Other symbols — just note them
        process.stdout.write(`(${symbol})`);
      }
      return;
    }

    // ── Chainlink backfill: topic="crypto_prices", type="subscribe" ──────────
    if (topic === "crypto_prices" && msgType === "subscribe") {
      const symbol = payload?.["symbol"] as string | undefined;
      const data = payload?.["data"];
      if (symbol === "btc/usd" && Array.isArray(data)) {
        console.log(
          `\n🔵 [Chainlink backfill] symbol=${symbol} items=${data.length}`
        );
        // Show first and last items
        if (data.length > 0) {
          console.log("   First item:", JSON.stringify(data[0]));
          console.log("   Last item:", JSON.stringify(data[data.length - 1]));

          // Populate history from backfill
          for (const item of data as any[]) {
            if (
              typeof item?.timestamp === "number" &&
              typeof item?.value === "number"
            ) {
              collected.push({
                source: "chainlink_backfill",
                symbol: "btc/usd",
                price: item.value,
                rawTimestamp: item.timestamp,
                wallClock: Date.now(),
                raw: item,
              });
            }
          }
        }
      }
      return;
    }

    // ── Chainlink real-time: topic="crypto_prices_chainlink" ─────────────────
    if (topic === "crypto_prices_chainlink") {
      const symbol = payload?.["symbol"] as string | undefined;
      const value = payload?.["value"];
      const ts = (payload?.["timestamp"] ?? msg["timestamp"]) as number | undefined;

      if (symbol === "btc/usd" && typeof value === "number") {
        const entry: PriceEntry = {
          source: "chainlink",
          symbol,
          price: value,
          rawTimestamp: ts ?? 0,
          wallClock: Date.now(),
          raw: { topic, type: msgType, payload },
        };
        collected.push(entry);
        console.log(
          `\n🔵 [Chainlink] BTC=$${value.toFixed(2)}  rawTs=${ts}  wallClock=${Date.now()}`
        );
      }
      return;
    }

    // ── Unknown message ───────────────────────────────────────────────────────
    console.log("\n❓ Unknown message:", JSON.stringify(msg).substring(0, 300));
  });

  ws.on("error", (err) => {
    console.error("\n❌ WebSocket error:", err.message);
  });

  ws.on("close", (code, reason) => {
    console.log(`\n🔌 Disconnected: code=${code} reason=${reason.toString()}`);
  });
}

function printSummary() {
  console.log("\n\n══════════════════════════════════════════════");
  console.log("                   SUMMARY");
  console.log("══════════════════════════════════════════════");

  const binance = collected.filter((e) => e.source === "binance");
  const chainlink = collected.filter((e) => e.source === "chainlink");
  const backfill = collected.filter((e) => e.source === "chainlink_backfill");

  console.log(`\n📊 Total entries collected: ${collected.length}`);
  console.log(`  Binance real-time:       ${binance.length}`);
  console.log(`  Chainlink real-time:     ${chainlink.length}`);
  console.log(`  Chainlink backfill:      ${backfill.length}`);

  if (binance.length > 0) {
    const last = binance[binance.length - 1]!;
    const first = binance[0]!;
    const avgIntervalMs =
      binance.length > 1
        ? (last.wallClock - first.wallClock) / (binance.length - 1)
        : 0;
    console.log(`\n🟡 Binance stats:`);
    console.log(`  Price range: $${Math.min(...binance.map((e) => e.price)).toFixed(2)} – $${Math.max(...binance.map((e) => e.price)).toFixed(2)}`);
    console.log(`  Avg tick interval: ${avgIntervalMs.toFixed(0)}ms`);
    console.log(`  First raw ts: ${first.rawTimestamp} | Wall: ${new Date(first.wallClock).toISOString()}`);
    console.log(`  Last raw ts: ${last.rawTimestamp} | Wall: ${new Date(last.wallClock).toISOString()}`);
    console.log(`  Sample raw message:\n`, JSON.stringify(first.raw, null, 2));
  }

  if (chainlink.length > 0) {
    const last = chainlink[chainlink.length - 1]!;
    const first = chainlink[0]!;
    const avgIntervalMs =
      chainlink.length > 1
        ? (last.wallClock - first.wallClock) / (chainlink.length - 1)
        : 0;
    console.log(`\n🔵 Chainlink stats:`);
    console.log(`  Price range: $${Math.min(...chainlink.map((e) => e.price)).toFixed(2)} – $${Math.max(...chainlink.map((e) => e.price)).toFixed(2)}`);
    console.log(`  Avg tick interval: ${avgIntervalMs.toFixed(0)}ms`);
    console.log(`  Sample raw message:\n`, JSON.stringify(first.raw, null, 2));
  }

  if (backfill.length > 0) {
    console.log(`\n📦 Backfill sample (first 3 items):`);
    backfill.slice(0, 3).forEach((e) => {
      console.log(
        `  price=$${e.price.toFixed(2)}  rawTs=${e.rawTimestamp}  age=${Date.now() - e.rawTimestamp}ms`
      );
    });
  }

  // Momentum calculation test
  if (collected.length >= 2) {
    const now = Date.now();
    const lookbackMs = 90_000;
    const cutoffWall = now - lookbackMs;
    const historical = collected.filter(
      (e) => e.wallClock <= cutoffWall && e.source !== "chainlink_backfill"
    );
    const current = collected[collected.length - 1];

    console.log(`\n🔬 Momentum test (lookback=${lookbackMs / 1000}s):`);
    if (historical.length > 0 && current) {
      const histPrice = historical[historical.length - 1]!.price;
      const nowPrice = current.price;
      const delta = nowPrice - histPrice;
      const direction = Math.abs(delta) < 30 ? "NEUTRAL" : delta > 0 ? "UP" : "DOWN";
      console.log(`  Historical price: $${histPrice.toFixed(2)}`);
      console.log(`  Current price:    $${nowPrice.toFixed(2)}`);
      console.log(`  Delta:            ${delta >= 0 ? "+" : ""}$${delta.toFixed(2)}`);
      console.log(`  Momentum:         ${direction}`);
    } else {
      console.log("  ⚠️  Need 90s of real-time data to test momentum (backfill provides it)");
      // Use backfill for momentum test
      if (backfill.length >= 2) {
        const oldest = backfill[0]!;
        const newest = backfill[backfill.length - 1]!;
        const delta = newest.price - oldest.price;
        const direction = Math.abs(delta) < 30 ? "NEUTRAL" : delta > 0 ? "UP" : "DOWN";
        console.log(`  Backfill oldest: $${oldest.price.toFixed(2)} at rawTs=${oldest.rawTimestamp}`);
        console.log(`  Backfill newest: $${newest.price.toFixed(2)} at rawTs=${newest.rawTimestamp}`);
        console.log(`  Delta:           ${delta >= 0 ? "+" : ""}$${delta.toFixed(2)}`);
        console.log(`  Direction:       ${direction}`);
      }
    }
  }

  console.log("\n══════════════════════════════════════════════\n");
  process.exit(0);
}

main();
