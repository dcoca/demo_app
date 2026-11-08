import { requireMember } from "@/features/auth/session";
import { handler, ok, readJson } from "@/lib/http";
import { createCredentialSchema } from "@/lib/validation/schemas";
import { createCredential } from "@/server/services/household-admin-service";

type Ctx = { params: Promise<{ householdId: string }> };

/** Returns the raw token once. It is never stored or retrievable again. */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { householdId } = await params;
  const { user } = await requireMember(householdId, "credentials:create_own");
  const input = await readJson(req, createCredentialSchema);
  return ok(await createCredential({ householdId, userId: user.id, ...input }), 201);
});
