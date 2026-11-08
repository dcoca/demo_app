import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getMemberships, requirePageUser } from "@/features/auth/session";
import { CreateHouseholdForm } from "@/features/households/create-household-form";

export const metadata: Metadata = { title: "Set up your household" };

export default async function OnboardingPage() {
  await requirePageUser("/onboarding");
  if ((await getMemberships()).length > 0) redirect("/list");
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5 py-10">
      <h1 className="text-2xl font-semibold">Set up your household</h1>
      <p className="text-muted mt-1 text-sm">
        Everyone in a household shares one list. Got an invitation instead? Open the link from your email.
      </p>
      <div className="mt-8">
        <CreateHouseholdForm />
      </div>
    </main>
  );
}
