import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSessionApiKey } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSessionApiKey();
  if (!session) redirect("/login");

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-neutral-900 bg-neutral-950">
        <div className="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between text-sm">
          <div className="flex items-center gap-6">
            <Link
              href="/keys"
              className="text-neutral-200 no-underline hover:no-underline font-semibold"
            >
              mantis
            </Link>
            <nav className="flex items-center gap-4 text-neutral-400">
              <Link href="/keys" className="text-neutral-400 no-underline hover:text-neutral-200">
                keys
              </Link>
              <Link href="/keys/new" className="text-neutral-400 no-underline hover:text-neutral-200">
                new
              </Link>
              <Link
                href="/inbox"
                className="text-neutral-400 no-underline hover:text-neutral-200"
                target="_blank"
              >
                inbox ↗
              </Link>
              {session.isAdmin && (
                <Link
                  href="/settings/wallet"
                  className="text-neutral-400 no-underline hover:text-neutral-200"
                >
                  settings
                </Link>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-neutral-500">
            <span className="hidden sm:inline">{session.prefix}…</span>
            <form action="/logout" method="post">
              <button
                type="submit"
                className="text-neutral-400 hover:text-neutral-200 bg-transparent border-0 cursor-pointer text-sm font-[inherit] p-0"
              >
                logout
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="flex-1">
        <div className="max-w-5xl mx-auto px-6 py-6">{children}</div>
      </main>
    </div>
  );
}
