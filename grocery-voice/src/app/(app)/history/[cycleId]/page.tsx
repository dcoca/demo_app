import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireActiveHousehold } from "@/features/auth/session";
import { ORDER_STATUS_LABEL } from "@/features/orders/status";
import { Badge, Card } from "@/components/ui";
import { formatDateTime, formatQuantity, SOURCE_LABEL } from "@/lib/format";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { householdProfiles } from "@/server/queries";
import type { Order, OrderSnapshot, ShoppingItem } from "@/types/domain";

export const metadata: Metadata = { title: "Past list" };

export default async function CycleDetailPage({ params }: { params: Promise<{ cycleId: string }> }) {
  const { cycleId } = await params;
  const { active } = await requireActiveHousehold(`/history/${cycleId}`);
  const supabase = await createSupabaseServerClient();

  // RLS returns nothing for cycles in other households.
  const { data: cycle } = await supabase.from("shopping_cycles").select("*").eq("id", cycleId).maybeSingle();
  if (!cycle) notFound();

  const [{ data: items }, { data: order }, profiles] = await Promise.all([
    supabase.from("shopping_items").select("*").eq("cycle_id", cycleId).order("created_at"),
    supabase.from("orders").select("*").eq("cycle_id", cycleId).maybeSingle(),
    householdProfiles(active.householdId),
  ]);
  const o = order as Order | null;
  const [{ data: snapshot }, { data: events }] = await Promise.all([
    o?.current_snapshot_id
      ? supabase.from("order_snapshots").select("*").eq("id", o.current_snapshot_id).maybeSingle()
      : Promise.resolve({ data: null }),
    o ? supabase.from("order_events").select("*").eq("order_id", o.id).order("created_at") : Promise.resolve({ data: [] }),
  ]);
  const snap = snapshot as OrderSnapshot | null;

  return (
    <div className="space-y-4">
      <Link href="/history" className="text-muted text-sm">
        ← History
      </Link>
      <h1 className="text-lg font-semibold">
        Week of {new Date(cycle.started_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
      </h1>
      {o ? <Badge>{ORDER_STATUS_LABEL[o.status]}</Badge> : null}

      {snap ? (
        <Card title={`Ordered list (snapshot v${snap.version})`} description={`Sent ${formatDateTime(snap.created_at)}`}>
          <ul className="divide-y divide-[var(--border)] text-sm">
            {snap.items.map((i) => (
              <li key={i.itemId} className="flex justify-between py-2">
                <span className="first-letter:uppercase">{i.name}{i.brand ? ` · ${i.brand}` : ""}</span>
                <span className="text-muted">{formatQuantity(i.quantity, i.unit)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="Everything added that week">
        <ul className="divide-y divide-[var(--border)] text-sm">
          {((items ?? []) as ShoppingItem[]).map((i) => (
            <li key={i.id} className="flex justify-between gap-2 py-2">
              <span className={i.status === "removed" ? "text-muted line-through" : ""}>
                <span className="first-letter:uppercase">{i.name}</span>
                <span className="text-muted block text-xs">
                  {[i.added_by ? profiles[i.added_by]?.display_name : null, SOURCE_LABEL[i.source], i.status].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="text-muted">{formatQuantity(i.quantity, i.unit)}</span>
            </li>
          ))}
        </ul>
      </Card>

      {events?.length ? (
        <Card title="Order timeline">
          <ol className="space-y-2 text-sm">
            {(events as Array<{ id: string; to_status: Order["status"]; actor_id: string | null; created_at: string; note: string | null }>).map((e) => (
              <li key={e.id}>
                <span className="font-medium">{ORDER_STATUS_LABEL[e.to_status]}</span>
                <span className="text-muted">
                  {" "}· {formatDateTime(e.created_at)}
                  {e.actor_id ? ` · ${profiles[e.actor_id]?.display_name ?? "member"}` : " · system"}
                  {e.note ? ` · ${e.note}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      ) : null}
    </div>
  );
}
