import { type NextRequest, NextResponse } from "next/server";
import { loadOwnedKey, requireApiKeyOrSession } from "@/lib/auth";
import { audit } from "@/lib/audit";
import {
  rotateSigningSecret,
  serializeDestination,
} from "@/lib/notify/destinations";
import { extractIp } from "@/lib/request-info";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string; destinationId: string }> };

/**
 * Rotates a webhook destination's HMAC signing secret and returns the new
 * plaintext. In-flight notifications keep the previous secret (denormalized
 * at enqueue).
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireApiKeyOrSession(req);
  if (!auth.ok) return auth.res;

  const { id, destinationId } = await ctx.params;
  if (!UUID_RE.test(destinationId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const ownedKey = await loadOwnedKey(auth.key, id);
  if (!ownedKey) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const updated = await rotateSigningSecret(id, destinationId);
  if (!updated) {
    return NextResponse.json(
      {
        error: "not_found",
        message:
          "no webhook destination with that id under this key (only webhook channels have signing secrets)",
      },
      { status: 404 },
    );
  }

  await audit({
    type: "destinations.replaced",
    actorApiKeyId: auth.key.id,
    actorLabel: auth.key.name,
    subjectKind: "destination",
    subjectId: destinationId,
    metadata: { action: "rotate_signing_secret", key_id: id },
    ip: extractIp(req),
  });

  return NextResponse.json(serializeDestination(updated, { reveal: true }));
}
