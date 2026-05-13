const MAX_CAPTURES = 100;
const MAX_BODY_BYTES = 64 * 1024;

export type Capture = {
  id: number;
  captured_at: string;
  method: string;
  slug: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  body_truncated: boolean;
};

const buffer: Capture[] = [];
let counter = 0;

// Opt-in via ENABLE_DEV_INBOX=1. Captures arbitrary unauthenticated request
// bodies into an in-memory ring buffer — never run with this on in prod.
export function isEnabled(): boolean {
  return process.env.ENABLE_DEV_INBOX === "1";
}

export function pushCapture(input: Omit<Capture, "id" | "captured_at">): Capture {
  const cap: Capture = {
    ...input,
    id: ++counter,
    captured_at: new Date().toISOString(),
  };
  buffer.unshift(cap);
  if (buffer.length > MAX_CAPTURES) buffer.length = MAX_CAPTURES;
  return cap;
}

export function listCaptures(slug?: string): Capture[] {
  if (!slug) return [...buffer];
  return buffer.filter((c) => c.slug === slug);
}

export function clearCaptures(): void {
  buffer.length = 0;
}

export function truncateBody(text: string): { body: string; truncated: boolean } {
  if (text.length <= MAX_BODY_BYTES) return { body: text, truncated: false };
  return { body: text.slice(0, MAX_BODY_BYTES), truncated: true };
}
