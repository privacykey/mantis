import { describe, expect, it } from "vitest";
import {
  env,
  keyDashboardUrl,
  keyUrl,
  resolveDashboardBaseUrl,
  statusPublicId,
  statusTag,
  statusUrl,
} from "@/lib/env";

describe("resolveDashboardBaseUrl", () => {
  it("uses PUBLIC_BASE_URL on a single-host deployment", () => {
    expect(resolveDashboardBaseUrl({ publicBaseUrl: "https://mantis.example.com" })).toBe(
      "https://mantis.example.com",
    );
  });

  it("prefers an explicit DASHBOARD_BASE_URL and trims its trailing slash", () => {
    expect(
      resolveDashboardBaseUrl({
        dashboardBaseUrl: " https://admin.example.com:8443/ ",
        publicBaseUrl: "https://canary.example.com",
        publicOnlyHosts: "canary.example.com",
        dashboardHosts: "other.example.com",
      }),
    ).toBe("https://admin.example.com:8443");
  });

  // With the host split, /keys on the public-only host is a 404: a dashboard
  // link built on PUBLIC_BASE_URL would not open.
  it("falls back to the first DASHBOARD_HOSTS entry when PUBLIC_BASE_URL is public-only", () => {
    expect(
      resolveDashboardBaseUrl({
        publicBaseUrl: "https://mantis-public.tailnet.ts.net",
        publicOnlyHosts: "mantis-public.tailnet.ts.net",
        dashboardHosts: "mantis-private.tailnet.ts.net, second.example.com",
      }),
    ).toBe("https://mantis-private.tailnet.ts.net");
  });

  it("keeps PUBLIC_BASE_URL's scheme and port for a bare dashboard host", () => {
    expect(
      resolveDashboardBaseUrl({
        publicBaseUrl: "http://public.mantis.test:3891",
        publicOnlyHosts: "public.mantis.test",
        dashboardHosts: "dash.mantis.test",
      }),
    ).toBe("http://dash.mantis.test:3891");
    // ...unless the entry names its own.
    expect(
      resolveDashboardBaseUrl({
        publicBaseUrl: "http://public.mantis.test:3891",
        publicOnlyHosts: "public.mantis.test",
        dashboardHosts: "dash.mantis.test:4000",
      }),
    ).toBe("http://dash.mantis.test:4000");
  });

  it("treats an unlisted PUBLIC_BASE_URL host as public-only too (fail-closed split)", () => {
    expect(
      resolveDashboardBaseUrl({
        publicBaseUrl: "https://canary.example.com",
        publicOnlyHosts: "other-public.example.com",
        dashboardHosts: "admin.example.com",
      }),
    ).toBe("https://admin.example.com");
  });

  it("keeps PUBLIC_BASE_URL when it is itself a dashboard host", () => {
    expect(
      resolveDashboardBaseUrl({
        publicBaseUrl: "https://mantis.example.com",
        publicOnlyHosts: "canary.example.com",
        dashboardHosts: "mantis.example.com",
      }),
    ).toBe("https://mantis.example.com");
  });

  it("has nothing better than PUBLIC_BASE_URL when no dashboard host is configured", () => {
    expect(
      resolveDashboardBaseUrl({
        publicBaseUrl: "https://canary.example.com",
        publicOnlyHosts: "canary.example.com",
      }),
    ).toBe("https://canary.example.com");
  });
});

describe("key URLs", () => {
  it("keyDashboardUrl points at the dashboard key page, keyUrl at the trigger", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(keyDashboardUrl(id)).toBe(`${env.dashboardBaseUrl}/keys/${id}`);
    expect(keyUrl("AbCdEf1234")).toBe(`${env.publicBaseUrl}/c/AbCdEf1234`);
    expect(keyDashboardUrl(id)).not.toContain("/c/");
  });
});

describe("status capability", () => {
  it("statusUrl is /status/<publicId>.<tag>", () => {
    expect(statusUrl("AbCdEf1234")).toBe(
      `${env.publicBaseUrl}/status/AbCdEf1234.${statusTag("AbCdEf1234")}`,
    );
  });

  it("the tag is 22 base64url characters, stable per id and different across ids", () => {
    expect(statusTag("AbCdEf1234")).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(statusTag("AbCdEf1234")).toBe(statusTag("AbCdEf1234"));
    expect(statusTag("AbCdEf1234")).not.toBe(statusTag("AbCdEf1235"));
  });

  it("statusPublicId accepts only the id with its own tag", () => {
    const tag = statusTag("AbCdEf1234");
    expect(statusPublicId(`AbCdEf1234.${tag}`)).toBe("AbCdEf1234");
    for (const token of [
      "AbCdEf1234", // the bait id alone
      "AbCdEf1234.",
      `AbCdEf1234.${statusTag("AbCdEf1235")}`, // another key's tag
      `AbCdEf1235.${tag}`,
      `AbCdEf1234.${tag}x`,
      `AbCdEf1234.${tag.slice(0, 21)}`,
      `AbCdEf1234.${tag}.${tag}`,
      `.${tag}`,
      "",
    ]) {
      expect(statusPublicId(token), token).toBeNull();
    }
  });
});
