import { setActiveHouseholdCookie, requireApiUser } from "@/features/auth/session";
import { fromDatabaseError } from "@/lib/errors";
import { handler, ok, readJson } from "@/lib/http";
import { createHouseholdSchema } from "@/lib/validation/schemas";

export const POST = handler(async (req: Request) => {
  const { supabase } = await requireApiUser();
  const input = await readJson(req, createHouseholdSchema);
  const { data, error } = await supabase.rpc("create_household", { p_name: input.name, p_timezone: input.timezone });
  if (error) throw fromDatabaseError(error);
  await setActiveHouseholdCookie(data as string);
  return ok({ householdId: data }, 201);
});
