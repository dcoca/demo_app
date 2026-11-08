import { constantTimeEqualHex, parseIntegrationToken, sha256Hex } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { ingestRequestSchema } from "@/lib/validation/schemas";
import type { ItemSource } from "@/types/domain";
import { inputProviderFor } from "../integrations/siri/siri-shortcut-provider";
import type { IngestionResult } from "../integrations/types";
import { addItems, type ItemWriter } from "./items-service";

export interface CredentialRecord {
  id: string;
  household_id: string;
  created_by: string;
  allowed_sources: ItemSource[];
  scopes: string[];
  token_hash: string;
  revoked_at: string | null;
}

export interface CredentialLookup {
  findByPrefix(prefix: string): Promise<CredentialRecord | null>;
  isMember(householdId: string, userId: string): Promise<boolean>;
  touchLastUsed(credentialId: string): Promise<void>;
}

export interface IngestDeps {
  credentials: CredentialLookup;
  items: ItemWriter;
}

const UNAUTHORIZED = () => new AppError("unauthorized", "Missing or invalid integration token");

export function bearerToken(header: string | null): string | null {
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  return match?.[1] ?? null;
}

/**
 * POST /api/v1/ingest
 *
 * Authorization comes from the credential, never from the payload: the
 * token resolves to exactly one household, and the payload's householdId must
 * match it. The credential stops working when revoked or when the member who
 * created it leaves the household.
 */
export async function ingest(deps: IngestDeps, authorization: string | null, body: unknown): Promise<IngestionResult> {
  const token = bearerToken(authorization);
  const parsedToken = token ? parseIntegrationToken(token) : null;
  if (!token || !parsedToken) throw UNAUTHORIZED();

  const credential = await deps.credentials.findByPrefix(parsedToken.prefix);
  if (!credential || !constantTimeEqualHex(credential.token_hash, sha256Hex(token))) throw UNAUTHORIZED();
  if (credential.revoked_at) throw UNAUTHORIZED();

  const parsed = ingestRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("bad_request", "Invalid ingestion payload", parsed.error.flatten());
  }
  const req = parsed.data;

  // Same response as a wrong household: do not confirm other households exist.
  if (req.householdId !== credential.household_id) {
    throw new AppError("forbidden", "This token is not allowed to write to that household");
  }
  if (!credential.scopes.includes("items:write")) {
    throw new AppError("forbidden", "This token cannot add items");
  }
  if (!credential.allowed_sources.includes(req.source)) {
    throw new AppError("forbidden", `This token is not allowed to submit as ${req.source}`);
  }
  if (!(await deps.credentials.isMember(credential.household_id, credential.created_by))) {
    throw UNAUTHORIZED();
  }

  const { items, actorLabel } = inputProviderFor(req.source).parse(req);
  if (items.length === 0) throw new AppError("bad_request", "No grocery items found in the request");

  const result = await addItems(deps.items, {
    householdId: credential.household_id,
    source: req.source,
    items,
    idempotencyKey: req.externalEventId,
    externalEventId: req.externalEventId,
    credentialId: credential.id,
    actorUserId: credential.created_by,
    actorLabel,
  });

  await deps.credentials.touchLastUsed(credential.id).catch(() => undefined);
  return result;
}
