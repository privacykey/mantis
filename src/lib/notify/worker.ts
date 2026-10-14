import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { type NotificationChannel } from "@/db/schema";
import { log } from "@/lib/log";
import { runRetentionSweep } from "@/lib/retention";
import { openSecretOrNull } from "@/lib/secret-box";
import { causeDetail } from "@/lib/ssrf";
import { loadSendContext, send } from "./senders";

const IDLE_POLL_MS = 5_000;
const ACTIVE_POLL_MS = 200;
const BATCH_SIZE = 10;
const RETENTION_INTERVAL_MS = 60 * 60_000; // hourly
const LEASE_SECONDS = 60;

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
  // A crash still consumes an attempt. Older workers left no lease; their
  // updated_at provides a grace period when migrating an existing queue.
  await db.execute(sql`
    update notifications set status = 'failed', claim_token = null, lease_until = null,
      last_error = 'delivery lease expired after final attempt', updated_at = now()
    where status = 'in_flight' and attempts >= max_attempts
      and coalesce(lease_until, updated_at + (${LEASE_SECONDS}::int * interval '1 second')) <= now()
  `);
  // Atomic claim with SKIP LOCKED so multiple workers don't race. The
  // denormalized signing_secret (set at enqueue) rides through to the
  // sender for HMAC-signing the outbound POST.
  const claimed = await db.execute<{
    id: string;
    hit_id: string;
    destination_id: string | null;
    channel: NotificationChannel;
    target: string;
    signing_secret: string | null;
    attempts: number;
    max_attempts: number;
    claim_token: string;
  }>(sql`
    update notifications
    set status = 'in_flight', updated_at = now(), claim_token = gen_random_uuid(),
      lease_until = now() + (${LEASE_SECONDS}::int * interval '1 second'), attempts = attempts + 1
    where id in (
      select id from notifications
      where attempts < max_attempts and (
        (status = 'pending' and next_attempt_at <= now()) or
        (status = 'in_flight' and coalesce(lease_until, updated_at + (${LEASE_SECONDS}::int * interval '1 second')) <= now())
      )
      order by next_attempt_at
      limit ${limit}
      for update skip locked
    )
    returning id, hit_id, destination_id, channel, target, signing_secret, attempts, max_attempts, claim_token
  `);

  if (claimed.length === 0) return 0;

  await Promise.all(claimed.map(processOne));
  return claimed.length;
}

type Claimed = {
  id: string;
  hit_id: string;
  destination_id: string | null;
  channel: NotificationChannel;
  target: string;
  signing_secret: string | null;
  attempts: number;
  max_attempts: number;
  claim_token: string;
};

async function processOne(c: Claimed): Promise<void> {
  const nextAttempt = c.attempts;
  try {
    const ctx = await loadSendContext(c.hit_id);
    if (!ctx) {
      await markAborted(c, "hit no longer exists");
      return;
    }
    if (ctx.key.disabledAt !== null) {
      await markAborted(c, "key disabled before delivery");
      return;
    }
    // Every enqueued row names its destination, and deleting that destination
    // nulls the reference. Removal aborts the rows it can see; this catches a
    // row whose hit was still committing at that moment.
    if (c.destination_id === null) {
      await markAborted(c, "destination removed before delivery");
      return;
    }

    // Recheck ownership immediately before any external effect. A paused old
    // worker must not send after a newer worker has acquired its delivery.
    if (!await renewClaim(c)) return;
    const heartbeat = setInterval(() => {
      void renewClaim(c).catch((err) => log.warn({ err, id: c.id }, "delivery lease renewal failed"));
    }, LEASE_SECONDS * 1000 / 3);
    heartbeat.unref();
    try {
      await send(c.channel, {
        ...ctx,
        target: c.target,
        // Decrypt the at-rest envelope right before it is used as the HMAC key.
        signingSecret: openSecretOrNull(c.signing_secret),
        deliveryId: c.id,
      });
    } finally {
      clearInterval(heartbeat);
    }

    await markSucceeded(c, nextAttempt);
  } catch (err) {
    // `message` is stored as last_error and shown with the hit; the cause
    // (resolved address, resolver or connect error) stays in this log.
    const message = err instanceof Error ? err.message : String(err);
    const cause = causeDetail(err);
    if (nextAttempt >= c.max_attempts) {
      if (await markFailed(c, nextAttempt, message)) log.warn(
        { id: c.id, channel: c.channel, target: c.target, attempts: nextAttempt, cause },
        `notification permanently failed: ${message}`,
      );
    } else {
      const backoffMs = backoffMillis(nextAttempt);
      if (await scheduleRetry(c, nextAttempt, backoffMs, message)) log.info(
        { id: c.id, channel: c.channel, attempts: nextAttempt, retryInMs: backoffMs, cause },
        `notification will retry: ${message}`,
      );
    }
  }
}

async function renewClaim(c: Claimed): Promise<boolean> {
  const renewed = await db.execute(sql`
    update notifications set lease_until = now() + (${LEASE_SECONDS}::int * interval '1 second')
    where id = ${c.id} and status = 'in_flight' and claim_token = ${c.claim_token}
      and lease_until > now()
    returning id
  `);
  return renewed.length > 0;
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

async function markSucceeded(c: Claimed, attempts: number): Promise<void> {
  await db.execute(sql`
    update notifications
    set status = 'succeeded',
        attempts = ${attempts},
        succeeded_at = now(),
        updated_at = now(),
        last_error = null, claim_token = null, lease_until = null
    where id = ${c.id} and status = 'in_flight' and claim_token = ${c.claim_token}
  `);
}

async function markFailed(
  c: Claimed,
  attempts: number,
  err: string,
): Promise<boolean> {
  const updated = await db.execute(sql`
    update notifications
    set status = 'failed',
        attempts = ${attempts},
        last_error = ${err.slice(0, 500)},
        updated_at = now(), claim_token = null, lease_until = null
    where id = ${c.id} and status = 'in_flight' and claim_token = ${c.claim_token}
    returning id
  `);
  return updated.length > 0;
}

async function markAborted(c: Claimed, reason: string): Promise<void> {
  await db.execute(sql`
    update notifications
    set status = 'aborted',
        last_error = ${reason.slice(0, 500)},
        updated_at = now(), claim_token = null, lease_until = null
    where id = ${c.id} and status = 'in_flight' and claim_token = ${c.claim_token}
  `);
}

async function scheduleRetry(
  c: Claimed,
  attempts: number,
  inMs: number,
  err: string,
): Promise<boolean> {
  const updated = await db.execute(sql`
    update notifications
    set status = 'pending',
        attempts = ${attempts},
        next_attempt_at = now() + (${inMs}::int * interval '1 millisecond'),
        last_error = ${err.slice(0, 500)},
        updated_at = now(), claim_token = null, lease_until = null
    where id = ${c.id} and status = 'in_flight' and claim_token = ${c.claim_token}
    returning id
  `);
  return updated.length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
