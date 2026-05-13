import { NewKeyForm } from "./form";

export const dynamic = "force-dynamic";

export default function NewKeyPage() {
  return (
    <div className="max-w-xl">
      <h1 className="text-xl font-semibold mb-1">new key</h1>
      <p className="text-sm text-neutral-500 mb-6">
        A new mantis URL will be minted. Anyone who hits it will be logged.
      </p>
      <NewKeyForm />
    </div>
  );
}
