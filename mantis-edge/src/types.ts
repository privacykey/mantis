export type ResponseKind = "gif" | "empty" | "json" | "redirect" | "html";

export const RESPONSE_KINDS: ResponseKind[] = [
  "gif",
  "empty",
  "json",
  "redirect",
  "html",
];

export type Payload = {
  /** Webhook URL the worker POSTs to on hit. */
  w: string;
  /** Response kind to return to the client. Defaults to "gif". */
  r?: ResponseKind;
  /** Response payload (used by json / redirect / html). */
  p?: unknown;
  /** Memo, forwarded to the webhook for context. */
  m?: string;
  /** Optional unix timestamp (seconds) after which the URL stops working. */
  exp?: number;
};

export interface Env {
  MANTIS_EDGE_KEY: string;
  /** Optional comma-separated webhook host allowlist. Supports exact hosts and *.example.com wildcards. */
  MANTIS_EDGE_WEBHOOK_ALLOWLIST?: string;
}
