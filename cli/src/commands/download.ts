import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { c } from "../lib/out.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";

export type DownloadOpts = GlobalOpts & {
  docx?: string;
  xlsx?: string;
  pptx?: string;
  pdf?: string;
  folder?: string;
  nfcLabel?: string;
  appleWallet?: string;
  svg?: string;
  html?: string;
  md?: string;
  eml?: string;
  ics?: string;
  vcf?: string;
  rtf?: string;
  cookies?: string;
  bookmarks?: string;
  env?: string;
  awsCredentials?: string;
  netrc?: string;
  kubeconfig?: string;
  ovpn?: string;
  rdp?: string;
};

type FileFmt =
  | "docx"
  | "xlsx"
  | "pptx"
  | "pdf"
  | "folder"
  | "nfc-label"
  | "apple-wallet"
  | "svg"
  | "html"
  | "md"
  | "eml"
  | "ics"
  | "vcf"
  | "rtf"
  | "cookies"
  | "bookmarks"
  | "env"
  | "aws-credentials"
  | "netrc"
  | "kubeconfig"
  | "ovpn"
  | "rdp";

const FLAG_TO_FMT: Record<string, FileFmt> = {
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  pdf: "pdf",
  folder: "folder",
  nfcLabel: "nfc-label",
  appleWallet: "apple-wallet",
  svg: "svg",
  html: "html",
  md: "md",
  eml: "eml",
  ics: "ics",
  vcf: "vcf",
  rtf: "rtf",
  cookies: "cookies",
  bookmarks: "bookmarks",
  env: "env",
  awsCredentials: "aws-credentials",
  netrc: "netrc",
  kubeconfig: "kubeconfig",
  ovpn: "ovpn",
  rdp: "rdp",
};

export async function downloadCmd(
  id: string,
  opts: DownloadOpts,
): Promise<void> {
  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, id);
    const targets: Array<{ fmt: FileFmt; path: string }> = [];
    for (const flag of Object.keys(FLAG_TO_FMT) as Array<keyof typeof FLAG_TO_FMT>) {
      const p = opts[flag as keyof DownloadOpts] as string | undefined;
      if (p) targets.push({ fmt: FLAG_TO_FMT[flag]!, path: resolve(p) });
    }
    if (targets.length === 0) {
      throw new Error(
        `specify at least one of: ${Object.keys(FLAG_TO_FMT)
          .map((f) => `--${f.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`)
          .join(", ")}`,
      );
    }
    for (const t of targets) {
      const { data } = await client.downloadFile(fullId, t.fmt);
      await writeFile(t.path, data);
      process.stderr.write(
        `${c.green("✓")} saved ${data.length} bytes to ${t.path}\n`,
      );
    }
  });
}
