# Mantis canaries in self-hosted apps

How to plant a tripwire inside the self-hosted apps you already run. Every recipe assumes you have a Mantis instance running and a key minted (`mantis new "memo"`). The `URL` referenced below is the per-key trigger URL printed by `mantis new`.

Two flavours of recipe:

1. **Drop-a-file** — generate an artifact with `mantis new --<fmt>` and upload it. The app stores the bytes; later, when anyone views/opens the file, an embedded reference fetches the trigger URL.
2. **Paste-a-URL** — no new artifact needed. You put the trigger URL into a field the app will hit on your behalf (a credential, a webhook, a dashboard tile, etc.).

| | Format | What fires the canary |
| -- | --- | --- |
| `--docx` `--xlsx` `--pptx` | Office | Auto-fetch of external image when the doc is opened in Word/Excel/PowerPoint |
| `--pdf` | PDF | `/OpenAction → /URI` on open + clickable link + visible URL |
| `--folder` | ZIP of all of the above + .url/.webloc shortcuts | Honey-directory: every file in the bundle fires the same key |
| `--svg` | SVG | Browser/viewer renders `<image href=…>` |
| `--html` | HTML | Browser fetches `<img src=…>` |
| `--md` | Markdown | Note renderer fetches `![](…)` image |
| `--eml` | RFC 5322 email | Mail client renders HTML body `<img>` |
| `--ics` | iCalendar event | Some calendar clients fetch `ATTACH;FMTTYPE=image/*` |
| `--vcf` | vCard | CardDAV clients fetch `PHOTO;VALUE=URI` |

---

## Photo libraries — Immich, PhotoPrism, Lychee, LibrePhotos

```sh
mantis new "vacation 2024 — RAW" --svg /tmp/vacation.svg
```

Upload `vacation.svg` to your photo library. Caveats per app:

- **Immich**: SVG uploads land in the library, but Immich generates a server-side raster thumbnail by default — the thumbnail does not fire. Opening the original (link or "Open original") fires every time. Useful for detecting download-and-view, not gallery scrolling.
- **PhotoPrism / Lychee**: similar — SVG previews depend on the app's preview pipeline; verify with `mantis hits <id>` after a single render.

For a passive scraper signal (much weaker) you can also place a JPEG whose EXIF `UserComment` contains the trigger URL; this only fires if someone runs `exiftool` on the file.

## Document management — Paperless-ngx, Mayan EDMS

```sh
mantis new "Q4 financials — final" --pdf /tmp/q4.pdf
mantis new "Archived inbox" --eml /tmp/archive.eml
```

Upload `q4.pdf` to Paperless. Paperless OCRs the document but does not auto-fire the canary during indexing. When you (or anyone) clicks the document in the UI to preview it, the browser PDF viewer hits the trigger URL on open. The clickable URL annotation and `/OpenAction` both fire.

EML is useful for email-archive workflows. Paperless can ingest .eml; opening the message preview fires the inline `<img>`.

## Notes — Joplin, Trilium, Logseq, Obsidian sync

```sh
mantis new "API keys backup" --md /tmp/note.md
mantis new "Server passwords" --html /tmp/note.html
```

Import the Markdown file as a new note. The first time the note opens (or every time, depending on the renderer), the inline image renders and fires.

Trilium and Logseq render Markdown server-side or on-render — both work. Obsidian renders Markdown in the desktop client; the inline image fires from your editor when the note is opened.

## Calendar — Radicale, Nextcloud Calendar, DAViCal

```sh
mantis new "Quarterly Review — leadership" --ics /tmp/event.ics
```

Import `event.ics` into your calendar app. Apple Calendar and macOS Calendar fetch attachments with `FMTTYPE=image/*` on open; behavior varies for other clients. The `URL` property is also clickable from the event detail.

## Contacts — Radicale, Nextcloud Contacts, CardDAV

```sh
mantis new "Backup admin contact" --vcf /tmp/contact.vcf
```

Import the vCard. CardDAV clients (macOS Contacts, iOS Contacts, Thunderbird Address Book) fetch the `PHOTO;VALUE=URI` reference on contact render. The `URL` field is also surfaced as the contact's URL property.

## Password vaults — Vaultwarden, Bitwarden, Padloc

No new artifact needed. Create a login entry:

- **Name**: `Internal admin — DO NOT TOUCH`
- **URL**: paste your Mantis trigger URL (e.g. `https://mantis.example.com/c/abc123`)
- **Username**: `admin`
- **Password**: anything random

Bitwarden's "Launch & autofill" hits the URL. The browser extension's icon-click also fires. Manual reveal does **not** fire — only when the URL is followed.

## Dashboards — Heimdall, Homer, Homepage, Dashy

No new artifact needed. Add a tile:

- **Label**: `Internal Wiki` / `Admin Console` / `Backup Portal`
- **URL**: trigger URL

