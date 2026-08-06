import type { NotificationChannel } from "@/db/schema";

const SLACK_RE = /^https:\/\/hooks\.slack\.com\/services\//;
const DISCORD_RE =
  /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\//;
// Legacy Office 365 connectors. Microsoft retired these in May 2026 — kept
// only so existing destinations created before then keep validating.
const TEAMS_LEGACY_RE =
  /^https:\/\/(?:[a-z0-9-]+\.webhook\.office\.com\/webhookb2\/|outlook\.office\.com\/webhook\/)/i;
// The replacement: Power Automate "Workflows" (the `When a Teams webhook
// request is received` trigger), which issues URLs on Logic Apps hosts —
// prod-NN.<region>.logic.azure.com/workflows/… — plus the sovereign clouds
// and the newer Power Platform endpoints. Matched on HOST, not prefix,
// because the region/instance labels vary per tenant.
const TEAMS_WORKFLOW_HOST_RE =
  /(?:^|\.)(?:logic\.azure\.(?:com|us|cn|de)|powerplatform\.com)$/i;

function isTeamsTarget(target: string): boolean {
  if (TEAMS_LEGACY_RE.test(target)) return true;
  try {
    const u = new URL(target);
    return u.protocol === "https:" && TEAMS_WORKFLOW_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HA_WEBHOOK_PATH_RE = /^\/api\/webhook\/[A-Za-z0-9_-]+\/?$/;

/**
 * Validates a destination target against its declared channel. Returns
 * { ok: true } if the target is well-formed for the channel, or an error
 * message describing what's wrong.
 */
export function validateDestination(
  channel: NotificationChannel,
  target: string,
): { ok: true } | { ok: false; error: string } {
  if (!target || target.length === 0) {
    return { ok: false, error: "target is required" };
  }
  if (target.length > 2048) {
    return { ok: false, error: "target too long (max 2048)" };
  }

  switch (channel) {
    case "email":
      if (!EMAIL_RE.test(target)) {
        return { ok: false, error: "not a valid email address" };
      }
      return { ok: true };

    case "webhook":
      try {
        const u = new URL(target);
        if (u.protocol !== "https:" && u.protocol !== "http:") {
          return { ok: false, error: "webhook URL must be http(s)" };
        }
        return { ok: true };
      } catch {
        return { ok: false, error: "not a valid URL" };
      }

    case "slack":
      if (!SLACK_RE.test(target)) {
        return {
          ok: false,
          error: "Slack URL must start with https://hooks.slack.com/services/",
        };
      }
      return { ok: true };

    case "discord":
      if (!DISCORD_RE.test(target)) {
        return {
          ok: false,
          error:
            "Discord URL must start with https://discord.com/api/webhooks/ (or discordapp.com)",
        };
      }
      return { ok: true };

    case "teams":
      if (!isTeamsTarget(target)) {
        return {
          ok: false,
          error:
            "not a Teams webhook URL. In Teams use Workflows → " +
            '"Post to a channel when a webhook request is received", which ' +
            "gives you a https://…logic.azure.com/workflows/… URL. (The old " +
            "*.webhook.office.com connector URLs still validate, but Microsoft " +
            "retired them in May 2026.)",
        };
      }
      return { ok: true };

    case "home_assistant": {
      let u: URL;
      try {
        u = new URL(target);
      } catch {
        return { ok: false, error: "not a valid URL" };
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        return { ok: false, error: "Home Assistant URL must be http(s)" };
      }
      if (!HA_WEBHOOK_PATH_RE.test(u.pathname)) {
        return {
          ok: false,
          error: "Home Assistant URL must end with /api/webhook/<id>",
        };
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: `unknown channel: ${String(channel)}` };
  }
}

/**
 * Best-effort channel detection from a URL alone. Returns null if no known
 * platform matches — callers should fall back to "webhook" (or "email" for
 * an email-shaped target).
 */
export function detectChannelFromUrl(
  target: string,
): NotificationChannel | null {
  if (SLACK_RE.test(target)) return "slack";
  if (DISCORD_RE.test(target)) return "discord";
  if (isTeamsTarget(target)) return "teams";
  if (EMAIL_RE.test(target)) return "email";
  try {
    const u = new URL(target);
    if (HA_WEBHOOK_PATH_RE.test(u.pathname)) return "home_assistant";
    return "webhook";
  } catch {
    return null;
  }
}
