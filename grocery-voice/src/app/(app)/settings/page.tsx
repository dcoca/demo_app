import type { Metadata } from "next";
import Link from "next/link";
import { requireActiveHousehold } from "@/features/auth/session";
import { can } from "@/features/households/permissions";
import { HouseholdSettings, InviteForm, MemberList, NotificationToggle } from "@/features/households/settings-forms";
import { Card } from "@/components/ui";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { householdProfiles } from "@/server/queries";
import type { DuplicatePolicy, HouseholdRole } from "@/types/domain";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { user, active } = await requireActiveHousehold("/settings");
  const supabase = await createSupabaseServerClient();
  const [{ data: household }, { data: members }, { data: invitations }, { data: prefs }, profiles] = await Promise.all([
    supabase.from("households").select("id, name, duplicate_policy").eq("id", active.householdId).single(),
    supabase.from("household_members").select("user_id, role, joined_at").eq("household_id", active.householdId).order("joined_at"),
    can(active.role, "members:invite")
      ? supabase
          .from("household_invitations")
          .select("id, email, role, expires_at")
          .eq("household_id", active.householdId)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .gt("expires_at", new Date().toISOString())
      : Promise.resolve({ data: [] }),
    supabase.from("notification_preferences").select("email_reminders").eq("household_id", active.householdId).eq("user_id", user.id).maybeSingle(),
    householdProfiles(active.householdId),
  ]);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      <nav className="grid grid-cols-2 gap-2 text-sm">
        <Link href="/settings/schedule" className="surface rounded-xl px-4 py-3 font-medium">
          Schedule &amp; reminders →
        </Link>
        <Link href="/settings/integrations" className="surface rounded-xl px-4 py-3 font-medium">
          Siri &amp; Alexa →
        </Link>
      </nav>

      <HouseholdSettings
        householdId={active.householdId}
        name={household?.name ?? ""}
        duplicatePolicy={(household?.duplicate_policy as DuplicatePolicy) ?? "increase_quantity"}
        canEdit={can(active.role, "household:rename")}
      />

      <Card title="Members">
        <MemberList
          householdId={active.householdId}
          currentUserId={user.id}
          currentRole={active.role}
          members={((members ?? []) as Array<{ user_id: string; role: HouseholdRole }>).map((m) => ({
            userId: m.user_id,
            role: m.role,
            name: profiles[m.user_id]?.display_name ?? "Member",
            email: profiles[m.user_id]?.email ?? "",
          }))}
        />
      </Card>

      {can(active.role, "members:invite") ? (
        <Card title="Invite someone" description="They'll get an email link. Invitations expire after 7 days and only work for that email address.">
          <InviteForm
            householdId={active.householdId}
            pending={(invitations ?? []) as Array<{ id: string; email: string; role: string; expires_at: string }>}
          />
        </Card>
      ) : null}

      <Card title="My notifications">
        <NotificationToggle householdId={active.householdId} enabled={prefs?.email_reminders ?? true} />
      </Card>

      <form action="/auth/signout" method="post">
        <button className="text-muted min-h-11 text-sm underline">Sign out</button>
      </form>
    </div>
  );
}
