import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { MANTIS_VERSION } from "@/lib/version";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STARTED_AT = new Date();

/**
 * Liveness + minimal readiness check for load balancers / uptime monitors.
 * Always returns JSON. Status 200 = app + DB OK, 503 = DB unreachable.
 *
 * Intentionally lightweight (`SELECT 1`) so high-frequency probes don't
 * exercise the notification worker / hits table / etc.
 */
export async function GET() {
  const startedAt = STARTED_AT.toISOString();
  try {
    await db.execute(sql`SELECT 1`);
    return NextResponse.json(
      { status: "ok", db: "ok", started_at: startedAt, version: MANTIS_VERSION },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "X-Mantis-Version": MANTIS_VERSION,
        },
      },
    );
  } catch {
    return NextResponse.json(
      {
        status: "degraded",
        db: "fail",
        started_at: startedAt,
        version: MANTIS_VERSION,
        // Fixed string on purpose: this endpoint is unauthenticated and the
        // driver's message names the internal DB host/port.
        error: "database unreachable",
      },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "X-Mantis-Version": MANTIS_VERSION,
        },
      },
    );
  }
}

export async function HEAD() {
  // Cheap HEAD path for `curl -I` / k8s probes that don't need a body.
  try {
    await db.execute(sql`SELECT 1`);
    return new NextResponse(null, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Mantis-Version": MANTIS_VERSION,
      },
    });
  } catch {
    return new NextResponse(null, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Mantis-Version": MANTIS_VERSION,
      },
    });
  }
}
