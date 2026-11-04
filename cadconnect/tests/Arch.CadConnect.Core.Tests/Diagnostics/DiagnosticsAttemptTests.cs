using Arch.CadConnect.Core.Diagnostics;

namespace Arch.CadConnect.Core.Tests.Diagnostics;

/// <summary>M4.2: an attempt's event sequence, and its isolation from sink
///  failures - logging can never throw into, or change, the operation.</summary>
public class DiagnosticsAttemptTests
{
    private readonly FixedTime _time = new(new DateTimeOffset(2026, 10, 28, 12, 0, 0, TimeSpan.Zero));

    [Fact]
    public void An_attempt_writes_started_then_its_events_in_order_under_one_id()
    {
        var sink = new RecordingSink();

        var attempt = DiagnosticsAttempt.Start(sink, "pdm.checkout", _time, DiagnosticField.Text("command", "Checkout"));
        attempt.Step("reservation.sent");
        attempt.Cleanup(DiagnosticField.Number("removed", 1));
        attempt.Succeeded();

        Assert.Equal(new[] { DiagnosticOutcome.Started, DiagnosticOutcome.Step, DiagnosticOutcome.Cleanup, DiagnosticOutcome.Succeeded },
            sink.Events.Select(e => e.Outcome));
        Assert.Equal(new[] { 1, 2, 3, 4 }, sink.Events.Select(e => e.Sequence));
        Assert.All(sink.Events, e => Assert.Equal(attempt.AttemptId, e.AttemptId));
        Assert.All(sink.Events, e => Assert.Equal("pdm.checkout", e.Operation));
        Assert.Equal("reservation.sent", sink.Field(sink.Events[1], "step"));
        Assert.Matches("^[0-9a-f]{32}$", attempt.AttemptId);
    }

    [Fact]
    public void A_refusal_is_a_single_event_attempt()
    {
        var sink = new RecordingSink();

        DiagnosticsAttempt.Refuse(sink, "refusal.workspace-origin", _time, DiagnosticField.Text("command", "Checkout"));

        var e = Assert.Single(sink.Events);
        Assert.Equal(DiagnosticOutcome.Refused, e.Outcome);
        Assert.Equal(1, e.Sequence);
    }

    [Fact]
    public void A_failure_records_only_the_exception_type_never_its_message()
    {
        var sink = new RecordingSink();
        var attempt = DiagnosticsAttempt.Start(sink, "pdm.check-in", _time);

        attempt.Failed(new InvalidOperationException("Bearer arch_dt_SECRET engineer@example.com"));

        var e = sink.Events.Last();
        Assert.Equal(DiagnosticOutcome.Failed, e.Outcome);
        Assert.Equal("InvalidOperationException", sink.Field(e, "exceptionType"));
        Assert.DoesNotContain(e.Fields, f => (f.Value as string)?.Contains("SECRET") == true);
    }

    [Fact]
    public void A_throwing_sink_never_reaches_the_caller()
    {
        var sink = new ThrowingSink();

        var attempt = DiagnosticsAttempt.Start(sink, "copydesign.apply", _time);
        attempt.Step("models.copy");
        attempt.Failed(new Exception("x"));
        attempt.Cleanup();
        attempt.Succeeded();
        DiagnosticsAttempt.Refuse(sink, "refusal.command", _time);

        Assert.Equal(6, sink.Calls);
    }

    [Fact]
    public void A_null_sink_is_allowed()
    {
        var attempt = DiagnosticsAttempt.Start(null, "pdm.checkout");
        attempt.Succeeded();
        DiagnosticsAttempt.Refuse(null, "refusal.command");
    }
}
