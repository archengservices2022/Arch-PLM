namespace Arch.CadConnect.Core.Workspace;

/// <summary>What one plan entry's Get Latest may do to its local file and
///  manifest entry.</summary>
public enum GetLatestEntryHandling
{
    /// <summary>The server proved a valid checkout of exactly this version: keep
    ///  the marker and make sure the file is writable.</summary>
    KeepCheckout,

    /// <summary>The server proved the marker stale: remove it, provided the
    ///  local bytes are the marker's base or the plan's version. Bytes that are
    ///  exactly the base may be replaced by a newer plan version.</summary>
    ClearStaleMarker,

    /// <summary>Another document is bound to this path and has no marker: take
    ///  the path over only if no file is there.</summary>
    AdoptIfPathFree,

    /// <summary>The server said nothing that stops the ordinary rules applying.</summary>
    Proceed,

    /// <summary>Nothing is bound here and nothing was here: only a new file may
    ///  land on this path, never on anything that appeared since.</summary>
    ProceedNewFile,

    /// <summary>Touch neither the file nor the manifest entry.</summary>
    Block,
}

/// <param name="Marker">The stale marker, for
///  <see cref="GetLatestEntryHandling.ClearStaleMarker"/>.</param>
public sealed record GetLatestEntryDecision(
    GetLatestEntryHandling Handling,
    string? BlockReason = null,
    WorkspaceCheckoutBinding? Marker = null)
{
    public static readonly GetLatestEntryDecision KeepCheckout = new(GetLatestEntryHandling.KeepCheckout);
    public static readonly GetLatestEntryDecision AdoptIfPathFree = new(GetLatestEntryHandling.AdoptIfPathFree);
    public static readonly GetLatestEntryDecision Proceed = new(GetLatestEntryHandling.Proceed);
    public static readonly GetLatestEntryDecision ProceedNewFile = new(GetLatestEntryHandling.ProceedNewFile);

    public static GetLatestEntryDecision Block(string reason) => new(GetLatestEntryHandling.Block, reason);
}

/// <summary>
/// P6 M4.4 Package C: the pure decisions for a plan entry whose local state a
/// Get Latest could damage. Only the server can tell a valid checkout from a
/// stale marker, so a marker is kept or cleared on its answer alone, and
/// anything short of a clear answer blocks the entry.
///
/// KNOWN LIMIT, kept deliberately: stale-base replacement needs the marker.
/// Check In or Undo Checkout reconcile a stale marker themselves (marker
/// cleared, entry Unverified), and with no marker Get Latest treats the file
/// like any other that differs from its pinned version: local-conflict, never
/// overwritten. Such a file stays writable and Unverified, so Checkout is
/// refused, until the user moves it aside.
/// </summary>
public static class GetLatestCheckoutPolicy
{
    public const string StatusUnknownReason =
        "checkout-status-unknown: the server could not confirm your checkout of this file, so it was left unchanged";

    public const string CheckoutStatusNotCheckedReason =
        "checkout-status-not-checked: the run stopped asking the server before it reached this file, so it was left unchanged and is not confirmed current. Run Get Latest again";

    public const string CheckoutMarkerMissingReason =
        "checkout-marker-missing: the server shows this file is checked out to you, but this workspace has no record of that checkout, so it was left unchanged. "
        + "Run Checkout on this file again to restore the record";

    public const string LocalFileAppearedReason =
        "local-file-appeared: a file appeared at this path during Get Latest, so it was left unchanged and nothing was written over it";

    public const string DecisionMissingReason =
        "checkout-decision-missing: Get Latest reached no decision for this file, so it was left unchanged";

    /// <summary>The summary line must not read as complete when this applies.</summary>
    public static bool IsNotChecked(string? reason) =>
        reason is not null && reason.StartsWith("checkout-status-not-checked:", StringComparison.Ordinal);

    public const string BaseMismatchReason =
        "checkout-base-mismatch: your checkout does not match the version on the server, so this file was left unchanged";

    public const string PathConflictReason =
        "path-conflict: this file belongs to a different document, so it was left unchanged. Use another workspace folder for this document";

    public const string PathConflictCheckedOutReason =
        "path-conflict: this path belongs to a different document that is checked out here, so it was left unchanged";

    public const string StaleConflictReason =
        "stale-checkout-conflict: the server no longer shows this checkout and the local file has changed, so it was left unchanged. "
        + "Copy this file to a safe place to keep your changes, then run Get Latest into a new, empty workspace folder for the latest version";

    public const string CheckoutWithoutRecordReason =
        "checkout-without-record: you hold this document checked out, but this workspace has no record of it, so this file was left unchanged. "
        + "Copy this file to a safe place to keep your changes, then run Get Latest into a new, empty workspace folder, "
        + "or ask your Arch PLM administrator to release the checkout";

    public const string DocumentOpenReason =
        "document-open: this file may be open in Inventor, so it was left unchanged. "
        + "Save any work you need under a new name, close this document in Inventor, and run Get Latest again";

