import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { buildInstaller } from "@mantis/core/installers";

// The clone detector compares window.location.hostname with the "expected
// hostname" the operator typed. location.hostname is always lowercase with no
// scheme, port, path or trailing dot, so anything else in the expected value
// would never match — and the detector would fire on the operator's own site.

const base = {
  url: "https://mantis.example.com/c/AbCdEf2345",
  keyId: "00000000-0000-0000-0000-000000000000",
  memo: "m",
};

function expectedIn(content: string): string {
  const m = content.match(/var expected = (".*");/);
  expect(m, "no `var expected = …;` in the snippet").toBeTruthy();
  return JSON.parse(m![1]!) as string;
}

/** Run the generated snippet as a page on `hostname`; return what it requested. */
function runOn(content: string, hostname: string): string[] {
  const requested: string[] = [];
  class FakeImage {
    set src(v: string) {
      requested.push(v);
    }
  }
  runInNewContext(content, {
    window: {
      location: { hostname, href: `https://${hostname}/login?next=%2F` },
    },
    document: { referrer: "" },
    Image: FakeImage,
    encodeURIComponent,
  });
  return requested;
}

describe("js-clone-detector expected hostname", () => {
  it.each([
    "own-site.test",
    "Own-Site.test",
    "  own-site.test  ",
    "own-site.test.",
    "https://own-site.test",
    "https://own-site.test/",
    "HTTPS://Own-Site.Test:8443/path?x=1#frag",
    "//own-site.test/",
    "own-site.test:443",
    "own-site.test/some/page",
    "https://user:pw@own-site.test/",
  ])("normalises %j to the bare lowercase hostname", (hostname) => {
    const out = buildInstaller("js-clone-detector", { ...base, hostname });
    expect(expectedIn(out.content)).toBe("own-site.test");
    expect(out.content).toContain("Expected hostname: own-site.test\n");
    expect(out.notes).toContain('neither "own-site.test" nor a subdomain');

    // Stays silent on the operator's own site, however the visitor spelled it…
    for (const own of [
      "own-site.test",
      "OWN-SITE.test",
      "www.own-site.test",
      "own-site.test.",
    ]) {
      expect(runOn(out.content, own), `fired on ${own}`).toEqual([]);
    }
    // …and still fires on a clone, including a look-alike suffix.
    for (const clone of ["evil.test", "own-site.test.evil.test", "notown-site.test"]) {
      const hits = runOn(out.content, clone);
      expect(hits, `did not fire on ${clone}`).toHaveLength(1);
      expect(hits[0]).toMatch(/^https:\/\/mantis\.example\.com\/c\/AbCdEf2345\?l=/);
    }
  });

  it("keeps the brackets of an IPv6 literal and drops its port", () => {
    const out = buildInstaller("js-clone-detector", {
      ...base,
      hostname: "http://[2001:DB8::1]:8080/",
    });
    expect(expectedIn(out.content)).toBe("[2001:db8::1]");
    expect(runOn(out.content, "[2001:db8::1]")).toEqual([]);
  });

  it("still warns, and fires everywhere, when no hostname is given", () => {
    for (const hostname of [undefined, "", "   ", "https://"]) {
      const out = buildInstaller("js-clone-detector", { ...base, hostname });
      expect(expectedIn(out.content)).toBe("");
      expect(out.notes).toMatch(/fire on ALL hostnames/);
      expect(runOn(out.content, "own-site.test")).toHaveLength(1);
    }
  });
});
