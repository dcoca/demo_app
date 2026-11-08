import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md p-6 text-center">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="text-muted mt-2 text-sm">That page doesn&apos;t exist, or you don&apos;t have access to it.</p>
      <Link href="/list" className="mt-4 inline-block text-sm font-medium text-brand-600 underline">
        Back to your list
      </Link>
    </main>
  );
}
