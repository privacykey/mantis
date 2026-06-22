import { type NextRequest, NextResponse } from "next/server";
import { log } from "@/lib/log";
import {
  BodyTooLargeError,
  MAX_WEBHOOK_LOG_BYTES,
  readBodyJson,
} from "@/lib/safe-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Apple Wallet's "log" endpoint — receivers can POST diagnostic strings here
 * when something goes wrong. We surface these at debug level for operators
 * but don't otherwise act on them.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readBodyJson<{ logs?: unknown } | null>(
      req,
      MAX_WEBHOOK_LOG_BYTES,
    ).catch((err) => {
      // Only the size cap should bubble — silent-ignore parse failures
      // because Apple Wallet retries are noisy enough already.
      if (err instanceof BodyTooLargeError) throw err;
      return null;
    });
    if (body && Array.isArray(body.logs)) {
      for (const line of body.logs) {
        if (typeof line === "string") {
          log.debug({ source: "apple-wallet" }, line.slice(0, 500));
        }
      }
    }
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json(
        { error: "payload_too_large", message: err.message },
        { status: 413 },
      );
    }
    log.warn({ err }, "wallet log endpoint failed to parse body");
  }
  return new NextResponse(null, { status: 200 });
}
