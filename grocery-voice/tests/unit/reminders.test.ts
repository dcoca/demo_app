import { describe, expect, it } from "vitest";
import { deliverNotifications, retryDelayMs, type NotificationStore } from "@/server/services/notification-service";
import { reminderEmail, runReminders, type NewNotification, type ReminderStore } from "@/server/services/reminder-service";
import type { EmailProvider } from "@/lib/notifications/email";
import type { HouseholdSchedule, NotificationRecord } from "@/types/domain";

function schedule(overrides: Partial<HouseholdSchedule> = {}): HouseholdSchedule {
  return {
    household_id: "hh-1",
    enabled: true,
    frequency: "weekly",
    shopping_weekday: 0,
    interval_days: null,
    anchor_date: null,
    review_lead_days: 1,
    review_reminder_time: "18:00:00",
    order_cutoff_time: "10:00:00",
    timezone: "America/New_York",
    next_reminder_at: "2026-11-07T23:00:00.000Z",
    next_shopping_date: "2026-11-08",
    last_reminded_shopping_date: null,
    ...overrides,
  };
}

class MemoryReminderStore implements ReminderStore {
  rows = new Map<string, NewNotification>();
  readyCalls = 0;
  constructor(public schedules: HouseholdSchedule[]) {}
  async dueSchedules(now: Date) {
    return this.schedules.filter((s) => s.enabled && s.next_reminder_at && new Date(s.next_reminder_at) <= now).map((s) => ({ ...s }));
  }
  async advanceSchedule(id: string, expected: string | null, next: { nextReminderAt: Date; nextShoppingDate: string; lastRemindedShoppingDate: string | null }) {
    const s = this.schedules.find((x) => x.household_id === id)!;
    if (s.next_reminder_at !== expected) return false;
    s.next_reminder_at = next.nextReminderAt.toISOString();
    s.next_shopping_date = next.nextShoppingDate;
    s.last_reminded_shopping_date = next.lastRemindedShoppingDate;
    return true;
  }
  async recipients() {
    return [
      { userId: "u1", email: "dana@example.com", displayName: "Dana" },
      { userId: "u2", email: "sam@example.com", displayName: "Sam" },
    ];
  }
  async householdSummary() {
    return { name: "Parkers", activeItemCount: 24, orderId: "order-1" };
  }
  async enqueue(rows: NewNotification[]) {
    let n = 0;
    for (const r of rows) {
      if (this.rows.has(r.dedupeKey)) continue;
      this.rows.set(r.dedupeKey, r);
      n++;
    }
    return n;
  }
  async markOrderReadyForReview() {
    this.readyCalls++;
  }
}

describe("runReminders", () => {
  const deps = (store: ReminderStore) => ({ store, appUrl: "https://app.example" });

  it("queues one reminder per member and advances to next week", async () => {
    const store = new MemoryReminderStore([schedule()]);
    const r = await runReminders(deps(store), new Date("2026-11-07T23:01:00Z"));
    expect(r.notificationsQueued).toBe(2);
    expect(store.readyCalls).toBe(1);
    expect(store.schedules[0]!.next_shopping_date).toBe("2026-11-15");
    expect(store.schedules[0]!.last_reminded_shopping_date).toBe("2026-11-08");
  });

  it("repeated or overlapping scheduler runs never send twice", async () => {
    const s = schedule();
    const storeA = new MemoryReminderStore([s]);
    // Two runs that both read the schedule before either advanced it.
    const due = await storeA.dueSchedules(new Date("2026-11-07T23:01:00Z"));
    storeA.dueSchedules = async () => due.map((x) => ({ ...x }));
    await runReminders(deps(storeA), new Date("2026-11-07T23:01:00Z"));
    await runReminders(deps(storeA), new Date("2026-11-07T23:02:00Z"));
    expect(storeA.rows.size).toBe(2);
  });

  it("skips a reminder whose ordering cutoff has already passed", async () => {
    const store = new MemoryReminderStore([schedule()]);
    const r = await runReminders(deps(store), new Date("2026-11-08T16:00:00Z")); // after 10:00 EST Sunday
    expect(r.skippedPastCutoff).toBe(1);
    expect(store.rows.size).toBe(0);
    expect(store.schedules[0]!.next_shopping_date).toBe("2026-11-15");
  });

  it("writes the review email", () => {
    const { body } = reminderEmail({ itemCount: 24, dayName: "Sunday", reviewUrl: "https://app.example/order", householdName: "Parkers" });
    expect(body).toBe(
      "Your grocery list is ready to review.\n\n24 items are waiting for your Sunday order.\n\nReview your list: https://app.example/order",
    );
  });
});

describe("deliverNotifications", () => {
  function record(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
    return {
      id: "n1", household_id: "hh-1", user_id: "u1", kind: "review_reminder", channel: "email",
      dedupe_key: "review_reminder:hh-1:2026-11-08:u1", status: "sending", attempts: 1, max_attempts: 5,
      next_attempt_at: "", last_error: null, subject: "s", body: "b", payload: { to: "dana@example.com" },
      created_at: "", sent_at: null, ...overrides,
    };
  }

  function store(batch: NotificationRecord[]) {
    const log: string[] = [];
    const s: NotificationStore = {
      claim: async () => batch,
      markSent: async (id) => void log.push(`sent:${id}`),
      markFailed: async (id, _e, _n, dead) => void log.push(`${dead ? "dead" : "failed"}:${id}`),
    };
    return { s, log };
  }

  it("sends with the dedupe key as the provider idempotency key", async () => {
    const keys: string[] = [];
    const email: EmailProvider = { id: "t", send: async (m) => (keys.push(m.idempotencyKey), { providerMessageId: "x" }) };
    const { s, log } = store([record()]);
    expect(await deliverNotifications({ store: s, email }, new Date())).toEqual({ sent: 1, failed: 0, dead: 0 });
    expect(keys).toEqual(["review_reminder:hh-1:2026-11-08:u1"]);
    expect(log).toEqual(["sent:n1"]);
  });

  it("retries failures with backoff and gives up after max attempts", async () => {
    const email: EmailProvider = { id: "t", send: async () => { throw new Error("smtp down"); } };
    const { s, log } = store([record({ id: "a", attempts: 1 }), record({ id: "b", attempts: 5 })]);
    expect(await deliverNotifications({ store: s, email }, new Date())).toEqual({ sent: 0, failed: 1, dead: 1 });
    expect(log).toEqual(["failed:a", "dead:b"]);
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(25 * 60_000);
  });
});
