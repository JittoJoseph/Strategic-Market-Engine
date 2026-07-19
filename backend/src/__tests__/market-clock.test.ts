import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

import { MarketClock } from "../services/market-clock.js";

const realFetch = globalThis.fetch;

/** Serve a fixed server time, optionally delaying to simulate round-trip. */
function mockTime(serverSeconds: () => number, delayMs = 0) {
  globalThis.fetch = vi.fn(async () => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { ok: true, text: async () => String(serverSeconds()) } as Response;
  }) as unknown as typeof fetch;
}

describe("MarketClock", () => {
  let clock: MarketClock;
  beforeEach(() => {
    clock = new MarketClock();
  });
  afterEach(() => {
    clock.stop();
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("reports unsynced and falls back to host time before the first sync", () => {
    expect(clock.getStatus().synced).toBe(false);
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50);
  });

  it("corrects a host clock that is behind the server", async () => {
    // Host is 5s behind: server reads 5s later than Date.now().
    mockTime(() => Math.floor((Date.now() + 5000) / 1000));
    await clock.sync();

    expect(clock.getStatus().synced).toBe(true);
    expect(clock.getStatus().offsetMs).toBeGreaterThan(4000);
    expect(clock.getStatus().offsetMs).toBeLessThan(6000);
    expect(Math.abs(clock.now() - (Date.now() + 5000))).toBeLessThan(1500);
  });

  it("corrects a host clock that is ahead of the server", async () => {
    mockTime(() => Math.floor((Date.now() - 8000) / 1000));
    await clock.sync();
    expect(clock.getStatus().offsetMs).toBeLessThan(-7000);
    expect(clock.getStatus().offsetMs).toBeGreaterThan(-9000);
  });

  it("stays on host time when the host is already accurate", async () => {
    mockTime(() => Math.floor(Date.now() / 1000));
    await clock.sync();
    expect(Math.abs(clock.getStatus().offsetMs)).toBeLessThan(1000);
  });

  it("compensates for round-trip latency rather than counting it as drift", async () => {
    // Accurate server, but 400ms each way. Naive math would look ~400ms off.
    mockTime(() => Math.floor(Date.now() / 1000), 400);
    await clock.sync();
    expect(Math.abs(clock.getStatus().offsetMs)).toBeLessThan(1000);
    expect(clock.getStatus().lastRttMs).toBeGreaterThanOrEqual(400);
  });

  it("keeps the last good offset when the server is unreachable", async () => {
    mockTime(() => Math.floor((Date.now() + 5000) / 1000));
    await clock.sync();
    const good = clock.getStatus().offsetMs;

    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    expect(await clock.sync()).toBe(false);
    expect(clock.getStatus().offsetMs).toBe(good);
  });

  it("ignores sub-second jitter so the clock does not wobble", async () => {
    // Deterministic: pin local time to a second boundary, hold the server's
    // (1s-resolution) reply fixed, then nudge local time 200ms. The measured
    // offset moves by 200ms — below the correction threshold, so it must hold.
    vi.useFakeTimers();
    try {
      const base = new Date("2026-01-01T00:00:00.000Z").getTime();
      vi.setSystemTime(base);
      mockTime(() => base / 1000 + 5);

      await clock.sync();
      expect(clock.getStatus().offsetMs).toBe(5000);

      vi.setSystemTime(base + 200);
      await clock.sync();
      expect(clock.getStatus().offsetMs).toBe(5000);

      // A move past the threshold is adopted.
      vi.setSystemTime(base + 1500);
      await clock.sync();
      expect(clock.getStatus().offsetMs).toBe(3500);
    } finally {
      vi.useRealTimers();
    }
  });
});
