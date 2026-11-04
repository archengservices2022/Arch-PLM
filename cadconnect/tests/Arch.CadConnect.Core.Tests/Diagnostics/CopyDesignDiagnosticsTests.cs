using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.CopyDesign.Apply;
using Arch.CadConnect.Core.Diagnostics;
using Arch.CadConnect.Core.Session;
using Arch.CadConnect.Core.Tests.CopyDesign.Apply;
using Arch.CadConnect.Core.Workspace;

using static Arch.CadConnect.Core.Tests.CopyDesign.Apply.CopyDesignApplyFixtures;

namespace Arch.CadConnect.Core.Tests.Diagnostics;

/// <summary>
/// M4.2: Copy Design attempt logging - exactly one terminal event per
/// attempt, correctly classified for EVERY <see cref="CopyDesignApplyOutcome"/>;
/// entry outcomes and cleanup; the orchestrator's phase observer (with
/// fakes), which can never change the result; and refusal events.
/// </summary>
public class CopyDesignDiagnosticsTests
{
    private static readonly FixedTime Time = new(new DateTimeOffset(2026, 10, 28, 12, 0, 0, TimeSpan.Zero));

    private static DiagnosticsAttempt Attempt(RecordingSink sink) =>
        CopyDesignDiagnostics.Start(sink, "Apply", Plan(Array.Empty<CopyDesignNode>()), "key-1",
            "http://localhost:3100", "user-1", "org-1", "fp-1", Time);

    private static bool IsTerminal(DiagnosticEvent e) =>
        e.Outcome is DiagnosticOutcome.Succeeded or DiagnosticOutcome.Failed or DiagnosticOutcome.Refused;

    // ---- classification -------------------------------------------------------

    public static TheoryData<CopyDesignApplyOutcome> AllOutcomes()
    {
        var data = new TheoryData<CopyDesignApplyOutcome>();
        foreach (var o in Enum.GetValues<CopyDesignApplyOutcome>()) data.Add(o);
        return data;
    }

    [Theory]
    [MemberData(nameof(AllOutcomes))]
    public void Every_outcome_produces_exactly_one_correctly_classified_terminal_event(CopyDesignApplyOutcome outcome)
    {
        var sink = new RecordingSink();
        var attempt = Attempt(sink);
        var result = new CopyDesignApplyOperationResult(outcome, outcome == CopyDesignApplyOutcome.Succeeded ? null : "why",
            "op-7", Array.Empty<CopyDesignApplyEntryOutcome>(), null, "key-1");

        CopyDesignDiagnostics.RecordResult(attempt, result);

        var terminal = Assert.Single(sink.Events, IsTerminal);
        var expected = outcome switch
        {
            CopyDesignApplyOutcome.Succeeded => DiagnosticOutcome.Succeeded,
            CopyDesignApplyOutcome.AlreadyRunning => DiagnosticOutcome.Refused,
            _ => DiagnosticOutcome.Failed,
        };
        Assert.Equal(expected, terminal.Outcome);
        Assert.Equal(outcome.ToString(), sink.Field(terminal, "outcome"));
        Assert.Equal("op-7", sink.Field(terminal, "operationId"));
        Assert.Equal("key-1", sink.Field(terminal, "idempotencyKey"));
        Assert.Equal(CopyDesignDiagnostics.PhaseOf(outcome), sink.Field(terminal, "phase"));
        Assert.Equal(outcome == CopyDesignApplyOutcome.Succeeded ? null : outcome.ToString(), sink.Field(terminal, "errorCode"));
        Assert.Same(terminal, sink.Events.Last());     // nothing after the terminal event
    }

    [Fact]
    public void Materialization_gaps_are_a_failure_not_a_success()
    {
        Assert.Equal(DiagnosticOutcome.Failed, CopyDesignDiagnostics.Classify(CopyDesignApplyOutcome.SucceededWithMaterializationGaps));
    }

    // ---- start, entries and cleanup ------------------------------------------------

