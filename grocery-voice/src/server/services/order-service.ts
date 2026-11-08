import { AppError } from "@/lib/errors";
import { buildSnapshotItems, snapshotContentHash } from "@/features/orders/snapshot";
import { canTransition, LINKABLE_STATUSES } from "@/features/orders/status";
import type { Order, OrderSnapshot, OrderStatus, ShoppingItem, ShoppingLink, SnapshotItem } from "@/types/domain";
import type { GroceryOrderingProvider } from "../integrations/types";

export interface OrderStore {
  getOrder(orderId: string): Promise<Order | null>;
  householdName(householdId: string): Promise<string>;
  cycleItems(cycleId: string): Promise<ShoppingItem[]>;
  getSnapshot(snapshotId: string): Promise<OrderSnapshot | null>;
  /** Returns the snapshot with this content, creating the next version if new. */
  upsertSnapshot(input: {
    orderId: string;
    householdId: string;
    items: SnapshotItem[];
    contentHash: string;
    createdBy: string | null;
  }): Promise<OrderSnapshot>;
  setCurrentSnapshot(orderId: string, snapshotId: string): Promise<void>;
  getLink(snapshotId: string, provider: string): Promise<ShoppingLink | null>;
  /**
   * Inserts a pending link row, or takes over a failed/stale/expiring one.
   * Returns null when another request currently holds the claim.
   */
  claimLink(input: {
    orderId: string;
    snapshotId: string;
    householdId: string;
    provider: string;
    isMock: boolean;
    staleBefore: Date;
    refreshBefore: Date;
  }): Promise<ShoppingLink | null>;
  completeLink(linkId: string, result: { url: string; isMock: boolean; expiresAt: Date | null }): Promise<ShoppingLink>;
  failLink(linkId: string, error: string): Promise<void>;
  transition(orderId: string, to: OrderStatus, expectedFrom: OrderStatus[], actorId: string, note?: string): Promise<Order>;
  closeCycle(orderId: string, actorId: string): Promise<{ newCycleId: string; carriedOver: number }>;
}

export interface OrderDeps {
  store: OrderStore;
  provider: GroceryOrderingProvider;
  appUrl: string;
  now?: () => Date;
}

const CLAIM_STALE_MS = 60_000;
const REFRESH_IF_EXPIRING_MS = 24 * 3600 * 1000;

export interface LinkOutcome {
  link: ShoppingLink;
  snapshot: OrderSnapshot;
  reused: boolean;
}

async function requireOrder(store: OrderStore, orderId: string): Promise<Order> {
  const order = await store.getOrder(orderId);
  if (!order) throw new AppError("not_found", "Order not found");
  return order;
}

async function currentSnapshotItems(store: OrderStore, order: Order) {
  const items = buildSnapshotItems(await store.cycleItems(order.cycle_id));
  return { items, hash: snapshotContentHash(items) };
}

/**
 * Snapshot the list and get a provider link for it.
 *   - Same content as an existing snapshot  -> same snapshot row.
 *   - Snapshot already has a usable link     -> reuse it (no provider call).
 *   - Concurrent/retried requests             -> one claim wins; others get 409.
 */
export async function generateLink(deps: OrderDeps, orderId: string, actorId: string): Promise<LinkOutcome> {
  const now = deps.now?.() ?? new Date();
  const order = await requireOrder(deps.store, orderId);
  if (!LINKABLE_STATUSES.includes(order.status)) {
    throw new AppError("conflict", "Approve the list before creating an Instacart link");
  }

  const { items, hash } = await currentSnapshotItems(deps.store, order);
  if (items.length === 0) throw new AppError("unprocessable", "The list is empty");

  const snapshot = await deps.store.upsertSnapshot({
    orderId,
    householdId: order.household_id,
    items,
    contentHash: hash,
    createdBy: actorId,
  });
  if (order.current_snapshot_id !== snapshot.id) await deps.store.setCurrentSnapshot(orderId, snapshot.id);

  const existing = await deps.store.getLink(snapshot.id, deps.provider.providerId);
  if (
    existing?.status === "ready" &&
    existing.url &&
    existing.is_mock === deps.provider.isMock &&
    (!existing.expires_at || new Date(existing.expires_at).getTime() > now.getTime() + REFRESH_IF_EXPIRING_MS)
  ) {
    if (order.status === "approved") {
      await deps.store.transition(orderId, "link_generated", ["approved"], actorId);
    }
    return { link: existing, snapshot, reused: true };
  }

  const claimed = await deps.store.claimLink({
    orderId,
    snapshotId: snapshot.id,
    householdId: order.household_id,
    provider: deps.provider.providerId,
    isMock: deps.provider.isMock,
    staleBefore: new Date(now.getTime() - CLAIM_STALE_MS),
    refreshBefore: new Date(now.getTime() + REFRESH_IF_EXPIRING_MS),
  });
  if (!claimed) throw new AppError("conflict", "A link is already being created. Try again in a moment.");

  const household = await deps.store.householdName(order.household_id);
  let link: ShoppingLink;
  try {
    const result = await deps.provider.createShoppingLink({
      title: `${household} groceries`,
      items: snapshot.items,
      linkbackUrl: `${deps.appUrl}/order`,
    });
    link = await deps.store.completeLink(claimed.id, result);
  } catch (error) {
    await deps.store.failLink(claimed.id, error instanceof Error ? error.message : "failed");
    throw new AppError("upstream_error", "Could not create the Instacart link. Your list is unchanged; try again.");
  }

  const latest = await requireOrder(deps.store, orderId);
  if (latest.status !== "link_generated" && canTransition(latest.status, "link_generated")) {
    await deps.store.transition(orderId, "link_generated", [latest.status], actorId, `Snapshot v${snapshot.version}`);
  }
  return { link, snapshot, reused: false };
}

