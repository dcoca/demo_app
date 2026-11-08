import { requireMember } from "@/features/auth/session";
import { fromDatabaseError } from "@/lib/errors";
import { handler, ok, readJson } from "@/lib/http";
import { notificationPrefsSchema } from "@/lib/validation/schemas";

type Ctx = { params: Promise<{ householdId: string }> };

export const PUT = handler(async (req: Request, { params }: Ctx) => {
  const { householdId } = await params;
  const { user, supabase } = await requireMember(householdId);
  const input = await readJson(req, notificationPrefsSchema);
  const { data, error } = await supabase
    .from("notification_preferences")
    .upsert({ household_id: householdId, user_id: user.id, email_reminders: input.emailReminders, updated_at: new Date().toISOString() })
    .select("email_reminders")
    .single();
  if (error) throw fromDatabaseError(error);
  return ok(data);
});