    [Fact]
    public void The_start_event_names_kind_key_server_user_and_plan_shape()
    {
        var sink = new RecordingSink();
        var plan = Plan(new[]
        {
            CopyNode("a", @"C:\src\a.iam", @"C:\dst\a.iam", CadDocumentType.Iam, isRoot: true),
            CopyNode("b", @"C:\src\b.ipt", @"C:\dst\b.ipt"),
            ReuseNode("c", @"C:\lib\c.ipt"),
        });

        var attempt = CopyDesignDiagnostics.Start(sink, "Resume", plan, "key-9", "http://localhost:3100", "user-1", "org-1", null, Time);

        var start = Assert.Single(sink.Events);
        Assert.Equal(DiagnosticOutcome.Started, start.Outcome);
        Assert.Equal(CopyDesignDiagnostics.ResumeOperation, attempt.Operation);
        Assert.Equal("Resume", sink.Field(start, "attemptKind"));
        Assert.Equal("key-9", sink.Field(start, "idempotencyKey"));
        Assert.Equal("http://localhost:3100", sink.Field(start, "serverOrigin"));
        Assert.Equal("user-1", sink.Field(start, "userId"));
        Assert.Equal(3L, sink.Field(start, "entryCount"));
        Assert.Equal(2L, sink.Field(start, "copyCount"));
        Assert.Equal(@"C:\root\root.iam", sink.Field(start, "rootPath"));
    }

    [Theory]
    [InlineData("Apply", CopyDesignDiagnostics.ApplyOperation)]
    [InlineData("Fresh", CopyDesignDiagnostics.ApplyOperation)]
    [InlineData("Resume", CopyDesignDiagnostics.ResumeOperation)]
    [InlineData("Recover", CopyDesignDiagnostics.RecoverOperation)]
    public void Each_attempt_kind_has_its_own_operation_name(string kind, string operation)
    {
        Assert.Equal(operation, CopyDesignDiagnostics.OperationFor(kind));
    }

    [Fact]
    public void Entry_outcomes_and_cleanup_are_recorded_before_the_terminal_event()
    {
        var sink = new RecordingSink();
        var attempt = Attempt(sink);
        var result = new CopyDesignApplyOperationResult(
            CopyDesignApplyOutcome.VerificationFailed, "verification failed for b.ipt", "op-1",
            new[]
            {
                new CopyDesignApplyEntryOutcome("res-a", CopyDesignApplyEntryAction.Copy, @"C:\dst\a.iam", true, true,
                    new CopyDesignMaterializationResult("res-a", CopyDesignMaterializationOutcome.Materialized, "fv-1", 1, "sha", 10, "ok")),
                new CopyDesignApplyEntryOutcome("res-b", CopyDesignApplyEntryAction.Copy, @"C:\dst\b.ipt", true, false, null),
            },
            new CopyDesignCleanupReport(new[]
            {
                new CopyDesignCleanupOutcome(@"C:\dst\b.ipt", true, null),
                new CopyDesignCleanupOutcome(@"C:\dst\a.iam", false, "locked by Inventor"),
            }),
            "key-1");

        CopyDesignDiagnostics.RecordResult(attempt, result);

        var entries = sink.Events.Where(e => e.Outcome == DiagnosticOutcome.Step && (string?)sink.Field(e, "step") == "entry").ToArray();
        Assert.Equal(2, entries.Length);
        Assert.Equal("Materialized", sink.Field(entries[0], "materialization"));
        Assert.Equal("fv-1", sink.Field(entries[0], "fileVersionId"));
        Assert.Equal(false, sink.Field(entries[1], "verificationPassed"));
        var cleanup = sink.Events.Where(e => e.Outcome == DiagnosticOutcome.Cleanup).ToArray();
        Assert.Equal(1L, sink.Field(cleanup[0], "removed"));
        Assert.Equal(1L, sink.Field(cleanup[0], "failed"));
        Assert.Equal(@"C:\dst\a.iam", sink.Field(cleanup[1], "path"));
        Assert.Equal("cleanup-not-removed", sink.Field(cleanup[1], "errorCode"));
        var terminal = sink.Events.Last();
        Assert.Equal(DiagnosticOutcome.Failed, terminal.Outcome);
        Assert.Equal("VerificationFailed", sink.Field(terminal, "errorCode"));
        Assert.Equal("models.verify", sink.Field(terminal, "phase"));
        Assert.Equal(true, sink.Field(terminal, "reservedButUnmaterialized"));
    }

