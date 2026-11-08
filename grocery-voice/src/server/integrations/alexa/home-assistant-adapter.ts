import { HttpError, isTransientHttpError, withRetry } from "@/lib/retry";
import type { ExternalListItem, ShoppingListSyncAdapter } from "../types";

/**
 * Reads Alexa's shopping list through Home Assistant.
 *
 * Amazon has no supported public API for the Alexa shopping list, so we rely
 * on Home Assistant exposing the list as a `todo.*` entity (for example via
 * its Alexa Devices integration) and read it with Home Assistant's documented
 * REST API:
 *
 *   POST /api/services/todo/get_items?return_response
 *   { "entity_id": "todo.alexa_shopping_list", "status": ["needs_action"] }
 *
 * Authentication is a Home Assistant long-lived access token. Grocery Voice
 * never sees Amazon credentials.
 *
 * Direction: inbound only (capabilities.write = false). A two-way adapter
 * would add todo.update_item / todo.add_item calls behind the same interface.
 */
export interface HomeAssistantAdapterOptions {
  baseUrl: string;
  entityId: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface HaTodoItem {
  uid?: unknown;
  summary?: unknown;
  status?: unknown;
  description?: unknown;
}

export class HomeAssistantShoppingListAdapter implements ShoppingListSyncAdapter {
  readonly providerId = "home_assistant";
  readonly capabilities = { read: true, write: false } as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HomeAssistantAdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private url(path: string) {
    return `${this.opts.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    return withRetry(
      async () => {
        const res = await this.fetchImpl(this.url(path), {
          ...init,
          redirect: "manual", // never follow redirects to other hosts
          headers: {
            Authorization: `Bearer ${this.opts.accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
        });
        if (res.status === 401 || res.status === 403) {
          throw new HttpError(res.status, "Home Assistant rejected the access token");
        }
        if (!res.ok) throw new HttpError(res.status, `Home Assistant responded ${res.status}`);
        return res.json();
      },
      {
        attempts: this.opts.attempts ?? 3,
        baseDelayMs: 500,
        isRetryable: isTransientHttpError,
        sleep: this.opts.sleep,
      },
    );
  }

  async fetchOpenItems(): Promise<ExternalListItem[]> {
    const body = await this.request("/api/services/todo/get_items?return_response", {
      method: "POST",
      body: JSON.stringify({ entity_id: this.opts.entityId, status: ["needs_action"] }),
    });

    const items = extractItems(body, this.opts.entityId);
    const out: ExternalListItem[] = [];
    for (const raw of items) {
      if (typeof raw.uid !== "string" || typeof raw.summary !== "string") continue;
      if (raw.status !== undefined && raw.status !== "needs_action") continue;
      const summary = raw.summary.trim();
      if (!summary) continue;
      out.push({
        externalId: raw.uid,
        summary: summary.slice(0, 120),
        description: typeof raw.description === "string" ? raw.description.slice(0, 500) : null,
      });
    }
    return out;
  }

  async checkHealth(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.request("/api/", { method: "GET" });
      return { ok: true, message: "Home Assistant API reachable" };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Unreachable" };
    }
  }
}

/** Accepts the documented `{ service_response: { <entity>: { items } } }` shape. */
export function extractItems(body: unknown, entityId: string): HaTodoItem[] {
  if (!body || typeof body !== "object") throw new Error("Unexpected Home Assistant response");
  const root = body as Record<string, unknown>;
  const container = (root.service_response ?? root) as Record<string, unknown>;
  const entity = container[entityId] as { items?: unknown } | undefined;
  if (!entity || !Array.isArray(entity.items)) {
    throw new Error(`Home Assistant returned no items for ${entityId}. Check the entity id.`);
  }
  return entity.items as HaTodoItem[];
}
