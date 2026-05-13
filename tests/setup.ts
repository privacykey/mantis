// Test setup: provide required env vars before any module is imported.
// Lets us exercise modules that read process.env at import time (env.ts).
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost/test";
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
