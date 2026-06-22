import { type NextRequest, NextResponse } from "next/server";
import { isEnabled, pushCapture, truncateBody } from "@/lib/inbox";
import {
  BodyTooLargeError,
  MAX_INBOX_CAPTURE_BYTES,
  readBodyText,
} from "@/lib/safe-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ slug: string[] }> };

async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  if (!isEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const { slug } = await ctx.params;
  // The inbox is a dev-only webhook capture; accept generously, but still
  // bound. 1 MiB is well above any sane real webhook payload.
  let rawBody: string;
  try {
    rawBody = await readBodyText(req, MAX_INBOX_CAPTURE_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json(
        { error: "payload_too_large", message: err.message },
        { status: 413 },
      );
    }
    throw err;
  }
  const { body, truncated } = truncateBody(rawBody);

  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) headers[k] = v;

  const cap = pushCapture({
    method: req.method,
    slug: slug.join("/"),
    url: req.nextUrl.pathname + req.nextUrl.search,
    headers,
    body,
    body_truncated: truncated,
  });

  return NextResponse.json({ ok: true, captured_id: cap.id });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
