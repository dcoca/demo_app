import type { ItemSource, SnapshotItem } from "@/types/domain";

/**
 * Integration contracts. Each provider lives behind one of these interfaces
 * so it can be swapped (or mocked) without touching the domain services.
 */

// ---------------------------------------------------------------------------
// Push sources: something sends us items (Siri Shortcut, Alexa skill, API).
// ---------------------------------------------------------------------------
export interface ExternalGroceryItem {
  name: string;
  quantity?: number | null;
  unit?: string | null;
  brand?: string | null;
  notes?: string | null;
}

export interface ParsedIngestion {
  items: ExternalGroceryItem[];
  /** Label shown as "added by", e.g. "Siri (Dana's iPhone)". */
  actorLabel: string;
}

export interface GroceryInputProvider {
  readonly providerId: Extract<ItemSource, "siri" | "alexa" | "api">;
  /** Turns a validated ingest payload into grocery items. Pure. */
  parse(input: { items?: ExternalGroceryItem[]; text?: string; device?: string }): ParsedIngestion;
}

export interface IngestionResultItem {
  index: number;
  action: "created" | "merged";
  itemId: string;
  name: string;
  quantity: number | null;
}

export interface IngestionResult {
  cycleId: string;
  replayed: boolean;
  results: IngestionResultItem[];
}

// ---------------------------------------------------------------------------
// Pull sources: we read an external list (Alexa via Home Assistant).
// ---------------------------------------------------------------------------
export interface ExternalListItem {
  /** Stable id from the external system (Home Assistant todo item uid). */
  externalId: string;
  summary: string;
  description?: string | null;
}

export interface SyncAdapterCapabilities {
  read: true;
  /** Reserved for two-way sync; no adapter implements writes yet. */
  write: boolean;
}

export interface ShoppingListSyncAdapter {
  readonly providerId: string;
  readonly capabilities: SyncAdapterCapabilities;
  /** Open (not completed) items currently on the external list. */
  fetchOpenItems(): Promise<ExternalListItem[]>;
  /** Cheap reachability/auth check for health reporting. */
  checkHealth(): Promise<{ ok: boolean; message: string }>;
  // Two-way sync would add, e.g.:
  // markCompleted?(externalId: string): Promise<void>;
  // addItem?(summary: string): Promise<ExternalListItem>;
}

// ---------------------------------------------------------------------------
// Ordering: turn a snapshot into a shopping hand-off link.
// ---------------------------------------------------------------------------
export interface ShoppingLinkRequest {
  title: string;
  items: SnapshotItem[];
  /** Where Instacart's page links back to. */
  linkbackUrl?: string;
}

export interface ShoppingLinkResult {
  url: string;
  expiresAt: Date | null;
  /** True when no real provider was called. Always surfaced in the UI. */
  isMock: boolean;
}

export interface GroceryOrderingProvider {
  readonly providerId: string;
  readonly isMock: boolean;
  createShoppingLink(request: ShoppingLinkRequest): Promise<ShoppingLinkResult>;
}
