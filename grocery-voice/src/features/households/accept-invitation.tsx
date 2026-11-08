"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Notice } from "@/components/ui";
import { api } from "@/lib/api-client";

export function AcceptInvitation({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await api("/api/v1/invitations/accept", { method: "POST", body: { token } });
      router.replace("/list");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept the invitation");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error ? <Notice tone="red">{error}</Notice> : null}
      <Button onClick={accept} disabled={busy} className="w-full">
        {busy ? "Joining…" : "Accept invitation"}
      </Button>
    </div>
  );
}
