"use client";

import { deleteKeyAction } from "../actions";

export function DeleteButton({ keyId, memo }: { keyId: string; memo: string }) {
  return (
    <form
      action={deleteKeyAction}
      onSubmit={(e) => {
        if (!confirm(`Delete "${memo}"? Its hits will be deleted too.`)) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="id" value={keyId} />
      <button
        type="submit"
        className="text-xs text-red-400 hover:text-red-300 bg-transparent border-0 cursor-pointer font-[inherit] p-0"
      >
        delete
      </button>
    </form>
  );
}
