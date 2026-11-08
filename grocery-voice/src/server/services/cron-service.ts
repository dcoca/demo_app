import "server-only";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/errors";
import { serverEnv } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { adapterFor, ingestDeps, notificationDeps, reminderDeps, syncStore } from "../container";
import { deliverNotifications } from "./notification-service";
import { runReminders } from "./reminder-service";
import { syncConnection, type SyncRunResult } from "./sync-service";

export function assertCronAuthorized(req: Request) {
  const expected = Buffer.from(`Bearer ${serverEnv().CRON_SECRET}`);
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new AppError("unauthorized", "Invalid cron credentials");
  }
}

/** Runs `fn` only if no other invocation holds the named lock. */
export async function withJobLock<T>(job: string, ttlSeconds: number, fn: () => Promise<T>) {
  const admin = supabaseAdmin();
  const holder = randomUUID();
  const { data: acquired, error } = await admin.rpc("try_acquire_job_lock", {
    p_job: job,
    p_holder: holder,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw error;
  if (!acquired) return { skipped: true as const };
  try {
    return { skipped: false as const, result: await fn() };
  } finally {
    await admin.rpc("release_job_lock", { p_job: job, p_holder: holder });
  }
}

export async function runReminderJob(now = new Date()) {
  return withJobLock("reminders", 300, async () => {
    const reminders = await runReminders(reminderDeps(), now);
    const delivery = await deliverNotifications(notificationDeps(), now);
    return { reminders, delivery };
  });
}

export async function runSyncJob() {
  return withJobLock("integration-sync", 300, async () => {
    const store = syncStore();
    const connections = await store.claimDue(20, 240);
    const results: Array<{ connectionId: string } & (SyncRunResult | { status: "error"; error: string })> = [];
    for (const connection of connections) {
      try {
        const adapter = await adapterFor(connection);
        const result = await syncConnection({ store, items: ingestDeps().items, adapter }, connection);
        results.push({ connectionId: connection.id, ...result });
      } catch (error) {
        // Configuration problems (missing key, bad URL) count as failures too.
        const message = error instanceof Error ? error.message : "Sync failed";
        const failures = connection.consecutive_failures + 1;
        await store.updateHealth(connection.id, {
          health: failures >= 3 ? "failing" : "degraded",
          consecutiveFailures: failures,
          lastAttemptAt: new Date(),
          lastError: message,
          nextPollAt: new Date(Date.now() + connection.poll_interval_seconds * 1000),
        });
        results.push({ connectionId: connection.id, status: "error", error: message });
      }
    }
    return results;
  });
}
