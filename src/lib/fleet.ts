import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { apiKeys, type ApiKey } from "@/db/schema";

/**
 * Fleet lineage for external_id claims (POST /api/keys).
 *
 * external_id values are guessable (serials, hostnames) and unique across the
 * whole instance, so whoever creates one first decides which key every later
 * claim resolves to. A claim may therefore only adopt a row from the
 * claimer's own fleet:
 *
 *   - admins, the enroll keys they own, and rows with no recorded creator
 *     form one fleet (the instance operators);
 *   - a non-admin full key and the enroll keys bound to it (ownerApiKeyId)
 *     form their own fleet.
 *
 * Minting API keys is admin-only, so an enroll key with no recorded owner
 * (minted before the column existed) belongs to the operators.
 */
const OPERATORS = "operators";

type Lineage = Pick<ApiKey, "id" | "isAdmin" | "scope" | "ownerApiKeyId">;

async function loadLineage(id: string): Promise<Lineage | null> {
  const [row] = await db
    .select({
      id: apiKeys.id,
      isAdmin: apiKeys.isAdmin,
      scope: apiKeys.scope,
      ownerApiKeyId: apiKeys.ownerApiKeyId,
    })
    .from(apiKeys)
    .where(eq(apiKeys.id, id))
    .limit(1);
  return row ?? null;
}

async function fleetOf(key: Lineage): Promise<string> {
  if (key.isAdmin) return OPERATORS;
  if (key.scope !== "enroll") return key.id;
  if (!key.ownerApiKeyId) return OPERATORS;
  const owner = await loadLineage(key.ownerApiKeyId);
  if (!owner) return key.id;
  return owner.isAdmin ? OPERATORS : owner.id;
}

/** True when `caller` and the API key that created a row share a fleet. */
export async function sameFleet(
  caller: ApiKey,
  creatorApiKeyId: string | null,
): Promise<boolean> {
  if (creatorApiKeyId === caller.id) return true;
  const callerFleet = await fleetOf(caller);
  if (creatorApiKeyId === null) return callerFleet === OPERATORS;
  const creator = await loadLineage(creatorApiKeyId);
  if (!creator) return false;
  return callerFleet === (await fleetOf(creator));
}

/** True when the API key that created a row is enrollment-scoped. */
export async function isEnrollKey(apiKeyId: string | null): Promise<boolean> {
  if (apiKeyId === null) return false;
  return (await loadLineage(apiKeyId))?.scope === "enroll";
}
