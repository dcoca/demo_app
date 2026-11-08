import { z } from "zod";
import { setActiveHouseholdCookie, requireMember } from "@/features/auth/session";
import { handler, ok, readJson } from "@/lib/http";

const schema = z.object({ householdId: z.string().uuid() });

export const POST = handler(async (req: Request) => {
  const { householdId } = await readJson(req, schema);
  await requireMember(householdId);
  await setActiveHouseholdCookie(householdId);
  return ok({ householdId });
});
