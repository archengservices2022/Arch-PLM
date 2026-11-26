# Pilot structure procedure: recording assembly structure before a release

**Applies to:** the Arch PLM pilot.
**Basis:** PO decision BOM-1(a) = D-B (signed 2026-11-19) and the signed B06 plan Rev1, decisions G-1 to G-4 (all option a).
**Replaced by:** automatic capture of references on check-in (backlog F00/F01) in the full release.

During the pilot, Arch PLM does **not** read an assembly's structure from Inventor. The structure, meaning which parts an assembly contains and which models a drawing shows, is recorded **by hand** on the dashboard under **CAD references**. A release includes only the documents that are linked to the revision, plus everything reachable from them through those recorded links.

The server enforces two rules when a revision is released:

1. **Every assembly (IAM) in the release needs at least one COMPONENT link, and every drawing (IDW/DWG) needs at least one DRAWING_REFERENCE link.** This includes sub-assemblies reached through other links. Otherwise the release is refused, and the message names the document.
2. **The release comment must start with `Structure checked against Scan References`** whenever the release contains an assembly or a drawing. Otherwise the release is refused.

A refused release changes nothing.

> **What the server can NOT check.** It only notices structure that is completely **missing**. It cannot tell whether the recorded structure is **complete** (1 of 5 parts linked passes) or **out of date** (a part was replaced after the links were entered). Completeness depends entirely on this procedure. The sign-off comment is your **statement** that you followed it, not a proof.

## Who

- **The engineer who owns the assembly** checks and records the structure (steps 1–5).
- **The person who releases** (Approver or Admin) confirms the check was done and releases with the sign-off comment (step 6).

## When

Before **every** release of a revision whose documents include an assembly or a drawing, not only the first time. Assemblies change between revisions, and recorded links do not update themselves.

## Steps

### 1. Make sure every component is managed in Arch PLM (G-1)

Every part and sub-assembly in the assembly must be a CAD document in Arch PLM, including library and Content Center parts. A link can only point at a managed document. There is **no exception** in the pilot: register unmanaged parts first.

**Document numbers have no file extension.** Enter `A-1001`, not `A-1001.ipt`. This is a pilot decision: D-D decision record Rev1, signed by the PO 2026-11-19, DD-3(a).

- Documents are registered in two places, and both follow the rule: the dashboard **Attach** form (below) and **Copy Design** in Inventor.
- **Scan References** prints the number exactly as stored, so the comparison in steps 2 and 3 still works if a number has an extension. The rule exists because of the decision, not because the comparison needs it.
- On the dashboard, **CAD documents > Attach** has a **Document number (no extension)** field. Typing the file name fills it with the name minus ONE recognized extension from the list below (`10073-MFD-AS210.iam` gives `10073-MFD-AS210`; `notes.txt` stays `notes.txt`, because `.txt` is not in the list). Once you type in the number box yourself, a later file-name change no longer touches it; clear the box to get the automatic number back. If you leave it empty, the server uses that same name minus one recognized extension. The server **refuses** a number that still ends in a CAD or drawing extension (`.ipt`, `.iam`, `.idw`, `.dwg`, `.pdf`, `.ipn`, `.dxf`, `.step`, `.stp`, `.iges`, `.igs`, `.sat`, `.stl`, any letter case) and keeps what you typed so you can correct it. A number such as `PUMP-REV.2` is not an extension and is accepted.
- **Copy Design** in Inventor already sets each new document's number to the new file name **without** its extension.

### 2. Scan the assembly in Inventor

For each assembly in the release, **including every sub-assembly**:

1. Open it in Inventor, saved and signed in.
2. On the **ARCH ENGINEERING** tab, run **Scan References**.
3. The scan status must be **COMPLETE**. If it is **PARTIAL**, some documents could not be inspected; fix that first (open or resolve them), or the comparison below is not reliable.
4. Note every component the report lists under **References (by parent)**, with the **document number** from its `identity ->` line.
   - A component is managed only if the report shows an **`identity ->`** line with its document number.
   - Any entry **without** one must be registered first (step 1). That includes **INSIDE WORKSPACE** entries (a file in the workspace is not necessarily an Arch PLM document), and every **OUTSIDE WORKSPACE**, **SCOPE UNKNOWN** or **UNRESOLVED** entry.
   - A line **[CHILD REFERENCES NOT ENUMERATED]** means that sub-document was not inspected. Open or resolve it and scan again, as for PARTIAL.

### 3. Compare with Arch PLM and correct the links

On the dashboard, under **CAD references**, find the assembly. Compare by **document number**: use the numbers from the scan's `identity ->` lines, not file names. Then:

- **Add** a **COMPONENT** link for every component in the scan that is missing: **Parent CAD document = the assembly**, **Child CAD document = the component**. The direction matters: a reversed link leaves the assembly without components, and a release does not follow it to the parts.
- **Remove** every link to a part that is no longer in the assembly, using the **Remove** button next to the link (G-3).
  - Each removal is written to the server log (who, which link, when). This is the only record until the full release adds structure history. Remove links deliberately.
  - Removing a link does not change any earlier release.
  - If you remove an assembly's **last** COMPONENT link, its next release will be refused until its components are recorded again. This is intended.

### 4. Drawings: link them to the revision AND to their models

For each drawing that belongs to the release:

1. **Link the drawing to the revision being released** (add it to the revision's documents). **A drawing that is not linked to the revision is NOT in the release**, and the server cannot detect that it is missing.
2. Under **CAD references**, give the drawing a **DRAWING_REFERENCE** link to **each** model it shows: **Parent CAD document = the drawing**, **Child CAD document = the model**.

### 5. Copied assemblies (Copy Design)

An assembly created with **Copy Design** starts with **no** links in Arch PLM, even though the files reference their copied parts. Before its first release, record its structure with steps 2–4, like any other assembly.

### 6. Release with the sign-off comment (G-2)

When the structure is correct, release the revision with a comment that **starts with**:

```
Structure checked against Scan References: <date>, <assemblies and drawings checked>
```

For example: `Structure checked against Scan References: 2026-11-19, ASM-1001, ASM-1002, DRW-1001`.

The comment is stored permanently with the release in the revision's lifecycle history. Letter case does not matter, but the comment must **start** with the phrase.

## Known limits for pilot users (G-4)

- **Get Latest of an unreleased (working) assembly may miss parts** if its links are incomplete. For a guaranteed complete set of files, use **Get Latest of a released revision**.
- The server checks only that structure **exists**, not that it is **right**. Steps 2–4 are what make it right.
- Structure is recorded per document, not per file version. Links changed today also affect future releases of other revisions that use the same documents. Earlier releases keep exactly the files they froze.

## If a release is refused

| Message | What to do |
| --- | --- |
| "assembly … has no components recorded" | Steps 2–3 for that assembly (and its sub-assemblies). |
| "drawing … has no model recorded" | Step 4.2 for that drawing. |
| "…release with a comment starting 'Structure checked against Scan References'" | Do steps 1–5, then step 6. |
| "That CAD dependency was not found" (when removing) | Someone else already removed it. Refresh the page. |
