import { type NextRequest, NextResponse } from "next/server";
import { loadOwnedKey, requireApiKeyOrSession } from "@/lib/auth";
import {
  ALL_FORMATS,
  FILE_EXT,
  FILE_MIME,
  generateFile,
  type FileFormat,
} from "@/lib/docs";
import { keyUrl } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

function isAllowed(v: string): v is FileFormat {
  return (ALL_FORMATS as string[]).includes(v);
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireApiKeyOrSession(req);
  if (!auth.ok) return auth.res;

  const { id } = await ctx.params;
  const key = await loadOwnedKey(auth.key, id);
  if (!key) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "docx";
  if (!isAllowed(format)) {
    return NextResponse.json(
      {
        error: "bad_request",
        message: `unsupported format: ${format}. Allowed: ${ALL_FORMATS.join(", ")}`,
      },
      { status: 400 },
    );
  }

  let buf: Buffer;
  try {
    buf = await generateFile(format, {
      title: key.memo,
      url: keyUrl(key.publicId),
      publicId: key.publicId,
      keyId: key.id,
    });
  } catch (err) {
    if (err && typeof err === "object" && "name" in err && err.name === "ApplePassDisabledError") {
      return NextResponse.json(
        {
          error: "not_configured",
          message: err instanceof Error ? err.message : String(err),
        },
        { status: 503 },
      );
    }
    throw err;
  }
  const filename = sanitizeFilename(key.memo) + "." + FILE_EXT[format];
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": FILE_MIME[format],
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buf.length),
      "Cache-Control": "no-store",
    },
  });
}

function sanitizeFilename(s: string): string {
  return (
    s
      .replace(/[^A-Za-z0-9 _.\-]/g, "")
      .trim()
      .slice(0, 60) || "mantis"
  );
}
