import type { Metadata } from "next";
import { requireActiveHousehold } from "@/features/auth/session";
import { ShoppingList } from "@/features/shopping/shopping-list";
import { householdProfiles, openCycleWithItems, orderForCycle } from "@/server/queries";
import { ORDER_STATUS_LABEL } from "@/features/orders/status";
import Link from "next/link";

export const metadata: Metadata = { title: "List" };

export default async function ListPage() {
  const { user, active } = await requireActiveHousehold("/list");
  const [{ cycle, items }, profiles] = await Promise.all([
    openCycleWithItems(active.householdId),
    householdProfiles(active.householdId),
  ]);
  const order = cycle ? await orderForCycle(cycle.id) : null;

  return (
    <div className="space-y-4">
      {order && order.status !== "draft" ? (
        <Link href="/order" className="surface flex items-center justify-between rounded-2xl px-4 py-3 text-sm">
          <span>
            Order: <span className="font-medium">{ORDER_STATUS_LABEL[order.status]}</span>
          </span>
          <span aria-hidden>→</span>
        </Link>
      ) : null}
      {cycle ? (
        <ShoppingList
          householdId={active.householdId}
          cycleId={cycle.id}
          initialItems={items}
          profiles={profiles}
          currentUserId={user.id}
        />
      ) : (
        <p className="text-muted text-sm">No open shopping cycle.</p>
      )}
    </div>
  );
}
