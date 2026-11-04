using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.CopyDesign.Apply;
using Arch.CadConnect.Core.Session;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Core.Diagnostics;

/// <summary>
/// M4.2: what a Copy Design attempt (Apply, Resume, Recover) writes to its
/// diagnostics log - the start (kind, key, bound server, user id, plan
/// shape), every orchestrator phase boundary, every entry's outcome, cleanup,
/// and exactly ONE terminal event classified from the result. A failure is
/// described by its outcome code and the phase it failed in - never by the
/// result's free-text reason, which can carry server or exception text. Kept
/// in Core so every <see cref="CopyDesignApplyOutcome"/> is unit-testable;
/// the controller only calls these.
/// </summary>
public static class CopyDesignDiagnostics
{
    public const string ApplyOperation = "copydesign.apply";
    public const string ResumeOperation = "copydesign.resume";
    public const string RecoverOperation = "copydesign.recover";

    public static string OperationFor(string attemptKind) => attemptKind switch
    {
        "Resume" => ResumeOperation,
        "Recover" => RecoverOperation,
        _ => ApplyOperation,
    };

    public static DiagnosticsAttempt Start(
        IDiagnosticsSink? sink, string attemptKind, CopyDesignPlan plan, string idempotencyKey,
        IArchSession session, string? confirmedFingerprint) =>
        Start(sink, attemptKind, plan, idempotencyKey, session.Server.OriginString,
            session.Identity.UserId, session.Identity.OrganizationId, confirmedFingerprint, TimeProvider.System);

    public static DiagnosticsAttempt Start(
        IDiagnosticsSink? sink, string attemptKind, CopyDesignPlan plan, string idempotencyKey,
        string serverOrigin, string? userId, string? organizationId, string? confirmedFingerprint, TimeProvider time)
    {
        ArgumentNullException.ThrowIfNull(plan);
        return DiagnosticsAttempt.Start(sink, OperationFor(attemptKind), time,
            DiagnosticField.Code("attemptKind", attemptKind),
            DiagnosticField.Id("idempotencyKey", idempotencyKey),
            DiagnosticField.Origin("serverOrigin", serverOrigin),
            DiagnosticField.Id("userId", userId),
            DiagnosticField.Id("organizationId", organizationId),
            DiagnosticField.Id("fingerprint", confirmedFingerprint),
            DiagnosticField.Path("rootPath", plan.RootAbsolutePath),
            DiagnosticField.Number("entryCount", plan.Nodes.Count),
            DiagnosticField.Number("copyCount", plan.Nodes.Count(n => n.ProposedAction == CopyDesignAction.Copy)));
    }

    /// <summary>The orchestrator's phase observer, writing one step event
    ///  per boundary.</summary>
    public static ICopyDesignApplyProgress Progress(DiagnosticsAttempt attempt) => new ProgressAdapter(attempt);

    /// <summary>Entry outcomes, cleanup, then the single terminal event.</summary>
    public static void RecordResult(DiagnosticsAttempt attempt, CopyDesignApplyOperationResult result)
    {
        ArgumentNullException.ThrowIfNull(attempt);
        ArgumentNullException.ThrowIfNull(result);
        try
        {
            foreach (var entry in result.Entries ?? Array.Empty<CopyDesignApplyEntryOutcome>())
            {
                attempt.Step("entry",
                    DiagnosticField.Id("resultingCadDocumentId", entry.CadDocumentId),
                    DiagnosticField.Code("action", entry.Action.ToString()),
                    DiagnosticField.Path("destinationPath", entry.DestinationAbsolutePath),
                    DiagnosticField.Flag("physicallyCreated", entry.PhysicallyCreated),
                    DiagnosticField.Flag("verificationPassed", entry.VerificationPassed),
                    DiagnosticField.Code("materialization", entry.Materialization?.Outcome.ToString()),
                    DiagnosticField.Id("fileVersionId", entry.Materialization?.FileVersionId));
            }
            RecordCleanup(attempt, "destinations", result.Cleanup);
            RecordCleanup(attempt, "oldVersionsBackups", result.BackupCleanup);

            var fields = new[]
            {
                DiagnosticField.Code("outcome", result.Outcome.ToString()),
                DiagnosticField.Code("errorCode", result.Outcome == CopyDesignApplyOutcome.Succeeded ? null : result.Outcome.ToString()),
                DiagnosticField.Code("phase", PhaseOf(result.Outcome)),
                DiagnosticField.Id("operationId", result.CopyDesignOperationId),
                DiagnosticField.Id("idempotencyKey", result.IdempotencyKey),
                DiagnosticField.Flag("reservedButUnmaterialized", result.ReservedButUnmaterialized),
            };
            switch (Classify(result.Outcome))
            {
                case DiagnosticOutcome.Succeeded: attempt.Succeeded(fields); break;
                case DiagnosticOutcome.Refused: attempt.Refused(fields); break;
                default: attempt.Failed(fields); break;
            }
        }
        catch
        {
            // best-effort
        }
    }

    /// <summary>Only a full success is a success; the in-process guard's
    ///  refusal is a refusal; everything else - including materialization
    ///  gaps - is a failure the log must not hide.</summary>
    public static DiagnosticOutcome Classify(CopyDesignApplyOutcome outcome) => outcome switch
    {
        CopyDesignApplyOutcome.Succeeded => DiagnosticOutcome.Succeeded,
        CopyDesignApplyOutcome.AlreadyRunning => DiagnosticOutcome.Refused,
        _ => DiagnosticOutcome.Failed,
    };

