import Decimal from "decimal.js";
import { createModuleLogger } from "../utils/logger.js";
import { getConfig } from "../utils/config.js";
import { getPortfolio, initPortfolio, updateCashBalance } from "../db/client.js";

const logger = createModuleLogger("portfolio-manager");

/** Cash is never a gate: the research run lets the balance go negative. */
export class PortfolioManager {
  private cashBalance = new Decimal(0);
  private initialCapital = new Decimal(0);

  async init(): Promise<void> {
    this.load(await initPortfolio(getConfig().portfolio.startingCapital));
    logger.info({ initialCapital: this.initialCapital.toString(), cashBalance: this.cashBalance.toString() }, "Portfolio initialised");
  }

  async reload(): Promise<void> {
    const portfolio = await getPortfolio();
    if (!portfolio) throw new Error("Portfolio row missing");
    this.load(portfolio);
  }

  getCashBalance(): number {
    return this.cashBalance.toNumber();
  }

  getInitialCapital(): number {
    return this.initialCapital.toNumber();
  }

  deductCash(amount: number): Promise<void> {
    return this.adjust(-amount);
  }

  addCash(amount: number): Promise<void> {
    return this.adjust(amount);
  }

  private load(row: { cashBalance: string; initialCapital: string }): void {
    this.cashBalance = new Decimal(row.cashBalance);
    this.initialCapital = new Decimal(row.initialCapital);
  }

  private async adjust(delta: number): Promise<void> {
    this.cashBalance = this.cashBalance.plus(delta);
    await updateCashBalance(this.cashBalance.toString());
  }
}
