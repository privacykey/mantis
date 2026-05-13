import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { log } from "@/lib/log";
import { processBatch } from "@/lib/notify";
import { rateLimit } from "@/lib/rate-limit";
import { extractIp } from "@/lib/request-info";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET;
const UNAUTH_RATE_LIMIT = { limit: 10, windowMs: 60_000 } as const;

function authorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return false; // fail closed when no shared secret is set
  const header = req.headers.get("authorization");
  if (!header) return false;
  const expected = `Bearer ${CRON_SECRET}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function handle(req: NextRequest): Promise<Response> {
  if (!CRON_SECRET) {
    log.warn(
      "/api/cron/notifications hit but CRON_SECRET is not set — refusing. Set CRON_SECRET to enable this endpoint.",
    );
  }
  if (!authorized(req)) {
    // Throttle unauth probes per source (per IP when trusted, global otherwise).
    const ip = extractIp(req);
    const rl = rateLimit(`cron:${ip ?? "anonymous"}`, UNAUTH_RATE_LIMIT);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "rate_limited" },
        {
          status: 429,
          headers: {
            "Retry-After": String(
              Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)),
            ),
          },
        },
      );
    }
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const max = Math.min(
    1000,
    Math.max(1, Number(url.searchParams.get("max") ?? "200")),
  );

  let processed = 0;
  while (processed < max) {
    const batch = await processBatch(Math.min(25, max - processed));
    if (batch === 0) break;
    processed += batch;
  }

  return NextResponse.json({ processed });
}

export const GET = handle;
export const POST = handle;
