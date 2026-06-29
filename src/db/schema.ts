import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const responseKindEnum = pgEnum("response_kind", [
  "gif",
  "empty",
  "json",
  "redirect",
  "html",
]);

export const keyKindEnum = pgEnum("key_kind", ["http"]);

export const monitorModeEnum = pgEnum("monitor_mode", [
  "off",
  "latch",
  "window",
]);

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  hash: text("hash").notNull().unique(),
  /** Admins see all data + revoke other keys. Non-admins are scoped to their own rows. */
  isAdmin: boolean("is_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

// Opaque session tokens. Cookie carries the plaintext (`mantis_sess_…`);
// the row stores the SHA-256 hash. Revoke = invalidate cookie without
// touching the underlying API key.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix").notNull(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (t) => [
    index("sessions_api_key_idx").on(t.apiKeyId),
    index("sessions_active_idx")
      .on(t.expiresAt)
      .where(sql`revoked_at IS NULL`),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export const keys = pgTable(
  "keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicId: text("public_id").notNull().unique(),
    kind: keyKindEnum("kind").notNull().default("http"),
    memo: text("memo").notNull(),
    responseKind: responseKindEnum("response_kind").notNull().default("gif"),
    responsePayload: jsonb("response_payload"),
    dedupeWindowSeconds: integer("dedupe_window_seconds").notNull().default(60),
    monitorMode: monitorModeEnum("monitor_mode").notNull().default("off"),
    monitorWindowSeconds: integer("monitor_window_seconds")
      .notNull()
      .default(300),
    monitorResetAt: timestamp("monitor_reset_at", { withTimezone: true }),
    // The first single-file document format this key was downloaded as (docx,
    // pdf, …). Set once, on the first such download (see the download route).
    // The dashboard uses it to nudge operators toward one filetype per key so
    // each hit traces back to a single planted file. null = not yet downloaded
    // as a document; the `folder` bundle and wallet/NFC vectors never set it.
    firstDownloadFormat: text("first_download_format"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdByApiKeyId: uuid("created_by_api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("keys_created_at_idx").on(t.createdAt.desc()),
    // Owner-scoped lists (non-admin /api/keys, dashboard keys page,
    // /api/hits/recent) filter on created_by_api_key_id and order by
    // created_at desc; the composite serves both in one index scan.
    index("keys_created_by_idx").on(t.createdByApiKeyId, t.createdAt.desc()),
  ],
);

export const notificationDestinations = pgTable(
  "notification_destinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyId: uuid("key_id")
      .notNull()
      .references(() => keys.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(), // values from notificationChannelEnum at runtime
    target: text("target").notNull(),
    /** HMAC secret for outbound bodies. Set for webhook; null elsewhere (those channels auth via URL). */
    signingSecret: text("signing_secret"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastActivationStatus: text("last_activation_status"), // "ok" | "failed" | null
    lastActivationError: text("last_activation_error"),
    lastActivationAt: timestamp("last_activation_at", { withTimezone: true }),
  },
  (t) => [index("notification_destinations_key_idx").on(t.keyId)],
);

export const hits = pgTable(
  "hits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyId: uuid("key_id")
      .notNull()
      .references(() => keys.id, { onDelete: "cascade" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    referer: text("referer"),
    headers: jsonb("headers"),
    uaBrowser: text("ua_browser"),
    uaBrowserVersion: text("ua_browser_version"),
    uaOs: text("ua_os"),
    uaDevice: text("ua_device"),
    botLabel: text("bot_label"),
    isDuplicate: boolean("is_duplicate").notNull().default(false),
  },
  (t) => [
    index("hits_key_occurred_idx").on(t.keyId, t.occurredAt.desc()),
    index("hits_occurred_idx").on(t.occurredAt.desc()),
  ],
);

export const notificationStatusEnum = pgEnum("notification_status", [
  "pending",
  "in_flight",
  "succeeded",
  "failed",
  "aborted",
]);

export const notificationChannelEnum = pgEnum("notification_channel", [
  "webhook",
  "email",
  "slack",
  "discord",
  "teams",
  "home_assistant",
]);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hitId: uuid("hit_id")
      .notNull()
      .references(() => hits.id, { onDelete: "cascade" }),
    keyId: uuid("key_id")
      .notNull()
      .references(() => keys.id, { onDelete: "cascade" }),
    destinationId: uuid("destination_id").references(
      () => notificationDestinations.id,
      { onDelete: "set null" },
    ),
    channel: notificationChannelEnum("channel").notNull(),
    target: text("target").notNull(),
    /** Denormalized destination secret at enqueue. In-flight rows keep the old secret if the destination rotates. */
    signingSecret: text("signing_secret"),
    status: notificationStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }),
  },
  (t) => [
    index("notifications_pending_idx")
      .on(t.nextAttemptAt)
      .where(sql`status = 'pending'`),
    index("notifications_hit_idx").on(t.hitId),
    // Supports the hourly retention purge (DELETE ... WHERE status IN (...)
    // AND updated_at < cutoff); without it the sweep seq-scans the table.
    index("notifications_settled_updated_idx")
      .on(t.updatedAt)
      .where(sql`status IN ('succeeded', 'failed', 'aborted')`),
  ],
);

