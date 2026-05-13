import JSZip from "jszip";
import { generateDocx } from "./docx";
import { generatePdf } from "./pdf";
import { generatePptx } from "./pptx";
import { generateXlsx } from "./xlsx";
import { type DocOptions } from "./util";

/**
 * "Honey directory" — a zip of pre-baited mantis files all wired to the same URL.
 * Drop the unzipped folder on a shared drive; any file opened/clicked fires the mantis.
 */
export async function generateFolder(opts: DocOptions): Promise<Buffer> {
  const folderName = sanitizeFolderName(opts.title) || "Mantis";
  const zip = new JSZip();
  const root = zip.folder(folderName);
  if (!root) throw new Error("failed to create root folder in zip");

  const url = opts.url;

  // --- Office canaries: open in Word/Excel/PowerPoint → external image fetch
  const [xlsx, docx, pptx, pdf] = await Promise.all([
    generateXlsx({
      title: "Q4 Salary Review",
      url,
      body: [
        "Salary band",
        "Department",
        "Q3 Total",
        "Q4 Projected",
        "% Change",
        "[content redacted — see HR portal]",
      ],
    }),
    generateDocx({
      title: "Restructuring Memo — Draft",
      url,
      body: [
        "INTERNAL — DO NOT FORWARD",
        "",
        "This memo outlines proposed organizational changes for Q4 2026.",
        "Final details are pending leadership review.",
        "",
        "[See attached spreadsheet for affected positions.]",
      ],
    }),
    generatePptx({
      title: "All-Hands Q4 Plans (DRAFT)",
      url,
      body: [
        "Quarterly review",
        "Organizational priorities",
        "Restructuring update",
        "Q1 2027 preview",
      ],
    }),
    generatePdf({
      title: "Layoff Schedule 2026",
      url,
      body: [
        "Confidential — HR Working Group only",
        "",
        "Per leadership review on 2026-04-30, the following roles are slated for elimination effective Q4 2026.",
        "Final list pending legal review.",
        "",
        "Names and severance details redacted from this draft.",
      ],
    }),
  ]);

  root.file("Q4 Salary Review.xlsx", xlsx);
  root.file("Restructuring Memo - Draft.docx", docx);
  root.file("All-Hands Q4 Plans.pptx", pptx);
  root.file("Layoff Schedule 2026.pdf", pdf);

  // --- Plaintext bait: fake credentials with the mantis URL embedded as a "more info" line
  root.file("passwords.txt", buildPasswordsTxt(url));
  root.file("database-credentials.txt", buildDbCredsTxt(url));
  root.file("README.txt", buildReadmeTxt(url));

  // --- Shortcuts: Windows Internet Shortcut and macOS WebLoc — fire on double-click
  root.file("Open in Browser.url", buildUrlShortcut(url));
  root.file("Latest Version.webloc", buildWebloc(url));

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function sanitizeFolderName(s: string): string {
  return s
    .replace(/[^A-Za-z0-9 _.\-]/g, "")
    .trim()
    .slice(0, 80);
}

// AWS/Stripe documented example keys — public, not real credentials anywhere.
function buildPasswordsTxt(url: string): string {
  return [
    "# Production credentials — DO NOT SHARE",
    "# Updated 2026-04-22 (rotated last month)",
    "# Source of truth: see Latest Version.webloc / Open in Browser.url",
    "",
    "ssh root@prod-bastion.internal.example.com",
    "  pw: Tr0ub4dor&3-PROD",
    "",
    "AWS root account",
    "  access_key: AKIAIOSFODNN7EXAMPLE",
    "  secret_key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "",
    "Stripe (read-only)",
    "  key: sk_live_4eC39HqLyjWDarjtT1zdp7dc",
    "",
    "Slack webhook",
    "  https://hooks.slack.com/services/T01ABCD/B02EFGH/zzzPRODyyy",
    "",
    `# Latest backup: ${url}`,
    "",
  ].join("\r\n");
}

function buildDbCredsTxt(url: string): string {
  return [
    "# PostgreSQL — Production",
    "# DO NOT COMMIT THIS FILE",
    "",
    "DB_HOST=prod-db-primary.internal.example.com",
    "DB_PORT=5432",
    "DB_NAME=production_main",
    "DB_USER=app_admin",
    "DB_PASS=ze1Pho1ai5oh4uic9Aeph8eiriop1ie",
    "",
    "# Read replica",
    "DB_REPLICA_HOST=prod-db-replica.internal.example.com",
    "DB_REPLICA_USER=readonly_app",
    "DB_REPLICA_PASS=Choj9eshohs5shoo9oosh3eichi3aiCh",
    "",
    "# Migration / DBA",
    "DB_ADMIN_USER=postgres",
    "DB_ADMIN_PASS=ohB7eim8aen2yaiP4thaeg6aighai7Ai",
    "",
    `# Operator notes & connection guide: ${url}`,
    "",
  ].join("\r\n");
}

function buildReadmeTxt(url: string): string {
  return [
    "Internal working draft. Files in this directory are pre-decisional and",
    "should not be circulated outside the working group.",
    "",
    "Contents:",
    "  - Q4 Salary Review.xlsx",
    "  - Restructuring Memo - Draft.docx",
    "  - All-Hands Q4 Plans.pptx",
    "  - Layoff Schedule 2026.pdf",
    "  - passwords.txt, database-credentials.txt (rotated; for emergency access only)",
    "",
    `For latest versions of all files, see: ${url}`,
    "",
    "— Leadership working group",
    "",
  ].join("\r\n");
}

function buildUrlShortcut(url: string): string {
  // Windows Internet Shortcut (.url). Plain INI; double-click opens default browser.
  // CRLF line endings are conventional.
  return ["[InternetShortcut]", `URL=${url}`, "IconIndex=0", ""].join("\r\n");
}

function buildWebloc(url: string): string {
  // macOS Internet shortcut (.webloc) — XML plist. Double-click opens in default browser.
  // Escape URL contents safely for XML.
  const escaped = url
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "    <key>URL</key>",
    `    <string>${escaped}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}