    /// <summary>A file appeared at the path during a stale-base replacement:
    ///  both copies are kept and neither is touched further.</summary>
    public static string ReplacementConflictReason(string copyRelativePath) =>
        "replacement-conflict: a file appeared here while this one was being updated, so it was kept. "
        + $"The previous file is saved as the CAD recovery copy \"{copyRelativePath}\". Compare the two before using either. "
        + "Get Latest will stop here until the copy has been moved out of the .arch folder; leave its .pending.json record where it is";

    /// <summary>The copy could not go back, so a later Get Latest stops here
    ///  until someone has looked at it.</summary>
    public static bool IsReplacementConflict(string? reason) =>
        reason is not null && reason.StartsWith("replacement-conflict:", StringComparison.Ordinal);

    public const string RecoveryFolderUnsafeReason =
        "recovery-folder-unsafe: the workspace's .arch\\.recovery folder is missing, is a link, or could not be verified, "
        + "so this file was left unchanged. Check that folder, or use a new, empty workspace folder";

    /// <summary>An earlier stale-base replacement did not finish and cannot be
    ///  finished safely here. The CAD copy is the file that matters; the record
    ///  beside it only tracks it, and clears itself once the copy has been
    ///  moved out.</summary>
    public static string InterruptedReplacementMessage(string copyPath, string recordPath) =>
        "Get Latest was not run: an earlier update of a file in this workspace did not finish. Nothing was changed. "
        + $"Your previous file is saved as the CAD recovery copy \"{copyPath}\". The recovery record \"{recordPath}\" only tracks it. "
        + "Compare the copy with the file in the workspace, and once you have what you need move the copy, not the record, "
        + "out of the .arch folder. Then run Get Latest again.";

    /// <summary>The file was replaced, but nothing outside the workspace
    ///  confirmed its previous version, or that version could not be removed.
    ///  A later Get Latest stops until someone has looked at it.</summary>
    public static string RecoveryCopyRetainedReason(string copyRelativePath) =>
        "recovery-copy-retained: this file was updated, but cleanup did not complete: the previous file could not be confirmed on the server or removed, "
        + $"so it was kept as the CAD recovery copy \"{copyRelativePath}\". Manual recovery may be required: compare the copy with the file in the workspace "
        + "and, once you have what you need, move the copy, not its .pending.json record, out of the .arch folder. Get Latest will stop here until then";

    /// <summary>Asking whether a copy exists got no answer, so it may well exist
    ///  and its record stays.</summary>
    public static string RecoveryCopyUnknownMessage(string copyPath, string recordPath) =>
        $"Get Latest was not run: it could not determine whether the CAD recovery copy \"{copyPath}\" still exists. Nothing was changed. "
        + $"Keep the recovery record \"{recordPath}\" where it is. Check that you can open the .arch\\.recovery folder, then run Get Latest again.";

    public const string ManifestChangedBeforeWorkMessage =
        "Get Latest was not run: this workspace's record (.arch\\workspace.json) changed while Get Latest was preparing, so nothing was downloaded and the record was left exactly as it is. "
        + "Check what else is using this workspace, then run Get Latest again.";

    public const string ManifestChangedMessage =
        "Get Latest did not save this workspace's record: .arch\\workspace.json or its folder changed during the run, so the record was left exactly as it is. "
        + "Files this run downloaded are in the workspace but are not recorded. Check what else is using this workspace, then run Get Latest again.";

