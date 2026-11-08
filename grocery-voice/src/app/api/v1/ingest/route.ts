import { handler, ok } from "@/lib/http";
import { AppError } from "@/lib/errors";
import { ingestDeps } from "@/server/container";
import { ingest } from "@/server/services/ingest-service";

/**
 * Voice ingestion endpoint (Siri Shortcuts, mock Alexa, API clients).
 *   Authorization: Bearer gv_<prefix>_<secret>
 * Credentials are accepted only in the header, never in the URL.
 */
export const POST = handler(async (req: Request) => {
  if (new URL(req.url).searchParams.has("token")) {
    throw new AppError("bad_request", "Send the token in the Authorization header, not the URL");
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new AppError("bad_request", "Body must be JSON");
  }
  const result = await ingest(ingestDeps(), req.headers.get("authorization"), body);
  return ok(
    {
      status: result.replayed ? "duplicate_event" : "accepted",
      replayed: result.replayed,
      cycleId: result.cycleId,
      items: result.results,
      // Short phrase a Shortcut can speak back.
      message: `Added ${result.results.map((r) => r.name).join(", ")}`,
    },
    result.replayed ? 200 : 201,
  );
});