    /// <summary>The orchestrator phase an outcome ends in - named like the
    ///  progress steps, so a log reads start to finish in one vocabulary.</summary>
    public static string PhaseOf(CopyDesignApplyOutcome outcome) => outcome switch
    {
        CopyDesignApplyOutcome.AlreadyRunning => "start",
        CopyDesignApplyOutcome.MappingFailed => "mapping",
        CopyDesignApplyOutcome.DrawingsPresentWithoutAcknowledgement => "mapping",
        CopyDesignApplyOutcome.RevalidationFailed => "revalidation",
        CopyDesignApplyOutcome.ReservationCallFailed => "reservation",
        CopyDesignApplyOutcome.ReservationResponseInvalid => "reservation.validation",
        CopyDesignApplyOutcome.UnexpectedMaterializationState => "resume.status",
        CopyDesignApplyOutcome.PhysicalCopyFailed => "models.copy",
        CopyDesignApplyOutcome.ReferenceRewiringFailed => "models.rewire",
        CopyDesignApplyOutcome.VerificationFailed => "models.verify",
        CopyDesignApplyOutcome.DrawingPhysicalCopyFailed => "drawings.copy",
        CopyDesignApplyOutcome.DrawingReferenceRewiringFailed => "drawings.rewire",
        CopyDesignApplyOutcome.DrawingVerificationFailed => "drawings.verify",
        CopyDesignApplyOutcome.SourceIntegrityViolation => "drawings.integrity",
        CopyDesignApplyOutcome.SucceededWithMaterializationGaps => "materialize",
        CopyDesignApplyOutcome.Succeeded => "complete",
        _ => "unknown",
    };

    private static void RecordCleanup(DiagnosticsAttempt attempt, string source, CopyDesignCleanupReport? report)
    {
        if (report is null) return;
        var outcomes = report.Outcomes ?? Array.Empty<CopyDesignCleanupOutcome>();
        attempt.Cleanup(
            DiagnosticField.Code("source", source),
            DiagnosticField.Number("removed", outcomes.Count(o => o.Deleted)),
            DiagnosticField.Number("failed", outcomes.Count(o => !o.Deleted)));
        foreach (var failure in outcomes.Where(o => !o.Deleted))
        {
            // Which file was left behind - never the failure text.
            attempt.Cleanup(
                DiagnosticField.Code("source", source),
                DiagnosticField.Code("errorCode", "cleanup-not-removed"),
                DiagnosticField.Path("path", failure.AbsolutePath));
        }
    }

    private sealed class ProgressAdapter(DiagnosticsAttempt attempt) : ICopyDesignApplyProgress
    {
        public void Report(CopyDesignApplyProgressEvent progress) =>
            attempt.Step(progress.Step,
                DiagnosticField.Id("operationId", progress.OperationId),
                DiagnosticField.Id("resultingCadDocumentId", progress.CadDocumentId),
                DiagnosticField.Code("outcome", progress.Detail));
    }
}

/// <summary>
/// M4.2: refusal events - each is an attempt of its own with a single
/// Refused event. Workspace-origin refusals record the verdict and both
/// origins; session-binding refusals record which server the attempt was
/// bound to and which one is current; other up-front refusals record a fixed
/// error code. Never the user-facing message.
/// </summary>
public static class RefusalDiagnostics
{
    public const string WorkspaceOriginOperation = "refusal.workspace-origin";
    public const string SessionBindingOperation = "refusal.session-binding";
    public const string CommandOperation = "refusal.command";

    public const string NotSignedIn = "not-signed-in";
    public const string AlreadyRunning = "copy-design-already-running";

    public static void WorkspaceOrigin(IDiagnosticsSink? sink, string command, WorkspaceServerBindingResult binding, string source = "controller") =>
        WorkspaceOrigin(sink, command, binding, source, TimeProvider.System);

    public static void WorkspaceOrigin(IDiagnosticsSink? sink, string command, WorkspaceServerBindingResult binding, string source, TimeProvider time)
    {
        if (binding is null || binding.Allowed) return;
        DiagnosticsAttempt.Refuse(sink, WorkspaceOriginOperation, time,
            DiagnosticField.Code("command", command),
            DiagnosticField.Code("verdict", binding.Verdict.ToString()),
            DiagnosticField.Path("workspaceRoot", binding.WorkspaceRoot),
            DiagnosticField.Origin("workspaceServerOrigin", binding.WorkspaceServerOrigin),
            DiagnosticField.Origin("connectedServerOrigin", binding.ConnectedServerOrigin),
            DiagnosticField.Code("source", source));
    }

    public static void SessionBinding(IDiagnosticsSink? sink, string command, string? boundServerOrigin, string? currentServerOrigin) =>
        SessionBinding(sink, command, boundServerOrigin, currentServerOrigin, TimeProvider.System);

    public static void SessionBinding(IDiagnosticsSink? sink, string command, string? boundServerOrigin, string? currentServerOrigin, TimeProvider time) =>
        DiagnosticsAttempt.Refuse(sink, SessionBindingOperation, time,
            DiagnosticField.Code("command", command),
            DiagnosticField.Code("errorCode", "session-changed"),
            DiagnosticField.Origin("boundServerOrigin", boundServerOrigin),
            DiagnosticField.Origin("currentServerOrigin", currentServerOrigin),
            DiagnosticField.Code("source", "connection-manager"));

    /// <summary>Any other up-front refusal of a command (see the error code
    ///  constants above).</summary>
    public static void Command(IDiagnosticsSink? sink, string command, string errorCode) =>
        DiagnosticsAttempt.Refuse(sink, CommandOperation,
            DiagnosticField.Code("command", command),
            DiagnosticField.Code("errorCode", errorCode));
}
