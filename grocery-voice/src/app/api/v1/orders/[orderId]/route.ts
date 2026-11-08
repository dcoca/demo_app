import { requireApiUser } from "@/features/auth/session";
import { AppError } from "@/lib/errors";
import { handler, ok, readJson } from "@/lib/http";
import { orderActionSchema } from "@/lib/validation/schemas";
import { orderDeps } from "@/server/container";
import {
  applySimpleAction,
  closeCycle,
  generateLink,
  getOrderView,
  openHandoff,
  reopen,
} from "@/server/services/order-service";

type Ctx = { params: Promise<{ orderId: string }> };

/** Membership is proven by reading the order through RLS with the user's session. */
async function authorize(orderId: string) {
  const { user, supabase } = await requireApiUser();
  const { data } = await supabase.from("orders").select("id").eq("id", orderId).maybeSingle();
  if (!data) throw new AppError("not_found", "Order not found");
  return user;
}

export const GET = handler(async (_req: Request, { params }: Ctx) => {
  const { orderId } = await params;
  await authorize(orderId);
  return ok(await getOrderView(orderDeps(), orderId));
});

export const POST = handler(async (req: Request, { params }: Ctx) => {
  const { orderId } = await params;
  const user = await authorize(orderId);
  const { action } = await readJson(req, orderActionSchema);
  const deps = orderDeps();

  switch (action) {
    case "generate_link": {
      const { link, snapshot, reused } = await generateLink(deps, orderId, user.id);
      return ok({ url: link.url, isMock: link.is_mock, snapshotVersion: snapshot.version, reused });
    }
    case "open_handoff":
      return ok(await openHandoff(deps, orderId, user.id));
    case "reopen":
      return ok({ order: await reopen(deps, orderId, user.id) });
    case "close_cycle":
      return ok(await closeCycle(deps, orderId, user.id));
    default:
      return ok({ order: await applySimpleAction(deps, orderId, action, user.id) });
  }
});
