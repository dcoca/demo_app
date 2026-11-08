/**
 * Item-name normalization used for duplicate detection.
 *
 * The normalized form is an internal matching key only; the name a person
 * typed or spoke is what the UI shows. The rules are intentionally small:
 *
 *   1. Unicode NFKC, lower-case, collapse whitespace, trim punctuation.
 *   2. Drop a leading article/filler ("a", "an", "some", "the").
 *   3. Fold a regular English plural on the LAST word only
 *      ("Bananas" -> "banana", "cherry tomatoes" -> "cherry tomato").
 *
 * Modifiers are never removed, so "organic milk", "almond milk" and "milk"
 * stay three distinct items.
 */

const LEADING_FILLERS = new Set(["a", "an", "some", "the", "more"]);

// Words that end in "s" but are not plurals (or whose singular reads wrong).
const PLURAL_EXCEPTIONS = new Set([
  "asparagus",
  "couscous",
  "hummus",
  "molasses",
  "swiss",
  "brussels",
  "citrus",
  "octopus",
  "grits",
  "series",
  "species",
  "chips", // "chip" is not how anyone shops; keep as-is
  "oats",
  "greens",
  "glass",
  "bass",
  "lentils",
  "noodles",
  "jus",
]);

export function singularize(word: string): string {
  if (word.length <= 3 || PLURAL_EXCEPTIONS.has(word)) return word;
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`; // berries
  if (word.endsWith("oes")) return word.slice(0, -2); // tomatoes, potatoes
  if (/(ches|shes|xes|sses|zes)$/.test(word)) return word.slice(0, -2); // peaches, boxes
  if (word.endsWith("ves") && ["loaves", "halves"].includes(word)) return `${word.slice(0, -3)}f`;
  if (word.endsWith("ss") || word.endsWith("us") || word.endsWith("is")) return word;
  if (word.endsWith("s")) return word.slice(0, -1); // bananas, eggs
  return word;
}

export function normalizeItemName(input: string): string {
  const words = input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}'&%\- ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-'&\s]+|[-'&\s]+$/g, "")
    .split(" ")
    .filter(Boolean);

  while (words.length > 1 && LEADING_FILLERS.has(words[0]!)) words.shift();
  if (words.length === 0) return "";

  const last = words.length - 1;
  words[last] = singularize(words[last]!);
  return words.join(" ");
}

/** Display clean-up: trims and collapses whitespace, keeps the person's casing. */
export function cleanDisplayName(input: string): string {
  return input.normalize("NFKC").replace(/\s+/g, " ").trim();
}

const UNIT_SYNONYMS: Record<string, string> = {
  gallon: "gallon", gallons: "gallon", gal: "gallon",
  "half gallon": "half gallon", "half gallons": "half gallon",
  quart: "quart", quarts: "quart", qt: "quart",
  pint: "pint", pints: "pint", pt: "pint",
  liter: "liter", liters: "liter", litre: "liter", litres: "liter", l: "liter",
  milliliter: "ml", milliliters: "ml", ml: "ml",
  pound: "lb", pounds: "lb", lb: "lb", lbs: "lb",
  ounce: "oz", ounces: "oz", oz: "oz",
  "fl oz": "fl oz", "fluid ounce": "fl oz", "fluid ounces": "fl oz",
  kilogram: "kg", kilograms: "kg", kg: "kg", kilo: "kg", kilos: "kg",
  gram: "g", grams: "g", g: "g",
  dozen: "dozen", dozens: "dozen",
  each: "each", ea: "each", count: "each", ct: "each", piece: "each", pieces: "each",
  pack: "pack", packs: "pack", package: "pack", packages: "pack", pkg: "pack",
  bag: "bag", bags: "bag",
  box: "box", boxes: "box",
  can: "can", cans: "can",
  jar: "jar", jars: "jar",
  bottle: "bottle", bottles: "bottle",
  carton: "carton", cartons: "carton",
  bunch: "bunch", bunches: "bunch",
  head: "head", heads: "head",
  loaf: "loaf", loaves: "loaf",
  container: "container", containers: "container",
  cup: "cup", cups: "cup",
};

/** Canonical unit, or a trimmed lower-case unit if it is not a known synonym. */
export function normalizeUnit(input: string | null | undefined): string | null {
  if (input == null) return null;
  const key = input.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (!key) return null;
  return UNIT_SYNONYMS[key] ?? key;
}

export function isKnownUnit(input: string): boolean {
  return input.toLowerCase().replace(/\./g, "").trim() in UNIT_SYNONYMS;
}
