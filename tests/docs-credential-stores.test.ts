import { describe, expect, it } from "vitest";
import {
  ALL_FORMATS,
  CREDENTIAL_FORMATS,
  FILE_EXT,
  FILE_MIME,
  FIXED_BASENAME,
  artifactFilename,
  generateFile,
  type FileFormat,
} from "@/lib/docs";
import { DEFAULT_BODY } from "@/lib/docs/util";

const URL = "https://mantis.example.com/c/aBcD1234";
const TITLE = "prod credentials — build box";

async function render(format: FileFormat): Promise<string> {
  const buf = await generateFile(format, { title: TITLE, url: URL });
  return buf.toString("utf8");
}

describe("format catalog", () => {
  it("every format has a generator, a MIME type and an extension", async () => {
    for (const fmt of ALL_FORMATS) {
      expect(FILE_MIME[fmt], `${fmt} MIME`).toBeTruthy();
      expect(FILE_EXT[fmt], `${fmt} ext`).toBeTruthy();
    }
  });

  it("generates every text-based format without throwing", async () => {
    // apple-wallet needs signing config and folder/nfc-label/pdf are binary;
    // this covers everything that should be plain text end to end.
    for (const fmt of CREDENTIAL_FORMATS) {
      const out = await render(fmt);
      expect(out.length, `${fmt} is empty`).toBeGreaterThan(0);
    }
  });

  it("puts the trigger URL (or its host) in every credential store", async () => {
    // The whole point of these files is that the bait is discoverable in them.
    for (const fmt of CREDENTIAL_FORMATS) {
      const out = await render(fmt);
      const hasUrl = out.includes(URL);
      const hasHost = out.includes("mantis.example.com");
      expect(hasUrl || hasHost, `${fmt} contains no bait`).toBe(true);
    }
  });

  it("keeps the canonical filename for formats whose name is the disguise", () => {
    // A cookie jar named after the memo is not a cookie jar.
    expect(artifactFilename("cookies", "chrome-cookies-laptop")).toBe(
      "cookies.txt",
    );
    expect(artifactFilename("aws-credentials", "anything")).toBe("credentials");
    expect(artifactFilename("netrc", "anything")).toBe(".netrc");
    expect(artifactFilename("env", "anything")).toBe(".env");
    expect(artifactFilename("kubeconfig", "anything")).toBe("config");
    // …and leaves memo-named formats alone.
    expect(artifactFilename("docx", "Q4 payroll")).toBe("Q4 payroll.docx");
    expect(artifactFilename("ovpn", "corp vpn")).toBe("corp vpn.ovpn");
  });

  it("only fixes basenames for formats that actually have a canonical name", () => {
    for (const fmt of Object.keys(FIXED_BASENAME) as FileFormat[]) {
      expect(ALL_FORMATS, `${fmt} is not a real format`).toContain(fmt);
    }
  });
});

describe("cookies.txt", () => {
  it("is a valid Netscape jar with the bait scoped to the trigger path", async () => {
    const out = await render("cookies");
    expect(out.startsWith("# Netscape HTTP Cookie File")).toBe(true);

    const rows = out
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("\t"));
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) {
      expect(r, `row has ${r.length} fields, expected 7`).toHaveLength(7);
    }

    // A replayed jar only registers if the cookie's path matches the canary's.
    const bait = rows.find((r) => r[0] === "mantis.example.com");
    expect(bait, "no cookie for the trigger host").toBeTruthy();
    expect(bait![2]).toBe("/c/aBcD1234");
    expect(bait![3]).toBe("TRUE"); // https → secure flag set
  });

  it("looks lived-in rather than like a single planted line", async () => {
    const rows = (await render("cookies"))
      .split("\n")
      .filter((l) => l && !l.startsWith("#"));
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });
});

