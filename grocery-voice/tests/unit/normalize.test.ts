import { describe, expect, it } from "vitest";
import { normalizeItemName, normalizeUnit, singularize } from "@/features/shopping/normalize";

describe("normalizeItemName", () => {
  it("treats case variants as the same item", () => {
    expect(normalizeItemName("Bananas")).toBe(normalizeItemName("bananas"));
    expect(normalizeItemName("  MILK ")).toBe("milk");
  });

  it("folds simple plurals on the last word", () => {
    expect(normalizeItemName("banana")).toBe(normalizeItemName("Bananas"));
    expect(normalizeItemName("eggs")).toBe("egg");
    expect(normalizeItemName("cherry tomatoes")).toBe("cherry tomato");
    expect(normalizeItemName("strawberries")).toBe("strawberry");
    expect(normalizeItemName("peaches")).toBe("peach");
  });

  it("keeps modifiers, so variants stay distinct", () => {
    const names = ["organic milk", "almond milk", "milk", "2% milk"].map(normalizeItemName);
    expect(new Set(names).size).toBe(4);
  });

  it("does not mangle words that only look plural", () => {
    for (const w of ["hummus", "asparagus", "couscous", "swiss", "oats", "grits", "molasses"]) {
      expect(singularize(w)).toBe(w);
    }
    expect(normalizeItemName("glass")).toBe("glass");
  });

  it("drops leading articles and punctuation", () => {
    expect(normalizeItemName("some apples.")).toBe("apple");
    expect(normalizeItemName("The Bread!")).toBe("bread");
    expect(normalizeItemName("a")).toBe("a");
  });

  it("normalizes unicode and whitespace", () => {
    expect(normalizeItemName("Ｍｉｌｋ")).toBe("milk");
    expect(normalizeItemName("ice\t\tcream")).toBe("ice cream");
    expect(normalizeItemName("crème fraîche")).toBe("crème fraîche");
  });

  it("returns empty for unusable names", () => {
    expect(normalizeItemName("!!!")).toBe("");
  });
});

describe("normalizeUnit", () => {
  it("maps synonyms to canonical units", () => {
    expect(normalizeUnit("Gallons")).toBe("gallon");
    expect(normalizeUnit("lbs.")).toBe("lb");
    expect(normalizeUnit("ounces")).toBe("oz");
    expect(normalizeUnit("pkg")).toBe("pack");
  });
  it("passes unknown units through lower-cased", () => {
    expect(normalizeUnit("Sleeve")).toBe("sleeve");
  });
  it("treats blank as no unit", () => {
    expect(normalizeUnit("  ")).toBeNull();
    expect(normalizeUnit(null)).toBeNull();
  });
});
