import {
  deleteCloudflareServiceAuth,
  deleteKey,
  getKey,
  listProfiles,
  patchProfile,
  removeProfile,
  useProfile,
} from "../lib/config.js";
import { c, emit, fail } from "../lib/out.js";

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
        w(`${marker}${c.bold(name.padEnd(16))} ${c.cyan(entry.baseUrl)}\n`);
        if (entry.keyPrefix) {
          w(`    ${c.dim("key:  ")} ${entry.keyPrefix}…\n`);
        }
        if (entry.cloudflareAccessMode) {
          w(
            `    ${c.dim("cf:   ")} ${entry.cloudflareAccessMode}${
              entry.cloudflareAccessAppUrl
                ? c.dim(` (${entry.cloudflareAccessAppUrl})`)
                : ""
            }\n`,
          );
        }
        if (entry.edgeWorkerUrl) {
          w(`    ${c.dim("edge: ")} ${entry.edgeWorkerUrl}\n`);
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
      process.stdout.write(`${current}\n`);
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
  process.stderr.write(`${c.green("✓")} switched to profile ${c.bold(name)}\n`);
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
  if (result.baseUrl) {
    deleteKey(result.baseUrl);
    deleteCloudflareServiceAuth(result.baseUrl);
  }
  const tail = result.wasCurrent
    ? result.newCurrent
      ? c.dim(` (current → ${result.newCurrent})`)
      : c.dim(" (was current; no profiles remain)")
    : "";
  process.stderr.write(
    `${c.green("✓")} removed profile ${c.bold(name)}${tail}\n`,
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
        `${c.green("✓")} cleared default edge worker for ${c.bold(name)} ${c.dim(`(was: ${updated.edgeWorkerUrl ?? "—"})`)}\n`,
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
    `${c.green("✓")} profile ${c.bold(name)} default edge worker → ${c.cyan(worker)}\n`,
  );
}

export async function profileShowCmd(name?: string): Promise<void> {
  const { current, profiles } = await listProfiles();
  const target = name ?? current;
  if (!target) return fail("no profile selected");
  const found = profiles.find((p) => p.name === target);
  if (!found) return fail(`profile '${target}' not found`);
  const hasKey = !!getKey(found.entry.baseUrl);
  emit(
    () => {
      const w = process.stdout.write.bind(process.stdout);
      w(`${c.bold(found.name)}${found.name === current ? c.dim(" (current)") : ""}\n`);
      w(`  ${c.dim("server:")} ${found.entry.baseUrl}\n`);
      w(
        `  ${c.dim("key:   ")} ${found.entry.keyPrefix ?? "—"}${
          hasKey ? "" : c.red(" (no keychain entry)")
        }\n`,
      );
      if (found.entry.cloudflareAccessMode) {
        w(
          `  ${c.dim("cf:    ")} ${found.entry.cloudflareAccessMode}${
            found.entry.cloudflareAccessAppUrl
              ? c.dim(` (${found.entry.cloudflareAccessAppUrl})`)
              : ""
          }\n`,
        );
      }
      if (found.entry.edgeWorkerUrl) {
        w(`  ${c.dim("edge:  ")} ${found.entry.edgeWorkerUrl}\n`);
      }
    },
    {
      name: found.name,
      is_current: found.name === current,
      base_url: found.entry.baseUrl,
      key_prefix: found.entry.keyPrefix ?? null,
      has_key: hasKey,
      cloudflare_mode: found.entry.cloudflareAccessMode ?? null,
      cloudflare_app_url: found.entry.cloudflareAccessAppUrl ?? null,
      edge_worker_url: found.entry.edgeWorkerUrl ?? null,
    },
  );
}
