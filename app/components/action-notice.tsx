"use client";

import { useEffect } from "react";

/**
 * Pilot UX fix KI-2: shows the fixed, allowlisted message for a refused
 * action. `message` always comes from the server-side allowlist
 * (app/lib/action-notice-core.ts), never from the URL.
 *
 * After it is shown, the `notice` parameter is removed from the address bar
 * (without a reload), so a later action or refresh does not show the same
 * message again. This runs after every render on purpose: a repeated refusal
 * navigates back to the same notice URL without remounting this component.
 */
export function ActionNotice({ message }: { message: string }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("notice")) {
      url.searchParams.delete("notice");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  });

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
