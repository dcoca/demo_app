import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUser } from "@/features/auth/session";
import { LoginForm } from "@/features/auth/login-form";
import { safeNext } from "@/lib/safe-redirect";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const target = safeNext(next);
  if (await getUser()) redirect(target);
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5 py-10">
      <h1 className="text-2xl font-semibold">Grocery Voice</h1>
      <p className="text-muted mt-1 text-sm">One grocery list for Siri, Alexa and everyone at home.</p>
      <div className="mt-8">
        <LoginForm next={target} linkError={error === "link"} />
      </div>
    </main>
  );
}
