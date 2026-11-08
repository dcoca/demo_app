import type { Metadata } from "next";
import { requireActiveHousehold } from "@/features/auth/session";
import { OrderPanel } from "@/features/orders/order-panel";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { householdProfiles, openCycleWithItems, orderForCycle } from "@/server/queries";
import { orderDeps } from "@/server/container";
import { getOrderView } from "@/server/services/order-service";
import type { HouseholdSchedule } from "@/types/domain";

export const metadata: Metadata = { title: "Order" };

export default async function OrderPage() {
  const { active } = await requireActiveHousehold("/order");
  const { cycle, items } = await openCycleWithItems(active.householdId);
  const order = cycle ? await orderForCycle(cycle.id) : null;
  if (!cycle || !order) return <p className="text-muted text-sm">No open order.</p>;

  // Membership was proven above by reading the order through RLS.
  const deps = orderDeps();
  const [view, profiles] = await Promise.all([getOrderView(deps, order.id), householdProfiles(active.householdId)]);
  const supabase = await createSupabaseServerClient();
  const { data: schedule } = await supabase
    .from("household_schedules")
    .select("*")
    .eq("household_id", active.householdId)
    .maybeSingle();

  return (
    <OrderPanel
      view={view}
      activeItems={items.filter((i) => i.status === "active")}
      profiles={profiles}
      providerIsMock={deps.provider.isMock}
      schedule={(schedule as HouseholdSchedule | null) ?? null}
    />
  );
}
