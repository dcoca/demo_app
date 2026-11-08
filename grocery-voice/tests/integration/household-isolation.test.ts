import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addItemsAs,
  addMember,
  asAnon,
  asService,
  asUser,
  closeDb,
  createHousehold,
  createUser,
  db,
  expectPgError,
  hasDatabase,
  item,
} from "./db";

/**
 * Proves that Row-Level Security keeps households apart: a signed-in user who
 * is not a member of a household can neither read nor change any of its data,
 * through tables or SQL functions.
 */
describe.skipIf(!hasDatabase)("household isolation (RLS)", () => {
  let alice: { id: string; email: string };
  let bob: { id: string; email: string };
  let aliceHome: string;
  let bobHome: string;
  let aliceItemId: string;
  let aliceOrderId: string;

  const HOUSEHOLD_TABLES = [
    "households",
    "household_members",
    "household_invitations",
    "shopping_cycles",
    "shopping_items",
    "ingestion_events",
    "integration_connections",
    "external_item_mappings",
    "sync_runs",
    "household_schedules",
    "notification_preferences",
    "notifications",
    "orders",
    "order_snapshots",
    "shopping_links",
    "order_events",
  ];

  beforeAll(async () => {
    alice = await createUser("alice");
    bob = await createUser("bob");
    aliceHome = await createHousehold(alice.id, "Alice home");
    bobHome = await createHousehold(bob.id, "Bob home");

    const added = await addItemsAs(alice.id, aliceHome, [item("milk")]);
    aliceItemId = added.results[0]!.itemId;

    // Populate every household-scoped table for Alice's household.
    await asService(async (c) => {
      const { rows } = await c.query("select id from orders where household_id = $1", [aliceHome]);
      aliceOrderId = rows[0].id;
      await c.query(
        `insert into household_invitations (household_id, email, token_hash, invited_by) values ($1, 'x@example.com', $2, $3)`,
        [aliceHome, createHash("sha256").update(`t-${aliceHome}`).digest("hex"), alice.id],
      );
      const conn = await c.query(
        `insert into integration_connections (household_id, provider, label, base_url, entity_id, created_by)
         values ($1, 'home_assistant', 'HA', 'https://ha.example.com', 'todo.alexa', $2) returning id`,
        [aliceHome, alice.id],
      );
      await c.query(`insert into integration_connection_secrets (connection_id, encrypted_token) values ($1, 'v1.x.y.z')`, [conn.rows[0].id]);
      await c.query(
        `insert into external_item_mappings (connection_id, external_id, household_id, item_id, external_summary) values ($1, 'ext-1', $2, $3, 'milk')`,
        [conn.rows[0].id, aliceHome, aliceItemId],
      );
      await c.query(`insert into sync_runs (connection_id, household_id) values ($1, $2)`, [conn.rows[0].id, aliceHome]);
      await c.query(
        `insert into notifications (household_id, user_id, kind, dedupe_key, subject, body) values ($1, $2, 'review_reminder', $3, 's', 'b')`,
        [aliceHome, alice.id, `k-${aliceHome}`],
      );
      await c.query(
        `insert into integration_credentials (household_id, created_by, label, token_prefix, token_hash) values ($1, $2, 'phone', $3, 'abc')`,
        [aliceHome, alice.id, `pfx${aliceHome.replace(/-/g, "").slice(0, 9)}`],
      );
      const snap = await c.query(
        `insert into order_snapshots (order_id, household_id, version, content_hash, items, item_count) values ($1, $2, 1, 'h', '[]', 0) returning id`,
        [aliceOrderId, aliceHome],
      );
      await c.query(
        `insert into shopping_links (order_id, snapshot_id, household_id, provider, status) values ($1, $2, $3, 'instacart', 'pending')`,
        [aliceOrderId, snap.rows[0].id, aliceHome],
      );
    });
    // A voice event (service caller, as the ingest route does) to populate ingestion_events.
    await asService((c) =>
      c.query("select public.add_items($1, 'siri', $2::jsonb, 'evt-seed', 'h', $3, 'Siri', 'evt-seed')", [
        aliceHome,
        JSON.stringify([item("bread")]),
        alice.id,
      ]),
    );
  });

  afterAll(closeDb);

  it("the owner can see every household-scoped table for their household", async () => {
    await asUser(alice.id, async (c) => {
      for (const table of HOUSEHOLD_TABLES) {
        const col = table === "households" ? "id" : "household_id";
        const { rowCount } = await c.query(`select 1 from public.${table} where ${col} = $1`, [aliceHome]);
        expect(rowCount, table).toBeGreaterThan(0);
      }
    });
  });

  it("a non-member sees zero rows of another household in every table", async () => {
    await asUser(bob.id, async (c) => {
      for (const table of HOUSEHOLD_TABLES) {
        const col = table === "households" ? "id" : "household_id";
        const { rowCount } = await c.query(`select 1 from public.${table} where ${col} = $1`, [aliceHome]);
        expect(rowCount, table).toBe(0);
      }
    });
  });

  it("anonymous callers see nothing", async () => {
    await asAnon(async (c) => {
      for (const table of HOUSEHOLD_TABLES) {
        const result = await c.query(`select 1 from public.${table}`).catch((e: { code: string }) => e);
        if ("rowCount" in result) expect(result.rowCount, table).toBe(0);
        else expect(result.code, table).toBe("42501");
      }
    });
  });

  it("a non-member cannot update or 'complete' another household's items", async () => {
    await asUser(bob.id, async (c) => {
      const { rowCount } = await c.query("update shopping_items set status = 'completed' where id = $1", [aliceItemId]);
      expect(rowCount).toBe(0);
    });
    const { rows } = await db().query("select status from shopping_items where id = $1", [aliceItemId]);
    expect(rows[0].status).toBe("active");
  });

  it("a member cannot move an item into another household", async () => {
    await expectPgError(
      asUser(alice.id, (c) => c.query("update shopping_items set household_id = $1 where id = $2", [bobHome, aliceItemId])),
      "GV422",
    );
  });

  it("a non-member cannot insert items, even by naming the household", async () => {
    await expectPgError(addItemsAs(bob.id, aliceHome, [item("caviar")]), "GV403");
    const { rows } = await db().query("select id from shopping_cycles where household_id = $1 and status = 'open'", [aliceHome]);
    await expectPgError(
      asUser(bob.id, (c) =>
        c.query("insert into shopping_items (household_id, cycle_id, name, normalized_name) values ($1, $2, 'x', 'x')", [
          aliceHome,
          rows[0].id,
        ]),
      ),
      "42501",
    );
  });

  it("users cannot spoof a voice source or another actor through add_items", async () => {
    await expectPgError(
      asUser(alice.id, (c) =>
        c.query("select public.add_items($1, 'siri', $2::jsonb, 'k-spoof', 'h', $3)", [aliceHome, JSON.stringify([item("x")]), alice.id]),
      ),
      "GV403",
    );
    await expectPgError(
      asUser(alice.id, (c) =>
        c.query("select public.add_items($1, 'web', $2::jsonb, 'k-spoof2', 'h', $3)", [aliceHome, JSON.stringify([item("x")]), bob.id]),
      ),
      "GV403",
    );
  });

  it("a non-member cannot drive another household's order", async () => {
    await expectPgError(
      asUser(bob.id, (c) => c.query("select public.transition_order($1, 'approved')", [aliceOrderId])),
      "GV404",
    );
    await expectPgError(asUser(bob.id, (c) => c.query("select public.close_cycle($1)", [aliceOrderId])), "GV404");
  });

  it("orders, snapshots and links are read-only to members (writes go through the server)", async () => {
    await expectPgError(
      asUser(alice.id, (c) => c.query("update orders set status = 'completed_unverified' where id = $1", [aliceOrderId])),
      "42501",
    );
    await expectPgError(
      asUser(alice.id, (c) => c.query("insert into shopping_links (order_id, snapshot_id, household_id, provider) values ($1, $1, $2, 'x')", [aliceOrderId, aliceHome])),
      "42501",
    );
  });

  it("secrets never reach client roles", async () => {
    await expectPgError(asUser(alice.id, (c) => c.query("select encrypted_token from integration_connection_secrets")), "42501");
    await expectPgError(asUser(alice.id, (c) => c.query("select token_hash from integration_credentials")), "42501");
    // RLS with no policies: the table is readable in principle but always empty to clients.
    const keys = await asUser(alice.id, (c) => c.query("select * from idempotency_keys"));
    expect(keys.rowCount).toBe(0);
    const { rowCount } = await asUser(alice.id, (c) =>
      c.query("select id, token_prefix from integration_credentials where household_id = $1", [aliceHome]),
    );
    expect(rowCount).toBe(1);
  });

  it("server-only functions cannot be called by users", async () => {
    await expectPgError(asUser(alice.id, (c) => c.query("select * from public.claim_notifications(10, 60)")), "42501");
    await expectPgError(asUser(alice.id, (c) => c.query("select * from public.claim_due_connections(10, 60)")), "42501");
    await expectPgError(asUser(alice.id, (c) => c.query("select public.ensure_open_cycle($1)", [aliceHome])), "42501");
  });

  it("a non-member cannot read other members' profiles", async () => {
    const { rowCount } = await asUser(bob.id, (c) => c.query("select 1 from profiles where id = $1", [alice.id]));
    expect(rowCount).toBe(0);
  });
});

