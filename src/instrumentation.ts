export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { log } = await import("@/lib/log");

  // Fail fast at boot: importing the env module evaluates the required()
  // checks (DATABASE_URL, MANTIS_API_KEY_PEPPER). Without this the process
  // boots "healthy" and only throws on the first request that touches a key
  // path — which the `/` healthcheck never trips. Crash here instead.
  const { env } = await import("@/lib/env");
  void env.databaseUrl;
  void env.apiKeyPepper;

  if (process.env.AUTO_MIGRATE === "1") {
    try {
      const { migrate } = await import("drizzle-orm/postgres-js/migrator");
      const { db } = await import("@/db/client");
      await migrate(db, { migrationsFolder: "./src/db/migrations" });
      log.info("migrations applied");
    } catch (err) {
      log.error({ err }, "auto-migration failed");
      throw err;
    }
  }

  try {
    const { bootstrapIfEmpty } = await import("@/db/bootstrap");
    await bootstrapIfEmpty();
  } catch (err) {
    log.error({ err }, "bootstrap failed (continuing without seed)");
  }

  if (
    process.env.ENABLE_DEV_INBOX === "1" &&
    process.env.NODE_ENV === "production"
  ) {
    log.warn(
      "ENABLE_DEV_INBOX=1 with NODE_ENV=production — the unauthenticated " +
        "/inbox capture is exposed. Anyone who can reach this server can read " +
        "every webhook body it captures. Set ENABLE_DEV_INBOX=0 unless you " +
        "are intentionally running a deliberate test deployment.",
    );
  }

  // Warn (don't change behavior) when retention is fully unset: hits and
  // notifications are then kept forever, which grows the DB unbounded and
  // slows the dashboard/list queries over time. Operators opt in by setting
  // the *_RETENTION_DAYS vars (see .env.example / lib/retention.ts).
  if (
    !process.env.MANTIS_HIT_RETENTION_DAYS &&
    !process.env.MANTIS_NOTIFICATION_RETENTION_DAYS
  ) {
    log.warn(
      "no retention configured — MANTIS_HIT_RETENTION_DAYS and " +
        "MANTIS_NOTIFICATION_RETENTION_DAYS are unset, so hits and " +
        "notifications are retained forever. Set them (e.g. 90 and 30) to " +
        "enable automatic pruning and keep query performance steady.",
    );
  }

  // Default the worker ON unless explicitly disabled.
  // Skip on Vercel, where each function instance is short-lived — use /api/cron/notifications instead.
  const explicit = process.env.RUN_NOTIFY_WORKER;
  const wantWorker =
    explicit === "1" || (explicit !== "0" && !process.env.VERCEL);

  if (wantWorker) {
    try {
      const { startNotifyWorker } = await import("@/lib/notify");
      startNotifyWorker();
    } catch (err) {
      log.error({ err }, "failed to start notify worker");
    }
  } else {
    log.info(
      "notify worker not started (Vercel or RUN_NOTIFY_WORKER=0). Configure cron to /api/cron/notifications.",
    );
  }
}
