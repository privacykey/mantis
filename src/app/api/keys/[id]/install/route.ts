import { type NextRequest, NextResponse } from "next/server";
import { loadOwnedKey, requireApiKeyOrSession } from "@/lib/auth";
import { keyUrl } from "@/lib/env";
import {
  ALL_INSTALL_TYPES,
  buildInstaller,
  isInstallType,
} from "@mantis/core/installers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireApiKeyOrSession(req);
  if (!auth.ok) return auth.res;

  const { id } = await ctx.params;
  const key = await loadOwnedKey(auth.key, id);
  if (!key) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  if (!type || !isInstallType(type)) {
    return NextResponse.json(
      {
        error: "bad_request",
        message: `type is required. Allowed: ${ALL_INSTALL_TYPES.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const hostnameRaw = url.searchParams.get("hostname") ?? undefined;
  const hostname = hostnameRaw
    ? hostnameRaw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")
    : undefined;

  const installer = buildInstaller(type, {
    url: keyUrl(key.publicId),
    keyId: key.id,
    memo: key.memo,
    ...(hostname ? { hostname } : {}),
  });

  // Two modes: ?format=json returns the full installer metadata; default returns
  // the raw snippet content as a downloadable file.
  if (url.searchParams.get("format") === "json") {
    return NextResponse.json(installer);
  }

  return new NextResponse(installer.content, {
    status: 200,
    headers: {
      "Content-Type": installer.mime,
      "Content-Disposition": `attachment; filename="${installer.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
