import { requireMember } from "@/features/auth/session";
import { AppError, fromDatabaseError } from "@/lib/errors";
import { handler, ok } from "@/lib/http";

type Ctx = { params: Promise<{ householdId: string; invitationId: string }> };

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  const { householdId, invitationId } = await params;
  const { supabase } = await requireMember(householdId, "members:invite");
  const { data, error } = await supabase
    .from("household_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", invitationId)
    .eq("household_id", householdId)
    .is("accepted_at", null)
    .select("id");
  if (error) throw fromDatabaseError(error);
  if (!data?.length) throw new AppError("not_found", "Invitation not found");
  return ok({ revoked: true });
});
