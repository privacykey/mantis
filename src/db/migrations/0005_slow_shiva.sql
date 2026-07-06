CREATE TYPE "public"."api_key_scope" AS ENUM('full', 'enroll');--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scope" "api_key_scope" DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "keys" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "keys" ADD CONSTRAINT "keys_external_id_unique" UNIQUE("external_id");