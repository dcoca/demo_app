import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, fromDatabaseError } from "@/lib/errors";
import type {
  HouseholdSchedule,
  IntegrationConnection,
  NotificationRecord,
  Order,
  OrderSnapshot,
  OrderStatus,
  ShoppingItem,
  ShoppingLink,
} from "@/types/domain";
import type { IngestionResult } from "../integrations/types";
import type { CredentialLookup, CredentialRecord } from "../services/ingest-service";
import type { AddItemsParams, ItemWriter } from "../services/items-service";
import type { NotificationStore } from "../services/notification-service";
import type { OrderStore } from "../services/order-service";
import type { NewNotification, ReminderStore } from "../services/reminder-service";
import type { SyncStore } from "../services/sync-service";

function unwrap<T>(result: { data: T | null; error: { code?: string; message?: string } | null }): T {
  if (result.error) throw fromDatabaseError(result.error);
  return result.data as T;
}

// ---------------------------------------------------------------------------
// Items: one RPC. Works with a user client (RLS + function checks) or the
// service client (route already authenticated a credential/connection).
// ---------------------------------------------------------------------------
export class SupabaseItemWriter implements ItemWriter {
  constructor(private readonly db: SupabaseClient) {}

  async addItems(p: AddItemsParams): Promise<IngestionResult> {
    return unwrap(
      await this.db.rpc("add_items", {
        p_household_id: p.householdId,
        p_source: p.source,
        p_items: p.items,
        p_idempotency_key: p.idempotencyKey,
        p_request_hash: p.requestHash,
        p_actor_user_id: p.actorUserId,
        p_actor_label: p.actorLabel,
        p_external_event_id: p.externalEventId,
        p_credential_id: p.credentialId,
        p_connection_id: p.connectionId,
      }),
    ) as IngestionResult;
  }
}

// ---------------------------------------------------------------------------
// Integration credentials (service role)
// ---------------------------------------------------------------------------
export class SupabaseCredentialLookup implements CredentialLookup {
  constructor(private readonly admin: SupabaseClient) {}

  async findByPrefix(prefix: string): Promise<CredentialRecord | null> {
    return unwrap(
      await this.admin
        .from("integration_credentials")
        .select("id, household_id, created_by, allowed_sources, scopes, token_hash, revoked_at")
        .eq("token_prefix", prefix)
        .maybeSingle(),
    );
  }

  async isMember(householdId: string, userId: string): Promise<boolean> {
    const row = unwrap(
      await this.admin
        .from("household_members")
        .select("user_id")
        .eq("household_id", householdId)
        .eq("user_id", userId)
        .maybeSingle(),
    );
    return row !== null;
  }

  async touchLastUsed(credentialId: string): Promise<void> {
    await this.admin
      .from("integration_credentials")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", credentialId);
  }
}

// ---------------------------------------------------------------------------
// Home Assistant sync bookkeeping (service role)
// ---------------------------------------------------------------------------
export class SupabaseSyncStore implements SyncStore {
  constructor(private readonly admin: SupabaseClient) {}

