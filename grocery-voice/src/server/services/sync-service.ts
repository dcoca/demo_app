import { hashPayload } from "@/lib/crypto";
import { parseSpokenPhrase } from "@/features/shopping/parse-spoken";
import type { IntegrationConnection, IntegrationHealth } from "@/types/domain";
import type { ShoppingListSyncAdapter } from "../integrations/types";
import { addItems, type ItemWriter } from "./items-service";

export interface SyncRunResult {
  status: "succeeded" | "failed";
  fetched: number;
  imported: number;
  alreadyMapped: number;
  errors: string[];
}

export interface SyncStore {
  mappedExternalIds(connectionId: string): Promise<Set<string>>;
  upsertMapping(row: {
    connectionId: string;
    householdId: string;
    externalId: string;
    itemId: string | null;
    summary: string;
  }): Promise<void>;
  touchMappings(connectionId: string, externalIds: string[]): Promise<void>;
  startRun(connectionId: string, householdId: string): Promise<string>;
  finishRun(runId: string, result: SyncRunResult): Promise<void>;
  saveCheckpoint(connectionId: string, checkpoint: { cursor: string; count: number; at: Date }): Promise<void>;
  updateHealth(
    connectionId: string,
    patch: {
      health: IntegrationHealth;
      consecutiveFailures: number;
      lastAttemptAt: Date;
      lastSuccessAt?: Date;
      lastError: string | null;
      nextPollAt: Date;
    },
  ): Promise<void>;
}

export interface SyncDeps {
  store: SyncStore;
  items: ItemWriter;
  adapter: ShoppingListSyncAdapter;
  now?: () => Date;
}

const MAX_BACKOFF_SECONDS = 6 * 3600;

export function healthAfterFailure(consecutiveFailures: number): IntegrationHealth {
  return consecutiveFailures >= 3 ? "failing" : "degraded";
}

export function nextPollAfterFailure(now: Date, intervalSeconds: number, consecutiveFailures: number): Date {
  const backoff = Math.min(MAX_BACKOFF_SECONDS, intervalSeconds * 2 ** Math.max(0, consecutiveFailures - 1));
  return new Date(now.getTime() + backoff * 1000);
}

/**
 * One-way sync: external list -> Grocery Voice.
 *
 * Guarantees
 *   - No duplicates: each external item is written with the idempotency key
 *     "ha:<connection>:<external id>" and then recorded in
 *     external_item_mappings. If the process dies between the two writes, the
 *     next run replays the same key, gets the same item id back, and records
 *     the mapping.
 *   - No data loss: items that disappear from the external list, or a list
 *     that cannot be read, never cause internal items to be changed.
 *   - Failure isolation: a failed run only updates health and backoff.
 */
export async function syncConnection(deps: SyncDeps, connection: IntegrationConnection): Promise<SyncRunResult> {
  const now = deps.now?.() ?? new Date();
  const runId = await deps.store.startRun(connection.id, connection.household_id);

  let external;
  try {
    external = await deps.adapter.fetchOpenItems();
  } catch (error) {
    const failures = connection.consecutive_failures + 1;
    const message = error instanceof Error ? error.message : "Unknown error";
    const result: SyncRunResult = { status: "failed", fetched: 0, imported: 0, alreadyMapped: 0, errors: [message] };
    await deps.store.updateHealth(connection.id, {
      health: healthAfterFailure(failures),
      consecutiveFailures: failures,
      lastAttemptAt: now,
      lastError: message,
      nextPollAt: nextPollAfterFailure(now, connection.poll_interval_seconds, failures),
    });
    await deps.store.finishRun(runId, result);
    return result;
  }

  const mapped = await deps.store.mappedExternalIds(connection.id);
  const errors: string[] = [];
  let imported = 0;
  let alreadyMapped = 0;

  for (const item of external) {
    if (mapped.has(item.externalId)) {
      alreadyMapped++;
      continue;
    }
    try {
      const parsed = parseSpokenPhrase(item.summary) ?? { name: item.summary };
      const key = `ha:${connection.id}:${item.externalId}`;
      const result = await addItems(deps.items, {
        householdId: connection.household_id,
        source: "alexa",
        items: [{ ...parsed, notes: item.description ?? null }],
        idempotencyKey: key,
        externalEventId: key,
        connectionId: connection.id,
        actorLabel: "Alexa (via Home Assistant)",
      });
      await deps.store.upsertMapping({
        connectionId: connection.id,
        householdId: connection.household_id,
        externalId: item.externalId,
        itemId: result.results[0]?.itemId ?? null,
        summary: item.summary,
      });
      if (!result.replayed) imported++;
    } catch (error) {
      errors.push(`${item.summary}: ${error instanceof Error ? error.message : "failed"}`);
    }
  }

  await deps.store.touchMappings(
    connection.id,
    external.map((i) => i.externalId),
  );
  await deps.store.saveCheckpoint(connection.id, {
    cursor: hashPayload(external.map((i) => i.externalId).sort()),
    count: external.length,
    at: now,
  });

  const result: SyncRunResult = {
    status: errors.length === 0 ? "succeeded" : "failed",
    fetched: external.length,
    imported,
    alreadyMapped,
    errors,
  };

  // Reading worked, so the connection is reachable. Per-item write errors are
  // retried next run (they are unmapped) and reported as degraded.
  await deps.store.updateHealth(connection.id, {
    health: errors.length === 0 ? "healthy" : "degraded",
    consecutiveFailures: 0,
    lastAttemptAt: now,
    lastSuccessAt: now,
    lastError: errors[0] ?? null,
    nextPollAt: new Date(now.getTime() + connection.poll_interval_seconds * 1000),
  });
  await deps.store.finishRun(runId, result);
  return result;
}
