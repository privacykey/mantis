import { type NextRequest, NextResponse } from "next/server";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Apple Wallet's "log" endpoint — receivers can POST diagnostic strings here
 * when something goes wrong. We surface these at debug level for operators
 * but don't otherwise act on them.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      logs?: unknown;
    } | null;
    if (body && Array.isArray(body.logs)) {
      for (const line of body.logs) {
        if (typeof line === "string") {
          log.debug({ source: "apple-wallet" }, line.slice(0, 500));
        }
      }
    }
  } catch (err) {
    log.warn({ err }, "wallet log endpoint failed to parse body");
  }
  return new NextResponse(null, { status: 200 });
}
