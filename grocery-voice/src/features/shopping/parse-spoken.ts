import { cleanDisplayName, isKnownUnit, normalizeUnit } from "./normalize";

export interface SpokenItem {
  name: string;
  quantity?: number;
  unit?: string;
}

// Phrases that contain "and" but are one product.
const PROTECTED_PHRASES = [
  "mac and cheese",
  "macaroni and cheese",
  "salt and pepper",
  "half and half",
  "peanut butter and jelly",
  "bread and butter pickles",
  "sweet and sour sauce",
  "rice and beans",
  "cookies and cream",
  "pork and beans",
];

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, half: 0.5, couple: 2,
};

function splitPhrases(text: string): string[] {
  let working = text;
  const placeholders: string[] = [];
  for (const phrase of PROTECTED_PHRASES) {
    working = working.replace(new RegExp(`\\b${phrase}\\b`, "gi"), (match) => {
      placeholders.push(match);
      return `\u0000${placeholders.length - 1}\u0000`;
    });
  }
  return working
    .split(/\s*(?:,|;|\n|\band\b|&|\bplus\b|\balso\b)\s*/i)
    .map((part) => part.replace(/\u0000(\d+)\u0000/g, (_, i: string) => placeholders[Number(i)] ?? ""))
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseQuantity(token: string): number | undefined {
  if (/^\d+(\.\d+)?$/.test(token)) return Number(token);
  const frac = /^(\d+)\/(\d+)$/.exec(token);
  if (frac && Number(frac[2]) !== 0) return Number(frac[1]) / Number(frac[2]);
  return NUMBER_WORDS[token];
}

/** "2 gallons of milk" -> { name: "milk", quantity: 2, unit: "gallon" } */
export function parseSpokenPhrase(phrase: string): SpokenItem | null {
  const tokens = cleanDisplayName(phrase).replace(/[.!?]+$/, "").split(" ").filter(Boolean);
  if (tokens.length === 0) return null;

  // A whole protected product name ("half and half") is never a quantity + name.
  if (PROTECTED_PHRASES.includes(tokens.join(" ").toLowerCase())) return { name: tokens.join(" ") };

  const item: SpokenItem = { name: "" };
  const first = tokens[0]!.toLowerCase();
  const qty = parseQuantity(first);
  // A lone number word like "a" only counts as a quantity if something follows.
  if (qty !== undefined && tokens.length > 1) {
    item.quantity = qty;
    tokens.shift();
    if (tokens[0]?.toLowerCase() === "of") tokens.shift(); // "a couple of"
  }

  if (tokens.length > 1) {
    const two = `${tokens[0]} ${tokens[1]}`.toLowerCase();
    if (isKnownUnit(two) && tokens.length > 2) {
      item.unit = normalizeUnit(two) ?? undefined;
      tokens.splice(0, 2);
    } else if (isKnownUnit(tokens[0]!)) {
      item.unit = normalizeUnit(tokens[0]) ?? undefined;
      tokens.shift();
    }
    if (item.unit && tokens[0]?.toLowerCase() === "of") tokens.shift();
  }

  if (item.unit && item.quantity === undefined) item.quantity = 1;
  item.name = tokens.join(" ");
  return item.name ? item : null;
}

/** "milk, two dozen eggs and mac and cheese" -> three items. */
export function parseSpokenList(text: string): SpokenItem[] {
  return splitPhrases(text)
    .map(parseSpokenPhrase)
    .filter((i): i is SpokenItem => i !== null)
    .slice(0, 50);
}
