import { requireMember } from "@/features/auth/session";
import { can } from "@/features/households/permissions";
import { handler, ok } from "@/lib/http";
import { revokeCredential } from "@/server/services/household-admin-service";

type Ctx = { params: Promise<{ householdId: string; credentialId: string }> };

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  const { householdId, credentialId } = await params;
  const { user, role } = await requireMember(householdId);
  await revokeCredential({ householdId, credentialId, userId: user.id, isAdmin: can(role, "integrations:manage") });
  return ok({ revoked: true });
});
