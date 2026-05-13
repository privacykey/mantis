"use client";

import { useEffect, useState } from "react";

type InstallType =
  | "shell"
  | "shell-sudo"
  | "macos-login"
  | "macos-boot"
  | "macos-wake"
  | "macos-network"
  | "linux-boot"
  | "linux-wake"
  | "linux-network"
  | "windows-logon"
  | "windows-wake"
  | "windows-network"
  | "css-background"
  | "js-clone-detector"
  | "nfc-ndef"
  | "homeassistant"
  | "scrypted";

type Installer = {
  type: InstallType;
  name: string;
  description: string;
  os: "macos" | "linux" | "windows" | "posix" | "web" | "tag" | "iot";
  filename: string;
  content: string;
  install: string[];
  uninstall: string[];
  notes?: string;
};

const TABS: Array<{ type: InstallType; short: string }> = [
  { type: "shell", short: "shell" },
  { type: "shell-sudo", short: "sudo" },
  { type: "macos-login", short: "macOS login" },
  { type: "macos-boot", short: "macOS boot" },
  { type: "macos-wake", short: "macOS wake" },
  { type: "macos-network", short: "macOS net" },
  { type: "linux-boot", short: "linux boot" },
  { type: "linux-wake", short: "linux wake" },
  { type: "linux-network", short: "linux net" },
  { type: "windows-logon", short: "win logon" },
  { type: "windows-wake", short: "win wake" },
  { type: "windows-network", short: "win net" },
  { type: "css-background", short: "web CSS" },
  { type: "js-clone-detector", short: "web JS" },
  { type: "nfc-ndef", short: "NFC tag" },
  { type: "homeassistant", short: "Home Assistant" },
  { type: "scrypted", short: "Scrypted" },
];

export function InstallersCard({ keyId }: { keyId: string }) {
  const [active, setActive] = useState<InstallType>("shell");
  const [installer, setInstaller] = useState<Installer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostname, setHostname] = useState<string>("");

  useEffect(() => {
    let alive = true;
    setInstaller(null);
    setError(null);
    const params = new URLSearchParams({ type: active, format: "json" });
    if (active === "js-clone-detector" && hostname.trim()) {
      params.set("hostname", hostname.trim());
    }
    fetch(`/api/keys/${keyId}/install?${params.toString()}`, {
      cache: "no-store",
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (alive) setInstaller(data as Installer);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [active, keyId, hostname]);

  return (
    <section className="mt-8 border border-neutral-900 rounded p-4 bg-neutral-950/40">
      <h2 className="text-base font-semibold mb-1">install on a host</h2>
      <p className="text-xs text-neutral-500 mb-3">
        Ready-made snippets that fire this mantis on shell startup, login,
        boot, or via web embed. Pick a target, copy or download, follow the
        install steps.
      </p>

      <div className="flex flex-wrap gap-1 mb-4 border-b border-neutral-900">
        {TABS.map((t) => (
          <button
            key={t.type}
            type="button"
            onClick={() => setActive(t.type)}
            className={
              "text-xs px-3 py-1.5 border-b-2 transition-colors cursor-pointer font-[inherit] bg-transparent " +
              (active === t.type
                ? "text-neutral-100 border-blue-400"
                : "text-neutral-500 border-transparent hover:text-neutral-300")
            }
          >
            {t.short}
          </button>
        ))}
      </div>

      {active === "js-clone-detector" && (
        <div className="mb-3">
          <label className="block text-xs uppercase tracking-wide text-neutral-500 mb-1">
            expected hostname (no protocol, no path)
          </label>
          <input
            type="text"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            placeholder="example.com"
            className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded px-3 py-1.5 text-sm text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-600"
          />
          <p className="text-xs text-neutral-600 mt-1">
            Snippet only fires when window.location.hostname is neither this
            value nor a subdomain of it. Leave blank to fire on every page.
          </p>
        </div>
      )}

      {error && (
        <div className="text-sm text-red-400">failed to load: {error}</div>
      )}

      {installer && (
        <div className="space-y-3">
          <p className="text-sm text-neutral-300">{installer.description}</p>
          {installer.notes && (
            <p className="text-xs text-neutral-500">{installer.notes}</p>
          )}

          <Block title={installer.filename} text={installer.content} />

          <DownloadLink
            keyId={keyId}
            type={installer.type}
            filename={installer.filename}
            hostname={
              installer.type === "js-clone-detector" ? hostname : undefined
            }
          />

          {installer.type === "nfc-ndef" && (
            <a
              href={`/api/keys/${keyId}/download?format=nfc-label`}
              className="text-xs text-blue-400 no-underline hover:underline block"
              download
            >
              ↓ download printable sticker label (PDF, with QR fallback)
            </a>
          )}

          <Block
            title="install"
            text={installer.install.join("\n")}
            mono
          />

          <details>
            <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-300">
              uninstall
            </summary>
            <div className="mt-2">
              <Block title="" text={installer.uninstall.join("\n")} mono />
            </div>
          </details>
        </div>
      )}
    </section>
  );
}

function Block({
  title,
  text,
  mono,
}: {
  title: string;
  text: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; ignore */
    }
  };
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        {title ? (
          <span className="text-xs text-neutral-500 font-mono">{title}</span>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={onCopy}
          className="text-xs text-neutral-400 hover:text-neutral-100 bg-neutral-900 border border-neutral-800 rounded px-2 py-0.5 cursor-pointer font-[inherit]"
        >
          {copied ? "copied!" : "copy"}
        </button>
      </div>
      <pre
        className={
          "bg-neutral-950 border border-neutral-900 rounded p-3 text-xs overflow-auto max-h-72 whitespace-pre-wrap break-words " +
          (mono ? "text-neutral-300" : "text-neutral-300")
        }
      >
        {text}
      </pre>
    </div>
  );
}

function DownloadLink({
  keyId,
  type,
  filename,
  hostname,
}: {
  keyId: string;
  type: InstallType;
  filename: string;
  hostname?: string;
}) {
  const params = new URLSearchParams({ type });
  if (hostname && hostname.trim()) params.set("hostname", hostname.trim());
  return (
    <a
      href={`/api/keys/${keyId}/install?${params.toString()}`}
      className="text-xs text-blue-400 no-underline hover:underline"
      download={filename}
    >
      ↓ download {filename}
    </a>
  );
}
