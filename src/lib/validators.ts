import { z } from "zod";
import {
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
    target: z.string().min(1).max(2048),
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

export const createKeySchema = z
  .object({
    memo: z.string().min(1).max(500),
    response_kind: responseKindSchema.optional(),
    response_payload: responsePayloadSchema,
    destinations: destinationsArraySchema.optional(),
    expires_at: z.iso.datetime().nullable().optional(),
    dedupe_window_seconds: z.number().int().min(0).max(86_400).optional(),
    monitor_mode: monitorModeSchema.optional(),
    monitor_window_seconds: z.number().int().min(30).max(86_400).optional(),
  })
  .strict();

export const updateKeySchema = z
  .object({
    memo: z.string().min(1).max(500).optional(),
    response_kind: responseKindSchema.optional(),
    response_payload: responsePayloadSchema,
    destinations: destinationsArraySchema.optional(),
    expires_at: z.iso.datetime().nullable().optional(),
    dedupe_window_seconds: z.number().int().min(0).max(86_400).optional(),
    monitor_mode: monitorModeSchema.optional(),
    monitor_window_seconds: z.number().int().min(30).max(86_400).optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

export const createApiKeySchema = z
  .object({
    name: z.string().min(1).max(100),
    // Admin keys see all data and can manage other API keys. Only an existing
    // admin can mint another admin key. Defaults to false (least privilege).
    is_admin: z.boolean().optional(),
  })
  .strict();

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export type CreateKeyInput = z.infer<typeof createKeySchema>;
export type UpdateKeyInput = z.infer<typeof updateKeySchema>;
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type DestinationInputZ = z.infer<typeof destinationInputSchema>;
