using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Core.Diagnostics;

/// <summary>
/// P6 M4.4: what the multi-instance locks write to the diagnostics log - a
/// refusal event of its own when a command cannot take its locks, and an
/// acquired / released step in the command's own attempt. Codes, the path
/// and the holder's process id only (and only when that process is on this
/// machine) - never the machine name, never the holder record's text.
/// </summary>
public static class WorkspaceLockDiagnostics
{
    public const string RefusalOperation = "refusal.workspace-lock";
    public const string AcquiredStep = "lock.acquired";
    public const string ReleasedStep = "lock.released";

    public static void Refusal(IDiagnosticsSink? sink, string command, WorkspaceLockRefusal refusal) =>
        Refusal(sink, command, refusal, TimeProvider.System);

    public static void Refusal(IDiagnosticsSink? sink, string command, WorkspaceLockRefusal refusal, TimeProvider time)
    {
        if (refusal is null) return;
        DiagnosticsAttempt.Refuse(sink, RefusalOperation, time,
            DiagnosticField.Code("command", command),
            DiagnosticField.Code("errorCode", refusal.ErrorCode),
            DiagnosticField.Code("lockScope", ScopeCode(refusal.Scope)),
            DiagnosticField.Code("lockMode", ModeCode(refusal.Mode)),
            DiagnosticField.Code("pathLocality", LocalityCode(refusal.Locality)),
            DiagnosticField.Path("path", refusal.Path),
            DiagnosticField.Id("idempotencyKey", refusal.IdempotencyKey),
            DiagnosticField.Number("holderProcessId", refusal.HolderProcessId),
            DiagnosticField.Code("source", "workspace-lock"));
    }

    public static void Acquired(DiagnosticsAttempt? attempt, WorkspaceLockLease lease, long durationMs)
    {
        if (attempt is null || lease is null) return;
        attempt.Step(AcquiredStep,
            DiagnosticField.Number("lockCount", lease.Targets.Count),
            DiagnosticField.Number("durationMs", durationMs));
    }

    public static void Released(DiagnosticsAttempt? attempt, WorkspaceLockLease lease, DateTimeOffset nowUtc)
    {
        if (attempt is null || lease is null) return;
        attempt.Step(ReleasedStep,
            DiagnosticField.Number("lockCount", lease.Targets.Count),
            DiagnosticField.Number("durationMs", (long)Math.Max(0, (nowUtc - lease.AcquiredUtc).TotalMilliseconds)),
            DiagnosticField.Number("failed", lease.FailedReleases));
    }

    public static string? ScopeCode(LockScope? scope) => scope switch
    {
        LockScope.Workspace => "workspace",
        LockScope.Operation => "operation",
        LockScope.Destination => "destination",
        _ => null,
    };

    public static string? ModeCode(LockMode? mode) => mode switch
    {
        LockMode.Exclusive => "exclusive",
        LockMode.Shared => "shared",
        _ => null,
    };

    public static string? LocalityCode(PathLocality? locality) => locality switch
    {
        PathLocality.Local => "local",
        PathLocality.Network => "network",
        PathLocality.CloudSync => "cloud-sync",
        PathLocality.UnsupportedDrive => "unsupported-drive",
        PathLocality.Unresolvable => "unresolvable",
        _ => null,
    };
}
