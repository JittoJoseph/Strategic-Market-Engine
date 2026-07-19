let offsetMs = 0;
let synced = false;

/** Sub-second differences are below the server clock's own resolution. */
const MIN_CORRECTION_MS = 250;

export function syncFromRoundTrip(
  sentAt: number,
  serverMs: number,
  receivedAt: number,
): void {
  const measured = serverMs - (sentAt + receivedAt) / 2;
  if (!synced || Math.abs(measured - offsetMs) >= MIN_CORRECTION_MS) {
    offsetMs = measured;
  }
  synced = true;
}

export function seedFromServerTimestamp(serverMs: number): void {
  if (synced) return;
  offsetMs = serverMs - Date.now();
  synced = true;
}

/** Current market time in epoch ms. */
export function marketNow(): number {
  return Date.now() + offsetMs;
}

export function getMarketTimeOffsetMs(): number {
  return offsetMs;
}
