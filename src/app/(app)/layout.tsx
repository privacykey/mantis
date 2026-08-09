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
            <nav
              aria-label="primary"
              className="flex items-center gap-4 text-neutral-400"
            >
              <Link href="/keys" className="text-neutral-400 no-underline hover:text-neutral-200">
                keys
              </Link>
              <Link href="/keys/new" className="text-neutral-400 no-underline hover:text-neutral-200">
                new
              </Link>
              <Link
                href="/keys/bulk"
                className="text-neutral-400 no-underline hover:text-neutral-200"
                title="Mint many keys at once and download them as a zip"
              >
                bulk
              </Link>
              <Link
                href="/keys/device"
                className="text-neutral-400 no-underline hover:text-neutral-200"
                title="Mint every host alarm for one machine and download an install bundle"
              >
                machine
              </Link>
              <Link
                href="/inbox"
                className="text-neutral-400 no-underline hover:text-neutral-200"
                title="Catch-all dev inbox: captures notifications when no real destination is configured"
                target="_blank"
                rel="noopener noreferrer"
              >
                dev inbox <span aria-hidden="true">↗</span>
                <span className="sr-only">(opens in new tab)</span>
              </Link>
              {session.isAdmin && (
                <Link
                  href="/settings/notifications"
                  className="text-neutral-400 no-underline hover:text-neutral-200"
                >
                  settings
                </Link>
              )}
              <a
                href="https://github.com/privacykey/docs-mantis"
                className="text-neutral-400 no-underline hover:text-neutral-200"
                title="Documentation (opens in new tab)"
                target="_blank"
                rel="noopener noreferrer"
              >
                docs <span aria-hidden="true">↗</span>
                <span className="sr-only">(opens in new tab)</span>
              </a>
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
