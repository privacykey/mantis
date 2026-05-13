"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { loginAction, type LoginState } from "./actions";

export function LoginForm() {
  const [state, formAction] = useActionState<LoginState, FormData>(loginAction, {});

  return (
    <form action={formAction} className="space-y-3">
      <label className="block">
        <span className="block text-xs uppercase tracking-wide text-neutral-500 mb-1">
          API key
        </span>
        <input
          type="password"
          name="api_key"
          autoComplete="off"
          autoFocus
          required
          placeholder="mantis_live_…"
          className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-600"
        />
      </label>

      {state.error && (
        <div className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
          {state.error}
        </div>
      )}

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full bg-neutral-100 text-neutral-900 rounded px-3 py-2 text-sm font-medium hover:bg-white disabled:opacity-50 disabled:cursor-wait"
    >
      {pending ? "checking…" : "sign in"}
    </button>
  );
}
