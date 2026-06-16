CREATE INDEX "st_status_entry_ts_idx" ON "simulated_trades" USING btree ("status","entry_ts");--> statement-breakpoint
ALTER TABLE "simulated_trades" DROP COLUMN "orderbook_snapshot";--> statement-breakpoint
ALTER TABLE "simulated_trades" DROP COLUMN "raw";