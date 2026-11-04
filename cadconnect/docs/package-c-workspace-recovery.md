# Workspace recovery after an interrupted manifest save

Arch CAD Connect refuses every command on a workspace in the `RecoveryRequired` state:
Get Latest, Checkout, Check In, Undo Checkout, and Copy Design for both source and
destination. The refusal names the files it found, relative to the workspace folder.

Arch PLM never restores, promotes, replaces or deletes any of these files. Only a person
resolves this state, because everything in a workspace folder is editable: **a file name, a
timestamp or a hash in the folder proves nothing about what a file holds.**

## What the state means

| What is in `.arch` | Meaning |
| --- | --- |
| No `workspace.json`, a `workspace.json.<id>.previous` | A save stopped after setting the old record aside. The `.previous` file is probably the last complete record. |
| `workspace.json` and a `.previous` | The new record is in place and cleanup did not finish, or someone else wrote `workspace.json` during the save. |
| No `workspace.json`, only a `workspace.json.<id>.tmp` | A first save stopped before it finished, or the record was moved away. |
| `workspace.json` beside a `.tmp` it cannot be checked against | The record is unreadable. |
| Any other file or folder whose name starts with `workspace.json` | Unknown. Treat it as unsafe. |
| `.arch` is a link or could not be listed | The folder could not be verified. |

## Procedure

1. **Stop everyone using this workspace.** Close every Inventor window on every computer
   that uses it. Recovery while a command runs is not protected.
2. **Back up first.** Copy the CAD files and the whole `.arch` folder, unchanged, to a safe
   place. Do not delete anything, here or later.
3. **Check each candidate record.** Open it in a text editor and confirm that:
   - it is complete JSON, and its `schema` is `arch-plm.workspace-manifest.v1`;
   - its `serverOrigin` is exactly the server this workspace belongs to;
   - its `organizationId` is your organization (older records may not have one; such a
     record cannot be verified locally, so confirm it with your administrator);
   - its `entries` describe the files in this folder.
4. **Reconcile checkouts against the server.** For each file you have checked out, ask the
   server (Arch PLM web, or your administrator), not the record. A candidate saved before a
   checkout has no entry for it. Restoring it loses the local marker while the server still
   shows the checkout: Get Latest then treats the file like any other that differs from its
   pinned version, and an unchanged file can be set read-only.
5. **Decide, and move only what you have checked:**

   | Situation | Action |
   | --- | --- |
   | No `workspace.json`, one `.previous` passes steps 3 and 4 | Rename it to `workspace.json`. Move any `.tmp` out of `.arch`. |
   | Both present, `workspace.json` passes steps 3 and 4 | Keep `workspace.json`. Move `.previous` out of `.arch`. |
   | No `workspace.json`, only a `.tmp`, and no checkouts expected | Move the `.tmp` out of `.arch`. The folder then counts as new. |
   | Anything else, or any doubt at all | **Stop and escalate** (below). |

6. **Run Get Latest** signed in to that workspace's own server. The ordinary server and
   organization checks apply to the record you chose. Review the result before working on.

## A checkout the workspace has no record of

The server can hold a checkout this workspace has no marker for, for example after a failed
save, or a lost answer to Checkout. Get Latest then leaves that file alone and says so, and
Check In and Undo Checkout refuse it. Nothing is released automatically.

**Run Checkout on the file again.** It asks the server first, and restores the record only if
the server confirms your checkout, on the version this workspace holds, and your account may
still check out. Your edits are not touched.

If Checkout reports the checkout is on another version, or your account may no longer check
out, or the workspace entry is Unverified, an administrator must reconcile it:

1. Stop everyone using this workspace, then copy the file and the `.arch` folder somewhere safe.
2. On the server, confirm the checkout, its owner and its base version.
3. If the local file has edits to keep, copy it out and note which version it started from.
4. The administrator releases the checkout with Admin Unlock.
5. Run Get Latest into this workspace or a new, empty folder.
6. Check out the document again and reapply any edits by hand.

## When to escalate

Leave every file where it is and contact your Arch PLM administrator if there is more than
one candidate, an unfamiliar file name, a link in `.arch`, a candidate that fails any check in
step 3, a checkout that cannot be reconciled, or anything you are unsure about. Meanwhile, run
Get Latest into a new, empty workspace folder.
