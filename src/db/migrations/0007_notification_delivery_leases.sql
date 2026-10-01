ALTER TABLE "notifications" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "notifications_lease_idx" ON "notifications" USING btree ("lease_until") WHERE status = 'in_flight';