If anyone clicks the tile, the canary fires. Doubles as a phishing-resistance training tool for housemates.

## Bookmarks — Linkding, Wallabag, Hoarder, Karakeep, Shiori

No new artifact needed. Paste the trigger URL as a bookmark. Most of these services scrape the URL on add to extract metadata, so the canary fires immediately on save (one expected hit). Re-fetches or re-syncs also fire — this signal is noisy. Best for detecting force-rescan attacks rather than per-view activity.

## Home automation — Home Assistant, n8n, Node-RED

No new artifact needed. Add a `webhook` integration / node:

- **URL**: trigger URL
- Wire it into an automation that *should never run* (e.g., guarded behind a condition that's always false).

A misconfiguration, manual test, or attacker-modified config will fire the canary.

## Code hosting — Gitea, Forgejo, Gogs

```sh
mantis new "Private repo README" --md /tmp/README.md
```

Drop the generated `README.md` into a fresh private repo. Anyone with read access loads the README and fires the canary. Useful for detecting unauthorised clone-and-browse.

For a separate vector inside the same repo, you can also add a fake `.env` whose first line is the trigger URL. Exfiltrators scanning for secrets often follow URLs in `.env` files.

## RSS / social — FreshRSS, Miniflux, Mastodon, Pixelfed

No new artifact needed. Publish a status or feed item containing the trigger URL. Federating instances and aggregators fetch OpenGraph metadata from the URL → the canary fires every scrape. This is a federation/scraper detector, not a user-clicked detector.

## Cloud storage — Nextcloud, Seafile, OwnCloud

Any of the artifacts above work — drop into a folder and grant a share link. The recipe is the same as the file-format's intended consumer: the .pdf fires when previewed in the browser's PDF viewer; the .eml fires when previewed in Nextcloud Mail; the .vcf fires when imported into Contacts; etc.

For a single-file high-fidelity option, use `mantis new "Confidential" --folder /tmp/honey.zip` — the unzipped folder contains a coordinated set of bait files that all fire the same key.

## Mail servers — Mailcow, Mail-in-a-Box, Stalwart

```sh
mantis new "Archived support email" --eml /tmp/junk.eml
```

Place the .eml into an archive or junk folder. Any mail client opening the message renders the HTML body and fires.

## Verification

After dropping a recipe, confirm it landed:

```sh
mantis hits <key-id>
```

The hit's `user_agent` field tells you which renderer fired (browser? mail client? CalDAV?), useful for narrowing down where the access happened.

For broader coverage, set the key's monitor mode to `latch` so the next view trips an Uptime Kuma alert:

```sh
mantis monitor <key-id> --mode latch
```

See the Uptime Kuma section of the main README for the rest of that flow.

---

## Edge compatibility

Mantis has two URL-emitting modes:

| Mode | URL shape | Backing | Per-hit storage |
|---|---|---|---|
| **Server-backed** (`mantis new`) | `https://mantis.example.com/c/abc123` (~40 chars) | Postgres-backed Next.js server | Yes — full hit log, dashboard, monitor modes, retry queue |
| **mantis-edge** (`mantis edge mint`) | `https://worker.example.com/c/<sealed-blob>` (~150–400 chars) | Cloudflare Worker, AES-GCM-sealed config in the URL itself | No — fires the configured webhook once, no local state |

Every file format below is just a URL container — **all 12 formats work with either mode.** Pick the mode first, get a URL, then drop it into the format.

### Compatibility matrix

| Format | Server-backed | mantis-edge | Notes |
|---|---|---|---|
| `.docx` `.xlsx` `.pptx` | ✅ | ✅ | OOXML `relationships/External` URL — length doesn't matter |
| `.pdf` | ✅ | ✅ | `/OpenAction → /URI` accepts any URL; long URLs may wrap when displayed but still open |
| `.folder` (zip) | ✅ | ✅ | All bundled bait files inherit the same URL |
| `.svg` | ✅ | ✅ | `<image href>` accepts any URL |
| `.html` | ✅ | ✅ | `<img src>` accepts any URL |
| `.md` | ✅ | ✅ | `![](URL)` Markdown image syntax has no length limit |
| `.eml` | ✅ | ✅ | RFC 5322 has no `<img src>` URL length cap; very long URLs may trip overzealous spam filters |
| `.ics` | ✅ | ⚠ | RFC 5545 §3.1 says lines SHOULD fold at 75 octets. Our generator doesn't fold — long edge URLs may upset strict parsers (most tolerate it). Test in your CalDAV client before deploying. |
| `.vcf` | ✅ | ⚠ | RFC 6350 §3.2 same folding rule. Same caveat. |
| `.nfc-label` (PDF/QR sticker) | ✅ | ✅ | QR error correction at "M" comfortably encodes up to ~500 chars; edge URLs at ~300 chars still scan reliably |
| `.apple-wallet` (.pkpass) | ✅ | ⚠ | Apple Wallet's web-service callbacks require the server-backed key for registration/de-registration callbacks — edge-only use loses install/uninstall tracking |
| QR via `--qr` | ✅ | ✅ | Same QR comment as above |

### Trade-offs

**Use server-backed when you want:**
- A hit log you can query (`mantis hits`, dashboard, `/api/keys/<id>/hits`)
- Uptime Kuma monitor mode (latch/window)
- Webhook retry queue + delivery state on each hit
- Compact URLs (small QR codes, clean-looking VCF/ICS, fitting in tight UI fields)

**Use mantis-edge when you want:**
- Zero server attack surface (no DB, no API, no auth to compromise)
- Sub-50ms response from Cloudflare's edge globally
- A canary that survives even if your main mantis server is down
- One-shot fire-and-forget: you don't care to query past hits, just want a webhook on access

**Combine them** by minting two URLs (one of each) for the same artifact — e.g. `mantis new "Q4" --pdf q4.pdf` plus a separately-minted edge URL pasted into the PDF body — and you get both a live audit trail and a degradation-proof tripwire.

---

## Format standards reference

Every artifact Mantis generates follows a published spec, so any compliant consumer renders it correctly:

| Format | Spec | Embed mechanism |
|---|---|---|
| `.docx` | ECMA-376 / **ISO/IEC 29500-1:2016** (Office Open XML, WordprocessingML) | `word/_rels/document.xml.rels` Relationship `Target="..." TargetMode="External"` pointing at canary URL, referenced by a `w:drawing` |
| `.xlsx` | ECMA-376 / ISO/IEC 29500-1 (SpreadsheetML) | `xl/drawings/_rels/drawing1.xml.rels` external Relationship |
| `.pptx` | ECMA-376 / ISO/IEC 29500-1 (PresentationML) | `ppt/slides/_rels/slide1.xml.rels` external Relationship |
| `.pdf` | **ISO 32000-1:2008** / 32000-2:2020 | `/Catalog → /OpenAction → /Action /URI` + `/Annot /Link /URI` |
| `.folder` (zip) | **ISO/IEC 21320-1:2015** (subset of PKWARE APPNOTE.TXT) | Container only — payload is the bundled formats |
| `.svg` | **W3C SVG 1.1 (Second Edition)** / SVG 2 | `<image href="...">` (SVG 2) + `xlink:href` (SVG 1.1 back-compat) |
| `.html` | **WHATWG HTML Living Standard** | `<img src="...">` |
| `.md` | **CommonMark 0.31.2** (most renderers) — some use GFM (GitHub Flavored Markdown) | `![alt](url)` image syntax |
| `.eml` | **RFC 5322** (Internet Message Format) + **RFC 2045–2049** (MIME) | `multipart/alternative` with `text/html` part containing `<img src="...">` |
| `.ics` | **RFC 5545** (iCalendar Core Object Specification) + RFC 5546 (transport) | `VEVENT` with `URL:<canary>` and `ATTACH;FMTTYPE=image/png:<canary>` |
| `.vcf` | **RFC 6350** (vCard 4.0) | `PHOTO;VALUE=URI:<canary>` and `URL:<canary>` |
| `.nfc-label` | ISO 32000 (PDF) + **ISO/IEC 18004:2015** (QR Code 2005) | NDEF URI record on NFC, QR fallback printed in PDF |
| `.apple-wallet` | Apple **PassKit Package Format** (proprietary, no ISO equivalent) | Web-service URL in `pass.json` → callbacks fire on install/registration/update |
| `.pkpass` QR `--qr` | **ISO/IEC 18004:2015** (QR Code) | Direct URL encoding, error correction level "M" |
| Trigger 1×1 GIF | **CompuServe GIF89a** | Default response body for `/c/<id>` on a server-backed key |

### Why this matters for self-hosted apps

App ecosystems treat their input formats as **black boxes that conform to a spec**. Immich doesn't know your SVG was generated by Mantis — it just sees a W3C-conformant SVG with an `<image href>`. Paperless doesn't know your PDF embeds a tripwire — it sees an ISO 32000 PDF with an OpenAction. The standards layer is what makes a Mantis canary indistinguishable from a "real" file at the format level.

The only fingerprint is the URL itself. For maximum stealth:

- Use a custom domain for your server (`assets.your-company.com/c/<id>` looks innocuous; `mantis.example.com/c/<id>` does not)
- Or use mantis-edge with a domain like `cdn.your-company.com` — the URL still reveals the path `/c/<blob>`, but the host stays neutral
- The `CANARY_PUBLIC_PATH` env var (default `/c`) lets server-backed mode use stealthier paths like `/img`, `/track`, `/r`
