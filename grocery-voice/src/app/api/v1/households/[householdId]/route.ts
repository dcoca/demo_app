import { requireMember } from "@/features/auth/session";
import { fromDatabaseError } from "@/lib/errors";
import { handler, ok, readJson } from "@/lib/http";
import { updateHouseholdSchema } from "@/lib/validation/schemas";

type Ctx = { params: Promise<{ householdId: string }> };

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { householdId } = await params;
  const { supabase } = await requireMember(householdId, "household:rename");
  const input = await readJson(req, updateHouseholdSchema);
  const { data, error } = await supabase
    .from("households")
    .update({
      ...(input.name ? { name: input.name } : {}),
      ...(input.duplicatePolicy ? { duplicate_policy: input.duplicatePolicy } : {}),
    })
    .eq("id", householdId)
    .select("id, name, duplicate_policy")
    .single();
  if (error) throw fromDatabaseError(error);
  return ok(data);
});
