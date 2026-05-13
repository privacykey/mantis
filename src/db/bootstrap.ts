import { count } from "drizzle-orm";
import { db } from "./client";
import { apiKeys } from "./schema";
import { env } from "@/lib/env";
import { hashApiKey, isWellFormedApiKey, mintApiKey } from "@/lib/api-keys";
import { log } from "@/lib/log";

let bootstrapped = false;

export async function bootstrapIfEmpty(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;

  const [row] = await db.select({ n: count() }).from(apiKeys);
  if ((row?.n ?? 0) > 0) return;

  if (env.bootstrapApiKey) {
    if (!isWellFormedApiKey(env.bootstrapApiKey)) {
      log.error("BOOTSTRAP_API_KEY is set but malformed; refusing to seed");
      return;
    }
    await db.insert(apiKeys).values({
      name: "bootstrap",
      prefix: env.bootstrapApiKey.slice(0, 18),
      hash: hashApiKey(env.bootstrapApiKey),
      isAdmin: true,
    });
    log.info("seeded bootstrap admin key from BOOTSTRAP_API_KEY");
    return;
  }

  const minted = mintApiKey();
  await db.insert(apiKeys).values({
    name: "bootstrap",
    prefix: minted.prefix,
    hash: minted.hash,
    isAdmin: true,
  });

  // Structured log carries the prefix only; plaintext is in the stdout banner.
  log.warn(
    { prefix: minted.prefix },
    "no api_keys found; minted a bootstrap admin key. See stdout banner for plaintext (printed only on first boot).",
  );

  console.log("\n========================================");
  console.log("  Mantis bootstrap API key (save this!)");
  console.log("  " + minted.plaintext);
  console.log("========================================\n");
}
