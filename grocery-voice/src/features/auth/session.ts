import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { AppError } from "@/lib/errors";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { can, type HouseholdAction } from "@/features/households/permissions";
import type { HouseholdRole } from "@/types/domain";

export const ACTIVE_HOUSEHOLD_COOKIE = "gv_household";

/** Remembers which household the user is looking at (not an authorization signal). */
export async function setActiveHouseholdCookie(householdId: string) {
  (await cookies()).set(ACTIVE_HOUSEHOLD_COOKIE, householdId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export interface Membership {
  householdId: string;
  householdName: string;
  role: HouseholdRole;
}

/** Verified user (asks Supabase Auth; does not trust the cookie alone). */
export const getUser = cache(async (): Promise<User | null> => {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
});

export async function requirePageUser(next = "/list"): Promise<User> {
  const user = await getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  return user;
}

export const getMemberships = cache(async (): Promise<Membership[]> => {
  const user = await getUser();
  if (!user) return [];
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("household_members")
    .select("household_id, role, households(name)")
    .eq("user_id", user.id)
    .order("joined_at");
  if (error) throw error;
  return (data ?? []).map((row) => ({
    householdId: row.household_id as string,
    role: row.role as HouseholdRole,
    householdName: (row.households as unknown as { name: string } | null)?.name ?? "Household",
  }));
});

/** For pages: the active household, or redirect to onboarding. */
export async function requireActiveHousehold(next = "/list") {
  const user = await requirePageUser(next);
  const memberships = await getMemberships();
  if (memberships.length === 0) redirect("/onboarding");
  const preferred = (await cookies()).get(ACTIVE_HOUSEHOLD_COOKIE)?.value;
  const active = memberships.find((m) => m.householdId === preferred) ?? memberships[0]!;
  return { user, memberships, active };
}

/**
 * For route handlers: the caller must be signed in and a member of the
 * household (checked through RLS with the caller's own session).
 */
export async function requireMember(householdId: string, action?: HouseholdAction) {
  const supabase = await createSupabaseServerClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new AppError("unauthorized", "Sign in required");

  const { data, error } = await supabase
    .from("household_members")
    .select("role")
    .eq("household_id", householdId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (error) throw new AppError("internal", "Could not verify membership");
  if (!data) throw new AppError("not_found", "Household not found");

  const role = data.role as HouseholdRole;
  if (action && !can(role, action)) throw new AppError("forbidden", "Your role does not allow this");
  return { user: auth.user, role, supabase };
}

export async function requireApiUser() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new AppError("unauthorized", "Sign in required");
  return { user: data.user, supabase };
}