    [Fact]
    public void No_free_form_reason_or_message_text_is_ever_recorded()
    {
        const string serverText = "Server said: engineer@example.com may not do this (HTTP 409) at C:\\Users\\Someone\\x";
        var sink = new RecordingSink();
        var attempt = Attempt(sink);
        var result = new CopyDesignApplyOperationResult(
            CopyDesignApplyOutcome.ReservationCallFailed, serverText, null,
            new[]
            {
                new CopyDesignApplyEntryOutcome("res-a", CopyDesignApplyEntryAction.Copy, @"C:\dst\a.ipt", true, true,
                    new CopyDesignMaterializationResult("res-a", CopyDesignMaterializationOutcome.Failed, null, null, null, null, serverText)),
            },
            new CopyDesignCleanupReport(new[] { new CopyDesignCleanupOutcome(@"C:\dst\a.ipt", false, serverText) }),
            "key-1");

        CopyDesignDiagnostics.RecordResult(attempt, result);

        Assert.All(sink.Events, e =>
        {
            Assert.DoesNotContain(e.Fields, f => f.Name == "reason");
            Assert.DoesNotContain(e.Fields, f => f.Value is string s && (s.Contains("Server said") || s.Contains("HTTP 409")));
            Assert.All(e.Fields, f => Assert.NotEqual(DiagnosticFieldKind.Text, f.Kind));   // only codes, ids, paths, numbers, flags
        });
        Assert.DoesNotContain("reason", DiagnosticFieldAllowList.Names);
    }

    [Theory]
    [MemberData(nameof(AllOutcomes))]
    public void Every_outcome_names_a_known_phase(CopyDesignApplyOutcome outcome)
    {
        Assert.NotEqual("unknown", CopyDesignDiagnostics.PhaseOf(outcome));
        Assert.Equal(CopyDesignDiagnostics.PhaseOf(outcome), Core.Diagnostics.DiagnosticValueSanitizer.SanitizeCode(CopyDesignDiagnostics.PhaseOf(outcome)));
    }

    [Fact]
    public void Recording_into_a_throwing_sink_never_throws()
    {
        var attempt = CopyDesignDiagnostics.Start(new ThrowingSink(), "Apply", Plan(Array.Empty<CopyDesignNode>()), "k",
            "http://localhost:3100", null, null, null, Time);

        CopyDesignDiagnostics.RecordResult(attempt, CopyDesignApplyOperationResult.Simple(CopyDesignApplyOutcome.MappingFailed, "x"));
        CopyDesignDiagnostics.Progress(attempt).Report(new CopyDesignApplyProgressEvent("models.copy"));
    }

    // ---- the orchestrator's phase observer, with fakes ---------------------------------

    private static (OrchestratorHarness Harness, CopyDesignPlan Plan) HappyPath()
    {
        var h = new OrchestratorHarness();
        var child = CopyNode("cad-child", @"C:\src\child.ipt", @"C:\dst\child-new.ipt");
        var parent = CopyNode("cad-parent", @"C:\src\parent.iam", @"C:\dst\parent-new.iam", CadDocumentType.Iam, isRoot: true);
        var plan = Plan(new[] { parent, child }, new[] { ComponentEdge(parent, child, childIsCopy: true) });
        h.ExistingSources.Add(parent.SourceAbsolutePath);
        h.ExistingSources.Add(child.SourceAbsolutePath);
        return (h, plan);
    }

