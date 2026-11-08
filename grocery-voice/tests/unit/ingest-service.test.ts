import { beforeEach, describe, expect, it } from "vitest";
import { generateIntegrationToken } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { ingest, type CredentialLookup, type CredentialRecord } from "@/server/services/ingest-service";
import { InMemoryItemWriter } from "./fakes";

const HOUSEHOLD = "11111111-1111-4111-8111-111111111111";
const OTHER_HOUSEHOLD = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

class FakeCredentials implements CredentialLookup {
  byPrefix = new Map<string, CredentialRecord>();
  members = new Set<string>([`${HOUSEHOLD}:${USER}`]);
  touched: string[] = [];
  async findByPrefix(prefix: string) {
    return this.byPrefix.get(prefix) ?? null;
  }
  async isMember(h: string, u: string) {
    return this.members.has(`${h}:${u}`);
  }
  async touchLastUsed(id: string) {
    this.touched.push(id);
  }
}

function setup(overrides: Partial<CredentialRecord> = {}) {
  const creds = new FakeCredentials();
  const writer = new InMemoryItemWriter();
  const { token, prefix, hash } = generateIntegrationToken();
  creds.byPrefix.set(prefix, {
    id: "cred-1",
    household_id: HOUSEHOLD,
    created_by: USER,
    allowed_sources: ["siri"],
    scopes: ["items:write"],
    token_hash: hash,
    revoked_at: null,
    ...overrides,
  });
  return { creds, writer, token, deps: { credentials: creds, items: writer } };
}

const body = (extra: Record<string, unknown> = {}) => ({
  source: "siri",
  externalEventId: "evt-1",
  householdId: HOUSEHOLD,
  items: [{ name: "milk", quantity: 2, unit: "gallon" }],
  ...extra,
});

async function expectError(p: Promise<unknown>, code: AppError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === code);
}

describe("ingest", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("adds items for a valid token and records the source", async () => {
    const result = await ingest(ctx.deps, `Bearer ${ctx.token}`, body());
    expect(result.replayed).toBe(false);
    expect(ctx.writer.items).toHaveLength(1);
    expect(ctx.writer.items[0]).toMatchObject({ name: "milk", quantity: 2, unit: "gallon", source: "siri", added_by: USER });
    expect(ctx.creds.touched).toEqual(["cred-1"]);
  });

  it("rejects missing, malformed and unknown tokens", async () => {
    await expectError(ingest(ctx.deps, null, body()), "unauthorized");
    await expectError(ingest(ctx.deps, "Bearer nope", body()), "unauthorized");
    const { token: stranger } = generateIntegrationToken();
    await expectError(ingest(ctx.deps, `Bearer ${stranger}`, body()), "unauthorized");
    expect(ctx.writer.calls).toBe(0);
  });

  it("rejects a token whose secret half is wrong", async () => {
    const tampered = ctx.token.slice(0, -1) + (ctx.token.endsWith("A") ? "B" : "A");
    await expectError(ingest(ctx.deps, `Bearer ${tampered}`, body()), "unauthorized");
  });

  it("never trusts householdId alone", async () => {
    await expectError(ingest(ctx.deps, `Bearer ${ctx.token}`, body({ householdId: OTHER_HOUSEHOLD })), "forbidden");
    expect(ctx.writer.calls).toBe(0);
  });

  it("rejects revoked tokens", async () => {
    const revoked = setup({ revoked_at: new Date().toISOString() });
    await expectError(ingest(revoked.deps, `Bearer ${revoked.token}`, body()), "unauthorized");
  });

  it("stops working when the creator leaves the household", async () => {
    ctx.creds.members.clear();
    await expectError(ingest(ctx.deps, `Bearer ${ctx.token}`, body()), "unauthorized");
  });

  it("enforces the sources a token may submit as", async () => {
    await expectError(ingest(ctx.deps, `Bearer ${ctx.token}`, body({ source: "alexa" })), "forbidden");
  });

  it("validates the payload", async () => {
    await expectError(ingest(ctx.deps, `Bearer ${ctx.token}`, body({ items: [] })), "bad_request");
    await expectError(ingest(ctx.deps, `Bearer ${ctx.token}`, body({ text: "milk" })), "bad_request"); // both
    await expectError(ingest(ctx.deps, `Bearer ${ctx.token}`, { ...body(), extra: 1 }), "bad_request");
    await expectError(ingest(ctx.deps, `Bearer ${ctx.token}`, body({ externalEventId: "" })), "bad_request");
  });

  it("parses dictated text", async () => {
    await ingest(ctx.deps, `Bearer ${ctx.token}`, {
      source: "siri",
      externalEventId: "evt-text",
      householdId: HOUSEHOLD,
      text: "milk, two dozen eggs and bananas",
      device: "Dana's iPhone",
    });
    expect(ctx.writer.items.map((i) => [i.name, i.quantity, i.unit])).toEqual([
      ["milk", null, null],
      ["eggs", 2, "dozen"],
      ["bananas", null, null],
    ]);
    expect(ctx.writer.items[0]!.added_by_label).toBe("Siri (Dana's iPhone)");
  });

  it("is idempotent per externalEventId: a retry never increases quantity", async () => {
    await ingest(ctx.deps, `Bearer ${ctx.token}`, body());
    const retry = await ingest(ctx.deps, `Bearer ${ctx.token}`, body());
    expect(retry.replayed).toBe(true);
    expect(ctx.writer.items).toHaveLength(1);
    expect(ctx.writer.items[0]!.quantity).toBe(2);
  });

  it("an identical explicit add with a NEW event id follows the duplicate policy", async () => {
    await ingest(ctx.deps, `Bearer ${ctx.token}`, body());
    await ingest(ctx.deps, `Bearer ${ctx.token}`, body({ externalEventId: "evt-2" }));
    expect(ctx.writer.items).toHaveLength(1);
    expect(ctx.writer.items[0]!.quantity).toBe(4);

    const separate = setup();
    separate.writer.policy = "separate_item";
    await ingest(separate.deps, `Bearer ${separate.token}`, body());
    await ingest(separate.deps, `Bearer ${separate.token}`, body({ externalEventId: "evt-2" }));
    expect(separate.writer.items).toHaveLength(2);
  });

  it("rejects reuse of an event id with different content", async () => {
    await ingest(ctx.deps, `Bearer ${ctx.token}`, body());
    await expectError(
      ingest(ctx.deps, `Bearer ${ctx.token}`, body({ items: [{ name: "eggs" }] })),
      "idempotency_conflict",
    );
  });

  it("merges case variants but not different products", async () => {
    await ingest(ctx.deps, `Bearer ${ctx.token}`, body({ items: [{ name: "Bananas" }, { name: "organic milk" }] }));
    await ingest(ctx.deps, `Bearer ${ctx.token}`, body({ externalEventId: "e2", items: [{ name: "bananas" }, { name: "almond milk" }] }));
    expect(ctx.writer.items.map((i) => [i.name, i.quantity])).toEqual([
      ["Bananas", 2],
      ["organic milk", null],
      ["almond milk", null],
    ]);
  });
});
