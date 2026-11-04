using System.Globalization;

namespace Arch.CadConnect.Core.Workspace.Locking;

/// <summary>
/// P6 M4.4: the words for a lock refusal, shown to the engineer. Every lock
/// refusal happens before the command's first server request, so every
/// message says nothing was sent or changed. The holder's machine name may
/// appear HERE (shown to the user) - it is never written to the diagnostics
/// log.
/// </summary>
public static class WorkspaceLockMessages
{
    public static string Describe(WorkspaceLockRefusal refusal)
    {
        ArgumentNullException.ThrowIfNull(refusal);
        var at = string.IsNullOrWhiteSpace(refusal.Path) ? "" : $" (\"{refusal.Path}\")";
        var reason = refusal.ErrorCode switch
        {
            WorkspaceLockErrorCodes.WorkspaceLocked => refusal.Holder is { } holder
                ? $"Another Arch CAD Connect window is using this workspace{at}: {holder.Command}, Inventor process {holder.ProcessId}"
                  + (string.IsNullOrWhiteSpace(holder.MachineName) ? "" : $" on {holder.MachineName}")
                  + $", since {holder.AcquiredUtc.ToLocalTime().ToString("HH:mm", CultureInfo.InvariantCulture)}. Try again when it has finished."
                : $"Another Arch CAD Connect window - in this or another Inventor, possibly on another computer - is using this workspace{at}. Try again when it has finished.",
            WorkspaceLockErrorCodes.OperationLocked =>
                "This Copy Design operation is already running in another Inventor window on this computer. Let it finish, then check its result.",
            WorkspaceLockErrorCodes.DestinationLocked =>
                $"Another Copy Design on this computer is writing to the destination folder{at}. Try again when it has finished.",
            WorkspaceLockErrorCodes.PathNetworkUnsupported =>
                $"The folder{at} is on a network location. Workspaces and Copy Design destinations on network folders are not supported yet.",
            WorkspaceLockErrorCodes.PathSyncUnsupported =>
                $"The folder{at} is inside a cloud-sync folder (such as OneDrive), which cannot be locked safely between computers. Use a local folder outside it.",
            WorkspaceLockErrorCodes.PathTypeUnsupported =>
                $"The folder{at} is on a drive type that is not supported. Use a local fixed or removable drive.",
            WorkspaceLockErrorCodes.PathUnresolvable =>
                $"The path{at} could not be resolved.",
            WorkspaceLockErrorCodes.PathSharedUnsupported =>
                $"The destination{at} is inside a folder this computer shares on the network, so another computer could write to it at the same time. "
                + "Choose a destination inside a managed workspace or in an unshared local folder.",
            WorkspaceLockErrorCodes.ShareStatusUnknown =>
                $"Could not determine whether the destination{at} is shared on the network. Choose a destination inside a managed workspace.",
            WorkspaceLockErrorCodes.NotInWorkspace =>
                $"The file{at} is not inside an Arch PLM workspace.",
            WorkspaceLockErrorCodes.NestedWorkspace =>
                $"The path{at} is inside a workspace that is itself inside another Arch PLM workspace. Nested workspaces are not supported.",
            WorkspaceLockErrorCodes.AmbiguousRoot =>
                $"The path{at} reaches its workspace through a folder link that leads into a different workspace. Open the file from its real location.",
            WorkspaceLockErrorCodes.DestinationOverlap =>
                $"Two Copy Design destinations are the same file, or a destination is a folder{at}.",
            WorkspaceLockErrorCodes.DestinationOverlapsSource =>
                $"A Copy Design destination is one of its own source files{at}.",
            WorkspaceLockErrorCodes.DestinationReservedPath =>
                $"A Copy Design destination is inside an \".arch\" folder{at}, which is reserved for Arch PLM.",
            WorkspaceLockErrorCodes.OperationKeyMissing =>
                "The Copy Design operation has no server or idempotency key.",
            WorkspaceLockErrorCodes.PathChanged =>
                $"A folder{at} changed while the command was starting (it was moved or replaced). Try again.",
            WorkspaceLockErrorCodes.WorkspaceChanged =>
                $"The workspace{at} was changed by someone else while the command was starting (its workspace record was created, removed or re-bound). Try again.",
            WorkspaceLockErrorCodes.WorkspaceRecoveryRequired =>
                $"The workspace{at} needs manual recovery: an earlier save of its record did not finish cleanly, or its .arch folder could not be verified. "
                + "Follow the workspace recovery procedure, or ask your Arch PLM administrator.",
            // One code, three causes: the operation is not the one the lock was taken
            // for, the command holding it has ended, or the locked folder could not
            // be verified as the one that was locked (it may have been moved or replaced).
            WorkspaceLockErrorCodes.LockScopeRefused =>
                $"The workspace lock{at} could not be used: it was taken for a different operation, the command that held it has already ended, "
                + "or the workspace folder could not be verified as the one that was locked (it may have been moved or replaced). Try the command again.",
            _ =>
                $"The workspace lock{at} could not be used ({refusal.ErrorCode}).",
        };
        return reason + " Nothing was sent to the server and nothing was changed.";
    }
}
