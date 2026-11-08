import { z } from "zod";
import { setActiveHouseholdCookie, requireApiUser } from "@/features/auth/session";
import { sha256Hex } from "@/lib/crypto";
import { fromDatabaseError } from "@/lib/errors";
import { handler, ok, readJson } from "@/lib/http";

const schema = z.object({ token: z.string().regex(/^[A-Za-z0-9]{40}$/) });

export const POST = handler(async (req: Request) => {
  const { supabase } = await requireApiUser();
  const { token } = await readJson(req, schema);
  const { data, error } = await supabase.rpc("accept_invitation", { p_token_hash: sha256Hex(token) });
  if (error) throw fromDatabaseError(error);
  await setActiveHouseholdCookie(data as string);
  return ok({ householdId: data });
});
