import type { Metadata } from "next";
import Link from "next/link";
import { requireActiveHousehold } from "@/features/auth/session";
import { can } from "@/features/households/permissions";
import { ScheduleForm } from "@/features/scheduling/schedule-form";
import { Badge, Card } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { HouseholdSchedule, NotificationRecord } from "@/types/domain";

export const metadata: Metadata = { title: "Schedule" };

const STATUS_TONE = { sent: "green", pending: "neutral", sending: "blue", failed: "amber", dead: "red" } as const;

export default async function SchedulePage() {
  const { active } = await requireActiveHousehold("/settings/schedule");
  const supabase = await createSupabaseServerClient();
  const [{ data: schedule }, { data: notifications }] = await Promise.all([
    supabase.from("household_schedules").select("*").eq("household_id", active.householdId).single(),
    supabase
      .from("notifications")
      .select("id, subject, status, attempts, created_at, sent_at, last_error, user_id")
      .eq("household_id", active.householdId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  const s = schedule as HouseholdSchedule;

  return (
    <div className="space-y-4">
      <Link href="/settings" className="text-muted text-sm">
        ← Settings
      </Link>
      <h1 className="text-lg font-semibold">Schedule &amp; reminders</h1>
      <Card
        title="Shopping schedule"
        description={
          s.enabled && s.next_reminder_at
            ? `Next reminder: ${formatDateTime(s.next_reminder_at, s.timezone)} (${s.timezone})`
            : "Reminders are off."
        }
      >
        <ScheduleForm householdId={active.householdId} schedule={s} canEdit={can(active.role, "schedule:edit")} />
      </Card>
      <Card title="Notification history">
        {notifications?.length ? (
          <ul className="divide-y divide-[var(--border)] text-sm">
            {(notifications as NotificationRecord[]).map((n) => (
              <li key={n.id} className="flex items-start justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="block truncate">{n.subject}</span>
                  <span className="text-muted text-xs">
                    {formatDateTime(n.sent_at ?? n.created_at, s.timezone)}
                    {n.attempts > 1 ? ` · ${n.attempts} attempts` : ""}
                    {n.last_error && n.status !== "sent" ? ` · ${n.last_error}` : ""}
                  </span>
                </span>
                <Badge tone={STATUS_TONE[n.status]}>{n.status}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted text-sm">No reminders sent yet.</p>
        )}
      </Card>
    </div>
  );
}
