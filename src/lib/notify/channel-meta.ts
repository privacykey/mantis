/**
 * UI metadata for notification channels. Lives outside the client components
 * so the new-key form, the bulk form and the global settings page can't drift
 * apart on labels or placeholders — the Teams placeholder in particular was
 * showing a URL shape Microsoft retired in May 2026.
 */
export const CHANNEL_META = [
  {
    value: "webhook",
    label: "webhook (generic JSON)",
    placeholder: "https://example.com/hook",
    help: "Raw JSON POST, signed with X-Mantis-Signature.",
  },
  {
    value: "email",
    label: "email",
    placeholder: "alerts@example.com",
    help: "Requires SMTP_URL on the server.",
  },
  {
    value: "slack",
    label: "Slack",
    placeholder: "https://hooks.slack.com/services/T.../B.../...",
    help: "Slack incoming webhook.",
  },
  {
    value: "discord",
    label: "Discord",
    placeholder: "https://discord.com/api/webhooks/.../...",
    help: "Discord channel webhook.",
  },
  {
    value: "teams",
    label: "Microsoft Teams",
    placeholder: "https://prod-00.australiaeast.logic.azure.com/workflows/...",
    help:
      'Teams → Workflows → "Post to a channel when a webhook request is ' +
      'received". Office 365 connector URLs (*.webhook.office.com) still ' +
      "work but Microsoft retired them in May 2026.",
  },
  {
    value: "home_assistant",
    label: "Home Assistant",
    placeholder: "https://ha.example.com/api/webhook/<webhook_id>",
    help: "Posts to a Home Assistant webhook automation trigger.",
  },
] as const;

export type ChannelMeta = (typeof CHANNEL_META)[number];

export function channelMeta(value: string): ChannelMeta {
  return CHANNEL_META.find((c) => c.value === value) ?? CHANNEL_META[0];
}
