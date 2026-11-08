import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { canTransition } from "@/features/orders/status";
import { AppError } from "@/lib/errors";
import { MockInstacartProvider } from "@/server/integrations/instacart/instacart-provider";
import type { GroceryOrderingProvider, ShoppingLinkRequest, ShoppingLinkResult } from "@/server/integrations/types";
import { applySimpleAction, generateLink, getOrderView, openHandoff, type OrderStore } from "@/server/services/order-service";
import type { Order, OrderSnapshot, OrderStatus, ShoppingItem, ShoppingLink, SnapshotItem } from "@/types/domain";

class MemoryOrderStore implements OrderStore {
  order: Order;
  items: ShoppingItem[] = [];
  snapshots: OrderSnapshot[] = [];
  links: ShoppingLink[] = [];
  events: Array<[OrderStatus, OrderStatus]> = [];

  constructor() {
    const now = new Date().toISOString();
    this.order = {
      id: "order-1",
      household_id: "hh-1",
      cycle_id: "cycle-1",
      status: "draft",
      provider: "instacart",
      current_snapshot_id: null,
      approved_by: null,
      approved_at: null,
      completed_by: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    };
  }
  addItem(name: string, extra: Partial<ShoppingItem> = {}) {
    const now = new Date(Date.now() + this.items.length).toISOString();
    const item: ShoppingItem = {
      id: randomUUID(), household_id: "hh-1", cycle_id: "cycle-1", name, normalized_name: name,
      quantity: null, unit: null, brand: null, notes: null, organic: false, upc: null,
      status: "active", source: "web", added_by: "u1", added_by_label: null,
      created_at: now, updated_at: now, completed_at: null, removed_at: null, version: 1, ...extra,
    };
    this.items.push(item);
    return item;
  }
  async getOrder() { return { ...this.order }; }
  async householdName() { return "Parkers"; }
  async cycleItems() { return this.items.filter((i) => i.status === "active"); }
  async getSnapshot(id: string) { return this.snapshots.find((s) => s.id === id) ?? null; }
  async upsertSnapshot(input: { orderId: string; householdId: string; items: SnapshotItem[]; contentHash: string; createdBy: string | null }) {
    const existing = this.snapshots.find((s) => s.content_hash === input.contentHash);
    if (existing) return existing;
    const snap: OrderSnapshot = {
      id: randomUUID(), order_id: input.orderId, household_id: input.householdId, version: this.snapshots.length + 1,
      content_hash: input.contentHash, items: input.items, item_count: input.items.length, created_by: input.createdBy,
      created_at: new Date().toISOString(),
    };
    this.snapshots.push(snap);
    return snap;
  }
  async setCurrentSnapshot(_o: string, id: string) { this.order.current_snapshot_id = id; }
  async getLink(snapshotId: string) { return this.links.find((l) => l.snapshot_id === snapshotId) ?? null; }
  async claimLink(input: { snapshotId: string; provider: string; isMock: boolean; staleBefore: Date; refreshBefore: Date }) {
    const existing = this.links.find((l) => l.snapshot_id === input.snapshotId);
    if (!existing) {
      const link: ShoppingLink = {
        id: randomUUID(), order_id: "order-1", snapshot_id: input.snapshotId, household_id: "hh-1", provider: input.provider,
        status: "pending", url: null, is_mock: false, expires_at: null, attempts: 1, claimed_at: new Date().toISOString(),
        error: null, created_at: new Date().toISOString(),
      };
      this.links.push(link);
      return { ...link };
    }
    const takeover =
      existing.status === "failed" ||
      (existing.status === "pending" && new Date(existing.claimed_at) < input.staleBefore) ||
      (existing.status === "ready" && existing.is_mock !== input.isMock);
    if (!takeover) return null;
    existing.status = "pending";
    existing.claimed_at = new Date().toISOString();
    return { ...existing };
  }
  async completeLink(id: string, r: { url: string; isMock: boolean; expiresAt: Date | null }) {
    const l = this.links.find((x) => x.id === id)!;
    Object.assign(l, { status: "ready", url: r.url, is_mock: r.isMock, expires_at: r.expiresAt?.toISOString() ?? null });
    return { ...l };
  }
  async failLink(id: string, error: string) {
    Object.assign(this.links.find((x) => x.id === id)!, { status: "failed", error });
  }
  async transition(_id: string, to: OrderStatus, expected: OrderStatus[]) {
    if (!expected.includes(this.order.status) || !canTransition(this.order.status, to)) {
      throw new AppError("conflict", `Cannot move order from ${this.order.status} to ${to}`);
    }
    this.events.push([this.order.status, to]);
    this.order.status = to;
    return { ...this.order };
  }
  async closeCycle() { return { newCycleId: "cycle-2", carriedOver: 0 }; }
}

class CountingProvider implements GroceryOrderingProvider {
  readonly providerId = "instacart";
  readonly isMock = false;
  calls: ShoppingLinkRequest[] = [];
  fail = 0;
  async createShoppingLink(req: ShoppingLinkRequest): Promise<ShoppingLinkResult> {
    this.calls.push(req);
    if (this.fail > 0) {
      this.fail--;
      throw new Error("503");
    }
    return { url: `https://www.instacart.com/store/shopping_lists/${this.calls.length}`, expiresAt: new Date(Date.now() + 14 * 864e5), isMock: false };
  }
}

