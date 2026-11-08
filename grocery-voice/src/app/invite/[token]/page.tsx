import type { Metadata } from "next";
import { getUser } from "@/features/auth/session";
import { AcceptInvitation } from "@/features/households/accept-invitation";
import Link from "next/link";

export const metadata: Metadata = { title: "Join a household" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getUser();
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-5 py-10">
      <h1 className="text-2xl font-semibold">Join a household</h1>
      {user ? (
        <>
          <p className="text-muted mt-1 text-sm">Signed in as {user.email}. The invitation must have been sent to this address.</p>
          <div className="mt-6">
            <AcceptInvitation token={token} />
          </div>
        </>
      ) : (
        <>
          <p className="text-muted mt-1 text-sm">Sign in or create an account with the email address the invitation was sent to.</p>
          <Link
            href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
            className="mt-6 inline-flex min-h-11 items-center justify-center rounded-xl bg-brand-600 px-4 text-sm font-medium text-white"
          >
            Continue
          </Link>
        </>
      )}
    </main>
  );
}
