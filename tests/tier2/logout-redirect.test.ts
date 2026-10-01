import { describe, expect, it } from "vitest";
import { DASHBOARD_HOST, rawRequest } from "./_client";

describe("logout redirect behind the production proxy", () => {
  it("keeps the browser on its HTTPS dashboard origin instead of the standalone host", async () => {
    const response = await rawRequest("/logout", {
      method: "POST",
      host: DASHBOARD_HOST,
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": DASHBOARD_HOST,
        origin: `https://${DASHBOARD_HOST}`,
      },
    });

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe("/login");
    expect(new URL(response.headers.location as string, `https://${DASHBOARD_HOST}/keys`).href)
      .toBe(`https://${DASHBOARD_HOST}/login`);
  });
});
