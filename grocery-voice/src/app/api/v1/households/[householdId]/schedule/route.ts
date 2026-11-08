import { requireMember } from "@/features/auth/session";
import { handler, ok, readJson } from "@/lib/http";
import { scheduleSchema } from "@/lib/validation/schemas";
import { saveSchedule } from "@/server/services/household-admin-service";

type Ctx = { params: Promise<{ householdId: string }> };

export const PUT = handler(async (req: Request, { params }: Ctx) => {
  const { householdId } = await params;
  const { supabase } = await requireMember(householdId, "schedule:edit");
  const input = await readJson(req, scheduleSchema);
  return ok(await saveSchedule(supabase, householdId, input));
});
