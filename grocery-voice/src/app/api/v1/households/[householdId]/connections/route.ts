import { requireMember } from "@/features/auth/session";
import { handler, ok, readJson } from "@/lib/http";
import { createConnectionSchema } from "@/lib/validation/schemas";
import { createConnection } from "@/server/services/household-admin-service";

type Ctx = { params: Promise<{ householdId: string }> };

export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { householdId } = await params;
  const { user } = await requireMember(householdId, "integrations:manage");
  const input = await readJson(req, createConnectionSchema);
  const connection = await createConnection({ householdId, userId: user.id, ...input });
  return ok({ connection }, 201);
});