describe.skipIf(!hasDatabase)("membership roles", () => {
  afterAll(closeDb);

  it("members cannot invite or change roles; admins invite; owners manage roles", async () => {
    const owner = await createUser("owner");
    const admin = await createUser("admin");
    const member = await createUser("member");
    const home = await createHousehold(owner.id);
    await addMember(home, admin.id, "admin");
    await addMember(home, member.id, "member");

    const invite = (userId: string, email: string) =>
      asUser(userId, (c) =>
        c.query("insert into household_invitations (household_id, email, token_hash, invited_by) values ($1, $2, $3, $4)", [
          home,
          email,
          createHash("sha256").update(`${email}-${userId}`).digest("hex"),
          userId,
        ]),
      );

    await expectPgError(invite(member.id, "a@example.com"), "42501");
    await invite(admin.id, "b@example.com");

    const promote = (actor: string) =>
      asUser(actor, (c) => c.query("update household_members set role = 'owner' where household_id = $1 and user_id = $2", [home, member.id]));
    expect((await promote(member.id)).rowCount).toBe(0);
    expect((await promote(admin.id)).rowCount).toBe(0);
    expect((await promote(owner.id)).rowCount).toBe(1);
  });

  it("a household always keeps an owner", async () => {
    const owner = await createUser("solo");
    const home = await createHousehold(owner.id);
    await expectPgError(
      asUser(owner.id, (c) => c.query("delete from household_members where household_id = $1 and user_id = $2", [home, owner.id])),
      "GV422",
    );
    await expectPgError(
      asUser(owner.id, (c) => c.query("update household_members set role = 'member' where household_id = $1 and user_id = $2", [home, owner.id])),
      "GV422",
    );
  });

  it("removed members immediately lose access", async () => {
    const owner = await createUser("o");
    const leaver = await createUser("leaver");
    const home = await createHousehold(owner.id);
    await addMember(home, leaver.id);
    expect((await asUser(leaver.id, (c) => c.query("select 1 from shopping_cycles where household_id = $1", [home]))).rowCount).toBe(1);
    await asUser(leaver.id, (c) => c.query("delete from household_members where household_id = $1 and user_id = $2", [home, leaver.id]));
    expect((await asUser(leaver.id, (c) => c.query("select 1 from shopping_cycles where household_id = $1", [home]))).rowCount).toBe(0);
  });
});

