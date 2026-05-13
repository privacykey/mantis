import { db } from "@/db/client";
import { auditEvents, type NewAuditEvent } from "@/db/schema";
import { log } from "@/lib/log";

export type AuditEventType =
  | "session.login"
  | "session.logout"
  | "api_key.created"
  | "api_key.revoked"
  | "key.created"
  | "key.updated"
  | "key.deleted"
  | "key.disabled"
  | "key.enabled"
  | "destinations.replaced"
  | "destination.secret_revealed"
  | "wallet_config.saved"
  | "wallet_config.cleared"
  | "monitor.reset";

export type AuditInput = {
  type: AuditEventType;
  actorApiKeyId?: string | null;
  actorLabel?: string | null;
  subjectKind?: string | null;
  subjectId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
};

/** Best-effort audit insert. Never throws — failures are logged at warn. */
export async function audit(input: AuditInput): Promise<void> {
  try {
    const row: NewAuditEvent = {
      eventType: input.type,
      actorApiKeyId: input.actorApiKeyId ?? null,
      actorLabel: input.actorLabel ?? null,
      subjectKind: input.subjectKind ?? null,
      subjectId: input.subjectId ?? null,
      metadata: (input.metadata ?? null) as object | null,
      ip: input.ip ?? null,
    };
    await db.insert(auditEvents).values(row);
  } catch (err) {
    log.warn({ err, type: input.type }, "audit log write failed");
  }
}
