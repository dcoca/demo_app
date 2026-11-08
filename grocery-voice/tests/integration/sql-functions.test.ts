import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ORDER_TRANSITIONS } from "@/features/orders/status";
import { normalizeItemName } from "@/features/shopping/normalize";
import { addItemsAs, addMember, asService, asUser, closeDb, createHousehold, createUser, db, expectPgError, hasDatabase } from "./db";

const n = (name: string, extra: Record<string, unknown> = {}) => ({ name, normalized_name: normalizeItemName(name), ...extra });

async function activeItems(householdId: string) {
  const { rows } = await db().query(
    `select i.name, i.quantity::float as quantity, i.unit
     from shopping_items i join shopping_cycles c on c.id = i.cycle_id
     where i.household_id = $1 and c.status = 'open' and i.status = 'active' order by i.created_at`,
    [householdId],
  );
  return rows as Array<{ name: string; quantity: number | null; unit: string | null }>;
}

describe.skipIf(!hasDatabase)("add_items", () => {
  afterAll(closeDb);

  it("replaying the same idempotency key never changes quantity", async () => {
    const u = await createUser("u");
    const h = await createHousehold(u.id);
    const first = await addItemsAs(u.id, h, [n("milk", { quantity: 1 })], "key-1", "hash-1");
    const again = await addItemsAs(u.id, h, [n("milk", { quantity: 1 })], "key-1", "hash-1");
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.results).toEqual(first.results);
    expect(await activeItems(h)).toEqual([{ name: "milk", quantity: 1, unit: null }]);
  });

  it("rejects the same key with a different payload", async () => {
    const u = await createUser("u");
    const h = await createHousehold(u.id);
    await addItemsAs(u.id, h, [n("milk")], "key-1", "hash-1");
    await expectPgError(addItemsAs(u.id, h, [n("eggs")], "key-1", "hash-2"), "GV409");
  });

  it("concurrent retries with one key create exactly one item", async () => {
    const u = await createUser("u");
    const h = await createHousehold(u.id);
    await Promise.all(Array.from({ length: 8 }, () => addItemsAs(u.id, h, [n("eggs", { quantity: 12 })], "same-key", "same-hash")));
    expect(await activeItems(h)).toEqual([{ name: "eggs", quantity: 12, unit: null }]);
  });

  it("concurrent distinct adds of the same item merge instead of racing (increase_quantity)", async () => {
    const u = await createUser("u");
    const h = await createHousehold(u.id);
    await Promise.all(Array.from({ length: 6 }, () => addItemsAs(u.id, h, [n("Bananas")])));
    expect(await activeItems(h)).toEqual([{ name: "Bananas", quantity: 6, unit: null }]);
  });

  it("explicit duplicate adds follow the household policy", async () => {
    const u = await createUser("u");
    const h = await createHousehold(u.id);
    await addItemsAs(u.id, h, [n("Bananas")]);
    await addItemsAs(u.id, h, [n("bananas", { quantity: 2 })]);
    expect(await activeItems(h)).toEqual([{ name: "Bananas", quantity: 3, unit: null }]);

    await asUser(u.id, (c) => c.query("update households set duplicate_policy = 'separate_item' where id = $1", [h]));
    await addItemsAs(u.id, h, [n("bananas")]);
    expect((await activeItems(h)).length).toBe(2);
  });

  it("never merges different products or different units", async () => {
    const u = await createUser("u");
    const h = await createHousehold(u.id);
    await addItemsAs(u.id, h, [n("organic milk"), n("almond milk"), n("milk", { unit: "gallon" })]);
    await addItemsAs(u.id, h, [n("milk", { unit: "quart" })]);
    expect((await activeItems(h)).map((i) => `${i.name}/${i.unit}`)).toEqual([
      "organic milk/null",
      "almond milk/null",
      "milk/gallon",
      "milk/quart",
    ]);
  });

  it("a completed item is not merged into; re-adding creates a fresh line", async () => {
    const u = await createUser("u");
    const h = await createHousehold(u.id);
    const r = await addItemsAs(u.id, h, [n("bread")]);
    await asUser(u.id, (c) => c.query("update shopping_items set status = 'completed' where id = $1", [r.results[0]!.itemId]));
    await addItemsAs(u.id, h, [n("bread")]);
    expect(await activeItems(h)).toEqual([{ name: "bread", quantity: null, unit: null }]);
  });

  it("records voice events once per (household, source, external id)", async () => {
    const u = await createUser("u");
    const h = await createHousehold(u.id);
    const call = () =>
      asService((c) =>
        c.query("select public.add_items($1, 'siri', $2::jsonb, 'evt-9', 'h', $3, 'Siri', 'evt-9') as r", [h, JSON.stringify([n("milk")]), u.id]),
      );
    await call();
    const replay = await call();
    expect(replay.rows[0].r.replayed).toBe(true);
    const { rows } = await db().query("select count(*)::int as c from ingestion_events where household_id = $1", [h]);
    expect(rows[0].c).toBe(1);
  });

  it("bumps version on every update for optimistic concurrency", async () => {
    const u = await createUser("u");
    const h = await createHousehold(u.id);
    const r = await addItemsAs(u.id, h, [n("rice")]);
    const id = r.results[0]!.itemId;
    const upd = (version: number) =>
      asUser(u.id, (c) => c.query("update shopping_items set notes = 'basmati' where id = $1 and version = $2", [id, version]));
    expect((await upd(1)).rowCount).toBe(1);
    expect((await upd(1)).rowCount).toBe(0); // stale writer loses
    const { rows } = await db().query("select version, completed_at from shopping_items where id = $1", [id]);
    expect(rows[0].version).toBe(2);
  });
});

