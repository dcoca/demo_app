import { requireMember } from "@/features/auth/session";
import { AppError } from "@/lib/errors";
import { handler, ok, readJson } from "@/lib/http";
import { addItemsSchema, idempotencyKeySchema } from "@/lib/validation/schemas";
import { SupabaseItemWriter } from "@/server/repositories/supabase-stores";
import { addItems } from "@/server/services/items-service";

type Ctx = { params: Promise<{ householdId: string }> };

/**
 * Add items. Requires an Idempotency-Key header (the client generates one
 * per user action and reuses it on retry), so a retried request can never
 * increase a quantity twice.
 */
export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { householdId } = await params;
  const { user, supabase } = await requireMember(householdId, "list:edit");

  const keyResult = idempotencyKeySchema.safeParse(req.headers.get("idempotency-key") ?? "");
  if (!keyResult.success) throw new AppError("bad_request", "Idempotency-Key header is required");
  const input = await readJson(req, addItemsSchema);

  // The user's own client: add_items() re-checks membership and actor in SQL.
  const result = await addItems(new SupabaseItemWriter(supabase), {
    householdId,
    source: "web",
    items: input.items,
    idempotencyKey: `${user.id}:${keyResult.data}`,
    actorUserId: user.id,
  });
  return ok(result, result.replayed ? 200 : 201);
});
