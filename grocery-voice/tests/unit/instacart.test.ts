import { describe, expect, it } from "vitest";
import { InstacartProvider, MockInstacartProvider } from "@/server/integrations/instacart/instacart-provider";
import { buildProductsLinkRequest, toInstacartLineItem, toMeasurement } from "@/server/integrations/instacart/mapping";
import type { SnapshotItem } from "@/types/domain";

const item = (overrides: Partial<SnapshotItem> = {}): SnapshotItem => ({
  itemId: "i1", name: "milk", quantity: null, unit: null, brand: null, organic: false, upc: null, notes: null, ...overrides,
});

describe("Instacart line item mapping", () => {
  it("uses line_item_measurements, never the deprecated quantity/unit fields", () => {
    const line = toInstacartLineItem(item({ quantity: 2, unit: "gallon" }));
    expect(line).toEqual({ name: "milk", line_item_measurements: [{ quantity: 2, unit: "gallon" }] });
    expect(line).not.toHaveProperty("quantity");
    expect(line).not.toHaveProperty("unit");
  });

  it("maps units and converts dozens", () => {
    expect(toMeasurement(1, "lb")).toEqual({ quantity: 1, unit: "pound" });
    expect(toMeasurement(2, "dozen")).toEqual({ quantity: 24, unit: "each" });
    expect(toMeasurement(1, "half gallon")).toEqual({ quantity: 0.5, unit: "gallon" });
    expect(toMeasurement(null, null)).toEqual({ quantity: 1, unit: "each" });
    expect(toMeasurement(3, "sleeve")).toEqual({ quantity: 3, unit: "each" });
  });

  it("adds brand and organic filters, UPCs and notes", () => {
    const line = toInstacartLineItem(item({ name: "yogurt", brand: "Chobani", organic: true, upc: "0818290011312", notes: "vanilla" }));
    expect(line.filters).toEqual({ brand_filters: ["Chobani"], health_filters: ["ORGANIC"] });
    expect(line.upcs).toEqual(["0818290011312"]);
    expect(line.display_text).toBe("yogurt (vanilla)");
  });

  it("builds a shopping_list request", () => {
    const body = buildProductsLinkRequest({ title: "Parkers groceries", items: [item()], linkbackUrl: "https://app/order", expiresInDays: 14 });
    expect(body).toMatchObject({
      title: "Parkers groceries",
      link_type: "shopping_list",
      expires_in: 14,
      landing_page_configuration: { partner_linkback_url: "https://app/order", enable_pantry_items: false },
    });
  });
});

describe("InstacartProvider", () => {
  function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const r = responses.shift()!;
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }
  const noSleep = async () => {};

  it("posts to the documented endpoint with a bearer key and returns products_link_url", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 200, body: { products_link_url: "https://customers.dev.instacart.tools/store/shopping_lists/123" } }]);
    const p = new InstacartProvider({ apiKey: "key_abc", environment: "development", fetchImpl, sleep: noSleep });
    const r = await p.createShoppingLink({ title: "t", items: [item()] });
    expect(r.url).toBe("https://customers.dev.instacart.tools/store/shopping_lists/123");
    expect(r.isMock).toBe(false);
    expect(calls[0]!.url).toBe("https://connect.dev.instacart.tools/idp/v1/products/products_link");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer key_abc");
    expect(JSON.parse(calls[0]!.init.body as string).line_items[0].name).toBe("milk");
  });

  it("uses the production host in production", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 200, body: { products_link_url: "https://www.instacart.com/x" } }]);
    await new InstacartProvider({ apiKey: "k", environment: "production", fetchImpl, sleep: noSleep }).createShoppingLink({ title: "t", items: [item()] });
    expect(calls[0]!.url).toBe("https://connect.instacart.com/idp/v1/products/products_link");
  });

  it("retries 429/5xx but not 4xx", async () => {
    const retry = fakeFetch([{ status: 503 }, { status: 429 }, { status: 200, body: { products_link_url: "https://www.instacart.com/x" } }]);
    await new InstacartProvider({ apiKey: "k", environment: "development", fetchImpl: retry.fetchImpl, sleep: noSleep }).createShoppingLink({ title: "t", items: [item()] });
    expect(retry.calls).toHaveLength(3);

    const bad = fakeFetch([{ status: 400 }]);
    await expect(
      new InstacartProvider({ apiKey: "k", environment: "development", fetchImpl: bad.fetchImpl, sleep: noSleep }).createShoppingLink({ title: "t", items: [item()] }),
    ).rejects.toThrow("400");
    expect(bad.calls).toHaveLength(1);
  });

  it("does not claim success without a link in the response", async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: {} }]);
    await expect(
      new InstacartProvider({ apiKey: "k", environment: "development", fetchImpl, sleep: noSleep }).createShoppingLink({ title: "t", items: [item()] }),
    ).rejects.toThrow("products_link_url");
  });
});

describe("MockInstacartProvider", () => {
  it("is clearly marked and points at the in-app mock page", async () => {
    const r = await new MockInstacartProvider("https://app.example").createShoppingLink({ title: "t", items: [item()] });
    expect(r.isMock).toBe(true);
    expect(r.url.startsWith("https://app.example/mock-instacart#")).toBe(true);
    const decoded = JSON.parse(Buffer.from(r.url.split("#")[1]!, "base64url").toString());
    expect(decoded.line_items[0].name).toBe("milk");
  });
});
