ALTER TABLE "simulated_trades" ADD COLUMN "exit_reason" text;--> statement-breakpoint
ALTER TABLE "simulated_trades" ADD COLUMN "take_profit_trigger_price" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "simulated_trades" ADD COLUMN "take_profit_triggered_at" timestamp;--> statement-breakpoint
ALTER TABLE "simulated_trades" ADD COLUMN "take_profit_exit_price" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "simulated_trades" ADD COLUMN "take_profit_fees" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "simulated_trades" ADD COLUMN "take_profit_pnl" numeric(18, 8);