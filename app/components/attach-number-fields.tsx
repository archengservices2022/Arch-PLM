"use client";

import { useEffect, useRef } from "react";

import { KeptInput } from "@/app/components/keep-input-form";
import { fileNameStem } from "@/app/lib/document-number-core";

/**
 * DD-ATTACH: the File name and Document number fields of the dashboard
 * "CAD documents > Attach" form.
 *
 * Typing a file name fills the document number with the file name's stem (the
 * name without ONE recognized CAD extension) - but only while the user has not
 * typed in the number box (DD-1): any keystroke there that leaves it non-empty
 * marks it as the user's; clearing it hands it back to the automatic fill.
 * After a refusal the form re-mounts with the kept values; a non-empty kept
 * number is then treated as the user's (never overwritten) - the conservative
 * reading, since the form cannot know who typed it. Both are plain uncontrolled
 * <KeptInput>s (FE-L3); without JavaScript the server derives the same stem
 * from an empty number (app/lib/document-number-core.ts). The server, not this
 * component, enforces "no extension".
 */
export function AttachNumberFields({
  labelClassName,
  inputClassName,
}: {
  labelClassName: string;
  inputClassName: string;
}) {
  const numberRef = useRef<HTMLInputElement>(null);
  const userOwnsNumber = useRef(false);

  useEffect(() => {
    // Mount (also after a refusal): a number already in the box is the user's.
    userOwnsNumber.current = (numberRef.current?.value ?? "") !== "";
  }, []);

  return (
    <>
      <label className={labelClassName}>
        File name
        <KeptInput
          name="fileName"
          required
          placeholder="10073-MFD-AS210.iam"
          className={inputClassName}
          onChange={(event) => {
            const number = numberRef.current;
            if (number && !userOwnsNumber.current) number.value = fileNameStem(event.currentTarget.value);
          }}
        />
      </label>
      <label className={labelClassName}>
        Document number (no extension)
        <KeptInput
          ref={numberRef}
          name="documentNumber"
          placeholder="10073-MFD-AS210"
          className={inputClassName}
          onChange={(event) => {
            // Programmatic fills do not fire this; only the user's own edits do.
            userOwnsNumber.current = event.currentTarget.value !== "";
          }}
        />
      </label>
    </>
  );
}
