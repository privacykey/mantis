import { type NextRequest } from "next/server";
import { handleTrigger } from "./trigger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ publicId: string }> };

async function handle(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { publicId } = await ctx.params;
  return handleTrigger(req, publicId);
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
// A tool that treats the bait as an API endpoint sends whatever method its
// operation calls for; `<trigger URL>/` (trailing slash) lands here too. The
// same set is exported for <trigger URL>/<appended path> in ./[...rest].
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
