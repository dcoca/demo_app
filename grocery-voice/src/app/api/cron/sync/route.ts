import { handler, ok } from "@/lib/http";
import { assertCronAuthorized, runSyncJob } from "@/server/services/cron-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Polls due Home Assistant connections. Each connection has its own interval. */
async function run(req: Request) {
  assertCronAuthorized(req);
  return ok(await runSyncJob());
}

export const POST = handler(run);
export const GET = handler(run);
