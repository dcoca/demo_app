import { describe, expect, it } from "vitest";
import { extractItems, HomeAssistantShoppingListAdapter } from "@/server/integrations/alexa/home-assistant-adapter";
import { assertSafeHomeAssistantUrl } from "@/server/integrations/alexa/url-guard";

function fakeFetch(responses: Array<{ status: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift()!;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const haResponse = {
  changed_states: [],
  service_response: {
    "todo.alexa_shopping_list": {
      items: [
        { uid: "a1", summary: "Strawberries", status: "needs_action" },
        { uid: "a2", summary: "  ", status: "needs_action" },
        { uid: "a3", summary: "milk", status: "completed" },
        { summary: "no uid" },
        { uid: "a4", summary: "2 gallons of milk", status: "needs_action", description: "the good one" },
      ],
    },
  },
};

describe("HomeAssistantShoppingListAdapter", () => {
  const opts = { baseUrl: "https://ha.example.com/", entityId: "todo.alexa_shopping_list", accessToken: "llat", sleep: async () => {} };

  it("calls todo.get_items with return_response and the bearer token", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 200, body: haResponse }]);
    const items = await new HomeAssistantShoppingListAdapter({ ...opts, fetchImpl }).fetchOpenItems();
    expect(calls[0]!.url).toBe("https://ha.example.com/api/services/todo/get_items?return_response");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ entity_id: "todo.alexa_shopping_list", status: ["needs_action"] });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer llat");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(items).toEqual([
      { externalId: "a1", summary: "Strawberries", description: null },
      { externalId: "a4", summary: "2 gallons of milk", description: "the good one" },
    ]);
  });

  it("retries network errors and 5xx", async () => {
    const { calls, fetchImpl } = fakeFetch([new TypeError("fetch failed"), { status: 502 }, { status: 200, body: haResponse }]);
    await new HomeAssistantShoppingListAdapter({ ...opts, fetchImpl }).fetchOpenItems();
    expect(calls).toHaveLength(3);
  });

  it("does not retry a rejected token", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 401 }]);
    await expect(new HomeAssistantShoppingListAdapter({ ...opts, fetchImpl }).fetchOpenItems()).rejects.toThrow("access token");
    expect(calls).toHaveLength(1);
  });

  it("explains a wrong entity id", () => {
    expect(() => extractItems({ service_response: {} }, "todo.wrong")).toThrow("todo.wrong");
  });

  it("reports itself as read-only (one-way sync)", () => {
    expect(new HomeAssistantShoppingListAdapter(opts).capabilities).toEqual({ read: true, write: false });
  });
});

describe("assertSafeHomeAssistantUrl", () => {
  it("accepts public https URLs", () => {
    expect(assertSafeHomeAssistantUrl("https://abc.ui.nabu.casa", false).hostname).toBe("abc.ui.nabu.casa");
  });

  it.each([
    "http://ha.example.com",
    "https://localhost:8123",
    "https://homeassistant.local:8123",
    "https://127.0.0.1",
    "https://10.0.0.5",
    "https://192.168.1.10:8123",
    "https://169.254.169.254",
    "https://[::1]",
    "https://user:pw@ha.example.com",
    "https://ha.example.com/?x=1",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => assertSafeHomeAssistantUrl(url, false)).toThrow();
  });

  it("allows local URLs only when explicitly enabled for development", () => {
    expect(assertSafeHomeAssistantUrl("http://192.168.1.10:8123", true).port).toBe("8123");
  });
});
