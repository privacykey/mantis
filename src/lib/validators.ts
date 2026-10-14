import { z } from "zod";
import {
  apiKeyScopes,
  monitorModes,
  notificationChannels,
  responseKinds,
} from "@/db/schema";

const responseKindSchema = z.enum(responseKinds);
const monitorModeSchema = z.enum(monitorModes);
const channelSchema = z.enum(notificationChannels);

// z.url() accepts any URL `new URL()` parses, including `javascript:`,
// `data:`, `file:`, etc. We only allow plain http(s) where a URL is going to
// be served back as a redirect target or fetched as a webhook destination.
function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
const httpUrl = z
  .string()
  .max(2048)
  .refine(isHttpUrl, { message: "must be a http(s) URL" });

// Memos and destination targets are rendered in other principals' terminals,
// alerts and audit views, and never need control characters (C0, DEL, C1).
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/;
const controlFree = { message: "must not contain control characters" };

export function hasControlChars(s: string): boolean {
  return CONTROL_CHARS_RE.test(s);
}

const memoSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((s) => !hasControlChars(s), controlFree);

const responsePayloadSchema = z
  .union([
    z.object({ url: httpUrl }).strict(),
    z.object({ html: z.string().max(64 * 1024) }).strict(),
    z.record(z.string(), z.unknown()),
  ])
  .nullable()
  .optional();

// Webhook-shaped channels carry a URL target; email carries an address.
const destinationInputSchema = z
  .object({
    channel: channelSchema,
    target: z
      .string()
      .min(1)
      .max(2048)
      .refine((s) => !hasControlChars(s), controlFree),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.channel === "email") {
      if (!z.email().safeParse(d.target).success) {
        ctx.addIssue({
          code: "custom",
          path: ["target"],
          message: "email target must be a valid email address",
        });
      }
      return;
    }
    if (!isHttpUrl(d.target)) {
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: `${d.channel} target must be a http(s) URL`,
      });
    }
  });

const destinationsArraySchema = z.array(destinationInputSchema).max(50);

// Stable machine identity for idempotent enrollment (MDM serials, hostnames,
// asset tags). Charset is tight because the value round-trips through audit
// logs, shell scripts, and memos.
const externalIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, {
    message:
      "must start with a letter/digit and contain only letters, digits, . _ : -",
  });

/**
 * Normalise an operator-supplied site origin to URL.origin form (http/https,
 * lower-case host, no path, default port dropped). The hit recorder compares
 * these as exact strings, so storing anything else would silently disable the
 * exclusion. Returns null when the value is not an http(s) URL.
 */
export function normalizeSelfOrigin(value: string): string | null {
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

export const MAX_SELF_ORIGINS = 20;

// Own-site origins for web canaries (see keys.selfOrigins).
const selfOriginsSchema = z
  .array(
    z
      .string()
      .max(2048)
      .refine((s) => normalizeSelfOrigin(s) !== null, {
        message: "must be a http(s) origin such as https://www.example.com",
      })
      .transform((s) => normalizeSelfOrigin(s)!),
  )
  .max(MAX_SELF_ORIGINS)
  .transform((origins) => [...new Set(origins)]);

export const createKeySchema = z
  .object({
    memo: memoSchema,
    external_id: externalIdSchema.optional(),
    response_kind: responseKindSchema.optional(),
    response_payload: responsePayloadSchema,
    destinations: destinationsArraySchema.optional(),
    // A key that is already expired never fires. Minting one is only useful
    // for planting a dead tripwire under someone else's external_id.
    expires_at: z.iso
      .datetime()
      .refine((v) => Date.parse(v) > Date.now(), {
        message: "expires_at must be in the future",
      })
      .nullable()
      .optional(),
    dedupe_window_seconds: z.number().int().min(0).max(86_400).optional(),
    monitor_mode: monitorModeSchema.optional(),
    monitor_window_seconds: z.number().int().min(30).max(86_400).optional(),
    self_origins: selfOriginsSchema.optional(),
    // Admin only: adopt an existing external_id that another fleet created.
    adopt: z.boolean().optional(),
  })
  .strict();

export const updateKeySchema = z
  .object({
    memo: memoSchema.optional(),
    response_kind: responseKindSchema.optional(),
    response_payload: responsePayloadSchema,
    destinations: destinationsArraySchema.optional(),
    expires_at: z.iso.datetime().nullable().optional(),
    dedupe_window_seconds: z.number().int().min(0).max(86_400).optional(),
    monitor_mode: monitorModeSchema.optional(),
    monitor_window_seconds: z.number().int().min(30).max(86_400).optional(),
    self_origins: selfOriginsSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

export const createApiKeySchema = z
  .object({
    name: z.string().min(1).max(100),
    // Admin keys see all data and can manage other API keys. Only an existing
    // admin can mint another admin key. Defaults to false (least privilege).
    is_admin: z.boolean().optional(),
    // "enroll" mints a create-only key for fleet provisioning (see
    // src/db/schema.ts apiKeys.scope). Defaults to "full".
    scope: z.enum(apiKeyScopes).optional(),
    // Enroll keys only: the full key whose fleet this credential enrolls for
    // (see apiKeys.ownerApiKeyId). Defaults to the minting admin.
    owner_api_key_id: z.uuid().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.is_admin && v.scope === "enroll") {
      ctx.addIssue({
        code: "custom",
        path: ["scope"],
        message: "an enrollment-scoped key cannot also be admin",
      });
    }
    if (v.owner_api_key_id !== undefined && v.scope !== "enroll") {
      ctx.addIssue({
        code: "custom",
        path: ["owner_api_key_id"],
        message: "owner_api_key_id only applies to enrollment-scoped keys",
      });
    }
  });

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export type CreateKeyInput = z.infer<typeof createKeySchema>;
export type UpdateKeyInput = z.infer<typeof updateKeySchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type DestinationInputZ = z.infer<typeof destinationInputSchema>;
