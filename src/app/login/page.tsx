import { redirect } from "next/navigation";
import { getSessionApiKey } from "@/lib/session";
import { LoginForm } from "./form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await getSessionApiKey();
  if (session) redirect("/keys");

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold mb-1">mantis</h1>
        <p className="text-sm text-neutral-500 mb-8">
          Paste your API key to sign in.
        </p>
        <LoginForm />
        <p className="text-xs text-neutral-600 mt-6 leading-relaxed">
          First run? The bootstrap admin key was printed once to the server logs
          on first boot — <code>docker compose logs mantis | grep
          &quot;bootstrap API key&quot; -A1</code> — or set via{" "}
          <code>BOOTSTRAP_API_KEY</code>. See the{" "}
          <a
            href="https://github.com/privacykey/docs-mantis"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 no-underline hover:underline"
          >
            getting-started docs
          </a>
          .
        </p>
        <p className="text-xs text-neutral-600 mt-3 leading-relaxed">
          Your key is also accepted via the CLI (<code>mantis login</code>) and
          HTTP API (<code>Authorization: Bearer …</code>). The key is stored in
          an httpOnly cookie scoped to this server.
        </p>
      </div>
    </main>
  );
}
