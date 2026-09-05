import type { Destination, NotificationChannel } from "../lib/api.js";
import { c, emit, fail, table, truncate } from "../lib/out.js";
import { resolveKeyRef } from "../lib/resolve.js";
import { withClient, type GlobalOpts } from "../lib/runner.js";
import { ALL_CHANNELS } from "../lib/channels.js";

const VALID_CHANNELS = ALL_CHANNELS;

export async function listDestinationsCmd(
  keyId: string,
  opts: GlobalOpts,
): Promise<void> {
  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, keyId);
    const key = await client.getKey(fullId);
    emit(
      () => {
        if (key.destinations.length === 0) {
          // Empty-state guidance goes to stderr so `dest list | wc -l` stays
          // honest; mirrors the dest-add error phrasing.
          process.stderr.write(
            c.dim(
              `no destinations configured. Add one with \`mantis dest add ${keyId} webhook https://example.com/hook\` (channels: ${VALID_CHANNELS.join(", ")}).\n`,
            ),
          );
          return;
        }
        const rows = key.destinations.map((d) => [
          d.id.slice(0, 8),
          d.channel,
          truncate(d.target, 60),
          statusIcon(d.last_activation_status),
        ]);
        process.stdout.write(
          table(["id", "channel", "target", "activation"], rows) + "\n",
        );
      },
      { data: key.destinations },
    );
  });
}

export async function addDestinationCmd(
  keyId: string,
  channelArg: string | undefined,
  targetArg: string | undefined,
  opts: GlobalOpts & { channel?: string; target?: string },
): Promise<void> {
  const channel = opts.channel ?? channelArg;
  const target = opts.target ?? targetArg;
  if (!channel || !(VALID_CHANNELS as readonly string[]).includes(channel)) {
    fail(
      `destination channel is required. Try \`mantis dest add ${keyId} webhook https://example.com/hook\` (channels: ${VALID_CHANNELS.join(", ")})`,
    );
  }
  if (!target) {
    fail(
      `destination target is required. Try \`mantis dest add ${keyId} ${channel} <url-or-email>\``,
    );
  }
  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, keyId);
    const key = await client.getKey(fullId);
    const next: Array<{ channel: NotificationChannel; target: string }> = [
      ...key.destinations.map((d) => ({ channel: d.channel, target: d.target })),
      { channel: channel as NotificationChannel, target },
    ];
    const updated = await client.patchKey(fullId, { destinations: next });
    const added = updated.destinations[updated.destinations.length - 1];
    emit(
      () => {
        if (!added) {
          process.stderr.write(c.red("added but no row returned\n"));
          return;
        }
        const ok = added.last_activation_status === "ok";
        process.stdout.write(
          `${ok ? c.green("✓") : c.yellow("⚠")} added ${added.channel}: ${added.target}\n`,
        );
        if (!ok && added.last_activation_error) {
          process.stdout.write(
            `  ${c.dim("activation failed:")} ${added.last_activation_error}\n`,
          );
        }
        if (added.signing_secret) {
          process.stdout.write(
            `  ${c.dim("signing secret:")} ${added.signing_secret}\n` +
              `  ${c.dim("(receiver verifies X-Mantis-Signature: sha256=hex of HMAC-SHA256(`{ts}.{body}`, secret))")}\n`,
          );
        }
      },
      { destinations: updated.destinations },
    );
  });
}

export async function rmDestinationCmd(
  keyId: string,
  destinationIdOrPrefix: string,
  opts: GlobalOpts,
): Promise<void> {
  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, keyId);
    const key = await client.getKey(fullId);
    const matches = key.destinations.filter(
      (d) => d.id === destinationIdOrPrefix || d.id.startsWith(destinationIdOrPrefix),
    );
    if (matches.length === 0) {
      fail(`no destination matches ${destinationIdOrPrefix} on key ${fullId}`);
    }
    if (matches.length > 1) {
      fail(
        `ambiguous prefix ${destinationIdOrPrefix} matches ${matches.length} destinations — use a longer id`,
      );
    }
    const target = matches[0]!;
    const next = key.destinations
      .filter((d) => d.id !== target.id)
      .map((d) => ({ channel: d.channel, target: d.target }));
    await client.patchKey(fullId, { destinations: next });
    emit(
      () => {
        process.stdout.write(
          `${c.green("✓")} removed ${target.channel}: ${truncate(target.target, 60)}\n`,
        );
      },
      { removed: target },
    );
  });
}

