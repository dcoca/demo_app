"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, Notice } from "@/components/ui";
import { api } from "@/lib/api-client";
import { formatDateTime, formatQuantity } from "@/lib/format";
import { WEEKDAYS } from "@/features/scheduling/schedule";
import type { OrderView } from "@/server/services/order-service";
import type { HouseholdSchedule, OrderAction, Profile, ShoppingItem } from "@/types/domain-client";
import { ORDER_STATUS_LABEL } from "./status";

const STEPS = ["Review", "Approve", "Instacart link", "Checkout"] as const;

function stepIndex(status: OrderView["order"]["status"]): number {
  switch (status) {
    case "draft":
    case "ready_for_review":
      return 0;
    case "approved":
      return 1;
    case "link_generated":
      return 2;
    default:
      return 3;
  }
}

export function OrderPanel({
  view,
  activeItems,
  profiles,
  providerIsMock,
  schedule,
}: {
  view: OrderView;
  activeItems: ShoppingItem[];
  profiles: Record<string, Profile>;
  providerIsMock: boolean;
  schedule: HouseholdSchedule | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<OrderAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { order, snapshot, link, listChangedSinceSnapshot } = view;

  async function act(action: OrderAction) {
    setBusy(action);
    setError(null);
    setNotice(null);
    // Open the tab synchronously so mobile browsers don't block it as a popup.
    const tab = action === "open_handoff" ? window.open("about:blank", "_blank") : null;
    if (tab) tab.opener = null; // the provider page gets no handle back to this app
    try {
      const result = await api<{ url?: string; regenerated?: boolean; carriedOver?: number }>(`/api/v1/orders/${order.id}`, {
        method: "POST",
        body: { action },
      });
      if (action === "open_handoff" && result.url) {
        if (tab) tab.location.href = result.url;
        else window.location.href = result.url;
        if (result.regenerated) setNotice("Your list had changed, so we created a fresh Instacart link first.");
      }
      if (action === "close_cycle") {
        setNotice(
          result.carriedOver
            ? `New list started. ${result.carriedOver} item(s) added after the order moved to the new list.`
            : "New list started.",
        );
      }
      router.refresh();
    } catch (err) {
      tab?.close();
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  const step = stepIndex(order.status);
  const completedBy = order.completed_by ? profiles[order.completed_by]?.display_name ?? "A member" : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">This week&apos;s order</h1>
        <p className="text-muted text-sm">
          {ORDER_STATUS_LABEL[order.status]}
          {schedule?.enabled && schedule.next_shopping_date
            ? ` · next shopping day ${WEEKDAYS[schedule.shopping_weekday]}, cutoff ${schedule.order_cutoff_time.slice(0, 5)}`
            : ""}
        </p>
      </div>

      <ol className="grid grid-cols-4 gap-1 text-center text-xs" aria-label="Order progress">
        {STEPS.map((label, i) => (
          <li key={label} aria-current={i === step ? "step" : undefined}>
            <div className={`h-1.5 rounded-full ${i <= step ? "bg-brand-500" : "bg-black/10 dark:bg-white/10"}`} />
            <span className={i === step ? "mt-1 block font-medium" : "text-muted mt-1 block"}>{label}</span>
          </li>
        ))}
      </ol>

      {providerIsMock ? (
        <Notice tone="amber">
          Instacart is in <strong>mock mode</strong>: no API key is configured, so links open a preview page inside
          Grocery Voice and nothing is sent to Instacart.
        </Notice>
      ) : null}
      {error ? <Notice tone="red">{error}</Notice> : null}
      {notice ? <Notice tone="green">{notice}</Notice> : null}

      {order.status === "completed_unverified" ? (
        <Card title="Marked as ordered">
          <p className="text-sm">
            {completedBy} said the order was placed{order.completed_at ? ` on ${formatDateTime(order.completed_at)}` : ""}.
            Grocery Voice can&apos;t see Instacart checkouts, so this is <strong>not verified</strong> with Instacart.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => act("close_cycle")} disabled={!!busy}>
              {busy === "close_cycle" ? "Starting…" : "Start next week's list"}
            </Button>
            <Button variant="secondary" onClick={() => act("undo_confirm")} disabled={!!busy}>
              I haven&apos;t ordered yet
            </Button>
          </div>
        </Card>
      ) : null}

      {(order.status === "link_generated" || order.status === "handoff_opened") && link?.url ? (
        <Card
          title={link.is_mock ? "Mock Instacart link ready" : "Instacart link ready"}
          description={
            snapshot
              ? `Snapshot v${snapshot.version} · ${snapshot.item_count} items · created ${formatDateTime(snapshot.created_at)}`
              : undefined
          }
        >
          {listChangedSinceSnapshot ? (
            <div className="mb-3">
              <Notice tone="amber">The list changed after this link was made. Opening Instacart will create an updated link.</Notice>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => act("open_handoff")} disabled={!!busy}>
              {busy === "open_handoff" ? "Opening…" : link.is_mock ? "Open mock Instacart page" : "Open Instacart"}
            </Button>
            {order.status === "handoff_opened" ? (
              <Button variant="secondary" onClick={() => act("confirm_placed")} disabled={!!busy}>
                I placed the order
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => act("reopen")} disabled={!!busy}>
              Edit list
            </Button>
          </div>
          <p className="text-muted mt-3 text-xs">
            You choose a store and check out on Instacart. Grocery Voice never buys anything for you.
          </p>
        </Card>
      ) : null}

      {order.status === "approved" ? (
        <Card title="Approved" description={`${activeItems.length} items are ready to send to Instacart.`}>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => act("generate_link")} disabled={!!busy || activeItems.length === 0}>
              {busy === "generate_link" ? "Creating link…" : "Create Instacart link"}
            </Button>
            <Button variant="ghost" onClick={() => act("reopen")} disabled={!!busy}>
              Back to review
            </Button>
          </div>
        </Card>
      ) : null}

      {order.status === "draft" || order.status === "ready_for_review" ? (
        <Card title="Review the list" description="Check quantities and notes, then approve. You can still change things later.">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => act("approve")} disabled={!!busy || activeItems.length === 0}>
              {busy === "approve" ? "Approving…" : `Approve ${activeItems.length} items`}
            </Button>
            <Link href="/list" className="inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-medium hover:bg-black/5">
              Edit list
            </Link>
          </div>
        </Card>
      ) : null}

      <Card title={`Items (${activeItems.length})`}>
        {activeItems.length === 0 ? (
          <p className="text-muted text-sm">The list is empty.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] text-sm">
            {activeItems.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="font-medium first-letter:uppercase">{item.name}</span>
                  {item.brand ? <span className="text-muted"> · {item.brand}</span> : null}
                  {item.notes ? <span className="text-muted block truncate text-xs">{item.notes}</span> : null}
                </span>
                <span className="flex shrink-0 gap-1">
                  {item.organic ? <Badge tone="green">organic</Badge> : null}
                  {formatQuantity(item.quantity, item.unit) ? <Badge>{formatQuantity(item.quantity, item.unit)}</Badge> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
