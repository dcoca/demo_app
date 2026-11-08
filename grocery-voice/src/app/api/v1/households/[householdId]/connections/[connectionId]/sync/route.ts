import { requireMember } from "@/features/auth/session";
import { AppError } from "@/lib/errors";
import { handler, ok } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { adapterFor, ingestDeps, syncStore } from "@/server/container";
import { syncConnection } from "@/server/services/sync-service";
import type { IntegrationConnection } from "@/types/domain";

type Ctx = { params: Promise<{ householdId: string; connectionId: string }> };

/** "Sync now". Takes the same lease the scheduler uses, so they never overlap. */
export const POST = handler(async (_req: Request, { params }: Ctx) => {
  const { householdId, connectionId } = await params;
  await requireMember(householdId, "list:edit");

  const now = new Date();
  const { data, error } = await supabaseAdmin()
    .from("integration_connections")
    .update({ lease_until: new Date(now.getTime() + 120_000).toISOString() })
    .eq("id", connectionId)
    .eq("household_id", householdId)
    .eq("enabled", true)
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .select("*")
    .maybeSingle();
  if (error) throw new AppError("internal", "Could not start sync");
  if (!data) throw new AppError("conflict", "A sync is already running, or the connection is disabled");

  const connection = data as IntegrationConnection;
  const store = syncStore();
  try {
    const adapter = await adapterFor(connection);
    return ok(await syncConnection({ store, items: ingestDeps().items, adapter }, connection));
  } catch (e) {
    await store.updateHealth(connection.id, {
      health: "degraded",
      consecutiveFailures: connection.consecutive_failures + 1,
      lastAttemptAt: now,
      lastError: e instanceof Error ? e.message : "Sync failed",
      nextPollAt: new Date(now.getTime() + connection.poll_interval_seconds * 1000),
    });
    throw new AppError("upstream_error", e instanceof Error ? e.message : "Sync failed");
  }
});
