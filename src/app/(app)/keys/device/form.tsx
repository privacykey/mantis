"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  DEVICE_PROFILES,
  defaultVectorSlugs,
  getDeviceProfile,
  type DeviceOs,
} from "@mantis/core/device-profiles";
import { deviceCreateAction, type DeviceState } from "./actions";

const PLACEHOLDER: Record<DeviceOs, string> = {
  macos: "adams-macbook",
  linux: "web01",
  windows: "reception-pc",
};

export function DeviceForm({
  hasGlobalDestinations,
}: {
  hasGlobalDestinations: boolean;
}) {
  const [state, formAction] = useActionState<DeviceState, FormData>(
    deviceCreateAction,
    {},
  );
  const [os, setOs] = useState<DeviceOs>("macos");
  const [device, setDevice] = useState("");
  const [selected, setSelected] = useState<string[]>(() =>
    defaultVectorSlugs("macos"),
  );
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const profile = useMemo(() => getDeviceProfile(os), [os]);

  const chooseOs = (next: DeviceOs) => {
    setOs(next);
    // Slugs repeat across profiles (`wake`, `network`), so carrying a selection
    // over would silently keep vectors the new OS doesn't offer.
    setSelected(defaultVectorSlugs(next));
  };

  const toggle = (slug: string) =>
    setSelected((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );

  const download = async () => {
    if (!state.minted || !state.device || !state.os) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const res = await fetch("/api/keys/device-bundle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device: state.device,
          os: state.os,
          vectors: state.minted.map((m) => ({ id: m.id, slug: m.slug })),
        }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(`bundle failed (${res.status}): ${msg.slice(0, 200)}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${state.device}-${state.os}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  const warnings = profile.vectors.filter(
    (v) => selected.includes(v.slug) && v.needsExtraSetup,
  );
  const needsRoot = profile.vectors.some(
    (v) => selected.includes(v.slug) && v.needsRoot,
  );

  return (
    <div className="space-y-6">
      <form action={formAction} className="space-y-5">
        <fieldset className="border-0 p-0 m-0">
          <legend className="block text-xs uppercase tracking-wide text-neutral-500 mb-2">
            1 · operating system
          </legend>
          <input type="hidden" name="os" value={os} />
          <div className="grid grid-cols-3 gap-2">
            {DEVICE_PROFILES.map((p) => {
              const active = p.os === os;
              return (
                <button
                  key={p.os}
                  type="button"
                  onClick={() => chooseOs(p.os)}
                  aria-pressed={active}
                  className={`text-left rounded border px-3 py-2 cursor-pointer font-[inherit] transition-colors ${
                    active
                      ? "border-neutral-500 bg-neutral-900 text-neutral-100"
                      : "border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-700"
                  }`}
                >
                  <span className="block text-sm">{p.label}</span>
                  <span className="block text-xs text-neutral-600 mt-0.5">
                    {p.vectors.length} alarms
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-neutral-500 mb-1">
            2 · device name
          </span>
          <input
            name="device"
            required
            value={device}
            onChange={(e) => setDevice(e.target.value)}
            placeholder={PLACEHOLDER[os]}
            autoComplete="off"
            className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-neutral-100 placeholder-neutral-700 focus:outline-none focus:border-neutral-600 font-mono text-sm"
          />
          <span className="block text-xs text-neutral-600 mt-1">
            Goes in every memo, so hits read{" "}
            <span className="text-neutral-400 font-mono">
              {device || PLACEHOLDER[os]} — wake from sleep
            </span>
            . Re-running with the same name reuses that machine&apos;s keys
            instead of minting duplicates.
          </span>
        </label>

        <fieldset className="border-0 p-0 m-0">
          <legend className="block text-xs uppercase tracking-wide text-neutral-500 mb-2">
            3 · alarms — {selected.length} selected
          </legend>
          <div className="space-y-1.5">
            {profile.vectors.map((v) => {
              const on = selected.includes(v.slug);
              return (
                <label
                  key={v.slug}
                  className={`flex gap-2.5 items-start rounded border px-3 py-2 cursor-pointer transition-colors ${
                    on
                      ? "border-neutral-700 bg-neutral-900"
                      : "border-neutral-900 bg-neutral-950 hover:border-neutral-800"
                  }`}
                >
                  <input
                    type="checkbox"
                    name="vectors"
                    value={v.slug}
                    checked={on}
                    onChange={() => toggle(v.slug)}
                    className="mt-0.5 accent-neutral-300"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-neutral-200">
                      {v.label}
                      {v.needsRoot && (
                        <span className="ml-2 text-xs text-neutral-600">
                          root
                        </span>
                      )}
                      {v.needsExtraSetup && (
                        <span className="ml-2 text-xs text-amber-600">
                          needs {v.needsExtraSetup.what}
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-neutral-600 mt-0.5">
                      {v.blurb}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {warnings.map((v) => (
          <div
            key={v.slug}
            className="text-xs text-amber-500/80 border border-amber-900/40 bg-amber-950/20 rounded px-3 py-2"
          >
            <strong className="font-medium">{v.label}</strong> needs{" "}
            {v.needsExtraSetup!.what} on the machine, which isn&apos;t installed
            by default. {v.needsExtraSetup!.why} Install it first, or the key
            mints fine and the alarm simply never fires:
            <span className="block mt-1 font-mono text-amber-400/90">
              {v.needsExtraSetup!.install.join(" && ")}
            </span>
          </div>
        ))}

        {needsRoot && (
          <div className="text-xs text-neutral-500 border border-neutral-900 rounded bg-neutral-950/40 px-3 py-2">
            Some alarms install system-wide, so the bundle&apos;s installer asks
            for {os === "windows" ? "an elevated PowerShell" : "sudo"} once.
          </div>
        )}

        {!hasGlobalDestinations && (
          <div className="text-xs text-amber-500/80 border border-amber-900/40 bg-amber-950/20 rounded px-3 py-2">
            No global destinations configured. These keys get no per-key
            destinations, so they would record hits without alerting anyone.{" "}
            <Link
              href="/settings/notifications"
              className="text-blue-400 no-underline hover:underline"
            >
              set them up first
            </Link>
            .
          </div>
        )}

        {state.error && (
          <div
            role="alert"
            className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2"
          >
            {state.error}
          </div>
        )}

        <Submit count={selected.length} />
      </form>

      {state.minted && state.minted.length > 0 && (
        <div className="border border-neutral-900 rounded bg-neutral-950/40 p-4 space-y-3">
          <div className="text-sm text-emerald-500">
            {state.device} is armed — {state.minted.length} alarm
            {state.minted.length === 1 ? "" : "s"}.
            {state.minted.some((m) => !m.created) && (
              <span className="text-neutral-500">
                {" "}
                ({state.minted.filter((m) => !m.created).length} reused from a
                previous run.)
              </span>
            )}
          </div>

          <ul className="text-xs text-neutral-400 space-y-1 list-none p-0 m-0">
            {state.minted.map((m) => (
              <li key={m.id}>
                <Link
                  href={`/keys/${m.id}`}
                  className="text-neutral-300 no-underline hover:underline"
                >
                  {m.memo}
                </Link>{" "}
                <span className="text-neutral-600">/c/{m.publicId}</span>
              </li>
            ))}
          </ul>

          {downloadError && (
            <div className="text-xs text-red-400">
              Keys are minted, but the bundle failed: {downloadError}
            </div>
          )}

          <button
            type="button"
            disabled={downloading}
            onClick={download}
            className="text-xs bg-neutral-100 text-neutral-900 rounded px-3 py-1.5 font-medium hover:bg-white disabled:opacity-50 cursor-pointer border-0"
          >
            {downloading ? "building…" : "download install bundle (.zip)"}
          </button>

          <p className="text-xs text-neutral-600 m-0">
            Unzip on {state.device}, read the script, then run{" "}
            <span className="font-mono text-neutral-500">
              {state.os === "windows" ? ".\\install.ps1" : "./install.sh"}
            </span>
            .
          </p>
        </div>
      )}
    </div>
  );
}

function Submit({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || count === 0}
      className="bg-neutral-100 text-neutral-900 rounded px-4 py-2 text-sm font-medium hover:bg-white disabled:opacity-50 cursor-pointer"
    >
      {pending
        ? "minting…"
        : count === 0
          ? "pick at least one alarm"
          : `mint ${count} key${count === 1 ? "" : "s"}`}
    </button>
  );
}
