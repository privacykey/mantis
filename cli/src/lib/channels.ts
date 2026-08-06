import type { NotificationChannel } from "./api.js";

/**
 * Single source of truth for notification channels in the CLI.
 *
 * This list was previously duplicated across new / bulk-create / destinations /
 * completion and the commander `.choices()` in index.ts, and the copies drifted:
 * `home_assistant` shipped in the server schema, the senders and the CLI's own
 * `NotificationChannel` type, but four of the five copies omitted it — so
 * `mantis new --dest home_assistant:…` was rejected for a channel the server
 * fully supports. Import from here rather than re-declaring.
 *
 * Must stay in sync with `notificationChannelEnum` in src/db/schema.ts.
 */
export const ALL_CHANNELS: NotificationChannel[] = [
  "webhook",
  "email",
  "slack",
  "discord",
  "teams",
  "home_assistant",
];

/**
 * Channels the stateless edge worker can format a payload for
 * (mantis-edge/src/forward.ts). Deliberately NARROWER than ALL_CHANNELS: the
 * worker has no SMTP and no Home Assistant formatter, so offering those in
 * `mantis edge mint` would mint URLs whose notifications silently never render.
 */
export const EDGE_CHANNELS = [
  "webhook",
  "slack",
  "discord",
  "teams",
] as const;

export type EdgeChannel = (typeof EDGE_CHANNELS)[number];