describe.skipIf(!hasDatabase)("orders and cycles", () => {
  afterAll(closeDb);

  it("the TypeScript transition table matches the database exactly", async () => {
    const { rows } = await db().query(`
      select f::text as from, t::text as to
      from unnest(enum_range(null::order_status)) f, unnest(enum_range(null::order_status)) t
      where public.order_transition_allowed(f, t)`);
    const sql = rows.map((r) => `${r.from}->${r.to}`).sort();
    const ts = ORDER_TRANSITIONS.map(([f, t]) => `${f}->${t}`).sort();
    expect(sql).toEqual(ts);
  });

  it("rejects invalid transitions and stale expectations", async () => {
    const u = await createUser("u");
    const h = await createHousehold(u.id);
    const { rows } = await db().query("select id from orders where household_id = $1", [h]);
    const orderId = rows[0].id;
    await expectPgError(asUser(u.id, (c) => c.query("select public.transition_order($1, 'completed_unverified')", [orderId])), "GV409");
    await expectPgError(
      asUser(u.id, (c) => c.query("select public.transition_order($1, 'approved', array['ready_for_review']::order_status[])", [orderId])),
      "GV409",
    );
    await asUser(u.id, (c) => c.query("select public.transition_order($1, 'approved')", [orderId]));
    const ev = await db().query("select from_status, to_status, actor_id from order_events where order_id = $1 order by created_at", [orderId]);
    expect(ev.rows.at(-1)).toEqual({ from_status: "draft", to_status: "approved", actor_id: u.id });
  });

  it("closing a cycle archives the order and carries over items added after the snapshot", async () => {
    const u = await createUser("u");
    const partner = await createUser("p");
    const h = await createHousehold(u.id);
    await addMember(h, partner.id);
    const ordered = await addItemsAs(u.id, h, [n("milk"), n("strawberries")]);
    const { rows } = await db().query("select id from orders where household_id = $1", [h]);
    const orderId = rows[0].id as string;

    // Snapshot of what was sent to Instacart (written by the server).
    await asService(async (c) => {
      const snap = await c.query(
        "insert into order_snapshots (order_id, household_id, version, content_hash, items, item_count) values ($1, $2, 1, 'h', $3, 2) returning id",
        [orderId, h, JSON.stringify(ordered.results.map((r) => ({ itemId: r.itemId })))],
      );
      await c.query("update orders set current_snapshot_id = $1 where id = $2", [snap.rows[0].id, orderId]);
    });
    for (const to of ["approved", "link_generated", "handoff_opened"]) {
      await asUser(u.id, (c) => c.query("select public.transition_order($1, $2::order_status)", [orderId, to]));
    }
    // Added through Alexa after the link was generated: must not be lost.
    await addItemsAs(partner.id, h, [n("eggs")]);

    await expectPgError(asUser(u.id, (c) => c.query("select public.close_cycle($1)", [orderId])), "GV409");
    await asUser(partner.id, (c) => c.query("select public.transition_order($1, 'completed_unverified')", [orderId]));

    const closed = await asUser(u.id, (c) => c.query("select public.close_cycle($1) as r", [orderId]));
    expect(closed.rows[0].r).toMatchObject({ carriedOver: 1, replayed: false });
    expect((await activeItems(h)).map((i) => i.name)).toEqual(["eggs"]);

    const order = await db().query("select status, completed_by from orders where id = $1", [orderId]);
    expect(order.rows[0]).toEqual({ status: "archived", completed_by: partner.id });

    const again = await asUser(u.id, (c) => c.query("select public.close_cycle($1) as r", [orderId]));
    expect(again.rows[0].r.replayed).toBe(true);

    const cycles = await db().query("select sequence, status from shopping_cycles where household_id = $1 order by sequence", [h]);
    expect(cycles.rows).toEqual([
      { sequence: 1, status: "closed" },
      { sequence: 2, status: "open" },
    ]);
    const newOrder = await db().query("select o.status from orders o join shopping_cycles c on c.id = o.cycle_id where c.household_id = $1 and c.status = 'open'", [h]);
    expect(newOrder.rows).toEqual([{ status: "draft" }]);
  });
});

