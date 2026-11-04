using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Diagnostics;
using Arch.CadConnect.Core.Session;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api;

/// <summary>
/// M4.2: what Get Latest, Checkout, Check In and Undo Checkout write to
/// their diagnostics logs - a start event (command, workspace, file, bound
/// server, internal user id) and exactly one terminal event built from the
/// result. A failure records only the exception's TYPE and, for an API
/// error, its failure kind - never its message.
/// </summary>
public static class PdmDiagnostics
{
    public const string GetLatestOperation = "pdm.get-latest";
    public const string CheckoutOperation = "pdm.checkout";
    public const string CheckInOperation = "pdm.check-in";
    public const string UndoCheckoutOperation = "pdm.undo-checkout";

    public static DiagnosticsAttempt StartFileCommand(IDiagnosticsSink? sink, string operation, ManagedFileRef file, IArchSession? session) =>
        StartFileCommand(sink, operation, file, session?.Server.OriginString, session?.Identity.UserId, TimeProvider.System);

    public static DiagnosticsAttempt StartFileCommand(
        IDiagnosticsSink? sink, string operation, ManagedFileRef file, string? serverOrigin, string? userId, TimeProvider time) =>
        DiagnosticsAttempt.Start(sink, operation, time,
            DiagnosticField.Path("workspaceRoot", file?.WorkspaceRoot),
            DiagnosticField.Path("path", file?.AbsoluteFilePath),
            DiagnosticField.Origin("serverOrigin", serverOrigin),
            DiagnosticField.Id("userId", userId));

    public static DiagnosticsAttempt StartGetLatest(IDiagnosticsSink? sink, GetLatestRequest request, IArchSession? session) =>
        StartGetLatest(sink, request, session?.Server.OriginString, session?.Identity.UserId, TimeProvider.System);

    public static DiagnosticsAttempt StartGetLatest(
        IDiagnosticsSink? sink, GetLatestRequest request, string? serverOrigin, string? userId, TimeProvider time) =>
        DiagnosticsAttempt.Start(sink, GetLatestOperation, time,
            DiagnosticField.Path("workspaceRoot", request?.WorkspaceRoot),
            DiagnosticField.Text("documentNumber", request?.Root.Value),
            DiagnosticField.Code("documentType", request?.Root.DocumentType),
            DiagnosticField.Origin("serverOrigin", serverOrigin),
            DiagnosticField.Id("userId", userId));

    public static void RecordGetLatest(DiagnosticsAttempt attempt, MaterializationReport report)
    {
        try
        {
            var s = report.Summary;
            var fields = new[]
            {
                DiagnosticField.Id("rootCadDocumentId", report.RootCadDocumentId),
                DiagnosticField.Number("requested", report.RequestedEntries),
                DiagnosticField.Number("downloaded", s.Downloaded),
                DiagnosticField.Number("alreadyCurrent", s.AlreadyCurrent),
                DiagnosticField.Number("blocked", s.Blocked),
                DiagnosticField.Number("failed", s.Failed),
                DiagnosticField.Number("retainedRecoveryCopies", report.Results.Count(r => r.RetainedRecoveryCopy is not null)),
                DiagnosticField.Number("retainedManifestArtifacts", report.RetainedManifestArtifact is null ? 0 : 1),
                DiagnosticField.Number("durationMs", (long)(report.FinishedAtUtc - report.StartedAtUtc).TotalMilliseconds),
            };
            if (report.ReachedValidState) attempt.Succeeded(fields); else attempt.Failed(fields);
        }
        catch
        {
            // best-effort
        }
    }

    public static void RecordCheckout(DiagnosticsAttempt attempt, CheckoutOperationResult result)
    {
        try
        {
            var fields = new[]
            {
                DiagnosticField.Id("cadDocumentId", result.CadDocumentId),
                DiagnosticField.Id("fileVersionId", result.BaseFileVersionId),
                DiagnosticField.Number("versionNumber", result.BaseVersionNumber),
                DiagnosticField.Flag("madeWritable", result.MadeWritable),
                DiagnosticField.Flag("manifestUpdated", result.ManifestUpdated),
                DiagnosticField.Flag("reconcileNeeded", result.ReconcileNeeded),
            };
            if (result.ReconcileNeeded) attempt.Failed(fields); else attempt.Succeeded(fields);
        }
        catch
        {
            // best-effort
        }
    }

    public static void RecordCheckIn(DiagnosticsAttempt attempt, CheckInOperationResult result)
    {
        try
        {
            var fields = new[]
            {
                DiagnosticField.Flag("verified", result.Verified),
                DiagnosticField.Id("fileVersionId", result.NewFileVersionId),
                DiagnosticField.Number("versionNumber", result.NewVersionNumber),
                DiagnosticField.Flag("manifestUpdated", result.ManifestUpdated),
                DiagnosticField.Flag("madeControlled", result.MadeControlled),
            };
            if (result.Verified) attempt.Succeeded(fields); else attempt.Failed(fields);
        }
        catch
        {
            // best-effort
        }
    }

    public static void RecordUndo(DiagnosticsAttempt attempt, UndoOperationResult result)
    {
        try
        {
            var fields = new[]
            {
                DiagnosticField.Flag("restored", result.Restored),
                DiagnosticField.Number("versionNumber", result.RestoredToVersionNumber),
                DiagnosticField.Path("recoveryPath", result.RecoveryFilePath),
                DiagnosticField.Flag("manifestUpdated", result.ManifestReconciled),
            };
            if (result.Restored) attempt.Succeeded(fields); else attempt.Failed(fields);
        }
        catch
        {
            // best-effort
        }
    }

    /// <summary>The operation threw: the exception type and, for an API
    ///  error, its failure kind. Never the message.</summary>
    public static void RecordException(DiagnosticsAttempt attempt, Exception exception)
    {
        try
        {
            var workspace = exception as Core.Workspace.WorkspaceRootException;
            attempt.Failed(exception,
                DiagnosticField.Code("failureKind", (exception as ArchApiException)?.Kind.ToString()),
                DiagnosticField.Number("retainedRecoveryCopies", workspace?.RetainedRecoveryCopies),
                DiagnosticField.Number("retainedManifestArtifacts", workspace?.RetainedManifestArtifacts));
        }
        catch
        {
            // best-effort
        }
    }
}
