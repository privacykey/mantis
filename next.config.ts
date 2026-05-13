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

const config: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["postgres"],
  async headers() {
    return [
      // /c/* sets its own CSP (may serve operator-supplied HTML).
      { source: "/((?!c/).*)", headers: COMMON_HEADERS },
      // Drop X-Frame-Options on the public trigger; the canary URL is
      // sometimes embedded as a CSS background or <img>.
      {
        source: "/c/:publicId",
        headers: COMMON_HEADERS.filter((h) => h.key !== "X-Frame-Options"),
      },
    ];
  },
};

export default config;