describe("order service", () => {
  let store: MemoryOrderStore;
  let provider: CountingProvider;
  const deps = () => ({ store, provider, appUrl: "https://app.example" });

  beforeEach(() => {
    store = new MemoryOrderStore();
    provider = new CountingProvider();
    store.addItem("milk", { quantity: 2, unit: "gallon" });
    store.addItem("strawberries", { organic: true });
  });

  it("requires approval before creating a link", async () => {
    await expect(generateLink(deps(), "order-1", "u1")).rejects.toMatchObject({ code: "conflict" });
    expect(provider.calls).toHaveLength(0);
  });

  it("snapshots the list, creates one link, and reuses it while the list is unchanged", async () => {
    await applySimpleAction(deps(), "order-1", "approve", "u1");
    const first = await generateLink(deps(), "order-1", "u1");
    const second = await generateLink(deps(), "order-1", "u1");
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.link.url).toBe(first.link.url);
    expect(provider.calls).toHaveLength(1);
    expect(store.order.status).toBe("link_generated");
    expect(first.snapshot.items.map((i) => i.name)).toEqual(["milk", "strawberries"]);
  });

  it("regenerates when the list changes, keeping versioned snapshots", async () => {
    await applySimpleAction(deps(), "order-1", "approve", "u1");
    await generateLink(deps(), "order-1", "u1");
    store.addItem("eggs");
    const view = await getOrderView(deps(), "order-1");
    expect(view.listChangedSinceSnapshot).toBe(true);
    const next = await generateLink(deps(), "order-1", "u1");
    expect(next.reused).toBe(false);
    expect(next.snapshot.version).toBe(2);
    expect(provider.calls).toHaveLength(2);
  });

  it("returns to an earlier snapshot (and its link) if an edit is undone", async () => {
    await applySimpleAction(deps(), "order-1", "approve", "u1");
    const original = await generateLink(deps(), "order-1", "u1");
    const eggs = store.addItem("eggs");
    await generateLink(deps(), "order-1", "u1");
    eggs.status = "removed";
    const back = await generateLink(deps(), "order-1", "u1");
    expect(back.snapshot.id).toBe(original.snapshot.id);
    expect(back.reused).toBe(true);
    expect(provider.calls).toHaveLength(2);
  });

  it("refuses a concurrent second claim instead of calling the provider twice", async () => {
    await applySimpleAction(deps(), "order-1", "approve", "u1");
    const slow = new CountingProvider();
    let release!: () => void;
    slow.createShoppingLink = async (req) => {
      slow.calls.push(req);
      await new Promise<void>((r) => (release = r));
      return { url: "https://www.instacart.com/x", expiresAt: null, isMock: false };
    };
    const d = { store, provider: slow, appUrl: "https://app.example" };
    const first = generateLink(d, "order-1", "u1");
    await new Promise((r) => setTimeout(r, 0));
    await expect(generateLink(d, "order-1", "u2")).rejects.toMatchObject({ code: "conflict" });
    release();
    await first;
    expect(slow.calls).toHaveLength(1);
  });

  it("marks a failed provider call and lets the next attempt retry", async () => {
    await applySimpleAction(deps(), "order-1", "approve", "u1");
    provider.fail = 1;
    await expect(generateLink(deps(), "order-1", "u1")).rejects.toMatchObject({ code: "upstream_error" });
    expect(store.links[0]!.status).toBe("failed");
    expect(store.order.status).toBe("approved");
    const ok = await generateLink(deps(), "order-1", "u1");
    expect(ok.link.status).toBe("ready");
  });

  it("opening the link records handoff_opened but never completes the order", async () => {
    await applySimpleAction(deps(), "order-1", "approve", "u1");
    await generateLink(deps(), "order-1", "u1");
    const opened = await openHandoff(deps(), "order-1", "u1");
    expect(opened.regenerated).toBe(false);
    expect(store.order.status).toBe("handoff_opened");
    expect(store.order.completed_at).toBeNull();
    await openHandoff(deps(), "order-1", "u1");
    expect(store.order.status).toBe("handoff_opened");
  });

  it("opening after the list changed regenerates first", async () => {
    await applySimpleAction(deps(), "order-1", "approve", "u1");
    await generateLink(deps(), "order-1", "u1");
    store.addItem("eggs");
    const opened = await openHandoff(deps(), "order-1", "u1");
    expect(opened.regenerated).toBe(true);
    expect(provider.calls.at(-1)!.items.map((i) => i.name)).toContain("eggs");
  });

  it("only an explicit confirmation after hand-off marks the order completed_unverified", async () => {
    await applySimpleAction(deps(), "order-1", "approve", "u1");
    await expect(applySimpleAction(deps(), "order-1", "confirm_placed", "u1")).rejects.toBeInstanceOf(AppError);
    await generateLink(deps(), "order-1", "u1");
    await openHandoff(deps(), "order-1", "u1");
    await applySimpleAction(deps(), "order-1", "confirm_placed", "u1");
    expect(store.order.status).toBe("completed_unverified");
  });

  it("refuses to create a link for an empty list", async () => {
    store.items = [];
    await applySimpleAction(deps(), "order-1", "approve", "u1");
    await expect(generateLink(deps(), "order-1", "u1")).rejects.toMatchObject({ code: "unprocessable" });
  });

  it("replaces a mock link once a real provider is configured", async () => {
    await applySimpleAction(deps(), "order-1", "approve", "u1");
    const mock = await generateLink({ store, provider: new MockInstacartProvider("https://app.example"), appUrl: "https://app.example" }, "order-1", "u1");
    expect(mock.link.is_mock).toBe(true);
    const real = await generateLink(deps(), "order-1", "u1");
    expect(real.link.is_mock).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });
});
