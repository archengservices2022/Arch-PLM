using Arch.CadConnect.Api;
using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Diagnostics;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests;

/// <summary>
/// M4.2: Get Latest, Checkout, Check In and Undo Checkout logging - one
/// started and one terminal event per command, the terminal event
/// classified from the result, and a thrown failure recorded by exception
/// TYPE and API failure kind only.
/// </summary>
public class PdmDiagnosticsTests
{
    private sealed class Sink : IDiagnosticsSink
    {
        public List<DiagnosticEvent> Events { get; } = new();

        public void Write(DiagnosticEvent diagnosticEvent) => Events.Add(diagnosticEvent);

        public object? Field(DiagnosticEvent e, string name) => e.Fields.FirstOrDefault(f => f.Name == name).Value;
    }

    private static readonly ManagedFileRef File = ManagedFileRef.Create(@"D:\ws", @"D:\ws\A.ipt");

    private static (Sink Sink, DiagnosticsAttempt Attempt) Start(string operation)
    {
        var sink = new Sink();
        return (sink, PdmDiagnostics.StartFileCommand(sink, operation, File, "http://localhost:3100", "user-1", TimeProvider.System));
    }

    [Fact]
    public void A_file_command_starts_with_its_workspace_file_server_and_user_id()
    {
        var (sink, attempt) = Start(PdmDiagnostics.CheckoutOperation);

        var e = Assert.Single(sink.Events);
        Assert.Equal(DiagnosticOutcome.Started, e.Outcome);
        Assert.Equal("pdm.checkout", attempt.Operation);
        Assert.Equal(@"D:\ws", sink.Field(e, "workspaceRoot"));
        Assert.Equal(@"D:\ws\A.ipt", sink.Field(e, "path"));
        Assert.Equal("http://localhost:3100", sink.Field(e, "serverOrigin"));
        Assert.Equal("user-1", sink.Field(e, "userId"));
    }

    [Theory]
    [InlineData(false, DiagnosticOutcome.Succeeded)]
    [InlineData(true, DiagnosticOutcome.Failed)]
    public void Checkout_succeeds_unless_it_needs_reconciling(bool reconcileNeeded, DiagnosticOutcome expected)
    {
        var (sink, attempt) = Start(PdmDiagnostics.CheckoutOperation);

        PdmDiagnostics.RecordCheckout(attempt, new CheckoutOperationResult("cad-1", "fv-1", 1, true, true, reconcileNeeded, "msg"));

        var e = sink.Events.Last();
        Assert.Equal(expected, e.Outcome);
        Assert.Equal("cad-1", sink.Field(e, "cadDocumentId"));
        Assert.Equal(reconcileNeeded, sink.Field(e, "reconcileNeeded"));
    }

    [Theory]
    [InlineData(true, DiagnosticOutcome.Succeeded)]
    [InlineData(false, DiagnosticOutcome.Failed)]
    public void Check_in_succeeds_only_when_verified(bool verified, DiagnosticOutcome expected)
    {
        var (sink, attempt) = Start(PdmDiagnostics.CheckInOperation);

        PdmDiagnostics.RecordCheckIn(attempt, new CheckInOperationResult(verified, "fv-2", 2, "msg"));

        Assert.Equal(expected, sink.Events.Last().Outcome);
        Assert.Equal(2L, sink.Field(sink.Events.Last(), "versionNumber"));
    }

    [Theory]
    [InlineData(true, DiagnosticOutcome.Succeeded)]
    [InlineData(false, DiagnosticOutcome.Failed)]
    public void Undo_succeeds_only_when_restored(bool restored, DiagnosticOutcome expected)
    {
        var (sink, attempt) = Start(PdmDiagnostics.UndoCheckoutOperation);

        PdmDiagnostics.RecordUndo(attempt, new UndoOperationResult(restored, 1, restored ? null : @"D:\ws\.arch\recovery\A.ipt", "msg"));

        Assert.Equal(expected, sink.Events.Last().Outcome);
    }

    [Theory]
    [InlineData(0, 0, DiagnosticOutcome.Succeeded)]
    [InlineData(1, 0, DiagnosticOutcome.Failed)]
    [InlineData(0, 1, DiagnosticOutcome.Failed)]
    public void Get_Latest_succeeds_only_with_nothing_blocked_or_failed(int blocked, int failed, DiagnosticOutcome expected)
    {
        var sink = new Sink();
        var request = new GetLatestRequest { Root = CadDocumentLookup.ByNumber("ARCH-TEST-001.ipt", "IPT"), WorkspaceRoot = @"D:\ws" };
        var attempt = PdmDiagnostics.StartGetLatest(sink, request, "http://localhost:3100", "user-1", TimeProvider.System);
        var results = new List<MaterializationEntryResult>();
        for (var i = 0; i < blocked; i++) results.Add(Entry(MaterializationStatus.Blocked));
        for (var i = 0; i < failed; i++) results.Add(Entry(MaterializationStatus.Failed));
        results.Add(Entry(MaterializationStatus.Downloaded));

        PdmDiagnostics.RecordGetLatest(attempt, new MaterializationReport
        {
            WorkspaceRoot = @"D:\ws",
            RootCadDocumentId = "cad-root",
            StartedAtUtc = DateTimeOffset.UnixEpoch,
            FinishedAtUtc = DateTimeOffset.UnixEpoch.AddSeconds(2),
            RequestedEntries = results.Count,
            Results = results,
        });

        Assert.Equal("ARCH-TEST-001.ipt", sink.Field(sink.Events[0], "documentNumber"));
        Assert.Equal("IPT", sink.Field(sink.Events[0], "documentType"));
        var e = sink.Events.Last();
        Assert.Equal(expected, e.Outcome);
        Assert.Equal((long)blocked, sink.Field(e, "blocked"));
        Assert.Equal((long)failed, sink.Field(e, "failed"));
        Assert.Equal(1L, sink.Field(e, "downloaded"));
        Assert.Equal(2000L, sink.Field(e, "durationMs"));
    }

    private static MaterializationEntryResult Entry(MaterializationStatus status) => new()
    {
        CadDocumentId = "cad-" + Guid.NewGuid().ToString("N"),
        FileVersionId = "fv",
        RelativePath = "a.ipt",
        Status = status,
    };

    [Fact]
    public void A_thrown_failure_records_its_type_and_api_kind_but_never_its_message()
    {
        var (sink, attempt) = Start(PdmDiagnostics.CheckInOperation);

        PdmDiagnostics.RecordException(attempt, new ArchApiException(ArchApiFailureKind.Conflict, "engineer.private@example.com holds Bearer arch_dt_SECRET"));

        var e = sink.Events.Last();
        Assert.Equal(DiagnosticOutcome.Failed, e.Outcome);
        Assert.Equal("ArchApiException", sink.Field(e, "exceptionType"));
        Assert.Equal("Conflict", sink.Field(e, "failureKind"));
        Assert.DoesNotContain(e.Fields, f => (f.Value as string)?.Contains("SECRET") == true || (f.Value as string)?.Contains("@") == true);
    }

    [Fact]
    public void A_non_api_failure_has_no_failure_kind()
    {
        var (sink, attempt) = Start(PdmDiagnostics.UndoCheckoutOperation);

        PdmDiagnostics.RecordException(attempt, new IOException("x"));

        Assert.Equal("IOException", sink.Field(sink.Events.Last(), "exceptionType"));
        Assert.Null(sink.Field(sink.Events.Last(), "failureKind"));
    }
}
