import { DateTime } from "luxon";

/**
 * Pure, timezone-aware schedule math. All inputs are wall-clock values in the
 * household's IANA timezone; outputs are UTC instants plus the local shopping
 * date they belong to. DST is handled by Luxon: a reminder at 02:30 on a
 * spring-forward day resolves to the next valid local time.
 */
export interface ScheduleRule {
  frequency: "weekly" | "custom";
  /** 0 = Sunday ... 6 = Saturday */
  shoppingWeekday: number;
  intervalDays?: number | null;
  /** First shopping date (YYYY-MM-DD) for custom frequency. */
  anchorDate?: string | null;
  reviewLeadDays: number;
  /** "HH:MM" or "HH:MM:SS" */
  reviewReminderTime: string;
  orderCutoffTime: string;
  timezone: string;
}

export interface Occurrence {
  /** Local calendar date of the shopping day, YYYY-MM-DD. */
  shoppingDate: string;
  reminderAt: Date;
  cutoffAt: Date;
}

function atTime(day: DateTime, time: string): DateTime {
  const [h = 0, m = 0, s = 0] = time.split(":").map(Number);
  return day.set({ hour: h, minute: m, second: s, millisecond: 0 });
}

function toLuxonWeekday(sundayZero: number): number {
  return sundayZero === 0 ? 7 : sundayZero; // Luxon: Monday=1 ... Sunday=7
}

function occurrenceFor(rule: ScheduleRule, shoppingDay: DateTime): Occurrence {
  const reminder = atTime(shoppingDay.minus({ days: rule.reviewLeadDays }), rule.reviewReminderTime);
  const cutoff = atTime(shoppingDay, rule.orderCutoffTime);
  return {
    shoppingDate: shoppingDay.toISODate()!,
    reminderAt: reminder.toUTC().toJSDate(),
    cutoffAt: cutoff.toUTC().toJSDate(),
  };
}

/** Shopping days on or after `fromLocalDay`, in order. */
function* shoppingDays(rule: ScheduleRule, fromLocalDay: DateTime): Generator<DateTime> {
  if (rule.frequency === "weekly") {
    const target = toLuxonWeekday(rule.shoppingWeekday);
    let day = fromLocalDay.startOf("day");
    day = day.plus({ days: (target - day.weekday + 7) % 7 });
    for (;;) {
      yield day;
      day = day.plus({ weeks: 1 });
    }
  }

  if (!rule.intervalDays || !rule.anchorDate) throw new Error("Custom schedules need intervalDays and anchorDate");
  const anchor = DateTime.fromISO(rule.anchorDate, { zone: rule.timezone }).startOf("day");
  const start = fromLocalDay.startOf("day");
  let steps = Math.max(0, Math.ceil(start.diff(anchor, "days").days / rule.intervalDays));
  for (;;) {
    yield anchor.plus({ days: steps * rule.intervalDays });
    steps += 1;
  }
}

/**
 * The next occurrence whose reminder is strictly after `after`, skipping any
 * shopping date that was already reminded.
 */
export function nextOccurrence(
  rule: ScheduleRule,
  after: Date,
  lastRemindedShoppingDate?: string | null,
): Occurrence {
  const nowLocal = DateTime.fromJSDate(after, { zone: rule.timezone });
  if (!nowLocal.isValid) throw new Error(`Invalid timezone ${rule.timezone}`);

  // Start far enough back that a reminder later today for a shopping day
  // `reviewLeadDays` from now is not missed.
  let guard = 0;
  for (const day of shoppingDays(rule, nowLocal.minus({ days: rule.reviewLeadDays }))) {
    if (++guard > 400) break;
    const occ = occurrenceFor(rule, day);
    if (lastRemindedShoppingDate && occ.shoppingDate <= lastRemindedShoppingDate) continue;
    if (occ.reminderAt.getTime() > after.getTime()) return occ;
  }
  throw new Error("Could not compute next occurrence");
}

/** The occurrence whose shopping date is `shoppingDate` (used when a reminder fires). */
export function occurrenceForDate(rule: ScheduleRule, shoppingDate: string): Occurrence {
  return occurrenceFor(rule, DateTime.fromISO(shoppingDate, { zone: rule.timezone }));
}

export function formatShoppingDay(shoppingDate: string, timezone: string): string {
  return DateTime.fromISO(shoppingDate, { zone: timezone }).toFormat("cccc");
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
