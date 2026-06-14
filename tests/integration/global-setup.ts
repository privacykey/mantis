import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Runs ONCE before the integration suite: applies the Drizzle migrations to the
// test database so the route handlers find the schema they expect. Idempotent —
// re-running against an already-migrated DB is a no-op (mirrors CI's
// `pnpm run db:migrate` step before the test job).
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || url.includes("@localhost/test")) {
    throw new Error(
      "Integration tests require a real DATABASE_URL (migrated test Postgres).",
    );
  }
  const sql = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(sql), { migrationsFolder: "src/db/migrations" });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
