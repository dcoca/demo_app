import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptSecret, generateIntegrationToken, randomToken, sha256Hex } from "@/lib/crypto";
import { publicEnv, serverEnv } from "@/lib/env";
import { AppError, fromDatabaseError } from "@/lib/errors";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { ScheduleInput } from "@/lib/validation/schemas";
import { nextOccurrence } from "@/features/scheduling/schedule";
import type { IntegrationConnection, ItemSource } from "@/types/domain";
import { emailProvider } from "../container";
import { HomeAssistantShoppingListAdapter } from "../integrations/alexa/home-assistant-adapter";
import { assertSafeHomeAssistantUrl } from "../integrations/alexa/url-guard";

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------
export async function createInvitation(
  userClient: SupabaseClient,
  input: { householdId: string; email: string; role: "member" | "admin"; invitedBy: string; householdName: string },
) {
  const token = randomToken(40);
  const { data, error } = await userClient
    .from("household_invitations")
    .insert({
      household_id: input.householdId,
      email: input.email,
      role: input.role,
      token_hash: sha256Hex(token),
      invited_by: input.invitedBy,
    })
    .select("id, email, role, expires_at")
    .single();
  if (error) throw fromDatabaseError(error);

  const link = `${publicEnv().NEXT_PUBLIC_APP_URL}/invite/${token}`;
  let emailed = false;
  try {
    await emailProvider().send({
      to: input.email,
      subject: `You're invited to ${input.householdName} on Grocery Voice`,
      text: `You've been invited to share the "${input.householdName}" grocery list.\n\nAccept: ${link}\n\nThis link expires in 7 days.`,
      idempotencyKey: `invitation:${data.id}`,
    });
    emailed = true;
  } catch {
    emailed = false; // the inviter can still copy the link
  }
  return { invitation: data, link, emailed };
}

// ---------------------------------------------------------------------------
// Integration credentials (Siri Shortcuts etc.)
// ---------------------------------------------------------------------------
export async function createCredential(input: {
  householdId: string;
  userId: string;
  label: string;
  allowedSources: ItemSource[];
}) {
  const { token, prefix, hash } = generateIntegrationToken();
  const { data, error } = await supabaseAdmin()
    .from("integration_credentials")
    .insert({
      household_id: input.householdId,
      created_by: input.userId,
      label: input.label,
      allowed_sources: input.allowedSources,
      token_prefix: prefix,
      token_hash: hash,
    })
    .select("id, label, token_prefix, allowed_sources, created_at")
    .single();
  if (error) throw fromDatabaseError(error);
  // The raw token is returned exactly once and never stored.
  return { credential: data, token };
}

export async function revokeCredential(input: { householdId: string; credentialId: string; userId: string; isAdmin: boolean }) {
  let query = supabaseAdmin()
    .from("integration_credentials")
    .update({ revoked_at: new Date().toISOString(), revoked_by: input.userId })
    .eq("id", input.credentialId)
    .eq("household_id", input.householdId)
    .is("revoked_at", null);
  if (!input.isAdmin) query = query.eq("created_by", input.userId);
  const { data, error } = await query.select("id");
  if (error) throw fromDatabaseError(error);
  if (!data?.length) throw new AppError("not_found", "Credential not found");
}

// ---------------------------------------------------------------------------
// Home Assistant connections
// ---------------------------------------------------------------------------
function encryptionKey(): string {
  const key = serverEnv().INTEGRATION_ENCRYPTION_KEY;
  if (!key) throw new AppError("unprocessable", "Server is missing INTEGRATION_ENCRYPTION_KEY");
  return key;
}

