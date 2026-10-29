namespace Arch.CadConnect.Core.Diagnostics;

/// <summary>M4.2: what a diagnostic event says happened. Started/Step are
///  progress; Succeeded, Failed and Refused end an attempt; Cleanup reports
///  what an attempt removed (or could not remove) after itself.</summary>
public enum DiagnosticOutcome
{
    Started,
    Step,
    Succeeded,
    Failed,
    Refused,
    Cleanup,
}

/// <summary>One diagnostic event of one attempt. Fields are NOT yet
///  sanitized - the sink filters them through the allow-list and the
///  sanitizer when writing.</summary>
public sealed record DiagnosticEvent(
    DateTimeOffset TimestampUtc,
    string Operation,
    string AttemptId,
    DateTimeOffset AttemptStartedUtc,
    int Sequence,
    DiagnosticOutcome Outcome,
    IReadOnlyList<DiagnosticField> Fields)
{
    /// <summary>Started, terminal and cleanup events are flushed to disk at
    ///  once; step events only to the OS.</summary>
    public bool IsImportant => Outcome is not DiagnosticOutcome.Step;
}

/// <summary>Where diagnostic events go. Implementations must be
///  best-effort: <see cref="Write"/> never throws.</summary>
public interface IDiagnosticsSink
{
    void Write(DiagnosticEvent diagnosticEvent);
}

public sealed class NullDiagnosticsSink : IDiagnosticsSink
{
    public static readonly NullDiagnosticsSink Instance = new();

    private NullDiagnosticsSink()
    {
    }

    public void Write(DiagnosticEvent diagnosticEvent)
    {
    }
}