export async function testDestinationCmd(
  keyId: string,
  opts: GlobalOpts & { yes?: boolean },
): Promise<void> {
  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, keyId);
    const key = await client.getKey(fullId);

    if (key.destinations.length === 0) {
      fail(
        `key ${fullId} has no destinations. Run \`mantis dest add ${fullId} <channel> <target>\` first.`,
      );
    }

    if (!opts.yes) {
      process.stderr.write(
        c.yellow(
          `⚠ this will trigger the key URL (recording a real hit) and fire all ${key.destinations.length} configured destination(s).\n`,
        ),
      );
      process.stderr.write(
        c.dim(`   key:  ${fullId.slice(0, 8)} — ${key.memo}\n`),
      );
      process.stderr.write(
        c.dim(`   url:  ${key.url}\n`),
      );
      for (const d of key.destinations) {
        process.stderr.write(c.dim(`     → ${d.channel}: ${d.target}\n`));
      }
      process.stderr.write(c.dim(`\n   re-run with --yes to confirm.\n`));
      return;
    }

    // Find the most recent hit id (if any) so we can detect the new one.
    const beforePage = await client.listHits(fullId, { limit: 1 });
    const previousLatestId = beforePage.data[0]?.id ?? null;

    // Trigger via a normal GET with a distinctive UA so the receiver can
    // distinguish a CLI-issued test from a real fire.
    const triggerRes = await fetch(key.url, {
      method: "GET",
      headers: { "User-Agent": "mantis-cli-test/1.0" },
    });
    process.stderr.write(
      `${c.dim("trigger:")} ${triggerRes.status} ${triggerRes.statusText}\n`,
    );

    // Poll for the new hit and its notification statuses (up to ~10s).
    const deadline = Date.now() + 10_000;
    let newHit: Awaited<ReturnType<typeof client.listHits>>["data"][0] | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const page = await client.listHits(fullId, { limit: 5 });
      const latest = page.data[0];
      if (latest && latest.id !== previousLatestId) {
        newHit = latest;
        if (latest.notifications.length === key.destinations.length) break;
      }
    }

    if (!newHit) {
      fail(
        "trigger completed but no new hit appeared after 10s. Check the server logs.",
      );
    }

    emit(
      () => {
        const w = process.stdout.write.bind(process.stdout);
        w(`${c.green("✓")} test triggered hit ${newHit.id.slice(0, 8)} ${c.dim(`(${formatRelative(newHit.occurred_at)})`)}\n`);
        if (newHit.notifications.length === 0) {
          w(c.dim("  (notifications still pending — re-run `mantis hits " + fullId.slice(0, 8) + " -v` to follow up)\n"));
          return;
        }
        for (const n of newHit.notifications) {
          const status = n.status;
          const color =
            status === "succeeded" ? c.green :
            status === "failed" ? c.red :
            c.yellow;
          w(
            `  ${color(status.padEnd(10))} ${n.channel.padEnd(8)} ${c.dim(
              truncate(
                n.target ??
                  (n.destination_scope === "global"
                    ? "(global destination)"
                    : "(destination removed)"),
                60,
              ),
            )}` +
              (n.last_error ? `\n      ${c.red(n.last_error.slice(0, 80))}` : "") +
              "\n",
          );
        }
      },
      {
        hit_id: newHit.id,
        occurred_at: newHit.occurred_at,
        notifications: newHit.notifications,
      },
    );
  });
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}

export async function rotateDestinationSecretCmd(
  keyId: string,
  destinationIdOrPrefix: string,
  opts: GlobalOpts & { yes?: boolean },
): Promise<void> {
  await withClient(opts, async (client) => {
    const fullId = await resolveKeyRef(client, keyId);
    const key = await client.getKey(fullId);
    const matches = key.destinations.filter(
      (d) =>
        d.id === destinationIdOrPrefix ||
        d.id.startsWith(destinationIdOrPrefix),
    );
    if (matches.length === 0) {
      fail(`no destination matches ${destinationIdOrPrefix} on key ${fullId}`);
    }
    if (matches.length > 1) {
      fail(
        `ambiguous prefix ${destinationIdOrPrefix} matches ${matches.length} destinations — use a longer id`,
      );
    }
    const target = matches[0]!;
    if (target.channel !== "webhook") {
      fail(
        `rotate-secret is only supported on webhook destinations (this one is ${target.channel})`,
      );
    }

    if (!opts.yes) {
      process.stderr.write(
        c.yellow(
          `⚠ this rotates the HMAC signing secret on ${target.channel}: ${truncate(target.target, 60)}.\n`,
        ),
      );
      process.stderr.write(
        c.dim(
          `   in-flight notifications keep the old secret; future hits use the new one.\n   the new secret is shown ONCE and never again — capture it before closing the terminal.\n   re-run with --yes to proceed.\n`,
        ),
      );
      return;
    }

    const updated = await client.rotateDestinationSecret(fullId, target.id);
    emit(
      () => {
        process.stdout.write(
          `${c.green("✓")} rotated signing secret for ${target.channel}: ${target.target}\n`,
        );
        if (updated.signing_secret) {
          process.stdout.write(`\n${c.bold("new signing secret (save it now):")}\n`);
          process.stdout.write(`  ${c.cyan(updated.signing_secret)}\n\n`);
          process.stdout.write(
            c.dim(
              `Update your receiver to verify HMAC-SHA256(\`{ts}.{body}\`, secret) → X-Mantis-Signature.\n`,
            ),
          );
        }
      },
      updated,
    );
  });
}

function statusIcon(status: Destination["last_activation_status"]): string {
  if (status === "ok") return c.green("✓");
  if (status === "failed") return c.red("⚠");
  return c.dim("·");
}
