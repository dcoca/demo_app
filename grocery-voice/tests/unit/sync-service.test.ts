import { beforeEach, describe, expect, it } from "vitest";
import { MockAlexaShoppingList } from "@/server/integrations/alexa/mock-alexa-list";
import { nextPollAfterFailure, syncConnection, type SyncRunResult, type SyncStore } from "@/server/services/sync-service";
import type { IntegrationConnection } from "@/types/domain";
import { InMemoryItemWriter } from "./fakes";

class MemorySyncStore implements SyncStore {
  mappings = new Map<string, { itemId: string | null; summary: string }>();
  runs: SyncRunResult[] = [];
  checkpoints: Array<{ cursor: string; count: number }> = [];
  health: Array<Parameters<SyncStore["updateHealth"]>[1]> = [];
  failMappingOnce = false;

  async mappedExternalIds() {
    return new Set(this.mappings.keys());
  }
  async upsertMapping(row: Parameters<SyncStore["upsertMapping"]>[0]) {
    if (this.failMappingOnce) {
      this.failMappingOnce = false;
      throw new Error("crash after item write, before mapping");
    }
    this.mappings.set(row.externalId, { itemId: row.itemId, summary: row.summary });
  }
  async touchMappings() {}
  async startRun() {
    return `run-${this.runs.length + 1}`;
  }
  async finishRun(_id: string, r: SyncRunResult) {
    this.runs.push(r);
  }
  async saveCheckpoint(_c: string, cp: { cursor: string; count: number }) {
    this.checkpoints.push(cp);
  }
  async updateHealth(_c: string, patch: Parameters<SyncStore["updateHealth"]>[1]) {
    this.health.push(patch);
  }
}

const NOW = new Date("2026-11-08T12:00:00Z");

function connection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    id: "conn-1",
    household_id: "hh-1",
    provider: "home_assistant",
    label: "Alexa",
    base_url: "https://ha.example.com",
    entity_id: "todo.alexa_shopping_list",
    sync_direction: "inbound",
    poll_interval_seconds: 300,
    enabled: true,
    health: "unknown",
    consecutive_failures: 0,
    last_attempt_at: null,
    last_success_at: null,
    last_error: null,
    next_poll_at: NOW.toISOString(),
    lease_until: null,
    created_by: "user-1",
    created_at: NOW.toISOString(),
    ...overrides,
  };
}

describe("syncConnection (Alexa -> Grocery Voice)", () => {
  let alexa: MockAlexaShoppingList;
  let store: MemorySyncStore;
  let items: InMemoryItemWriter;
  const deps = () => ({ store, items, adapter: alexa, now: () => NOW });

  beforeEach(() => {
    alexa = new MockAlexaShoppingList();
    store = new MemorySyncStore();
    items = new InMemoryItemWriter();
  });

  it("imports new Alexa items with quantities parsed and source recorded", async () => {
    alexa.say("strawberries");
    alexa.say("2 gallons of milk");
    const r = await syncConnection(deps(), connection());
    expect(r).toMatchObject({ status: "succeeded", fetched: 2, imported: 2 });
    expect(items.items.map((i) => [i.name, i.quantity, i.unit, i.source])).toEqual([
      ["strawberries", null, null, "alexa"],
      ["milk", 2, "gallon", "alexa"],
    ]);
    expect(store.health.at(-1)).toMatchObject({ health: "healthy", consecutiveFailures: 0 });
  });

  it("re-reading the same list never duplicates items", async () => {
    alexa.say("strawberries");
    await syncConnection(deps(), connection());
    await syncConnection(deps(), connection());
    const third = await syncConnection(deps(), connection());
    expect(third).toMatchObject({ imported: 0, alreadyMapped: 1 });
    expect(items.items).toHaveLength(1);
    expect(items.items[0]!.quantity).toBeNull();
  });

  it("recovers from a crash between the item write and the mapping write", async () => {
    alexa.say("eggs");
    store.failMappingOnce = true;
    const first = await syncConnection(deps(), connection());
    expect(first.status).toBe("failed");
    expect(store.mappings.size).toBe(0);
    expect(items.items).toHaveLength(1);

    const second = await syncConnection(deps(), connection());
    expect(second.status).toBe("succeeded");
    expect(items.items).toHaveLength(1); // replayed via idempotency key, not re-added
    expect(store.mappings.get("mock-1")?.itemId).toBe(items.items[0]!.id);
  });

  it("does not touch internal items when Alexa is unavailable", async () => {
    alexa.say("bread");
    await syncConnection(deps(), connection());
    alexa.failNext(1);
    const r = await syncConnection(deps(), connection());
    expect(r.status).toBe("failed");
    expect(items.items).toHaveLength(1);
    expect(items.items[0]!.status).toBe("active");
  });

  it("does not delete internal items that disappear from Alexa", async () => {
    const bread = alexa.say("bread");
    await syncConnection(deps(), connection());
    alexa.complete(bread.externalId);
    await syncConnection(deps(), connection());
    expect(items.items[0]!.status).toBe("active");
  });

  it("degrades, then fails, with exponential backoff", async () => {
    alexa.failNext(3);
    let c = connection();
    for (let i = 1; i <= 3; i++) {
      await syncConnection(deps(), c);
      const h = store.health.at(-1)!;
      expect(h.consecutiveFailures).toBe(i);
      expect(h.health).toBe(i >= 3 ? "failing" : "degraded");
      expect(h.nextPollAt.getTime() - NOW.getTime()).toBe(300_000 * 2 ** (i - 1));
      c = connection({ consecutive_failures: i });
    }
    await syncConnection(deps(), c);
    expect(store.health.at(-1)).toMatchObject({ health: "healthy", consecutiveFailures: 0 });
  });

  it("caps backoff at six hours", () => {
    expect(nextPollAfterFailure(NOW, 3600, 20).getTime() - NOW.getTime()).toBe(6 * 3600 * 1000);
  });

  it("leaves a failed item unmapped so the next run retries it", async () => {
    alexa.say("rice");
    items.failNext = 1;
    const r = await syncConnection(deps(), connection());
    expect(r.status).toBe("failed");
    expect(store.health.at(-1)?.health).toBe("degraded");
    await syncConnection(deps(), connection());
    expect(items.items).toHaveLength(1);
  });

  it("records a checkpoint after each successful read", async () => {
    alexa.say("a");
    alexa.say("b");
    await syncConnection(deps(), connection());
    expect(store.checkpoints.at(-1)).toMatchObject({ count: 2 });
  });
});