describe.skipIf(!hasDatabase)("invitations", () => {
  afterAll(closeDb);

  async function setup() {
    const owner = await createUser("host");
    const guest = await createUser("guest");
    const stranger = await createUser("stranger");
    const home = await createHousehold(owner.id);
    const tokenHash = createHash("sha256").update(`invite-${home}`).digest("hex");
    await asUser(owner.id, (c) =>
      c.query("insert into household_invitations (household_id, email, token_hash, invited_by) values ($1, $2, $3, $4)", [
        home,
        guest.email,
        tokenHash,
        owner.id,
      ]),
    );
    return { owner, guest, stranger, home, tokenHash };
  }

  it("only the invited email can accept, and accepting twice is harmless", async () => {
    const { guest, stranger, home, tokenHash } = await setup();
    await expectPgError(asUser(stranger.id, (c) => c.query("select public.accept_invitation($1)", [tokenHash])), "GV403");
    const joined = await asUser(guest.id, (c) => c.query("select public.accept_invitation($1) as id", [tokenHash]));
    expect(joined.rows[0].id).toBe(home);
    await asUser(guest.id, (c) => c.query("select public.accept_invitation($1)", [tokenHash]));
    const { rows } = await db().query("select role from household_members where household_id = $1 and user_id = $2", [home, guest.id]);
    expect(rows).toEqual([{ role: "member" }]);
  });

  it("revoked, expired and unknown invitations are rejected", async () => {
    const { owner, guest, tokenHash } = await setup();
    await asUser(owner.id, (c) => c.query("update household_invitations set revoked_at = now() where token_hash = $1", [tokenHash]));
    await expectPgError(asUser(guest.id, (c) => c.query("select public.accept_invitation($1)", [tokenHash])), "GV404");
    await expectPgError(asUser(guest.id, (c) => c.query("select public.accept_invitation('nope')")), "GV404");
  });
});
