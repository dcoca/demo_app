"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Badge, Button, Card, Field, Input, Notice, Select } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { DuplicatePolicy, HouseholdRole } from "@/types/domain";

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "red" | "green"; text: string } | null>(null);
  async function run(fn: () => Promise<unknown>, success?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (success) setMessage({ tone: "green", text: success });
      router.refresh();
      return true;
    } catch (err) {
      setMessage({ tone: "red", text: err instanceof Error ? err.message : "Something went wrong" });
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, message, run, setMessage };
}

export function HouseholdSettings(props: { householdId: string; name: string; duplicatePolicy: DuplicatePolicy; canEdit: boolean }) {
  const [name, setName] = useState(props.name);
  const [policy, setPolicy] = useState(props.duplicatePolicy);
  const { busy, message, run } = useAction();

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(
      () => api(`/api/v1/households/${props.householdId}`, { method: "PATCH", body: { name, duplicatePolicy: policy } }),
      "Saved",
    );
  }

  return (
    <Card title="Household">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name" htmlFor="hh-name">
          <Input id="hh-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!props.canEdit} required maxLength={80} />
        </Field>
        <Field
          label="When someone adds an item that's already on the list"
          htmlFor="hh-policy"
          hint="Matching ignores case and simple plurals (Bananas = banana) but never merges different items like organic milk and almond milk."
        >
          <Select id="hh-policy" value={policy} onChange={(e) => setPolicy(e.target.value as DuplicatePolicy)} disabled={!props.canEdit}>
            <option value="increase_quantity">Increase the quantity</option>
            <option value="separate_item">Add it as a separate line</option>
          </Select>
        </Field>
        {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
        {props.canEdit ? (
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        ) : null}
      </form>
    </Card>
  );
}

export function MemberList(props: {
  householdId: string;
  currentUserId: string;
  currentRole: HouseholdRole;
  members: Array<{ userId: string; role: HouseholdRole; name: string; email: string }>;
}) {
  const { busy, message, run } = useAction();
  const router = useRouter();
  const isOwner = props.currentRole === "owner";

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-[var(--border)]">
        {props.members.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span className="min-w-0">
              <span className="font-medium">{m.name}</span>
              {m.userId === props.currentUserId ? <span className="text-muted"> (you)</span> : null}
              <span className="text-muted block truncate text-xs">{m.email}</span>
            </span>
            <span className="flex items-center gap-2">
              {isOwner && m.userId !== props.currentUserId ? (
                <>
                  <label className="sr-only" htmlFor={`role-${m.userId}`}>
                    Role for {m.name}
                  </label>
                  <Select
                    id={`role-${m.userId}`}
                    className="w-28"
                    value={m.role}
                    disabled={busy}
                    onChange={(e) =>
                      run(() =>
                        api(`/api/v1/households/${props.householdId}/members/${m.userId}`, {
                          method: "PATCH",
                          body: { role: e.target.value },
                        }),
                      )
                    }
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                    <option value="owner">Owner</option>
                  </Select>
                  <Button
                    variant="ghost"
                    className="text-red-600"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`Remove ${m.name} from the household?`)) {
                        void run(() => api(`/api/v1/households/${props.householdId}/members/${m.userId}`, { method: "DELETE" }));
                      }
                    }}
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <Badge>{m.role}</Badge>
              )}
            </span>
          </li>
        ))}
      </ul>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Button
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          if (!confirm("Leave this household? You'll lose access to its list.")) return;
          const ok = await run(() => api(`/api/v1/households/${props.householdId}/members/${props.currentUserId}`, { method: "DELETE" }));
          if (ok) router.replace("/list");
        }}
      >
        Leave household
      </Button>
    </div>
  );
}

export function InviteForm(props: { householdId: string; pending: Array<{ id: string; email: string; role: string; expires_at: string }> }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [link, setLink] = useState<string | null>(null);
  const { busy, message, run, setMessage } = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLink(null);
    await run(async () => {
      const res = await api<{ link: string; emailed: boolean }>(`/api/v1/households/${props.householdId}/invitations`, {
        method: "POST",
        body: { email, role },
      });
      setLink(res.link);
      setEmail("");
      setMessage({
        tone: "green",
        text: res.emailed ? "Invitation emailed. You can also share the link below." : "Email couldn't be sent; share this link instead.",
      });
    });
  }

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="invite-email" className="sr-only">
          Email
        </label>
        <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" required />
        <label htmlFor="invite-role" className="sr-only">
          Role
        </label>
        <Select id="invite-role" className="sm:w-32" value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </Select>
        <Button type="submit" disabled={busy}>
          Invite
        </Button>
      </form>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {link ? (
        <Input readOnly value={link} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
      ) : null}
      {props.pending.length ? (
        <ul className="divide-y divide-[var(--border)] text-sm">
          {props.pending.map((inv) => (
            <li key={inv.id} className="flex items-center justify-between py-2">
              <span>
                {inv.email} <Badge>{inv.role}</Badge>
              </span>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => run(() => api(`/api/v1/households/${props.householdId}/invitations/${inv.id}`, { method: "DELETE" }))}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function NotificationToggle({ householdId, enabled }: { householdId: string; enabled: boolean }) {
  const [on, setOn] = useState(enabled);
  const { busy, message, run } = useAction();
  return (
    <div className="space-y-2">
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input
          type="checkbox"
          className="h-5 w-5"
          checked={on}
          disabled={busy}
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            void run(() =>
              api(`/api/v1/households/${householdId}/notification-preferences`, { method: "PUT", body: { emailReminders: next } }),
            ).then((ok) => !ok && setOn(!next));
          }}
        />
        Email me when the list is ready to review
      </label>
      {message?.tone === "red" ? <Notice tone="red">{message.text}</Notice> : null}
    </div>
  );
}
