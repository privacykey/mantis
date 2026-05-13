CREATE TYPE "public"."key_kind" AS ENUM('http');--> statement-breakpoint
CREATE TYPE "public"."monitor_mode" AS ENUM('off', 'latch', 'window');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('webhook', 'email', 'slack', 'discord', 'teams');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'in_flight', 'succeeded', 'failed', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."response_kind" AS ENUM('gif', 'empty', 'json', 'redirect', 'html');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" text NOT NULL,
	"actor_api_key_id" uuid,
	"actor_label" text,
	"subject_kind" text,
	"subject_id" text,
	"metadata" jsonb,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "hits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"referer" text,
	"headers" jsonb,
	"ua_browser" text,
	"ua_browser_version" text,
	"ua_os" text,
	"ua_device" text,
	"bot_label" text,
	"is_duplicate" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_id" text NOT NULL,
	"kind" "key_kind" DEFAULT 'http' NOT NULL,
	"memo" text NOT NULL,
	"response_kind" "response_kind" DEFAULT 'gif' NOT NULL,
	"response_payload" jsonb,
	"dedupe_window_seconds" integer DEFAULT 60 NOT NULL,
	"monitor_mode" "monitor_mode" DEFAULT 'off' NOT NULL,
	"monitor_window_seconds" integer DEFAULT 300 NOT NULL,
	"monitor_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by_api_key_id" uuid,
	CONSTRAINT "keys_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "notification_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"target" text NOT NULL,
	"signing_secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activation_status" text,
	"last_activation_error" text,
	"last_activation_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hit_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"destination_id" uuid,
	"channel" "notification_channel" NOT NULL,
	"target" text NOT NULL,
	"signing_secret" text,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"succeeded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"api_key_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip" text,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "wallet_config" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"cert_p12_b64" text NOT NULL,
	"cert_pass" text NOT NULL,
	"team_id" text NOT NULL,
	"pass_type_id" text NOT NULL,
	"auth_secret" text NOT NULL,
	"organization_name" text DEFAULT 'Mantis' NOT NULL,
	"wwdr_pem_b64" text,
	"icon_png_b64" text,
	"logo_png_b64" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"push_token" text NOT NULL,
	"key_id" uuid NOT NULL,
	"pass_type_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_api_key_id_api_keys_id_fk" FOREIGN KEY ("actor_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hits" ADD CONSTRAINT "hits_key_id_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keys" ADD CONSTRAINT "keys_created_by_api_key_id_api_keys_id_fk" FOREIGN KEY ("created_by_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_destinations" ADD CONSTRAINT "notification_destinations_key_id_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_hit_id_hits_id_fk" FOREIGN KEY ("hit_id") REFERENCES "public"."hits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_key_id_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_destination_id_notification_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."notification_destinations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_registrations" ADD CONSTRAINT "wallet_registrations_key_id_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_occurred_idx" ON "audit_events" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_api_key_id");--> statement-breakpoint
CREATE INDEX "audit_events_subject_idx" ON "audit_events" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "hits_key_occurred_idx" ON "hits" USING btree ("key_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "hits_occurred_idx" ON "hits" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "keys_created_at_idx" ON "keys" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_destinations_key_idx" ON "notification_destinations" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "notifications_pending_idx" ON "notifications" USING btree ("next_attempt_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "notifications_hit_idx" ON "notifications" USING btree ("hit_id");--> statement-breakpoint
CREATE INDEX "sessions_api_key_idx" ON "sessions" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "sessions_active_idx" ON "sessions" USING btree ("expires_at") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_registrations_device_key_uq" ON "wallet_registrations" USING btree ("device_id","key_id");--> statement-breakpoint
CREATE INDEX "wallet_registrations_key_idx" ON "wallet_registrations" USING btree ("key_id");--> statement-breakpoint

-- Append-only enforcement on audit_events. UPDATE/DELETE raise unless the
-- transaction-local GUC `mantis.allow_audit_purge` is '1' — set only by
-- the retention sweep (src/lib/retention.ts). Not derivable from schema.ts,
-- so this lives in the migration directly.
CREATE OR REPLACE FUNCTION audit_events_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF current_setting('mantis.allow_audit_purge', true) = '1' THEN
        RETURN COALESCE(OLD, NEW);
    END IF;
    RAISE EXCEPTION 'audit_events is append-only; UPDATE/DELETE refused';
END;
$$;--> statement-breakpoint

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();--> statement-breakpoint

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();