  async mappedExternalIds(connectionId: string) {
    const ids = new Set<string>();
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const rows = unwrap(
        await this.admin
          .from("external_item_mappings")
          .select("external_id")
          .eq("connection_id", connectionId)
          .range(from, from + pageSize - 1),
      ) as { external_id: string }[];
      rows.forEach((r) => ids.add(r.external_id));
      if (rows.length < pageSize) return ids;
    }
  }

  async upsertMapping(row: Parameters<SyncStore["upsertMapping"]>[0]) {
    unwrap(
      await this.admin.from("external_item_mappings").upsert(
        {
          connection_id: row.connectionId,
          household_id: row.householdId,
          external_id: row.externalId,
          item_id: row.itemId,
          external_summary: row.summary,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: "connection_id,external_id" },
      ),
    );
  }

  async touchMappings(connectionId: string, externalIds: string[]) {
    if (externalIds.length === 0) return;
    unwrap(
      await this.admin
        .from("external_item_mappings")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("connection_id", connectionId)
        .in("external_id", externalIds.slice(0, 500)),
    );
  }

  async startRun(connectionId: string, householdId: string) {
    const row = unwrap(
      await this.admin
        .from("sync_runs")
        .insert({ connection_id: connectionId, household_id: householdId })
        .select("id")
        .single(),
    ) as { id: string };
    return row.id;
  }

  async finishRun(runId: string, r: Parameters<SyncStore["finishRun"]>[1]) {
    unwrap(
      await this.admin
        .from("sync_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: r.status,
          fetched: r.fetched,
          imported: r.imported,
          already_mapped: r.alreadyMapped,
          error: r.errors.join("\n").slice(0, 2000) || null,
        })
        .eq("id", runId),
    );
  }

  async saveCheckpoint(connectionId: string, c: { cursor: string; count: number; at: Date }) {
    unwrap(
      await this.admin.from("sync_checkpoints").upsert({
        connection_id: connectionId,
        cursor: c.cursor,
        last_seen_count: c.count,
        last_successful_sync_at: c.at.toISOString(),
        updated_at: new Date().toISOString(),
      }),
    );
  }

  async updateHealth(connectionId: string, p: Parameters<SyncStore["updateHealth"]>[1]) {
    unwrap(
      await this.admin
        .from("integration_connections")
        .update({
          health: p.health,
          consecutive_failures: p.consecutiveFailures,
          last_attempt_at: p.lastAttemptAt.toISOString(),
          ...(p.lastSuccessAt ? { last_success_at: p.lastSuccessAt.toISOString() } : {}),
          last_error: p.lastError,
          next_poll_at: p.nextPollAt.toISOString(),
          lease_until: null,
        })
        .eq("id", connectionId),
    );
  }

  async claimDue(limit: number, leaseSeconds: number): Promise<IntegrationConnection[]> {
    return unwrap(
      await this.admin.rpc("claim_due_connections", { p_limit: limit, p_lease_seconds: leaseSeconds }),
    ) as IntegrationConnection[];
  }

  async encryptedToken(connectionId: string): Promise<string | null> {
    const row = unwrap(
      await this.admin
        .from("integration_connection_secrets")
        .select("encrypted_token")
        .eq("connection_id", connectionId)
        .maybeSingle(),
    ) as { encrypted_token: string } | null;
    return row?.encrypted_token ?? null;
  }
}

// ---------------------------------------------------------------------------
// Orders (service role; routes verify membership before calling)
// ---------------------------------------------------------------------------
export class SupabaseOrderStore implements OrderStore {
  constructor(private readonly admin: SupabaseClient) {}

  async getOrder(orderId: string) {
    return unwrap(await this.admin.from("orders").select("*").eq("id", orderId).maybeSingle()) as Order | null;
  }

  async householdName(householdId: string) {
    const row = unwrap(
      await this.admin.from("households").select("name").eq("id", householdId).single(),
    ) as { name: string };
    return row.name;
  }

  async cycleItems(cycleId: string) {
    return unwrap(
      await this.admin.from("shopping_items").select("*").eq("cycle_id", cycleId).eq("status", "active"),
    ) as ShoppingItem[];
  }

  async getSnapshot(snapshotId: string) {
    return unwrap(
      await this.admin.from("order_snapshots").select("*").eq("id", snapshotId).maybeSingle(),
    ) as OrderSnapshot | null;
  }

  async upsertSnapshot(input: Parameters<OrderStore["upsertSnapshot"]>[0]): Promise<OrderSnapshot> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const existing = unwrap(
        await this.admin
          .from("order_snapshots")
          .select("*")
          .eq("order_id", input.orderId)
          .eq("content_hash", input.contentHash)
          .maybeSingle(),
      ) as OrderSnapshot | null;
      if (existing) return existing;

      const latest = unwrap(
        await this.admin
          .from("order_snapshots")
          .select("version")
          .eq("order_id", input.orderId)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ) as { version: number } | null;

