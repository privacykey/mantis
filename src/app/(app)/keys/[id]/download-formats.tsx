"use client";

import Link from "next/link";
import { useState } from "react";

// The two single-file document groups subject to the one-filetype-per-key rule.
// They mirror ATTRIBUTION_FORMATS in @/lib/docs — kept inline here so this
// client bundle doesn't pull in the (server-only) document generators. The
// `folder` bundle and wallet/NFC vectors stay in the server component, exempt.
const FILE_KEY_FORMATS = ["docx", "xlsx", "pptx", "pdf", "rtf"] as const;
const SELF_HOSTED_FORMATS = ["svg", "html", "md", "eml", "ics", "vcf"] as const;
// Credential and config stores. Grouped apart from the document formats
// because they fire differently: a document beacons when it is rendered, these
// beacon when the URL inside them is used.
const CREDENTIAL_STORE_FORMATS = [
  "cookies",
  "bookmarks",
  "env",
  "aws-credentials",
  "netrc",
  "kubeconfig",
  "ovpn",
  "rdp",
] as const;

export function DownloadFormats({
  keyId,
  memo,
  initialLockedFormat,
}: {
  keyId: string;
  memo: string;
  initialLockedFormat: string | null;
}) {
  // The persisted server value is authoritative; the optimistic value only
  // bridges the gap between a click and the next server render, so the operator
  // sees the locked state immediately without reloading the page.
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const locked = initialLockedFormat ?? optimistic;

  // First document download wins. Lock the UI the instant a format is clicked —
  // the same GET also stamps firstDownloadFormat server-side. Once locked, later
  // clicks of other formats don't change it, matching the server's
  // `WHERE first_download_format IS NULL` guard.
  const onDownload = (fmt: string) => {
    if (locked === null) setOptimistic(fmt);
  };

  return (
    <>
      <span className="block mb-1">file keys</span>
      <div className="flex flex-wrap gap-3">
        {FILE_KEY_FORMATS.map((fmt) => (
          <DownloadLink
            key={fmt}
            keyId={keyId}
            fmt={fmt}
            lockedFormat={locked}
            onDownload={onDownload}
          />
        ))}
      </div>
      <span className="block mt-2 mb-1">self-hosted app formats</span>
      <div className="flex flex-wrap gap-3">
        {SELF_HOSTED_FORMATS.map((fmt) => (
          <DownloadLink
            key={fmt}
            keyId={keyId}
            fmt={fmt}
            lockedFormat={locked}
            onDownload={onDownload}
          />
        ))}
      </div>
      <span className="block mt-2 mb-1">credential &amp; config stores</span>
      <div className="flex flex-wrap gap-3">
        {CREDENTIAL_STORE_FORMATS.map((fmt) => (
          <DownloadLink
            key={fmt}
            keyId={keyId}
            fmt={fmt}
            lockedFormat={locked}
            onDownload={onDownload}
          />
        ))}
      </div>
      <span className="block text-neutral-600 mt-1">
        where an intruder with a shell looks first. These fire when the URL
        inside is <em>used</em>, not when the file is opened.
      </span>
      <span className="block text-neutral-600 mt-1">
        for Immich / Paperless / Joplin / calendar / contacts etc. — see{" "}
        <a
          href="https://github.com/privacykey/docs-mantis/blob/main/self-hosted-apps.md"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 no-underline hover:underline"
        >
          docs-mantis: self-hosted-apps.md
        </a>
        .
      </span>
      <OneFiletypeNudge memo={memo} lockedFormat={locked} />
    </>
  );
}

// A single document-format download link. Once a key has been downloaded as one
// format, that format is highlighted as "this key's filetype" and the others are
// dimmed (but still clickable) — the soft nudge toward one filetype per key.
function DownloadLink({
  keyId,
  fmt,
  lockedFormat,
  onDownload,
}: {
  keyId: string;
  fmt: string;
  lockedFormat: string | null;
  onDownload: (fmt: string) => void;
}) {
  const isLocked = lockedFormat === fmt;
  const dimmed = lockedFormat !== null && !isLocked;
  return (
    <span className="inline-flex items-center gap-1">
      <a
        href={`/api/keys/${keyId}/download?format=${fmt}`}
        className={`no-underline hover:underline ${
          dimmed ? "text-neutral-600" : "text-blue-400"
        }`}
        title={
          dimmed
            ? `This key's filetype is .${lockedFormat}. Downloading another filetype makes hits harder to trace — mint a new key instead.`
            : undefined
        }
        download
        onClick={() => onDownload(fmt)}
      >
        ↓ .{fmt}
      </a>
      {isLocked && (
        <span className="text-emerald-500 text-[10px] uppercase tracking-wide whitespace-nowrap">
          ← this key&apos;s filetype
        </span>
      )}
    </span>
  );
}

// Guidance shown under the document-download links: a plain tip before the first
// download, an amber warning + "mint another key" shortcut afterwards.
function OneFiletypeNudge({
  memo,
  lockedFormat,
}: {
  memo: string;
  lockedFormat: string | null;
}) {
  if (lockedFormat === null) {
    return (
      <span className="block text-neutral-600 mt-2">
        Tip: download one filetype per key so each hit traces back to a single
        planted file. Need another format? Mint a separate key.
      </span>
    );
  }
  return (
    <span className="block text-amber-500/90 mt-2">
      ⚠ This key was downloaded as .{lockedFormat}. For clean attribution, keep
      one filetype per key.{" "}
      <Link
        href={`/keys/new?memo=${encodeURIComponent(memo)}`}
        className="text-blue-400 no-underline hover:underline"
      >
        + new key for a different filetype
      </Link>
    </span>
  );
}
