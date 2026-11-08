import { requireMember } from "@/features/auth/session";
import { AppError, fromDatabaseError } from "@/lib/errors";
import { handler, ok, readJson } from "@/lib/http";
import { memberUpdateSchema } from "@/lib/validation/schemas";

type Ctx = { params: Promise<{ householdId: string; userId: string }> };

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { householdId, userId } = await params;
  const { supabase } = await requireMember(householdId, "members:change_role");
  const input = await readJson(req, memberUpdateSchema);
  const { data, error } = await supabase
    .from("household_members")
    .update({ role: input.role })
    .eq("household_id", householdId)
    .eq("user_id", userId)
    .select("user_id, role");
  if (error) throw fromDatabaseError(error);
  if (!data?.length) throw new AppError("not_found", "Member not found");
  return ok(data[0]);
});

/** Owners remove anyone; anyone may remove themselves (leave). */
export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  const { householdId, userId } = await params;
  const { user, role, supabase } = await requireMember(householdId);
  if (userId !== user.id && role !== "owner") throw new AppError("forbidden", "Only owners can remove members");
  const { data, error } = await supabase
    .from("household_members")
    .delete()
    .eq("household_id", householdId)
    .eq("user_id", userId)
    .select("user_id");
  if (error) throw fromDatabaseError(error);
  if (!data?.length) throw new AppError("not_found", "Member not found");
  return ok({ removed: true });
});
