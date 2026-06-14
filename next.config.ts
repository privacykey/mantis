import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Common security headers. HSTS only in prod — dev runs on plain localhost.
const COMMON_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  ...(isProd
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains",
        },
      ]
    : []),
];

// Defence-in-depth CSP for the dashboard / management surface (NOT /c, which
// sets its own per-response CSP for operator-supplied HTML). 'unsafe-inline' is
// required for Next.js's hydration scripts/styles; we still block external
// script/object/base/form targets and framing. Applied only in production —
// `next dev` needs 'unsafe-eval' + ws: for HMR, so we skip it there.
const DASHBOARD_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join("; ");

const DASHBOARD_HEADERS = isProd
  ? [...COMMON_HEADERS, { key: "Content-Security-Policy", value: DASHBOARD_CSP }]
  : COMMON_HEADERS;

const config: NextConfig = {
  output: "standalone",
  // Don't advertise the framework/version on every response.
  poweredByHeader: false,
  serverExternalPackages: ["postgres"],
  async headers() {
    return [
      // Everything except /c/* gets the dashboard headers (incl. CSP in prod).
      { source: "/((?!c/).*)", headers: DASHBOARD_HEADERS },
      // Drop X-Frame-Options on the public trigger; the canary URL is
      // sometimes embedded as a CSS background or <img>. /c sets its own CSP.
      {
        source: "/c/:publicId",
        headers: COMMON_HEADERS.filter((h) => h.key !== "X-Frame-Options"),
      },
    ];
  },
};

export default config;
