import { HttpError, isTransientHttpError, withRetry } from "@/lib/retry";
import type { GroceryOrderingProvider, ShoppingLinkRequest, ShoppingLinkResult } from "../types";
import { buildProductsLinkRequest, type InstacartProductsLinkResponse } from "./mapping";

export const INSTACART_BASE_URLS = {
  development: "https://connect.dev.instacart.tools",
  production: "https://connect.instacart.com",
} as const;

const LINK_TTL_DAYS = 14;

export interface InstacartProviderOptions {
  apiKey: string;
  environment: keyof typeof INSTACART_BASE_URLS;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Real Instacart Developer Platform provider. Creates a shopping-list page;
 * the person chooses a store and checks out on Instacart. Nothing here places
 * or pays for an order, and the API returns no checkout signal.
 */
export class InstacartProvider implements GroceryOrderingProvider {
  readonly providerId = "instacart";
  readonly isMock = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: InstacartProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async createShoppingLink(request: ShoppingLinkRequest): Promise<ShoppingLinkResult> {
    if (request.items.length === 0) throw new Error("Cannot create a shopping link for an empty list");

    const body = buildProductsLinkRequest({
      title: request.title,
      items: request.items,
      linkbackUrl: request.linkbackUrl,
      expiresInDays: LINK_TTL_DAYS,
    });
    const url = `${INSTACART_BASE_URLS[this.opts.environment]}/idp/v1/products/products_link`;

    const data = await withRetry(
      async () => {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          // Do not echo the response body: it may contain request details.
          throw new HttpError(res.status, `Instacart responded ${res.status}`);
        }
        return (await res.json()) as Partial<InstacartProductsLinkResponse>;
      },
      { attempts: 3, baseDelayMs: 500, isRetryable: isTransientHttpError, sleep: this.opts.sleep },
    );

    if (typeof data.products_link_url !== "string" || !/^https:\/\//.test(data.products_link_url)) {
      throw new Error("Instacart response did not include products_link_url");
    }

    return {
      url: data.products_link_url,
      expiresAt: new Date(Date.now() + LINK_TTL_DAYS * 24 * 3600 * 1000),
      isMock: false,
    };
  }
}

/**
 * Used when INSTACART_API_KEY is not configured. Returns a link to an in-app
 * page that states plainly that no Instacart request was made.
 */
export class MockInstacartProvider implements GroceryOrderingProvider {
  readonly providerId = "instacart";
  readonly isMock = true;

  constructor(private readonly appUrl: string) {}

  async createShoppingLink(request: ShoppingLinkRequest): Promise<ShoppingLinkResult> {
    if (request.items.length === 0) throw new Error("Cannot create a shopping link for an empty list");
    const payload = Buffer.from(
      JSON.stringify(
        buildProductsLinkRequest({ title: request.title, items: request.items, expiresInDays: LINK_TTL_DAYS }),
      ),
    ).toString("base64url");
    // Payload is a preview of the request we would have sent; no secrets.
    return {
      url: `${this.appUrl}/mock-instacart#${payload}`,
      expiresAt: null,
      isMock: true,
    };
  }
}
