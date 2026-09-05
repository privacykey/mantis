import { and, eq, inArray, isNull } from "drizzle-orm";
import JSZip from "jszip";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { keys } from "@/db/schema";
import { requireApiKeyOrSession } from "@/lib/auth";
import {
  ALL_FORMATS,
  FILE_EXT,
  FIXED_BASENAME,
  generateFile,
  isAttributionFormat,
  type FileFormat,
} from "@/lib/docs";
import { keyUrl } from "@/lib/env";
import { log } from "@/lib/log";
import {
  BodyParseError,
  BodyTooLargeError,
  MAX_API_JSON_BYTES,
  readBodyJson,
} from "@/lib/safe-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Matches the per-submission cap in the bulk create action. */
const MAX_KEYS = 50;
const uuidSchema = z.uuid();

function isAllowed(v: string): v is FileFormat {
  return (ALL_FORMATS as string[]).includes(v);
}

/** Filesystem-safe stem derived from the memo, so files are identifiable. */
function safeStem(memo: string, fallback: string): string {
  const cleaned = memo
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._ -]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 60);
  return cleaned || fallback;
}

/**
 * Bundles one generated artifact per key into a single zip, so a bulk mint
 * ends in one download instead of N. Keys are looked up by id and filtered to
 * the caller's own — an id that isn't theirs is skipped, not 403'd, so the
 * endpoint can't be used to probe which key ids exist.
 */
export async function POST(req: NextRequest) {
  const auth = await requireApiKeyOrSession(req);
  if (!auth.ok) return auth.res;

  let body: unknown;
  try {
    body = await readBodyJson(req, MAX_API_JSON_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json(
        { error: "payload_too_large", message: err.message },
        { status: 413 },
      );
    }
    if (!(err instanceof BodyParseError)) throw err;
    return NextResponse.json(
      { error: "bad_request", message: "body must be JSON" },
      { status: 400 },
    );
  }

  const { ids, format } = (body ?? {}) as { ids?: unknown; format?: unknown };
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json(
      { error: "bad_request", message: "ids must be a non-empty array" },
      { status: 400 },
    );
  }
  if (ids.length > MAX_KEYS) {
    return NextResponse.json(
      { error: "bad_request", message: `too many ids (max ${MAX_KEYS})` },
      { status: 400 },
    );
  }
  if (!ids.every((i): i is string => uuidSchema.safeParse(i).success)) {
    return NextResponse.json(
      { error: "bad_request", message: "ids must be valid UUIDs" },
      { status: 400 },
    );
  }
  const fmt = typeof format === "string" ? format : "";
  if (!isAllowed(fmt)) {
    return NextResponse.json(
      {
        error: "bad_request",
        message: `unsupported format: ${fmt}. Allowed: ${ALL_FORMATS.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const owned = await db.select().from(keys).where(inArray(keys.id, ids));
  // Non-admins only get their own keys; admins see everything, mirroring
  // loadOwnedKey's rule for the single-key download.
  const visible = auth.key.isAdmin
    ? owned
    : owned.filter((k) => k.createdByApiKeyId === auth.key.id);

  if (visible.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const zip = new JSZip();
  const used = new Set<string>();
  let failures = 0;

  for (const key of visible) {
    let stem = safeStem(key.memo, key.publicId);
    // Two keys may legitimately share a memo shape; keep filenames unique.
    if (used.has(stem)) stem = `${stem}-${key.publicId}`;
    used.add(stem);

    try {
      const buf = await generateFile(fmt, {
        title: key.memo,
        url: keyUrl(key.publicId),
        publicId: key.publicId,
        keyId: key.id,
      });
      // Match single-file downloads: only a successful generation claims the
      // format, and a concurrent or later download cannot overwrite it.
      if (isAttributionFormat(fmt) && key.firstDownloadFormat == null) {
        await db
          .update(keys)
          .set({ firstDownloadFormat: fmt })
          .where(and(eq(keys.id, key.id), isNull(keys.firstDownloadFormat)));
      }
      // Formats with a canonical filename keep it and get a folder per key —
      // `chrome-cookies-laptop/cookies.txt` rather than a jar named after the
      // memo, which is not a jar anyone would believe.
      const fixed = FIXED_BASENAME[fmt];
      zip.file(fixed ? `${stem}/${fixed}` : `${stem}.${FILE_EXT[fmt]}`, buf);
    } catch (err) {
      // One bad artifact shouldn't sink the batch — record it in the zip so
      // the operator knows which key needs attention.
      failures += 1;
      log.error({ err, keyId: key.id, format: fmt }, "bulk artifact failed");
      zip.file(
        `FAILED-${stem}.txt`,
        `Could not generate ${fmt} for "${key.memo}" (${key.publicId}).\n` +
          `Reason: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  zip.file(
    "README.txt",
    [
      "Mantis bulk canary artifacts",
      "",
      `Format: ${fmt}`,
      `Keys:   ${visible.length}${failures ? ` (${failures} failed to generate)` : ""}`,
      "",
      "One file per key. Plant each one separately — hits are only",
      "traceable to a location if each location has its own key.",
      "",
      ...visible.map((k) => `  ${k.memo}  ->  ${keyUrl(k.publicId)}`),
    ].join("\n"),
  );

  const out = await zip.generateAsync({ type: "nodebuffer" });
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(new Uint8Array(out), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="mantis-${fmt}-${stamp}.zip"`,
      "Content-Length": String(out.length),
      "Cache-Control": "no-store",
    },
  });
}