describe("bookmarks.html", () => {
  it("declares the Netscape bookmark doctype and beacons via ICON_URI", async () => {
    const out = await render("bookmarks");
    expect(out.startsWith("<!DOCTYPE NETSCAPE-Bookmark-file-1>")).toBe(true);
    expect(out).toContain(`HREF="${URL}"`);
    expect(out).toContain(`ICON_URI="${URL}"`);
  });

  it("escapes a hostile memo rather than injecting markup", async () => {
    const buf = await generateFile("bookmarks", {
      title: '<script>alert(1)</script>',
      url: URL,
    });
    const out = buf.toString("utf8");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("credential stores", () => {
  it("netrc keys on the bare host, which is what curl/git match on", async () => {
    const out = await render("netrc");
    expect(out).toMatch(/^machine mantis\.example\.com$/m);
  });

  it("aws credentials point a profile's endpoint_url at the canary", async () => {
    const out = await render("aws-credentials");
    expect(out).toContain(`endpoint_url = ${URL}`);
  });

  it("kubeconfig sets the bait as a cluster server", async () => {
    const out = await render("kubeconfig");
    expect(out).toContain(`server: ${URL}`);
  });

  it("carries no credential that could be mistaken for a live secret", async () => {
    // These files get committed by accident. Every fake secret must be a
    // published example value or obvious nonsense, never something that would
    // page a real secret-scanning team.
    const documented = [
      "AKIAIOSFODNN7EXAMPLE",
      "AKIAI44QH8DHBEXAMPLE",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY",
      "sk_live_4eC39HqLyjWDarjtT1zdp7dc", // Stripe's published test value
    ];
    for (const fmt of ["env", "aws-credentials"] as const) {
      const out = await render(fmt);
      for (const m of out.matchAll(/AKIA[0-9A-Z]{16}/g)) {
        expect(documented, `${fmt}: undocumented AWS key ${m[0]}`).toContain(
          m[0],
        );
      }
      for (const m of out.matchAll(/sk_live_[A-Za-z0-9]+/g)) {
        expect(documented, `${fmt}: undocumented Stripe key`).toContain(m[0]);
      }
    }
  });
});

describe("connection profiles", () => {
  it("ovpn keeps the bait as a profile-update URL and targets the host", async () => {
    const out = await render("ovpn");
    expect(out).toContain(URL);
    expect(out).toMatch(/^remote mantis\.example\.com 1194$/m);
  });

  it("rdp is CRLF-delimited with the bait in workspacefeedurl", async () => {
    const out = await render("rdp");
    expect(out).toContain("\r\n");
    expect(out).toContain(`workspacefeedurl:s:${URL}`);
    expect(out).toMatch(/^full address:s:mantis\.example\.com$/m);
  });
});

describe("rtf", () => {
  it("embeds an INCLUDEPICTURE field that re-fetches on every open", async () => {
    const out = await render("rtf");
    expect(out.startsWith("{\\rtf1")).toBe(true);
    expect(out).toContain("INCLUDEPICTURE");
    // \d means "don't cache" — without it a re-opened document goes quiet.
    expect(out).toContain("\\\\d");
    expect(out).toContain(URL);
  });

  it("escapes RTF control characters in an operator memo", async () => {
    const buf = await generateFile("rtf", {
      title: "brace { and backslash \\ and — dash",
      url: URL,
    });
    const out = buf.toString("utf8");
    expect(out).toContain("\\{");
    expect(out).toContain("\\\\ ");
    // Non-ASCII must become a \uN escape, or the reader shows mojibake.
    expect(out).not.toContain("—");
    expect(out).toMatch(/\\u\d+\?/);
  });
});

describe("default sample body", () => {
  it("does not tell the reader it is a placeholder", () => {
    // The old default said "Replace this placeholder text with the actual
    // content you want" — accurate as an instruction, fatal in a planted file.
    const joined = DEFAULT_BODY.join(" ").toLowerCase();
    for (const tell of ["placeholder", "replace this", "lorem ipsum"]) {
      expect(joined, `default body still says "${tell}"`).not.toContain(tell);
    }
    expect(joined.length).toBeGreaterThan(200);
  });
});
