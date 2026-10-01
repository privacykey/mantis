/** Nodemailer parses URL query options; sibling object options are discarded. */
export function boundedSmtpUrl(raw: string): string {
  const url = new URL(raw);
  for (const [name, bound] of [["connectionTimeout", 10_000], ["greetingTimeout", 10_000], ["socketTimeout", 15_000]] as const) {
    const configured = Number(url.searchParams.get(name));
    url.searchParams.set(name, String(configured > 0 && Number.isFinite(configured) ? Math.min(configured, bound) : bound));
  }
  return url.toString();
}
