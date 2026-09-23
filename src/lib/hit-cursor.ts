const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeHitCursor(at: string, id: string): string {
  return `${at}~${id}`;
}

export function parseHitCursor(raw: string): { at: string; id: string | null } | null {
  const separator = raw.indexOf("~");
  const dateRaw = separator < 0 ? raw : raw.slice(0, separator);
  const id = separator < 0 ? null : raw.slice(separator + 1);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(dateRaw) ||
      Number.isNaN(Date.parse(dateRaw)) ||
      (id !== null && !UUID_RE.test(id))) return null;
  return { at: dateRaw, id };
}
