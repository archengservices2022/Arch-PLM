namespace Arch.CadConnect.Core.Workspace;

/// <summary>
/// Per-entry outcome of a Get Latest materialization. Mirrors the P3B-2B
/// materializer (<c>web/app/lib/workspace-materialize-core.ts</c>).
/// </summary>
public enum MaterializationStatus
{
    /// <summary>Bytes were downloaded, size + SHA-256 verified, and the file
    ///  was atomically placed (created new - never overwriting).</summary>
    Downloaded,

    /// <summary>An existing local file already matched the pinned checksum +
    ///  size. No download, no write.</summary>
    AlreadyCurrent,

    /// <summary>A non-destructive stop for THIS entry: an existing local file
    ///  differs (local-conflict), a path was unsafe, a plan collision, or the
    ///  entry carried no materializable version. Nothing was written.</summary>
    Blocked,

    /// <summary>A download / hash / size / write failure. Any partial artifact
    ///  was removed; the final path holds no valid-looking file.</summary>
    Failed,
}

/// <summary>P6 M4.4 Package C: what <see cref="WorkspaceManifest.ApplyRun"/> does
///  with the entry's existing checkout marker. Only set when a Get Latest
///  decided something about a checkout; otherwise <see cref="Default"/>.</summary>
public enum MaterializationManifestAction
{
    /// <summary>The ordinary rules for the entry's status.</summary>
    Default,

    /// <summary>Leave the existing entry exactly as it is.</summary>
    PreserveEntry,

    /// <summary>The server proved the checkout: carry the marker over.</summary>
    KeepCheckout,

    /// <summary>The server proved the marker stale: remove it.</summary>
    ClearCheckout,
}

public sealed record MaterializationEntryResult
{
    /// <summary>Authoritative identity.</summary>
    public required string CadDocumentId { get; init; }

    /// <summary>Authoritative identity of the pinned version; null when the
    ///  entry carried no materializable version at all.</summary>
    public required string? FileVersionId { get; init; }

    /// <summary>The (re-validated) relative filename this entry targeted, if
    ///  one could be resolved; null when blocked before any path resolved.</summary>
    public required string? RelativePath { get; init; }

    public required MaterializationStatus Status { get; init; }

    /// <summary>Human-readable detail for Blocked / Failed, or for a Downloaded
    ///  entry that left a <see cref="RetainedRecoveryCopy"/>. Never contains a
    ///  server filesystem path.</summary>
    public string? Reason { get; init; }

    /// <summary>P6 M4.4 Package C: the file was replaced, but its previous
    ///  version could not be cleaned up and stays here, relative to the
    ///  workspace root. Null when nothing was left behind.</summary>
    public string? RetainedRecoveryCopy { get; init; }

    /// <summary>Bytes written for a fresh download; 0 for AlreadyCurrent.</summary>
    public long BytesWritten { get; init; }

    /// <summary>The verified, matching checksum for Downloaded / AlreadyCurrent.</summary>
    public string? Checksum { get; init; }

    public bool IsRoot { get; init; }
    public string? DocumentNumber { get; init; }

    public MaterializationManifestAction ManifestAction { get; init; } = MaterializationManifestAction.Default;
}

public sealed record MaterializationSummary(int Downloaded, int AlreadyCurrent, int Blocked, int Failed);

/// <summary>
/// The complete result of one Get Latest run. A per-entry problem never
/// aborts the others; every entry has a result.
/// </summary>
public sealed record MaterializationReport
{
    public required string WorkspaceRoot { get; init; }
    public required string RootCadDocumentId { get; init; }
    public required DateTimeOffset StartedAtUtc { get; init; }
    public required DateTimeOffset FinishedAtUtc { get; init; }
    public required int RequestedEntries { get; init; }

    /// <summary>Deterministic - same order as the plan's entries.</summary>
    public required IReadOnlyList<MaterializationEntryResult> Results { get; init; }

    /// <summary>P6 M4.4 Package C: the manifest was saved, but its old copy stayed
    ///  behind here, relative to the workspace root. Null when nothing did.</summary>
    public string? RetainedManifestArtifact { get; init; }

    public MaterializationSummary Summary => new(
        Downloaded: Results.Count(r => r.Status == MaterializationStatus.Downloaded),
        AlreadyCurrent: Results.Count(r => r.Status == MaterializationStatus.AlreadyCurrent),
        Blocked: Results.Count(r => r.Status == MaterializationStatus.Blocked),
        Failed: Results.Count(r => r.Status == MaterializationStatus.Failed));

    /// <summary>True when nothing failed, nothing was blocked and nothing is left
    ///  for a person to sort out - the local workspace is a complete, verified
    ///  copy of the pinned package.</summary>
    public bool ReachedValidState =>
        Results.All(r => r.Status is MaterializationStatus.Downloaded or MaterializationStatus.AlreadyCurrent
            && r.RetainedRecoveryCopy is null)
        && RetainedManifestArtifact is null;

    /// <summary>A one-line summary for the ribbon result dialog. It is the one
    ///  line always shown, so it carries any retained recovery copy.</summary>
    public string ToSummaryLine()
    {
        var s = Summary;
        var retained = Results.Where(r => r.RetainedRecoveryCopy is not null).Select(r => " " + r.Reason);
        var manifest = RetainedManifestArtifact is { } artifact ? " " + GetLatestCheckoutPolicy.ManifestArtifactRetainedReason(artifact) : "";
        var notChecked = Results.Count(r => GetLatestCheckoutPolicy.IsNotChecked(r.Reason));
        var incomplete = notChecked > 0
            ? $" {notChecked} not checked: this workspace is not confirmed current. Run Get Latest again."
            : "";
        return $"{s.Downloaded} downloaded, {s.AlreadyCurrent} already current, "
             + $"{s.Blocked} blocked, {s.Failed} failed." + incomplete + string.Concat(retained) + manifest;
    }
}