describe.skipIf(!hasDatabase)("scheduler primitives", () => {
  afterAll(closeDb);

  it("notifications dedupe by key and are claimed by one worker at a time", async () => {
    const u = await createUser("u");
    const h = await createHousehold(u.id);
    const key = `review_reminder:${h}:2026-11-08:${u.id}`;
    const insert = () =>
      db().query(
        `insert into notifications (household_id, user_id, kind, dedupe_key, subject, body, payload)
         values ($1, $2, 'review_reminder', $3, 's', 'b', '{}') on conflict (dedupe_key) do nothing`,
        [h, u.id, key],
      );
    await insert();
    await insert();
    const count = await db().query("select count(*)::int as c from notifications where dedupe_key = $1", [key]);
    expect(count.rows[0].c).toBe(1);

    const claims = await Promise.all(
      Array.from({ length: 4 }, () => asService((c) => c.query("select id from public.claim_notifications(100, 60) where dedupe_key = $1", [key]))),
    );
    expect(claims.reduce((sum, r) => sum + (r.rowCount ?? 0), 0)).toBe(1);
  });

  it("job locks admit one holder until released or expired", async () => {
    const job = `job-${randomUUID()}`;
    const take = (holder: string) =>
      asService(async (c) => (await c.query("select public.try_acquire_job_lock($1, $2, 60) as ok", [job, holder])).rows[0].ok as boolean);
    expect(await take("a")).toBe(true);
    expect(await take("b")).toBe(false);
    await asService((c) => c.query("select public.release_job_lock($1, 'a')", [job]));
    expect(await take("b")).toBe(true);
  });

  it("due Home Assistant connections are leased so overlapping runs skip them", async () => {
    const u = await createUser("u");
    const h = await createHousehold(u.id);
    await db().query(
      `insert into integration_connections (household_id, provider, label, base_url, entity_id, created_by, next_poll_at)
       values ($1, 'home_assistant', 'HA', 'https://ha.example.com', 'todo.alexa', $2, now() - interval '1 minute')`,
      [h, u.id],
    );
    const claim = () =>
      asService((c) => c.query("select id from public.claim_due_connections(100, 120) where household_id = $1", [h]));
    expect((await claim()).rowCount).toBe(1);
    expect((await claim()).rowCount).toBe(0);
  });
});
