import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { notifications, type NotificationChannel } from "@/db/schema";
import { log } from "@/lib/log";
import { runRetentionSweep } from "@/lib/retention";
import { loadSendContext, send } from "./senders";

const IDLE_POLL_MS = 5_000;
const ACTIVE_POLL_MS = 200;
const BATCH_SIZE = 10;
const RETENTION_INTERVAL_MS = 60 * 60_000; // hourly

// Backoff schedule: minutes from the first attempt failure.
// attempt 1 fails → wait BACKOFF[0] before attempt 2, etc.
const BACKOFF_MINUTES = [1, 5, 30, 120, 720]; // 1m, 5m, 30m, 2h, 12h

export type WorkerHandle = {
  stop(): void;
};

let workerStarted = false;

export function startNotifyWorker(): WorkerHandle {
  if (workerStarted) return { stop: () => {} };
  workerStarted = true;

  let stopped = false;
  let lastRetentionAt = 0;
  log.info("notify worker starting");

  void (async () => {
    while (!stopped) {
      try {
        const processed = await processBatch(BATCH_SIZE);

        // Hourly retention sweep, piggy-backed on the worker loop so we don't
        // need a separate cron. Idempotent — safe if multiple workers run.
        if (Date.now() - lastRetentionAt >= RETENTION_INTERVAL_MS) {
          lastRetentionAt = Date.now();
          try {
            await runRetentionSweep();
          } catch (err) {
            log.error({ err }, "retention sweep failed");
          }
        }

        await sleep(processed === 0 ? IDLE_POLL_MS : ACTIVE_POLL_MS);
      } catch (err) {
        log.error({ err }, "notify worker iteration failed");
        await sleep(IDLE_POLL_MS);
      }
    }
    log.info("notify worker stopped");
  })();

  return {
    stop() {
      stopped = true;
    },
  };
}

export async function processBatch(limit: number): Promise<number> {
  // Atomic claim with SKIP LOCKED so multiple workers don't race. The
  // denormalized signing_secret (set at enqueue) rides through to the
  // sender for HMAC-signing the outbound POST.
  const claimed = await db.execute<{
    id: string;
    hit_id: string;
    channel: NotificationChannel;
    target: string;
    signing_secret: string | null;
    attempts: number;
    max_attempts: number;
  }>(sql`
    update notifications
    set status = 'in_flight', updated_at = now()
    where id in (
      select id from notifications
      where status = 'pending' and next_attempt_at <= now()
      order by next_attempt_at
      limit ${limit}
      for update skip locked
    )
    returning id, hit_id, channel, target, signing_secret, attempts, max_attempts
  `);

  if (claimed.length === 0) return 0;

  await Promise.all(claimed.map(processOne));
  return claimed.length;
}

type Claimed = {
  id: string;
  hit_id: string;
  channel: NotificationChannel;
  target: string;
  signing_secret: string | null;
  attempts: number;
  max_attempts: number;
};

async function processOne(c: Claimed): Promise<void> {
  const nextAttempt = c.attempts + 1;
  try {
    const ctx = await loadSendContext(c.hit_id);
    if (!ctx) {
      await markAborted(c.id, "hit no longer exists");
      return;
    }
    if (ctx.key.disabledAt !== null) {
      await markAborted(c.id, "key disabled before delivery");
      return;
    }

    await send(c.channel, {
      ...ctx,
      target: c.target,
      signingSecret: c.signing_secret,
    });

    await markSucceeded(c.id, nextAttempt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (nextAttempt >= c.max_attempts) {
      await markFailed(c.id, nextAttempt, message);
      log.warn(
        { id: c.id, channel: c.channel, target: c.target, attempts: nextAttempt },
        `notification permanently failed: ${message}`,
      );
    } else {
      const backoffMs = backoffMillis(nextAttempt);
      await scheduleRetry(c.id, nextAttempt, backoffMs, message);
      log.info(
        { id: c.id, channel: c.channel, attempts: nextAttempt, retryInMs: backoffMs },
        `notification will retry: ${message}`,
      );
    }
  }
}

function backoffMillis(attemptNumber: number): number {
  // attemptNumber = number of attempts completed (the just-failed one).
  // index 0 of BACKOFF = wait after attempt 1 failed.
  const idx = Math.min(attemptNumber - 1, BACKOFF_MINUTES.length - 1);
  const baseMs = (BACKOFF_MINUTES[idx] ?? BACKOFF_MINUTES.at(-1) ?? 60) * 60_000;
  // ±20% jitter
  const jitter = baseMs * (Math.random() * 0.4 - 0.2);
  return Math.max(1_000, Math.floor(baseMs + jitter));
}

async function markSucceeded(id: string, attempts: number): Promise<void> {
  await db.execute(sql`
    update notifications
    set status = 'succeeded',
        attempts = ${attempts},
        succeeded_at = now(),
        updated_at = now(),
        last_error = null
    where id = ${id}
  `);
}

async function markFailed(
  id: string,
  attempts: number,
  err: string,
): Promise<void> {
  await db.execute(sql`
    update notifications
    set status = 'failed',
        attempts = ${attempts},
        last_error = ${err.slice(0, 500)},
        updated_at = now()
    where id = ${id}
  `);
}

async function markAborted(id: string, reason: string): Promise<void> {
  await db.execute(sql`
    update notifications
    set status = 'aborted',
        last_error = ${reason.slice(0, 500)},
        updated_at = now()
    where id = ${id}
  `);
}

async function scheduleRetry(
  id: string,
  attempts: number,
  inMs: number,
  err: string,
): Promise<void> {
  await db.execute(sql`
    update notifications
    set status = 'pending',
        attempts = ${attempts},
        next_attempt_at = now() + (${inMs}::int * interval '1 millisecond'),
        last_error = ${err.slice(0, 500)},
        updated_at = now()
    where id = ${id}
  `);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
