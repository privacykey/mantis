"use client";

import { useState } from "react";

export function CopyUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard might be blocked in non-secure contexts; ignore */
    }
  };

  return (
    <div className="flex items-center gap-2">
      <code className="text-sm font-mono text-blue-400 break-all flex-1">
        {url}
      </code>
      <button
        type="button"
        onClick={onCopy}
        className="text-xs text-neutral-400 hover:text-neutral-100 bg-neutral-900 border border-neutral-800 rounded px-2 py-1 cursor-pointer font-[inherit] shrink-0"
      >
        {copied ? "copied!" : "copy"}
      </button>
      <span role="status" className="sr-only">
        {copied ? "copied to clipboard" : ""}
      </span>
    </div>
  );
}
