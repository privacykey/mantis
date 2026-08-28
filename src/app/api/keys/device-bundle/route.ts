import { inArray } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { keys } from "@/db/schema";
import { requireApiKeyOrSession } from "@/lib/auth";
import {
  buildDeviceBundle,
  buildDeviceBundleFiles,
  bundleRootName,
  type BundleVector,
} from "@mantis/core/device-bundle";
import { getVector, isDeviceOs } from "@mantis/core/device-profiles";
import { env, keyUrl } from "@/lib/env";
import { buildInstaller } from "@mantis/core/installers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A machine has a bounded number of alarms; well above any real profile. */
const MAX_VECTORS = 20;

type VectorRef = { id: string; slug: string };

/**
 * Packages an already-minted device suite into an installable zip.
 *
 * Minting and bundling are separate on purpose: the keys exist in the database
 * the moment the suite is created, so a failed or re-requested download is just
 * another POST here rather than a reason to mint a second set. The dashboard
 * calls this straight after minting; the CLI calls it for `--bundle`.
 */
export async function POST(req: NextRequest) {
  const auth = await requireApiKeyOrSession(req);
  if (!auth.ok) return auth.res;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("body must be JSON");
  }

  const {
    device,
    os: osRaw,
    vectors: vectorsRaw,
  } = (body ?? {}) as {
    device?: unknown;
    os?: unknown;
    vectors?: unknown;
  };

  if (typeof device !== "string" || device.trim().length === 0) {
    return bad("device is required");
  }
  if (device.length > 200) return bad("device name too long (max 200)");
  if (typeof osRaw !== "string" || !isDeviceOs(osRaw)) {
    return bad("os must be one of: macos, linux, windows");
  }
  const os = osRaw;

  if (!Array.isArray(vectorsRaw) || vectorsRaw.length === 0) {
    return bad("vectors must be a non-empty array");
  }
  if (vectorsRaw.length > MAX_VECTORS) {
    return bad(`too many vectors (max ${MAX_VECTORS})`);
  }

  const refs: VectorRef[] = [];
  for (const v of vectorsRaw) {
    const { id, slug } = (v ?? {}) as { id?: unknown; slug?: unknown };
    if (typeof id !== "string" || typeof slug !== "string") {
      return bad("each vector needs a string id and slug");
    }
    if (!getVector(os, slug)) {
      return bad(`unknown vector "${slug}" for ${os}`);
    }
    refs.push({ id, slug });
  }

  // A slug maps to one installer destination on the host, so two keys claiming
  // the same slug would have the second silently overwrite the first.
  const slugs = refs.map((r) => r.slug);
  if (new Set(slugs).size !== slugs.length) {
    return bad("duplicate vector slugs in request");
  }

  const rows = await db
    .select()
    .from(keys)
    .where(
      inArray(
        keys.id,
        refs.map((r) => r.id),
      ),
    );
  // Same visibility rule as the bulk download: an id that isn't yours is
  // skipped rather than 403'd, so this can't be used to probe which ids exist.
  const visible = auth.key.isAdmin
    ? rows
    : rows.filter((k) => k.createdByApiKeyId === auth.key.id);
  const byId = new Map(visible.map((k) => [k.id, k]));

  const bundleVectors: BundleVector[] = [];
  for (const ref of refs) {
    const key = byId.get(ref.id);
    // Silently dropping a key here would hand back a bundle that looks complete
    // while one alarm is simply absent — worse than refusing.
    if (!key) return notFound(ref.slug);
    const vector = getVector(os, ref.slug)!;
    bundleVectors.push({
      vector,
      key: { id: key.id, publicId: key.publicId, memo: key.memo },
      installer: buildInstaller(vector.installType, {
        url: keyUrl(key.publicId),
        keyId: key.id,
        memo: key.memo,
      }),
    });
  }

  const bundleInput = {
    deviceName: device,
    os,
    vectors: bundleVectors,
    baseUrl: env.publicBaseUrl,
  };

  // JSON mode backs `mantis device --install`: the CLI materializes these files
  // into a temp directory and runs the very script the zip ships, so there is
  // one bootstrap implementation rather than a second one in the CLI.
  if (new URL(req.url).searchParams.get("format") === "json") {
    return NextResponse.json(buildDeviceBundleFiles(bundleInput), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const out = await buildDeviceBundle(bundleInput);

  const filename = `${bundleRootName(device, os)}.zip`;
  return new NextResponse(new Uint8Array(out), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(out.length),
      "Cache-Control": "no-store",
    },
  });
}

function bad(message: string) {
  return NextResponse.json({ error: "bad_request", message }, { status: 400 });
}

function notFound(slug: string) {
  return NextResponse.json(
    {
      error: "not_found",
      message: `no visible key for vector "${slug}"`,
    },
    { status: 404 },
  );
}
