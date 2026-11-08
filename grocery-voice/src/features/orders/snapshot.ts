import { hashPayload } from "@/lib/crypto";
import type { ShoppingItem, SnapshotItem } from "@/types/domain";

/**
 * The order snapshot is the active items of the cycle, in a stable order,
 * reduced to the fields that matter to the ordering provider. Two lists that
 * would produce the same Instacart page produce the same content hash.
 */
export function buildSnapshotItems(items: ShoppingItem[]): SnapshotItem[] {
  return items
    .filter((i) => i.status === "active")
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((i) => ({
      itemId: i.id,
      name: i.name,
      quantity: i.quantity === null ? null : Number(i.quantity),
      unit: i.unit,
      brand: i.brand,
      organic: i.organic,
      upc: i.upc,
      notes: i.notes,
    }));
}

export function snapshotContentHash(items: SnapshotItem[]): string {
  // Item ids are included: removing "milk" and re-adding it is a new line.
  return hashPayload(items);
}
