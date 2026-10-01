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
        <div className="max-w-5xl mx-auto px-6 py-3 grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr_auto]">
          <div className="contents">
            <Link
              href="/keys"
              className="col-start-1 row-start-1 text-neutral-200 no-underline hover:no-underline font-semibold"
            >
              mantis
            </Link>
            <nav
              aria-label="primary"
              className="col-start-1 col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-neutral-400 sm:col-start-2 sm:col-span-1 sm:row-start-1 [&>a]:whitespace-nowrap"
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
                href="https://docs.mantis.privacykey.org"
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
          <div className="col-start-2 row-start-1 flex items-center gap-3 text-neutral-500 sm:col-start-3">
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