      const { data, error } = await this.admin
        .from("order_snapshots")
        .insert({
          order_id: input.orderId,
          household_id: input.householdId,
          version: (latest?.version ?? 0) + 1,
          content_hash: input.contentHash,
          items: input.items,
          item_count: input.items.length,
          created_by: input.createdBy,
        })
        .select("*")
        .single();
      if (!error) return data as OrderSnapshot;
      if (error.code !== "23505") throw fromDatabaseError(error);
      // Lost a race on version or content hash: loop and re-read.
    }
    throw new AppError("conflict", "Could not snapshot the list; try again");
  }

  async setCurrentSnapshot(orderId: string, snapshotId: string) {
    unwrap(await this.admin.from("orders").update({ current_snapshot_id: snapshotId }).eq("id", orderId));
  }

  async getLink(snapshotId: string, provider: string) {
    return unwrap(
      await this.admin
        .from("shopping_links")
        .select("*")
        .eq("snapshot_id", snapshotId)
        .eq("provider", provider)
        .maybeSingle(),
    ) as ShoppingLink | null;
  }

  async claimLink(input: Parameters<OrderStore["claimLink"]>[0]) {
    const inserted = await this.admin
      .from("shopping_links")
      .insert({
        order_id: input.orderId,
        snapshot_id: input.snapshotId,
        household_id: input.householdId,
        provider: input.provider,
        status: "pending",
      })
      .select("*")
      .single();
    if (!inserted.error) return inserted.data as ShoppingLink;
    if (inserted.error.code !== "23505") throw fromDatabaseError(inserted.error);

    // Row exists: take it over only if failed, abandoned, expiring, or from
    // the other (mock/real) provider mode.
    const taken = await this.admin
      .from("shopping_links")
      .update({ status: "pending", claimed_at: new Date().toISOString(), error: null })
      .eq("snapshot_id", input.snapshotId)
      .eq("provider", input.provider)
      .or(
        [
          "status.eq.failed",
          `and(status.eq.pending,claimed_at.lt.${input.staleBefore.toISOString()})`,
          `and(status.eq.ready,expires_at.lt.${input.refreshBefore.toISOString()})`,
          `and(status.eq.ready,is_mock.neq.${input.isMock})`,
        ].join(","),
      )
      .select("*")
      .maybeSingle();
    return unwrap(taken) as ShoppingLink | null;
  }

  async completeLink(linkId: string, r: { url: string; isMock: boolean; expiresAt: Date | null }) {
    return unwrap(
      await this.admin
        .from("shopping_links")
        .update({
          status: "ready",
          url: r.url,
          is_mock: r.isMock,
          expires_at: r.expiresAt?.toISOString() ?? null,
          error: null,
        })
        .eq("id", linkId)
        .select("*")
        .single(),
    ) as ShoppingLink;
  }

  async failLink(linkId: string, error: string) {
    unwrap(
      await this.admin
        .from("shopping_links")
        .update({ status: "failed", error: error.slice(0, 500) })
        .eq("id", linkId),
    );
  }

  async transition(orderId: string, to: OrderStatus, expectedFrom: OrderStatus[], actorId: string, note?: string) {
    return unwrap(
      await this.admin.rpc("transition_order", {
        p_order_id: orderId,
        p_to: to,
        p_expected_from: expectedFrom,
        p_actor_id: actorId,
        p_note: note ?? null,
      }),
    ) as Order;
  }

  async closeCycle(orderId: string, actorId: string) {
    return unwrap(
      await this.admin.rpc("close_cycle", { p_order_id: orderId, p_actor_id: actorId }),
    ) as { newCycleId: string; carriedOver: number };
  }
}

// ---------------------------------------------------------------------------
// Reminders & notifications (service role, scheduler only)
// ---------------------------------------------------------------------------
export class SupabaseReminderStore implements ReminderStore {
  constructor(private readonly admin: SupabaseClient) {}

  async dueSchedules(now: Date, limit: number) {
    return unwrap(
      await this.admin
        .from("household_schedules")
        .select("*")
        .eq("enabled", true)
        .lte("next_reminder_at", now.toISOString())
        .order("next_reminder_at")
        .limit(limit),
    ) as HouseholdSchedule[];
  }

  async advanceSchedule(
    householdId: string,
    expected: string | null,
    next: { nextReminderAt: Date; nextShoppingDate: string; lastRemindedShoppingDate: string | null },
  ) {
    let query = this.admin
      .from("household_schedules")
      .update({
        next_reminder_at: next.nextReminderAt.toISOString(),
        next_shopping_date: next.nextShoppingDate,
        last_reminded_shopping_date: next.lastRemindedShoppingDate,
      })
      .eq("household_id", householdId);
    query = expected === null ? query.is("next_reminder_at", null) : query.eq("next_reminder_at", expected);
    const rows = unwrap(await query.select("household_id")) as unknown[];
    return rows.length === 1;
  }

