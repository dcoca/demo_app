"use client";

import { useRouter } from "next/navigation";
import type { Membership } from "@/features/auth/session";
import { api } from "@/lib/api-client";

export function HouseholdSwitcher({ memberships, activeId }: { memberships: Membership[]; activeId: string }) {
  const router = useRouter();
  const active = memberships.find((m) => m.householdId === activeId);
  if (memberships.length <= 1) {
    return <span className="truncate text-base font-semibold">{active?.householdName}</span>;
  }
  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="sr-only">Household</span>
      <select
        className="truncate bg-transparent text-base font-semibold"
        value={activeId}
        onChange={async (e) => {
          await api("/api/v1/active-household", { method: "POST", body: { householdId: e.target.value } });
          router.refresh();
        }}
      >
        {memberships.map((m) => (
          <option key={m.householdId} value={m.householdId}>
            {m.householdName}
          </option>
        ))}
      </select>
    </label>
  );
}
