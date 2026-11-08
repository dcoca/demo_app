import { handler, ok } from "@/lib/http";
import { assertCronAuthorized, runReminderJob } from "@/server/services/cron-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Called by Supabase Cron (pg_cron + pg_net) every 5 minutes. Idempotent. */
async function run(req: Request) {
  assertCronAuthorized(req);
  return ok(await runReminderJob());
}

export const POST = handler(run);
export const GET = handler(run);
