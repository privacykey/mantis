"use client";

import { useState } from "react";
import {
  revealGlobalSigningSecretAction,
  rotateGlobalSigningSecretAction,
} from "./actions";

type State =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "shown"; secret: string; rotated: boolean }
  | { kind: "error"; message: string };

/**
 * The global counterpart of the per-key SecretReveal: shows the signing-secret
 * fingerprint of a saved global webhook with reveal and rotate controls. Both
 * go through admin-only, audited server actions and keep the plaintext in
 * memory; the rendered HTML never contains it. Lives inside the destinations
 * <form>, so every button is type="button".
 */
export function GlobalSecretReveal({
  destinationId,
  fingerprint,
}: {
  destinationId: string;
  fingerprint: string;
}) {
  const [state, setState] = useState<State>({ kind: "hidden" });
  // After a rotation the prop is stale until the page re-renders.
  const [rotatedFingerprint, setRotatedFingerprint] = useState<string | null>(null);
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const [copied, setCopied] = useState(false);

  const run = async (
    action: typeof revealGlobalSigningSecretAction,
    rotated: boolean,
  ) => {
    setConfirmingRotate(false);
    setState({ kind: "loading" });
    try {
      const result = await action(destinationId);
      // Nothing comes back when the action redirected (session expired).
      if (!result) return;
      if ("error" in result) {
        setState({ kind: "error", message: result.error });
        return;
      }
      if (rotated) setRotatedFingerprint(result.signing_secret_fingerprint);
      setState({ kind: "shown", secret: result.signing_secret, rotated });
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

  const busy = state.kind === "loading";

  return (
    <div className="pl-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-neutral-500">signing secret</span>
        <code className="text-xs text-amber-300 font-mono bg-neutral-950 border border-neutral-900 rounded px-1.5 py-0.5 break-all">
          {state.kind === "shown" ? state.secret : (rotatedFingerprint ?? fingerprint)}
        </code>
        {state.kind === "hidden" && (
          <button
            type="button"
            onClick={() => run(revealGlobalSigningSecretAction, false)}
            className={buttonClass}
          >
            reveal
          </button>
        )}
        {state.kind === "shown" && (
          <>
            <button type="button" onClick={copy} className={buttonClass}>
              {copied ? "copied!" : "copy"}
            </button>
            <button type="button" onClick={hide} className={buttonClass}>
              hide
            </button>
            <span role="status" className="sr-only">
              {copied ? "copied to clipboard" : "signing secret revealed"}
            </span>
          </>
        )}
        {busy && (
          <span role="status" className="text-xs text-neutral-500">
            loading…
          </span>
        )}
        {!busy && !confirmingRotate && (
          <button
            type="button"
            onClick={() => setConfirmingRotate(true)}
            className={buttonClass}
          >
            rotate
          </button>
        )}
        {!busy && confirmingRotate && (
          <>
            <button
              type="button"
              onClick={() => run(rotateGlobalSigningSecretAction, true)}
              className="text-xs text-red-300 hover:text-red-100 bg-red-950/40 border border-red-900 rounded px-2 py-0.5 cursor-pointer font-[inherit]"
            >
              confirm rotate
            </button>
            <button
              type="button"
              onClick={() => setConfirmingRotate(false)}
              className={buttonClass}
            >
              cancel
            </button>
          </>
        )}
      </div>
      {confirmingRotate && (
        <p className="text-xs text-amber-400 mt-1">
          Rotating replaces the secret at once: the receiver rejects new alerts
          until it is given the new one.
        </p>
      )}
      {state.kind === "error" && (
        <p role="alert" className="text-xs text-red-400 mt-1">
          could not load the signing secret: {state.message}
        </p>
      )}
      {state.kind === "shown" && (
        <p className="text-xs text-neutral-600 mt-1">
          {state.rotated ? "New secret — give it to the receiver now. " : ""}
          Receiver verifies <code>X-Mantis-Signature: sha256={"{hex}"}</code>{" "}
          where <code>hex = HMAC-SHA256(`${"{ts}"}.${"{body}"}`, secret)</code>.{" "}
          <code>X-Mantis-Timestamp</code> is unix seconds — reject if older
          than ~5 min to prevent replays. This secret signs every key&apos;s
          alerts sent here through the global list; a key that lists this same
          URL as its own destination signs with that key&apos;s secret instead.
          Each reveal and rotation is recorded in the audit log.
        </p>
      )}
    </div>
  );
}

const buttonClass =
  "text-xs text-neutral-400 hover:text-neutral-100 bg-neutral-900 border border-neutral-800 rounded px-2 py-0.5 cursor-pointer font-[inherit]";
