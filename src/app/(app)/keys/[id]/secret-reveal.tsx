"use client";

import { useState } from "react";

type State =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "shown"; secret: string }
  | { kind: "error"; message: string };

/**
 * Renders the secret fingerprint with a reveal button. Clicking POSTs to
 * /api/keys/:id/destinations/:destId/signing-secret (audited) and shows
 * the plaintext in memory; the rendered HTML never contains it.
 */
export function SecretReveal({
  keyId,
  destinationId,
  fingerprint,
}: {
  keyId: string;
  destinationId: string;
  fingerprint: string;
}) {
  const [state, setState] = useState<State>({ kind: "hidden" });
  const [copied, setCopied] = useState(false);

  const reveal = async () => {
    setState({ kind: "loading" });
    try {
      const res = await fetch(
        `/api/keys/${keyId}/destinations/${destinationId}/signing-secret`,
        { method: "POST", cache: "no-store" },
      );
      if (!res.ok) {
        setState({
          kind: "error",
          message: `request failed (HTTP ${res.status})`,
        });
        return;
      }
      const body = (await res.json()) as { signing_secret?: unknown };
      if (typeof body.signing_secret !== "string") {
        setState({ kind: "error", message: "unexpected response shape" });
        return;
      }
      setState({ kind: "shown", secret: body.signing_secret });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const hide = () => {
    setState({ kind: "hidden" });
    setCopied(false);
  };

  const copy = async () => {
    if (state.kind !== "shown") return;
    try {
      await navigator.clipboard.writeText(state.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked in non-secure contexts; ignore */
    }
  };

  return (
    <div className="mt-1 not-font-mono">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-neutral-500">signing secret</span>
        <code className="text-xs text-amber-300 font-mono bg-neutral-950 border border-neutral-900 rounded px-1.5 py-0.5">
          {state.kind === "shown" ? state.secret : fingerprint}
        </code>
        {state.kind === "hidden" && (
          <button
            type="button"
            onClick={reveal}
            className="text-xs text-neutral-400 hover:text-neutral-100 bg-neutral-900 border border-neutral-800 rounded px-2 py-0.5 cursor-pointer font-[inherit]"
          >
            reveal
          </button>
        )}
        {state.kind === "loading" && (
          <span role="status" className="text-xs text-neutral-500">
            loading…
          </span>
        )}
        {state.kind === "shown" && (
          <>
            <button
              type="button"
              onClick={copy}
              className="text-xs text-neutral-400 hover:text-neutral-100 bg-neutral-900 border border-neutral-800 rounded px-2 py-0.5 cursor-pointer font-[inherit]"
            >
              {copied ? "copied!" : "copy"}
            </button>
            <button
              type="button"
              onClick={hide}
              className="text-xs text-neutral-400 hover:text-neutral-100 bg-neutral-900 border border-neutral-800 rounded px-2 py-0.5 cursor-pointer font-[inherit]"
            >
              hide
            </button>
            <span role="status" className="sr-only">
              {copied ? "copied to clipboard" : "signing secret revealed"}
            </span>
          </>
        )}
      </div>
      {state.kind === "error" && (
        <p role="alert" className="text-xs text-red-400 mt-1">
          could not reveal: {state.message}
        </p>
      )}
      {state.kind === "shown" && (
        <p className="text-xs text-neutral-600 mt-1">
          Receiver verifies <code>X-Mantis-Signature: sha256={"{hex}"}</code>{" "}
          where <code>hex = HMAC-SHA256(`${"{ts}"}.${"{body}"}`, secret)</code>.{" "}
          <code>X-Mantis-Timestamp</code> is unix seconds — reject if older
          than ~5 min to prevent replays. Each reveal is recorded in the audit
          log.
        </p>
      )}
    </div>
  );
}
