import { requireMember } from "@/features/auth/session";
import { handler, ok, readJson } from "@/lib/http";
import { inviteSchema } from "@/lib/validation/schemas";
import { createInvitation } from "@/server/services/household-admin-service";

type Ctx = { params: Promise<{ householdId: string }> };

export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { householdId } = await params;
  const { user, supabase } = await requireMember(householdId, "members:invite");
  const input = await readJson(req, inviteSchema);
  const { data: household } = await supabase.from("households").select("name").eq("id", householdId).single();
  const result = await createInvitation(supabase, {
    householdId,
    email: input.email,
    role: input.role,
    invitedBy: user.id,
    householdName: household?.name ?? "a household",
  });
  return ok(result, 201);
});
