import { describe, expect, it } from "vitest";
import { parseSpokenList, parseSpokenPhrase } from "@/features/shopping/parse-spoken";

describe("parseSpokenPhrase", () => {
  it("reads quantity, unit and name", () => {
    expect(parseSpokenPhrase("2 gallons of milk")).toEqual({ name: "milk", quantity: 2, unit: "gallon" });
    expect(parseSpokenPhrase("a dozen eggs")).toEqual({ name: "eggs", quantity: 1, unit: "dozen" });
    expect(parseSpokenPhrase("three avocados")).toEqual({ name: "avocados", quantity: 3 });
    expect(parseSpokenPhrase("1.5 lbs ground beef")).toEqual({ name: "ground beef", quantity: 1.5, unit: "lb" });
  });

  it("leaves plain names alone", () => {
    expect(parseSpokenPhrase("Milk")).toEqual({ name: "Milk" });
    expect(parseSpokenPhrase("bag")).toEqual({ name: "bag" });
  });

  it("does not treat a lone article as a quantity", () => {
    expect(parseSpokenPhrase("a")).toEqual({ name: "a" });
  });
});

describe("parseSpokenList", () => {
  it("splits on commas and 'and'", () => {
    expect(parseSpokenList("milk, eggs and bananas").map((i) => i.name)).toEqual(["milk", "eggs", "bananas"]);
  });

  it("keeps known compound products together", () => {
    expect(parseSpokenList("Mac and cheese and half and half").map((i) => i.name)).toEqual(["Mac and cheese", "half and half"]);
  });

  it("handles dictation without punctuation", () => {
    expect(parseSpokenList("2 gallons of milk and a dozen eggs")).toEqual([
      { name: "milk", quantity: 2, unit: "gallon" },
      { name: "eggs", quantity: 1, unit: "dozen" },
    ]);
  });

  it("ignores empty fragments", () => {
    expect(parseSpokenList(", ,and ")).toEqual([]);
  });
});
