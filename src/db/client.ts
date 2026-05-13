import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and configure it.",
  );
}

const globalForDb = globalThis as unknown as {
  _mantisSql?: ReturnType<typeof postgres>;
};

const sql =
  globalForDb._mantisSql ??
  postgres(url, {
    max: process.env.VERCEL ? 1 : 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb._mantisSql = sql;
}

export const db = drizzle(sql, { schema });
export { schema };
