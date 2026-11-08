import type { ExternalListItem, ShoppingListSyncAdapter } from "../types";

/**
 * In-memory stand-in for an Alexa shopping list. Used by tests and local
 * development to exercise the sync pipeline without Home Assistant.
 */
export class MockAlexaShoppingList implements ShoppingListSyncAdapter {
  readonly providerId = "mock_alexa";
  readonly capabilities = { read: true, write: false } as const;
  private items = new Map<string, ExternalListItem>();
  private failuresRemaining = 0;
  private counter = 0;

  /** Simulates someone saying "Alexa, add X to my shopping list". */
  say(summary: string): ExternalListItem {
    const item = { externalId: `mock-${++this.counter}`, summary };
    this.items.set(item.externalId, item);
    return item;
  }

  /** Simulates checking an item off in the Alexa app. */
  complete(externalId: string) {
    this.items.delete(externalId);
  }

  /** The next `n` reads fail as if Home Assistant were down. */
  failNext(n: number) {
    this.failuresRemaining = n;
  }

  async fetchOpenItems(): Promise<ExternalListItem[]> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new Error("Mock Alexa list unavailable");
    }
    return [...this.items.values()];
  }

  async checkHealth() {
    return { ok: this.failuresRemaining === 0, message: "mock" };
  }
}
