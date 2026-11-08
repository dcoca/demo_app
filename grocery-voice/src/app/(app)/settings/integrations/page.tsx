import type { Metadata } from "next";
import Link from "next/link";
import { requireActiveHousehold } from "@/features/auth/session";
import { can } from "@/features/households/permissions";
import { ConnectionManager, CredentialManager } from "@/features/integrations/integration-forms";
import { Card } from "@/components/ui";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { IntegrationConnection, IntegrationCredential } from "@/types/domain";

export const metadata: Metadata = { title: "Siri & Alexa" };

export default async function IntegrationsPage() {
  const { active } = await requireActiveHousehold("/settings/integrations");
  const supabase = await createSupabaseServerClient();
  const [{ data: credentials }, { data: connections }, { data: runs }] = await Promise.all([
    supabase
      .from("integration_credentials")
      .select("id, household_id, created_by, label, allowed_sources, scopes, token_prefix, created_at, last_used_at, revoked_at")
      .eq("household_id", active.householdId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false }),
    supabase.from("integration_connections").select("*").eq("household_id", active.householdId).order("created_at"),
    supabase
      .from("sync_runs")
      .select("id, connection_id, started_at, status, fetched, imported, already_mapped, error")
      .eq("household_id", active.householdId)
      .order("started_at", { ascending: false })
      .limit(10),
  ]);

  return (
    <div className="space-y-4">
      <Link href="/settings" className="text-muted text-sm">
        ← Settings
      </Link>
      <h1 className="text-lg font-semibold">Siri &amp; Alexa</h1>

      <Card
        title="Siri (Apple Shortcuts)"
        description={
          <>
            Create a token, then build the &ldquo;Add to Groceries&rdquo; Shortcut on your iPhone or Mac. Each token works for
            this household only and can be revoked any time. Full steps are in <code>docs/integrations.md</code>.
          </>
        }
      >
        <CredentialManager householdId={active.householdId} credentials={(credentials ?? []) as IntegrationCredential[]} />
      </Card>

      <Card
        title="Alexa (through Home Assistant)"
        description="Grocery Voice reads your Alexa shopping list from Home Assistant every few minutes. It never sees your Amazon password, and it never deletes items here because something changed or went missing in Alexa."
      >
        <ConnectionManager
          householdId={active.householdId}
          connections={(connections ?? []) as IntegrationConnection[]}
          runs={(runs ?? []) as Array<{ id: string; connection_id: string; started_at: string; status: string; fetched: number; imported: number; already_mapped: number; error: string | null }>}
          canManage={can(active.role, "integrations:manage")}
        />
      </Card>
    </div>
  );
}
