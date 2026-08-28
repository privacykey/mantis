import { type NextRequest, NextResponse } from "next/server";
import { requireApiKeyOrSession } from "@/lib/auth";
import { DEVICE_PROFILES, defaultVectorSlugs } from "@mantis/core/device-profiles";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The device-profile catalog, served over the API even though the CLI could
 * read @mantis/core directly: fetching means an installed `mantis device`
 * binary automatically picks up a new vector the moment the *server* has one,
 * and can't disagree with the dashboard about what a profile contains even
 * when the binary predates it.
 */
export async function GET(req: NextRequest) {
  const auth = await requireApiKeyOrSession(req);
  if (!auth.ok) return auth.res;

  return NextResponse.json({
    profiles: DEVICE_PROFILES.map((p) => ({
      os: p.os,
      label: p.label,
      blurb: p.blurb,
      defaults: defaultVectorSlugs(p.os),
      vectors: p.vectors.map((v) => ({
        slug: v.slug,
        label: v.label,
        blurb: v.blurb,
        install_type: v.installType,
        response_kind: v.responseKind,
        dedupe_window_seconds: v.dedupeWindowSeconds,
        needs_root: Boolean(v.needsRoot),
        needs_extra_setup: v.needsExtraSetup
          ? {
              what: v.needsExtraSetup.what,
              why: v.needsExtraSetup.why,
              detect: v.needsExtraSetup.detect,
              install: v.needsExtraSetup.install,
              requires: v.needsExtraSetup.requires,
            }
          : null,
      })),
    })),
  });
}
