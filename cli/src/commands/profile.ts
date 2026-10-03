import {
  getKey,
  listProfiles,
  patchProfile,
  removeProfile,
  useProfile,
} from "../lib/config.js";
import { c, emit, fail, safeText } from "../lib/out.js";

export async function profileListCmd(): Promise<void> {
  const { current, profiles } = await listProfiles();
  emit(
    () => {
      if (profiles.length === 0) {
        process.stderr.write(
          `${c.dim("no profiles configured. Run `mantis login` to create one.")}\n`,
        );
        return;
      }
      const w = process.stdout.write.bind(process.stdout);
      for (const { name, entry } of profiles) {
        const marker = name === current ? c.green("* ") : "  ";
        w(`${marker}${c.bold(safeText(name).padEnd(16))} ${c.cyan(safeText(entry.baseUrl))}\n`);
        if (entry.keyPrefix) {
          w(`    ${c.dim("key:  ")} ${safeText(entry.keyPrefix)}…\n`);
        }
        if (entry.cloudflareAccessMode) {
          w(
            `    ${c.dim("cf:   ")} ${safeText(entry.cloudflareAccessMode)}${
              entry.cloudflareAccessAppUrl
                ? c.dim(` (${safeText(entry.cloudflareAccessAppUrl)})`)
                : ""
            }\n`,
          );
        }
        if (entry.edgeWorkerUrl) {
          w(`    ${c.dim("edge: ")} ${safeText(entry.edgeWorkerUrl)}\n`);
        }
      }
    },
    {
      current,
      profiles: profiles.map(({ name, entry }) => ({
        name,
        is_current: name === current,
        base_url: entry.baseUrl,
        key_prefix: entry.keyPrefix ?? null,
        cloudflare_mode: entry.cloudflareAccessMode ?? null,
        cloudflare_app_url: entry.cloudflareAccessAppUrl ?? null,
        edge_worker_url: entry.edgeWorkerUrl ?? null,
      })),
    },
  );
}

export async function profileCurrentCmd(): Promise<void> {
  const { current } = await listProfiles();
  if (!current) return fail("no profiles configured");
  emit(
    () => {
      process.stdout.write(`${safeText(current)}\n`);
    },
    { current },
  );
}

export async function profileUseCmd(name: string): Promise<void> {
  try {
    await useProfile(name);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  process.stderr.write(`${c.green("✓")} switched to profile ${c.bold(safeText(name))}\n`);
}

export async function profileRmCmd(
  name: string,
  opts: { yes?: boolean } = {},
): Promise<void> {
  if (!opts.yes) {
    process.stderr.write(
      c.red(`refusing to delete profile '${name}' without --yes\n`),
    );
    return fail("aborted");
  }
  const result = await removeProfile(name);
  if (!result.removed) {
    return fail(`profile '${name}' not found`);
  }
  const tail = result.wasCurrent
    ? result.newCurrent
      ? c.dim(` (current → ${safeText(result.newCurrent)})`)
      : c.dim(" (was current; no profiles remain)")
    : "";
  process.stderr.write(
    `${c.green("✓")} removed profile ${c.bold(safeText(name))}${tail}${result.credentialsRetained ? c.dim(" (shared server credentials retained)") : ""}\n`,
  );
}

export async function profileSetEdgeCmd(
  name: string,
  opts: { worker?: string; clear?: boolean } = {},
): Promise<void> {
  if (opts.clear) {
    try {
      const updated = await patchProfile(name, { edgeWorkerUrl: undefined });
      process.stderr.write(
        `${c.green("✓")} cleared default edge worker for ${c.bold(safeText(name))} ${c.dim(`(was: ${safeText(updated.edgeWorkerUrl ?? "—")})`)}\n`,
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (!opts.worker || !/^https?:\/\//.test(opts.worker)) {
    return fail(
      "--worker <url> is required (or pass --clear to unset)",
    );
  }
  const worker = opts.worker.replace(/\/$/, "");
  try {
    await patchProfile(name, { edgeWorkerUrl: worker });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  process.stderr.write(
    `${c.green("✓")} profile ${c.bold(safeText(name))} default edge worker → ${c.cyan(safeText(worker))}\n`,
  );
}

export async function profileShowCmd(name?: string): Promise<void> {
  const { current, profiles } = await listProfiles();
  const target = name ?? current;
  if (!target) return fail("no profile selected");
  const found = profiles.find((p) => p.name === target);
  if (!found) return fail(`profile '${target}' not found`);
  const key = getKey(found.entry.baseUrl);
  const hasKey = !!key;
  // Same check as whoami: the stored key is shared per server URL, so the
  // prefix recorded on this profile may no longer describe it.
  const recorded = found.entry.keyPrefix;
  const stalePrefix = Boolean(key && recorded && !key.startsWith(recorded));
  const keyPrefix = stalePrefix ? key!.slice(0, 18) : (recorded ?? null);
  emit(
    () => {
      const w = process.stdout.write.bind(process.stdout);
      w(`${c.bold(safeText(found.name))}${found.name === current ? c.dim(" (current)") : ""}\n`);
      w(`  ${c.dim("server:")} ${safeText(found.entry.baseUrl)}\n`);
      w(
        `  ${c.dim("key:   ")} ${safeText(keyPrefix ?? "—")}${
          hasKey ? "" : c.red(" (no keychain entry)")
        }${stalePrefix ? c.yellow(` (this profile recorded ${safeText(recorded)}; the key stored for this server has been replaced since)`) : ""}\n`,
      );
      if (found.entry.cloudflareAccessMode) {
        w(
          `  ${c.dim("cf:    ")} ${safeText(found.entry.cloudflareAccessMode)}${
            found.entry.cloudflareAccessAppUrl
              ? c.dim(` (${safeText(found.entry.cloudflareAccessAppUrl)})`)
              : ""
          }\n`,
        );
      }
      if (found.entry.edgeWorkerUrl) {
        w(`  ${c.dim("edge:  ")} ${safeText(found.entry.edgeWorkerUrl)}\n`);
      }
    },
    {
      name: found.name,
      is_current: found.name === current,
      base_url: found.entry.baseUrl,
      key_prefix: keyPrefix,
      key_prefix_stale: stalePrefix,
      has_key: hasKey,
      cloudflare_mode: found.entry.cloudflareAccessMode ?? null,
      cloudflare_app_url: found.entry.cloudflareAccessAppUrl ?? null,
      edge_worker_url: found.entry.edgeWorkerUrl ?? null,
    },
  );
}