    [Fact]
    public async Task A_successful_apply_reports_every_phase_boundary_in_order()
    {
        var sink = new RecordingSink();
        var attempt = Attempt(sink);
        var (h, plan) = HappyPath();
        h.Progress = CopyDesignDiagnostics.Progress(attempt);

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);
        CopyDesignDiagnostics.RecordResult(attempt, result);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        var steps = sink.Events.Where(e => e.Outcome == DiagnosticOutcome.Step).Select(e => (string?)sink.Field(e, "step")).ToArray();
        Assert.Equal(
            new[] { "mapped", "reservation.sent", "reservation.validated", "models.copy", "models.rewire", "models.verify", "materialize", "materialize", "entry", "entry" },
            steps);
        var validated = sink.Events.Single(e => (string?)sink.Field(e, "step") == "reservation.validated");
        Assert.Equal("op-1", sink.Field(validated, "operationId"));
        Assert.Equal(DiagnosticOutcome.Succeeded, sink.Events.Last().Outcome);
    }

    [Fact]
    public async Task A_failed_reservation_reports_the_failure_and_never_a_validated_reservation()
    {
        var sink = new RecordingSink();
        var attempt = Attempt(sink);
        var (h, plan) = HappyPath();
        h.Reservation.ThrowForCall = _ => new IOException("connection reset");
        h.Progress = CopyDesignDiagnostics.Progress(attempt);

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);
        CopyDesignDiagnostics.RecordResult(attempt, result);

        Assert.Equal(CopyDesignApplyOutcome.ReservationCallFailed, result.Outcome);
        var steps = sink.Events.Where(e => e.Outcome == DiagnosticOutcome.Step).Select(e => (string?)sink.Field(e, "step")).ToArray();
        Assert.Equal(new[] { "mapped", "reservation.sent", "reservation.failed" }, steps);
        Assert.Equal(DiagnosticOutcome.Failed, sink.Events.Last().Outcome);
        Assert.Equal("key-1", sink.Field(sink.Events.Last(), "idempotencyKey"));
    }

    private sealed class ExplodingProgress : ICopyDesignApplyProgress
    {
        public int Calls { get; private set; }

        public void Report(CopyDesignApplyProgressEvent progress)
        {
            Calls++;
            throw new InvalidOperationException("observer bug");
        }
    }

    [Fact]
    public async Task A_throwing_observer_changes_nothing_about_the_attempt()
    {
        var (plain, plan) = HappyPath();
        var expected = await plain.Build().ExecuteAsync(plan, "key-1", null);

        var (observed, samePlan) = HappyPath();
        var exploding = new ExplodingProgress();
        observed.Progress = exploding;
        var actual = await observed.Build().ExecuteAsync(samePlan, "key-1", null);

        Assert.True(exploding.Calls > 0);
        Assert.Equal(expected.Outcome, actual.Outcome);
        Assert.Equal(expected.CopyDesignOperationId, actual.CopyDesignOperationId);
        Assert.Equal(expected.Entries.Select(e => (e.CadDocumentId, e.PhysicallyCreated, e.VerificationPassed, e.Materialization?.Outcome)),
            actual.Entries.Select(e => (e.CadDocumentId, e.PhysicallyCreated, e.VerificationPassed, e.Materialization?.Outcome)));
        Assert.Equal(plain.Materializer.Calls.Count, observed.Materializer.Calls.Count);
    }

    // ---- refusals ---------------------------------------------------------------

    [Fact]
    public void A_workspace_origin_refusal_records_the_verdict_and_both_origins()
    {
        var sink = new RecordingSink();
        var binding = WorkspaceServerBinding.Evaluate("http://localhost:3000", ArchServerUri.Parse("http://localhost:3100"), @"D:\ws");

        RefusalDiagnostics.WorkspaceOrigin(sink, "Checkout", binding, "controller", Time);

        var e = Assert.Single(sink.Events);
        Assert.Equal(DiagnosticOutcome.Refused, e.Outcome);
        Assert.Equal(RefusalDiagnostics.WorkspaceOriginOperation, e.Operation);
        Assert.Equal("Checkout", sink.Field(e, "command"));
        Assert.Equal("DifferentServer", sink.Field(e, "verdict"));
        Assert.Equal("http://localhost:3000", sink.Field(e, "workspaceServerOrigin"));
        Assert.Equal("http://localhost:3100", sink.Field(e, "connectedServerOrigin"));
        Assert.Equal(@"D:\ws", sink.Field(e, "workspaceRoot"));
    }

    [Fact]
    public void An_allowed_binding_logs_nothing()
    {
        var sink = new RecordingSink();
        var allowed = WorkspaceServerBinding.Evaluate("http://localhost:3100", ArchServerUri.Parse("http://localhost:3100"), @"D:\ws");

        RefusalDiagnostics.WorkspaceOrigin(sink, "Checkout", allowed, "controller", Time);

        Assert.Empty(sink.Events);
    }

    [Fact]
    public void A_session_binding_refusal_records_the_bound_and_current_servers()
    {
        var sink = new RecordingSink();

        RefusalDiagnostics.SessionBinding(sink, "ApplyCopyDesignAsync", "http://localhost:3100", "http://localhost:3000", Time);

        var e = Assert.Single(sink.Events);
        Assert.Equal(RefusalDiagnostics.SessionBindingOperation, e.Operation);
        Assert.Equal(DiagnosticOutcome.Refused, e.Outcome);
        Assert.Equal("ApplyCopyDesignAsync", sink.Field(e, "command"));
        Assert.Equal("http://localhost:3100", sink.Field(e, "boundServerOrigin"));
        Assert.Equal("http://localhost:3000", sink.Field(e, "currentServerOrigin"));
        Assert.Equal("session-changed", sink.Field(e, "errorCode"));
    }

    [Theory]
    [InlineData(RefusalDiagnostics.NotSignedIn)]
    [InlineData(RefusalDiagnostics.AlreadyRunning)]
    public void A_command_refusal_records_a_fixed_error_code(string errorCode)
    {
        var sink = new RecordingSink();

        RefusalDiagnostics.Command(sink, "Apply Copy Design", errorCode);

        var e = Assert.Single(sink.Events);
        Assert.Equal(errorCode, sink.Field(e, "errorCode"));
        Assert.Equal(errorCode, DiagnosticValueSanitizer.SanitizeCode(errorCode));
        Assert.All(e.Fields, f => Assert.Equal(DiagnosticFieldKind.Code, f.Kind));
    }
}
