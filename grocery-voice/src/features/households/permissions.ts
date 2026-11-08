import type { HouseholdRole } from "@/types/domain";

export type HouseholdAction =
  | "list:edit"
  | "order:manage"
  | "household:rename"
  | "members:invite"
  | "members:change_role"
  | "members:remove"
  | "schedule:edit"
  | "integrations:manage"
  | "credentials:create_own";

const MATRIX: Record<HouseholdAction, HouseholdRole[]> = {
  "list:edit": ["owner", "admin", "member"],
  "order:manage": ["owner", "admin", "member"],
  "credentials:create_own": ["owner", "admin", "member"],
  "household:rename": ["owner", "admin"],
  "members:invite": ["owner", "admin"],
  "schedule:edit": ["owner", "admin"],
  "integrations:manage": ["owner", "admin"],
  "members:change_role": ["owner"],
  "members:remove": ["owner"],
};

/** Mirrors the RLS policies; used for UI affordances and service guards. */
export function can(role: HouseholdRole | null | undefined, action: HouseholdAction): boolean {
  return role ? MATRIX[action].includes(role) : false;
}