    /// <summary>The workspace is neither new nor healthy. Nothing here restores
    ///  anything, so this says what a person must do, and what proves nothing.</summary>
    public static string RecoveryRequiredMessage(IEnumerable<string> artifacts) =>
        "This workspace needs manual recovery: an earlier save of its record (.arch\\workspace.json) did not finish cleanly, or its .arch folder could not be verified. "
        + "Nothing was sent to the server and nothing was changed. Arch PLM will not restore, replace or delete anything here. "
        + $"Found: {string.Join(", ", artifacts.Select(a => $"\"{a}\""))}. "
        + "Stop everyone using this workspace, including every Inventor window. Back up the CAD files and the whole .arch folder. "
        + "Check each candidate record's structure, server and organization, and reconcile its checkout entries against the server: "
        + "a file name or timestamp alone proves nothing. If anything is uncertain, leave every file where it is, ask your Arch PLM administrator, "
        + "and use a new, empty workspace folder meanwhile.";

    /// <summary>The save finished, or at least the file is safe, but the old
    ///  record stayed beside it, so the next command will refuse this workspace.</summary>
    public static string ManifestArtifactRetainedReason(string artifactPath) =>
        $"manifest-artifact-retained: an older copy of this workspace's record stayed behind as \"{artifactPath}\" and cleanup did not complete. "
        + "Keep that file: Arch PLM will not remove it. This workspace now needs manual recovery, so its commands will be refused until someone has compared the two records "
        + "and moved the older one out of the .arch folder. Stop everyone using this workspace and back up its CAD files and .arch folder first";
    /// <summary>A record that cannot be verified proves nothing about the files
    ///  around it, so everything stays and work continues elsewhere.</summary>
    public static string UntrustedRecoveryRecordMessage(string recordPath) =>
        "Get Latest was not run: the recovery record \"" + recordPath + "\" could not be verified, so it cannot be relied on. "
        + "Nothing was changed. Keep this record and every .recovery- file beside it where they are: they may hold your work. "
        + "To carry on, run Get Latest into a new, empty workspace folder, and ask your Arch PLM administrator to review this folder.";

    public const string RecoveryFolderUnsafeMessage =
        "Get Latest was not run: this workspace's .arch\\.recovery folder is a link or could not be verified, "
        + "so it cannot be trusted. Nothing was changed. Check that folder, or use a new, empty workspace folder.";

    public const string StagingFolderUnsafeReason =
        "staging-folder-unsafe: the workspace's .arch\\.staging folder is a link or could not be verified, so nothing was downloaded "
        + "and this file was left unchanged. Check that folder, or use a new, empty workspace folder";

    public const string ArchFolderUnsafeMessage =
        "Get Latest was not run: this workspace's .arch folder is a link or could not be verified, so it cannot be trusted. "
        + "Nothing was changed. Check that folder, or use a new, empty workspace folder.";

    public const string FileIdentityReason =
        "file-identity-unknown: this file is a link or has more than one name, so it cannot be replaced safely and was left unchanged. "
        + "Use a new, empty workspace folder for the latest version";

    public const string NotWritableReason =
        "checkout-not-writable: this file is checked out to you, but it could not be made writable";

    /// <summary>A plan entry whose manifest entry carries a checkout marker.</summary>
    /// <param name="status">The server's answer, or null when there was no
    ///  usable answer.</param>
    public static GetLatestEntryDecision Decide(
        WorkspacePlanEntry entry,
        WorkspaceCheckoutBinding marker,
        ServerCheckoutStatus? status)
    {
        ArgumentNullException.ThrowIfNull(entry);
        ArgumentNullException.ThrowIfNull(marker);

        return status?.State switch
        {
            null => GetLatestEntryDecision.Block(StatusUnknownReason),
            ServerCheckoutState.Available or ServerCheckoutState.Locked =>
                new GetLatestEntryDecision(GetLatestEntryHandling.ClearStaleMarker, Marker: marker),
            ServerCheckoutState.Mine => IsSameCheckoutOfPlanVersion(entry, marker, status)
                ? GetLatestEntryDecision.KeepCheckout
                : GetLatestEntryDecision.Block(BaseMismatchReason),
            _ => GetLatestEntryDecision.Block(StatusUnknownReason),
        };
    }

    /// <summary>A bound file with no marker: the marker's absence proves nothing,
    ///  because a save can fail after the server took the checkout. Marking the
    ///  file controlled needs the server to say it is not this user's.</summary>
    /// <param name="status">The server's answer, or null when there was no
    ///  usable answer.</param>
    public static GetLatestEntryDecision DecideMarkerless(ServerCheckoutStatus? status) => status?.State switch
    {
        ServerCheckoutState.Available or ServerCheckoutState.Locked => GetLatestEntryDecision.Proceed,
        ServerCheckoutState.Mine => GetLatestEntryDecision.Block(CheckoutMarkerMissingReason),
        _ => GetLatestEntryDecision.Block(StatusUnknownReason),
    };

    /// <summary>An existing file no manifest entry describes - a missing
    ///  manifest looks like this for every file. Null means the ordinary rules:
    ///  the server proved it is not checked out to this user. A checkout the
    ///  server does report is not turned into a marker here: this workspace
    ///  never recorded it, so nothing shows these bytes are that checkout's.</summary>
    /// <param name="status">The server's answer, or null when there was no
    ///  usable answer.</param>
    public static GetLatestEntryDecision? DecideUnbound(ServerCheckoutStatus? status) => status?.State switch
    {
        ServerCheckoutState.Available or ServerCheckoutState.Locked => null,
        ServerCheckoutState.Mine => GetLatestEntryDecision.Block(CheckoutWithoutRecordReason),
        _ => GetLatestEntryDecision.Block(StatusUnknownReason),
    };

    private static bool IsSameCheckoutOfPlanVersion(
        WorkspacePlanEntry entry, WorkspaceCheckoutBinding marker, ServerCheckoutStatus status) =>
        entry.Version is { } version
        && string.Equals(status.CheckoutId, marker.CheckoutId, StringComparison.Ordinal)
        && string.Equals(status.BaseFileVersionId, marker.BaseFileVersionId, StringComparison.Ordinal)
        && string.Equals(marker.BaseFileVersionId, version.FileVersionId, StringComparison.Ordinal)
        && marker.BaseVersionNumber == version.VersionNumber
        && string.Equals(marker.BaseChecksum, version.Checksum, StringComparison.Ordinal)
        && marker.BaseFileSize == version.FileSize;
}
