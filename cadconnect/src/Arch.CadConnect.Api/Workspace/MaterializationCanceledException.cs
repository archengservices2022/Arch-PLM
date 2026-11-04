using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Workspace;

/// <summary>P6 M4.4 Package C: a run cancelled after finishing some entries.
///  <see cref="Completed"/> holds those, which changed local files, so the
///  caller must record them before letting the cancellation go on.</summary>
public sealed class MaterializationCanceledException(MaterializationReport completed, OperationCanceledException inner)
    : OperationCanceledException(inner.Message, inner, inner.CancellationToken)
{
    public MaterializationReport Completed { get; } = completed;
}
