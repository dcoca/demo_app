import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Order, Profile, ShoppingCycle, ShoppingItem } from "@/types/domain";

/** Read helpers for Server Components. All run as the user, under RLS. */

export async function openCycleWithItems(householdId: string) {
  const supabase = await createSupabaseServerClient();
  const { data: cycle } = await supabase
    .from("shopping_cycles")
    .select("*")
    .eq("household_id", householdId)
    .eq("status", "open")
    .maybeSingle();
  if (!cycle) return { cycle: null, items: [] as ShoppingItem[] };
  const { data: items } = await supabase
    .from("shopping_items")
    .select("*")
    .eq("cycle_id", cycle.id)
    .neq("status", "removed")
    .order("created_at");
  return { cycle: cycle as ShoppingCycle, items: (items ?? []) as ShoppingItem[] };
}

export async function householdProfiles(householdId: string): Promise<Record<string, Profile>> {
  const supabase = await createSupabaseServerClient();
  const { data: members } = await supabase.from("household_members").select("user_id").eq("household_id", householdId);
  const ids = (members ?? []).map((m) => m.user_id as string);
  if (ids.length === 0) return {};
  const { data } = await supabase.from("profiles").select("id, email, display_name").in("id", ids);
  return Object.fromEntries(((data ?? []) as Profile[]).map((p) => [p.id, p]));
}

export async function orderForCycle(cycleId: string): Promise<Order | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from("orders").select("*").eq("cycle_id", cycleId).maybeSingle();
  return (data as Order | null) ?? null;
}
