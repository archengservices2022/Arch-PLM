namespace Arch.CadConnect.Core.CopyDesign.Apply;

/// <summary>
/// M4.2: optional observer of <see cref="CopyDesignApplyOrchestrator"/>'s
/// phase boundaries (mapped, reservation sent / returned / validated, each
/// physical phase, each materialization), so a diagnostics log can show how
/// far an attempt got even if Inventor dies mid-run. Observation only: the
/// orchestrator ignores anything an observer does, including throwing.
/// </summary>
public interface ICopyDesignApplyProgress
{
    void Report(CopyDesignApplyProgressEvent progress);
}

/// <param name="Step">A fixed step name, e.g. <c>reservation.sent</c>.</param>
/// <param name="OperationId">The confirmed operation id, once known.</param>
/// <param name="CadDocumentId">The entry a per-entry step is about.</param>
/// <param name="Detail">A short machine value (an outcome enum name, a count).</param>
public sealed record CopyDesignApplyProgressEvent(
    string Step,
    string? OperationId = null,
    string? CadDocumentId = null,
    string? Detail = null);
