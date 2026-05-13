"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  saveWalletConfigAction,
  type WalletConfigState,
} from "./actions";

type Props = {
  defaults: {
    teamId: string | null;
    passTypeId: string | null;
    organizationName: string | null;
  };
};

export function WalletConfigForm({ defaults }: Props) {
  const [state, formAction] = useActionState<WalletConfigState, FormData>(
    saveWalletConfigAction,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      <Field
        label="Pass Type ID certificate (.p12)"
        hint="Exported from Keychain Access after registering a Pass Type ID at developer.apple.com. Required."
      >
        <input
          type="file"
          name="cert_p12"
          accept=".p12,application/x-pkcs12"
          required
          className={fileCls}
        />
      </Field>

      <Field
        label="Cert password"
        hint="The password you set when exporting the .p12 from Keychain Access."
      >
        <input
          type="password"
          name="cert_pass"
          required
          autoComplete="off"
          className={inputCls}
        />
      </Field>

      <Field
        label="Team ID"
        hint="10-character uppercase Apple Team ID (e.g. ABCDE12345). Visible in your Apple Developer account."
      >
        <input
          name="team_id"
          required
          maxLength={10}
          defaultValue={defaults.teamId ?? ""}
          placeholder="ABCDE12345"
          className={`${inputCls} font-mono uppercase`}
        />
      </Field>

      <Field
        label="Pass Type ID"
        hint="The Pass Type ID you registered (e.g. pass.com.example.mantis)."
      >
        <input
          name="pass_type_id"
          required
          defaultValue={defaults.passTypeId ?? ""}
          placeholder="pass.com.yourdomain.mantis"
          className={`${inputCls} font-mono`}
        />
      </Field>

      <Field
        label="Organization name"
        hint="Shown on the pass front. Defaults to 'Mantis'."
      >
        <input
          name="organization_name"
          defaultValue={defaults.organizationName ?? "Mantis"}
          maxLength={64}
          className={inputCls}
        />
      </Field>

      <Field
        label="Auth secret"
        hint="Used to HMAC-derive a per-pass authenticationToken. Leave blank to auto-generate. Rotating this invalidates all outstanding passes."
      >
        <input
          name="auth_secret"
          autoComplete="off"
          placeholder="(auto-generate if blank)"
          className={`${inputCls} font-mono`}
        />
      </Field>

      <details className="border border-neutral-900 rounded p-3 bg-neutral-950/40">
        <summary className="text-xs uppercase tracking-wide text-neutral-500 cursor-pointer">
          optional assets
        </summary>
        <div className="space-y-3 mt-3">
          <Field
            label="WWDR intermediate certificate (.pem)"
            hint="Apple's WWDR cert. If unset, passkit-generator uses its bundled fallback. Download fresh from Apple PKI when needed."
          >
            <input
              type="file"
              name="wwdr_pem"
              accept=".pem,.cer,.crt"
              className={fileCls}
            />
          </Field>
          <Field
            label="Icon (58×58 PNG)"
            hint="Custom icon shown in Wallet. Falls back to a solid-yellow default."
          >
            <input
              type="file"
              name="icon_png"
              accept="image/png"
              className={fileCls}
            />
          </Field>
          <Field
            label="Logo (160×50 PNG)"
            hint="Custom logo on the pass front. Falls back to a solid-yellow default."
          >
            <input
              type="file"
              name="logo_png"
              accept="image/png"
              className={fileCls}
            />
          </Field>
        </div>
      </details>

      {state.error && (
        <div className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
          {state.error}
        </div>
      )}
      {state.ok && state.message && (
        <div className="text-sm text-emerald-400 bg-emerald-950/40 border border-emerald-900 rounded px-3 py-2">
          {state.message}
        </div>
      )}

      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="bg-neutral-100 text-neutral-900 rounded px-4 py-2 text-sm font-medium hover:bg-white disabled:opacity-50"
    >
      {pending ? "saving + smoke-testing…" : "save wallet config"}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-neutral-500 mb-1">
        {label}
      </span>
      {children}
      {hint && <span className="block text-xs text-neutral-600 mt-1">{hint}</span>}
    </label>
  );
}

const inputCls =
  "w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-neutral-100 placeholder-neutral-600 focus:outline-none focus:border-neutral-600";

const fileCls =
  "w-full text-sm text-neutral-300 file:mr-3 file:py-2 file:px-3 file:rounded file:border-0 file:text-xs file:bg-neutral-800 file:text-neutral-200 hover:file:bg-neutral-700 file:cursor-pointer";
