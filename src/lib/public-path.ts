const DEFAULT_PUBLIC_PATH = "/c";
// `/<publicId>` optionally followed by `/<anything>`, matched against whatever
// comes after the trigger prefix.
const TRIGGER_TAIL_RE = /^\/([A-Za-z0-9]{6,32})(\/.*)?$/;

/** Normalises MANTIS_PUBLIC_PATH: leading slash, no trailing slashes. */
export function normalizePublicPath(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  if (!v) return DEFAULT_PUBLIC_PATH;
  const withSlash = v.startsWith("/") ? v : `/${v}`;
  const stripped = withSlash.replace(/\/+$/, "");
  return stripped || DEFAULT_PUBLIC_PATH;
}

/**
 * The trigger handler lives at /c/[publicId] (and /c/[publicId]/[...rest] for
 * tools that append their own path to the bait URL). When MANTIS_PUBLIC_PATH
 * points somewhere else, minted URLs use that prefix, so the proxy must rewrite
 * `<prefix>/<id>` and `<prefix>/<id>/<anything>` onto the real routes — env is
 * runtime-only (the Docker image is built without it), which is why this isn't
 * a next.config rewrite. A trailing slash is dropped on the way (under /c as
 * well), so `<trigger URL>/` reaches the handler instead of a redirect that a
 * non-browser client won't follow.
 *
 * Only paths under a trigger prefix with a well-formed id are ever rewritten,
 * and always onto /c/… — which every host that may see the request is already
 * allowed to reach — so this can't widen the public-only host gate.
 * Returns the internal pathname to rewrite to, or null to leave the request
 * alone.
 */
export function publicPathRewrite(
  pathname: string,
  configuredPublicPath: string | null | undefined,
): string | null {
  const prefix = normalizePublicPath(configuredPublicPath);
  // The configured prefix first: it may itself sit under /c.
  let tail: string | null = null;
  if (prefix !== DEFAULT_PUBLIC_PATH && pathname.startsWith(`${prefix}/`)) {
    tail = pathname.slice(prefix.length);
  }
  let match = tail === null ? null : TRIGGER_TAIL_RE.exec(tail);
  if (!match && pathname.startsWith(`${DEFAULT_PUBLIC_PATH}/`)) {
    match = TRIGGER_TAIL_RE.exec(pathname.slice(DEFAULT_PUBLIC_PATH.length));
  }
  if (!match) return null;

  const appended = (match[2] ?? "").replace(/\/+$/, "");
  const target = `${DEFAULT_PUBLIC_PATH}/${match[1]}${appended}`;
  return target === pathname ? null : target;
}
