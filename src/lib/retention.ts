import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { log } from "@/lib/log";

/**
 * Background retention sweep, idempotent. Each category opts in via env:
 *   MANTIS_HIT_RETENTION_DAYS          — hits (cascades to notifications)
 *   MANTIS_NOTIFICATION_RETENTION_DAYS — settled notifications only
 *   MANTIS_AUDIT_RETENTION_DAYS        — append-only audit_events
 *   MANTIS_SESSION_RETENTION_DAYS      — terminated sessions only
 * Unset = retain forever. Runs inside the notify worker.
 *
 * The rate_limits sweep below is the exception: it always runs and is not
 * env-gated. That table is internal operational state (one row per limiter
 * key) with no value once its fixed-window has elapsed, so leaving rows
 * forever is pure unbounded growth — a slow disk-exhaustion vector, since
 * keys include attacker-rotatable IPs (login:<ip>, auth-fail:<ip>, …).
 */

// TTL for spent rate_limits rows. All limiter windows are ~1 minute, so a day
// is comfortably past any live window — a row this old cannot be in use.
const RATE_LIMIT_RETENTION_DAYS = 1;

function readPositiveInt(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    log.warn({ var: name, value: raw }, "retention env var ignored (not a positive integer)");
    return null;
  }
  return n;
}

function retentionConfig(): {
  hitDays: number | null;
  notificationDays: number | null;
  auditDays: number | null;
  sessionDays: number | null;
} {
  return {
    hitDays: readPositiveInt("MANTIS_HIT_RETENTION_DAYS"),
    notificationDays: readPositiveInt("MANTIS_NOTIFICATION_RETENTION_DAYS"),
    auditDays: readPositiveInt("MANTIS_AUDIT_RETENTION_DAYS"),
    sessionDays: readPositiveInt("MANTIS_SESSION_RETENTION_DAYS"),
  };
}

export async function runRetentionSweep(): Promise<{
  hitsDeleted: number;
  notificationsDeleted: number;
  auditEventsDeleted: number;
  sessionsDeleted: number;
  rateLimitsDeleted: number;
}> {
  const cfg = retentionConfig();
  let hitsDeleted = 0;
  let notificationsDeleted = 0;
  let auditEventsDeleted = 0;
  let sessionsDeleted = 0;
  let rateLimitsDeleted = 0;

  if (cfg.hitDays !== null) {
    const res = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM hits
        WHERE occurred_at < now() - (${cfg.hitDays}::int * interval '1 day')
        RETURNING 1
      )
      SELECT count(*) AS count FROM deleted
    `);
    hitsDeleted = Number(res[0]?.count ?? 0);
  }

  if (cfg.notificationDays !== null) {
    const res = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM notifications
        WHERE status IN ('succeeded', 'failed', 'aborted')
          AND updated_at < now() - (${cfg.notificationDays}::int * interval '1 day')
        RETURNING 1
      )
      SELECT count(*) AS count FROM deleted
    `);
    notificationsDeleted = Number(res[0]?.count ?? 0);
  }

  // audit_events has an append-only trigger (migration 0009) that only
  // allows DELETE when the `mantis.allow_audit_purge` GUC is '1'. The
  // SET + DELETE must share one transaction so the `local` setting
  // survives to the DELETE.
  if (cfg.auditDays !== null) {
    auditEventsDeleted = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('mantis.allow_audit_purge', '1', true)`,
      );
      const res = await tx.execute<{ count: string }>(sql`
        WITH deleted AS (
          DELETE FROM audit_events
          WHERE occurred_at < now() - (${cfg.auditDays}::int * interval '1 day')
          RETURNING 1
        )
        SELECT count(*) AS count FROM deleted
      `);
      return Number(res[0]?.count ?? 0);
    });
  }

  // Only purges terminated rows (revoked OR past expires_at). Active
  // sessions stay; the cookie's expires_at is the actual lifetime gate.
  if (cfg.sessionDays !== null) {
    const res = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM sessions
        WHERE (revoked_at IS NOT NULL OR expires_at < now())
          AND COALESCE(revoked_at, expires_at) < now() - (${cfg.sessionDays}::int * interval '1 day')
        RETURNING 1
      )
      SELECT count(*) AS count FROM deleted
    `);
    sessionsDeleted = Number(res[0]?.count ?? 0);
  }

  // Always-on, unlike the env-gated categories above: drop rate_limits rows
  // whose window elapsed long ago. A plain DELETE is idempotent and safe to
  // run concurrently — overlapping sweeps just delete intersecting row sets.
  {
    const res = await db.execute<{ count: string }>(sql`
      WITH deleted AS (
        DELETE FROM rate_limits
        WHERE window_start < now() - (${RATE_LIMIT_RETENTION_DAYS}::int * interval '1 day')
        RETURNING 1
      )
      SELECT count(*) AS count FROM deleted
    `);
    rateLimitsDeleted = Number(res[0]?.count ?? 0);
  }

  if (
    hitsDeleted > 0 ||
    notificationsDeleted > 0 ||
    auditEventsDeleted > 0 ||
    sessionsDeleted > 0 ||
    rateLimitsDeleted > 0
  ) {
    log.info(
      {
        hitsDeleted,
        notificationsDeleted,
        auditEventsDeleted,
        sessionsDeleted,
        rateLimitsDeleted,
        cfg,
      },
      "retention sweep deleted rows",
    );
  }
  return {
    hitsDeleted,
    notificationsDeleted,
    auditEventsDeleted,
    sessionsDeleted,
    rateLimitsDeleted,
  };
}
