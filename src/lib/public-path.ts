const DEFAULT_PUBLIC_PATH = "/c";
const PUBLIC_ID_RE = /^[A-Za-z0-9]{6,32}$/;

/** Normalises MANTIS_PUBLIC_PATH: leading slash, no trailing slashes. */
export function normalizePublicPath(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  if (!v) return DEFAULT_PUBLIC_PATH;
  const withSlash = v.startsWith("/") ? v : `/${v}`;
  const stripped = withSlash.replace(/\/+$/, "");
  return stripped || DEFAULT_PUBLIC_PATH;
}

/**
 * The trigger handler lives at /c/[publicId]. When MANTIS_PUBLIC_PATH points
 * somewhere else, minted URLs use that prefix, so the proxy must rewrite
 * `<prefix>/<id>` onto the real route — env is runtime-only (the Docker image
 * is built without it), which is why this isn't a next.config rewrite.
 * Returns the internal pathname to rewrite to, or null to leave the request
 * alone.
 */
export function publicPathRewrite(
  pathname: string,
  configuredPublicPath: string | null | undefined,
): string | null {
  const prefix = normalizePublicPath(configuredPublicPath);
  if (prefix === DEFAULT_PUBLIC_PATH) return null;
  if (!pathname.startsWith(`${prefix}/`)) return null;
  const id = pathname.slice(prefix.length + 1);
  if (!PUBLIC_ID_RE.test(id)) return null;
  return `${DEFAULT_PUBLIC_PATH}/${id}`;
}
