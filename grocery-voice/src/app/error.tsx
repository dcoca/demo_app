"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-md p-6 text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-muted mt-2 text-sm">Your list is safe. Try again in a moment.</p>
      <button onClick={reset} className="mt-4 rounded-xl bg-brand-600 px-4 py-2 text-sm font-medium text-white">
        Try again
      </button>
    </main>
  );
}
