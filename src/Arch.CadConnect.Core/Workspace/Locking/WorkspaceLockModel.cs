namespace Arch.CadConnect.Core.Workspace.Locking;

/// <summary>P6 M4.4: what a lock protects.</summary>
public enum LockScope
{
    /// <summary>W - a managed workspace, locked IN PLACE
    ///  (<c>&lt;root&gt;\.arch\locks\workspace.lock</c>), so every process that can
    ///  write the workspace - any user, any session - meets the same file.</summary>
    Workspace,

    /// <summary>O - one Copy Design operation (server origin + idempotency
    ///  key), machine-wide.</summary>
    Operation,

    /// <summary>D - one unmanaged Copy Design destination folder,
    ///  machine-wide.</summary>
    Destination,
}

public enum LockMode
{
    Shared,
    Exclusive,
}

/// <summary>Where a path really lives, after every alias (junction, subst,
///  mapped drive, <c>\\?\</c> prefix, case, short name) is resolved.</summary>
public enum PathLocality
{
    /// <summary>A fixed or removable local volume.</summary>
    Local,

    /// <summary>UNC, a mapped network drive, or a subst onto a share.</summary>
    Network,

    /// <summary>Inside a cloud-sync folder (OneDrive) or carrying cloud-file
    ///  placeholder attributes - sync never carries a lock to another machine.</summary>
    CloudSync,

    /// <summary>CD, RAM disk or an unknown drive type.</summary>
    UnsupportedDrive,

    /// <summary>The path could not be resolved at all.</summary>
    Unresolvable,
}

/// <summary>Whether a local path lies inside a folder this machine publishes
///  as a file share (another machine could write it).</summary>
public enum ShareExposure
{
    NotShared,
    Shared,

    /// <summary>The share list could not be read - treated as shared.</summary>
    Unknown,
}

/// <summary>A file's identity on its volume - unchanged by renames of
///  OTHER paths, changed when the folder is replaced.</summary>
public readonly record struct FileIdentity(uint VolumeSerial, ulong FileIndex);

/// <summary>What a workspace manifest says about its binding, read without
///  changing anything (the same fields the M4.1 origin guard reads).</summary>
public sealed record WorkspaceBindingSnapshot(bool ManifestPresent, string? Schema, string? ServerOrigin, string? OrganizationId)
{
    public static readonly WorkspaceBindingSnapshot None = new(false, null, null, null);
}

/// <summary>Everything that must still be true after a lock is acquired.
///  Compared by value: any change - another folder swapped in, a manifest
///  created, removed or re-bound - refuses the command.</summary>
public sealed record LockIdentity(
    string CanonicalPath,
    bool Exists,
    FileIdentity? Id,
    string ExistingAncestor,
    FileIdentity? AncestorId,
    WorkspaceBindingSnapshot? Binding);

/// <summary>One lock a command needs. <see cref="Key"/> is the canonical
///  workspace root or destination folder, or the operation key.</summary>
public sealed record LockTarget(LockScope Scope, LockMode Mode, string Key, string? DisplayPath, LockIdentity? Identity);

/// <summary>Why a command may not take its locks. Never carries a message;
///  the controller words it.</summary>
public sealed record WorkspaceLockRefusal(
    string ErrorCode,
    LockScope? Scope = null,
    LockMode? Mode = null,
    string? Path = null,
    PathLocality? Locality = null,
    string? IdempotencyKey = null,
    WorkspaceLockHolderRecord? Holder = null,
    int? HolderProcessId = null);

/// <summary>The fixed error codes of M4.4 lock refusals (also the
///  diagnostics <c>errorCode</c> values).</summary>
public static class WorkspaceLockErrorCodes
{
    public const string WorkspaceLocked = "workspace-locked";
    public const string OperationLocked = "operation-locked";
    public const string DestinationLocked = "destination-locked";
    public const string LockUnavailable = "lock-unavailable";
    public const string LockAccessDenied = "lock-access-denied";
    public const string LockPathInvalid = "lock-path-invalid";
    public const string LockPathReparse = "lock-path-reparse";
    public const string LockForeignContent = "lock-foreign-content";
    public const string PathUnresolvable = "path-unresolvable";
    public const string PathNetworkUnsupported = "path-network-unsupported";
    public const string PathSyncUnsupported = "path-sync-unsupported";
    public const string PathTypeUnsupported = "path-type-unsupported";
    public const string PathSharedUnsupported = "path-shared-unsupported";
    public const string ShareStatusUnknown = "share-status-unknown";
    public const string NotInWorkspace = "not-in-workspace";
    public const string NestedWorkspace = "nested-workspace";
    public const string AmbiguousRoot = "ambiguous-root";
    public const string DestinationOverlap = "destination-overlap";
    public const string DestinationOverlapsSource = "destination-overlaps-source";
    public const string DestinationReservedPath = "destination-reserved-path";
    public const string OperationKeyMissing = "operation-key-missing";
    public const string PathChanged = "path-changed";
    public const string WorkspaceChanged = "workspace-changed";

    /// <summary>The code for "someone else holds it", per scope.</summary>
    public static string LockedFor(LockScope scope) => scope switch
    {
        LockScope.Operation => OperationLocked,
        LockScope.Destination => DestinationLocked,
        _ => WorkspaceLocked,
    };

    /// <summary>The refusal code for a path that is not on a supported local
    ///  volume, or null when it is.</summary>
    public static string? ForLocality(PathLocality locality) => locality switch
    {
        PathLocality.Local => null,
        PathLocality.Network => PathNetworkUnsupported,
        PathLocality.CloudSync => PathSyncUnsupported,
        PathLocality.UnsupportedDrive => PathTypeUnsupported,
        _ => PathUnresolvable,
    };
}
