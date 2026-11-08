import { requireMember } from "@/features/auth/session";
import { handler, ok, readJson } from "@/lib/http";
import { updateConnectionSchema } from "@/lib/validation/schemas";
import { deleteConnection, updateConnection } from "@/server/services/household-admin-service";

type Ctx = { params: Promise<{ householdId: string; connectionId: string }> };

export const PATCH = handler(async (req: Request, { params }: Ctx) => {
  const { householdId, connectionId } = await params;
  await requireMember(householdId, "integrations:manage");
  const input = await readJson(req, updateConnectionSchema);
  return ok({ connection: await updateConnection(householdId, connectionId, input) });
});

export const DELETE = handler(async (_req: Request, { params }: Ctx) => {
  const { householdId, connectionId } = await params;
  await requireMember(householdId, "integrations:manage");
  await deleteConnection(householdId, connectionId);
  return ok({ deleted: true });
});
