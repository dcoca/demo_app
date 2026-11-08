import { hashPayload } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { cleanDisplayName, normalizeItemName, normalizeUnit } from "@/features/shopping/normalize";
import type { ItemSource } from "@/types/domain";
import type { ExternalGroceryItem, IngestionResult } from "../integrations/types";

export interface NormalizedItem {
  name: string;
  normalized_name: string;
  quantity: number | null;
  unit: string | null;
  brand: string | null;
  notes: string | null;
  organic: boolean;
  upc: string | null;
}

export interface AddItemsParams {
  householdId: string;
  source: ItemSource;
  items: NormalizedItem[];
  idempotencyKey: string;
  requestHash: string;
  actorUserId?: string | null;
  actorLabel?: string | null;
  externalEventId?: string | null;
  credentialId?: string | null;
  connectionId?: string | null;
}

/** Persistence port; implemented by the add_items() SQL function. */
export interface ItemWriter {
  addItems(params: AddItemsParams): Promise<IngestionResult>;
}

export type AddItemInput = ExternalGroceryItem & { organic?: boolean; upc?: string | null };

export function normalizeItems(items: AddItemInput[]): NormalizedItem[] {
  return items.map((item) => {
    const name = cleanDisplayName(item.name);
    const normalized = normalizeItemName(name);
    if (!normalized) throw new AppError("bad_request", `"${item.name}" is not a usable item name`);
    return {
      name,
      normalized_name: normalized,
      quantity: item.quantity ?? null,
      unit: normalizeUnit(item.unit),
      brand: item.brand ? cleanDisplayName(item.brand) : null,
      notes: item.notes ? item.notes.trim() : null,
      organic: item.organic ?? /^organic\b/i.test(name),
      upc: item.upc ?? null,
    };
  });
}

export interface AddItemsCommand {
  householdId: string;
  source: ItemSource;
  items: AddItemInput[];
  /** Caller-scoped key. Web: "<userId>:<client key>". Voice: the external event id. */
  idempotencyKey: string;
  actorUserId?: string | null;
  actorLabel?: string | null;
  externalEventId?: string | null;
  credentialId?: string | null;
  connectionId?: string | null;
}

/**
 * The only way new items enter a list. Normalizes names and units, hashes the
 * normalized payload (so a retry with the same key but different content is
 * rejected), and delegates the atomic idempotent write to the database.
 */
export async function addItems(writer: ItemWriter, cmd: AddItemsCommand): Promise<IngestionResult> {
  if (cmd.items.length === 0) throw new AppError("bad_request", "No items to add");
  if (cmd.items.length > 50) throw new AppError("bad_request", "At most 50 items per request");
  const items = normalizeItems(cmd.items);
  return writer.addItems({
    householdId: cmd.householdId,
    source: cmd.source,
    items,
    idempotencyKey: cmd.idempotencyKey,
    requestHash: hashPayload(items),
    actorUserId: cmd.actorUserId ?? null,
    actorLabel: cmd.actorLabel ?? null,
    externalEventId: cmd.externalEventId ?? null,
    credentialId: cmd.credentialId ?? null,
    connectionId: cmd.connectionId ?? null,
  });
}
