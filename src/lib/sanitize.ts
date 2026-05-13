/** Collapses CR/LF/control bytes for safe drop-in to line-oriented fields (email headers, log lines). */
export function sanitizeHeaderValue(s: string, maxLen = 500): string {
  return s.replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ").trim().slice(0, maxLen);
}
