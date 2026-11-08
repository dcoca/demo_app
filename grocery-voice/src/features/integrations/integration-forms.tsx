"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Badge, Button, Field, Input, Notice } from "@/components/ui";
import { api } from "@/lib/api-client";
import { formatDateTime, timeAgo } from "@/lib/format";
import type { IntegrationConnection, IntegrationCredential, IntegrationHealth } from "@/types/domain";

const HEALTH_TONE: Record<IntegrationHealth, "green" | "amber" | "red" | "neutral"> = {
  healthy: "green",
  degraded: "amber",
  failing: "red",
  unknown: "neutral",
  disabled: "neutral",
};

export function CredentialManager({ householdId, credentials }: { householdId: string; credentials: IntegrationCredential[] }) {
  const router = useRouter();
  const [label, setLabel] = useState("My iPhone");
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string }>(`/api/v1/households/${householdId}/credentials`, {
        method: "POST",
        body: { label, allowedSources: ["siri"] },
      });
      setToken(res.token);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create token");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this token? Shortcuts using it will stop working.")) return;
    try {
      await api(`/api/v1/households/${householdId}/credentials/${id}`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke");
    }
  }

  const endpoint = typeof window === "undefined" ? "/api/v1/ingest" : `${window.location.origin}/api/v1/ingest`;

  return (
    <div className="space-y-4">
      {token ? (
        <div className="space-y-3">
          <Notice tone="amber">
            Copy this token now. It won&apos;t be shown again. Paste it into the Shortcut&apos;s Authorization header only;
            never put it in a URL.
          </Notice>
          <Input readOnly value={token} aria-label="New token" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
          <dl className="surface grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl p-3 text-xs">
            <dt className="text-muted">URL</dt>
            <dd className="break-all font-mono">{endpoint}</dd>
            <dt className="text-muted">Method</dt>
            <dd className="font-mono">POST</dd>
            <dt className="text-muted">Header</dt>
            <dd className="break-all font-mono">Authorization: Bearer &lt;token&gt;</dd>
            <dt className="text-muted">householdId</dt>
            <dd className="break-all font-mono">{householdId}</dd>
          </dl>
          <Button variant="secondary" onClick={() => setToken(null)}>
            Done
          </Button>
        </div>
      ) : (
        <form onSubmit={create} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="Device name" htmlFor="cred-label">
              <Input id="cred-label" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={60} />
            </Field>
          </div>
          <Button type="submit" disabled={busy}>
            Create Siri token
          </Button>
        </form>
      )}
      {error ? <Notice tone="red">{error}</Notice> : null}
      {credentials.length ? (
        <ul className="divide-y divide-[var(--border)] text-sm">
          {credentials.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium">{c.label}</span>{" "}
                <span className="text-muted font-mono text-xs">gv_{c.token_prefix}_…</span>
                <span className="text-muted block text-xs">
                  {c.last_used_at ? `Last used ${timeAgo(c.last_used_at)}` : "Never used"} · {c.allowed_sources.join(", ")}
                </span>
              </span>
              <Button variant="ghost" className="text-red-600" onClick={() => revoke(c.id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ConnectionManager({
  householdId,
  connections,
  runs,
  canManage,
}: {
  householdId: string;
  connections: IntegrationConnection[];
  runs: Array<{ id: string; connection_id: string; started_at: string; status: string; fetched: number; imported: number; already_mapped: number; error: string | null }>;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "red" | "green"; text: string } | null>(null);
  const [form, setForm] = useState({
    label: "Alexa via Home Assistant",
    baseUrl: "",
    entityId: "todo.alexa_shopping_list",
    accessToken: "",
    pollMinutes: 5,
  });

  async function run(id: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(id);
    setMessage(null);
    try {
      const result = await fn();
      if (success) setMessage({ tone: "green", text: success });
      router.refresh();
      return result;
    } catch (err) {
      setMessage({ tone: "red", text: err instanceof Error ? err.message : "Something went wrong" });
    } finally {
      setBusy(null);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    await run(
      "create",
      () =>
        api(`/api/v1/households/${householdId}/connections`, {
          method: "POST",
          body: {
            label: form.label,
            baseUrl: form.baseUrl,
            entityId: form.entityId,
            accessToken: form.accessToken,
            pollIntervalSeconds: form.pollMinutes * 60,
          },
        }),
      "Connected. Items on your Alexa list will appear within a few minutes.",
    );
    setForm((f) => ({ ...f, accessToken: "" }));
  }

  return (
    <div className="space-y-4">
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {connections.map((c) => {
        const lastRun = runs.find((r) => r.connection_id === c.id);
        return (
          <div key={c.id} className="surface space-y-2 rounded-xl p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{c.label}</span>
              <Badge tone={HEALTH_TONE[c.health]}>{c.health}</Badge>
            </div>
            <p className="text-muted break-all text-xs">
              {c.entity_id} · {c.base_url} · every {Math.round(c.poll_interval_seconds / 60)} min
            </p>
            <p className="text-muted text-xs">
              Last success: {c.last_success_at ? formatDateTime(c.last_success_at) : "never"}
              {c.consecutive_failures ? ` · ${c.consecutive_failures} failed attempt(s) in a row` : ""}
            </p>
            {c.last_error ? <p className="text-xs text-red-600">{c.last_error}</p> : null}
            {lastRun ? (
              <p className="text-muted text-xs">
                Last run {timeAgo(lastRun.started_at)}: {lastRun.status}, {lastRun.fetched} on Alexa list, {lastRun.imported} new
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                variant="secondary"
                disabled={!!busy || !c.enabled}
                onClick={() =>
                  run(c.id, async () => {
                    const r = await api<{ imported: number; fetched: number }>(
                      `/api/v1/households/${householdId}/connections/${c.id}/sync`,
                      { method: "POST" },
                    );
                    setMessage({ tone: "green", text: `Synced: ${r.imported} new of ${r.fetched} on the Alexa list.` });
                  })
                }
              >
                {busy === c.id ? "Syncing…" : "Sync now"}
              </Button>
              {canManage ? (
                <>
                  <Button
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() =>
                      run(c.id, () =>
                        api(`/api/v1/households/${householdId}/connections/${c.id}`, { method: "PATCH", body: { enabled: !c.enabled } }),
                      )
                    }
                  >
                    {c.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-red-600"
                    disabled={!!busy}
                    onClick={() =>
                      confirm("Disconnect? Items already imported stay on your list.") &&
                      run(c.id, () => api(`/api/v1/households/${householdId}/connections/${c.id}`, { method: "DELETE" }))
                    }
                  >
                    Disconnect
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        );
      })}

      {canManage && connections.length === 0 ? (
        <form onSubmit={create} className="space-y-3">
          <Field label="Home Assistant URL" htmlFor="ha-url" hint="Your Home Assistant Cloud (Nabu Casa) or other public https URL.">
            <Input
              id="ha-url"
              type="url"
              placeholder="https://example.ui.nabu.casa"
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              required
            />
          </Field>
          <Field label="Shopping list entity" htmlFor="ha-entity" hint="Find it in Home Assistant under Settings → Entities, filtered by 'todo'.">
            <Input id="ha-entity" value={form.entityId} onChange={(e) => setForm({ ...form, entityId: e.target.value })} required />
          </Field>
          <Field label="Long-lived access token" htmlFor="ha-token" hint="Create one in Home Assistant under your profile → Security. Stored encrypted.">
            <Input
              id="ha-token"
              type="password"
              autoComplete="off"
              value={form.accessToken}
              onChange={(e) => setForm({ ...form, accessToken: e.target.value })}
              required
            />
          </Field>
          <Field label="Check every (minutes)" htmlFor="ha-poll">
            <Input
              id="ha-poll"
              type="number"
              min={1}
              max={1440}
              value={form.pollMinutes}
              onChange={(e) => setForm({ ...form, pollMinutes: Number(e.target.value) })}
            />
          </Field>
          <Button type="submit" disabled={!!busy}>
            {busy === "create" ? "Checking connection…" : "Connect"}
          </Button>
        </form>
      ) : null}
      {!canManage && connections.length === 0 ? <p className="text-muted text-sm">An owner or admin can connect Alexa.</p> : null}
    </div>
  );
}
