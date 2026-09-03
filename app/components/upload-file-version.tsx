"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Upload control for a CAD document's next file version.
 *
 * The file is streamed to the API as the raw request body (the server enforces
 * the size limit while reading and computes SHA-256 + byte size itself). A
 * plain multipart <form> can't express a raw-body upload, hence this small
 * client component.
 */
export function UploadFileVersion({
  cadDocumentId,
}: {
  cadDocumentId: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/cad-documents/${cadDocumentId}/file-versions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "x-original-filename": file.name,
          },
          body: file,
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? `Upload failed (${response.status})`);
        return;
      }

      router.refresh();
    } catch {
      setError("Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  }

  return (
    <span className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        required
        disabled={busy}
        onChange={onChange}
        className="text-xs file:mr-2 file:rounded-md file:border-0 file:bg-slate-950 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white disabled:opacity-50"
      />
      {busy ? (
        <span className="text-xs text-slate-500">Uploading&hellip;</span>
      ) : null}
      {error ? (
        <span className="text-xs font-semibold text-red-600">{error}</span>
      ) : null}
    </span>
  );
}
