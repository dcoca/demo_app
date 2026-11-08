import { parseSpokenList } from "@/features/shopping/parse-spoken";
import type { ExternalGroceryItem, GroceryInputProvider, ParsedIngestion } from "../types";

/**
 * Apple Shortcuts sends either structured items or the raw dictated phrase.
 * Dictation like "milk, two dozen eggs and bananas" is split server-side so
 * the Shortcut itself stays trivial.
 */
class SpokenInputProvider implements GroceryInputProvider {
  constructor(
    readonly providerId: "siri" | "alexa" | "api",
    private readonly label: string,
  ) {}

  parse(input: { items?: ExternalGroceryItem[]; text?: string; device?: string }): ParsedIngestion {
    const items: ExternalGroceryItem[] = input.items ?? parseSpokenList(input.text ?? "");
    const actorLabel = input.device ? `${this.label} (${input.device})` : this.label;
    return { items, actorLabel };
  }
}

export const siriShortcutProvider = new SpokenInputProvider("siri", "Siri");

/**
 * Mock Alexa push source. Real Alexa items arrive through the Home Assistant
 * sync adapter; this lets a test harness or Alexa skill prototype push events
 * through the same authenticated ingestion endpoint.
 */
export const mockAlexaPushProvider = new SpokenInputProvider("alexa", "Alexa (mock)");

export const apiProvider = new SpokenInputProvider("api", "API");

export function inputProviderFor(source: "siri" | "alexa" | "api"): GroceryInputProvider {
  switch (source) {
    case "siri":
      return siriShortcutProvider;
    case "alexa":
      return mockAlexaPushProvider;
    case "api":
      return apiProvider;
  }
}
