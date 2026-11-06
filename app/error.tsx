"use client"; // Error boundaries must be Client Components

import Link from "next/link";

/**
 * Pilot UX fix KI-2: generic fallback for UNEXPECTED errors (expected
 * refusals are shown as notices on the dashboard instead).
 *
 * Shows no error details: in production Next.js forwards only a generic
 * message and a digest from the server; the digest is shown so a reported
 * problem can be matched to the server log.
 */
export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <main className="min-h-screen bg-stone-100 px-6 py-10 text-slate-950">
      <section className="mx-auto flex max-w-xl flex-col gap-4 rounded-md border border-slate-300 bg-white p-6">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-teal-700">
          Arch PLM
        </p>
        <h1 className="text-2xl font-semibold">Something went wrong</h1>
        <p className="text-sm leading-6 text-slate-700">
          The request could not be completed. Return to the dashboard to check
          the current state before trying again.
        </p>
        {error.digest ? (
          <p className="text-xs text-slate-500">Reference: {error.digest}</p>
        ) : null}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => retry()}
            className="h-9 rounded-md bg-teal-700 px-3 text-xs font-semibold text-white transition hover:bg-teal-800"
          >
            Try again
          </button>
          <Link
            href="/"
            className="flex h-9 items-center rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-700"
          >
            Back to dashboard
          </Link>
        </div>
      </section>
    </main>
  );
}
