import { redirect } from "next/navigation";
import { getSessionApiKey } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await getSessionApiKey();
  if (session) redirect("/keys");
  redirect("/login");
}
