ALTER TABLE "api_keys" ADD COLUMN "owner_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "keys" ADD COLUMN "self_origins" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_owner_api_key_id_api_keys_id_fk" FOREIGN KEY ("owner_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;