export async function createConnection(input: {
  householdId: string;
  userId: string;
  label: string;
  baseUrl: string;
  entityId: string;
  accessToken: string;
  pollIntervalSeconds: number;
}) {
  let url: URL;
  try {
    url = assertSafeHomeAssistantUrl(input.baseUrl, serverEnv().ALLOW_PRIVATE_HOME_ASSISTANT_URLS);
  } catch (e) {
    throw new AppError("bad_request", e instanceof Error ? e.message : "Invalid URL");
  }
  const key = encryptionKey();

  // Verify before saving so people find typos immediately.
  const adapter = new HomeAssistantShoppingListAdapter({
    baseUrl: url.toString(),
    entityId: input.entityId,
    accessToken: input.accessToken,
    attempts: 1,
  });
  try {
    await adapter.fetchOpenItems();
  } catch (e) {
    throw new AppError("bad_request", `Could not read ${input.entityId}: ${e instanceof Error ? e.message : "error"}`);
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("integration_connections")
    .insert({
      household_id: input.householdId,
      provider: "home_assistant",
      label: input.label,
      base_url: url.toString().replace(/\/+$/, ""),
      entity_id: input.entityId,
      poll_interval_seconds: input.pollIntervalSeconds,
      created_by: input.userId,
      health: "healthy",
    })
    .select("*")
    .single();
  if (error) throw fromDatabaseError(error);

  const secret = await admin
    .from("integration_connection_secrets")
    .insert({ connection_id: data.id, encrypted_token: encryptSecret(input.accessToken, key) });
  if (secret.error) {
    await admin.from("integration_connections").delete().eq("id", data.id);
    throw fromDatabaseError(secret.error);
  }
  return data as IntegrationConnection;
}

export async function updateConnection(
  householdId: string,
  connectionId: string,
  patch: { label?: string; enabled?: boolean; pollIntervalSeconds?: number; accessToken?: string },
) {
  const admin = supabaseAdmin();
  const update: Record<string, unknown> = {};
  if (patch.label !== undefined) update.label = patch.label;
  if (patch.pollIntervalSeconds !== undefined) update.poll_interval_seconds = patch.pollIntervalSeconds;
  if (patch.enabled !== undefined) {
    update.enabled = patch.enabled;
    update.health = patch.enabled ? "unknown" : "disabled";
    if (patch.enabled) update.next_poll_at = new Date().toISOString();
  }
  const { data, error } = await admin
    .from("integration_connections")
    .update(update)
    .eq("id", connectionId)
    .eq("household_id", householdId)
    .select("*")
    .maybeSingle();
  if (error) throw fromDatabaseError(error);
  if (!data) throw new AppError("not_found", "Connection not found");

  if (patch.accessToken) {
    const res = await admin.from("integration_connection_secrets").upsert({
      connection_id: connectionId,
      encrypted_token: encryptSecret(patch.accessToken, encryptionKey()),
      updated_at: new Date().toISOString(),
    });
    if (res.error) throw fromDatabaseError(res.error);
  }
  return data as IntegrationConnection;
}

export async function deleteConnection(householdId: string, connectionId: string) {
  // Imported items stay on the list; only the link to Home Assistant goes.
  const { data, error } = await supabaseAdmin()
    .from("integration_connections")
    .delete()
    .eq("id", connectionId)
    .eq("household_id", householdId)
    .select("id");
  if (error) throw fromDatabaseError(error);
  if (!data?.length) throw new AppError("not_found", "Connection not found");
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------
export async function saveSchedule(userClient: SupabaseClient, householdId: string, input: ScheduleInput, now = new Date()) {
  const rule = {
    frequency: input.frequency,
    shoppingWeekday: input.shoppingWeekday,
    intervalDays: input.intervalDays ?? null,
    anchorDate: input.anchorDate ?? null,
    reviewLeadDays: input.reviewLeadDays,
    reviewReminderTime: input.reviewReminderTime,
    orderCutoffTime: input.orderCutoffTime,
    timezone: input.timezone,
  };
  const next = input.enabled ? nextOccurrence(rule, now) : null;

  // User client: RLS restricts schedule edits to owners and admins.
  const { data, error } = await userClient
    .from("household_schedules")
    .update({
      enabled: input.enabled,
      frequency: input.frequency,
      shopping_weekday: input.shoppingWeekday,
      interval_days: input.frequency === "custom" ? input.intervalDays : null,
      anchor_date: input.frequency === "custom" ? input.anchorDate : null,
      review_lead_days: input.reviewLeadDays,
      review_reminder_time: input.reviewReminderTime,
      order_cutoff_time: input.orderCutoffTime,
      timezone: input.timezone,
      next_reminder_at: next?.reminderAt.toISOString() ?? null,
      next_shopping_date: next?.shoppingDate ?? null,
      // A new schedule may legitimately remind for an upcoming date again.
      last_reminded_shopping_date: null,
    })
    .eq("household_id", householdId)
    .select("*")
    .maybeSingle();
  if (error) throw fromDatabaseError(error);
  if (!data) throw new AppError("forbidden", "Only owners and admins can change the schedule");
  return data;
}