export type Notification = typeof notifications.$inferSelect;
export type NotificationStatus = (typeof notificationStatusEnum.enumValues)[number];
export type NotificationChannel = (typeof notificationChannelEnum.enumValues)[number];

export type NotificationDestination = typeof notificationDestinations.$inferSelect;
export type NewNotificationDestination = typeof notificationDestinations.$inferInsert;

export const notificationChannels = notificationChannelEnum.enumValues;

// Apple Wallet pass signing config. Single-row table (id always 'default') —
// alternative to setting APPLE_PASS_* env vars. Env vars take precedence when
// both are configured. Cert/icon/logo blobs are base64-encoded text columns
// so we don't need a custom bytea type.
export const walletConfig = pgTable("wallet_config", {
  id: text("id").primaryKey().default("default"),
  certP12B64: text("cert_p12_b64").notNull(),
  certPass: text("cert_pass").notNull(),
  teamId: text("team_id").notNull(),
  passTypeId: text("pass_type_id").notNull(),
  authSecret: text("auth_secret").notNull(),
  organizationName: text("organization_name").notNull().default("Mantis"),
  wwdrPemB64: text("wwdr_pem_b64"),
  iconPngB64: text("icon_png_b64"),
  logoPngB64: text("logo_png_b64"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type WalletConfig = typeof walletConfig.$inferSelect;
export type NewWalletConfig = typeof walletConfig.$inferInsert;

// Append-only audit log of state changes. Append-only enforced by trigger
// (migration 0009) — see lib/retention.ts for the purge path that bypasses
// the trigger via a transaction-local GUC.
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** See lib/audit.ts AuditEventType for the exhaustive list. */
    eventType: text("event_type").notNull(),
    /** Null for system events (e.g. bootstrap mint). */
    actorApiKeyId: uuid("actor_api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    /** Snapshot of actor's name at event time — survives the api_key row being deleted. */
    actorLabel: text("actor_label"),
    /** e.g. "key", "api_key", "destination", "wallet_config". */
    subjectKind: text("subject_kind"),
    subjectId: text("subject_id"),
    metadata: jsonb("metadata"),
    ip: text("ip"),
  },
  (t) => [
    index("audit_events_occurred_idx").on(t.occurredAt.desc()),
    index("audit_events_actor_idx").on(t.actorApiKeyId),
    index("audit_events_subject_idx").on(t.subjectKind, t.subjectId),
  ],
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;

// Wallet device registrations (deviceId + APNs push token), inserted on
// the iOS Wallet POST. Used to push pass-update notifications when a key's
// memo or other pass-affecting field changes.
export const walletRegistrations = pgTable(
  "wallet_registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: text("device_id").notNull(),
    pushToken: text("push_token").notNull(),
    keyId: uuid("key_id")
      .notNull()
      .references(() => keys.id, { onDelete: "cascade" }),
    passTypeId: text("pass_type_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("wallet_registrations_device_key_uq").on(t.deviceId, t.keyId),
    index("wallet_registrations_key_idx").on(t.keyId),
  ],
);

export type WalletRegistration = typeof walletRegistrations.$inferSelect;
export type NewWalletRegistration = typeof walletRegistrations.$inferInsert;

// Cluster-wide fixed-window rate limiter state — one row per limiter key
// (e.g. "auth-fail:<ip>"). The window resets lazily on the next consume.
// Shared across instances, unlike the in-memory fallback in lib/rate-limit.ts.
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true })
    .notNull()
    .defaultNow(),
  count: integer("count").notNull().default(0),
});

export type ApiKey = typeof apiKeys.$inferSelect;
export type Key = typeof keys.$inferSelect;
export type NewKey = typeof keys.$inferInsert;
export type Hit = typeof hits.$inferSelect;
export type NewHit = typeof hits.$inferInsert;

export const responseKinds = responseKindEnum.enumValues;
export type ResponseKind = (typeof responseKinds)[number];

export const monitorModes = monitorModeEnum.enumValues;
export type MonitorMode = (typeof monitorModes)[number];

export const _sqlNow = sql`now()`;
