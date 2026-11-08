import { describe, expect, it } from "vitest";
import { nextOccurrence, type ScheduleRule } from "@/features/scheduling/schedule";

const weeklySunday: ScheduleRule = {
  frequency: "weekly",
  shoppingWeekday: 0,
  reviewLeadDays: 1,
  reviewReminderTime: "18:00",
  orderCutoffTime: "10:00",
  timezone: "America/New_York",
};

describe("nextOccurrence (weekly)", () => {
  it("reminds the evening before the shopping day in the household timezone", () => {
    // Wed 2026-11-04 12:00 UTC
    const occ = nextOccurrence(weeklySunday, new Date("2026-11-04T12:00:00Z"));
    expect(occ.shoppingDate).toBe("2026-11-08");
    // Sat 2026-11-07 18:00 EST = 23:00 UTC
    expect(occ.reminderAt.toISOString()).toBe("2026-11-07T23:00:00.000Z");
    expect(occ.cutoffAt.toISOString()).toBe("2026-11-08T15:00:00.000Z");
  });

  it("moves to next week once this week's reminder has passed", () => {
    const occ = nextOccurrence(weeklySunday, new Date("2026-11-07T23:00:01Z"));
    expect(occ.shoppingDate).toBe("2026-11-15");
  });

  it("finds a reminder later today for a shopping day tomorrow", () => {
    // Sat 2026-11-07 15:00 UTC = 10:00 EST, reminder at 18:00 EST today
    const occ = nextOccurrence(weeklySunday, new Date("2026-11-07T15:00:00Z"));
    expect(occ.shoppingDate).toBe("2026-11-08");
  });

  it("is DST-aware (fall back on 2026-11-01 in New York)", () => {
    const before = nextOccurrence(weeklySunday, new Date("2026-10-20T00:00:00Z"));
    expect(before.reminderAt.toISOString()).toBe("2026-10-24T22:00:00.000Z"); // EDT, UTC-4
    const after = nextOccurrence(weeklySunday, new Date("2026-11-02T00:00:00Z"));
    expect(after.reminderAt.toISOString()).toBe("2026-11-07T23:00:00.000Z"); // EST, UTC-5
  });

  it("uses the household's timezone, not the server's", () => {
    const tokyo = { ...weeklySunday, timezone: "Asia/Tokyo" };
    const occ = nextOccurrence(tokyo, new Date("2026-11-04T00:00:00Z"));
    expect(occ.reminderAt.toISOString()).toBe("2026-11-07T09:00:00.000Z"); // 18:00 JST
  });

  it("skips a shopping date that was already reminded", () => {
    const occ = nextOccurrence(weeklySunday, new Date("2026-11-04T12:00:00Z"), "2026-11-08");
    expect(occ.shoppingDate).toBe("2026-11-15");
  });

  it("supports same-day reminders (lead 0)", () => {
    const occ = nextOccurrence({ ...weeklySunday, reviewLeadDays: 0, reviewReminderTime: "08:00" }, new Date("2026-11-04T12:00:00Z"));
    expect(occ.shoppingDate).toBe("2026-11-08");
    expect(occ.reminderAt.toISOString()).toBe("2026-11-08T13:00:00.000Z");
  });
});

describe("nextOccurrence (custom)", () => {
  const everyTenDays: ScheduleRule = {
    ...weeklySunday,
    frequency: "custom",
    intervalDays: 10,
    anchorDate: "2026-11-01",
  };

  it("steps from the anchor date", () => {
    expect(nextOccurrence(everyTenDays, new Date("2026-11-02T00:00:00Z")).shoppingDate).toBe("2026-11-11");
    expect(nextOccurrence(everyTenDays, new Date("2026-11-12T00:00:00Z")).shoppingDate).toBe("2026-11-21");
  });

  it("handles anchors in the future", () => {
    const occ = nextOccurrence({ ...everyTenDays, anchorDate: "2026-12-25" }, new Date("2026-11-02T00:00:00Z"));
    expect(occ.shoppingDate).toBe("2026-12-25");
  });
});
