import { get } from "node:http";

// Probe locally, using the dashboard host when host separation is enabled.
// A plain loopback Host is intentionally denied by the public-only gate.
const dashboardHost = (process.env.DASHBOARD_HOSTS ?? "").trim().split(/[\s,]+/)[0];
const req = get({
  hostname: "127.0.0.1",
  port: process.env.PORT ?? 3000,
  path: "/api/health",
  headers: dashboardHost ? { Host: dashboardHost } : {},
  timeout: 4000,
}, (res) => {
  process.exitCode = res.statusCode === 200 ? 0 : 1;
  res.resume();
});
req.on("timeout", () => req.destroy(new Error("health check timed out")));
req.on("error", () => { process.exitCode = 1; });
