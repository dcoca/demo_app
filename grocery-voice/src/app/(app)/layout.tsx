import type { ReactNode } from "react";
import { requireActiveHousehold } from "@/features/auth/session";
import { AppNav } from "@/components/app-nav";
import { HouseholdSwitcher } from "@/features/households/household-switcher";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { memberships, active } = await requireActiveHousehold();
  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col">
      <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-subtle bg-[var(--bg)]/90 px-4 py-3 backdrop-blur">
        <HouseholdSwitcher memberships={memberships} activeId={active.householdId} />
        <div className="hidden sm:block">
          <AppNav variant="top" />
        </div>
      </header>
      <main className="flex-1 px-4 pt-4 pb-28 sm:pb-10">{children}</main>
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-subtle bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] sm:hidden">
        <AppNav variant="bottom" />
      </div>
    </div>
  );
}
