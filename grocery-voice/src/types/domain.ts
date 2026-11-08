// Row shapes as read from Supabase. Kept by hand to match supabase/migrations;
// regenerate with `supabase gen types typescript` if the schema grows.

export type HouseholdRole = "owner" | "admin" | "member";
export type DuplicatePolicy = "increase_quantity" | "separate_item";
export type ItemStatus = "active" | "completed" | "removed";
export type ItemSource = "web" | "siri" | "alexa" | "home_assistant" | "api";
export type CycleStatus = "open" | "closed";

export type OrderStatus =
  | "draft"
  | "ready_for_review"
  | "approved"
  | "link_generated"
  | "handoff_opened"
  | "completed_unverified"
  | "archived";

export type IntegrationHealth = "unknown" | "healthy" | "degraded" | "failing" | "disabled";

export interface Household {
  id: string;
  name: string;
  duplicate_policy: DuplicatePolicy;
  created_by: string;
  created_at: string;
}

export interface HouseholdMember {
  household_id: string;
  user_id: string;
  role: HouseholdRole;
  joined_at: string;
}

export interface Profile {
  id: string;
  email: string;
  display_name: string;
}

export interface ShoppingCycle {
  id: string;
  household_id: string;
  sequence: number;
  status: CycleStatus;
  started_at: string;
  closed_at: string | null;
}

export interface ShoppingItem {
  id: string;
  household_id: string;
  cycle_id: string;
  name: string;
  normalized_name: string;
  quantity: number | null;
  unit: string | null;
  brand: string | null;
  notes: string | null;
  organic: boolean;
  upc: string | null;
  status: ItemStatus;
  source: ItemSource;
  added_by: string | null;
  added_by_label: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  removed_at: string | null;
  version: number;
}

export interface Order {
  id: string;
  household_id: string;
  cycle_id: string;
  status: OrderStatus;
  provider: string;
  current_snapshot_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  completed_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One line of an immutable order snapshot. */
export interface SnapshotItem {
  itemId: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  brand: string | null;
  organic: boolean;
  upc: string | null;
  notes: string | null;
}

export interface OrderSnapshot {
  id: string;
  order_id: string;
  household_id: string;
  version: number;
  content_hash: string;
  items: SnapshotItem[];
  item_count: number;
  created_by: string | null;
  created_at: string;
}

export interface ShoppingLink {
  id: string;
  order_id: string;
  snapshot_id: string;
  household_id: string;
  provider: string;
  status: "pending" | "ready" | "failed";
  url: string | null;
  is_mock: boolean;
  expires_at: string | null;
  attempts: number;
  claimed_at: string;
  error: string | null;
  created_at: string;
}

export interface HouseholdSchedule {
  household_id: string;
  enabled: boolean;
  frequency: "weekly" | "custom";
  shopping_weekday: number;
  interval_days: number | null;
  anchor_date: string | null;
  review_lead_days: number;
  review_reminder_time: string; // "HH:MM:SS"
  order_cutoff_time: string;
  timezone: string;
  next_reminder_at: string | null;
  next_shopping_date: string | null;
  last_reminded_shopping_date: string | null;
}

export interface IntegrationCredential {
  id: string;
  household_id: string;
  created_by: string;
  label: string;
  allowed_sources: ItemSource[];
  scopes: string[];
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface IntegrationConnection {
  id: string;
  household_id: string;
  provider: "home_assistant";
  label: string;
  base_url: string;
  entity_id: string;
  sync_direction: "inbound";
  poll_interval_seconds: number;
  enabled: boolean;
  health: IntegrationHealth;
  consecutive_failures: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  next_poll_at: string;
  lease_until: string | null;
  created_by: string;
  created_at: string;
}

export interface NotificationRecord {
  id: string;
  household_id: string;
  user_id: string;
  kind: "review_reminder" | "invitation";
  channel: "email";
  dedupe_key: string;
  status: "pending" | "sending" | "sent" | "failed" | "dead";
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  subject: string;
  body: string;
  payload: Record<string, unknown>;
  created_at: string;
  sent_at: string | null;
}
