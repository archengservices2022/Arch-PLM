namespace Arch.CadConnect.Core.Diagnostics;

/// <summary>
/// M4.2: one logged attempt (one command invocation) - an attempt id, an
/// operation name and an ordered event sequence, written to one log file by
/// <see cref="JsonLinesDiagnosticsSink"/>.
///
/// BEST-EFFORT AND ISOLATED: every method swallows every exception (from the
/// sink or anywhere else), so logging can never change, delay or fail the
/// operation it describes. The log is diagnostic only - nothing ever reads it
/// back to decide or recover anything (that is M4.3's journal, not this).
/// </summary>
public sealed class DiagnosticsAttempt
{
    private readonly IDiagnosticsSink _sink;
    private readonly TimeProvider _time;
    private int _sequence;

    private DiagnosticsAttempt(IDiagnosticsSink sink, string operation, TimeProvider time, string attemptId)
    {
        _sink = sink;
        _time = time;
        Operation = operation;
        AttemptId = attemptId;
        StartedUtc = time.GetUtcNow();
    }

    public string Operation { get; }

    public string AttemptId { get; }

    public DateTimeOffset StartedUtc { get; }

    /// <summary>Begin an attempt and write its <see cref="DiagnosticOutcome.Started"/>
    ///  event.</summary>
    public static DiagnosticsAttempt Start(IDiagnosticsSink? sink, string operation, params DiagnosticField[] fields) =>
        Start(sink, operation, TimeProvider.System, fields);

    public static DiagnosticsAttempt Start(IDiagnosticsSink? sink, string operation, TimeProvider time, params DiagnosticField[] fields)
    {
        var attempt = Create(sink, operation, time);
        attempt.Write(DiagnosticOutcome.Started, fields);
        return attempt;
    }

    /// <summary>A refusal is an attempt of its own with a single
    ///  <see cref="DiagnosticOutcome.Refused"/> event - nothing was started.</summary>
    public static void Refuse(IDiagnosticsSink? sink, string operation, params DiagnosticField[] fields) =>
        Refuse(sink, operation, TimeProvider.System, fields);

    public static void Refuse(IDiagnosticsSink? sink, string operation, TimeProvider time, params DiagnosticField[] fields) =>
        Create(sink, operation, time).Write(DiagnosticOutcome.Refused, fields);

    public void Step(string step, params DiagnosticField[] fields) =>
        Write(DiagnosticOutcome.Step, Prepend(DiagnosticField.Code("step", step), fields));

    public void Succeeded(params DiagnosticField[] fields) => Write(DiagnosticOutcome.Succeeded, fields);

    public void Failed(params DiagnosticField[] fields) => Write(DiagnosticOutcome.Failed, fields);

    /// <summary>Only the exception's TYPE is recorded - never its message,
    ///  stack or data, which may carry server text, paths or secrets.</summary>
    public void Failed(Exception exception, params DiagnosticField[] fields) =>
        Write(DiagnosticOutcome.Failed, Prepend(DiagnosticField.Code("exceptionType", exception?.GetType().Name), fields));

    public void Refused(params DiagnosticField[] fields) => Write(DiagnosticOutcome.Refused, fields);

    public void Cleanup(params DiagnosticField[] fields) => Write(DiagnosticOutcome.Cleanup, fields);

    private static DiagnosticsAttempt Create(IDiagnosticsSink? sink, string operation, TimeProvider time)
    {
        try
        {
            return new DiagnosticsAttempt(sink ?? NullDiagnosticsSink.Instance, operation, time, Guid.NewGuid().ToString("N"));
        }
        catch
        {
            return new DiagnosticsAttempt(NullDiagnosticsSink.Instance, operation, TimeProvider.System, Guid.NewGuid().ToString("N"));
        }
    }

    private void Write(DiagnosticOutcome outcome, IReadOnlyList<DiagnosticField> fields)
    {
        try
        {
            var sequence = Interlocked.Increment(ref _sequence);
            _sink.Write(new DiagnosticEvent(_time.GetUtcNow(), Operation, AttemptId, StartedUtc, sequence, outcome, fields ?? Array.Empty<DiagnosticField>()));
        }
        catch
        {
            // best-effort: logging never affects the operation
        }
    }

    private static DiagnosticField[] Prepend(DiagnosticField first, DiagnosticField[]? rest)
    {
        var all = new DiagnosticField[(rest?.Length ?? 0) + 1];
        all[0] = first;
        rest?.CopyTo(all, 1);
        return all;
    }
}
