import { formatShoppingDay, nextOccurrence, occurrenceForDate, type ScheduleRule } from "@/features/scheduling/schedule";
import type { HouseholdSchedule } from "@/types/domain";

export interface ReminderRecipient {
  userId: string;
  email: string;
  displayName: string;
}

export interface NewNotification {
  householdId: string;
  userId: string;
  kind: "review_reminder";
  dedupeKey: string;
  subject: string;
  body: string;
  payload: Record<string, unknown>;
}

export interface ReminderStore {
  dueSchedules(now: Date, limit: number): Promise<HouseholdSchedule[]>;
  /** Compare-and-set on next_reminder_at so concurrent runs advance once. */
  advanceSchedule(
    householdId: string,
    expectedNextReminderAt: string | null,
    next: { nextReminderAt: Date; nextShoppingDate: string; lastRemindedShoppingDate: string | null },
  ): Promise<boolean>;
  recipients(householdId: string): Promise<ReminderRecipient[]>;
  householdSummary(householdId: string): Promise<{ name: string; activeItemCount: number; orderId: string | null }>;
  /** Insert, ignoring rows whose dedupe_key already exists. Returns rows inserted. */
  enqueue(rows: NewNotification[]): Promise<number>;
  markOrderReadyForReview(orderId: string): Promise<void>;
}

export function scheduleRule(s: HouseholdSchedule): ScheduleRule {
  return {
    frequency: s.frequency,
    shoppingWeekday: s.shopping_weekday,
    intervalDays: s.interval_days,
    anchorDate: s.anchor_date,
    reviewLeadDays: s.review_lead_days,
    reviewReminderTime: s.review_reminder_time,
    orderCutoffTime: s.order_cutoff_time,
    timezone: s.timezone,
  };
}

export function reminderEmail(input: { itemCount: number; dayName: string; reviewUrl: string; householdName: string }) {
  const items = input.itemCount === 1 ? "1 item is" : `${input.itemCount} items are`;
  return {
    subject: `${input.householdName}: your grocery list is ready to review`,
    body: [
      "Your grocery list is ready to review.",
      "",
      `${items} waiting for your ${input.dayName} order.`,
      "",
      `Review your list: ${input.reviewUrl}`,
    ].join("\n"),
  };
}

export interface ReminderRunSummary {
  schedulesProcessed: number;
  notificationsQueued: number;
  skippedPastCutoff: number;
}

/**
 * Enqueue review reminders for every schedule that is due. Safe to run any
 * number of times: notifications are keyed by household + shopping date +
 * member, and the schedule advances with compare-and-set.
 */
export async function runReminders(
  deps: { store: ReminderStore; appUrl: string },
  now: Date,
): Promise<ReminderRunSummary> {
  const summary: ReminderRunSummary = { schedulesProcessed: 0, notificationsQueued: 0, skippedPastCutoff: 0 };
  const due = await deps.store.dueSchedules(now, 100);

  for (const schedule of due) {
    const rule = scheduleRule(schedule);
    const shoppingDate =
      schedule.next_shopping_date ?? nextOccurrence(rule, new Date(now.getTime() - 7 * 864e5)).shoppingDate;
    const occurrence = occurrenceForDate(rule, shoppingDate);
    const alreadyReminded =
      schedule.last_reminded_shopping_date !== null && schedule.last_reminded_shopping_date >= shoppingDate;

    if (!alreadyReminded) {
      if (now.getTime() > occurrence.cutoffAt.getTime()) {
        // Scheduler was down past the cutoff. A late "ready for Sunday" email
        // is noise; skip it and move on to the next occurrence.
        summary.skippedPastCutoff++;
      } else {
        const household = await deps.store.householdSummary(schedule.household_id);
        const { subject, body } = reminderEmail({
          itemCount: household.activeItemCount,
          dayName: formatShoppingDay(shoppingDate, rule.timezone),
          reviewUrl: `${deps.appUrl}/order`,
          householdName: household.name,
        });
        const recipients = await deps.store.recipients(schedule.household_id);
        summary.notificationsQueued += await deps.store.enqueue(
          recipients.map((r) => ({
            householdId: schedule.household_id,
            userId: r.userId,
            kind: "review_reminder" as const,
            dedupeKey: `review_reminder:${schedule.household_id}:${shoppingDate}:${r.userId}`,
            subject,
            body,
            payload: { to: r.email, shoppingDate, itemCount: household.activeItemCount },
          })),
        );
        if (household.orderId) await deps.store.markOrderReadyForReview(household.orderId);
      }
    }

    const next = nextOccurrence(rule, now, shoppingDate);
    await deps.store.advanceSchedule(schedule.household_id, schedule.next_reminder_at, {
      nextReminderAt: next.reminderAt,
      nextShoppingDate: next.shoppingDate,
      lastRemindedShoppingDate: shoppingDate,
    });
    summary.schedulesProcessed++;
  }
  return summary;
}
