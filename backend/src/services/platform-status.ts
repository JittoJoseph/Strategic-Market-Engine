import axios from "axios";
import { createModuleLogger } from "../utils/logger.js";
import { logAudit } from "../db/client.js";
import { POLY_URLS, STRATEGY } from "../types/index.js";

const logger = createModuleLogger("platform-status");

/**
 * Polymarket's status page is the entry gate. During incidents and maintenance
 * BTC Up/Down flow dries up and anything the book shows is an artefact, so new
 * positions need the page to read UP. A page we cannot read counts as not UP.
 */
export class PlatformStatusWatcher {
  private status = "UNKNOWN";
  private checkedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  async start(): Promise<void> {
    if (this.timer) return;
    await this.poll();
    this.timer = setInterval(() => void this.poll(), STRATEGY.statusPollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isUp(): boolean {
    return this.status === "UP" && Date.now() - this.checkedAt <= STRATEGY.statusMaxAgeMs;
  }

  getStatus() {
    return { status: this.status, up: this.isUp(), checkedAt: this.checkedAt || null };
  }

  private async poll(): Promise<void> {
    try {
      const { data } = await axios.get(POLY_URLS.STATUS_SUMMARY, { timeout: 10_000 });
      const next = String(data?.page?.status ?? "UNKNOWN");
      this.checkedAt = Date.now();
      if (next === this.status) return;
      const previous = this.status;
      this.status = next;
      logger[next === "UP" ? "info" : "warn"]({ previous, status: next }, "Polymarket status changed");
      logAudit(next === "UP" ? "info" : "warn", "SYSTEM", `Polymarket status ${previous} → ${next}`).catch(() => {});
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : error }, "Status page unreachable");
    }
  }
}

let instance: PlatformStatusWatcher | null = null;
export function getPlatformStatusWatcher(): PlatformStatusWatcher {
  if (!instance) instance = new PlatformStatusWatcher();
  return instance;
}
