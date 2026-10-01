import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const clear = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session", () => ({ clearSessionCookie: clear }));

import { POST } from "@/app/logout/route";

beforeEach(() => {
  clear.mockReset().mockResolvedValue(undefined);
});

describe("logout redirect", () => {
  it.each([
    ["HTTP upstream behind HTTPS", "http://127.0.0.1:3000/logout", { "x-forwarded-proto": "https", "x-forwarded-host": "dashboard.example.invalid" }],
    ["standalone internal origin", "https://0.0.0.0:3000/logout", { host: "localhost:3000", "x-forwarded-proto": "https" }],
    ["untrusted forwarded host", "http://localhost:3000/logout", { "x-forwarded-host": "foreign.example.invalid", forwarded: "host=foreign.example.invalid;proto=https" }],
  ] as const)("keeps the browser's dashboard origin with %s", async (_label, url, headers) => {
    const response = await POST(new NextRequest(url, { method: "POST", headers }));

    expect(clear).toHaveBeenCalledOnce();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    // The dashboard origin may differ from PUBLIC_BASE_URL's trigger origin.
    const browserPage = "https://dashboard.example.invalid/keys";
    expect(new URL(response.headers.get("location")!, browserPage).href)
      .toBe("https://dashboard.example.invalid/login");
  });

  it("does not return the redirect until session revocation completes", async () => {
    let revoke!: () => void;
    clear.mockReturnValue(new Promise<void>((resolve) => { revoke = resolve; }));
    let returned = false;
    const pending = POST(new NextRequest("http://localhost:3000/logout", { method: "POST" }))
      .then((response) => { returned = true; return response; });
    await Promise.resolve();
    expect(returned).toBe(false);
    revoke();
    expect((await pending).status).toBe(303);
  });

  it("does not claim successful logout if session revocation fails", async () => {
    clear.mockRejectedValue(new Error("session store unavailable"));
    await expect(POST(new NextRequest("http://localhost:3000/logout", { method: "POST" })))
      .rejects.toThrow("session store unavailable");
  });
});