  async recipients(householdId: string) {
    const prefs = unwrap(
      await this.admin
        .from("notification_preferences")
        .select("user_id")
        .eq("household_id", householdId)
        .eq("email_reminders", true),
    ) as { user_id: string }[];
    const members = unwrap(
      await this.admin.from("household_members").select("user_id").eq("household_id", householdId),
    ) as { user_id: string }[];
    const memberIds = new Set(members.map((m) => m.user_id));
    const ids = prefs.map((p) => p.user_id).filter((id) => memberIds.has(id));
    if (ids.length === 0) return [];
    const profiles = unwrap(
      await this.admin.from("profiles").select("id, email, display_name").in("id", ids),
    ) as { id: string; email: string; display_name: string }[];
    return profiles
      .filter((p) => p.email)
      .map((p) => ({ userId: p.id, email: p.email, displayName: p.display_name }));
  }

  async householdSummary(householdId: string) {
    const household = unwrap(
      await this.admin.from("households").select("name").eq("id", householdId).single(),
    ) as { name: string };
    const cycle = unwrap(
      await this.admin
        .from("shopping_cycles")
        .select("id, orders(id)")
        .eq("household_id", householdId)
        .eq("status", "open")
        .maybeSingle(),
    ) as { id: string; orders: { id: string } | { id: string }[] | null } | null;
    if (!cycle) return { name: household.name, activeItemCount: 0, orderId: null };
    const { count, error } = await this.admin
      .from("shopping_items")
      .select("id", { count: "exact", head: true })
      .eq("cycle_id", cycle.id)
      .eq("status", "active");
    if (error) throw fromDatabaseError(error);
    const order = Array.isArray(cycle.orders) ? cycle.orders[0] : cycle.orders;
    return { name: household.name, activeItemCount: count ?? 0, orderId: order?.id ?? null };
  }

  async enqueue(rows: NewNotification[]) {
    if (rows.length === 0) return 0;
    const inserted = unwrap(
      await this.admin
        .from("notifications")
        .upsert(
          rows.map((r) => ({
            household_id: r.householdId,
            user_id: r.userId,
            kind: r.kind,
            dedupe_key: r.dedupeKey,
            subject: r.subject,
            body: r.body,
            payload: r.payload,
          })),
          { onConflict: "dedupe_key", ignoreDuplicates: true },
        )
        .select("id"),
    ) as unknown[];
    return inserted.length;
  }

  async markOrderReadyForReview(orderId: string) {
    const { error } = await this.admin.rpc("transition_order", {
      p_order_id: orderId,
      p_to: "ready_for_review",
      p_expected_from: ["draft"],
      p_actor_id: null,
      p_note: "Review reminder sent",
    });
    // Already past draft (approved, linked, ...) is fine.
    if (error && error.code !== "GV409") throw fromDatabaseError(error);
  }
}

export class SupabaseNotificationStore implements NotificationStore {
  constructor(private readonly admin: SupabaseClient) {}

  async claim(limit: number, leaseSeconds: number) {
    return unwrap(
      await this.admin.rpc("claim_notifications", { p_limit: limit, p_lease_seconds: leaseSeconds }),
    ) as NotificationRecord[];
  }

  async markSent(id: string, providerMessageId: string | null, at: Date) {
    unwrap(
      await this.admin
        .from("notifications")
        .update({ status: "sent", sent_at: at.toISOString(), provider_message_id: providerMessageId, last_error: null, claimed_until: null })
        .eq("id", id),
    );
  }

  async markFailed(id: string, error: string, nextAttemptAt: Date, dead: boolean) {
    unwrap(
      await this.admin
        .from("notifications")
        .update({
          status: dead ? "dead" : "failed",
          last_error: error,
          next_attempt_at: nextAttemptAt.toISOString(),
          claimed_until: null,
        })
        .eq("id", id),
    );
  }
}
