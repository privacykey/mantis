import { type NextRequest } from "next/server";
import { handleTrigger } from "../trigger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ publicId: string; rest: string[] }> };

// <trigger URL>/<anything>. Bait that sits in a base-URL field (the aws
// profile's endpoint_url, a .env API_BASE_URL, a kubeconfig server) is consumed
// by tools that append their own path — an S3 bucket/object, a REST operation,
// /api/v1/… — and send whatever method the operation calls for. Those requests
// are the bait being USED, so they go through the same handler as the exact
// URL: same lookup, same limiter, same per-key response. Unknown, disabled and
// expired ids therefore stay indistinguishable here too (silent GIF).
async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { publicId, rest } = await ctx.params;
  return handleTrigger(req, publicId, `/${rest.join("/")}`);
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
