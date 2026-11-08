import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function randomToken(length: number): string {
  // Rejection sampling keeps the distribution uniform over the alphabet.
  const out: string[] = [];
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) out.push(ALPHABET[byte % 62]!);
    }
  }
  return out.join("");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/** Stable JSON (sorted keys) so equal payloads hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function hashPayload(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

// ---------------------------------------------------------------------------
// Integration credential tokens: gv_<prefix>_<secret>
// The prefix is a public lookup id; only the SHA-256 of the whole token is stored.
// ---------------------------------------------------------------------------
const TOKEN_RE = /^gv_([A-Za-z0-9]{12})_([A-Za-z0-9]{40})$/;

export function generateIntegrationToken(): { token: string; prefix: string; hash: string } {
  const prefix = randomToken(12);
  const token = `gv_${prefix}_${randomToken(40)}`;
  return { token, prefix, hash: sha256Hex(token) };
}

export function parseIntegrationToken(token: string): { prefix: string } | null {
  const match = TOKEN_RE.exec(token);
  return match ? { prefix: match[1]! } : null;
}

// ---------------------------------------------------------------------------
// AES-256-GCM for secrets at rest (Home Assistant access tokens).
// Format: v1.<iv b64>.<tag b64>.<ciphertext b64>
// ---------------------------------------------------------------------------
function keyFrom(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("INTEGRATION_ENCRYPTION_KEY must be 32 bytes (base64)");
  return key;
}

export function encryptSecret(plaintext: string, base64Key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(base64Key), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(payload: string, base64Key: string): string {
  const [version, iv, tag, ct] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(base64Key), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}
