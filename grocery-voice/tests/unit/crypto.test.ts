import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  generateIntegrationToken,
  hashPayload,
  parseIntegrationToken,
  sha256Hex,
} from "@/lib/crypto";
import { fromDatabaseError } from "@/lib/errors";
import { safeNext } from "@/lib/safe-redirect";
import { ORDER_TRANSITIONS, canTransition } from "@/features/orders/status";
import { can } from "@/features/households/permissions";

const KEY = Buffer.alloc(32, 9).toString("base64");

describe("integration tokens", () => {
  it("generates parseable tokens and stores only a hash", () => {
    const { token, prefix, hash } = generateIntegrationToken();
    expect(token).toMatch(/^gv_[A-Za-z0-9]{12}_[A-Za-z0-9]{40}$/);
    expect(parseIntegrationToken(token)).toEqual({ prefix });
    expect(hash).toBe(sha256Hex(token));
    expect(hash).not.toContain(token);
  });

  it("rejects malformed tokens", () => {
    expect(parseIntegrationToken("gv_short_x")).toBeNull();
    expect(parseIntegrationToken("Bearer gv_x")).toBeNull();
  });
});

describe("secret encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret("llat-token", KEY);
    const b = encryptSecret("llat-token", KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe("llat-token");
  });

  it("detects tampering and wrong keys", () => {
    const enc = encryptSecret("secret", KEY);
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join("."), KEY)).toThrow();
    expect(() => decryptSecret(enc, Buffer.alloc(32, 1).toString("base64"))).toThrow();
  });
});

describe("misc guards", () => {
  it("hashes payloads independent of key order", () => {
    expect(hashPayload({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashPayload({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });

  it("maps SQL error codes without leaking unknown errors", () => {
    expect(fromDatabaseError({ code: "GV409", message: "Idempotency key reused" }).code).toBe("idempotency_conflict");
    expect(fromDatabaseError({ code: "GV403", message: "x" }).status).toBe(403);
    const unknown = fromDatabaseError({ code: "XX000", message: "relation secret_table does not exist" });
    expect(unknown.status).toBe(500);
    expect(unknown.message).not.toContain("secret_table");
  });

  it("blocks open redirects", () => {
    expect(safeNext("/order")).toBe("/order");
    expect(safeNext("//evil.com")).toBe("/list");
    expect(safeNext("https://evil.com")).toBe("/list");
    expect(safeNext("/\\evil.com")).toBe("/list");
  });

  it("order states only move forward through explicit steps", () => {
    expect(canTransition("link_generated", "completed_unverified")).toBe(false);
    expect(canTransition("handoff_opened", "completed_unverified")).toBe(true);
    // Only a confirmed order can be archived.
    expect(ORDER_TRANSITIONS.filter(([, to]) => to === "archived")).toEqual([["completed_unverified", "archived"]]);
  });

  it("role permissions match the RLS policies", () => {
    expect(can("member", "list:edit")).toBe(true);
    expect(can("member", "members:invite")).toBe(false);
    expect(can("admin", "members:invite")).toBe(true);
    expect(can("admin", "members:change_role")).toBe(false);
    expect(can("owner", "members:change_role")).toBe(true);
    expect(can(null, "list:edit")).toBe(false);
  });
});