/**
 * Called when someone taps "Open Instacart". If the list changed since the
 * link was made, a fresh snapshot and link are created first. Opening the
 * link is recorded as handoff_opened; it says nothing about checkout.
 */
export async function openHandoff(deps: OrderDeps, orderId: string, actorId: string) {
  const order = await requireOrder(deps.store, orderId);
  if (!["link_generated", "handoff_opened"].includes(order.status)) {
    throw new AppError("conflict", "Create the Instacart link first");
  }
  const outcome = await generateLink(deps, orderId, actorId); // reuses when unchanged
  const latest = await requireOrder(deps.store, orderId);
  if (latest.status !== "handoff_opened") {
    await deps.store.transition(orderId, "handoff_opened", [latest.status], actorId);
  }
  return { url: outcome.link.url!, isMock: outcome.link.is_mock, regenerated: !outcome.reused };
}

export interface OrderView {
  order: Order;
  snapshot: OrderSnapshot | null;
  link: ShoppingLink | null;
  /** True when active items differ from what the current link contains. */
  listChangedSinceSnapshot: boolean;
}

export async function getOrderView(deps: Pick<OrderDeps, "store" | "provider">, orderId: string): Promise<OrderView> {
  const order = await requireOrder(deps.store, orderId);
  const snapshot = order.current_snapshot_id ? await deps.store.getSnapshot(order.current_snapshot_id) : null;
  const link = snapshot ? await deps.store.getLink(snapshot.id, deps.provider.providerId) : null;
  const { hash } = await currentSnapshotItems(deps.store, order);
  return { order, snapshot, link, listChangedSinceSnapshot: snapshot ? snapshot.content_hash !== hash : false };
}

const SIMPLE_ACTIONS: Record<string, { to: OrderStatus; from: OrderStatus[]; note?: string }> = {
  mark_ready: { to: "ready_for_review", from: ["draft"] },
  approve: { to: "approved", from: ["draft", "ready_for_review"] },
  // Explicit user statement that checkout happened on Instacart. Unverified.
  confirm_placed: { to: "completed_unverified", from: ["handoff_opened"], note: "Confirmed by member" },
  undo_confirm: { to: "handoff_opened", from: ["completed_unverified"] },
};

export async function applySimpleAction(
  deps: Pick<OrderDeps, "store">,
  orderId: string,
  action: keyof typeof SIMPLE_ACTIONS,
  actorId: string,
): Promise<Order> {
  const spec = SIMPLE_ACTIONS[action];
  if (!spec) throw new AppError("bad_request", "Unknown action");
  return deps.store.transition(orderId, spec.to, spec.from, actorId, spec.note);
}

/** Back to editing: approved -> ready_for_review, link states -> approved. */
export async function reopen(deps: Pick<OrderDeps, "store">, orderId: string, actorId: string): Promise<Order> {
  const order = await requireOrder(deps.store, orderId);
  const to: OrderStatus = order.status === "approved" ? "ready_for_review" : "approved";
  if (!canTransition(order.status, to)) throw new AppError("conflict", "This order cannot be reopened");
  return deps.store.transition(orderId, to, [order.status], actorId, "Reopened for edits");
}

export async function closeCycle(deps: Pick<OrderDeps, "store">, orderId: string, actorId: string) {
  return deps.store.closeCycle(orderId, actorId);
}
