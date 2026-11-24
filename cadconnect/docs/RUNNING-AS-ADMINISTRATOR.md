# Running Inventor as administrator

**Recommendation: start Autodesk Inventor normally. Do not use "Run as administrator".**
Arch CAD Connect is installed, signed in and run entirely per user and needs no
administrator rights (`scripts/install-addin.ps1:147-170`). Running Inventor elevated
gains nothing. It can leave workspace files owned by the Administrators group, it blocks
drag and drop from Explorer, and a second Inventor that is not elevated cannot use
the workspace while the elevated one holds it.

No defect is known. This page describes what changes when Inventor runs elevated and how
to recover.

Facts marked *(code)* come from the add-in source. Facts marked *(Windows)* describe
Windows behaviour that the add-in does not control. Check those with the test below.

## Where the add-in keeps its data

| What | Where | Source |
| --- | --- | --- |
| Add-in manifest | `%APPDATA%\Autodesk\Inventor <year>\Addins\Arch.CadConnect.addin` | `scripts/install-addin.ps1:162-170` |
| COM registration | `HKCU\Software\Classes\CLSID\{93C45016-…}` (per user, no `regsvr32`) | `scripts/install-addin.ps1:146-160` |
| Sign-in session (bearer token) | `%LOCALAPPDATA%\ArchEngineering\CadConnect\session.bin`, DPAPI `CurrentUser` | `src/Arch.CadConnect.Api/DpapiSessionStore.cs:36-58` |
| Connect settings (server, email, last workspace folder) | `%APPDATA%\ArchEngineering\CadConnect\connect.json` | `src/Arch.CadConnect.Inventor/Ui/ConnectSettings.cs:40-42` |
| Diagnostics log | `%LOCALAPPDATA%\ArchEngineering\CadConnect\logs` | `src/Arch.CadConnect.Core/Diagnostics/JsonLinesDiagnosticsSink.cs:88-90` |
| Workspace record, staging, lock file | `<workspace>\.arch\workspace.json`, `.arch\.staging\`, `.arch\locks\workspace.lock` | `WorkspaceManifest.cs:35`, `ManagedFileRestorer.cs:26`, `Locking/LockPrimitives.cs:117-171` |
| Machine-wide operation locks (Copy Design) | named kernel events `Global\ArchCadConnect.Lock.op.*` / `.dst.*`. These are not files. | `Locking/LockPrimitives.cs:303-359` |

All of these are per user, which is why elevation matters only in the ways below.

## What differs when Inventor runs elevated

### Same Windows account, elevated (the usual "Run as administrator")

- **Same profile, same data.** The `%APPDATA%`, `%LOCALAPPDATA%` and `HKCU` paths above are the
  same, so the add-in finds the same manifest, settings and `session.bin`. DPAPI
  `CurrentUser` is tied to the user, not to elevation *(Windows)*, so the saved
  session should still decrypt. If it does not, `TryLoad` treats the problem as "no
  session" and you are asked to sign in again (`DpapiSessionStore.cs:75-79`).
- **Does the add-in load?** The add-in is registered for COM in `HKCU` only. One
  **possible, unconfirmed** cause of a missing **ARCH ENGINEERING** tab in an elevated
  Inventor is that Windows ignores per-user COM registrations in elevated processes
  *(Windows, not verified for Inventor's add-in loader)*. Test step 2 records whether the
  add-in actually loads.
- **The owner and ACL of what an elevated run writes depend on how each file is written.**
  The add-in never sets an owner or ACL itself. Windows determines the result
  *(Windows)*:
  - **New** files and folders get the elevated token's default owner, normally
    `BUILTIN\Administrators`. Their ACL is inherited from the folder they are created in.
    This applies to `Directory.CreateDirectory` and to the `FileStream` that creates
    `workspace.lock` (`Locking/LockPrimitives.cs:154,169-171`).
  - **Moved** files keep the security they already had. Get Latest and restore write a
    file in `.arch\.staging` first and then **move** it into place
    (`WorkspaceMaterializer.cs:396-405`, `ManagedFileRestorer.cs:126-131`). Those files
    carry whatever owner and ACL they were given in `.arch\.staging`. They do not
    necessarily pick up the destination folder's permissions.
  - **Overwritten** files keep the existing file's security. For example, saving settings
    rewrites `connect.json` (`ConnectSettings.cs:65-66`).

  You may still have full access through inherited permissions. That is typical under your
  user profile but not guaranteed elsewhere. CI showed an Administrators owner on the lock
  event (commit `1b0bc2e`, `MachineNamedLockTests.cs:256-269`). Test step 4 records the
  owner and ACL actually observed.
- **The read-only "controlled" marker does not depend on who runs Inventor.** It is only
  the file's read-only attribute (`src/Arch.CadConnect.Core/Files/ManagedFileGuard.cs:22-29,110`), so
  elevation does not change checkout state.
- **An elevated and a normal Inventor exclude each other (fail closed).** If the elevated process created a lock event first, the normal process's
  `CreateEventExW` (requesting only `SYNCHRONIZE`) has one of two outcomes, depending on the
  event's DACL and integrity label *(Windows)*:
  - `ERROR_ALREADY_EXISTS`: access was allowed and the event already exists.
  - `ERROR_ACCESS_DENIED`: access was refused.

  The add-in treats **both** as **held by someone else** (`Locking/LockPrimitives.cs:314-316,346-356`).
  Any other failure counts as "unavailable". In every case the command is refused. You see
  "This Copy Design operation is already running in another Inventor window on this
  computer" or "Another Copy Design on this computer is writing to the destination folder"
  (`WorkspaceLockMessages.cs:25-28`). The workspace lock is the open handle on
  `workspace.lock` and is enforced for every user (`Locking/LockPrimitives.cs:117-128`).
- **If the normal Inventor cannot open `workspace.lock`** (for example because the elevated run
  created `.arch\locks` somewhere you lack write access), the command is refused with
  "The workspace lock (…) could not be used (lock-access-denied). Nothing was sent to the
  server and nothing was changed." (`Locking/LockPrimitives.cs:156-158,177-179`,
  `WorkspaceLockMessages.cs:69-72`).
- **Drag and drop from Explorer into an elevated Inventor is blocked** by Windows (UIPI)
  *(Windows)*. The add-in has no drag-and-drop handler of its own: there is no `AllowDrop`
  or `DragDrop` in `cadconnect/src`. This affects Inventor's own file drop, not an Arch
  command. Use **File > Open** instead.
- **Mapped network drives** may not be visible to an elevated process *(Windows)*. The add-in
  refuses workspaces on network locations anyway (`WorkspaceLockMessages.cs:29-30`).

### A different account (a standard user enters an administrator's credentials)

The process then runs with **the administrator's profile**: a different `%APPDATA%`,
`%LOCALAPPDATA%` and `HKCU`. Because installation is per user, the add-in is **not
installed** for that account and does not load. If someone installs it there, it has its own
settings and its own sign-in, and files it writes belong to that account. Do not do this.
Install and run as the engineer's own account.

## Recovery

1. **Close every Inventor**, elevated and normal. The lock events disappear when their
   process ends (`Locking/LockPrimitives.cs:322-323`). Nothing needs to be deleted.
2. Start Inventor **normally** and retry the command. If it works, nothing more is needed.
   An Administrators owner alone is harmless when the inherited permissions still give you
   Modify.
3. If it is refused (`lock-access-denied`), or Inventor cannot save a checked-out file,
   check the owner and access:
   ```powershell
   Get-Acl "<workspace>" | Format-List Owner, AccessToString
   Get-ChildItem "<workspace>" -Recurse -Force | Get-Acl | Where-Object Owner -like '*Administrators' | Select-Object Path, Owner
   ```
4. Give ownership back to the engineer, **only on the affected paths found in step 3**. Run
   these from an **elevated** prompt opened by the same engineer. `<path>` is one affected
   file or folder. Add `/T` only when `<path>` is a folder whose contents are all affected.

   **Command Prompt** (`cmd.exe`, where `%…%` variables expand):
   ```bat
   icacls "<path>" /setowner "%USERDOMAIN%\%USERNAME%" /C
   icacls "<path>" /grant "%USERDOMAIN%\%USERNAME%:M" /C
   ```
   **PowerShell** (where `%…%` does not expand):
   ```powershell
   $me = "$env:USERDOMAIN\$env:USERNAME"
   icacls "<path>" /setowner $me /C
   icacls "<path>" /grant "${me}:M" /C
   ```
   For a folder, grant `(OI)(CI)M` in place of `M` so the files inside inherit the access.
   Check `%APPDATA%\ArchEngineering\CadConnect` and
   `%LOCALAPPDATA%\ArchEngineering\CadConnect` the same way, and fix them only if step 3
   finds them affected.
5. **Do not** delete `.arch`, `workspace.lock`, or any `workspace.json.*` file. Do not clear
   read-only attributes by hand. The add-in never deletes its lock file
   (`Locking/LockPrimitives.cs:129-132`), and the read-only attribute is the checkout
   marker. If a command reports that the workspace needs recovery, follow
   [package-c-workspace-recovery.md](package-c-workspace-recovery.md).

## Manual test checklist

Use a test workspace and an account that is a local administrator. Record pass or fail and
the exact message for each step.

1. **Baseline.** Start Inventor normally, sign in, run Get Latest into a new workspace
   folder under your profile, then check out one part. Expected: works. `Get-Acl` on the
   workspace and on `.arch\locks\workspace.lock` shows **you** as owner.
2. **Loads elevated?** Close Inventor and start it with **Run as administrator**. Note whether
   the **ARCH ENGINEERING** tab appears, and record the observed result (loaded or not
   loaded). Check **Tools > Add-Ins** for the load state. If it is not loaded, go to step 8.
3. **Session.** In the elevated Inventor, is the user still signed in, or asked to sign in?
   Record which.
4. **Elevated writes.** Get Latest into a **second new** workspace folder, then check out a
   part. Expected: works. Run `Get-Acl … | Format-List Owner, AccessToString` on the new
   folder, on `.arch`, on `.arch\locks\workspace.lock`, and on a downloaded file. **Record the
   observed owner and ACL of each.** An owner of `BUILTIN\Administrators` is likely, but the
   ACL of downloaded (moved) files may differ from that of the folder.
5. **Mixed instances.** With the elevated Inventor still open, start a second Inventor
   **normally**. Prepare two Copy Designs from **different workspaces** that both target
   the **same destination folder** outside both workspaces. Each new run gets its own
   operation key, so only a shared destination makes the two collide. Start the one in the
   elevated Inventor, and while it runs, start the other in the normal Inventor. Expected:
   the second is refused with the lock-refusal message "Another Copy Design on this computer
   is writing to the destination folder (…). Try again when it has finished. Nothing was
   sent to the server and nothing was changed." Record the exact message.
6. **Drag and drop.** Drag an `.ipt` from Explorer onto the elevated Inventor. Expected:
   Windows blocks the drop. **File > Open** works.
7. **After elevation.** Close all Inventor windows. Start Inventor normally and open the
   step-4 workspace. Check in or undo the checkout, then Get Latest. Expected: works, or is refused
   with `lock-access-denied` and changes nothing. If it is refused, apply Recovery step 4 and
   retry. Expected: works.
8. **Clean up.** Delete the test workspaces, sign out, and confirm that `%APPDATA%` and
   `%LOCALAPPDATA%\ArchEngineering\CadConnect` are owned by you.
