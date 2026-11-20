"use client";

import { useEffect } from "react";

/**
 * Pilot UX fix KI-2: shows the fixed, allowlisted message for a refused
 * action. `message` always comes from the server-side allowlist
 * (app/lib/action-notice-core.ts), never from the URL. (B06: a release
 * refusal may name a document; that number is looked up on the server among
 * the user's own organization's documents, never taken from the URL.)
 *
 * After it is shown, the notice parameters (`notice`, and B06's `doc` and
 * `more`) are removed from the address bar (without a reload), so a later
 * action or refresh does not show the same message again. This runs after
 * every render on purpose: a repeated refusal navigates back to the same
 * notice URL without remounting this component.
 */
const NOTICE_PARAMS = ["notice", "doc", "more"] as const;

export function ActionNotice({
  message,
  kind = "refused",
}: {
  message: string;
  /** B05: /admin/users also confirms a completed change. */
  kind?: "refused" | "success";
}) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (NOTICE_PARAMS.some((name) => url.searchParams.has(name))) {
      for (const name of NOTICE_PARAMS) url.searchParams.delete(name);
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  });

  if (kind === "success") {
    return (
      <div
        role="status"
        data-testid="action-notice"
        className="mt-4 rounded-md border border-teal-300 bg-teal-50 px-4 py-3 text-sm text-teal-950"
      >
        <span className="font-semibold">Done: </span>
        {message}
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid="action-notice"
      className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
    >
      <span className="font-semibold">Not changed: </span>
      {message}
    </div>
  );
}
