import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Integration tests run against a real PostgreSQL with the Supabase shim and
 * all migrations applied (scripts/prepare-test-db.sh). They are skipped when
 * TEST_DATABASE_URL is not set.
 */
export const DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasDatabase = Boolean(DATABASE_URL);

let pool: pg.Pool | null = null;
export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  return pool;
}

export async function closeDb() {
  await pool?.end();
  pool = null;
}

type Claims = { sub?: string; role: string; email?: string };

/** Run queries as a Supabase role with JWT claims, inside a transaction. */
export async function as<T>(claims: Claims, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${claims.role === "service_role" ? "service_role" : claims.role === "anon" ? "anon" : "authenticated"}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export const asUser = <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  as({ sub: userId, role: "authenticated" }, fn);
export const asService = <T>(fn: (c: pg.PoolClient) => Promise<T>) => as({ role: "service_role" }, fn);
export const asAnon = <T>(fn: (c: pg.PoolClient) => Promise<T>) => as({ role: "anon" }, fn);

export async function createUser(name: string): Promise<{ id: string; email: string }> {
  const email = `${name}-${randomUUID().slice(0, 8)}@example.com`;
  const { rows } = await db().query(
    "insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id",
    [email, JSON.stringify({ display_name: name })],
  );
  return { id: rows[0].id, email };
}

export async function createHousehold(ownerId: string, name = "Home"): Promise<string> {
  return asUser(ownerId, async (c) => {
    const { rows } = await c.query("select public.create_household($1, 'America/New_York') as id", [name]);
    return rows[0].id as string;
  });
}

/** Adds a member directly (bypassing invitations) for test setup. */
export async function addMember(householdId: string, userId: string, role: "member" | "admin" | "owner" = "member") {
  await db().query("insert into public.household_members (household_id, user_id, role) values ($1, $2, $3)", [householdId, userId, role]);
}

export function item(name: string, extra: Record<string, unknown> = {}) {
  return { name, normalized_name: name.toLowerCase().replace(/s$/, ""), quantity: null, unit: null, ...extra };
}

export async function addItemsAs(
  userId: string,
  householdId: string,
  items: unknown[],
  key: string = randomUUID(),
  hash = "h-" + JSON.stringify(items),
) {
  return asUser(userId, async (c) => {
    const { rows } = await c.query(
      "select public.add_items($1, 'web', $2::jsonb, $3, $4, $5) as r",
      [householdId, JSON.stringify(items), `${userId}:${key}`, hash, userId],
    );
    return rows[0].r as { replayed: boolean; cycleId: string; results: Array<{ itemId: string; action: string; quantity: number | null }> };
  });
}

export async function expectPgError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (error) {
    const actual = (error as { code?: string }).code;
    if (actual !== code) throw new Error(`Expected SQLSTATE ${code}, got ${actual}: ${(error as Error).message}`);
    return;
  }
  throw new Error(`Expected SQLSTATE ${code}, but the statement succeeded`);
}
