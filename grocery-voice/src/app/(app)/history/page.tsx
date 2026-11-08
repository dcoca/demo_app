import type { Metadata } from "next";
import Link from "next/link";
import { requireActiveHousehold } from "@/features/auth/session";
import { ORDER_STATUS_LABEL } from "@/features/orders/status";
import { Badge } from "@/components/ui";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { OrderStatus } from "@/types/domain";

export const metadata: Metadata = { title: "History" };

export default async function HistoryPage() {
  const { active } = await requireActiveHousehold("/history");
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("shopping_cycles")
    .select("id, sequence, status, started_at, closed_at, orders(status), shopping_items(count)")
    .eq("household_id", active.householdId)
    .order("sequence", { ascending: false })
    .limit(52);

  const cycles = (data ?? []) as unknown as Array<{
    id: string;
    sequence: number;
    status: "open" | "closed";
    started_at: string;
    closed_at: string | null;
    orders: { status: OrderStatus }[] | { status: OrderStatus } | null;
    shopping_items: { count: number }[];
  }>;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Shopping history</h1>
      <ul className="surface divide-y divide-[var(--border)] rounded-2xl">
        {cycles.map((c) => {
          const order = Array.isArray(c.orders) ? c.orders[0] : c.orders;
          return (
            <li key={c.id}>
              <Link href={c.status === "open" ? "/list" : `/history/${c.id}`} className="flex items-center justify-between gap-3 px-4 py-3">
                <span>
                  <span className="font-medium">
                    {c.status === "open" ? "Current list" : `Week of ${new Date(c.started_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                  </span>
                  <span className="text-muted block text-xs">
                    {c.shopping_items[0]?.count ?? 0} items
                    {c.closed_at ? ` · closed ${new Date(c.closed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                  </span>
                </span>
                {order ? <Badge tone={c.status === "open" ? "green" : "neutral"}>{ORDER_STATUS_LABEL[order.status]}</Badge> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
