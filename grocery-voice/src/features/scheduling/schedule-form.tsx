"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, type FormEvent } from "react";
import { Button, Field, Input, Notice, Select } from "@/components/ui";
import { api } from "@/lib/api-client";
import type { HouseholdSchedule } from "@/types/domain-client";
import { WEEKDAYS } from "./schedule";

export function ScheduleForm({ householdId, schedule, canEdit }: { householdId: string; schedule: HouseholdSchedule; canEdit: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [frequency, setFrequency] = useState(schedule.frequency);
  const [weekday, setWeekday] = useState(schedule.shopping_weekday);
  const [intervalDays, setIntervalDays] = useState(schedule.interval_days ?? 14);
  const [anchorDate, setAnchorDate] = useState(schedule.anchor_date ?? "");
  const [leadDays, setLeadDays] = useState(schedule.review_lead_days);
  const [reminderTime, setReminderTime] = useState(schedule.review_reminder_time.slice(0, 5));
  const [cutoffTime, setCutoffTime] = useState(schedule.order_cutoff_time.slice(0, 5));
  const [timezone, setTimezone] = useState(schedule.timezone);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "red" | "green"; text: string } | null>(null);

  const timezones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [schedule.timezone];
    }
  }, [schedule.timezone]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/v1/households/${householdId}/schedule`, {
        method: "PUT",
        body: {
          enabled,
          frequency,
          shoppingWeekday: weekday,
          intervalDays: frequency === "custom" ? intervalDays : null,
          anchorDate: frequency === "custom" ? anchorDate : null,
          reviewLeadDays: leadDays,
          reviewReminderTime: reminderTime,
          orderCutoffTime: cutoffTime,
          timezone,
        },
      });
      setMessage({ tone: "green", text: "Schedule saved" });
      router.refresh();
    } catch (err) {
      setMessage({ tone: "red", text: err instanceof Error ? err.message : "Could not save" });
    } finally {
      setBusy(false);
    }
  }

  const disabled = !canEdit || busy;

  return (
    <form onSubmit={submit} className="space-y-4">
      {!canEdit ? <Notice>Only owners and admins can change the schedule.</Notice> : null}
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" className="h-5 w-5" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={disabled} />
        Send review reminders
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Frequency" htmlFor="freq">
          <Select id="freq" value={frequency} onChange={(e) => setFrequency(e.target.value as "weekly" | "custom")} disabled={disabled}>
            <option value="weekly">Weekly</option>
            <option value="custom">Every N days</option>
          </Select>
        </Field>
        {frequency === "weekly" ? (
          <Field label="Shopping day" htmlFor="weekday">
            <Select id="weekday" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} disabled={disabled}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <>
            <Field label="Every how many days" htmlFor="interval">
              <Input id="interval" type="number" min={1} max={60} value={intervalDays} onChange={(e) => setIntervalDays(Number(e.target.value))} disabled={disabled} />
            </Field>
            <Field label="Next shopping date" htmlFor="anchor">
              <Input id="anchor" type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} required disabled={disabled} />
            </Field>
          </>
        )}
        <Field label="Remind this many days before" htmlFor="lead" hint="0 means the morning of the shopping day.">
          <Input id="lead" type="number" min={0} max={6} value={leadDays} onChange={(e) => setLeadDays(Number(e.target.value))} disabled={disabled} />
        </Field>
        <Field label="Reminder time" htmlFor="reminder-time">
          <Input id="reminder-time" type="time" value={reminderTime} onChange={(e) => setReminderTime(e.target.value)} disabled={disabled} />
        </Field>
        <Field label="Ordering cutoff (on shopping day)" htmlFor="cutoff" hint="Reminders aren't sent after the cutoff has passed.">
          <Input id="cutoff" type="time" value={cutoffTime} onChange={(e) => setCutoffTime(e.target.value)} disabled={disabled} />
        </Field>
        <Field label="Timezone" htmlFor="tz">
          <Select id="tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={disabled}>
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {canEdit ? (
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save schedule"}
        </Button>
      ) : null}
    </form>
  );
}
