import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../utils/logger.js", () => {
  const noop = () => {};
  const childLogger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => childLogger,
  };
  return {
    createModuleLogger: () => childLogger,
    getLogger: () => childLogger,
  };
});
vi.mock("../db/client.js", () => ({ logAudit: async () => {} }));

import { MarketWebSocketWatcher } from "../services/market-ws-watcher.js";

const TOKEN = "token-1";

/** Drive the private message handler exactly as the socket would. */
function feed(w: MarketWebSocketWatcher, msg: unknown) {
  (w as unknown as { handleMessage: (m: unknown) => void }).handleMessage(msg);
}

function snapshot(bids: [string, string][], asks: [string, string][]) {
  return {
    event_type: "book",
    asset_id: TOKEN,
    timestamp: "1757908892351",
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
  };
}

describe("MarketWebSocketWatcher — maintained order book", () => {
  let w: MarketWebSocketWatcher;
  beforeEach(() => {
    w = new MarketWebSocketWatcher();
  });

  it("has no book before a snapshot arrives", () => {
    expect(w.getBook(TOKEN)).toBeNull();
    expect(w.getBestBid(TOKEN)).toBeNull();
  });

  it("derives best bid/ask from a snapshot regardless of level order", () => {
    feed(
      w,
      snapshot(
        [
          ["0.48", "30"],
          ["0.50", "15"],
          ["0.49", "20"],
        ],
        [
          ["0.53", "60"],
          ["0.52", "25"],
        ],
      ),
    );
    expect(w.getBestBid(TOKEN)).toBe(0.5);
    expect(w.getBestAsk(TOKEN)).toBe(0.52);
    const book = w.getBook(TOKEN)!;
    expect(book.bids[0]!.price).toBe("0.5"); // best-first
    expect(book.asks[0]!.price).toBe("0.52");
  });

  it("applies price_change as the new ABSOLUTE size at a level", () => {
    feed(w, snapshot([["0.50", "15"]], [["0.52", "25"]]));
    feed(w, {
      event_type: "price_change",
      price_changes: [
        { asset_id: TOKEN, price: "0.50", size: "200", side: "BUY" },
      ],
      timestamp: "1757908892352",
    });
    expect(w.getBook(TOKEN)!.bids[0]).toEqual({ price: "0.5", size: "200" });
  });

  it("removes a level when price_change reports size 0", () => {
    feed(
      w,
      snapshot(
        [
          ["0.50", "15"],
          ["0.49", "20"],
        ],
        [["0.52", "25"]],
      ),
    );
    feed(w, {
      event_type: "price_change",
      price_changes: [
        { asset_id: TOKEN, price: "0.50", size: "0", side: "BUY" },
      ],
      timestamp: "1757908892352",
    });
    expect(w.getBestBid(TOKEN)).toBe(0.49);
  });

  it("routes SELL-side changes to the ask book", () => {
    feed(w, snapshot([["0.50", "15"]], [["0.52", "25"]]));
    feed(w, {
      event_type: "price_change",
      price_changes: [
        { asset_id: TOKEN, price: "0.51", size: "10", side: "SELL" },
      ],
      timestamp: "1757908892352",
    });
    expect(w.getBestAsk(TOKEN)).toBe(0.51);
    expect(w.getBestBid(TOKEN)).toBe(0.5);
  });

  it("emits bookUpdate with book-derived best bid/ask", () => {
    const seen: unknown[] = [];
    w.on("bookUpdate", (e) => seen.push(e));
    feed(w, snapshot([["0.50", "15"]], [["0.52", "25"]]));
    expect(seen).toEqual([
      { tokenId: TOKEN, bestBid: 0.5, bestAsk: 0.52, timestamp: 1757908892351 },
    ]);
  });

  it("ignores deltas for a token with no snapshot yet (resyncs on next book)", () => {
    feed(w, {
      event_type: "price_change",
      price_changes: [
        { asset_id: TOKEN, price: "0.50", size: "5", side: "BUY" },
      ],
      timestamp: "1",
    });
    expect(w.getBook(TOKEN)).toBeNull();
  });

  it("a later snapshot fully replaces prior state", () => {
    feed(w, snapshot([["0.50", "15"]], [["0.52", "25"]]));
    feed(w, snapshot([["0.10", "5"]], [["0.90", "5"]]));
    expect(w.getBestBid(TOKEN)).toBe(0.1);
    expect(w.getBestAsk(TOKEN)).toBe(0.9);
    expect(w.getBook(TOKEN)!.bids).toHaveLength(1);
  });

  it("drops the book on unsubscribe so stale depth is never executable", () => {
    feed(w, snapshot([["0.50", "15"]], [["0.52", "25"]]));
    w.unsubscribe([TOKEN]);
    expect(w.getBook(TOKEN)).toBeNull();
  });
});
