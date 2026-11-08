import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/errors";
import type { IngestionResult } from "@/server/integrations/types";
import type { AddItemsParams, ItemWriter } from "@/server/services/items-service";
import type { DuplicatePolicy, ShoppingItem } from "@/types/domain";

/**
 * In-memory twin of the add_items() SQL function: idempotency by
 * (household, source, key) with request-hash check, and the duplicate policy.
 * The SQL version is tested against PostgreSQL in tests/integration.
 */
export class InMemoryItemWriter implements ItemWriter {
  items: ShoppingItem[] = [];
  calls = 0;
  failNext = 0;
  private keys = new Map<string, { hash: string; response: IngestionResult }>();

  constructor(
    public policy: DuplicatePolicy = "increase_quantity",
    public cycleId = "cycle-1",
  ) {}

  async addItems(p: AddItemsParams): Promise<IngestionResult> {
    this.calls++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("database unavailable");
    }
    const k = `${p.householdId}|${p.source}|${p.idempotencyKey}`;
    const existing = this.keys.get(k);
    if (existing) {
      if (existing.hash !== p.requestHash) throw new AppError("idempotency_conflict", "Idempotency key reused with a different payload");
      return { ...existing.response, replayed: true };
    }
    const results: IngestionResult["results"] = [];
    p.items.forEach((input, index) => {
      const match =
        this.policy === "increase_quantity"
          ? this.items.find(
              (i) => i.status === "active" && i.cycle_id === this.cycleId && i.normalized_name === input.normalized_name && i.unit === input.unit,
            )
          : undefined;
      if (match) {
        match.quantity = (match.quantity ?? 1) + (input.quantity ?? 1);
        match.version++;
        results.push({ index, action: "merged", itemId: match.id, name: match.name, quantity: match.quantity });
      } else {
        const now = new Date().toISOString();
        const item: ShoppingItem = {
          id: randomUUID(),
          household_id: p.householdId,
          cycle_id: this.cycleId,
          ...input,
          status: "active",
          source: p.source,
          added_by: p.actorUserId ?? null,
          added_by_label: p.actorLabel ?? null,
          created_at: now,
          updated_at: now,
          completed_at: null,
          removed_at: null,
          version: 1,
        };
        this.items.push(item);
        results.push({ index, action: "created", itemId: item.id, name: item.name, quantity: item.quantity });
      }
    });
    const response = { cycleId: this.cycleId, results, replayed: false };
    this.keys.set(k, { hash: p.requestHash, response });
    return response;
  }
}
