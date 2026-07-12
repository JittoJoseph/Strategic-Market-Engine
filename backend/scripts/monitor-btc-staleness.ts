// Watches the RTDS feed for the "open but silent" staleness condition and
// force-reconnects, polling the production API to compare.
// Usage: npx tsx scripts/monitor-btc-staleness.ts (Ctrl+C to stop)

import WebSocket from "ws";

const RTDS_WS = "wss://ws-live-data.polymarket.com";
const API_BASE = "https://penguinx-btc-analysis.onrender.com";

let lastBinanceTick = 0;
let lastChainlinkTick = 0;
let binanceCount = 0;
let chainlinkCount = 0;
let lastPrice = 0;
let reconnectCount = 0;
let wsRef: WebSocket | null = null;

function fmt(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function connectRtds() {
  reconnectCount++;
  const ws = new WebSocket(RTDS_WS);
  wsRef = ws;

  ws.on("open", () => {
    console.log(`[${new Date().toISOString()}] 🟢 RTDS connected (reconnect #${reconnectCount})`);

    ws.send(
      JSON.stringify({
        action: "subscribe",
        subscriptions: [
          { topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"btc/usd"}' },
          { topic: "crypto_prices", type: "*" },
        ],
      })
    );

    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, 5_000);
  });

  ws.on("message", (raw) => {
    const text = (raw as Buffer).toString().trim();
    if (text === "PONG" || text === "pong") return;

    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }

    const topic = msg?.topic;
    const payload = msg?.payload;
    const now = Date.now();

    if (topic === "crypto_prices" && msg?.type !== "subscribe") {
      if (payload?.symbol === "btcusdt" && typeof payload?.value === "number") {
        if (lastBinanceTick > 0 && now - lastBinanceTick > 15_000) {
          console.log(`[${new Date().toISOString()}] ⚠️  Binance gap: ${fmt(now - lastBinanceTick)}`);
        }
        lastBinanceTick = now;
        lastPrice = payload.value;
        binanceCount++;
      }
    }

    if (topic === "crypto_prices_chainlink") {
      if (payload?.symbol === "btc/usd" && typeof payload?.value === "number") {
        if (lastChainlinkTick > 0 && now - lastChainlinkTick > 10_000) {
          console.log(`[${new Date().toISOString()}] ⚠️  Chainlink gap: ${fmt(now - lastChainlinkTick)}`);
        }
        lastChainlinkTick = now;
        lastPrice = payload.value;
        chainlinkCount++;
      }
    }
  });

  ws.on("close", (code) => {
    console.log(`[${new Date().toISOString()}] 🔴 RTDS closed (code=${code}), reconnecting...`);
    setTimeout(connectRtds, 2_000);
  });

  ws.on("error", (e) => console.error(`[${new Date().toISOString()}] ❌ WS error:`, e.message));
}

setInterval(() => {
  const now = Date.now();
  const binanceAge = lastBinanceTick > 0 ? now - lastBinanceTick : -1;
  const chainlinkAge = lastChainlinkTick > 0 ? now - lastChainlinkTick : -1;

  const FORCE_RECONNECT_MS = 30_000;

  const binanceStale = binanceAge > FORCE_RECONNECT_MS;
  const chainlinkStale = chainlinkAge > FORCE_RECONNECT_MS;

  if ((binanceAge > 0 || chainlinkAge > 0) && (binanceStale || chainlinkStale)) {
    console.log(
      `[${new Date().toISOString()}] 🔴 STALENESS DETECTED — ` +
      `Binance: ${binanceAge >= 0 ? fmt(binanceAge) : "never"} | ` +
      `Chainlink: ${chainlinkAge >= 0 ? fmt(chainlinkAge) : "never"} — ` +
      `FORCE-RECONNECTING`
    );
    if (wsRef) {
      try { wsRef.terminate(); } catch {}
      wsRef = null;
    }
    connectRtds();
  }
}, 10_000);

setInterval(async () => {
  const now = Date.now();
  const binanceAge = lastBinanceTick > 0 ? fmt(now - lastBinanceTick) : "no ticks";
  const chainlinkAge = lastChainlinkTick > 0 ? fmt(now - lastChainlinkTick) : "no ticks";

  console.log(
    `[${new Date().toISOString()}] 📊 ` +
    `$${lastPrice.toFixed(2)} | Binance: ${binanceAge} (${binanceCount} total) | ` +
    `Chainlink: ${chainlinkAge} (${chainlinkCount} total) | ` +
    `WS: ${wsRef?.readyState === WebSocket.OPEN ? "OPEN" : "NOT OPEN"}`
  );

  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    const data = await res.json() as any;
    const prodTs = data.btcPrice?.timestamp ?? 0;
    const prodAge = fmt(Date.now() - prodTs);
    const prodPrice = data.btcPrice?.price;
    const prodFresh = data.orchestrator?.btcPriceFresh;
    console.log(
      `             📡 Prod: $${prodPrice} age=${prodAge} fresh=${prodFresh}`
    );
  } catch { /* ignore */ }
}, 30_000);

console.log("═".repeat(60));
console.log("  PenguinX BTC Staleness Monitor");
console.log("  Press Ctrl+C to stop");
console.log("═".repeat(60));
console.log();

connectRtds();
