import { requireMember } from "@/features/auth/session";
import { cleanDisplayName, normalizeItemName, normalizeUnit } from "@/features/shopping/normalize";
import { AppError, fromDatabaseError } from "@/lib/errors";
import { handler, ok, readJson } from "@/lib/http";
import { updateItemSchema } from "@/lib/validation/schemas";

type Ctx = { params: Promise<{ householdId: string; itemId: string }> };

/**
 * Edit, complete, restore or remove an item. Uses optimistic concurrency:
 * the client sends the version it last saw; a stale version returns 409 with
 * the current item so the UI can reconcile instead of overwriting.
 */
export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { householdId, itemId } = await params;
  const { supabase } = await requireMember(householdId, "list:edit");
  const input = await readJson(req, updateItemSchema);

  const { data: current, error: readError } = await supabase
    .from("shopping_items")
    .select("*, shopping_cycles(status)")
    .eq("id", itemId)
    .eq("household_id", householdId)
    .maybeSingle();
  if (readError) throw fromDatabaseError(readError);
  if (!current) throw new AppError("not_found", "Item not found");
  if ((current.shopping_cycles as { status: string } | null)?.status !== "open") {
    throw new AppError("conflict", "Items from previous shopping cycles are read-only");
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = cleanDisplayName(input.name);
    const normalized = normalizeItemName(name);
    if (!normalized) throw new AppError("bad_request", "Item name is empty");
    patch.name = name;
    patch.normalized_name = normalized;
  }
  if (input.quantity !== undefined) patch.quantity = input.quantity;
  if (input.unit !== undefined) patch.unit = normalizeUnit(input.unit);
  if (input.brand !== undefined) patch.brand = input.brand;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.organic !== undefined) patch.organic = input.organic;
  if (input.upc !== undefined) patch.upc = input.upc;
  if (input.status !== undefined) patch.status = input.status;
  if (Object.keys(patch).length === 0) throw new AppError("bad_request", "Nothing to update");

  const { data, error } = await supabase
    .from("shopping_items")
    .update(patch)
    .eq("id", itemId)
    .eq("household_id", householdId)
    .eq("version", input.expectedVersion)
    .select("*")
    .maybeSingle();
  if (error) throw fromDatabaseError(error);
  if (!data) {
    const { data: latest } = await supabase.from("shopping_items").select("*").eq("id", itemId).maybeSingle();
    throw new AppError("conflict", "This item was changed by someone else", { current: latest });
  }
  return ok(data);
});
