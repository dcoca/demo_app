"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Field, Input, Notice } from "@/components/ui";
import { api } from "@/lib/api-client";

export function CreateHouseholdForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await api("/api/v1/households", { method: "POST", body: { name, timezone } });
      router.replace("/list");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create household");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Household name" htmlFor="household-name" hint="For example: The Parkers, or 12 Elm Street.">
        <Input id="household-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
      </Field>
      {error ? <Notice tone="red">{error}</Notice> : null}
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? "Creating…" : "Create household"}
      </Button>
    </form>
  );
}
